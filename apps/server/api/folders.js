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

  try {
    if (!oldSubcategory) {
      // Renaming a top-level category
      const updateNotes = db.prepare(
        'UPDATE notes SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE category = ?'
      ).bind(newName, oldCategory);
      const updateFolders = db.prepare(
        'UPDATE folders SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE category = ?'
      ).bind(newName, oldCategory);
      
      await db.batch([updateNotes, updateFolders]);
      
      return c.json({ success: true, oldCategory, newCategory: newName });
    } else {
      // Renaming a subcategory
      const updateNotes = db.prepare(
        'UPDATE notes SET subcategory = ?, updated_at = CURRENT_TIMESTAMP WHERE category = ? AND subcategory = ?'
      ).bind(newName, oldCategory, oldSubcategory);
      const updateFolders = db.prepare(
        'UPDATE folders SET subcategory = ?, updated_at = CURRENT_TIMESTAMP WHERE category = ? AND subcategory = ?'
      ).bind(newName, oldCategory, oldSubcategory);

      await db.batch([updateNotes, updateFolders]);
      
      return c.json({ success: true, oldCategory, oldSubcategory, newSubcategory: newName });
    }
  } catch (err) {
    if (String(err?.message || '').includes('UNIQUE constraint failed')) {
      return jsonError(c, 'Folder name already exists', 409);
    }
    throw err;
  }
});

export default router;
