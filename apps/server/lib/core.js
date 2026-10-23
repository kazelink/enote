import Database from 'better-sqlite3';
import fs from 'fs';
import { opendir } from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

class LocalDatabase {
    constructor(dbPath) {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        // NORMAL is the recommended pairing with WAL: far fewer fsyncs on save,
        // still crash-safe (worst case loses the last transaction, no corruption).
        this.db.pragma('synchronous = NORMAL');
        // Make note_media's ON DELETE CASCADE actually fire (SQLite default is OFF).
        this.db.pragma('foreign_keys = ON');
        this._stmtCache = new Map();
    }

    _cachedPrepare(query) {
        let stmt = this._stmtCache.get(query);
        if (!stmt) {
            stmt = this.db.prepare(query);
            this._stmtCache.set(query, stmt);
        }
        return stmt;
    }

    prepare(query) {
        return new LocalPreparedStatement(this, query);
    }

    async batch(statements) {
        const results = [];
        const runBatch = this.db.transaction(() => {
            for (const stmt of statements) {
                results.push(stmt.runSync());
            }
        });
        runBatch();
        return results;
    }

    exec(sql) {
        return this.db.exec(sql);
    }
}

class LocalPreparedStatement {
    constructor(localDb, query, params = []) {
        this._localDb = localDb;
        this.query = query;
        this.params = params;
    }

    bind(...params) {
        return new LocalPreparedStatement(this._localDb, this.query, params);
    }

    async all() {
        try {
            const stmt = this._localDb._cachedPrepare(this.query);
            let results;
            if (stmt.reader) {
                results = stmt.all(...this.params);
            } else {
                stmt.run(...this.params);
                results = [];
            }
            return { results, success: true };
        } catch (e) {
            console.error("DB all() error on query:", this.query, e);
            throw e;
        }
    }

    async first() {
        try {
            const stmt = this._localDb._cachedPrepare(this.query);
            if (!stmt.reader) {
                return null;
            }
            const result = stmt.get(...this.params);
            return result || null;
        } catch (e) {
            console.error("DB first() error on query:", this.query, e);
            throw e;
        }
    }

    async run() {
        return this.runSync();
    }

    iterate() {
        try {
            const stmt = this._localDb._cachedPrepare(this.query);
            if (!stmt.reader) {
                stmt.run(...this.params);
                return [][Symbol.iterator]();
            }
            return stmt.iterate(...this.params);
        } catch (e) {
            console.error("DB iterate() error on query:", this.query, e);
            throw e;
        }
    }

    runSync() {
        try {
            const stmt = this._localDb._cachedPrepare(this.query);
            if (stmt.reader) {
                 const rows = stmt.all(...this.params);
                 return { results: rows, success: true, meta: { changes: 0, last_row_id: 0 } };
            }
            const info = stmt.run(...this.params);
            return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        } catch (e) {
            console.error("DB run() error on query:", this.query, e);
            throw e;
        }
    }
}

// Canonical MIME↔extension mapping, shared with the upload route.
export const MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov'
};

const MIME_BY_EXT = Object.fromEntries([
    ...Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime]),
    ['jpeg', 'image/jpeg']
]);

function getMimeTypeFromExtension(key) {
    const ext = key.split('.').pop()?.toLowerCase();
    return ext ? (MIME_BY_EXT[ext] || 'application/octet-stream') : 'application/octet-stream';
}

class LocalStorage {
    constructor(baseDir) {
        this.baseDir = baseDir;
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    _getFilePath(key) {
        const safeKey = key.replace(/\.\./g, '').replace(/^\//, '');
        return path.join(this.baseDir, safeKey);
    }

    // Callers only ever pass a File (multipart upload) or a node stream
    // (validated raw upload); anything else is a programming error.
    async put(key, body) {
        const filePath = this._getFilePath(key);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        try {
            if (typeof Blob !== 'undefined' && body instanceof Blob) {
                await pipeline(Readable.fromWeb(body.stream()), fs.createWriteStream(filePath));
            } else if (body && typeof body.pipe === 'function') {
                await pipeline(body, fs.createWriteStream(filePath));
            } else {
                throw new Error('Unsupported storage body type');
            }

            return { key };
        } catch (error) {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            throw error;
        }
    }

    async get(key) {
        const filePath = this._getFilePath(key);
        if (!fs.existsSync(filePath)) {
            return null;
        }

        const contentType = getMimeTypeFromExtension(key);
        const nodeStream = fs.createReadStream(filePath);
        const webStream = Readable.toWeb(nodeStream);

        return {
            body: webStream,
            writeHttpMetadata: (headers) => {
                headers.set('Content-Type', contentType);
            }
        };
    }

    async *iterate({ prefix = '' } = {}) {
        const basePrefix = prefix.replace(/\.\./g, '').replace(/^\//, '');
        const searchDir = path.join(this.baseDir, basePrefix);

        if (!fs.existsSync(searchDir)) {
            return;
        }

        yield* this._iterateDir(searchDir, '', basePrefix);
    }

    async *_iterateDir(dir, currentPrefix, basePrefix) {
        const handle = await opendir(dir);

        try {
            for await (const entry of handle) {
                // Skip .meta.json files (legacy cleanup)
                if (entry.name.endsWith('.meta.json')) {
                    // Optionally delete stale .meta.json files on iteration
                    try {
                        const metaPath = path.join(dir, entry.name);
                        fs.unlinkSync(metaPath);
                    } catch {
                        // Ignore cleanup errors
                    }
                    continue;
                }

                const fullPath = path.join(dir, entry.name);
                const relativeKey = currentPrefix ? `${currentPrefix}${entry.name}` : entry.name;

                if (entry.isDirectory()) {
                    yield* this._iterateDir(fullPath, `${relativeKey}/`, basePrefix);
                    continue;
                }

                if (!entry.isFile()) continue;

                const stat = await fs.promises.stat(fullPath);
                yield {
                    key: basePrefix
                        ? path.join(basePrefix, relativeKey).replace(/\\/g, '/')
                        : relativeKey.replace(/\\/g, '/'),
                    uploaded: stat.mtime,
                    size: stat.size
                };
            }
        } finally {
            await handle.close().catch(() => {});
        }
    }

    async delete(key) {
        const filePath = this._getFilePath(key);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        // No .meta.json to delete
    }

    has(key) {
        return fs.existsSync(this._getFilePath(key));
    }

    // Same-volume move: atomic and O(1) regardless of file size, unlike a
    // stream copy. Returns null when the source does not exist.
    async move(fromKey, toKey) {
        const fromPath = this._getFilePath(fromKey);
        if (!fs.existsSync(fromPath)) return null;

        const toPath = this._getFilePath(toKey);
        const dir = path.dirname(toPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        await fs.promises.rename(fromPath, toPath);
        return { key: toKey };
    }
}

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'enote.db');
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(process.cwd(), 'data', 'storage');

export const db = new LocalDatabase(DB_PATH);
export const bucket = new LocalStorage(STORAGE_PATH);

export function runBackground(promise) {
    Promise.resolve(promise).catch(e => console.error("Unhandled background task error:", e));
}
