import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { ensureFolderRecords } from '../lib/folders.js';
import { jsonError, parseJsonBody } from '../lib/http.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { UPSERT_NOTE_SQL } from '../lib/sql.js';
import {
  extractMediaKeys,
  normalizeFolderName,
  normalizeTagList,
  normalizeTitle,
  parseStoredTags,
  serializeTags
} from '../lib/utils.js';
import { V } from '../lib/validate.js';
import { db } from '../lib/core.js';
import {
  getLatestSeq,
  getLatestSeqByNoteIds,
  getNotesByIds,
  listAllFolders,
  listChangesSince
} from '../lib/sync.js';

const router = new Hono();

const MAX_CONTENT_LENGTH = 500_000;
const MAX_ITEMS_PER_PUSH = 200;
const MAX_PULL_LIMIT = 200;
const DEFAULT_PULL_LIMIT = 50;

function toClientNote(row, seq) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    subcategory: row.subcategory,
    tags: parseStoredTags(row.tags),
    content: typeof row.content === 'string' ? row.content : '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    seq
  };
}

// A client that has never synced sends since=0 and gets the folder tree too;
// afterwards folders are derived from notes, which avoids shipping them on
// every incremental pull (they are a projection of notes anyway).
router.get('/state', authMiddleware, async (c) => {
  const latestSeq = await getLatestSeq();
  const notes = await db.prepare('SELECT COUNT(*) AS n FROM notes').first();
  const folders = await db.prepare('SELECT COUNT(*) AS n FROM folders').first();

  return c.json({
    latestSeq,
    noteCount: Number(notes?.n || 0),
    folderCount: Number(folders?.n || 0)
  });
});

router.get('/pull', authMiddleware, async (c) => {
  const sinceRaw = Number(c.req.query('since') || 0);
  const limitRaw = Number(c.req.query('limit') || DEFAULT_PULL_LIMIT);

  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
  const limit = Number.isFinite(limitRaw)
    ? Math.min(MAX_PULL_LIMIT, Math.max(1, Math.floor(limitRaw)))
    : DEFAULT_PULL_LIMIT;

  const latestSeq = await getLatestSeq();
  const changes = await listChangesSince(since, limit);

  if (!changes.length) {
    return c.json({
      notes: [],
      deleted: [],
      // Jump straight to the newest cursor: folder rows live in the same stream
      // but are never served here, so leaving the cursor behind would rescan
      // the same empty window on every pull.
      nextSeq: latestSeq,
      latestSeq,
      hasMore: false,
      fullReset: false,
      ...(since === 0 ? { folders: await listAllFolders() } : {})
    });
  }

  const upsertIds = changes.filter((ch) => ch.op === 'upsert').map((ch) => ch.entity_id);
  const rowMap = await getNotesByIds([...new Set(upsertIds)]);

  const notes = [];
  const deleted = [];

  for (const ch of changes) {
    if (ch.op === 'delete') {
      deleted.push({ id: ch.entity_id, seq: ch.seq });
      continue;
    }

    const row = rowMap.get(ch.entity_id);
    // An upsert whose row is gone means the note was removed after that write
    // (hard delete), so the client must delete it too rather than keep a stale copy.
    if (!row) {
      deleted.push({ id: ch.entity_id, seq: ch.seq });
      continue;
    }

    notes.push(toClientNote(row, ch.seq));
  }

  const nextSeq = changes[changes.length - 1].seq;
  const remaining = await db.prepare(
    'SELECT 1 AS x FROM sync_changes WHERE seq > ? LIMIT 1'
  ).bind(nextSeq).first();

  return c.json({
    notes,
    deleted,
    nextSeq,
    latestSeq,
    hasMore: Boolean(remaining),
    fullReset: false,
    ...(since === 0 ? { folders: await listAllFolders() } : {})
  });
});

function normalizeIncomingNote(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid note payload');

  const id = String(input.id || '');
  if (!V.isUUID(id)) throw new Error('Invalid note ID format');

  const title = normalizeTitle(input.title);
  if (!title) throw new Error('Title required');

  const category = normalizeFolderName(input.category);
  if (!category) throw new Error('Major category required');

  const subcategory = normalizeFolderName(input.subcategory);
  if (!subcategory) throw new Error('Minor category required');

  const content = typeof input.content === 'string' ? input.content : '';
  if (content.length > MAX_CONTENT_LENGTH) {
    const err = new Error('Content too large');
    err.status = 413;
    throw err;
  }

  const createdAt = typeof input.createdAt === 'string' && input.createdAt
    ? input.createdAt
    : new Date().toISOString();

  const updatedAt = typeof input.updatedAt === 'string' && input.updatedAt
    ? input.updatedAt
    : createdAt;

  return {
    id,
    title,
    category,
    subcategory,
    tags: normalizeTagList(input.tags),
    content,
    createdAt,
    updatedAt,
    baseSeq: Number.isFinite(Number(input.baseSeq)) ? Math.max(0, Math.floor(Number(input.baseSeq))) : 0
  };
}

router.post('/push', authMiddleware, async (c) => {
  const { value: body, response } = await parseJsonBody(c);
  if (response) return response;

  const incomingNotes = Array.isArray(body?.notes) ? body.notes : [];
  const incomingDeletions = Array.isArray(body?.deletions) ? body.deletions : [];

  const total = incomingNotes.length + incomingDeletions.length;
  if (total === 0) {
    return c.json({ applied: 0, deleted: 0, conflicts: [], latestSeq: await getLatestSeq() });
  }
  if (total > MAX_ITEMS_PER_PUSH) {
    return jsonError(c, `Too many items in one push (max ${MAX_ITEMS_PER_PUSH})`, 413);
  }

  let parsedNotes;
  try {
    parsedNotes = incomingNotes.map(normalizeIncomingNote);
  } catch (e) {
    return jsonError(c, e.message, e.status || 400);
  }

  const deletionIds = [];
  for (const item of incomingDeletions) {
    const id = String(item?.id || '');
    if (!V.isUUID(id)) return jsonError(c, 'Invalid note ID format', 400);
    deletionIds.push({
      id,
      baseSeq: Number.isFinite(Number(item?.baseSeq)) ? Math.max(0, Math.floor(Number(item.baseSeq))) : 0
    });
  }

  const allIds = [...new Set([...parsedNotes.map((n) => n.id), ...deletionIds.map((d) => d.id)])];
  const latestByNote = await getLatestSeqByNoteIds(allIds);

  const conflicts = [];
  const appliedNotes = [];
  const appliedDeletions = [];

  for (const note of parsedNotes) {
    const serverSeq = latestByNote.get(note.id) || 0;

    // Optimistic concurrency: the client edited on top of `baseSeq`. If the
    // server has moved past that, another device wrote in between. We keep the
    // incoming version (last-write-wins) but report it so the UI can flag it,
    // instead of silently discarding either side.
    if (serverSeq > note.baseSeq) {
      conflicts.push({
        id: note.id,
        kind: 'update',
        baseSeq: note.baseSeq,
        serverSeq,
        resolution: 'client_wins'
      });
    }

    appliedNotes.push(note);
  }

  const noteIdsToDelete = [];
  for (const item of deletionIds) {
    const serverSeq = latestByNote.get(item.id) || 0;
    if (serverSeq > item.baseSeq) {
      conflicts.push({
        id: item.id,
        kind: 'delete',
        baseSeq: item.baseSeq,
        serverSeq,
        resolution: 'client_wins'
      });
    }
    noteIdsToDelete.push(item.id);
  }

  const statements = [];

  for (const note of appliedNotes) {
    const sanitized = await sanitizeContent(note.content);
    const tagsJson = serializeTags(note.tags);

    statements.push(
      db.prepare(UPSERT_NOTE_SQL).bind(
        note.id,
        note.title,
        note.category,
        note.subcategory,
        tagsJson,
        sanitized,
        note.createdAt,
        note.updatedAt
      )
    );

    // Rebuild the media index in the same transaction as the content it mirrors.
    statements.push(db.prepare('DELETE FROM note_media WHERE note_id = ?').bind(note.id));
    for (const key of extractMediaKeys(sanitized)) {
      statements.push(
        db.prepare('INSERT OR IGNORE INTO note_media (note_id, media_key) VALUES (?, ?)').bind(note.id, key)
      );
    }
  }

  for (const id of noteIdsToDelete) {
    statements.push(db.prepare('DELETE FROM notes WHERE id = ?').bind(id));
    statements.push(db.prepare('DELETE FROM note_media WHERE note_id = ?').bind(id));
  }

  if (statements.length) {
    await db.batch(statements);
  }

  // Folders are derived from notes, so ensure each touched folder exists.
  const foldersTouched = new Map();
  for (const note of appliedNotes) {
    foldersTouched.set(`${note.category}\u0000${note.subcategory}`, note);
  }
  for (const note of foldersTouched.values()) {
    await ensureFolderRecords(db, note.category, note.subcategory, note.createdAt, note.updatedAt);
  }

  return c.json({
    applied: appliedNotes.length,
    deleted: noteIdsToDelete.length,
    conflicts,
    latestSeq: await getLatestSeq()
  });
});

// Attachment manifest. Media bodies are served by the existing /img and /video
// routes, so clients only need the key list to work out what they are missing.
router.get('/media', authMiddleware, async (c) => {
  const { results } = await db.prepare(
    'SELECT DISTINCT media_key FROM note_media ORDER BY media_key'
  ).all();

  return c.json({
    keys: (results || []).map((row) => row.media_key)
  });
});

export default router;
