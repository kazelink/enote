import { UPSERT_FOLDER_SQL } from './sql.js';
import { normalizeTimestamp } from './utils.js';

function normalizeFolderTimestamps(createdAt, updatedAt) {
  const now = new Date().toISOString();
  const safeCreatedAt = normalizeTimestamp(createdAt, now) || now;
  const safeUpdatedAt = normalizeTimestamp(updatedAt, safeCreatedAt) || safeCreatedAt;
  return { createdAt: safeCreatedAt, updatedAt: safeUpdatedAt };
}

export async function ensureFolderRecords(db, category, subcategory, createdAt, updatedAt) {
  if (!category) return;

  const timestamps = normalizeFolderTimestamps(createdAt, updatedAt);
  const stmts = [
    db.prepare(UPSERT_FOLDER_SQL).bind(category, '', timestamps.createdAt, timestamps.updatedAt)
  ];
  if (subcategory) {
    stmts.push(db.prepare(UPSERT_FOLDER_SQL).bind(category, subcategory, timestamps.createdAt, timestamps.updatedAt));
  }
  await db.batch(stmts);
}

function parseFolderRow(row) {
  try {
    const subfolders = row.subfolders_json ? JSON.parse(row.subfolders_json) : [];
    return {
      category: row.category,
      count: row.count,
      updated_at: row.updated_at,
      subfolders: Array.isArray(subfolders) ? subfolders : []
    };
  } catch (e) {
    console.error('Failed to parse subfolders JSON:', e);
    return {
      category: row.category,
      count: row.count,
      updated_at: row.updated_at,
      subfolders: []
    };
  }
}

// Optimized: Use SQLite json_group_array for tree structure in database
export async function loadFolderTree(db) {
  // Single optimized query: SQLite builds the tree structure
  const result = await db.prepare(`
    SELECT
      f.category,
      COALESCE(cat_notes.cnt, 0) AS count,
      COALESCE(cat_notes.max_upd, f.updated_at) AS updated_at,
      COALESCE(
        json_group_array(
          json_object(
            'category', sf.category,
            'subcategory', sf.subcategory,
            'count', COALESCE(sub_notes.cnt, 0),
            'updated_at', COALESCE(sub_notes.max_upd, sf.updated_at)
          )
        ) FILTER (WHERE sf.subcategory != ''),
        '[]'
      ) AS subfolders_json
    FROM folders f
    LEFT JOIN (
      SELECT category, COUNT(*) AS cnt, MAX(updated_at) AS max_upd
      FROM notes
      GROUP BY category
    ) cat_notes ON cat_notes.category = f.category
    LEFT JOIN folders sf ON sf.category = f.category
    LEFT JOIN (
      SELECT category, subcategory, COUNT(*) AS cnt, MAX(updated_at) AS max_upd
      FROM notes
      GROUP BY category, subcategory
    ) sub_notes ON sub_notes.category = sf.category AND sub_notes.subcategory = sf.subcategory
    WHERE f.subcategory = ''
    GROUP BY f.category, f.updated_at, cat_notes.cnt, cat_notes.max_upd
    ORDER BY lower(f.category) ASC
  `).all();

  if (!result?.results) return [];

  return result.results.map(parseFolderRow);
}
