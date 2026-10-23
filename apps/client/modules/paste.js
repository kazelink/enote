const ALLOWED_TAGS = new Set([
    'p', 'div', 'h1', 'h2', 'blockquote', 'br',
    'span', 'b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre',
    'ul', 'ol', 'li', 'a', 'img', 'video',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption'
]);

const STRIP_WITH_CONTENT = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math',
    'template', 'noscript', 'form', 'base', 'link', 'meta'
]);

const BLOCK_ALIGN_TAGS = new Set(['p', 'div', 'h1', 'h2', 'blockquote', 'ul', 'ol', 'li', 'th', 'td', 'caption']);
const INDENT_TAGS = new Set(['p', 'div', 'h1', 'h2', 'blockquote', 'ul', 'ol', 'li']);
const ALIGN_VALUES = new Set(['left', 'center', 'right', 'justify']);
const TABLE_SCOPE_VALUES = new Set(['row', 'col', 'rowgroup', 'colgroup']);
const DIVIDER_TEXT = '----------';
const DIVIDER_CLASS = 'text-divider';
const SAFE_COLOR_RE = /^(#[0-9a-f]{3,8}|rgb(a)?\(\s*[\d.\s,%]+\)|hsl(a)?\(\s*[\d.\s,%]+\)|[a-z]{1,20}|var\(\s*--[a-z0-9_-]+\s*(,\s*(#[0-9a-f]{3,8}|rgb(a)?\(\s*[\d.\s,%]+\)|hsl(a)?\(\s*[\d.\s,%]+\)))?\s*\))$/i;
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function parseStyleMap(styleText) {
    const styleMap = new Map();

    for (const rawRule of String(styleText || '').split(';')) {
        const idx = rawRule.indexOf(':');
        if (idx === -1) continue;

        const prop = rawRule.slice(0, idx).trim().toLowerCase();
        const value = rawRule.slice(idx + 1).trim();
        if (!prop || !value) continue;

        styleMap.set(prop, value);
    }

    return styleMap;
}

function isSafeHref(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;

    const compact = trimmed.replace(/[\u0000-\u001f\u007f\s]+/g, '').toLowerCase();
    if (compact.startsWith('javascript:') || compact.startsWith('vbscript:') || compact.startsWith('data:text/html')) {
        return false;
    }

    return /^https?:\/\//.test(compact)
        || compact.startsWith('/')
        || compact.startsWith('mailto:')
        || compact.startsWith('tel:');
}

function isSafeMediaSrc(value) {
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

function sanitizeClass(tag, value) {
    if (typeof value !== 'string') return '';
    const classes = value.split(/\s+/).filter(Boolean);
    if (INDENT_TAGS.has(tag)) {
        return [
            classes.includes('indent') ? 'indent' : '',
            tag === 'p' && classes.includes(DIVIDER_CLASS) ? DIVIDER_CLASS : ''
        ].filter(Boolean).join(' ');
    }
    return '';
}

function sanitizeStyle(tag, styleMap) {
    const safeRules = [];

    if (BLOCK_ALIGN_TAGS.has(tag)) {
        const textAlign = String(styleMap.get('text-align') || '').toLowerCase();
        if (ALIGN_VALUES.has(textAlign)) safeRules.push(`text-align:${textAlign}`);
    }

    if (tag === 'span') {
        const color = String(styleMap.get('color') || '').trim();
        if (SAFE_COLOR_RE.test(color)) safeRules.push(`color:${color}`);
    }

    if (tag === 'img') {
        const compactWidth = String(styleMap.get('width') || '').replace(/\s+/g, '');
        const match = compactWidth.match(/^(\d{1,3})%$/);
        if (match) {
            const percent = Number(match[1]);
            if (percent >= 1 && percent <= 100) safeRules.push(`width:${percent}%`);
        }
    }

    return safeRules.join(';');
}

function sanitizeSpanAttribute(value) {
    const numeric = parseInt(String(value || '').trim(), 10);
    return Number.isInteger(numeric) && numeric >= 1 && numeric <= 20 ? String(numeric) : '';
}

function isBoldWeight(value) {
    const compact = String(value || '').trim().toLowerCase();
    if (!compact) return false;
    if (compact === 'bold' || compact === 'bolder') return true;

    const numeric = parseInt(compact, 10);
    return Number.isFinite(numeric) && numeric >= 600;
}

function extractSemanticWrappers(styleMap) {
    const wrappers = [];

    if (isBoldWeight(styleMap.get('font-weight'))) wrappers.push('strong');
    if (String(styleMap.get('font-style') || '').trim().toLowerCase() === 'italic') wrappers.push('em');

    const textDecoration = [
        styleMap.get('text-decoration'),
        styleMap.get('text-decoration-line')
    ].filter(Boolean).join(' ').toLowerCase();

    if (textDecoration.includes('underline')) wrappers.push('u');
    if (textDecoration.includes('line-through')) wrappers.push('s');

    return wrappers;
}

function wrapChildren(el, wrappers) {
    if (!wrappers.length || !el.firstChild) return;

    const doc = el.ownerDocument;
    const outer = doc.createElement(wrappers[0]);
    let cursor = outer;

    for (let i = 1; i < wrappers.length; i += 1) {
        const next = doc.createElement(wrappers[i]);
        cursor.appendChild(next);
        cursor = next;
    }

    while (el.firstChild) {
        cursor.appendChild(el.firstChild);
    }

    el.appendChild(outer);
}

function unwrapElement(el) {
    const parent = el.parentNode;
    if (!parent) return;

    while (el.firstChild) {
        parent.insertBefore(el.firstChild, el);
    }
    parent.removeChild(el);
}

function sanitizeAllowedElement(el, tag, styleMap) {
    const nextAttrs = new Map();
    const rawClass = el.getAttribute('class');
    const rawHref = el.getAttribute('href');
    const rawSrc = el.getAttribute('src');
    const rawTarget = String(el.getAttribute('target') || '').toLowerCase();
    const rawTitle = el.getAttribute('title');
    const rawAlt = el.getAttribute('alt');
    const rawColspan = el.getAttribute('colspan');
    const rawRowspan = el.getAttribute('rowspan');
    const rawScope = String(el.getAttribute('scope') || '').toLowerCase();

    if (rawClass) {
        const safeClass = sanitizeClass(tag, rawClass);
        if (safeClass) nextAttrs.set('class', safeClass);
    }

    const safeStyle = sanitizeStyle(tag, styleMap);
    if (safeStyle) nextAttrs.set('style', safeStyle);

    if (tag === 'a') {
        if (isSafeHref(rawHref)) {
            nextAttrs.set('href', rawHref.trim());
            if (rawTitle) nextAttrs.set('title', rawTitle);
            if (rawTarget === '_blank') {
                nextAttrs.set('target', '_blank');
                nextAttrs.set('rel', 'noopener noreferrer');
            }
        }
    }

    if (tag === 'img') {
        if (!isSafeMediaSrc(rawSrc)) {
            el.remove();
            return;
        }
        nextAttrs.set('src', rawSrc.trim());
        nextAttrs.set('loading', 'lazy');
        if (rawAlt) nextAttrs.set('alt', rawAlt);
        if (rawTitle) nextAttrs.set('title', rawTitle);
    }

    if (tag === 'video') {
        if (!isSafeMediaSrc(rawSrc)) {
            el.remove();
            return;
        }
        nextAttrs.set('src', rawSrc.trim());
        nextAttrs.set('controls', '');
        nextAttrs.set('preload', 'none');
    }

    if (tag === 'td' || tag === 'th') {
        const colspan = sanitizeSpanAttribute(rawColspan);
        const rowspan = sanitizeSpanAttribute(rawRowspan);
        if (colspan) nextAttrs.set('colspan', colspan);
        if (rowspan) nextAttrs.set('rowspan', rowspan);
        if (tag === 'th' && TABLE_SCOPE_VALUES.has(rawScope)) nextAttrs.set('scope', rawScope);
    }

    for (const attr of Array.from(el.attributes)) {
        el.removeAttribute(attr.name);
    }

    for (const [name, value] of nextAttrs.entries()) {
        el.setAttribute(name, value);
    }

    if (tag === 'span' && el.attributes.length === 0) {
        unwrapElement(el);
    }
}

function sanitizeNode(node) {
    if (!node) return;

    if (node.nodeType === 3) return;
    if (node.nodeType !== 1) {
        node.remove();
        return;
    }

    const el = node;
    const tag = el.tagName.toLowerCase();

    if (STRIP_WITH_CONTENT.has(tag)) {
        el.remove();
        return;
    }

    const styleMap = parseStyleMap(el.getAttribute('style'));
    wrapChildren(el, extractSemanticWrappers(styleMap));

    Array.from(el.childNodes).forEach(sanitizeNode);

    if (!ALLOWED_TAGS.has(tag)) {
        unwrapElement(el);
        return;
    }

    sanitizeAllowedElement(el, tag, styleMap);
}

export function sanitizePastedHtml(html) {
    if (typeof html !== 'string' || !html.trim()) return '';

    const doc = new DOMParser().parseFromString(html, 'text/html');
    Array.from(doc.body.childNodes).forEach(sanitizeNode);
    return doc.body.innerHTML.trim();
}
