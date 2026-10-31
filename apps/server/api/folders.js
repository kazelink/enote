import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { cleanupMediaKeys, extractMediaKeys, normalizeFolderName } from '../lib/utils.js';
import { ensureFolderRecords, loadFolderTree } from '../lib/folders.js';
import { getQueryString, jsonError, parseJsonBody } from '../lib/http.js';
import { db, bucket, runBackground } from '../lib/core.js';

const router = new Hono();

router.get('/tree', authMiddleware, async (c) => {
  try {
    const tree = await loadFolderTree(db);
    return c.json(tree);
  } catch (err) {
    console.error('Failed to load folder tree:', err);
    return jsonError(c, 'Failed to load folder tree', 500);
  }
});

router.post('/', authMiddleware, async (c) => {
  const { value: body, response } = await parseJsonBody(c);
  if (response) return response;

  const category = normalizeFolderName(body?.category);
  const subcategory = normalizeFolderName(body?.subcategory);

  if (!category) {
    return jsonError(c, 'Major category required', 400);
  }

  const now = new Date().toISOString();
  await ensureFolderRecords(db, category, subcategory, now, now);

  return c.json({
    success: true,
    category,
    subcategory,
    createdAt: now,
    updatedAt: now
  });
});

router.delete('/', authMiddleware, async (c) => {
  const category = normalizeFolderName(getQueryString(c, 'category'));
  const subcategory = normalizeFolderName(getQueryString(c, 'subcategory'));

  if (!category) {
    return jsonError(c, 'Major category required', 400);
  }

  const where = subcategory
    ? { sql: 'category = ? AND subcategory = ?', params: [category, subcategory] }
    : { sql: 'category = ?', params: [category] };

  const mediaSummary = await db.prepare(
    `SELECT COUNT(*) AS total, group_concat(content, '') AS content_blob
     FROM notes
     WHERE ${where.sql}`
  ).bind(...where.params).first();
  const deletedNotes = Number(mediaSummary?.total ?? 0);
  const mediaKeys = new Set(extractMediaKeys(mediaSummary?.content_blob || ''));

  const deleteNotesStmt = db.prepare(
    `DELETE FROM notes WHERE ${where.sql}`
  ).bind(...where.params);
  const deleteFoldersStmt = db.prepare(
    `DELETE FROM folders WHERE ${where.sql}`
  ).bind(...where.params);

  await db.batch([deleteNotesStmt, deleteFoldersStmt]);

  if (mediaKeys.size > 0) {
    runBackground(cleanupMediaKeys(bucket, [...mediaKeys], db));
  }

  return c.json({
    success: true,
    category,
    subcategory,
    deletedNotes
  });
});

router.put('/', authMiddleware, async (c) => {
  const { value: body, response } = await parseJsonBody(c);
  if (response) return response;

  const oldCategory = normalizeFolderName(body?.oldCategory);
  const oldSubcategory = normalizeFolderName(body?.oldSubcategory);
  const newName = normalizeFolderName(body?.newName);

  if (!oldCategory || !newName) {
    return jsonError(c, 'Invalid rename parameters', 400);
  }

  const targetColumn = oldSubcategory ? 'subcategory' : 'category';
  const whereSql = oldSubcategory ? 'category = ? AND subcategory = ?' : 'category = ?';
  const whereParams = oldSubcategory ? [oldCategory, oldSubcategory] : [oldCategory];

  try {
    await db.batch([
      db.prepare(`UPDATE notes SET ${targetColumn} = ? WHERE ${whereSql}`)
        .bind(newName, ...whereParams),
      db.prepare(`UPDATE folders SET ${targetColumn} = ?, updated_at = CURRENT_TIMESTAMP WHERE ${whereSql}`)
        .bind(newName, ...whereParams)
    ]);

    return c.json(oldSubcategory
      ? { success: true, oldCategory, oldSubcategory, newSubcategory: newName }
      : { success: true, oldCategory, newCategory: newName });
  } catch (err) {
    if (String(err?.message || '').includes('UNIQUE constraint failed')) {
      return jsonError(c, 'Folder name already exists', 409);
    }
    throw err;
  }
});

export default router;

