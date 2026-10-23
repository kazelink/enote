import { setImmediate as waitImmediate } from 'timers/promises';
import { extractMediaKeys } from './utils.js';
import { db, bucket } from './core.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOP_YIELD_EVERY = 200;

function uploadedAtMs(obj) {
    const ts = obj?.uploaded instanceof Date ? obj.uploaded.getTime() : Date.parse(String(obj?.uploaded || ''));
    return Number.isFinite(ts) ? ts : 0;
}

async function maybeYield(iterationCount) {
    if (iterationCount > 0 && iterationCount % LOOP_YIELD_EVERY === 0) {
        await waitImmediate();
    }
}

// Rebuild note_media index: extract all media keys from current notes.
// Also used after a bulk restore, which does not maintain the index per note.
export async function rebuildNoteMediaIndex() {
    // Clear the table
    await db.prepare('DELETE FROM note_media').run();
    
    const insertMediaKey = db.db.prepare('INSERT OR IGNORE INTO note_media (note_id, media_key) VALUES (?, ?)');
    const flushPendingKeys = db.db.transaction((records) => {
        for (const record of records) {
            insertMediaKey.run(record.note_id, record.media_key);
        }
    });

    const pendingRecords = [];
    const BATCH_SIZE = 250;
    let noteCount = 0;

    // Iterate all notes and extract media keys
    for (const row of db.prepare('SELECT id, content FROM notes').iterate()) {
        noteCount += 1;

        const mediaKeys = extractMediaKeys(row?.content);
        for (const mediaKey of mediaKeys) {
            pendingRecords.push({ note_id: row.id, media_key: mediaKey });
            if (pendingRecords.length >= BATCH_SIZE) {
                flushPendingKeys(pendingRecords);
                pendingRecords.length = 0;
            }
        }

        await maybeYield(noteCount);
    }

    if (pendingRecords.length > 0) {
        flushPendingKeys(pendingRecords);
    }

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

// Ultra-fast GC: iterate bucket, check note_media index
async function cleanupOrphanedMediaFast() {
    let scanned = 0;
    let deleted = 0;

    // Iterate bucket and check presence in note_media index
    const checkKeyStmt = db.db.prepare('SELECT 1 FROM note_media WHERE media_key = ? LIMIT 1');

    for await (const obj of bucket.iterate()) {
        scanned += 1;
        const key = obj.key;

        if (key.startsWith('tmp/') || key.startsWith('backups/')) {
            await maybeYield(scanned);
            continue;
        }

        // Check if this key is referenced in any note
        const isUsed = !!checkKeyStmt.get(key);
        if (!isUsed) {
            try {
                await bucket.delete(key);
                deleted += 1;
            } catch {
                // Ignore delete failures
            }
        }

        await maybeYield(scanned);
    }

    return { scanned, deleted };
}

export async function scheduledGc() {
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
    } catch (e) {
        console.error('Scheduled GC failed:', e);
    }
}
