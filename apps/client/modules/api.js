import { UI } from './ui.js';

function createSessionStore(key) {
    let memValue = null;
    return {
        get() {
            try { return sessionStorage.getItem(key) || memValue; }
            catch { return memValue; }
        },
        set(val) {
            memValue = val;
            try { sessionStorage.setItem(key, val); } catch {}
        },
        clear() {
            memValue = null;
            try { sessionStorage.removeItem(key); } catch {}
        }
    };
}

export const Nonce = createSessionStore('session_nonce');
export const Token = createSessionStore('session_token');

export function authHeaders(extra = {}) {
    const headers = { ...extra };
    const nonce = Nonce.get();
    if (nonce) headers['X-Session-Nonce'] = nonce;
    const token = Token.get();
    if (token) headers['X-Auth-Token'] = token;
    return headers;
}

export function isDesktopShell() {
    return location.hostname === 'tauri.localhost'
        || location.protocol === 'tauri:'
        || Boolean(window.__TAURI_INTERNALS__);
}

function isMobileShell() {
    return isDesktopShell() && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

export function getApiBase() {
    try {
        const stored = String(localStorage.getItem('enote_api_base') || '').replace(/\/+$/, '');
        if (stored) return stored;
    } catch {}

    // The desktop build may have a server on the same machine; a phone has none,
    // so it stays empty and the first-run prompt asks for the address instead.
    if (!isMobileShell() && isDesktopShell()) return 'http://127.0.0.1:3000';

    return '';
}

export function setApiBase(url) {
    try {
        localStorage.setItem('enote_api_base', String(url || '').trim().replace(/\/+$/, ''));
    } catch {}
}

function buildApiUrl(endpoint, data = {}) {
    const base = endpoint.startsWith('/api/') ? endpoint : `/api/${endpoint}`;
    const params = new URLSearchParams(
        Object.entries(data).filter(([, value]) => value != null && value !== '')
    );
    const path = `${getApiBase()}${base}`;
    return params.toString() ? `${path}?${params.toString()}` : path;
}

async function handleUnauthorized(res, payload) {
    if (res.status !== 401) return;
    Nonce.clear();
    Token.clear();
    UI.showAuth();
    const err = new Error(payload?.error || 'Unauthorized');
    err.code = 'UNAUTHORIZED';
    err.status = 401;
    throw err;
}

const REQUEST_TIMEOUT_MS = 30000;
const SYNC_TIMEOUT_MS = 15000;

function requestSignal(timeoutMs) {
    return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
}

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
    try {
        return await fetch(url, { ...options, signal: requestSignal(timeoutMs) });
    } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            const err = new Error('Request timed out. Check your connection.');
            err.code = 'TIMEOUT';
            throw err;
        }
        throw e;
    }
}

function safeStorageGet(key) {
    try {
        return localStorage.getItem(key) || '';
    } catch {
        return '';
    }
}

function safeStorageSet(key, value) {
    if (!value || value.length > 1024 * 1024) return;
    try {
        localStorage.setItem(key, value);
    } catch {}
}

export const API = {
    async req(endpoint, data = {}, method = 'GET') {
        const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
        const url = buildApiUrl(endpoint, hasBody ? {} : data);
        const headers = authHeaders();
        let body;

        if (hasBody) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(data);
        }

        const res = await fetchWithTimeout(
            url,
            { method, headers, body, credentials: 'include', cache: 'no-store' },
            String(endpoint).replace(/^\/?api\//, '').startsWith('sync/') ? SYNC_TIMEOUT_MS : REQUEST_TIMEOUT_MS
        );
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        let payload = null;

        if (contentType.includes('application/json')) {
            payload = await res.json().catch(() => null);
        } else {
            const text = await res.text().catch(() => '');
            payload = text ? { error: text } : null;
        }

        await handleUnauthorized(res, payload);

        if (!res.ok) {
            const err = new Error(payload?.error || `API Error (${res.status})`);
            err.code = 'API_ERROR';
            err.status = res.status;
            throw err;
        }

        return payload ?? {};
    },

    async html(endpoint, data = {}) {
        const url = buildApiUrl(endpoint, data);
        const cacheKey = `enote:html:${url}`;

        let res;
        try {
            res = await fetchWithTimeout(url, {
                headers: authHeaders({ 'HX-Request': 'true' }),
                credentials: 'include',
                cache: 'no-store'
            });
        } catch (err) {
            const cached = safeStorageGet(cacheKey);
            if (cached) {
                document.body.classList.add('is-offline');
                return cached;
            }
            throw err;
        }

        const text = await res.text().catch(() => '');
        await handleUnauthorized(res, { error: text });

        if (!res.ok) {
            const err = new Error(text || `HTML Error (${res.status})`);
            err.code = 'API_ERROR';
            err.status = res.status;
            throw err;
        }

        safeStorageSet(cacheKey, text);
        document.body.classList.remove('is-offline');
        return text;
    }
};
