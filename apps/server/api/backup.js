import { Hono } from 'hono';
import { authMiddleware } from '../lib/auth.js';
import { escapeHtml } from '../lib/utils.js';
import { getContentLength, getQueryString, jsonError, parseJsonBody } from '../lib/http.js';
import {
  MAX_RESTORE_FILE,
  MAX_RESTORE_REQUEST,
  createBackupExport,
  restoreBackupPayload,
  restoreBackupStream
} from '../lib/backup-service.js';

const router = new Hono();
const STREAM_RESTORE_HEADER = 'x-backup-upload';
const STREAM_RESTORE_MODE = 'file';

function getDeclaredBackupSize(c, fallback) {
  const headerBytes = Number(c.req.header('X-Backup-Size'));
  return Number.isFinite(headerBytes) && headerBytes > 0 ? headerBytes : fallback;
}

function restoreErrorResponse(c, error) {
  const message = error?.message || 'Restore failed';
  const status = error?.status || (message.includes('too large') ? 413 : /^Invalid|^No data/i.test(message) ? 400 : 500);
  return jsonError(c, message, status);
}

router.get('/export', authMiddleware, async (c) => {
  try {
    const category = getQueryString(c, 'category').trim();
    const subcategory = getQueryString(c, 'subcategory').trim();
    const { stream, filename, utfFilename } = await createBackupExport(category, subcategory);

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(utfFilename)}`
      }
    });
  } catch (e) {
    return jsonError(c, `Export Failed: ${escapeHtml(e.message)}`, 500);
  }
});

router.post('/restore', authMiddleware, async (c) => {
  if (String(c.req.header(STREAM_RESTORE_HEADER) || '').toLowerCase() === STREAM_RESTORE_MODE) {
    try {
      const declaredBytes = getDeclaredBackupSize(c, getContentLength(c));
      const result = await restoreBackupStream(c.req.raw.body, declaredBytes);
      return c.json(result);
    } catch (error) {
      return restoreErrorResponse(c, error);
    }
  }

  const contentLength = getContentLength(c);
  if (contentLength != null && contentLength > MAX_RESTORE_REQUEST) {
    return jsonError(c, 'Restore payload too large. Please retry from the app.', 413);
  }

  try {
    const { value: parsed, response } = await parseJsonBody(c, 'Invalid JSON');
    if (response) return response;

    const totalBytes = Number(parsed?.totalBytes);
    if (Number.isFinite(totalBytes) && totalBytes > MAX_RESTORE_FILE) {
      return jsonError(c, 'Backup file too large (max 100MB)', 413);
    }

    return c.json(await restoreBackupPayload(parsed));
  } catch (error) {
    return restoreErrorResponse(c, error);
  }
});

export default router;
