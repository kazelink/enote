import { getCookie } from 'hono/cookie';
import { verifyToken } from './jwt.js';
import { respondError } from './utils.js';

// Full auth requires the JWT (X-Auth-Token header or cookie) plus the matching session nonce header.
export async function authMiddleware(c, next) {
    const secret = process.env.JWT_SECRET;
    if (typeof secret !== 'string' || !secret) {
        return respondError(c, 'Server Not Configured', 500);
    }

    const headerToken = c.req.header('X-Auth-Token');
    const token = (headerToken && headerToken.trim()) || getCookie(c, 'enote_auth');
    const nonce = c.req.header('X-Session-Nonce');

    if (!token || !nonce) return respondError(c, 'Unauthorized', 401);

    const payload = await verifyToken(token, secret);
    if (!payload || payload.nonce !== nonce) return respondError(c, 'Unauthorized', 401);

    await next();
}

// Cookie-only auth is used for browser-native media requests that cannot attach custom headers.
export async function cookieOnlyAuth(c, next) {
    const secret = process.env.JWT_SECRET;
    if (typeof secret !== 'string' || !secret) {
        return respondError(c, 'Server Not Configured', 500);
    }

    // Native <img>/<video> requests cannot set headers. The packaged desktop and
    // mobile shells are cross-origin and therefore do not receive the auth
    // cookie, so they pass the same JWT as a query parameter. Signature and
    // expiry are still verified, so this does not widen what a valid token can
    // do — it only changes how it is transported.
    const url = new URL(c.req.url);
    const queryToken = url.searchParams.get('t');
    const token = getCookie(c, 'enote_auth') || queryToken;
    if (!token || !(await verifyToken(token, secret))) {
        return respondError(c, 'Unauthorized', 401);
    }

    await next();
}
