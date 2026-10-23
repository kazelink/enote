const ESC_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#x60;'
};

const ESC_RE = /[&<>"'`]/g;

const ENTITY_MAP = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#x60;': '`'
};

export const escapeHtml = (str) =>
    str == null ? '' : String(str).replace(ESC_RE, (char) => ESC_MAP[char] || char);

export function respondError(c, msg, status) {
    if (c.req.header('HX-Request')) return c.html(`<div class="auth-err">${msg}</div>`, status);
    return c.json({ error: msg }, status);
}

function normalizeInlineText(value, maxLen) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.slice(0, maxLen);
}

export function normalizeTitle(value, maxLen = 120) {
    return normalizeInlineText(value, maxLen);
}

export function normalizeFolderName(value, maxLen = 60) {
    return normalizeInlineText(value, maxLen);
}

export function normalizeTagList(input, { maxTags = 12, maxLen = 24 } = {}) {
    const source = Array.isArray(input)
        ? input
        : String(input || '').split(/[,\n，]+/);

    const tags = [];
    const seen = new Set();

    for (const raw of source) {
        const normalized = normalizeInlineText(raw, maxLen);
        if (!normalized) continue;

        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;

        seen.add(key);
        tags.push(normalized);
        if (tags.length >= maxTags) break;
    }

    return tags;
}

export function parseStoredTags(raw) {
    if (Array.isArray(raw)) return normalizeTagList(raw);
    if (typeof raw !== 'string' || !raw.trim()) return [];

    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return normalizeTagList(parsed);
    } catch {
        // Fall back to splitting plain text tag strings.
    }

    return normalizeTagList(raw);
}

export function serializeTags(tags) {
    return JSON.stringify(normalizeTagList(tags));
}

export function normalizeTimestamp(value, fallback = '') {
    const ts = Date.parse(String(value || ''));
    if (!Number.isFinite(ts)) return fallback;
    return new Date(ts).toISOString();
}

const ENTITY_RE = /&(?:nbsp|amp|lt|gt|quot|#39|#x60);/g;

function decodeBasicEntities(text) {
    return String(text || '').replace(ENTITY_RE, m => ENTITY_MAP[m] || m);
}

function stripHtmlTags(html) {
    return decodeBasicEntities(
        String(html || '')
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<\/(p|div|h1|h2|h3|blockquote|li)>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
    ).replace(/\s+/g, ' ').trim();
}

function excerptTextFromHtml(html, maxLen = 120) {
    const text = stripHtmlTags(html);
    if (!text) return '';
    return text.length <= maxLen ? text : `${text.slice(0, maxLen).trim()}...`;
}

export function deriveImportedTitle(content) {
    return excerptTextFromHtml(content, 80) || 'Imported Note';
}

const MEDIA_TAG_RE = /<(?:img|video)\b[^>]*>/gi;
const LOCAL_MEDIA_SRC_RE = /\bsrc\s*=\s*(["']?)\/(?:img|video)\/([^"'\s>]+)\1/i;
const PROTECTED_PREFIXES = ['backups/'];

const isProtectedKey = (key) =>
    PROTECTED_PREFIXES.some((prefix) => String(key || '').startsWith(prefix));

// Use note_media table for fast media key lookup
async function filterUnusedMediaKeys(db, keys) {
    if (!db || !Array.isArray(keys) || keys.length === 0) return keys;

    const placeholders = keys.map(() => '?').join(', ');
    
    // Fast: indexed query against note_media table
    const usedResult = await db.prepare(`
        SELECT DISTINCT media_key
        FROM note_media
        WHERE media_key IN (${placeholders})
    `).bind(...keys).all();

    const usedKeys = new Set((usedResult?.results || []).map(r => r.media_key));
    return keys.filter(key => !usedKeys.has(key));
}

export async function cleanupMediaKeys(bucket, keys, db = null) {
    if (!bucket || !Array.isArray(keys) || keys.length === 0) return;

    try {
        const deleteCandidates = [...new Set(
            keys
                .map((key) => String(key || '').trim())
                .filter((key) => key && !isProtectedKey(key))
        )];
        if (!deleteCandidates.length) return;

        const toDelete = await filterUnusedMediaKeys(db, deleteCandidates);
        if (toDelete.length) {
            await Promise.allSettled(toDelete.map((key) => bucket.delete(key)));
        }
    } catch (error) {
        console.error('Media cleanup failed:', error);
    }
}

export const extractMediaKeys = (html) => {
    const text = String(html || '');
    const keys = new Set();
    for (const tag of text.matchAll(MEDIA_TAG_RE)) {
        const match = tag[0].match(LOCAL_MEDIA_SRC_RE);
        if (match && match[2]) {
            const key = match[2].split(/[?#]/)[0];
            if (key) keys.add(key);
        }
    }
    return [...keys];
};

export async function cleanupImages(bucket, oldHtml, newHtml, db = null) {
    if (!bucket || !oldHtml) return;

    try {
        const oldKeys = extractMediaKeys(oldHtml).filter((key) => !isProtectedKey(key));
        if (!oldKeys.length) return;

        const keep = new Set(newHtml ? extractMediaKeys(newHtml) : []);
        const deleteCandidates = oldKeys.filter((key) => !keep.has(key));
        await cleanupMediaKeys(bucket, deleteCandidates, db);
    } catch (error) {
        console.error('Media cleanup failed:', error);
    }
}

export function toBackupEntry(row) {
    return {
        id: row.id,
        title: row.title,
        category: row.category,
        subcategory: row.subcategory,
        tags: parseStoredTags(row.tags),
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

export function toBackupFolder(row) {
    return {
        category: row.category,
        subcategory: row.subcategory,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}
