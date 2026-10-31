import sanitizeHtml from 'sanitize-html';
import { TABLE_SCOPE_VALUES, isSafeMediaSrc, sanitizeSpanAttribute } from '../../client/shared/media-rules.js';

const EXTRA_ALLOWED_TAGS = [
  'img', 'video',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption'
];

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

export function sanitizeContent(html) {
  if (typeof html !== 'string') return '';

  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

