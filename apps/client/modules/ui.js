import { Utils, RI_SVGS, loadScript } from './dom.js';


const AUTH_ARROW_SVG = '<svg viewBox="0 0 24 24"><path d="M16.172 11l-5.364-5.364 1.414-1.414L20 12l-7.778 7.778-1.414-1.414L16.172 13H4v-2z"></path></svg>';

const STATUS_ICONS = {
    loading: RI_SVGS.loader,
    ok: '<i class="ri-check-line"></i>',
    err: '<i class="ri-close-line" style="color:var(--danger)"></i>'
};

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

function appendCrumb(container, label, onClick, isPending = false) {
    const crumb = document.createElement('span');
    crumb.className = 'breadcrumb-item';
    crumb.textContent = label;
    if (onClick) {
        crumb.classList.add('clickable');
        crumb.addEventListener('click', onClick);
    }
    if (isPending) {
        crumb.classList.add('is-loading');
        const spin = document.createElement('span');
        spin.className = 'crumb-spin';
        crumb.appendChild(spin);
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
        const statusEl = Utils.$('sync-stat');
        if (!statusEl) return;

        statusEl.className = `sync-stat active ${mode === 'ok' ? 'success' : ''}`.trim();
        statusEl.innerHTML = STATUS_ICONS[mode] || '';
    },

    renderBreadcrumb({ view, category, subcategory, q, tag, currentNote = null, notePathHint = null, onNavigate = null, pendingKey = null }) {
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
            }), pendingKey === 'index');
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
                : null, pendingKey === 'category');
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
                : null, pendingKey === 'list');
        }
    },

    showAuth() {
        const overlay = Utils.$('auth-overlay');
        if (!overlay) return;

        overlay.classList.add('active');
        resetAuthUi();

        const inputEl = Utils.$('auth-input');
        if (inputEl) {
            inputEl.value = '';
            // Immediate focus attempt
            inputEl.focus({ preventScroll: true });

            // Native event-driven focus when transition completes
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
