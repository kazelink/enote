import { setImmediate as waitImmediate } from 'timers/promises';
import { extractMediaKeys } from './utils.js';
import { db, bucket } from './core.js';
import { pruneSyncChanges } from './sync.js';
import { maintenanceTask } from './maintenance.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOP_YIELD_EVERY = 200;

const SYNC_CHANGE_RETAIN_DAYS = 30;

function uploadedAtMs(obj) {
    const ts = obj?.uploaded instanceof Date ? obj.uploaded.getTime() : Date.parse(String(obj?.uploaded || ''));
    return Number.isFinite(ts) ? ts : 0;
}

async function maybeYield(iterationCount) {
    if (iterationCount > 0 && iterationCount % LOOP_YIELD_EVERY === 0) {
        await waitImmediate();
    }
}

const INSERT_MEDIA_SQL = 'INSERT OR IGNORE INTO note_media (note_id, media_key) VALUES (?, ?)';
const SCAN_BATCH = 250;

export async function rebuildNoteMediaIndex() {
    await db.prepare('DELETE FROM note_media').run();

    let noteCount = 0;
    let lastId = '';
    let pending = [];

    const flush = async () => {
        if (!pending.length) return;
        await db.batch(pending.map((r) => db.prepare(INSERT_MEDIA_SQL).bind(r.note_id, r.media_key)));
        pending = [];
    };

    for (;;) {
        const { results } = await db.prepare(
            'SELECT id, content FROM notes WHERE id > ? ORDER BY id LIMIT ?'
        ).bind(lastId, SCAN_BATCH).all();

        if (!results.length) break;

        for (const row of results) {
            noteCount += 1;
            lastId = row.id;

            for (const mediaKey of extractMediaKeys(row?.content)) {
                pending.push({ note_id: row.id, media_key: mediaKey });
                if (pending.length >= SCAN_BATCH) await flush();
            }
        }

        await maybeYield(noteCount);
    }

    await flush();
    return noteCount;
}

async function cleanupStaleTmpObjects(cutoff) {
    let scanned = 0;
    let deleted = 0;

    for await (const obj of bucket.iterate({ prefix: 'tmp/' })) {
        scanned += 1;
        const ts = uploadedAtMs(obj);
        if (ts > 0 && ts < cutoff) {
            await bucket.delete(obj.key);
            deleted += 1;
        }
        await maybeYield(scanned);
    }

    return { scanned, deleted };
}

async function cleanupOrphanedMediaFast() {
    let scanned = 0;
    let deleted = 0;

    const indexed = Number((await db.prepare('SELECT COUNT(*) AS n FROM note_media').first())?.n) || 0;
    const totalNotes = Number((await db.prepare('SELECT COUNT(*) AS n FROM notes').first())?.n) || 0;
    if (totalNotes > 0 && indexed === 0) {
        console.warn('Media GC: note_media looks empty while notes exist, skipping orphan cleanup.');
        return { scanned: 0, deleted: 0, skipped: true };
    }

    const isReferenced = async (key) => Boolean(await db.prepare(
        'SELECT 1 AS x FROM note_media WHERE media_key = ? LIMIT 1'
    ).bind(key).first());

    for await (const obj of bucket.iterate()) {
        scanned += 1;
        const key = obj.key;

        if (key.startsWith('tmp/') || key.startsWith('backups/')) {
            await maybeYield(scanned);
            continue;
        }

        const isUsed = await isReferenced(key);
        if (!isUsed) {
            try {
                await bucket.delete(key);
                deleted += 1;
            } catch {
            }
        }

        await maybeYield(scanned);
    }

    return { scanned, deleted };
}

export async function scheduledGc() {
    if (maintenanceTask()) {
        console.log('Media GC: skipped (maintenance in progress).');
        return;
    }

    try {
        console.log('Media GC: rebuilding note_media index...');
        const noteCount = await rebuildNoteMediaIndex();
        console.log(`Media GC: indexed ${noteCount} notes.`);

        const cutoff = Date.now() - DAY_MS;
        const tmpStats = await cleanupStaleTmpObjects(cutoff);
        if (tmpStats.deleted > 0) {
            console.log(`Media GC: deleted ${tmpStats.deleted} stale tmp files out of ${tmpStats.scanned} scanned.`);
        }

        const mediaStats = await cleanupOrphanedMediaFast();
        if (mediaStats.deleted > 0) {
            console.log(`Media GC: deleted ${mediaStats.deleted} orphaned media files out of ${mediaStats.scanned} scanned.`);
        }

        const pruned = await pruneSyncChanges({ retainDays: SYNC_CHANGE_RETAIN_DAYS });
        console.log(`Sync GC: pruned change rows older than ${pruned.cutoff}.`);
    } catch (e) {
        console.error('Scheduled GC failed:', e);
    }
}
