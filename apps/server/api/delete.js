import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { getQueryString, jsonError } from '../lib/http.js';
import { cleanupMediaKeys, extractMediaKeys } from '../lib/utils.js';
import { V } from '../lib/validate.js';
import { db, bucket, runBackground } from '../lib/core.js';

const router = new Hono();

router.delete('/', authMiddleware, async (c) => {
  const id = getQueryString(c, 'id');
  if (!id || !V.isUUID(id)) return jsonError(c, 'Invalid ID', 400);

  const entry = await db.prepare('SELECT content FROM notes WHERE id = ?').bind(id).first();
  if (!entry) return jsonError(c, 'Not found', 404);

  await db.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
  runBackground(cleanupMediaKeys(bucket, extractMediaKeys(entry.content), db));

  return c.json({ success: true });
});

export default router;
