import sanitizeHtml from 'sanitize-html';

const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const EXTRA_ALLOWED_TAGS = [
  'img', 'video',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption'
];
const TABLE_SCOPE_VALUES = new Set(['row', 'col', 'rowgroup', 'colgroup']);

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

function sanitizeSpanAttribute(value) {
  const numeric = parseInt(String(value || '').trim(), 10);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 20 ? String(numeric) : '';
}

function sanitizeTableCell(tagName, attribs) {
  const next = { ...attribs };
  const colspan = sanitizeSpanAttribute(next.colspan);
  const rowspan = sanitizeSpanAttribute(next.rowspan);

  if (colspan) next.colspan = colspan;
  else delete next.colspan;

  if (rowspan) next.rowspan = rowspan;
  else delete next.rowspan;

  if (tagName === 'th') {
    const scope = String(next.scope || '').toLowerCase();
    if (TABLE_SCOPE_VALUES.has(scope)) next.scope = scope;
    else delete next.scope;
  } else {
    delete next.scope;
  }

  return { tagName, attribs: next };
}

// Static sanitize-html options – built once at module load, reused on every call
const SANITIZE_OPTIONS = {
  allowedTags: [...new Set(sanitizeHtml.defaults.allowedTags.concat(EXTRA_ALLOWED_TAGS))],
  allowedAttributes: {
    '*': ['class', 'style'],
    'a': ['href', 'target', 'rel'],
    'img': ['src', 'alt', 'loading', 'width', 'height'],
    'video': ['src', 'controls', 'preload', 'width', 'height'],
    'td': ['colspan', 'rowspan'],
    'th': ['colspan', 'rowspan', 'scope'],
    'iframe': ['src', 'width', 'height', 'frameborder', 'allow'],
    'source': ['src', 'type']
  },
  allowedSchemes: ['http', 'https', 'mailto', 'data'],
  allowedSchemesAppliedToImg: ['http', 'https', 'data'],
  exclusiveFilter: (frame) => {
    if ((frame.tag === 'img' || frame.tag === 'video' || frame.tag === 'source') && frame.attribs?.src) {
      return !isSafeMediaSrc(frame.attribs.src);
    }
    return false;
  },
  transformTags: {
    'img': (tagName, attribs) => {
      if (attribs.src && !isSafeMediaSrc(attribs.src)) {
        return { tagName: 'img', attribs: { alt: 'Blocked content' } };
      }
      return { tagName, attribs };
    },
    'video': (tagName, attribs) => {
      if (attribs.src && !isSafeMediaSrc(attribs.src)) {
        return { tagName: 'video', attribs: { controls: 'controls' } };
      }
      return { tagName, attribs };
    },
    'td': sanitizeTableCell,
    'th': sanitizeTableCell
  },
  disallowedTagsMode: 'discard'
};

export async function sanitizeContent(html) {
  if (typeof html !== 'string') return '';

  // Use sanitize-html to safely parse and clean HTML
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
