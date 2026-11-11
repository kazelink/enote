import { authHeaders, Nonce, Token, getApiBase } from './api.js';
import * as LocalDB from './localdb.js';

const MEDIA_SRC_RE = /<(?:img|video|source)[^>]+src=["'](\/(?:img|video)\/[^"']+)["']/gi;
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const BLOB_URL_TTL_MS = 120_000;

export function absolutizeMediaHtml(html) {
    const base = getApiBase();
    if (!base) return String(html || '');

    const token = Token.get() || '';
    const nonce = Nonce.get() || '';
    const qs = token ? `?t=${encodeURIComponent(token)}&n=${encodeURIComponent(nonce)}` : '';

    return String(html || '').replace(
        /(src|href)=(["'])\/(img|video)\/([^"']+)\2/gi,
        (_m, attr, quote, kind, key) => `${attr}=${quote}${base}/${kind}/${key}${qs}${quote}`
    );
}

export function relativizeMediaHtml(html) {
    let out = String(html || '');
    const base = getApiBase();
    if (!base) return out;

    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return out.replace(
        new RegExp(`${escaped}/(img|video)/([^"'?#\\s]+)(\\?[^"'\\s]*)?`, 'gi'),
        '/$1/$2'
    );
}

function extractMediaPaths(content) {
    const paths = new Set();
    if (!content) return [];

    MEDIA_SRC_RE.lastIndex = 0;
    let match;
    while ((match = MEDIA_SRC_RE.exec(content))) {
        paths.add(match[1]);
    }
    return [...paths];
}

let cachedBytes = null;

async function hasByteBudget() {
    if (cachedBytes === null) {
        cachedBytes = await LocalDB.mediaTotalBytes().catch(() => 0);
    }
    return cachedBytes < MAX_CACHE_BYTES;
}

const inflight = new Map();

async function cacheMediaOne(path) {
    if (inflight.has(path)) return inflight.get(path);

    const task = (async () => {
        try {
            if (!(await hasByteBudget())) return null;

            const res = await fetch(`${getApiBase()}${path}`, {
                credentials: 'include',
                headers: authHeaders()
            });
            if (!res.ok) return null;

            const blob = await res.blob();
            if (!blob.size || blob.size > MAX_MEDIA_BYTES) return null;

            await LocalDB.putMediaBlob(path, blob);
            cachedBytes = (cachedBytes || 0) + blob.size;
            return blob;
        } catch {
            return null;
        } finally {
            inflight.delete(path);
        }
    })();

    inflight.set(path, task);
    return task;
}

export async function hydrateMedia(root) {
    if (!root) return 0;

    const base = getApiBase();
    const nodes = [...root.querySelectorAll('img[src], video[src], source[src]')];

    const replaced = await Promise.all(nodes.map(async (node) => {
        const src = node.getAttribute('src') || '';
        if (!/^\/(?:img|video)\//.test(src)) return 0;

        const applyBlob = (blob) => {
            if (!blob || !node.isConnected) return;
            const objectUrl = URL.createObjectURL(blob);
            node.setAttribute('src', objectUrl);
            setTimeout(() => URL.revokeObjectURL(objectUrl), BLOB_URL_TTL_MS);
        };

        const record = await LocalDB.getMediaBlob(src).catch(() => null);
        if (record?.blob) {
            applyBlob(record.blob);
            return 1;
        }

        if (base) node.setAttribute('src', `${base}${src}`);
        cacheMediaOne(src).then(applyBlob);

        return 0;
    }));

    return replaced.reduce((sum, n) => sum + n, 0);
}

export async function pruneOrphanMedia() {
    const notes = await LocalDB.allNotes();
    const referenced = new Set();

    for (const note of notes) {
        if (note._deleted) continue;
        for (const path of extractMediaPaths(note.content)) referenced.add(path);
    }

    const cached = await LocalDB.listMediaKeys();
    let removed = 0;

    for (const key of cached) {
        if (referenced.has(key)) continue;
        try {
            await LocalDB.deleteMediaBlob(key);
            removed += 1;
        } catch {
            continue;
        }
    }

    return { scanned: cached.length, removed };
}
