/**
 * Local-first storage for the browser / desktop shell.
 *
 * IndexedDB is used because the exact same code runs in a normal browser, in
 * the Tauri WebView and in a Capacitor WebView — no native module, no second
 * implementation to maintain. That is what keeps the desktop and mobile
 * clients on one code path.
 *
 * Record shape mirrors the server API one-for-one (id/title/category/
 * subcategory/tags/content/createdAt/updatedAt) plus internal sync fields
 * prefixed with an underscore, which are stripped before pushing.
 */

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

/**
 * Run `fn` inside a transaction and resolve when the transaction commits.
 *
 * `fn` MUST be synchronous (kick off requests, return the ones you need). An
 * IndexedDB transaction auto-commits as soon as control returns to the event
 * loop, so awaiting inside it would silently lose writes.
 */
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

function readAll(store) {
    return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

function readOne(store, key) {
    return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

/* ------------------------------------------------------------------ meta */

export async function readMeta(key, fallback = null) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_META, 'readonly');
        const req = tx.objectStore(STORE_META).get(key);
        req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
        req.onerror = () => reject(req.error);
    });
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

/* ----------------------------------------------------------------- notes */

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

/** Strip internal fields before sending a record to the server. */
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
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NOTES, 'readonly');
        const req = tx.objectStore(STORE_NOTES).get(id);
        req.onsuccess = () => {
            const row = req.result || null;
            resolve(row && !row._deleted ? row : null);
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Soft delete. The tombstone must survive until the deletion has been pushed,
 * otherwise a pull would resurrect the note from the server.
 */
export async function tombstoneNote(id) {
    const existing = await getNote(id);
    if (!existing) return;

    return withStore(STORE_NOTES, 'readwrite', (store) =>
        store.put({ ...existing, _deleted: 1, _dirty: 1 })
    );
}

/** Remove a row for good, after the server has acknowledged the delete. */
export async function purgeNote(id) {
    return withStore(STORE_NOTES, 'readwrite', (store) => store.delete(id));
}

export async function allNotes() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NOTES, 'readonly');
        readAll(tx.objectStore(STORE_NOTES)).then(resolve, reject);
    });
}

export async function pendingChanges() {
    const rows = await allNotes();
    return {
        notes: rows.filter((r) => !r._deleted && r._dirty),
        deletions: rows.filter((r) => r._deleted && r._dirty)
    };
}

export async function markSynced(notes, deletions, seq) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NOTES, 'readwrite');
        const store = tx.objectStore(STORE_NOTES);

        // The pushed records are now represented on the server at `seq`, so a
        // later edit builds on that version instead of looking like a conflict.
        for (const note of notes) {
            store.put({ ...note, _dirty: 0, _baseSeq: seq });
        }

        for (const note of deletions) {
            store.delete(note.id);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

/** Apply a server record without marking it dirty (it already exists remotely). */
export async function applyRemoteNote(note, seq) {
    return withStore(STORE_NOTES, 'readwrite', (store) =>
        store.put(toLocalNote(note, { dirty: 0, baseSeq: seq, deleted: 0 }))
    );
}

export async function applyRemoteDelete(id) {
    return withStore(STORE_NOTES, 'readwrite', (store) => store.delete(id));
}

/* --------------------------------------------------------------- queries */

/**
 * Mirrors the server's list query (list.js) against the local store.
 *
 * Search uses substring matching instead of SQLite FTS5. For Chinese text this
 * is actually more predictable than the server's tokenizer, which cannot split
 * Chinese words reliably.
 */
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

/** Same ordering as the SQL: title NOCASE asc, then updated_at desc. */
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

/* --------------------------------------------------------------- folders */

export async function replaceFolders(folders) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_FOLDERS, 'readwrite');
        const store = tx.objectStore(STORE_FOLDERS);
        store.clear();
        for (const f of folders || []) {
            store.put({
                key: `${f.category}\u0000${f.subcategory || ''}`,
                category: f.category,
                subcategory: f.subcategory || ''
            });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** Folder tree derived from notes, for when the server list is unavailable. */
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

/* ----------------------------------------------------------------- media */

export async function putMediaBlob(key, blob) {
    return withStore(STORE_MEDIA, 'readwrite', (store) =>
        store.put({ key, blob, size: blob.size || 0, accessedAt: Date.now() })
    );
}

export async function getMediaBlob(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MEDIA, 'readonly');
        const req = tx.objectStore(STORE_MEDIA).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

export async function listMediaKeys() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MEDIA, 'readonly');
        const req = tx.objectStore(STORE_MEDIA).getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

/* ----------------------------------------------------------------- stats */

export async function localStats() {
    const rows = await allNotes();
    return {
        total: rows.filter((r) => !r._deleted).length,
        dirty: rows.filter((r) => r._dirty && !r._deleted).length,
        tombstones: rows.filter((r) => r._deleted).length
    };
}
