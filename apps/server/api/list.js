import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { parseStoredTags } from '../lib/utils.js';
import { getQueryString, jsonError } from '../lib/http.js';
import { renderArchiveEmptyState, renderArchiveList, renderPagination } from '../lib/views.js';
import { V } from '../lib/validate.js';
import { db } from '../lib/core.js';

const router = new Hono();

function toClientNote(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    subcategory: row.subcategory,
    tags: parseStoredTags(row.tags),
    content: typeof row.content === 'string' ? row.content : '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function buildFtsQuery(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, '""'))
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(' AND ');
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (char) => `\\${char}`);
}

function buildQuery(category, subcategory, search, tag) {
  const conditions = [];
  const params = [];

  const safeCategory = String(category || '').trim();
  const safeSubcategory = String(subcategory || '').trim();
  if (safeCategory) {
    conditions.push('n.category = ?');
    params.push(safeCategory);
  }
  if (safeSubcategory) {
    conditions.push('n.subcategory = ?');
    params.push(safeSubcategory);
  }

  const q = String(search || '').trim().toLowerCase();
  if (q) {
    const ftsQuery = buildFtsQuery(q);
    const searchClauses = [];
    if (ftsQuery) {
      searchClauses.push('n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)');
      params.push(ftsQuery);
    }
    searchClauses.push(`EXISTS (
      SELECT 1
      FROM note_tags nt
      WHERE nt.note_id = n.id AND nt.tag_key LIKE ? ESCAPE '\\'
    )`);
    params.push(`%${escapeLike(q)}%`);
    conditions.push(`(${searchClauses.join(' OR ')})`);
  }

  const safeTag = String(tag || '').trim().toLowerCase();
  if (safeTag) {
    conditions.push(`EXISTS (
      SELECT 1
      FROM note_tags nt
      WHERE nt.note_id = n.id AND nt.tag_key = ?
    )`);
    params.push(safeTag);
  }

  return {
    conditions,
    params,
    hasFolderScope: !!(safeCategory && safeSubcategory)
  };
}

router.get('/', authMiddleware, async (c) => {
  const page = getQueryString(c, 'page', '1');
  const size = getQueryString(c, 'size', '10');
  const category = getQueryString(c, 'category');
  const subcategory = getQueryString(c, 'subcategory');
  const q = getQueryString(c, 'q');
  const tag = getQueryString(c, 'tag');
  const id = getQueryString(c, 'id');

  if (id) {
    if (!V.isUUID(id)) return jsonError(c, 'Invalid ID', 400);
    const row = await db.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first();
    return c.json(toClientNote(row) || {});
  }

  const limit = V.safeInt(size, 10, 1, 50);
  const requestedPage = V.safeInt(page, 1, 1, 9999);
  const { conditions, params, hasFolderScope } = buildQuery(category, subcategory, q, tag);
  const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = await db.prepare(
    `SELECT COUNT(*) AS total
     FROM notes n${whereClause}`
  ).bind(...params).first();
  const total = Number(totalRow?.total ?? 0);
  const totalPg = Math.max(1, Math.ceil(total / limit));

  // A stale URL can point past the end (last note on the final page deleted, or
  // an old bookmark). Clamp to the last real page so the list never renders as
  // empty while notes actually exist.
  const safePage = Math.min(requestedPage, totalPg);

  const listRes = await db.prepare(
    `SELECT id, title, category, subcategory, tags, created_at, updated_at
     FROM notes n${whereClause}
     ORDER BY n.title COLLATE NOCASE ASC, n.updated_at DESC, n.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, (safePage - 1) * limit).all();
  const list = (listRes.results ?? []).map(toClientNote);

  if (c.req.header('HX-Request')) {
    const hasAnyFilter = !!String(q || '').trim() || !!String(tag || '').trim();
    const html = list.length
      ? renderArchiveList(list)
      : `<div class="loading-hint">${renderArchiveEmptyState({ hasFolderScope, hasAnyFilter })}</div>`;

    return c.html(`${html}${renderPagination(safePage, totalPg)}`);
  }

  return c.json({ list, total });
});

export default router;
