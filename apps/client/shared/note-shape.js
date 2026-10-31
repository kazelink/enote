import { parseStoredTags } from './tags.js';

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

export function toClientNote(row, seq) {
    if (!row) return null;
    return {
        id: row.id,
        title: row.title,
        category: row.category,
        subcategory: row.subcategory,
        tags: parseStoredTags(row.tags),
        content: typeof row.content === 'string' ? row.content : '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        seq
    };
}
