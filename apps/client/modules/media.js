import { getApiBase } from './api.js';
import * as LocalDB from './localdb.js';

const MEDIA_SRC_RE = /<(?:img|video|source)[^>]+src=["'](\/(?:img|video)\/[^"']+)["']/gi;
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const CONCURRENCY = 2;

export function extractMediaPaths(content) {
    const paths = new Set();
    if (!content) return [];

    MEDIA_SRC_RE.lastIndex = 0;
    let match;
    while ((match = MEDIA_SRC_RE.exec(content))) {
        paths.add(match[1]);
    }
    return [...paths];
}

export async function cacheNoteMedia(notes, { onProgress } = {}) {
    const wanted = new Set();
    for (const note of notes || []) {
        for (const path of extractMediaPaths(note.content)) wanted.add(path);
    }
    if (!wanted.size) return { total: 0, downloaded: 0, failed: 0 };

    const cached = new Set(await LocalDB.listMediaKeys());
    const missing = [...wanted].filter((path) => !cached.has(path));
    if (!missing.length) return { total: wanted.size, downloaded: 0, failed: 0 };

    const queue = [...missing];
    let done = 0;
    let failed = 0;
    let usedBytes = await LocalDB.mediaTotalBytes().catch(() => 0);

    const worker = async () => {
        while (queue.length) {
            const path = queue.shift();
            try {
                if (usedBytes >= MAX_CACHE_BYTES) {
                    queue.length = 0;
                    break;
                }
                const res = await fetch(`${getApiBase()}${path}`, { credentials: 'include' });
                if (!res.ok) {
                    failed += 1;
                    continue;
                }
                const blob = await res.blob();
                if (blob.size > MAX_MEDIA_BYTES) {
                    failed += 1;
                    continue;
                }
                await LocalDB.putMediaBlob(path, blob);
                usedBytes += blob.size;
                done += 1;
                onProgress?.({ done, total: missing.length });
            } catch {
                failed += 1;
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

    return { total: wanted.size, downloaded: done, failed };
}

export async function hydrateMedia(root) {
    if (!root) return 0;

    const nodes = [...root.querySelectorAll('img[src], video[src], source[src]')];
    const replaced = await Promise.all(nodes.map(async (node) => {
        const src = node.getAttribute('src') || '';
        if (!/^\/(?:img|video)\//.test(src)) return 0;

        const record = await LocalDB.getMediaBlob(src).catch(() => null);
        if (!record?.blob) return 0;

        const objectUrl = URL.createObjectURL(record.blob);
        const release = () => URL.revokeObjectURL(objectUrl);
        node.setAttribute('src', objectUrl);
        node.addEventListener('load', release, { once: true });
        node.addEventListener('error', release, { once: true });
        return 1;
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
