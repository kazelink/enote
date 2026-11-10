import { getCookie } from 'hono/cookie';
import { verifyToken } from './jwt.js';
import { respondError } from './utils.js';

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

export async function cookieOnlyAuth(c, next) {
    const secret = process.env.JWT_SECRET;
    if (typeof secret !== 'string' || !secret) {
        return respondError(c, 'Server Not Configured', 500);
    }

    const url = new URL(c.req.url);
    const queryToken = url.searchParams.get('t');
    // 桌面/移动壳里页面域是 tauri://localhost，向远端取媒体属于跨域，
    // SameSite=Lax 的 Cookie 带不上，所以要接受请求头里的 token。
    const headerToken = c.req.header('X-Auth-Token');
    const token = getCookie(c, 'enote_auth') || headerToken || queryToken;

    if (!token || !(await verifyToken(token, secret))) {
        return respondError(c, 'Unauthorized', 401);
    }

    await next();
}

