import { db } from './core.js';
import { UPSERT_NOTE_SQL } from './sql.js';
import { extractMediaKeys } from './utils.js';

export function upsertNoteStatement({ id, title, category, subcategory, tagsJson, content, createdAt, updatedAt }) {
    return db.prepare(UPSERT_NOTE_SQL).bind(
        id,
        title,
        category,
        subcategory,
        tagsJson,
        content,
        createdAt,
        updatedAt
    );
}

export function noteMediaStatements(id, content) {
    return [
        db.prepare('DELETE FROM note_media WHERE note_id = ?').bind(id),
        ...extractMediaKeys(content).map((key) =>
            db.prepare('INSERT OR IGNORE INTO note_media (note_id, media_key) VALUES (?, ?)').bind(id, key)
        )
    ];
}

export function noteWriteStatements(note) {
    return [
        upsertNoteStatement(note),
        ...noteMediaStatements(note.id, note.content)
    ];
}
