import { Hono } from 'hono';
import { cookieOnlyAuth } from '../lib/auth.js';
import { textError } from '../lib/http.js';
import { bucket } from '../lib/core.js';

const SAFE_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime'
]);

function isSafeMediaKey(key) {
  return key
    && !key.includes('..')
    && !key.includes('\\')
    && !key.includes('\0')
    && !key.startsWith('/')
    && !key.startsWith('backups/');
}

export function createImagesRouter(routeBase) {
  const router = new Hono();

  router.get('/:key{.*}', cookieOnlyAuth, async (c) => {
    const key = c.req.param('key');
    if (!isSafeMediaKey(key)) return textError(c, 'Bad Request', 400);

    const obj = await bucket.get(key);
    if (!obj) return textError(c, 'Not Found', 404);

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    const cType = String(headers.get('Content-Type') || '').toLowerCase();
    if (!SAFE_MEDIA_TYPES.has(cType)) {
      return textError(c, 'Not Found', 404);
    }

    if (routeBase === 'img' && !cType.startsWith('image/')) return textError(c, 'Not Found', 404);
    if (routeBase === 'video' && !cType.startsWith('video/')) return textError(c, 'Not Found', 404);

    headers.set('Cache-Control', 'private, max-age=31536000, immutable');
    headers.set('Vary', 'Cookie');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(obj.body, { headers });
  });

  return router;
}
