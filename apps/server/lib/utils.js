export { escapeHtml } from '../../client/shared/render.js';

import { normalizeInlineText, normalizeTagList, parseStoredTags, serializeTags } from '../../client/shared/tags.js';

export { normalizeTagList, parseStoredTags, serializeTags };

const ENTITY_MAP = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#x60;': '`'
};

export function respondError(c, msg, status) {
    if (c.req.header('HX-Request')) return c.html(`<div class="auth-err">${msg}</div>`, status);
    return c.json({ error: msg }, status);
}

export function normalizeTitle(value, maxLen = 120) {
    return normalizeInlineText(value, maxLen);
}

export function normalizeFolderName(value, maxLen = 60) {
    return normalizeInlineText(value, maxLen);
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

async function filterUnusedMediaKeys(db, keys) {
    if (!db || !Array.isArray(keys) || keys.length === 0) return keys;

    const placeholders = keys.map(() => '?').join(', ');

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
