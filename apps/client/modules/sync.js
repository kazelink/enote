/**
 * Client-side sync engine.
 *
 * Order matters: push first, then pull. Pushing first means the batch we
 * download already includes our own writes applied, so the local store never
 * briefly shows a stale server copy over newer local edits.
 *
 * Triggers: after login, on a timer, when the window regains focus, and when
 * the network comes back. All of them funnel through sync() which drops
 * concurrent calls, so overlapping triggers cannot interleave.
 */
import { API } from './api.js';
import * as LocalDB from './localdb.js';

const PULL_LIMIT = 50;
const PUSH_BATCH = 40;
const AUTO_SYNC_MS = 30_000;
const MAX_PULL_PAGES = 200;

export const SyncStatus = {
    state: 'idle',
    lastSyncAt: 0,
    lastError: null,
    pending: 0,
    conflicts: [],
    _listeners: new Set(),

    on(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    },

    update(patch) {
        Object.assign(this, patch);
        for (const fn of this._listeners) {
            try { fn(this); } catch (e) { console.error('Sync listener failed:', e); }
        }
    }
};

let running = false;
let timer = null;
let started = false;

function isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function refreshPending() {
    try {
        const stats = await LocalDB.localStats();
        SyncStatus.update({ pending: stats.dirty + stats.tombstones });
    } catch {
        // Stats are cosmetic; never let them break a sync.
    }
}

/**
 * Push everything marked dirty. Records are sent oldest-batch-first and marked
 * clean only after the server acknowledges, so a crash mid-push simply retries.
 */
async function pushPending() {
    const { notes, deletions } = await LocalDB.pendingChanges();
    if (!notes.length && !deletions.length) return [];

    const conflicts = [];

    for (let i = 0; i < notes.length; i += PUSH_BATCH) {
        const batch = notes.slice(i, i + PUSH_BATCH);
        const res = await API.req('sync/push', {
            notes: batch.map(LocalDB.toRemoteNote)
        }, 'POST');

        for (const c of res.conflicts || []) conflicts.push(c);
        await LocalDB.markSynced(batch, [], res.latestSeq);
    }

    for (let i = 0; i < deletions.length; i += PUSH_BATCH) {
        const batch = deletions.slice(i, i + PUSH_BATCH);
        const res = await API.req('sync/push', {
            deletions: batch.map((n) => ({ id: n.id, baseSeq: n._baseSeq || 0 }))
        }, 'POST');

        for (const c of res.conflicts || []) conflicts.push(c);
        await LocalDB.markSynced([], batch, res.latestSeq);
    }

    return conflicts;
}

/**
 * Pull every page after the stored cursor. The cursor is persisted after each
 * page so an interrupted sync resumes instead of restarting from zero.
 */
async function pullRemote() {
    let cursor = await LocalDB.getCursor();
    let pages = 0;

    while (pages++ < MAX_PULL_PAGES) {
        const res = await API.req('sync/pull', { since: cursor, limit: PULL_LIMIT });

        if (res.fullReset) {
            cursor = 0;
            await LocalDB.setCursor(0);
            continue;
        }

        for (const note of res.notes || []) {
            await LocalDB.applyRemoteNote(note, note.seq);
        }
        for (const gone of res.deleted || []) {
            await LocalDB.applyRemoteDelete(gone.id);
        }
        if (res.folders) {
            await LocalDB.replaceFolders(res.folders);
        }

        const nextCursor = Number(res.nextSeq) || cursor;
        if (nextCursor > cursor) {
            cursor = nextCursor;
            await LocalDB.setCursor(cursor);
        }

        if (!res.hasMore) break;
    }

    // Marks the store as usable for local rendering from now on.
    await LocalDB.writeMeta('initialized', 1);
    return cursor;
}

export async function syncNow({ force = false } = {}) {
    if (running) return { skipped: true };
    if (!force && isOffline()) {
        SyncStatus.update({ state: 'offline' });
        return { offline: true };
    }

    running = true;
    SyncStatus.update({ state: 'syncing', lastError: null });

    try {
        const conflicts = await pushPending();
        await pullRemote();

        SyncStatus.update({
            state: 'idle',
            lastSyncAt: Date.now(),
            lastError: null,
            conflicts
        });

        await refreshPending();
        return { ok: true, conflicts };
    } catch (error) {
        // A 401 means the session expired; stay quiet and let the UI's own
        // auth handling take over instead of spamming the console.
        const authFailure = error?.code === 'UNAUTHORIZED';
        SyncStatus.update({
            state: authFailure ? 'auth' : (isOffline() ? 'offline' : 'error'),
            lastError: authFailure ? null : (error?.message || String(error))
        });
        if (!authFailure) console.error('Sync failed:', error);
        return { ok: false, error };
    } finally {
        running = false;
    }
}

export function startSyncEngine() {
    if (started) return;
    started = true;

    // Initial sync shortly after boot, so the UI can render local data first.
    setTimeout(() => { syncNow(); }, 300);

    timer = setInterval(() => { syncNow(); }, AUTO_SYNC_MS);

    window.addEventListener('focus', () => { syncNow(); });
    window.addEventListener('online', () => { syncNow(); });
    window.addEventListener('offline', () => SyncStatus.update({ state: 'offline' }));

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') syncNow();
    });
}

export function stopSyncEngine() {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
}

/** Queue a note for upload; call right after writing it to the local store. */
export async function queueNoteSave(note) {
    await LocalDB.putNote(note, { dirty: 1, baseSeq: note._baseSeq || 0 });
    // A locally written note is immediately renderable, so the list can switch
    // to the local path even if the first sync has not finished yet.
    await LocalDB.writeMeta('initialized', 1);
    await refreshPending();
    // Debounced: edits within the same second collapse into one push.
    scheduleSoon();
}

export async function queueNoteDelete(id) {
    await LocalDB.tombstoneNote(id);
    await refreshPending();
    scheduleSoon();
}

let soonTimer = null;
function scheduleSoon() {
    if (soonTimer) return;
    soonTimer = setTimeout(() => {
        soonTimer = null;
        syncNow();
    }, 1200);
}
