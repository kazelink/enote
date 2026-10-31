import { getApiBase } from './api.js';
import * as LocalDB from './localdb.js';

const MEDIA_SRC_RE = /<(?:img|video|source)[^>]+src=["'](\/(?:img|video)\/[^"']+)["']/gi;
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

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

// 媒体改为按需缓存：只在笔记被打开时才下载它引用的图片/视频。
// 首次同步不再批量预取。
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

            const res = await fetch(`${getApiBase()}${path}`, { credentials: 'include' });
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
            const release = () => URL.revokeObjectURL(objectUrl);
            node.setAttribute('src', objectUrl);
            node.addEventListener('load', release, { once: true });
            node.addEventListener('error', release, { once: true });
        };

        const record = await LocalDB.getMediaBlob(src).catch(() => null);
        if (record?.blob) {
            applyBlob(record.blob);
            return 1;
        }

        // 本地没有：桌面 / 移动壳里相对路径解析不到服务器，先指向远程地址；
        // 浏览器下 base 为空，保持原 src 即可。随后后台缓存，完成后换成
        // blob URL，下次离线也能看。
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
