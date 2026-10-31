import { Utils, RI_SVGS } from './dom.js';
import { UI } from './ui.js';
import { Nonce, Token } from './api.js';

export const Auth = {
    init() {
        const form = Utils.$('auth-form'), inp = Utils.$('auth-input'), msg = Utils.$('auth-messages');
        if (!form) return;

        const btn = form.querySelector('.auth-btn');
        let origHtml = '';

        inp?.addEventListener('input', () => { if (msg) msg.innerHTML = ''; });

        form.addEventListener('htmx:beforeRequest', () => {
            if (btn) { origHtml = btn.innerHTML; btn.innerHTML = RI_SVGS.loader; }
            if (msg) msg.innerHTML = '';
        });

        msg?.addEventListener('htmx:beforeSwap', e => {
            if (e.detail.xhr.status >= 400) Object.assign(e.detail, { shouldSwap: true, isError: false });
        });

        form.addEventListener('htmx:afterRequest', e => {
            if (e.detail.failed || e.detail.xhr.status >= 400) {
                if (btn && origHtml) btn.innerHTML = origHtml;
                if (inp) { inp.value = ''; requestAnimationFrame(() => inp.focus({ preventScroll: true })); }
                if (msg && !msg.innerHTML.trim()) msg.innerHTML = e.detail.xhr.responseText || '<div class="auth-err">ERROR</div>';
            }
        });

        document.body.addEventListener('loginSuccess', async () => {
            const okEl = Utils.$('auth-messages')?.querySelector('.auth-ok');
            if (okEl?.dataset?.nonce) Nonce.set(okEl.dataset.nonce);
            if (okEl?.dataset?.token) Token.set(okEl.dataset.token);
            if (btn) {
                btn.innerHTML = '<i class="ri-check-line" style="font-size:24px"></i>';
                btn.style.background = 'var(--success)';
            }
            if (msg) msg.innerHTML = '';
            UI.hideAuth();

            window.App?._startLocalSync?.();

            if (Utils.$('editor-wrapper-dom')?.style.display === 'none') await window.App?.loadView();
        });
    }
};
