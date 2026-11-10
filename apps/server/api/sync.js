import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { ensureFolderRecords } from '../lib/folders.js';
import { jsonError, parseJsonBody } from '../lib/http.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { noteMediaStatements, upsertNoteStatement } from '../lib/note-write.js';
import {
  normalizeFolderName,
  normalizeTagList,
  normalizeTitle,
  parseStoredTags,
  serializeTags
} from '../lib/utils.js';
import { V } from '../lib/validate.js';
import { db } from '../lib/core.js';
import { toClientNote } from '../../client/shared/note-shape.js';
import {
  getLatestSeq,
  getLatestSeqByNoteIds,
  getMinSeq,
  getNotesByIds,
  listAllFolders,
  listChangesSince
} from '../lib/sync.js';

const router = new Hono();

const MAX_CONTENT_LENGTH = 500_000;
const MAX_ITEMS_PER_PUSH = 200;
const MAX_PULL_LIMIT = 200;
const DEFAULT_PULL_LIMIT = 50;

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

  if (since > 0) {
    const minSeq = await getMinSeq();

    // 两种游标失效的情况：
    // 1) since > latestSeq —— 服务端换库 / 恢复旧备份后序号变小，增量永远是空，
    //    客户端会一直卡在旧游标上同步不到任何东西；
    // 2) since < minSeq - 1 —— 客户端游标早于保留窗口。
    // 两种都必须全量重来。
    const cursorUnusable = since > latestSeq || !minSeq || since < minSeq - 1;

    if (cursorUnusable) {
      return c.json({
        notes: [],
        deleted: [],
        nextSeq: 0,
        latestSeq,
        hasMore: false,
        fullReset: true,
        serverTime: new Date().toISOString(),
        folders: await listAllFolders()
      });
    }
  }

  const changes = await listChangesSince(since, limit);

  if (!changes.length) {
    return c.json({
      notes: [],
      deleted: [],
      nextSeq: latestSeq,
      latestSeq,
      hasMore: false,
      fullReset: false,
      serverTime: new Date().toISOString(),
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
    if (!row) {
      deleted.push({ id: ch.entity_id, seq: ch.seq });
      continue;
    }

    notes.push(toClientNote(row, ch.seq));
  }

  const nextSeq = changes[changes.length - 1].seq;
  const remaining = await db.prepare(
    "SELECT 1 AS x FROM sync_changes WHERE entity = 'note' AND seq > ? LIMIT 1"
  ).bind(nextSeq).first();

  return c.json({
    notes,
    deleted,
    nextSeq,
    latestSeq,
    hasMore: Boolean(remaining),
    fullReset: false,
    serverTime: new Date().toISOString(),
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

function sameNoteContent(existing, note) {
  if (existing.title !== note.title) return false;
  if (existing.category !== note.category) return false;
  if (existing.subcategory !== note.subcategory) return false;
  if (existing.content !== note.content) return false;
  if (String(existing.updated_at).slice(0, 19) !== String(note.updatedAt).slice(0, 19)) return false;

  const stored = parseStoredTags(existing.tags).map(String).sort();
  const incoming = (note.tags || []).map(String).sort();
  return stored.length === incoming.length && stored.every((t, i) => t === incoming[i]);
}

router.post('/push', authMiddleware, async (c) => {  const { value: body, response } = await parseJsonBody(c);
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

  // 逐条校验：一条超长/字段缺失的笔记只拒绝它自己，不拖垮整批。
  // 整批拒绝会让客户端永远卡在同一条毒丸上（每轮都失败、退避、重试）。
  const parsedNotes = [];
  const rejected = [];

  for (const raw of incomingNotes) {
    try {
      parsedNotes.push(normalizeIncomingNote(raw));
    } catch (e) {
      rejected.push({ id: String(raw?.id || ''), reason: e.message, status: e.status || 400 });
    }
  }

  const deletionIds = [];
  for (const item of incomingDeletions) {
    const id = String(item?.id || '');
    if (!V.isUUID(id)) {
      rejected.push({ id, reason: 'Invalid note ID format', status: 400 });
      continue;
    }
    deletionIds.push({
      id,
      baseSeq: Number.isFinite(Number(item?.baseSeq)) ? Math.max(0, Math.floor(Number(item.baseSeq))) : 0
    });
  }

  const allIds = [...new Set([...parsedNotes.map((n) => n.id), ...deletionIds.map((d) => d.id)])];

  // 全部被拒时不能继续：下面按 id 数量拼 IN 列表，空数组会生成非法 SQL。
  if (!allIds.length) {
    return c.json({
      applied: 0,
      deleted: 0,
      conflicts: [],
      rejected,
      notes: [],
      deletedIds: [],
      serverTime: new Date().toISOString(),
      latestSeq: await getLatestSeq()
    });
  }

  const latestByNote = await getLatestSeqByNoteIds(allIds);
  const sanitizedNotes = parsedNotes.map((note) => ({ ...note, content: sanitizeContent(note.content) }));

  const conflicts = [];
  const appliedNotes = [];
  const confirmed = [];
  const copyIds = new Set();

  for (const note of sanitizedNotes) {
    const serverSeq = latestByNote.get(note.id) || 0;

    if (serverSeq > note.baseSeq) {
      const existing = await db.prepare('SELECT * FROM notes WHERE id = ?').bind(note.id).first();

      if (existing && sameNoteContent(existing, note)) {
        confirmed.push({ id: note.id, seq: serverSeq });
        continue;
      }

      let copyId = null;
      if (existing) {
        copyId = crypto.randomUUID();
        copyIds.add(copyId);
        appliedNotes.push({
          id: copyId,
          title: `${existing.title}（冲突副本）`,
          category: existing.category,
          subcategory: existing.subcategory,
          tags: parseStoredTags(existing.tags),
          content: existing.content,
          createdAt: existing.created_at,
          updatedAt: existing.updated_at
        });
      }

      conflicts.push({
        id: note.id,
        kind: 'update',
        baseSeq: note.baseSeq,
        serverSeq,
        resolution: 'client_wins',
        copyId
      });
    }

    appliedNotes.push(note);
    confirmed.push({ id: note.id, seq: null });
  }

  // 服务端是否还有这篇笔记，一次查完（避免逐条 SELECT）。
  const existingById = new Map();
  if (deletionIds.length) {
    const placeholders = deletionIds.map(() => '?').join(',');
    const found = await db.prepare(`SELECT * FROM notes WHERE id IN (${placeholders})`)
      .bind(...deletionIds.map((d) => d.id))
      .all();
    for (const row of found.results || []) existingById.set(row.id, row);
  }

  const noteIdsToDelete = [];
  // 服务端已经不存在：删除目标已达成。不能返回冲突——否则客户端既没有
  // 可恢复的版本，也不会清队列，那条删除任务会永远留在本地反复重推。
  const alreadyGone = [];

  for (const item of deletionIds) {
    const existing = existingById.get(item.id);

    if (!existing) {
      alreadyGone.push(item.id);
      continue;
    }

    const serverSeq = latestByNote.get(item.id) || 0;
    if (serverSeq > item.baseSeq) {
      conflicts.push({
        id: item.id,
        kind: 'delete',
        baseSeq: item.baseSeq,
        serverSeq,
        resolution: 'server_wins',
        note: toClientNote(existing, serverSeq)
      });
      continue;
    }

    noteIdsToDelete.push(item.id);
  }

  const statements = [];

  appliedNotes.forEach((note) => {
    statements.push(upsertNoteStatement({
      id: note.id,
      title: note.title,
      category: note.category,
      subcategory: note.subcategory,
      tagsJson: serializeTags(note.tags),
      content: note.content,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt
    }));

    statements.push(...noteMediaStatements(note.id, note.content));
  });

  for (const id of noteIdsToDelete) {
    statements.push(db.prepare('DELETE FROM notes WHERE id = ?').bind(id));
    statements.push(db.prepare('DELETE FROM note_media WHERE note_id = ?').bind(id));
  }

  if (statements.length) {
    await db.batch(statements);
  }

  const unresolved = confirmed.filter((c) => c.seq === null).map((c) => c.id);
  if (unresolved.length) {
    const seqMap = await getLatestSeqByNoteIds([...new Set(unresolved)]);
    for (const c of confirmed) {
      if (c.seq === null) c.seq = seqMap.get(c.id) || 0;
    }
  }

  const foldersTouched = new Map();
  for (const note of appliedNotes) {
    foldersTouched.set(`${note.category}\u0000${note.subcategory}`, note);
  }
  for (const note of foldersTouched.values()) {
    await ensureFolderRecords(db, note.category, note.subcategory, note.createdAt, note.updatedAt);
  }

  return c.json({
    applied: appliedNotes.length - copyIds.size,
    deleted: noteIdsToDelete.length + alreadyGone.length,
    conflicts,
    rejected,
    notes: confirmed.map((c) => ({ id: c.id, seq: c.seq })),
    deletedIds: [...noteIdsToDelete, ...alreadyGone],
    serverTime: new Date().toISOString(),
    latestSeq: await getLatestSeq()
  });
});

router.get('/media', authMiddleware, async (c) => {
  const { results } = await db.prepare(
    'SELECT DISTINCT media_key FROM note_media ORDER BY media_key'
  ).all();

  return c.json({
    keys: (results || []).map((row) => row.media_key)
  });
});

export default router;

