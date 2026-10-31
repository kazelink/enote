const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
export const TABLE_SCOPE_VALUES = new Set(['row', 'col', 'rowgroup', 'colgroup']);

export function isSafeMediaSrc(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;

    const compact = trimmed.replace(/\s+/g, '');
    const lower = compact.toLowerCase();

    if (lower.startsWith('/img/backups/') || lower.startsWith('/video/backups/')) return false;
    if (lower.startsWith('/img/') || lower.startsWith('/video/')) return true;
    if (lower.startsWith('https://') || lower.startsWith('http://')) return true;
    return SAFE_DATA_IMAGE_RE.test(compact);
}

export function sanitizeSpanAttribute(value) {
    const numeric = parseInt(String(value || '').trim(), 10);
    return Number.isInteger(numeric) && numeric >= 1 && numeric <= 20 ? String(numeric) : '';
}
