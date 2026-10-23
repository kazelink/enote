import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { ensureFolderRecords } from '../lib/folders.js';
import { jsonError, parseJsonBody } from '../lib/http.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { cleanupImages, cleanupMediaKeys, extractMediaKeys, normalizeFolderName, normalizeTagList, normalizeTitle, serializeTags } from '../lib/utils.js';
import { V } from '../lib/validate.js';
import { UPSERT_NOTE_SQL } from '../lib/sql.js';
import { db, bucket, runBackground } from '../lib/core.js';

const router = new Hono();

const MAX_SAVE_CONTENT_LENGTH = 500_000;
const TMP_MEDIA_REGEX = /\/(img|video)\/tmp\/([a-zA-Z0-9.\-_]+)/g;

function planTempMediaPromotion(content) {
  const tmpMatches = [...content.matchAll(TMP_MEDIA_REGEX)];
  const finalKeys = [...new Set(tmpMatches.map((m) => m[2]))];

  if (finalKeys.length === 0) {
    return { content, finalKeys: [] };
  }

  const updatedContent = content.replace(TMP_MEDIA_REGEX, (full, route, key) =>
    finalKeys.includes(key) ? `/${route}/${key}` : full
  );

  return { content: updatedContent, finalKeys };
}

async function promotePlannedTempMedia(bucket, finalKeys) {
  if (finalKeys.length === 0) return;
  if (!bucket) throw new Error('Storage not configured');

  for (const key of finalKeys) {
    // Atomic same-volume rename instead of a stream copy: O(1) even for large
    // videos, and leaves no tmp file behind to clean up. A missing tmp file is
    // fine when the final key already exists (e.g. re-saving the same content).
    const moved = await bucket.move(`tmp/${key}`, key);
    if (!moved && !bucket.has(key)) {
      throw new Error(`Missing temporary media: ${key}`);
    }
  }
}

// The note_media index is consulted by media-cleanup decisions, so it must be
// updated in the same transaction as the content it mirrors.
function noteMediaStatements(id, content) {
  return [
    db.prepare('DELETE FROM note_media WHERE note_id = ?').bind(id),
    ...extractMediaKeys(content).map((key) =>
      db.prepare('INSERT OR IGNORE INTO note_media (note_id, media_key) VALUES (?, ?)').bind(id, key)
    )
  ];
}

async function restorePreviousNoteState(previousNote, id) {
  if (!previousNote) {
    await db.batch([
      db.prepare('DELETE FROM notes WHERE id = ?').bind(id),
      // Explicit for databases created before foreign_keys enforcement.
      db.prepare('DELETE FROM note_media WHERE note_id = ?').bind(id)
    ]);
    return;
  }

  await db.batch([
    db.prepare(UPSERT_NOTE_SQL)
      .bind(
        previousNote.id,
        previousNote.title,
        previousNote.category,
        previousNote.subcategory,
        previousNote.tags,
        previousNote.content,
        previousNote.created_at,
        previousNote.updated_at
      ),
    ...noteMediaStatements(id, previousNote.content)
  ]);
}

function parseAndValidateRequest(body) {
  const { id: clientId, title, category, subcategory, tags, content, date } = body || {};

  if (clientId && !V.isUUID(clientId)) throw new Error('Invalid client ID format');

  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle) throw new Error('Title required');

  const normalizedCategory = normalizeFolderName(category);
  if (!normalizedCategory) throw new Error('Major category required');

  const normalizedSubcategory = normalizeFolderName(subcategory);
  if (!normalizedSubcategory) throw new Error('Minor category required');

  const rawContent = typeof content === 'string' ? content : '';
  if (rawContent.length > MAX_SAVE_CONTENT_LENGTH) {
    const err = new Error('Content too large');
    err.status = 413;
    throw err;
  }

  const normalizedDate = typeof date === 'string' && V.isDateStr(date)
    ? date
    : new Date().toISOString().slice(0, 10);

  return {
    id: clientId || crypto.randomUUID(),
    title: normalizedTitle,
    category: normalizedCategory,
    subcategory: normalizedSubcategory,
    tags: normalizeTagList(tags),
    date: normalizedDate,
    rawContent
  };
}

router.post('/', authMiddleware, async (c) => {
  const { value: body, response } = await parseJsonBody(c);
  if (response) return response;

  try {
    const {
      id,
      title,
      category,
      subcategory,
      tags,
      date,
      rawContent
    } = parseAndValidateRequest(body);

    const sanitizedInput = await sanitizeContent(rawContent);
    const promotionPlan = planTempMediaPromotion(sanitizedInput);
    const sanitizedContent = promotionPlan.content;
    const previousNote = body?.id
      ? await db.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first()
      : null;
    const previousContent = typeof previousNote?.content === 'string' ? previousNote.content : '';

    const now = new Date().toISOString();
    const createdAt = typeof previousNote?.created_at === 'string' && previousNote.created_at
      ? previousNote.created_at
      : now;
    const updatedAt = `${date}T00:00:00.000Z`;

    await ensureFolderRecords(db, category, subcategory, createdAt, updatedAt);

    await db.batch([
      db.prepare(UPSERT_NOTE_SQL)
        .bind(id, title, category, subcategory, serializeTags(tags), sanitizedContent, createdAt, updatedAt),
      ...noteMediaStatements(id, sanitizedContent)
    ]);

    try {
      await promotePlannedTempMedia(bucket, promotionPlan.finalKeys);
    } catch (e) {
      await restorePreviousNoteState(previousNote, id);
      await cleanupMediaKeys(bucket, promotionPlan.finalKeys, db);
      return jsonError(c, e.message.includes('Missing temporary media')
        ? 'Some temporary images are missing. Please re-upload and try again.'
        : e.message, e.message.includes('Missing temporary media') ? 409 : 500);
    }

    if (previousContent) {
      runBackground(
        cleanupImages(bucket, previousContent, sanitizedContent, db).catch((e) => {
          console.error('Image cleanup failed after save:', e);
        })
      );
    }

    return c.json({
      success: true,
      id,
      title,
      category,
      subcategory,
      tags,
      content: sanitizedContent,
      createdAt,
      updatedAt
    });
  } catch (e) {
    return jsonError(c, e.message, e.status || 400);
  }
});

export default router;
