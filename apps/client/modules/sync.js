import { API, Token } from './api.js';
import * as LocalDB from './localdb.js';
import { toRemoteNote } from '../shared/note-shape.js';

const PULL_LIMIT = 100;
const PUSH_BATCH = 40;
const MAX_PUSH_ROUNDS = 200;
const AUTO_SYNC_MS = 120_000;
const MAX_PULL_PAGES = 200;

export const SyncStatus = {
    state: 'idle',
    lastSyncAt: 0,
    lastError: null,
    pending: 0,
    didWork: false,
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
let rerunRequested = false;
let timer = null;
let started = false;

let clockOffsetMs = 0;
let clockLoaded = false;

export function serverNowIso() {
    return new Date(Date.now() + clockOffsetMs).toISOString();
}

let backoffMs = 0;
let backoffUntil = 0;

const MIN_SYNC_GAP_MS = 3_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

function isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}

let retryTimer = null;

function scheduleRetry(delayMs) {
    if (retryTimer) return;
    const wait = Math.max(250, Math.min(Number(delayMs) || 0, MAX_RETRY_DELAY_MS));
    retryTimer = setTimeout(() => {
        retryTimer = null;
        syncNow();
    }, wait);
}

function clearRetry() {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
}

function resetBackoff() {
    backoffMs = 0;
    backoffUntil = 0;
}

async function refreshPending() {
    try {
        SyncStatus.update({ pending: await LocalDB.pendingCount() });
    } catch {
    }
}

async function pushPending() {
    const conflicts = [];
    let pushed = 0;

    for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
        const { notes, deletions } = await LocalDB.pendingChanges(PUSH_BATCH);
        if (!notes.length && !deletions.length) break;

        if (notes.length) {
            const res = await API.req('sync/push', {
                notes: notes.map(toRemoteNote)
            }, 'POST');

            for (const c of res.conflicts || []) conflicts.push(c);

            const seqById = new Map((res.notes || []).map((n) => [n.id, n.seq]));
            const done = notes.filter((n) => seqById.has(n.id));
            if (done.length) {
                await LocalDB.markNotesSynced(done, seqById);
                pushed += done.length;
            }
        }

        if (deletions.length) {
            const res = await API.req('sync/push', {
                deletions: deletions.map((n) => ({ id: n.id, baseSeq: n._baseSeq || 0 }))
            }, 'POST');

            for (const c of res.conflicts || []) conflicts.push(c);

            const deletedIds = res.deletedIds || [];
            if (deletedIds.length) {
                await LocalDB.markDeletedSynced(deletedIds);
                pushed += deletedIds.length;
            }

            for (const c of res.conflicts || []) {
                if (c.kind === 'delete' && c.note) {
                    await LocalDB.restoreFromServer(c.note, c.serverSeq || 0);
                }
            }
        }
    }

    return { conflicts, pushed };
}

async function pullRemote() {
    let cursor = await LocalDB.getCursor();
    let pages = 0;
    let changed = 0;

    while (pages++ < MAX_PULL_PAGES) {
        const res = await API.req('sync/pull', { since: cursor, limit: PULL_LIMIT });

        if (res.fullReset) {
            await LocalDB.resetForFullResync();
            cursor = 0;
            await LocalDB.setCursor(0);
            changed += 1;
            continue;
        }

        if (res.serverTime) {
            const skew = Date.parse(res.serverTime) - Date.now();
            if (Number.isFinite(skew) && Math.abs(skew - clockOffsetMs) > 1000) {
                clockOffsetMs = skew;
                LocalDB.writeMeta('clockOffset', skew).catch(() => {});
            }
        }

        const batchNotes = res.notes || [];
        const batchDeletes = (res.deleted || []).map((d) => d.id);
        if (batchNotes.length || batchDeletes.length) {
            changed += batchNotes.length + batchDeletes.length;
            await LocalDB.applyRemoteBatch(batchNotes, batchDeletes);
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

    await LocalDB.writeMeta('initialized', 1);

    return { cursor, changed };
}

export async function syncNow({ force = false } = {}) {
    if (running) {
        rerunRequested = true;
        return { queued: true };
    }

    if (!clockLoaded) {
        clockOffsetMs = Number(await LocalDB.readMeta('clockOffset', 0)) || 0;
        clockLoaded = true;
    }

    if (!Token.get()) {
        SyncStatus.update({ state: 'auth' });
        return { noSession: true };
    }

    if (!force && Date.now() < backoffUntil) {
        scheduleRetry(backoffUntil - Date.now());
        return { backedOff: true };
    }
    if (!force && Date.now() - SyncStatus.lastSyncAt < MIN_SYNC_GAP_MS) {
        scheduleRetry(MIN_SYNC_GAP_MS - (Date.now() - SyncStatus.lastSyncAt));
        return { throttled: true };
    }

    if (!force && isOffline()) {
        SyncStatus.update({ state: 'offline' });
        return { offline: true };
    }

    clearRetry();
    running = true;
    SyncStatus.update({ state: 'syncing', lastError: null });

    try {
        const conflicts = await pushPending();
        const pullResult = await pullRemote();

        resetBackoff();

        SyncStatus.update({
            state: 'idle',
            lastSyncAt: Date.now(),
            lastError: null,
            didWork: conflicts.pushed > 0 || (pullResult?.changed || 0) > 0,
            conflicts: conflicts.conflicts
        });

        if (pullResult?.changed > 0) {
            window.dispatchEvent(new CustomEvent('enote:data-changed'));
        }

        await refreshPending();
        return { ok: true, conflicts: conflicts.conflicts };
    } catch (error) {
        const authFailure = error?.code === 'UNAUTHORIZED';

        if (!authFailure) {
            backoffMs = Math.min(backoffMs ? backoffMs * 2 : 5_000, 5 * 60_000);
            backoffUntil = Date.now() + backoffMs;
            if (!isOffline()) scheduleRetry(backoffMs);
        }

        SyncStatus.update({
            state: authFailure ? 'auth' : (isOffline() ? 'offline' : 'error'),
            lastError: authFailure ? null : (error?.message || String(error))
        });
        if (!authFailure) console.error('Sync failed:', error);
        return { ok: false, error };
    } finally {
        running = false;
        if (rerunRequested) {
            rerunRequested = false;
            setTimeout(() => { syncNow({ force: true }); }, 0);
        }
    }
}

export function startSyncEngine() {
    if (started) return;
    started = true;

    setTimeout(() => { syncNow(); }, 300);

    timer = setInterval(() => { syncNow(); }, AUTO_SYNC_MS);

    window.addEventListener('focus', () => { syncNow(); });
    window.addEventListener('online', () => {
        resetBackoff();
        clearRetry();
        syncNow({ force: true });
    });
    window.addEventListener('offline', () => SyncStatus.update({ state: 'offline' }));

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            if (SyncStatus.pending > 0) syncNow({ force: true });
        } else {
            resetBackoff();
            syncNow({ force: true });
        }
    });
}

export async function queueNoteSave(note) {
    await LocalDB.putNote(note, { dirty: 1, baseSeq: note._baseSeq || 0 });
    await LocalDB.writeMeta('initialized', 1);
    await refreshPending();
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

