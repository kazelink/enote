import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { db } from '../lib/core.js';
import { jsonError, parseJsonBody } from '../lib/http.js';

const router = new Hono();

router.get('/', authMiddleware, async (c) => {
  const { results } = await db.prepare(`
    SELECT
      MIN(tag_name) AS tag,
      COUNT(DISTINCT note_id) AS count
    FROM note_tags
    GROUP BY tag_key
    ORDER BY tag_key ASC
  `).all();

  return c.json(results ?? []);
});

router.put('/', authMiddleware, async (c) => {
  const { value: body, response } = await parseJsonBody(c);
  if (response) return response;

  const oldName = String(body?.oldName || '').trim();
  const newName = String(body?.newName || '').trim();
  if (!oldName || !newName) return jsonError(c, 'Invalid rename parameters', 400);
  if (oldName === newName) return c.json({ success: true, oldName, newName });

  const oldKey = oldName.toLowerCase();

  await db.prepare(`
    UPDATE notes
    SET tags = (
      SELECT json_group_array(v) FROM (
        SELECT DISTINCT CASE
          WHEN lower(trim(CAST(j.value AS TEXT))) = ? THEN ?
          ELSE trim(CAST(j.value AS TEXT))
        END AS v
        FROM json_each(notes.tags) j
        WHERE trim(CAST(j.value AS TEXT)) != ''
      )
    ),
    updated_at = CURRENT_TIMESTAMP
    WHERE EXISTS (
      SELECT 1 FROM json_each(notes.tags) j
      WHERE lower(trim(CAST(j.value AS TEXT))) = ?
    )
  `).bind(oldKey, newName, oldKey).run();

  return c.json({ success: true, oldName, newName });
});

export default router;
