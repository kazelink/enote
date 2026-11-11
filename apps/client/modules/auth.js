import { Utils, LOADER_SVG, escapeHtml } from './dom.js';
import { UI } from './ui.js';
import { API, Nonce, Token } from './api.js';

const NETWORK_ERROR = 'Cannot reach the server. Check your network, or open "Server" below to change the address.';

export const Auth = {
    init() {
        const form = Utils.$('auth-form'), inp = Utils.$('auth-input'), msg = Utils.$('auth-messages');
        if (!form) return;

        const btn = form.querySelector('.auth-btn');
        let busy = false;

        inp?.addEventListener('input', () => { if (msg) msg.innerHTML = ''; });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (busy) return;

            const password = String(inp?.value || '');
            if (!password.trim()) return;

            busy = true;
            const origHtml = btn ? btn.innerHTML : '';
            if (btn) btn.innerHTML = LOADER_SVG;
            if (msg) msg.innerHTML = '';

            try {
                const res = await API.req('login', { password }, 'POST');

                if (res?.nonce) Nonce.set(res.nonce);
                if (res?.token) Token.set(res.token);

                if (btn) {
                    btn.innerHTML = '<i class="ri-check-line" style="font-size:24px"></i>';
                    btn.style.background = 'var(--success)';
                }
                if (msg) msg.innerHTML = '';
                UI.hideAuth();

                window.App?._startLocalSync?.();

                if (Utils.$('editor-wrapper-dom')?.style.display === 'none') await window.App?.loadView();
            } catch (err) {
                const message = err?.code === 'UNAUTHORIZED' || err?.status
                    ? (err.message || 'ERROR')
                    : NETWORK_ERROR;

                if (btn && origHtml) btn.innerHTML = origHtml;
                if (inp) {
                    inp.value = '';
                    requestAnimationFrame(() => inp.focus({ preventScroll: true }));
                }
                if (msg) msg.innerHTML = `<div class="auth-err">${escapeHtml(message)}</div>`;
            } finally {
                busy = false;
            }
        });
    }
};
