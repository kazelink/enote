import { db } from './core.js';

const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

const CREATE_CHANGES_SQL = `
CREATE TABLE IF NOT EXISTS sync_changes (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT    NOT NULL,
  entity_id  TEXT    NOT NULL,
  op         TEXT    NOT NULL,
  changed_at TEXT    NOT NULL
);
`.trim();

const CHANGE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_sync_changes_entity ON sync_changes(entity, entity_id, seq DESC);',
  'CREATE INDEX IF NOT EXISTS idx_sync_changes_seq ON sync_changes(seq);'
];

const TRIGGERS = [
  `
  CREATE TRIGGER IF NOT EXISTS sync_notes_ai AFTER INSERT ON notes
  BEGIN
    INSERT INTO sync_changes (entity, entity_id, op, changed_at)
    VALUES ('note', NEW.id, 'upsert', ${NOW_SQL});
  END
  `,
  `
  CREATE TRIGGER IF NOT EXISTS sync_notes_au AFTER UPDATE ON notes
  BEGIN
    INSERT INTO sync_changes (entity, entity_id, op, changed_at)
    VALUES ('note', NEW.id, 'upsert', ${NOW_SQL});
  END
  `,
  `
  CREATE TRIGGER IF NOT EXISTS sync_notes_ad AFTER DELETE ON notes
  BEGIN
    INSERT INTO sync_changes (entity, entity_id, op, changed_at)
    VALUES ('note', OLD.id, 'delete', ${NOW_SQL});
  END
  `,
  `
  CREATE TRIGGER IF NOT EXISTS sync_folders_ai AFTER INSERT ON folders
  BEGIN
    INSERT INTO sync_changes (entity, entity_id, op, changed_at)
    VALUES ('folder', NEW.category || '/' || NEW.subcategory, 'upsert', ${NOW_SQL});
  END
  `,
  `
  CREATE TRIGGER IF NOT EXISTS sync_folders_au AFTER UPDATE ON folders
  BEGIN
    INSERT INTO sync_changes (entity, entity_id, op, changed_at)
    VALUES ('folder', NEW.category || '/' || NEW.subcategory, 'upsert', ${NOW_SQL});
  END
  `,
  `
  CREATE TRIGGER IF NOT EXISTS sync_folders_ad AFTER DELETE ON folders
  BEGIN
    INSERT INTO sync_changes (entity, entity_id, op, changed_at)
    VALUES ('folder', OLD.category || '/' || OLD.subcategory, 'delete', ${NOW_SQL});
  END
  `
];

let syncSchemaReady = null;

async function applySyncSchema() {
  await db.prepare(CREATE_CHANGES_SQL).run();

  for (const sql of CHANGE_INDEXES) {
    await db.prepare(sql).run();
  }

  for (const sql of TRIGGERS) {
    await db.prepare(sql).run();
  }

  const empty = await db.prepare('SELECT 1 AS x FROM sync_changes LIMIT 1').first();
  if (!empty) {
    await db.prepare(`
      INSERT INTO sync_changes (entity, entity_id, op, changed_at)
      SELECT 'note', id, 'upsert', ${NOW_SQL} FROM notes
    `).run();
  }
}

export async function ensureSyncSchema() {
  if (syncSchemaReady) return syncSchemaReady;

  syncSchemaReady = applySyncSchema().catch((error) => {
    syncSchemaReady = null;
    throw error;
  });

  return syncSchemaReady;
}

export async function getLatestSeq() {
  const row = await db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS seq FROM sync_changes'
  ).first();
  return Number(row?.seq || 0);
}

export async function getLatestSeqByNoteIds(ids) {
  const map = new Map();
  if (!ids.length) return map;

  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db.prepare(`
    SELECT entity_id, MAX(seq) AS seq
    FROM sync_changes
    WHERE entity = 'note' AND entity_id IN (${placeholders})
    GROUP BY entity_id
  `).bind(...ids).all();

  for (const row of results || []) {
    map.set(row.entity_id, Number(row.seq));
  }
  return map;
}

export async function pruneSyncChanges({ retainDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000).toISOString();

  // 每条实体必须保留最新一行：since=0 的全量拉取只读 sync_changes，
  // 如果某篇笔记 30 天没动过就被清光记录，新设备将永远拉不到它。
  await db.prepare(
    `DELETE FROM sync_changes
     WHERE changed_at < ?
       AND seq NOT IN (
         SELECT MAX(seq) FROM sync_changes GROUP BY entity, entity_id
       )`
  ).bind(cutoff).run();

  return { cutoff };
}

export async function getMinSeq() {
  const row = await db.prepare('SELECT MIN(seq) AS seq FROM sync_changes').first();
  return Number(row?.seq) || 0;
}

export async function listChangesSince(since, limit) {
  const { results } = await db.prepare(`
    WITH latest AS (
      SELECT entity_id, MAX(seq) AS max_seq
      FROM sync_changes
      WHERE entity = 'note' AND seq > ?
      GROUP BY entity_id
      ORDER BY max_seq ASC
      LIMIT ?
    )
    SELECT c.entity_id, c.op, c.seq, c.changed_at
    FROM sync_changes c
    JOIN latest l ON l.entity_id = c.entity_id AND l.max_seq = c.seq
    ORDER BY c.seq ASC
  `).bind(since, limit).all();

  return results || [];
}

export async function getNotesByIds(ids) {
  const map = new Map();
  if (!ids.length) return map;

  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db.prepare(
    `SELECT * FROM notes WHERE id IN (${placeholders})`
  ).bind(...ids).all();

  for (const row of results || []) {
    map.set(row.id, row);
  }
  return map;
}

export async function listAllFolders() {
  const { results } = await db.prepare(
    'SELECT category, subcategory, created_at, updated_at FROM folders ORDER BY category, subcategory'
  ).all();
  return results || [];
}

