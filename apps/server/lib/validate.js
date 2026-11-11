import { isUuid } from '../../client/shared/id.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
    isUUID: isUuid,
    safeInt: (s, def = 1, min = 1, max = 9999) => {
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
    }
};
