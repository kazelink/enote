import { Utils, STATUS_SVGS, loadScript } from './dom.js';

const AUTH_ARROW_SVG = '<svg viewBox="0 0 24 24"><path d="M16.172 11l-5.364-5.364 1.414-1.414L20 12l-7.778 7.778-1.414-1.414L16.172 13H4v-2z"></path></svg>';

const RESULT_HOLD_MS = 2000;        
const RESULT_COOLDOWN_MS = 2500;    

const OP_VIEW = {
    loading: { icon: STATUS_SVGS.spin, cls: '', label: 'Working' },
    ok: { icon: STATUS_SVGS.check, cls: 'success', label: 'Done' },
    err: { icon: STATUS_SVGS.cross, cls: 'error', label: 'Failed' }
};

const Status = {
    op: '',             
    sync: null,         
    ackedSyncAt: 0,     
    cooldownUntil: 0,   
    key: '',            
    holdTimer: null,
    opTimer: null
};

function syncView(s, now) {
    if (!s) return null;

    if (s.state === 'syncing') {
        return { icon: STATUS_SVGS.spin, cls: '', label: 'Syncing' };
    }

    if (s.state === 'idle') {
        const pending = Number(s.pending) || 0;
        if (pending) {
            return { icon: STATUS_SVGS.spin, cls: '', label: `${pending} change(s) waiting to upload` };
        }

        const rejected = Array.isArray(s.rejectedIds) ? s.rejectedIds.length : 0;
        if (rejected) {
            return { icon: STATUS_SVGS.cross, cls: 'error', label: `${rejected} note(s) rejected by the server — open and save again to retry` };
        }

        if (s.didWork && s.lastSyncAt && s.lastSyncAt !== Status.ackedSyncAt) {
            if (now < Status.cooldownUntil) {
                Status.ackedSyncAt = s.lastSyncAt;
                return null;
            }
            return { icon: STATUS_SVGS.check, cls: 'success', label: 'Synced', autoAck: true };
        }
        return null;
    }

    if (s.state === 'offline') {
        return { icon: STATUS_SVGS.offline, cls: 'warn', label: 'Offline — changes are saved locally and sync when the server is reachable' };
    }

    if (s.state === 'error' || s.state === 'auth') {
        return {
            icon: STATUS_SVGS.cross,
            cls: 'error',
            label: s.state === 'auth'
                ? 'Session expired, sign in again'
                : (s.lastError ? `Sync failed: ${s.lastError}` : 'Sync failed, will retry automatically')
        };
    }

    return null;
}

function paintStatus() {
    const el = Utils.$('status');
    if (!el) return;

    clearTimeout(Status.holdTimer);
    Status.holdTimer = null;

    let view = OP_VIEW[Status.op] || null;
    if (!view) view = syncView(Status.sync, Date.now());

    const key = view ? `${view.icon}|${view.cls}` : '';
    if (Status.key !== key) {
        Status.key = key;
        el.innerHTML = view ? view.icon : '';
    }

    if (view) {
        el.className = view.cls ? `sync-stat active ${view.cls}` : 'sync-stat active';
        el.title = view.label;
        el.setAttribute('aria-label', view.label);
    } else {
        el.className = 'sync-stat';
        el.title = '';
        el.removeAttribute('aria-label');
    }

    if (view?.autoAck) {
        Status.holdTimer = setTimeout(() => {
            Status.holdTimer = null;
            Status.ackedSyncAt = Status.sync?.lastSyncAt || 0;
            paintStatus();
        }, RESULT_HOLD_MS);
    }
}

function resetAuthUi() {
    const authForm = Utils.$('auth-form');
    const authBtn = authForm?.querySelector('.auth-btn');
    const authMsg = Utils.$('auth-messages');

    if (authMsg) authMsg.innerHTML = '';
    if (authBtn) {
        authBtn.innerHTML = AUTH_ARROW_SVG;
        authBtn.style.removeProperty('background');
    }
}

async function showFancybox(items, options = {}) {
    try {
        await loadScript('/assets/fancybox.umd.js');
        if (typeof Fancybox !== 'undefined') {
            Fancybox.show(items, { showClass: false, Hash: false, ...options });
        }
    } catch (err) {
        console.error('Failed to load Fancybox:', err);
    }
}

function handleMediaClick(target, container) {
    if (target.tagName === 'IMG') {
        const imgs = Array.from(container.querySelectorAll('img'));
        const start = Math.max(0, imgs.indexOf(target));
        const gallery = imgs.map((img) => ({ src: img.src, type: 'image' }));

        showFancybox(gallery, {
            startIndex: start,
            Carousel: { initialSlide: start },
            Images: { Panzoom: { maxScale: 4 } },
            Thumbs: { type: 'modern' },
            wheel: 'zoom'
        });
    } else if (target.tagName === 'VIDEO') {
        target.pause();
        showFancybox([{ src: target.src, type: 'html5video' }]);
    }
}

function appendCrumb(container, label, onClick) {
    const crumb = document.createElement('span');
    crumb.className = 'breadcrumb-item';
    crumb.textContent = label;
    if (onClick) {
        crumb.classList.add('clickable');
        crumb.addEventListener('click', onClick);
    }
    container.appendChild(crumb);
}

function appendDivider(container) {
    const divider = document.createElement('span');
    divider.className = 'breadcrumb-divider';
    divider.textContent = '/';
    container.appendChild(divider);
}

export const UI = {
    setStatus(mode) {
        Status.op = OP_VIEW[mode] ? mode : '';
        clearTimeout(Status.opTimer);
        Status.opTimer = null;

        if (Status.op === 'ok' || Status.op === 'err') {
            Status.cooldownUntil = Date.now() + RESULT_COOLDOWN_MS;
            Status.opTimer = setTimeout(() => {
                Status.opTimer = null;
                Status.op = '';
                paintStatus();
            }, RESULT_HOLD_MS);
        }

        paintStatus();
    },

    renderSync(snapshot) {
        if (snapshot) Status.sync = snapshot;
        paintStatus();
    },

    renderBreadcrumb({ view, category, subcategory, q, tag, currentNote = null, notePathHint = null, onNavigate = null }) {
        const titleEl = Utils.$('c-title-box');
        if (!titleEl) return;
        const navigate = onNavigate || (() => {});
        const noteCategory = view === 'note' && !category
            ? String(currentNote?.category || notePathHint?.category || '')
            : String(category || '');
        const noteSubcategory = view === 'note' && !subcategory
            ? String(currentNote?.subcategory || notePathHint?.subcategory || '')
            : String(subcategory || '');

        if (view === 'backup') {
            titleEl.textContent = 'BACKUP';
            return;
        }

        titleEl.innerHTML = '';
        if (view === 'index') {
            appendCrumb(titleEl, 'NOTES', () => navigate({
                view: 'index',
                category: '',
                subcategory: '',
                note: '',
                q: '',
                tag: '',
                page: 1
            }));
            return;
        }

        if ((view === 'list' || view === 'note') && !noteCategory && !noteSubcategory) {
            appendCrumb(titleEl, q || tag ? 'SEARCH' : 'LIBRARY', null);
            return;
        }

        if (noteCategory) {
            appendCrumb(titleEl, noteCategory, (view === 'list' || view === 'note')
                ? () => navigate({
                    view: 'category',
                    category: noteCategory,
                    subcategory: '',
                    note: '',
                    q: '',
                    tag: '',
                    page: 1
                })
                : null);
        }

        if (noteSubcategory) {
            if (titleEl.childNodes.length) appendDivider(titleEl);
            appendCrumb(titleEl, noteSubcategory, (view === 'list' || view === 'note')
                ? () => navigate({
                    view: 'list',
                    category: noteCategory,
                    subcategory: noteSubcategory,
                    note: '',
                    q: '',
                    tag: '',
                    page: 1
                })
                : null);
        }
    },

    showAuth() {
        const overlay = Utils.$('auth-overlay');
        if (!overlay) return;

        overlay.classList.add('active');
        resetAuthUi();
        window.App?._renderAuthServerAddress?.();

        const inputEl = Utils.$('auth-input');
        if (inputEl) {
            inputEl.value = '';
            inputEl.focus({ preventScroll: true });

            const focusOnReady = (e) => {
                if (e.propertyName === 'opacity') {
                    inputEl.focus({ preventScroll: true });
                }
            };
            overlay.addEventListener('transitionend', focusOnReady, { once: true });
        }
    },

    hideAuth() {
        const overlay = Utils.$('auth-overlay');
        if (overlay) overlay.classList.remove('active');
    },

    initGlobalEvents() {
        document.addEventListener('click', (e) => {
            const dcText = e.target.closest('.dc-text');
            if (!dcText) return;

            const isMedia = e.target.tagName === 'IMG' || e.target.tagName === 'VIDEO';
            if (isMedia) {
                e.preventDefault();
                handleMediaClick(e.target, dcText);
            }
        });
    }
};
