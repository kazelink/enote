/**
 * Shared rendering module — imported by BOTH the Node server and the browser.
 *
 * Keeping templates here is what makes "one implementation, three targets"
 * possible: the cloud server renders list pages for the web client, and the
 * desktop/mobile clients render the exact same markup from their local
 * database. No forked template copies, no drift.
 *
 * Rules for this file:
 * - No Node built-ins, no browser-only APIs — pure functions only.
 * - Every user-controlled value must go through escapeHtml().
 */

const ESC_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#x60;'
};

const ESC_RE = /[&<>"'`]/g;

export const escapeHtml = (str) =>
    str == null ? '' : String(str).replace(ESC_RE, (char) => ESC_MAP[char] || char);

function encodeInlineParam(value) {
    return encodeURIComponent(String(value || '')).replace(/'/g, '%27');
}

export function renderArchiveDeleteAction(noteId) {
    return `
      <span class="archive-actions">
        <button class="archive-delete-btn" type="button" aria-label="Delete note"
          onclick="event.stopPropagation(); App.deleteEntry('${noteId}')">
          <i class="ri-close-line"></i>
        </button>
      </span>
  `;
}

export function renderArchiveRow(note) {
    const safeId = escapeHtml(note.id);
    const safeTitle = escapeHtml(note.title || 'Untitled Note');
    const encodedCategory = encodeInlineParam(note.category);
    const encodedSubcategory = encodeInlineParam(note.subcategory);
    const tagsHtml = note.tags.length
        ? note.tags.map((tag) => {
            const safeTag = escapeHtml(tag);
            const encodedTag = encodeInlineParam(tag);
            return `<button class="archive-tag" type="button" onclick="event.stopPropagation(); App.toggleTagByEncoded('${encodedTag}')">#${safeTag}</button>`;
        }).join('')
        : '';

    return `
    <div class="archive-row" role="button" tabindex="0" data-id="${safeId}"
      onclick="App.openNoteById('${safeId}', '${encodedCategory}', '${encodedSubcategory}')"
      onkeydown="if(event.key==='Enter' || event.key===' '){event.preventDefault();App.openNoteById('${safeId}', '${encodedCategory}', '${encodedSubcategory}')}">
      <div class="archive-track"><span class="archive-dot"></span></div>
      <div class="archive-title">${safeTitle}</div>
      <div class="archive-meta">
        <div class="archive-tags">${tagsHtml}</div>
      </div>
      ${renderArchiveDeleteAction(safeId)}
    </div>
  `;
}

export function renderArchiveList(notes) {
    return `<div class="archive-list">${notes.map((note) => renderArchiveRow(note)).join('')}</div>`;
}

export function renderPagination(currPg, totalPg) {
    const safeTotal = Math.max(1, totalPg);
    const safeCurr = Math.min(Math.max(1, currPg), safeTotal);
    const pgStyle = safeTotal > 1 ? 'flex' : 'none';
    const prevCls = safeCurr <= 1 ? ' is-disabled' : '';
    const nextCls = safeCurr >= safeTotal ? ' is-disabled' : '';
    return `
    <div class="pg-box" data-pagination style="display:${pgStyle}">
      <span class="pg-btn${prevCls}" onclick="App.changePage(-1)"><i class="ri-arrow-left-s-line"></i><span class="pg-spin"></span></span>
      <div class="pg-status">
        <span class="pg-status-txt" onclick="App.toggleJump(true)">${safeCurr}</span>
        <input type="number" class="pg-inp" style="display:none"
          value="${safeCurr}"
          onblur="App.toggleJump(false)"
          onkeydown="if(event.key==='Enter')this.blur()">
        <span>/ <span class="pg-total">${safeTotal}</span></span>
      </div>
      <span class="pg-btn${nextCls}" onclick="App.changePage(1)"><i class="ri-arrow-right-s-line"></i><span class="pg-spin"></span></span>
      <div class="pg-data" data-total="${safeTotal}" data-page="${safeCurr}" style="display:none"></div>
    </div>
  `;
}

export function renderArchiveEmptyState({ hasFolderScope, hasAnyFilter }) {
    if (hasFolderScope) {
        return hasAnyFilter
            ? 'No notes matched this folder search.'
            : 'No notes in this subfolder yet.';
    }

    return hasAnyFilter
        ? 'No notes matched this search.'
        : 'No notes in your library yet.';
}

/**
 * Compose the list payload the way the server does for HX requests, so the
 * client can swap in a locally rendered list without any other change.
 */
export function renderArchivePayload({ notes, page, totalPages, hasFolderScope, hasAnyFilter }) {
    const body = notes.length
        ? renderArchiveList(notes)
        : `<div class="loading-hint">${renderArchiveEmptyState({ hasFolderScope, hasAnyFilter })}</div>`;

    return `${body}${renderPagination(page, totalPages)}`;
}
