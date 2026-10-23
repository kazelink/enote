// Lightweight input validation helpers
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRealDate(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export const V = {
    isDateStr: isRealDate,
    isUUID: (s) => typeof s === 'string' && UUID_RE.test(s),
    safeInt: (s, def = 1, min = 1, max = 9999) => {
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
    }
};
