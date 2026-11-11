
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
    return typeof value === 'string' && UUID_RE.test(value);
}

export function newId() {
    const c = globalThis.crypto;
    if (typeof c?.randomUUID === 'function') return c.randomUUID();

    const bytes = new Uint8Array(16);
    if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);

    bytes[6] = (bytes[6] & 0x0f) | 0x40; 
    bytes[8] = (bytes[8] & 0x3f) | 0x80; 

    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
