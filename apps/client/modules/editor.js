import { Utils, State, escapeHtml } from './dom.js';
import { API } from './api.js';
import { UI } from './ui.js';
import { swalAlert, swalUnsaved } from './swal.js';
import { Upload } from './upload.js';
import * as LocalDB from './localdb.js';
import { queueNoteSave } from './sync.js';
import { sanitizePastedHtml } from './paste.js?v=5.5';
import Squire from '../assets/squire.mjs';
import { IndentPlugin } from './editor-indent.js?v=5.4';
import { ImagePlugin } from './editor-image.js';
import { ColorPlugin } from './editor-color.js';
import { TablePlugin } from './editor-table.js?v=5.5';
import { ToolbarPlugin } from './editor-toolbar.js?v=5.6';

const toggleDisplay = Utils.toggleView;

function normalizeTagInput(value) {
    const arr = Array.isArray(value) ? value : String(value || '').split(',');
    return arr.map((tag) => String(tag || '').trim()).filter(Boolean);
}

function createSquireFragment(html) {
    const template = document.createElement('template');
    template.innerHTML = sanitizePastedHtml(String(html || ''));
    return template.content;
}

function isEmptyEditorHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    const root = template.content;
    return !root.textContent.trim() && !root.querySelector('img, video, hr, table');
}

export const Editor = {
    sq: null,
    el: {},
    wrapper: null,
    newContainer: null,
    activeRow: null,
    _vpHandler: null,
    _loadTimer: null,
    _scrollY: null,
    _mainContainer: null,
    _preventScroll: null,
    _savePromise: null,
    _sessionId: 0,
    _activeUploads: new Set(),

    _beforeUnloadHandler: null,
    _metaSuggestMenu: null,
    _metaSuggestField: '',
    _metaSuggestOptions: [],
    _metaSuggestActiveIndex: -1,
    _metaSuggestHideTimer: null,
    _metaSuggestRaf: 0,
    _openMode: '',
    _hiddenInlineNodes: [],
    _metaCollapsed: false,
    _metaSuggestActiveInput: null,

    init() {
        const ids = [
            'toolbar', 'd-text', 'd-save', 'save-txt',
            'img-input', 'vid-input', 'btn-img', 'btn-vid', 'btn-hr', 'btn-color',
            'color-dropdown', 'img-toolbar',
            'n-title', 'n-category', 'n-subcategory', 'n-tags', 'n-date',
            'note-date-pill', 'note-date-text',
            'btn-meta-toggle', 'note-meta-bar'
        ];

        ids.forEach((id) => {
            const element = Utils.$(id);
            if (element) this.el[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = element;
        });

        this.wrapper = Utils.$('editor-wrapper-dom');
        this.newContainer = Utils.$('editor-card');

        if (!this.wrapper || !this.newContainer || !this.el.dText || !this.el.toolbar) return;

        this.sq = new Squire(this.el.dText, {
            blockTag: 'P',
            sanitizeToDOMFragment: createSquireFragment
        });

        IndentPlugin.init(this.sq);
        TablePlugin.init(this.sq);
        ImagePlugin.init(this.sq, this.wrapper, this.el.imgToolbar, () => this._triggerInput?.());
        ColorPlugin.init(this.sq, this.el.btnColor, this.el.colorDropdown);
        ToolbarPlugin.init(this.sq, this.el.toolbar, () => this._triggerInput?.());

        this._bindUnsavedGuard();
        this._bindContent();
        this._bindKeyboard();
        this._bindImage();
        this._bindVideo();
        this._bindMetaFields();
        this._bindUpload();

        if (this.el.dSave) this.el.dSave.onclick = () => this.save();
    },

    snapshot() {
        const el = this.el;
        return JSON.stringify({
            title: el.nTitle?.value || '',
            category: el.nCategory?.value || '',
            subcategory: el.nSubcategory?.value || '',
            tags: el.nTags?.value || '',
            date: el.nDate?.value || '',
            content: this._getEditorHTML()
        });
    },

    _getEditorHTML() {
        const html = this.sq ? this.sq.getHTML() : (this.el.dText?.innerHTML || '');
        return isEmptyEditorHtml(html) ? '' : html;
    },

    _setEditorHTML(html) {
        const safeHtml = sanitizePastedHtml(String(html || ''));
        if (this.sq) {
            if (!/<\s*video\b/i.test(safeHtml)) {
                this.sq.setHTML(safeHtml);
                return;
            }

            this.sq._setRawHTML(safeHtml);
            this.sq._undoIndex = -1;
            this.sq._undoStack.length = 0;
            this.sq._undoStackLength = 0;
            this.sq._isInUndoState = false;

            const root = this.sq.getRoot();
            const range = document.createRange();
            range.setStart(root.firstElementChild || root, 0);
            range.collapse(true);
            this.sq.saveUndoState(range);
            this.sq.setSelection(range);
            this.sq._updatePath?.(range, true);
        } else if (this.el.dText) {
            this.el.dText.innerHTML = safeHtml;
        }
    },

    _handleEditorInput() {
        ToolbarPlugin.scheduleSync();
        if (!ImagePlugin.isResizing) {
            ImagePlugin.deselect();
        }
    },

    async save() {
        if (this._savePromise) return this._savePromise;
        return (this._savePromise = this._doSave().finally(() => (this._savePromise = null)));
    },

    async _doSave() {
        const el = this.el;
        if (!el.dText || !el.nTitle || !el.nCategory || !el.nSubcategory || !el.nDate) return false;

        if (!el.nTitle.value.trim()) {
            swalAlert('Title Required', 'Add a title before saving this note.', 'warning');
            return false;
        }

        if (!el.nCategory.value.trim() || !el.nSubcategory.value.trim()) {
            swalAlert('Folder Required', 'Choose both a major category and a minor category.', 'warning');
            return false;
        }

        if (el.dSave) {
            el.dSave.classList.add('sending');
            el.dSave.disabled = true;
        }

        const returnPage = State.editingId && Number.isFinite(State.page) && State.page > 0 ? State.page : 1;

        try {
            // Local-first write. Persist to IndexedDB and let the sync engine
            // push it in the background: saving no longer waits on the network
            // and works while offline. The server stays authoritative and
            // re-sanitises the content when the change is pushed.
            const existing = State.editingId ? await LocalDB.getNote(State.editingId) : null;
            const id = String(State.editingId || (globalThis.crypto?.randomUUID
                ? globalThis.crypto.randomUUID()
                : `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`));

            const savedNote = {
                id,
                title: String(el.nTitle.value || '').trim(),
                category: String(el.nCategory.value || '').trim(),
                subcategory: String(el.nSubcategory.value || '').trim(),
                tags: normalizeTagInput(el.nTags?.value),
                createdAt: existing?.createdAt || new Date().toISOString(),
                updatedAt: el.nDate.value
                    ? `${el.nDate.value}T00:00:00.000Z`
                    : new Date().toISOString(),
                content: this._getEditorHTML()
            };

            await queueNoteSave({ ...savedNote, _baseSeq: existing?._baseSeq || 0 });

            this._setEditorHTML(savedNote.content);
            el.nTitle.value = savedNote.title;
            el.nCategory.value = savedNote.category;
            el.nSubcategory.value = savedNote.subcategory;
            if (el.nTags) el.nTags.value = savedNote.tags.join(', ');

            this._updateMetaStatus(savedNote.updatedAt);
            window.App?._invalidateSidebarCaches?.();
            window.App?.primeSavedNote?.(savedNote, true);
            State.originalSnapshot = this.snapshot();
            await this.close(true, { savedNote });

            window.App?.route({
                view: 'note',
                category: savedNote.category,
                subcategory: savedNote.subcategory,
                note: savedNote.id,
                q: '', tag: '', page: returnPage
            }, { quiet: true });

            UI.setStatus('ok');
            setTimeout(() => UI.setStatus(''), 2000);
            return true;
        } catch (e) {
            if (e?.code !== 'UNAUTHORIZED') swalAlert('Save Failed', e?.message || 'Unknown error', 'error');
            return false;
        } finally {
            if (el.dSave) {
                el.dSave.classList.remove('sending');
                el.dSave.disabled = false;
            }
        }
    },

    _bindUnsavedGuard() {
        if (!this._beforeUnloadHandler) {
            this._beforeUnloadHandler = (e) => {
                if (this.wrapper.style.display !== 'none' && this.hasContent() && this.snapshot() !== State.originalSnapshot) {
                    e.preventDefault();
                    return (e.returnValue = 'Unsaved changes');
                }
            };
            window.addEventListener('beforeunload', this._beforeUnloadHandler);
        }
    },

    _bindContent() {
        const { dText } = this.el;
        if (!dText) return;

        this._triggerInput = () => this._handleEditorInput();
        this.sq?.addEventListener('input', () => this._triggerInput());
        this.sq?.addEventListener('pasteImage', (e) => {
            const file = [...(e.detail?.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
            if (file) this._uploadAndInsertMedia(file, 'image');
        });

        dText.ondragover = (e) => e.preventDefault();

        const handleMediaFile = (e, files) => {
            const file = [...(files || [])].find((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
            if (file) {
                e.preventDefault();
                this._uploadAndInsertMedia(file, file.type.startsWith('image/') ? 'image' : 'video');
                return true;
            }
            return false;
        };

        dText.addEventListener('drop', (e) => handleMediaFile(e, e.dataTransfer?.files));

        dText.addEventListener('paste', (e) => {
            if (!e.defaultPrevented) handleMediaFile(e, e.clipboardData?.files);
        });
    },

    _bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && this.wrapper?.style.display !== 'none') {
                e.preventDefault();
                if (!this._savePromise) this.save();
            }
        });
    },

    _bindImage() {
        if (this.el.btnImg && this.el.imgInput) this.el.btnImg.onclick = () => this.el.imgInput.click();
    },

    _bindVideo() {
        if (this.el.btnVid && this.el.vidInput) this.el.btnVid.onclick = () => this.el.vidInput.click();
    },

    _bindMetaFields() {
        const el = this.el;[el.nTitle, el.nCategory, el.nSubcategory, el.nTags, el.nDate].forEach((input) => {
            input?.addEventListener('input', () => this._triggerInput?.());
        });

        if (el.nCategory) {
            el.nCategory.addEventListener('input', () => {
                const subcats = this._getSubcategoryValues(el.nCategory.value);
                if (el.nSubcategory && el.nSubcategory.value.trim() && !subcats.includes(el.nSubcategory.value.trim())) {
                    el.nSubcategory.value = '';
                    this._triggerInput?.();
                }
                this._refreshMetaSuggestions('category', { filter: true });
                if (this._metaSuggestField === 'subcategory') this._refreshMetaSuggestions('subcategory');
            });
        }

        if (el.nSubcategory) {
            el.nSubcategory.addEventListener('input', () => this._refreshMetaSuggestions('subcategory', { filter: true }));
        }

        this.bindSuggestion(el.nCategory, 'category');
        this.bindSuggestion(el.nSubcategory, 'subcategory');

        if (el.noteDatePill && el.nDate) {
            el.noteDatePill.addEventListener('click', () => {
                try { el.nDate.showPicker?.(); } catch (e) { }
                el.nDate.focus({ preventScroll: true });
            });
            el.nDate.addEventListener('change', () => {
                this._updateMetaStatus(el.nDate.value);
                this._triggerInput?.();
            });
        }

        if (el.btnMetaToggle) {
            el.btnMetaToggle.addEventListener('click', () => this._setMetaCollapsed(!this._metaCollapsed));
            this._setMetaCollapsed(false);
        }
    },

    bindSuggestion(inputEl, field) {
        if (!inputEl) return;
        const trigger = () => {
            this._metaSuggestActiveInput = inputEl;
            this._cancelHideMetaSuggestions();
            this._refreshMetaSuggestions(field);
        };
        inputEl.addEventListener('focus', trigger);
        inputEl.addEventListener('click', trigger);
        inputEl.addEventListener('keydown', (e) => this._handleMetaSuggestKeydown(e, field));
        inputEl.addEventListener('blur', () => this._scheduleHideMetaSuggestions(field));
    },

    _setMetaCollapsed(collapsed) {
        this._metaCollapsed = !!collapsed;
        if (this._metaCollapsed) this._hideMetaSuggestions();
        this.el.noteMetaBar?.classList.toggle('collapsed', this._metaCollapsed);
        if (this.el.btnMetaToggle) {
            this.el.btnMetaToggle.dataset.state = this._metaCollapsed ? 'collapsed' : 'expanded';
            this.el.btnMetaToggle.setAttribute('aria-label', this._metaCollapsed ? 'Show note details' : 'Hide note details');
        }
    },

    _bindUpload() {
        const attach = (input, type) => {
            if (input) input.onchange = () => {
                const file = input.files[0];
                if (file) this._uploadAndInsertMedia(file, type);
                input.value = '';
            };
        };
        attach(this.el.imgInput, 'image');
        attach(this.el.vidInput, 'video');
    },

    _getFolderTree() {
        return Array.isArray(window.App?._folderTreeCache) ? window.App._folderTreeCache : [];
    },

    _getCategoryValues() {
        return [...new Set(this._getFolderTree().map((r) => String(r?.category || '').trim()).filter(Boolean))];
    },

    _getSubcategoryValues(category) {
        const safe = String(category || '').trim();
        const match = safe ? this._getFolderTree().find((r) => String(r?.category || '').trim() === safe) : null;
        return [...new Set((match?.subfolders || []).map((s) => String(s?.subcategory || '').trim()).filter(Boolean))];
    },

    _sortMetaSuggestionValues(values, query = '') {
        const normalized = [...new Set((values || []).map((v) => String(v || '').trim()).filter(Boolean))];
        const needle = String(query || '').trim().toLowerCase();
        if (!needle) return normalized;

        const matched = [], rest = [];
        normalized.forEach((v) => v.toLowerCase().includes(needle) ? matched.push(v) : rest.push(v));
        return [...matched, ...rest];
    },

    _getMetaSuggestInput(field) {
        return this._metaSuggestActiveInput || (field === 'category' ? this.el.nCategory : (field === 'subcategory' ? this.el.nSubcategory : null));
    },

    _ensureMetaSuggestMenu() {
        if (this._metaSuggestMenu) return this._metaSuggestMenu;

        const menu = document.createElement('div');
        menu.className = 'meta-suggest-menu';
        menu.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const item = e.target.closest('.meta-suggest-item');
            if (item && !isNaN(item.dataset.index)) this._applyMetaSuggestion(+item.dataset.index);
        });

        document.body.appendChild(menu);
        this._metaSuggestMenu = menu;

        document.addEventListener('mousedown', (e) => {
            const input = this._getMetaSuggestInput(this._metaSuggestField);
            if (!menu.contains(e.target) && e.target !== input) this._hideMetaSuggestions();
        });

        const scheduleReposition = () => {
            if (this._metaSuggestRaf) return;
            this._metaSuggestRaf = requestAnimationFrame(() => {
                this._metaSuggestRaf = 0;
                this._repositionMetaSuggestions();
            });
        };
        window.addEventListener('resize', scheduleReposition);
        window.addEventListener('scroll', scheduleReposition, true);
        return menu;
    },

    _renderMetaSuggestions() {
        const menu = this._ensureMetaSuggestMenu();
        menu.innerHTML = this._metaSuggestOptions.map((val, i) => `
            <button type="button" class="meta-suggest-item${i === this._metaSuggestActiveIndex ? ' active' : ''}" data-index="${i}">
                ${escapeHtml(val)}
            </button>
        `).join('');
    },

    _repositionMetaSuggestions() {
        if (!this._metaSuggestField || !this._metaSuggestMenu?.classList.contains('show')) return;
        const input = this._getMetaSuggestInput(this._metaSuggestField);
        const rect = input?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return this._hideMetaSuggestions();

        const menu = this._metaSuggestMenu;
        const spaceBelow = window.innerHeight - rect.bottom - 12;
        const spaceAbove = rect.top - 12;
        const placeAbove = spaceBelow < 140 && spaceAbove > spaceBelow;
        const maxHeight = Math.max(120, Math.min(220, placeAbove ? spaceAbove - 6 : spaceBelow - 6));

        menu.style.left = `${Math.max(12, rect.left)}px`;
        menu.style.top = `${placeAbove ? Math.max(12, rect.top - maxHeight - 6) : rect.bottom + 6}px`;
        menu.style.width = `${rect.width}px`;
        menu.style.maxHeight = `${maxHeight}px`;
    },

    _showMetaSuggestions(field, values) {
        if (!values?.length) return this._hideMetaSuggestions(field);

        this._cancelHideMetaSuggestions();
        this._metaSuggestField = field;
        this._metaSuggestOptions = values;

        const current = String(this._getMetaSuggestInput(field)?.value || '').trim();
        const idx = values.findIndex((v) => String(v || '').trim() === current);
        this._metaSuggestActiveIndex = Math.max(0, idx);

        this._renderMetaSuggestions();
        this._metaSuggestMenu.classList.add('show');
        this._repositionMetaSuggestions();
        this._metaSuggestMenu.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    },

    _hideMetaSuggestions(field = '') {
        if (field && this._metaSuggestField && field !== this._metaSuggestField) return;
        if (this._metaSuggestRaf) {
            cancelAnimationFrame(this._metaSuggestRaf);
            this._metaSuggestRaf = 0;
        }
        this._cancelHideMetaSuggestions();
        this._metaSuggestField = '';
        this._metaSuggestOptions = [];
        this._metaSuggestActiveIndex = -1;
        if (this._metaSuggestMenu) {
            this._metaSuggestMenu.classList.remove('show');
            this._metaSuggestMenu.innerHTML = '';
        }
    },

    _scheduleHideMetaSuggestions(field) {
        this._cancelHideMetaSuggestions();
        this._metaSuggestHideTimer = setTimeout(() => this._hideMetaSuggestions(field), 120);
    },

    _cancelHideMetaSuggestions() {
        if (this._metaSuggestHideTimer) clearTimeout(this._metaSuggestHideTimer);
        this._metaSuggestHideTimer = null;
    },

    _refreshMetaSuggestions(field, { filter = false } = {}) {
        const input = this._getMetaSuggestInput(field);
        if (!input) return;

        let values = field === 'category' ? this._getCategoryValues() : this._getSubcategoryValues(this.el.nCategory?.value);
        if (input.id === 'backup-category' && field === 'category') values = ['(All Categories)', ...values];

        if (!values.length) return this._hideMetaSuggestions(field);
        this._showMetaSuggestions(field, this._sortMetaSuggestionValues(values, filter ? input.value : ''));
    },

    _setMetaSuggestActiveIndex(index) {
        if (!this._metaSuggestOptions.length) return;
        this._metaSuggestActiveIndex = Math.max(0, Math.min(this._metaSuggestOptions.length - 1, index));
        this._renderMetaSuggestions();
        this._metaSuggestMenu?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    },

    _applyMetaSuggestion(index) {
        const value = String(this._metaSuggestOptions[index] || '').trim();
        const el = this._getMetaSuggestInput(this._metaSuggestField);
        if (!value || !el) return;

        el.value = value;
        if (this._metaSuggestField === 'category' && this.el.nSubcategory && el === this.el.nCategory) {
            const currentSub = String(this.el.nSubcategory.value || '').trim();
            this.el.nSubcategory.value = this._getSubcategoryValues(value).includes(currentSub) ? currentSub : '';
        }

        this._triggerInput?.();
        this._hideMetaSuggestions();

        if (this._metaSuggestField === 'category' && this.el.nSubcategory && el === this.el.nCategory) {
            this.el.nSubcategory.focus({ preventScroll: true });
            this._refreshMetaSuggestions('subcategory');
        } else {
            el.focus({ preventScroll: true });
        }
    },

    _handleMetaSuggestKeydown(e, field) {
        const active = this._metaSuggestField === field && this._metaSuggestOptions.length > 0;
        if (!active) {
            if (e.key === 'ArrowDown') {
                this._refreshMetaSuggestions(field);
                if (this._metaSuggestOptions.length) e.preventDefault();
            }
            return;
        }

        if (e.key === 'ArrowDown') return e.preventDefault(), this._setMetaSuggestActiveIndex(this._metaSuggestActiveIndex + 1);
        if (e.key === 'ArrowUp') return e.preventDefault(), this._setMetaSuggestActiveIndex(this._metaSuggestActiveIndex - 1);
        if (e.key === 'Enter') return e.preventDefault(), this._applyMetaSuggestion(this._metaSuggestActiveIndex);
        if (e.key === 'Escape') return e.preventDefault(), this._hideMetaSuggestions(field);
    },

    _updateMetaStatus(dateValue) {
        if (!this.el.noteDateText || !this.el.nDate) return;
        const date = String(dateValue || '').slice(0, 10);
        const safe = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
        this.el.nDate.value = this.el.noteDateText.textContent = safe;
    },

    ensureFocus() {
        if (!this.sq) return;
        this.sq.focus();
        ToolbarPlugin.scheduleSync();
    },

    hasContent() {
        const { dText, nTitle } = this.el;
        return !!(nTitle?.value.trim() || dText?.innerText.trim() || dText?.querySelector('img, video, hr, table'));
    },

    async open(mode, data = {}, anchorEl) {
        this._sessionId += 1;
        const sid = this._sessionId;
        this._setupMobileContext();

        const el = this.el;
        if (!el.dText || !el.nTitle || !el.nCategory || !el.nSubcategory || !el.nTags || !this.wrapper) return;

        this._setEditorHTML(data.content || '');
        el.nTitle.value = data.title || '';
        el.nCategory.value = data.category || '';
        el.nSubcategory.value = data.subcategory || '';
        el.nTags.value = Array.isArray(data.tags) ? data.tags.join(', ') : (data.tags || '');

        this._setMetaCollapsed(false);
        this._updateMetaStatus(data.updatedAt);

        this.wrapper.style.display = 'flex';

        this._openMode = mode === 'new' ? 'new' : (anchorEl ? 'inline-edit' : 'standalone-edit');
        if (el.saveTxt) el.saveTxt.innerText = 'SAVE';

        if (mode === 'new') {
            State.editingId = null;
            this.wrapper.classList.add('editor-in-new');
            this.newContainer.style.display = 'block';
            const mc = this.newContainer.parentElement?.querySelector('.main-card');
            if (mc) mc.style.display = 'none';
            if (window.innerWidth > 600) this.newContainer.appendChild(this.wrapper);
        } else {
            State.editingId = data.id;
            this.activeRow = anchorEl;
            if (!anchorEl) {
                this.newContainer.style.display = 'block';
                const mc = this.newContainer.parentElement?.querySelector('.main-card');
                if (mc) mc.style.display = 'none';
                if (window.innerWidth > 600) {
                    this.newContainer.appendChild(this.wrapper);
                    this.newContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            } else {
                this.activeRow.classList.add('editing-inline');
                this._hiddenInlineNodes = this._collectInlineNodes(this.activeRow);
                this._hiddenInlineNodes.forEach(n => toggleDisplay(n, false));
                if (window.innerWidth > 600) {
                    this.wrapper.classList.add('editor-in-card');
                    this.activeRow.appendChild(this.wrapper);
                }
            }
        }

        State.originalSnapshot = this.snapshot();

        requestAnimationFrame(() => {
            if (sid !== this._sessionId) return;
            if (mode === 'new') {
                el.nTitle.focus({ preventScroll: true });
                el.toolbar.querySelectorAll('.active').forEach((b) => b.classList.remove('active'));
            } else {
                this.ensureFocus();
            }
        });
    },

    async close(force, options = {}) {
        if (!this.wrapper || this.wrapper.style.display === 'none') return true;
        ImagePlugin.deselect();

        if (!force && this.hasContent() && this.snapshot() !== State.originalSnapshot) {
            const saved = await swalUnsaved(() => this.save());
            if (saved === false) return false;
            if (saved === true && this.snapshot() === State.originalSnapshot) return true;
        }

        this._cleanupContext();
        this.newContainer.appendChild(this.wrapper);

        if (this._openMode === 'new' || this._openMode === 'standalone-edit') {
            this.newContainer.style.display = 'none';
            const mc = this.newContainer.parentElement?.querySelector('.main-card');
            if (mc) mc.style.display = '';
        } else if (this._openMode === 'inline-edit' && this.activeRow) {
            this._applySavedNoteToActiveRow(options.savedNote);
            this.activeRow.classList.remove('editing-inline');
            this._hiddenInlineNodes.forEach(n => toggleDisplay(n, true));
        }

        this._hiddenInlineNodes = [];
        this.activeRow = State.editingId = null;
        this._openMode = State.originalSnapshot = '';
        return true;
    },

    _cleanupContext() {
        this._setEditorHTML('');
        ['nTitle', 'nCategory', 'nSubcategory', 'nTags'].forEach(k => { if (this.el[k]) this.el[k].value = ''; });

        this.wrapper.style.display = 'none';
        this.wrapper.classList.remove('editor-fullscreen', 'editor-loading', 'editor-in-card', 'editor-in-new');
        this._hideMetaSuggestions();
        this._setMetaCollapsed(false);
        this._updateMetaStatus('');

        this._sessionId += 1;
        this._activeUploads.forEach((xhr) => xhr.abort());
        this._activeUploads.clear();
        ToolbarPlugin.cancelRaf();
        ImagePlugin.cancelRaf();
        if (this._loadTimer) clearTimeout(this._loadTimer);

        if (this._mainContainer) toggleDisplay(this._mainContainer, true);
        this._mainContainer = null;

        if (this._scrollY != null) window.scrollTo(0, this._scrollY);
        this._scrollY = null;

        if (this._vpHandler && window.visualViewport) {
            window.visualViewport.removeEventListener('resize', this._vpHandler);
            window.visualViewport.removeEventListener('scroll', this._vpHandler);
        }
        this._vpHandler = null;
        this.wrapper.style.height = this.wrapper.style.top = '';

        if (this._preventScroll) document.removeEventListener('touchmove', this._preventScroll);
        this._preventScroll = null;
    },

    _applySavedNoteToActiveRow(note) {
        if (!note || !this.activeRow?.classList.contains('note-detail-shell') || typeof window.App?._renderNoteDetail !== 'function') return;

        const temp = document.createElement('div');
        temp.innerHTML = window.App._renderNoteDetail(note);
        const nextRow = temp.firstElementChild;
        if (!nextRow) return;['.note-detail-header', '.note-detail-body', '.note-detail-footer'].forEach(sel => {
            const cur = this.activeRow.querySelector(sel);
            const nxt = nextRow.querySelector(sel);
            if (cur && nxt) cur.replaceWith(nxt);
            else if (cur) cur.remove();
            else if (nxt) this.activeRow.appendChild(nxt);
        });
    },

    _collectInlineNodes(row) {
        if (!row) return [];
        const sels = row.classList.contains('archive-row')
            ? ['.archive-track', '.archive-title', '.archive-tags', '.archive-date', '.archive-actions']
            : ['.note-detail-header', '.note-detail-body', '.note-detail-footer'];
        return sels.map((s) => row.querySelector(s)).filter(Boolean);
    },

    _setupMobileContext() {
        if (window.innerWidth > 600) return;
        this.wrapper.classList.add('editor-fullscreen', 'editor-loading');
        this._scrollY = window.scrollY;
        toggleDisplay((this._mainContainer = document.querySelector('.d-container')), false);
        document.body.appendChild(this.wrapper);

        this._preventScroll = (e) => { if (!e.target.closest('.editor-box')) e.preventDefault(); };
        document.addEventListener('touchmove', this._preventScroll, { passive: false });

        if (window.visualViewport) {
            this._vpHandler = () => {
                requestAnimationFrame(() => {
                    this.wrapper.style.height = `${window.visualViewport.height}px`;
                    this.wrapper.style.top = `${window.visualViewport.offsetTop}px`;
                });
                if (this.wrapper.classList.contains('editor-loading')) {
                    if (this._loadTimer) clearTimeout(this._loadTimer);
                    this._loadTimer = setTimeout(() => this.wrapper.classList.remove('editor-loading'), 150);
                }
            };
            this._vpHandler();
            window.visualViewport.addEventListener('resize', this._vpHandler, { passive: true });
            window.visualViewport.addEventListener('scroll', this._vpHandler, { passive: true });
        }
    },

    _uploadAndInsertMedia(file, type) {
        const sid = this._sessionId;
        const xhr = Upload.file(file, this.wrapper, (url) => {
            if (sid !== this._sessionId || !this.wrapper || this.wrapper.style.display === 'none' || !/^\/(img|video)\//.test(url)) return;
            this.ensureFocus();
            if (this.sq && type === 'video') {
                const video = document.createElement('video');
                video.src = url;
                video.controls = true;
                video.preload = 'metadata';
                this.sq.insertElement(video);
            } else {
                this.sq?.insertHTML(`<img src="${url}" loading="lazy">`);
            }
            this._triggerInput();
        }, () => this._activeUploads.delete(xhr));
        if (xhr) this._activeUploads.add(xhr);
    }
};
