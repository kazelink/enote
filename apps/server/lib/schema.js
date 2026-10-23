const RETRY_DELAYS_MS = [0, 250, 750, 1500];
const REQUIRED_TABLES = ['notes', 'folders', 'note_tags', 'note_media', 'notes_fts'];
const REQUIRED_TRIGGERS = [
  'note_tags_after_insert',
  'note_tags_after_update',
  'note_tags_after_delete',
  'notes_fts_after_insert',
  'notes_fts_after_update',
  'notes_fts_after_delete'
];
const TABLE_COLUMNS = {
  notes: ['id', 'title', 'category', 'subcategory', 'tags', 'content', 'created_at', 'updated_at'],
  note_tags: ['note_id', 'tag_name', 'tag_key'],
  note_media: ['note_id', 'media_key'],
  folders: ['category', 'subcategory', 'created_at', 'updated_at']
};

const CREATE_NOTES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`.trim();

const CREATE_NOTE_TAGS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  tag_key TEXT NOT NULL,
  PRIMARY KEY (note_id, tag_key)
);
`.trim();

const CREATE_NOTE_MEDIA_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS note_media (
  note_id TEXT NOT NULL,
  media_key TEXT NOT NULL,
  PRIMARY KEY (note_id, media_key),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);
`.trim();

const CREATE_NOTES_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  content,
  content='notes',
  content_rowid='rowid'
);
`.trim();

const CREATE_FOLDERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS folders (
  category TEXT NOT NULL,
  subcategory TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (category, subcategory)
);
`.trim();

const COLUMN_MIGRATIONS = {
  notes: {
    title: `ALTER TABLE notes ADD COLUMN title TEXT DEFAULT '';`,
    category: `ALTER TABLE notes ADD COLUMN category TEXT DEFAULT '';`,
    subcategory: `ALTER TABLE notes ADD COLUMN subcategory TEXT DEFAULT '';`,
    tags: `ALTER TABLE notes ADD COLUMN tags TEXT DEFAULT '[]';`,
    content: `ALTER TABLE notes ADD COLUMN content TEXT DEFAULT '';`,
    created_at: `ALTER TABLE notes ADD COLUMN created_at TEXT DEFAULT '';`,
    updated_at: `ALTER TABLE notes ADD COLUMN updated_at TEXT DEFAULT '';`
  },
  folders: {
    subcategory: `ALTER TABLE folders ADD COLUMN subcategory TEXT DEFAULT '';`,
    created_at: `ALTER TABLE folders ADD COLUMN created_at TEXT DEFAULT '';`,
    updated_at: `ALTER TABLE folders ADD COLUMN updated_at TEXT DEFAULT '';`
  }
};

const INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_notes_category_subcategory_updated ON notes(category, subcategory, updated_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_notes_category_updated ON notes(category, updated_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_notes_title_nocase ON notes(title COLLATE NOCASE ASC);',
  'CREATE INDEX IF NOT EXISTS idx_notes_cat_sub_title ON notes(category, subcategory, title COLLATE NOCASE ASC);',
  'CREATE INDEX IF NOT EXISTS idx_notes_cat_title ON notes(category, title COLLATE NOCASE ASC);',
  'CREATE INDEX IF NOT EXISTS idx_note_tags_tag_key ON note_tags(tag_key, note_id);',
  'CREATE INDEX IF NOT EXISTS idx_note_tags_note_id ON note_tags(note_id);',
  'CREATE INDEX IF NOT EXISTS idx_note_media_media_key ON note_media(media_key);',
  'CREATE INDEX IF NOT EXISTS idx_note_media_note_id ON note_media(note_id);',
  'CREATE INDEX IF NOT EXISTS idx_folders_subcategory ON folders(subcategory);',
  'DROP INDEX IF EXISTS idx_notes_title;',
  'DROP INDEX IF EXISTS idx_folders_category;',
  'DROP INDEX IF EXISTS idx_folders_category_subcategory;'
];

const TRIGGER_STATEMENTS = [
  'DROP TRIGGER IF EXISTS note_tags_after_insert;',
  'DROP TRIGGER IF EXISTS note_tags_after_update;',
  'DROP TRIGGER IF EXISTS note_tags_after_delete;',
  'DROP TRIGGER IF EXISTS notes_fts_after_insert;',
  'DROP TRIGGER IF EXISTS notes_fts_after_update;',
  'DROP TRIGGER IF EXISTS notes_fts_after_delete;',
  `
  CREATE TRIGGER note_tags_after_insert
  AFTER INSERT ON notes
  BEGIN
    INSERT OR IGNORE INTO note_tags (note_id, tag_name, tag_key)
    SELECT
      NEW.id,
      trim(CAST(value AS TEXT)),
      lower(trim(CAST(value AS TEXT)))
    FROM json_each(CASE WHEN json_valid(NEW.tags) THEN NEW.tags ELSE '[]' END)
    WHERE trim(CAST(value AS TEXT)) != '';
  END
  `,
  `
  CREATE TRIGGER note_tags_after_update
  AFTER UPDATE OF tags ON notes
  BEGIN
    DELETE FROM note_tags WHERE note_id = OLD.id;
    INSERT OR IGNORE INTO note_tags (note_id, tag_name, tag_key)
    SELECT
      NEW.id,
      trim(CAST(value AS TEXT)),
      lower(trim(CAST(value AS TEXT)))
    FROM json_each(CASE WHEN json_valid(NEW.tags) THEN NEW.tags ELSE '[]' END)
    WHERE trim(CAST(value AS TEXT)) != '';
  END
  `,
  `
  CREATE TRIGGER note_tags_after_delete
  AFTER DELETE ON notes
  BEGIN
    DELETE FROM note_tags WHERE note_id = OLD.id;
  END
  `,
  `
  CREATE TRIGGER notes_fts_after_insert
  AFTER INSERT ON notes
  BEGIN
    INSERT INTO notes_fts(rowid, title, content)
    VALUES (NEW.rowid, NEW.title, NEW.content);
  END
  `,
  `
  CREATE TRIGGER notes_fts_after_update
  AFTER UPDATE OF title, content ON notes
  BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content)
    VALUES('delete', OLD.rowid, OLD.title, OLD.content);
    INSERT INTO notes_fts(rowid, title, content)
    VALUES (NEW.rowid, NEW.title, NEW.content);
  END
  `,
  `
  CREATE TRIGGER notes_fts_after_delete
  AFTER DELETE ON notes
  BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content)
    VALUES('delete', OLD.rowid, OLD.title, OLD.content);
  END
  `
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hasRequiredObjects(db, type, names) {
  const placeholders = names.map(() => '?').join(', ');
  const { results } = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type = ? AND name IN (${placeholders})`
  ).bind(type, ...names).all();

  const found = new Set((results || []).map((row) => row.name));
  return names.every((name) => found.has(name));
}

async function getTableColumns(db, tableName) {
  const { results } = await db.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set((results || []).map((row) => row.name));
}

async function hasRequiredSchema(db) {
  const tablesReady = await hasRequiredObjects(db, 'table', REQUIRED_TABLES);
  if (!tablesReady) return false;

  const triggersReady = await hasRequiredObjects(db, 'trigger', REQUIRED_TRIGGERS);
  if (!triggersReady) return false;

  for (const [tableName, columns] of Object.entries(TABLE_COLUMNS)) {
    const existingColumns = await getTableColumns(db, tableName);
    if (!columns.every((column) => existingColumns.has(column))) return false;
  }

  return true;
}

async function runStatement(db, sql) {
  const statement = sql.trim().endsWith(';') ? sql.trim() : `${sql.trim()};`;
  await db.prepare(statement).run();
}

async function ensureTableColumns(db, tableName) {
  const columns = await getTableColumns(db, tableName);
  for (const column of TABLE_COLUMNS[tableName]) {
    if (!columns.has(column) && COLUMN_MIGRATIONS[tableName]?.[column]) {
      await runStatement(db, COLUMN_MIGRATIONS[tableName][column]);
    }
  }
}

async function backfillLegacyNotes(db, columns) {
  const nowExpr = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  const legacyDateExpr = columns.has('date')
    ? `CASE
         WHEN date IS NOT NULL AND length(trim(date)) = 10 THEN trim(date) || 'T00:00:00.000Z'
         ELSE ${nowExpr}
       END`
    : nowExpr;

  await runStatement(db, `
    UPDATE notes
    SET title = 'Untitled Note'
    WHERE title IS NULL OR trim(title) = ''
  `);

  await runStatement(db, `
    UPDATE notes
    SET category = 'Imported'
    WHERE category IS NULL OR trim(category) = ''
  `);

  await runStatement(db, `
    UPDATE notes
    SET subcategory = 'Legacy'
    WHERE subcategory IS NULL OR trim(subcategory) = ''
  `);

  await runStatement(db, `
    UPDATE notes
    SET tags = '[]'
    WHERE tags IS NULL OR trim(tags) = '' OR substr(trim(tags), 1, 1) != '['
  `);

  await runStatement(db, `
    UPDATE notes
    SET created_at = ${legacyDateExpr}
    WHERE created_at IS NULL OR trim(created_at) = ''
  `);

  await runStatement(db, `
    UPDATE notes
    SET updated_at = created_at
    WHERE updated_at IS NULL OR trim(updated_at) = ''
  `);
}

async function backfillFoldersFromNotes(db) {
  await runStatement(db, `
    INSERT INTO folders (category, subcategory, created_at, updated_at)
    SELECT
      category,
      '',
      MIN(created_at) AS created_at,
      MAX(updated_at) AS updated_at
    FROM notes
    WHERE trim(category) != ''
    GROUP BY category
    ON CONFLICT(category, subcategory) DO UPDATE SET
      created_at = CASE
        WHEN excluded.created_at < folders.created_at THEN excluded.created_at
        ELSE folders.created_at
      END,
      updated_at = CASE
        WHEN excluded.updated_at > folders.updated_at THEN excluded.updated_at
        ELSE folders.updated_at
      END
  `);

  await runStatement(db, `
    INSERT INTO folders (category, subcategory, created_at, updated_at)
    SELECT
      category,
      subcategory,
      MIN(created_at) AS created_at,
      MAX(updated_at) AS updated_at
    FROM notes
    WHERE trim(category) != '' AND trim(subcategory) != ''
    GROUP BY category, subcategory
    ON CONFLICT(category, subcategory) DO UPDATE SET
      created_at = CASE
        WHEN excluded.created_at < folders.created_at THEN excluded.created_at
        ELSE folders.created_at
      END,
      updated_at = CASE
        WHEN excluded.updated_at > folders.updated_at THEN excluded.updated_at
        ELSE folders.updated_at
      END
  `);

  await runStatement(db, `
    UPDATE folders
    SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE created_at IS NULL OR trim(created_at) = ''
  `);

  await runStatement(db, `
    UPDATE folders
    SET updated_at = created_at
    WHERE updated_at IS NULL OR trim(updated_at) = ''
  `);
}

async function syncNoteTags(db) {
  await runStatement(db, 'DELETE FROM note_tags');
  await runStatement(db, `
    INSERT OR IGNORE INTO note_tags (note_id, tag_name, tag_key)
    SELECT
      n.id,
      trim(CAST(json_each.value AS TEXT)) AS tag_name,
      lower(trim(CAST(json_each.value AS TEXT))) AS tag_key
    FROM notes n, json_each(CASE WHEN json_valid(n.tags) THEN n.tags ELSE '[]' END)
    WHERE trim(CAST(json_each.value AS TEXT)) != ''
  `);
}

async function rebuildNotesFts(db) {
  await runStatement(db, "INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
}

async function applySearchTriggers(db) {
  for (const sql of TRIGGER_STATEMENTS) {
    await runStatement(db, sql);
  }
}

async function applySchema(db) {
  await runStatement(db, CREATE_NOTES_TABLE_SQL);
  await ensureTableColumns(db, 'notes');

  const noteColumns = await getTableColumns(db, 'notes');
  await backfillLegacyNotes(db, noteColumns);

  await runStatement(db, CREATE_NOTE_TAGS_TABLE_SQL);
  await ensureTableColumns(db, 'note_tags');
  
  await runStatement(db, CREATE_NOTE_MEDIA_TABLE_SQL);
  await ensureTableColumns(db, 'note_media');
  
  await runStatement(db, CREATE_NOTES_FTS_SQL);
  await syncNoteTags(db);
  await rebuildNotesFts(db);

  await runStatement(db, CREATE_FOLDERS_TABLE_SQL);
  await ensureTableColumns(db, 'folders');
  await backfillFoldersFromNotes(db);

  for (const sql of INDEX_STATEMENTS) {
    await runStatement(db, sql);
  }

  await applySearchTriggers(db);

  await runStatement(db, 'DROP TABLE IF EXISTS note_stats');
  await runStatement(db, 'DROP TRIGGER IF EXISTS t_insert_note');
  await runStatement(db, 'DROP TRIGGER IF EXISTS t_delete_note');
  await runStatement(db, 'DROP TRIGGER IF EXISTS t_update_note');
}

let schemaReadyPromise = null;

import { db } from './core.js';

export async function ensureSchema() {
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    let lastError = null;

    for (const delayMs of RETRY_DELAYS_MS) {
      if (delayMs > 0) await sleep(delayMs);

      try {
        if (await hasRequiredSchema(db)) {
          return;
        }

        await applySchema(db);

        if (await hasRequiredSchema(db)) {
          return;
        }

        throw new Error('Database schema is still incomplete after initialization');
      } catch (error) {
        lastError = error;
        console.error('Schema initialization attempt failed:', error);
      }
    }

    throw lastError || new Error('Failed to initialize database schema');
  })().catch((error) => {
    schemaReadyPromise = null;
    throw error;
  });

  return schemaReadyPromise;
}
