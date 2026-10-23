/**
 * Sync layer schema.
 *
 * Design notes:
 * - We do NOT touch the existing `notes` / `folders` tables. `notes.updated_at`
 *   already carries business meaning (the user-chosen note date, day precision),
 *   so it cannot double as a revision counter.
 * - Instead every write is appended to `sync_changes`, an append-only change
 *   stream. Its AUTOINCREMENT `seq` is a strictly monotonic, global cursor:
 *   it totally orders all writes and never collides across clients.
 * - Triggers keep the stream complete without editing any existing write path
 *   (save / delete / folders / tags / backup all write through SQL directly).
 *   The triggers only INSERT into a separate table, never UPDATE the row, so
 *   there is no trigger recursion and no behavioural change to current code.
 * - Folders are a projection of notes and are rarely very numerous, so clients
 *   rebuild them from notes and only fetch the (small) folder list in full.
 */
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

// One INSERT-only trigger per (table, operation). `NEW.id` is used for updates
// because a note's id never changes.
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

  // Backfill: a database created before this layer existed has notes but no
  // change rows, so a fresh client would pull nothing. Seed one row per note
  // only when the stream is still empty.
  const empty = await db.prepare('SELECT 1 AS x FROM sync_changes LIMIT 1').first();
  if (!empty) {
    await db.prepare(`
      INSERT INTO sync_changes (entity, entity_id, op, changed_at)
      SELECT 'note', id, 'upsert', ${NOW_SQL} FROM notes
    `).run();
  }
}

/**
 * Idempotent. Safe to call on every startup; resolved once per process.
 */
export async function ensureSyncSchema() {
  if (syncSchemaReady) return syncSchemaReady;

  syncSchemaReady = applySyncSchema().catch((error) => {
    syncSchemaReady = null;
    throw error;
  });

  return syncSchemaReady;
}

/**
 * Current global cursor value. Clients compare this against their stored
 * cursor to decide whether a pull is needed at all.
 */
export async function getLatestSeq() {
  const row = await db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS seq FROM sync_changes'
  ).first();
  return Number(row?.seq || 0);
}

/**
 * Latest seq per note id, for optimistic-concurrency checks on push.
 * Returns a Map<noteId, seq>; ids with no change rows map to 0.
 */
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

/**
 * Resolve the change window into the minimal set of "current state" entries.
 *
 * A note can be written many times inside one window; only its newest change
 * matters, because the client applies whole records rather than deltas. The
 * inner GROUP BY collapses those repeats, and the join recovers the op that
 * belongs to the winning (largest) seq.
 */
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

/**
 * Note rows for a set of ids, keyed by id. Missing ids mean the row was
 * physically deleted after its last upsert (delete.js does a hard DELETE), so
 * callers must treat "absent" as a deletion rather than silently skipping.
 */
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
