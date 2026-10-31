const DB_NAME = 'enote';
const DB_VERSION = 1;

const STORE_NOTES = 'notes';
const STORE_FOLDERS = 'folders';
const STORE_MEDIA = 'media';
const STORE_META = 'meta';

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = () => {
            const db = req.result;

            if (!db.objectStoreNames.contains(STORE_NOTES)) {
                const notes = db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
                notes.createIndex('category', 'category', { unique: false });
                notes.createIndex('subcategory', 'subcategory', { unique: false });
                notes.createIndex('updatedAt', 'updatedAt', { unique: false });
                notes.createIndex('_dirty', '_dirty', { unique: false });
            }

            if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
                db.createObjectStore(STORE_FOLDERS, { keyPath: 'key' });
            }

            if (!db.objectStoreNames.contains(STORE_MEDIA)) {
                db.createObjectStore(STORE_MEDIA, { keyPath: 'key' });
            }

            if (!db.objectStoreNames.contains(STORE_META)) {
                db.createObjectStore(STORE_META, { keyPath: 'key' });
            }
        };

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('Local database is blocked by another tab'));
    });

    return dbPromise;
}

async function withStore(storeName, mode, fn) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let out;

        try {
            out = fn(store);
        } catch (e) {
            reject(e);
            return;
        }

        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
}

async function withRead(storeName, start) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = start(tx.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function readMeta(key, fallback = null) {
    const row = await withRead(STORE_META, (store) => store.get(key));
    return row ? row.value : fallback;
}

export async function writeMeta(key, value) {
    return withStore(STORE_META, 'readwrite', (store) => store.put({ key, value }));
}

export async function getCursor() {
    return Number(await readMeta('lastSeq', 0)) || 0;
}

export async function setCursor(seq) {
    return writeMeta('lastSeq', Number(seq) || 0);
}

export function toLocalNote(note, { dirty = 1, baseSeq = 0, deleted = 0 } = {}) {
    return {
        id: note.id,
        title: note.title || '',
        category: note.category || '',
        subcategory: note.subcategory || '',
        tags: Array.isArray(note.tags) ? note.tags : [],
        content: typeof note.content === 'string' ? note.content : '',
        createdAt: note.createdAt || new Date().toISOString(),
        updatedAt: note.updatedAt || new Date().toISOString(),
        _dirty: dirty ? 1 : 0,
        _baseSeq: Number(baseSeq) || 0,
        _deleted: deleted ? 1 : 0
    };
}

export function toRemoteNote(note) {
    return {
        id: note.id,
        title: note.title,
        category: note.category,
        subcategory: note.subcategory,
        tags: note.tags,
        content: note.content,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        baseSeq: note._baseSeq || 0
    };
}

export async function putNote(note, options) {
    const record = note._dirty !== undefined ? note : toLocalNote(note, options);
    return withStore(STORE_NOTES, 'readwrite', (store) => store.put(record));
}

export async function getNote(id) {
    const row = await withRead(STORE_NOTES, (store) => store.get(id));
    return row && !row._deleted ? row : null;
}

export async function tombstoneNote(id) {
    const existing = await getNote(id);
    if (!existing) return;

    return withStore(STORE_NOTES, 'readwrite', (store) =>
        store.put({ ...existing, _deleted: 1, _dirty: 1 })
    );
}

export async function allNotes() {
    return (await withRead(STORE_NOTES, (store) => store.getAll())) || [];
}

export async function restoreFromServer(note, seq) {
    return withStore(STORE_NOTES, 'readwrite', (store) =>
        store.put(toLocalNote(note, { dirty: 0, baseSeq: seq, deleted: 0 }))
    );
}

export async function pendingChanges() {
    const rows = (await withRead(STORE_NOTES, (store) => store.index('_dirty').getAll(1))) || [];
    return {
        notes: rows.filter((r) => !r._deleted),
        deletions: rows.filter((r) => r._deleted)
    };
}

export async function markSynced(notes, seqById, deletedIds = []) {
    return withStore(STORE_NOTES, 'readwrite', (store) => {
        for (const note of notes) {
            const seq = seqById instanceof Map ? seqById.get(note.id) : seqById?.[note.id];
            store.put({ ...note, _dirty: 0, _baseSeq: Number(seq) || note._baseSeq || 0 });
        }

        for (const id of deletedIds) {
            store.delete(id);
        }
    });
}

export async function resetForFullResync() {
    return withStore(STORE_NOTES, 'readwrite', (store) => {
        const req = store.openCursor();

        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            if (!cursor.value._dirty) cursor.delete();
            cursor.continue();
        };
    });
}

export async function applyRemoteBatch(notes, deletedIds = []) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NOTES, 'readwrite');
        const store = tx.objectStore(STORE_NOTES);

        for (const id of deletedIds) {
            const req = store.get(id);
            req.onsuccess = () => {
                const local = req.result;
                if (local && local._dirty) return;
                store.delete(id);
            };
        }

        for (const note of notes) {
            const req = store.get(note.id);
            req.onsuccess = () => {
                const local = req.result;
                if (local && local._dirty) return;
                store.put(toLocalNote(note, { dirty: 0, baseSeq: Number(note.seq) || 0, deleted: 0 }));
            };
        }

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export function queryNotes(rows, { category = '', subcategory = '', q = '', tag = '' } = {}) {
    let out = rows.filter((n) => !n._deleted);

    if (category) out = out.filter((n) => n.category === category);
    if (subcategory) out = out.filter((n) => n.subcategory === subcategory);

    const needle = String(q || '').trim().toLowerCase();
    if (needle) {
        out = out.filter((n) => {
            if ((n.title || '').toLowerCase().includes(needle)) return true;
            if ((n.content || '').toLowerCase().includes(needle)) return true;
            return (n.tags || []).some((t) => String(t).toLowerCase().includes(needle));
        });
    }

    const safeTag = String(tag || '').trim().toLowerCase();
    if (safeTag) {
        out = out.filter((n) => (n.tags || []).some((t) => String(t).toLowerCase() === safeTag));
    }

    return out;
}

export function sortNotes(rows) {
    return [...rows].sort((a, b) => {
        const byTitle = String(a.title || '').localeCompare(String(b.title || ''), undefined, {
            sensitivity: 'base'
        });
        if (byTitle !== 0) return byTitle;

        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
}

export function paginate(rows, page, size) {
    const limit = Math.min(50, Math.max(1, Number(size) || 10));
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
    const start = (safePage - 1) * limit;

    return {
        notes: rows.slice(start, start + limit),
        total,
        page: safePage,
        totalPages
    };
}

export async function replaceFolders(folders) {
    return withStore(STORE_FOLDERS, 'readwrite', (store) => {
        store.clear();
        for (const f of folders || []) {
            store.put({
                key: `${f.category}\u0000${f.subcategory || ''}`,
                category: f.category,
                subcategory: f.subcategory || ''
            });
        }
    });
}

export async function deriveFoldersFromNotes() {
    const rows = await allNotes();
    const seen = new Map();

    for (const n of rows) {
        if (n._deleted || !n.category) continue;
        const key = `${n.category}\u0000${n.subcategory || ''}`;
        if (!seen.has(key)) {
            seen.set(key, { key, category: n.category, subcategory: n.subcategory || '' });
        }
    }

    return [...seen.values()];
}

export async function putMediaBlob(key, blob) {
    return withStore(STORE_MEDIA, 'readwrite', (store) =>
        store.put({ key, blob, size: blob.size || 0, accessedAt: Date.now() })
    );
}

export async function getMediaBlob(key) {
    return (await withRead(STORE_MEDIA, (store) => store.get(key))) || null;
}

export async function deleteMediaBlob(key) {
    return withStore(STORE_MEDIA, 'readwrite', (store) => store.delete(key));
}

export async function listMediaKeys() {
    return (await withRead(STORE_MEDIA, (store) => store.getAllKeys())) || [];
}

export async function mediaTotalBytes() {
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MEDIA, 'readonly');
        let total = 0;
        const req = tx.objectStore(STORE_MEDIA).openCursor();

        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            total += Number(cursor.value.size) || 0;
            cursor.continue();
        };

        tx.oncomplete = () => resolve(total);
        tx.onerror = () => reject(tx.error);
    });
}

export async function localStats() {
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NOTES, 'readonly');
        let total = 0;
        let dirty = 0;
        let tombstones = 0;
        const req = tx.objectStore(STORE_NOTES).openCursor();

        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            const row = cursor.value;
            if (row._deleted) tombstones += 1;
            else {
                total += 1;
                if (row._dirty) dirty += 1;
            }
            cursor.continue();
        };

        tx.oncomplete = () => resolve({ total, dirty, tombstones });
        tx.onerror = () => reject(tx.error);
    });
}
