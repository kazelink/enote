import { Utils, getBlockFromRange } from './dom.js';
import { IndentPlugin }    from './editor-indent.js?v=5.4';
import { ImagePlugin }     from './editor-image.js';
import { TablePlugin }     from './editor-table.js?v=5.5';

const HEADING_BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'BLOCKQUOTE']);
const DIVIDER_TEXT = '----------';
const DIVIDER_CLASS = 'text-divider';

function getBlock(sq) {
    return getBlockFromRange(sq.getSelection(), sq.getRoot());
}

function replaceBlockTag(block, tag) {
    if (!HEADING_BLOCKS.has(block.nodeName) || block.nodeName === tag) return;
    const el = document.createElement(tag);
    if (block.className) el.className = block.className;
    if (block.style.cssText) el.style.cssText = block.style.cssText;
    if (block.dir) el.dir = block.dir;
    while (block.firstChild) el.appendChild(block.firstChild);
    block.parentNode.replaceChild(el, block);
}

function ensureValidSelection(sq) {
    const root = sq.getRoot();
    const range = sq.getSelection();
    if (root.contains(range.startContainer)) return;
    const r = document.createRange();
    r.setStart(root.firstChild || root, 0);
    r.collapse(true);
    sq.setSelection(r);
}

function getTopLevelNodeFromRange(range, root) {
    let node = range.startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    if (!node || node === root) return root.lastChild || null;

    while (node.parentNode && node.parentNode !== root) {
        node = node.parentNode;
    }
    return root.contains(node) ? node : null;
}

function isEmptyBlock(node) {
    return !!node
        && /^(P|DIV)$/i.test(node.nodeName)
        && !node.textContent.trim()
        && !node.querySelector('img, video, table');
}

function setCursorAtEnd(sq, node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    sq.setSelection(range);
    sq._updatePath?.(range, true);
}

function insertTextDivider(sq) {
    ensureValidSelection(sq);

    const root = sq.getRoot();
    const doc = root.ownerDocument;
    const range = sq.getSelection();
    const anchor = getTopLevelNodeFromRange(range, root);
    const divider = doc.createElement('p');

    divider.className = DIVIDER_CLASS;
    divider.style.textAlign = 'center';
    divider.textContent = DIVIDER_TEXT;

    sq.saveUndoState(range);

    if (anchor && root.children.length === 1 && isEmptyBlock(anchor)) {
        root.replaceChild(divider, anchor);
    } else if (anchor && anchor.parentNode === root) {
        root.insertBefore(divider, anchor.nextSibling);
    } else {
        root.appendChild(divider);
    }

    sq._docWasChanged();
    sq.focus();
    setCursorAtEnd(sq, divider);
}

function toggleHeading(sq, tag) {
    const blocks = [];
    sq.forEachBlock((block) => {
        if (HEADING_BLOCKS.has(block.nodeName)) blocks.push(block);
    });
    if (!blocks.length) return;

    const newTag = blocks.every((block) => block.nodeName === tag) ? 'P' : tag;
    sq.modifyBlocks((frag) => {
        Array.from(frag.childNodes).forEach((block) => replaceBlockTag(block, newTag));
        return frag;
    });
    sq.focus();
}

function findListAtCursor(sq, tag) {
    const root = sq.getRoot();
    const range = sq.getSelection();
    for (const node of [range.startContainer, range.endContainer]) {
        const el = node.nodeType === 3 ? node.parentNode : node;
        const list = el?.closest?.(tag);
        if (list && root.contains(list)) return list;
    }
    return null;
}

function removeList(sq, list) {
    const range = sq.getSelection();
    sq.saveUndoState(range);

    const newBlocks = [];
    for (const li of Array.from(list.children)) {
        if (li.nodeName !== 'LI') { newBlocks.push(li.cloneNode(true)); continue; }
        const p = document.createElement('P');
        while (li.firstChild) p.appendChild(li.firstChild);
        newBlocks.push(p);
    }
    const frag = document.createDocumentFragment();
    newBlocks.forEach(b => frag.appendChild(b));
    list.replaceWith(frag);
    sq._docWasChanged();

    try {
        const r = document.createRange();
        const first = newBlocks[0];
        const last = newBlocks[newBlocks.length - 1];
        r.setStart(first, 0);
        r.setEnd(last, last.childNodes.length);
        sq.setSelection(r);
    } catch (_) {
        sq.focus();
    }
}

export const ToolbarPlugin = {
    sq: null,
    _raf: null,
    _onChange: null,
    _docHandler: null,
    _btns: null,

    init(sq, toolbar, onChange) {
        this.sq = sq;
        this._onChange = onChange;
        if (!toolbar) return;

        this._btns = {
            bold:       toolbar.querySelector('[data-cmd="bold"]'),
            italic:     toolbar.querySelector('[data-cmd="italic"]'),
            ol:         Utils.$('btn-ol'),
            ul:         Utils.$('btn-ul'),
            h1:         toolbar.querySelector('[data-val="H1"]'),
            h2:         toolbar.querySelector('[data-val="H2"]'),
            blockquote: toolbar.querySelector('[data-val="blockquote"]'),
            center:     Utils.$('btn-center'),
            justify:    Utils.$('btn-justify'),
            indent:     toolbar.querySelector('[data-cmd="indentClass"]'),
            table:      Utils.$('btn-table'),
            tableContext: Array.from(toolbar.querySelectorAll('[data-table-context]')),
        };

        const moreWrapper = toolbar.querySelector('.tb-more-wrapper');
        const moreTrigger = toolbar.querySelector('.tb-more-trigger');
        const morePanel   = toolbar.querySelector('.tb-more-panel');

        if (moreTrigger && moreWrapper && morePanel) {
            const positionPanel = () => {
                morePanel.style.left = '100%';
                morePanel.style.right = 'auto';
                morePanel.style.paddingLeft = '6px';
                morePanel.style.paddingRight = '0';
                requestAnimationFrame(() => {
                    if (morePanel.getBoundingClientRect().right > window.innerWidth - 4) {
                        morePanel.style.left = 'auto';
                        morePanel.style.right = '100%';
                        morePanel.style.paddingLeft = '0';
                        morePanel.style.paddingRight = '6px';
                    }
                });
            };
            moreTrigger.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (moreWrapper.classList.toggle('open')) positionPanel();
            });
            moreWrapper.addEventListener('mouseenter', positionPanel);
            if (this._docHandler) document.removeEventListener('mousedown', this._docHandler);
            this._docHandler = (e) => {
                if (!moreWrapper.contains(e.target)) moreWrapper.classList.remove('open');
            };
            document.addEventListener('mousedown', this._docHandler);
        }

        const IGNORED = ['btn-img', 'btn-vid', 'btn-color', 'btn-hr'];

        toolbar.onmousedown = (e) => {
            if (e.target.closest('.tb-more-trigger')) return;
            const btn = e.target.closest('.tb-btn');
            if (!btn || btn.disabled || IGNORED.includes(btn.id)) return;
            e.preventDefault();
            sq.focus();
            this._handleAction(btn.dataset.cmd, btn.dataset.val);
            this.scheduleSync();
            ImagePlugin._schedulePosition();
        };

        const btnHr = Utils.$('btn-hr');
        if (btnHr) {
            btnHr.onclick = () => {
                insertTextDivider(sq);
                this._onChange?.();
                this.scheduleSync();
            };
        }

        sq.addEventListener('pathChange', () => this.scheduleSync());
        sq.addEventListener('select',     () => this.scheduleSync());
        sq.addEventListener('cursor',     () => this.scheduleSync());
    },

    _handleAction(cmd, val) {
        const sq = this.sq;
        ensureValidSelection(sq);
        switch (cmd) {
            case 'bold':
                sq.hasFormat('B') ? sq.removeBold() : sq.bold();
                break;

            case 'italic':
                sq.hasFormat('I') ? sq.removeItalic() : sq.italic();
                break;

            case 'justifyCenter': {
                if (ImagePlugin.currImg) {
                    ImagePlugin.toggleCenter();
                } else {
                    const block = getBlock(sq);
                    const isCentered = block?.style.textAlign === 'center';
                    sq.setTextAlignment(isCentered ? 'left' : 'center');
                }
                break;
            }

            case 'justifyFull': {
                const block = getBlock(sq);
                const isJustify = block?.style.textAlign === 'justify';
                sq.setTextAlignment(isJustify ? 'left' : 'justify');
                break;
            }

            case 'indentClass':
                IndentPlugin.toggle(sq);
                break;

            case 'insertOrderedList': {
                const ol = findListAtCursor(sq, 'ol');
                ol ? removeList(sq, ol) : sq.makeOrderedList();
                break;
            }

            case 'insertUnorderedList': {
                const ul = findListAtCursor(sq, 'ul');
                ul ? removeList(sq, ul) : sq.makeUnorderedList();
                break;
            }

            case 'formatBlock':
                if (val === 'blockquote') {
                    const range = sq.getSelection();
                    let node = range.startContainer;
                    if (node.nodeType === 3) node = node.parentNode;
                    const root = sq.getRoot();
                    const bq = node?.closest?.('blockquote');
                    (bq && root.contains(bq)) ? sq.removeQuote() : sq.increaseQuoteLevel();
                } else if (val === 'H1' || val === 'H2') {
                    toggleHeading(sq, val);
                }
                break;

            case 'insertTable':
                TablePlugin.insertTable(sq);
                break;

            case 'insertTableRow':
                TablePlugin.insertRow(sq);
                break;

            case 'insertTableColumn':
                TablePlugin.insertColumn(sq);
                break;

            case 'deleteTableRow':
                TablePlugin.deleteRow(sq);
                break;

            case 'deleteTableColumn':
                TablePlugin.deleteColumn(sq);
                break;

            case 'deleteTable':
                TablePlugin.deleteTable(sq);
                break;

            default: break;
        }
        if (this._onChange) this._onChange();
    },

    scheduleSync() {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
            this._raf = null;
            this._syncState();
        });
    },

    _syncState() {
        const sq = this.sq;
        const b = this._btns;
        if (!sq || !b) return;

        const block = getBlock(sq);
        const range = sq.getSelection();
        let bqNode = range.startContainer;
        if (bqNode.nodeType === 3) bqNode = bqNode.parentNode;

        b.bold?.classList.toggle('active', sq.hasFormat('B'));
        b.italic?.classList.toggle('active', sq.hasFormat('I'));

        b.ol?.classList.toggle('active', !!findListAtCursor(sq, 'ol'));
        b.ul?.classList.toggle('active', !!findListAtCursor(sq, 'ul'));

        b.h1?.classList.toggle('active', block?.nodeName === 'H1');
        b.h2?.classList.toggle('active', block?.nodeName === 'H2');
        b.blockquote?.classList.toggle('active', !!bqNode?.closest?.('blockquote'));

        const isCentered = ImagePlugin.currImg
            ? ImagePlugin.currImg.parentElement?.style.textAlign === 'center'
            : (block?.style.textAlign === 'center');
        b.center?.classList.toggle('active', !!isCentered);
        b.justify?.classList.toggle('active', block?.style.textAlign === 'justify');

        b.indent?.classList.toggle('active', IndentPlugin.isActive(sq));

        const inTable = TablePlugin.isActive(sq);
        b.table?.classList.toggle('active', inTable);
        b.tableContext?.forEach((btn) => {
            btn.disabled = !inTable;
        });
    },

    cancelRaf() {
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    }
};
