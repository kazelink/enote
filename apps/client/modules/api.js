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
        if (stored) {
            const fixed = upgradeStoredBase(stored);
            if (fixed !== stored) localStorage.setItem('enote_api_base', fixed);
            return fixed;
        }
    } catch {}

    if (!isMobileShell() && isDesktopShell()) return 'http://127.0.0.1:3000';

    return '';
}

export function setApiBase(url) {
    try {
        localStorage.setItem('enote_api_base', String(url || '').trim().replace(/\/+$/, ''));
    } catch {}
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function hostOf(base) {
    const rest = String(base || '').replace(/^[a-z]+:\/\//i, '');
    const hostPort = rest.split(/[/?#]/)[0];
    if (hostPort.startsWith('[')) {
        const end = hostPort.indexOf(']');
        return end === -1 ? hostPort.toLowerCase() : hostPort.slice(1, end).toLowerCase();
    }
    return hostPort.split(':')[0].toLowerCase();
}

function isLanHost(host) {
    return IPV4_RE.test(host)
        || host.includes(':')
        || host === 'localhost'
        || !host.includes('.')
        || host.endsWith('.local');
}

export function normalizeServerBase(raw) {
    let value = String(raw || '').trim();
    if (!value) return null;

    if (!/^[a-z]+:\/\//i.test(value)) {
        value = `${isLanHost(hostOf(value)) ? 'http' : 'https'}://${value}`;
    }
    value = value.replace(/\/+$/, '');

    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return value;
    } catch {
        return null;
    }
}

export function alternateServerBase(base) {
    if (!/^https?:\/\//i.test(base)) return null;
    if (isLanHost(hostOf(base))) return null;
    if (/^https:\/\//i.test(base)) return base.replace(/^https:/i, 'http:');
    return base.replace(/^http:/i, 'https:');
}

function upgradeStoredBase(stored) {
    if (!/^http:\/\//i.test(stored)) return stored;
    if (isLanHost(hostOf(stored))) return stored;

    try {
        const { port } = new URL(stored);
        if (port && port !== '80' && port !== '443') return stored;
    } catch {
        return stored;
    }

    return stored
        .replace(/^http:/i, 'https:')
        .replace(/:(?:80|443)(?=\/|$)/, '');
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
