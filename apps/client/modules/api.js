import { UI } from './ui.js';

let memNonce = null;
let memToken = null;

export const Nonce = {
    get() {
        try { return sessionStorage.getItem('session_nonce') || memNonce; }
        catch (e) { return memNonce; }
    },
    set(val) {
        memNonce = val;
        try { sessionStorage.setItem('session_nonce', val); } catch (e) { }
    },
    clear() {
        memNonce = null;
        try { sessionStorage.removeItem('session_nonce'); } catch (e) { }
    }
};

export const Token = {
    get() {
        try { return sessionStorage.getItem('session_token') || memToken; }
        catch (e) { return memToken; }
    },
    set(val) {
        memToken = val;
        try { sessionStorage.setItem('session_token', val); } catch (e) { }
    },
    clear() {
        memToken = null;
        try { sessionStorage.removeItem('session_token'); } catch (e) { }
    }
};

export function authHeaders(extra = {}) {
    const headers = { ...extra };
    const nonce = Nonce.get();
    if (nonce) headers['X-Session-Nonce'] = nonce;
    const token = Token.get();
    if (token) headers['X-Auth-Token'] = token;
    return headers;
}

/**
 * Server address for the packaged shell.
 *
 * In a browser the app is served from the same origin as the API, so an empty
 * base means "relative paths" and nothing changes. In Tauri the page loads
 * from the app bundle (tauri://localhost), where a relative `/api/...` would
 * point at local resources instead of the server — so the shell stores the
 * server URL here.
 */
export function getApiBase() {
    try {
        const stored = String(localStorage.getItem('enote_api_base') || '').replace(/\/+$/, '');
        if (stored) return stored;
    } catch {
        // Fall through to the shell default.
    }

    // Tauri: default to the local Docker port instead of prompting on first
    // launch. The login screen still exposes the server-address panel.
    if (location.hostname === 'tauri.localhost'
        || location.protocol === 'tauri:'
        || Boolean(window.__TAURI_INTERNALS__)) {
        return 'http://127.0.0.1:3000';
    }

    return '';
}

export function setApiBase(url) {
    try {
        localStorage.setItem('enote_api_base', String(url || '').trim().replace(/\/+$/, ''));
    } catch {
        // Storage can be unavailable in hardened contexts; relative paths still work.
    }
}

function buildApiUrl(endpoint, data = {}) {
    const base = endpoint.startsWith('/api/') ? endpoint : `/api/${endpoint}`;
    const params = new URLSearchParams(
        Object.entries(data).filter(([_, value]) => value != null && value !== '')
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

// Abort stalled requests so a dead tunnel surfaces as an error instead of an
// endless spinner. 60s accommodates slow links; uploads/downloads (which can
// legitimately run longer) use their own XHR/fetch paths without this signal.
const REQUEST_TIMEOUT_MS = 60000;

function requestSignal() {
    return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        : undefined;
}

async function fetchWithTimeout(url, options) {
    try {
        return await fetch(url, { ...options, signal: requestSignal() });
    } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            const err = new Error('Request timed out. Check your connection.');
            err.code = 'TIMEOUT';
            throw err;
        }
        throw e;
    }
}

export const API = {
    async req(endpoint, data = {}, method = 'GET') {
        const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
        const url = buildApiUrl(endpoint, hasBody ? {} : data);
        const headers = authHeaders();
        let body = undefined;

        if (hasBody) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(data);
        }

        const res = await fetchWithTimeout(url, { method, headers, body, credentials: 'include', cache: 'no-store' });
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
        const res = await fetchWithTimeout(url, {
            headers: authHeaders({ 'HX-Request': 'true' }),
            credentials: 'include',
            cache: 'no-store'
        });
        const text = await res.text().catch(() => '');
        await handleUnauthorized(res, { error: text });

        if (!res.ok) {
            const err = new Error(text || `HTML Error (${res.status})`);
            err.code = 'API_ERROR';
            err.status = res.status;
            throw err;
        }

        return text;
    }
};