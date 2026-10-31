export function normalizeInlineText(value, maxLen) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.slice(0, maxLen);
}

export function normalizeTagList(input, { maxTags = 12, maxLen = 24 } = {}) {
    const source = Array.isArray(input)
        ? input
        : String(input || '').split(/[,\n，]+/);

    const tags = [];
    const seen = new Set();

    for (const raw of source) {
        const normalized = normalizeInlineText(raw, maxLen);
        if (!normalized) continue;

        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;

        seen.add(key);
        tags.push(normalized);
        if (tags.length >= maxTags) break;
    }

    return tags;
}

export function parseStoredTags(raw) {
    if (Array.isArray(raw)) return normalizeTagList(raw);
    if (typeof raw !== 'string' || !raw.trim()) return [];

    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return normalizeTagList(parsed);
    } catch {
    }

    return normalizeTagList(raw);
}

export function serializeTags(tags) {
    return JSON.stringify(normalizeTagList(tags));
}
