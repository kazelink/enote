import { Hono } from 'hono';
import { Readable, Transform } from 'stream';
import { authMiddleware } from '../lib/auth.js';
import { jsonError, getContentLength } from '../lib/http.js';
import { bucket, MIME_EXT } from '../lib/core.js';

const router = new Hono();
const MAX_UPLOAD = 100 * 1024 * 1024;

const ALLOWED_MIME = new Set(Object.keys(MIME_EXT));

function normalizeMime(v) {
  const base = String(v || '').split(';')[0].trim().toLowerCase();
  return base === 'image/jpg' ? 'image/jpeg' : base;
}

function hasAscii(bytes, offset, text) {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function detectMediaMime(bytes) {
  if (bytes.length < 4) return '';

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (hasAscii(bytes, 0, 'GIF87a') || hasAscii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP')) return 'image/webp';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';

  if (bytes.length >= 12 && hasAscii(bytes, 4, 'ftyp')) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
    if (brand.startsWith('qt') || ['moov', 'm4v ', 'fqt '].includes(brand)) {
      return 'video/quicktime';
    }
    return 'video/mp4';
  }

  if (bytes.length >= 8 && (hasAscii(bytes, 4, 'moov') || hasAscii(bytes, 4, 'mdat'))) {
    return 'video/quicktime';
  }

  return '';
}

function validateUploadRequest(contentLength) {
  if (!bucket) throw new Error('Storage not configured');
  if (contentLength != null && contentLength > MAX_UPLOAD) {
    throw Object.assign(new Error('File too large (max 100MB)'), { status: 413 });
  }
}

function createUploadValidationStream(declaredType) {
  const headerChunks = [];
  let headerLength = 0;
  let totalBytes = 0;

  return new Transform({
    transform(chunk, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_UPLOAD) {
        callback(Object.assign(new Error('File too large (max 100MB)'), { status: 413 }));
        return;
      }

      if (headerLength < 32) {
        const remaining = 32 - headerLength;
        const slice = chunk.subarray(0, remaining);
        headerChunks.push(Buffer.from(slice));
        headerLength += slice.length;
      }

      callback(null, chunk);
    },
    flush(callback) {
      if (totalBytes === 0) {
        callback(new Error('File required'));
        return;
      }

      const headerBytes = new Uint8Array(Buffer.concat(headerChunks));
      const detectedType = detectMediaMime(headerBytes);
      if (!detectedType || !ALLOWED_MIME.has(detectedType)) {
        callback(new Error('Invalid file'));
        return;
      }
      if (detectedType !== declaredType) {
        callback(new Error('MIME type mismatch'));
        return;
      }

      callback();
    }
  });
}

async function validateMultipartFile(file) {
  if (!(file instanceof File)) throw new Error('File required');

  const declaredType = normalizeMime(file.type);
  if (!ALLOWED_MIME.has(declaredType)) throw new Error('Unsupported file type');
  if (file.size > MAX_UPLOAD) throw Object.assign(new Error('File too large (max 100MB)'), { status: 413 });

  const headerBytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const detectedType = detectMediaMime(headerBytes);
  
  if (!detectedType || !ALLOWED_MIME.has(detectedType)) throw new Error('Invalid file');
  if (detectedType !== declaredType) throw new Error('MIME type mismatch');

  return detectedType;
}

function mediaResponse(c, filename, mime) {
  const routeBase = mime.startsWith('video/') ? 'video' : 'img';
  return c.json({ url: `/${routeBase}/${filename}` });
}

async function handleRawUpload(c, declaredType) {
  if (!ALLOWED_MIME.has(declaredType)) {
    throw new Error('Unsupported file type');
  }
  if (!c.req.raw.body) {
    throw new Error('File required');
  }

  const ext = MIME_EXT[declaredType];
  const filename = `tmp/${crypto.randomUUID()}.${ext}`;
  const validatedStream = Readable.fromWeb(c.req.raw.body).pipe(createUploadValidationStream(declaredType));

  await bucket.put(filename, validatedStream);

  return mediaResponse(c, filename, declaredType);
}

router.post('/', authMiddleware, async (c) => {
  try {
    const contentLength = getContentLength(c);
    const requestType = normalizeMime(c.req.header('Content-Type'));
    validateUploadRequest(contentLength);

    if (ALLOWED_MIME.has(requestType)) {
      return await handleRawUpload(c, requestType);
    }

    if (!requestType.includes('multipart/form-data')) {
      throw new Error('Unsupported file type');
    }

    let formData;
    try {
      formData = await c.req.raw.formData();
    } catch {
      return jsonError(c, 'Invalid upload payload', 400);
    }

    const file = formData.get('file');
    const detectedType = await validateMultipartFile(file);

    const ext = MIME_EXT[detectedType];
    const filename = `tmp/${crypto.randomUUID()}.${ext}`;
    await bucket.put(filename, file);

    return mediaResponse(c, filename, detectedType);

  } catch (err) {
    return jsonError(c, err.message, err.status || 400);
  }
});

export default router;
