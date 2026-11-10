import { toLocalNote } from '../shared/note-shape.js';

const DB_NAME = 'enote';
const DB_VERSION = 1;

const STORE_NOTES = 'notes';
const STORE_MEDIA = 'media';
const STORE_META = 'meta';

const PENDING_DELETIONS_KEY = 'pending_deletions';
// 被服务端拒绝、已隔离的笔记 id，用于状态栏提示（正文仍完整保留在本地）。
const REJECTED_IDS_KEY = 'rejected_note_ids';

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

// notes store 的写入版本号。app.js 的列表缓存靠它判断是否需要重新读库：
// 平时切换目录、翻页、开关笔记都不必全量读 IndexedDB，
// 同时也不依赖调用方记得清缓存——漏清一处也不会显示陈旧数据。
let notesWriteSeq = 0;

export function notesRevision() {
    return notesWriteSeq;
}

function bumpNotesRevision() {
    notesWriteSeq += 1;
}

export async function readMeta(key, fallback = null) {
    const row = await withRead(STORE_META, (store) => store.get(key));
    return row ? row.value : fallback;
}export async function writeMeta(key, value) {
    return withStore(STORE_META, 'readwrite', (store) => store.put({ key, value }));
}

export async function getCursor() {
    return Number(await readMeta('lastSeq', 0)) || 0;
}

export async function setCursor(seq) {
    return writeMeta('lastSeq', Number(seq) || 0);
}

export async function putNote(note, options) {
    const record = note._dirty !== undefined ? note : toLocalNote(note, options);
    // 重新编辑即解除「被服务端拒绝」的隔离状态，允许再推一次。
    delete record._rejected;

    const db = await openDB();
    await new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NOTES, STORE_META], 'readwrite');
        tx.objectStore(STORE_NOTES).put(record);

        const meta = tx.objectStore(STORE_META);
        const req = meta.get(REJECTED_IDS_KEY);
        req.onsuccess = () => {
            const ids = Array.isArray(req.result?.value) ? req.result.value : [];
            if (!ids.includes(record.id)) return;
            meta.put({ key: REJECTED_IDS_KEY, value: ids.filter((id) => id !== record.id) });
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });

    bumpNotesRevision();
}

export async function getNote(id) {
    const row = await withRead(STORE_NOTES, (store) => store.get(id));
    return row && !row._deleted ? row : null;
}

// 单条删除：读一次拿 baseSeq，再走批量路径（两条记录以内，仍是一次事务的量级）。
export async function deleteNoteLocal(id) {
    const record = await getNote(id);
    return deleteNotesLocal([{ id, baseSeq: record?._baseSeq }]);
}

async function pendingDeletions() {
    const list = await readMeta(PENDING_DELETIONS_KEY, []);
    return Array.isArray(list) ? list.filter((item) => item && item.id) : [];
}

export async function clearDeletions(ids) {
    const drop = new Set(ids || []);
    if (!drop.size) return;

    // 读和写必须在同一个事务里：否则中间如果有新的删除入队，会被这里的
    // 旧快照覆盖掉，那条删除就永远推不上去了。
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_META, 'readwrite');
        const store = tx.objectStore(STORE_META);

        const req = store.get(PENDING_DELETIONS_KEY);
        req.onsuccess = () => {
            const list = Array.isArray(req.result?.value) ? req.result.value : [];
            const next = list.filter((item) => item && !drop.has(item.id));
            if (next.length !== list.length) {
                store.put({ key: PENDING_DELETIONS_KEY, value: next });
            }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export async function allNotes() {
    return (await withRead(STORE_NOTES, (store) => store.getAll())) || [];
}

export async function restoreFromServer(note, seq) {
    const result = await withStore(STORE_NOTES, 'readwrite', (store) =>
        store.put(toLocalNote(note, { dirty: 0, baseSeq: seq, deleted: 0 }))
    );
    bumpNotesRevision();
    return result;
}

export async function pendingChanges(limit = 0) {
    const rows = (await withRead(STORE_NOTES, (store) => limit > 0
        ? store.index('_dirty').getAll(1, limit)
        : store.index('_dirty').getAll(1))) || [];

    // 未删除的改动走 notes，删除走独立队列（主表里已经没有墓碑了）。
    // _rejected 是被服务端逐条拒绝的毒丸（超长正文、字段非法等），
    // 继续重推只会每轮空转，等用户编辑后 putNote 会解除标记。
    const notes = rows.filter((r) => !r._deleted && !r._rejected);
    let deletions = await pendingDeletions();

    if (limit > 0) {
        const room = Math.max(0, limit - notes.length);
        deletions = deletions.slice(0, room);
    }

    return { notes, deletions };
}

export async function markNotesSynced(notes, seqById) {
    if (!notes?.length) return;

    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NOTES, 'readwrite');
        const store = tx.objectStore(STORE_NOTES);

        for (const note of notes) {
            const seq = seqById instanceof Map ? seqById.get(note.id) : seqById?.[note.id];
            const nextBaseSeq = Number(seq) || note._baseSeq || 0;

            const req = store.get(note.id);
            req.onsuccess = () => {
                const current = req.result;
                if (!current) return;

                // 推送期间用户又改了这条笔记：库里的版本已经比发出去的快照新，
                // 此时绝不能写成 _dirty:0，否则这次修改永远不会上传；
                // 也不能用旧快照覆盖正文。只推进 baseSeq，留 dirty 给下一轮。
                const untouched = current.updatedAt === note.updatedAt
                    && current.title === note.title
                    && current.content === note.content;

                store.put(untouched
                    ? { ...current, _dirty: 0, _baseSeq: nextBaseSeq }
                    : { ...current, _baseSeq: nextBaseSeq });
            };
        }

        tx.oncomplete = () => { bumpNotesRevision(); resolve(); };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export async function markDeletedSynced(ids) {
    if (!ids?.length) return;

    await withStore(STORE_NOTES, 'readwrite', (store) => {
        for (const id of ids) store.delete(id);
    });
    bumpNotesRevision();
    await clearDeletions(ids);
}

export async function resetForFullResync() {
    const result = await withStore(STORE_NOTES, 'readwrite', (store) => {
        const req = store.openCursor();

        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            // _rejected 的笔记服务端根本没有，正文只存在本地：清掉就永久丢了。
            if (!cursor.value._dirty && !cursor.value._rejected) cursor.delete();
            cursor.continue();
        };
    });
    bumpNotesRevision();
    return result;
}

export async function applyRemoteBatch(notes, deletedIds = []) {
    const db = await openDB();
    // 本地已删、但还没推给服务端的条目：服务端此时仍会把它发下来，
    // 必须跳过，否则删掉的笔记会「复活」。
    const queuedForDelete = new Set((await pendingDeletions()).map((item) => item.id));

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NOTES, 'readwrite');
        const store = tx.objectStore(STORE_NOTES);

        for (const id of deletedIds) {
            const req = store.get(id);
            req.onsuccess = () => {
                const local = req.result;
                if (local && (local._dirty || local._rejected)) return;
                store.delete(id);
            };
        }

        for (const note of notes) {
            if (queuedForDelete.has(note.id)) continue;

            const req = store.get(note.id);
            req.onsuccess = () => {
                const local = req.result;
                if (local && (local._dirty || local._rejected)) return;
                store.put(toLocalNote(note, { dirty: 0, baseSeq: Number(note.seq) || 0, deleted: 0 }));
            };
        }

        tx.oncomplete = () => { bumpNotesRevision(); resolve(true); };
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

// 批量本地删除：物理删主表 + 逐条入删除队列，一个事务完成。
// 用于删除分类/子分类这种一次带走多条笔记的场景。
export async function deleteNotesLocal(items) {
    const targets = (items || []).filter((item) => item && item.id);
    if (!targets.length) return 0;

    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NOTES, STORE_META], 'readwrite');
        const notes = tx.objectStore(STORE_NOTES);
        const meta = tx.objectStore(STORE_META);

        for (const item of targets) notes.delete(item.id);

        const queueReq = meta.get(PENDING_DELETIONS_KEY);
        queueReq.onsuccess = () => {
            const list = Array.isArray(queueReq.result?.value) ? queueReq.result.value : [];
            const known = new Set(list.map((entry) => entry && entry.id));

            for (const item of targets) {
                if (known.has(item.id)) continue;
                list.push({ id: item.id, baseSeq: Number(item.baseSeq) || 0 });
                known.add(item.id);
            }

            meta.put({ key: PENDING_DELETIONS_KEY, value: list });
        };

        // 删掉的笔记若还在「被拒」清单里，要一并移除，否则状态栏会一直挂着
        // 「N 条未同步」，而那条笔记早就不存在了。
        const rejectedReq = meta.get(REJECTED_IDS_KEY);
        rejectedReq.onsuccess = () => {
            const ids = Array.isArray(rejectedReq.result?.value) ? rejectedReq.result.value : [];
            if (!ids.length) return;
            const drop = new Set(targets.map((item) => item.id));
            const next = ids.filter((id) => !drop.has(id));
            if (next.length !== ids.length) meta.put({ key: REJECTED_IDS_KEY, value: next });
        };

        tx.oncomplete = () => { bumpNotesRevision(); resolve(targets.length); };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

// 服务端逐条拒绝的笔记：清 dirty（不再重推）并打上标记，
// 正文完整保留在本地，用户下次编辑会解除标记并重新尝试上传。
export async function markNotesRejected(items) {
    const list = (items || []).filter((item) => item && item.id);
    if (!list.length) return 0;

    const byId = new Map(list.map((item) => [item.id, item]));
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NOTES, STORE_META], 'readwrite');
        const store = tx.objectStore(STORE_NOTES);
        const meta = tx.objectStore(STORE_META);
        let touched = 0;

        for (const [id, item] of byId) {
            const req = store.get(id);
            req.onsuccess = () => {
                const current = req.result;
                if (!current) return;

                // 推送期间用户又改了：不清 dirty、也不标拒绝，留给下一轮重推新内容。
                // 否则这次编辑会和 markNotesSynced 的旧逻辑一样被静默丢掉。
                const untouched = !item.updatedAt
                    || (current.updatedAt === item.updatedAt
                        && current.title === item.title
                        && current.content === item.content);
                if (!untouched) return;

                touched += 1;
                store.put({ ...current, _dirty: 0, _rejected: String(item.reason || 'Rejected') });

                const listReq = meta.get(REJECTED_IDS_KEY);
                listReq.onsuccess = () => {
                    const ids = Array.isArray(listReq.result?.value) ? listReq.result.value : [];
                    if (ids.includes(id)) return;
                    meta.put({ key: REJECTED_IDS_KEY, value: [...ids, id] });
                };
            };
        }

        tx.oncomplete = () => { bumpNotesRevision(); resolve(touched); };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export async function rejectedIds() {
    const list = await readMeta(REJECTED_IDS_KEY, []);
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id) : [];
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

export async function pendingCount() {
    const dirty = Number(await withRead(STORE_NOTES, (store) => store.index('_dirty').count(1))) || 0;
    const queued = (await pendingDeletions()).length;
    return dirty + queued;
}

// 旧版本把删除记成墓碑（_deleted=1 留在主表里）。升级后把这些记录
// 迁移到删除队列并物理清掉，避免它们既占空间又被当成「未删」。
export async function migrateTombstones() {
    if (await readMeta('tombstones_migrated', 0) === 1) return 0;

    const db = await openDB();

    // 读队列、合并墓碑、删主表、写标记必须在同一个事务里：
    // 分开写的话，中途崩溃会留下「队列已写、墓碑还在」的半成品状态。
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NOTES, STORE_META], 'readwrite');
        const notes = tx.objectStore(STORE_NOTES);
        const meta = tx.objectStore(STORE_META);
        let migrated = 0;

        const flagReq = meta.get('tombstones_migrated');
        flagReq.onsuccess = () => {
            if (flagReq.result?.value === 1) return;

            const queueReq = meta.get(PENDING_DELETIONS_KEY);
            queueReq.onsuccess = () => {
                const queue = Array.isArray(queueReq.result?.value) ? queueReq.result.value : [];
                const known = new Set(queue.map((item) => item && item.id));

                const cursorReq = notes.openCursor();
                cursorReq.onsuccess = () => {
                    const cursor = cursorReq.result;
                    if (cursor) {
                        const row = cursor.value;
                        if (row && row._deleted) {
                            if (!known.has(row.id)) {
                                queue.push({ id: row.id, baseSeq: Number(row._baseSeq) || 0 });
                                known.add(row.id);
                            }
                            cursor.delete();
                            migrated += 1;
                        }
                        cursor.continue();
                        return;
                    }

                    // 遍历结束：队列与标记和上面的删除同属一个事务
                    meta.put({ key: PENDING_DELETIONS_KEY, value: queue });
                    meta.put({ key: 'tombstones_migrated', value: 1 });
                };
            };
        };

        tx.oncomplete = () => {
            if (migrated) bumpNotesRevision();
            resolve(migrated);
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}
