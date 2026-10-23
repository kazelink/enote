import { Readable } from 'stream';
import { sanitizeContent } from './sanitize.js';
import { UPSERT_FOLDER_SQL, UPSERT_NOTE_SQL } from './sql.js';
import { createStreamingBackupParser } from './stream-parser.js';
import {
  deriveImportedTitle,
  normalizeFolderName,
  normalizeTagList,
  normalizeTimestamp,
  normalizeTitle,
  serializeTags,
  toBackupEntry,
  toBackupFolder
} from './utils.js';
import { V } from './validate.js';
import { db, runBackground } from './core.js';
import { rebuildNoteMediaIndex } from './scheduled.js';

export const MAX_RESTORE_FILE = 100 * 1024 * 1024;
export const MAX_RESTORE_REQUEST = 4 * 1024 * 1024;
export const RESTORE_CHUNK_SIZE = 100;
export const SANITIZE_BATCH_SIZE = 10;

const jsonEncoder = new TextEncoder();

export function extractRestoreEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['notes', 'diaries', 'entries', 'list']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return null;
}

export function extractRestoreFolders(payload) {
  return payload && typeof payload === 'object' && Array.isArray(payload.folders) ? payload.folders : [];
}

export function normalizeRestoreEntry(entry) {
  if (!entry || typeof entry !== 'object' || !V.isUUID(entry.id)) return null;

  const rawContent = typeof entry.content === 'string' ? entry.content : '';
  const fallbackTimestamp = V.isDateStr(entry.date)
    ? `${entry.date}T00:00:00.000Z`
    : new Date().toISOString();

  const createdAt = normalizeTimestamp(entry.createdAt || entry.created_at || fallbackTimestamp, fallbackTimestamp);
  const updatedAt = normalizeTimestamp(entry.updatedAt || entry.updated_at || createdAt, createdAt);
  const title = normalizeTitle(entry.title) || deriveImportedTitle(rawContent);

  if (!title) return null;

  return {
    id: String(entry.id),
    title,
    category: normalizeFolderName(entry.category) || 'Imported',
    subcategory: normalizeFolderName(entry.subcategory) || 'Legacy',
    tags: serializeTags(normalizeTagList(entry.tags)),
    content: rawContent,
    createdAt,
    updatedAt
  };
}

export function normalizeRestoreFolder(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const category = normalizeFolderName(entry.category);
  if (!category) return null;

  const fallbackTimestamp = new Date().toISOString();
  const createdAt = normalizeTimestamp(entry.createdAt || entry.created_at || fallbackTimestamp, fallbackTimestamp);
  const updatedAt = normalizeTimestamp(entry.updatedAt || entry.updated_at || createdAt, createdAt);

  return {
    category,
    subcategory: normalizeFolderName(entry.subcategory),
    createdAt,
    updatedAt
  };
}

function mergeFolderTimestampRecord(target, category, subcategory, createdAt, updatedAt) {
  const key = `${category}\u0000${subcategory}`;
  const existing = target.get(key);

  if (!existing) {
    target.set(key, { category, subcategory, createdAt, updatedAt });
  } else {
    existing.createdAt = existing.createdAt < createdAt ? existing.createdAt : createdAt;
    existing.updatedAt = existing.updatedAt > updatedAt ? existing.updatedAt : updatedAt;
  }
}

function trackDerivedFolders(target, entry) {
  mergeFolderTimestampRecord(target, entry.category, '', entry.createdAt, entry.updatedAt);
  mergeFolderTimestampRecord(target, entry.category, entry.subcategory, entry.createdAt, entry.updatedAt);
}

function deriveFoldersFromNotes(entries) {
  const deduped = new Map();
  for (const entry of entries) trackDerivedFolders(deduped, entry);
  return [...deduped.values()];
}

function collectNormalizedRestoreEntries(entries) {
  const validEntries = entries.map(normalizeRestoreEntry).filter(Boolean);
  return { skipped: entries.length - validEntries.length, validEntries };
}

async function sanitizeEntriesInPlace(entries) {
  for (let i = 0; i < entries.length; i += SANITIZE_BATCH_SIZE) {
    const batch = entries.slice(i, i + SANITIZE_BATCH_SIZE);
    const sanitized = await Promise.all(batch.map((entry) => sanitizeContent(entry.content)));
    batch.forEach((entry, index) => { entry.content = sanitized[index]; });
  }
}

function restoreEntriesInTransaction(entries) {
  if (!entries.length) return;
  const stmt = db.prepare(UPSERT_NOTE_SQL);
  for (const entry of entries) {
    stmt.bind(entry.id, entry.title, entry.category, entry.subcategory, entry.tags, entry.content, entry.createdAt, entry.updatedAt).runSync();
  }
}

function restoreFoldersInTransaction(folders) {
  if (!Array.isArray(folders) || folders.length === 0) return;
  const stmt = db.prepare(UPSERT_FOLDER_SQL);
  for (const folder of folders) {
    if (!folder?.category) continue;
    stmt.bind(folder.category, '', folder.createdAt, folder.updatedAt).runSync();
    if (folder.subcategory) {
      stmt.bind(folder.category, folder.subcategory, folder.createdAt, folder.updatedAt).runSync();
    }
  }
}

function beginRestoreTransaction(state) {
  if (state.open) return;
  db.exec('BEGIN IMMEDIATE');
  state.open = true;
}

function commitRestoreTransaction(state) {
  if (!state.open) return;
  db.exec('COMMIT');
  state.open = false;
}

function rollbackRestoreTransaction(state) {
  if (!state.open) return;
  try { db.exec('ROLLBACK'); } finally { state.open = false; }
}

export async function restoreBackupStream(webBody, declaredBytes) {
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESTORE_FILE) {
    throw Object.assign(new Error('Backup file too large (max 100MB)'), { status: 413 });
  }
  if (!webBody) throw Object.assign(new Error('No data provided.'), { status: 400 });

  let count = 0, skipped = 0, explicitFolderCount = 0, receivedBytes = 0;
  const explicitFolders = [];
  const derivedFolders = new Map();
  const transactionState = { open: false };
  let noteBatch = [];

  const flushNotes = async () => {
    if (!noteBatch.length) return;
    const batch = noteBatch;
    noteBatch = [];
    await sanitizeEntriesInPlace(batch);
    beginRestoreTransaction(transactionState);
    restoreEntriesInTransaction(batch);
  };

  try {
    const parser = createStreamingBackupParser({
      onFolder: async (folderEntry) => {
        const normalized = normalizeRestoreFolder(folderEntry);
        if (normalized) {
          explicitFolders.push(normalized);
          explicitFolderCount += 1;
        }
      },
      onNote: async (noteEntry) => {
        const normalized = normalizeRestoreEntry(noteEntry);
        if (!normalized) { skipped += 1; return; }

        count += 1;
        trackDerivedFolders(derivedFolders, normalized);
        noteBatch.push(normalized);
        if (noteBatch.length >= RESTORE_CHUNK_SIZE) await flushNotes();
      }
    });

    const decoder = new TextDecoder();
    for await (const chunk of Readable.fromWeb(webBody)) {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_RESTORE_FILE) {
        throw Object.assign(new Error('Backup file too large (max 100MB)'), { status: 413 });
      }
      await parser.push(decoder.decode(chunk, { stream: true }));
    }

    await parser.push(decoder.decode());
    await parser.finish();
    await flushNotes();

    beginRestoreTransaction(transactionState);
    restoreFoldersInTransaction([...explicitFolders, ...derivedFolders.values()]);
    commitRestoreTransaction(transactionState);

    // Restored notes bypass per-note note_media maintenance; refresh the index
    // so media-cleanup decisions see their references.
    runBackground(rebuildNoteMediaIndex());

    return { success: true, count, skipped, folderCount: explicitFolderCount };
  } catch (error) {
    rollbackRestoreTransaction(transactionState);
    throw error;
  }
}

export async function restoreBackupPayload(parsed) {
  const totalBytes = Number(parsed?.totalBytes);
  if (Number.isFinite(totalBytes) && totalBytes > MAX_RESTORE_FILE) {
    throw Object.assign(new Error('Backup file too large (max 100MB)'), { status: 413 });
  }

  const entries = extractRestoreEntries(parsed);
  if (!entries) throw Object.assign(new Error('Invalid data format'), { status: 400 });

  const restoreFolders = extractRestoreFolders(parsed).map(normalizeRestoreFolder).filter(Boolean);
  const { skipped, validEntries } = collectNormalizedRestoreEntries(entries);
  const derivedFolders = deriveFoldersFromNotes(validEntries);
  const count = validEntries.length;

  await sanitizeEntriesInPlace(validEntries);

  const transactionState = { open: false };
  try {
    beginRestoreTransaction(transactionState);
    restoreFoldersInTransaction([...restoreFolders, ...derivedFolders]);
    restoreEntriesInTransaction(validEntries);
    commitRestoreTransaction(transactionState);
  } catch (error) {
    rollbackRestoreTransaction(transactionState);
    throw error;
  }

  runBackground(rebuildNoteMediaIndex());

  return { success: true, count, skipped, folderCount: restoreFolders.length };
}

function buildExportScope(category, subcategory) {
  const conditions = [];
  if (category) conditions.push(['category', category]);
  if (category && subcategory) conditions.push(['subcategory', subcategory]);

  const params = conditions.map(([, v]) => v);
  const noteWhere = conditions.length ? ` WHERE ${conditions.map(([col]) => `n.${col} = ?`).join(' AND ')}` : '';
  const folderWhere = conditions.length ? ` WHERE ${conditions.map(([col]) => `${col} = ?`).join(' AND ')}` : '';

  return { noteWhere, noteParams: params, folderWhere, folderParams: [...params] };
}

async function countRows(sql, params) {
  return Number((await db.prepare(sql).bind(...params).first())?.total ?? 0);
}

export async function* streamBackupJson({ exportedAt, scopeLabel, noteWhere, noteParams, folderWhere, folderParams, noteCount, folderCount }) {
  const encode = (str) => jsonEncoder.encode(str);

  yield encode(`{"exportedAt":${JSON.stringify(exportedAt)},"scope":${JSON.stringify(scopeLabel)},"count":${noteCount},"folderCount":${folderCount},"folders":[`);

  let first = true;
  for (const row of db.prepare(`SELECT * FROM folders${folderWhere} ORDER BY lower(category) ASC, lower(subcategory) ASC`).bind(...folderParams).iterate()) {
    yield encode(`${first ? '' : ','}${JSON.stringify(toBackupFolder(row))}`);
    first = false;
  }

  yield encode('],"notes":[');

  first = true;
  for (const row of db.prepare(`SELECT * FROM notes n${noteWhere} ORDER BY updated_at DESC`).bind(...noteParams).iterate()) {
    yield encode(`${first ? '' : ','}${JSON.stringify(toBackupEntry(row))}`);
    first = false;
  }

  yield encode(']}');
}

export async function createBackupExport(category, subcategory) {
  const { noteWhere, noteParams, folderWhere, folderParams } = buildExportScope(category, subcategory);
  const scopeLabel = subcategory ? `${category}-${subcategory}` : category || 'all';
  const exportedAt = new Date().toISOString();
  const [noteCount, folderCount] = await Promise.all([
    countRows(`SELECT COUNT(*) AS total FROM notes n${noteWhere}`, noteParams),
    countRows(`SELECT COUNT(*) AS total FROM folders${folderWhere}`, folderParams)
  ]);

  const safeScope = scopeLabel.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const date = exportedAt.split('T')[0];
  const filename = `note-backup-${safeScope || 'all'}-${date}.json`;
  const utfFilename = `note-backup-${scopeLabel || 'all'}-${date}.json`;
  const stream = Readable.toWeb(Readable.from(streamBackupJson({
    exportedAt, scopeLabel, noteWhere, noteParams, folderWhere, folderParams, noteCount, folderCount
  })));

  return { stream, filename, utfFilename };
}
