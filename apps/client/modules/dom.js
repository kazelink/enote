export const RI_SVGS = {
    loader: '<svg class="ri-icon spin" viewBox="0 0 24 24"><path d="M18.364 5.636L16.95 7.05A7 7 0 1 0 19 12h2a9 9 0 1 1-2.636-6.364z"></path></svg>'
};

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (val) => String(val ?? '').replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]);

export const State = {
    view: 'index',
    category: '',
    subcategory: '',
    note: '',
    q: '',
    tag: '',
    page: 1,
    editingId: null,
    originalSnapshot: '',
    data: { totalPg: 1 }
};

const _scriptCache = new Map();
export function loadScript(src, timeout = 8000) {
    if (_scriptCache.has(src)) return _scriptCache.get(src);
    const p = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        const timer = setTimeout(() => {
            cleanup();
            _scriptCache.delete(src);
            reject(new Error(`Script load timeout: ${src}`));
        }, timeout);
        const cleanup = () => { s.onload = s.onerror = null; clearTimeout(timer); };
        s.onload = () => { cleanup(); resolve(); };
        s.onerror = () => {
            cleanup();
            _scriptCache.delete(src);
            reject(new Error(`Script load failed: ${src}`));
        };
        document.head.appendChild(s);
    });
    _scriptCache.set(src, p);
    return p;
}

export const Utils = {
    $: (id) => document.getElementById(id),
    toggleView(el, isVisible) {
        if (el) el.style.display = isVisible ? '' : 'none';
    }
};

const BLOCK_SELECTOR = 'p, div, h1, h2, blockquote, li';

export function getBlockFromRange(range, root) {
    let node = range.startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    const block = node?.closest?.(BLOCK_SELECTOR);
    return block && block !== root && root.contains(block) ? block : null;
}
