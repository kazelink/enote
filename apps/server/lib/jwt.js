import { CONFIG } from './config.js';

const enc = new TextEncoder();
// One secret per process → at most two entries (sign + verify).
const keyCache = new Map();

async function getHmacKey(secret, mode) {
  const cacheKey = `${mode}:${secret}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, [mode]
    );
    keyCache.set(cacheKey, key);
  }
  return key;
}

function base64urlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

export async function signToken(secret, nonce) {
  if (!crypto?.subtle) throw new Error('Secure Context Required (HTTPS)');
  if (typeof secret !== 'string' || !secret) throw new Error('JWT Secret Missing');
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64urlEncode(JSON.stringify({
    sub: 'admin',
    nonce,
    exp: Math.floor(Date.now() / 1000) + CONFIG.JWT_EXP
  }));
  const data = enc.encode(`${header}.${payload}`);
  const key = await getHmacKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, data);
  const sigB64 = base64urlEncode(String.fromCharCode(...new Uint8Array(sig)));
  return `${header}.${payload}.${sigB64}`;
}

export async function verifyToken(token, secret) {
  try {
    if (typeof token !== 'string' || !token) return false;
    if (typeof secret !== 'string' || !secret) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [header, payload, sig] = parts;

    // Validate header: only accept HS256
    const h = JSON.parse(base64urlDecode(header));
    if (h.alg !== 'HS256') return false;

    const data = enc.encode(`${header}.${payload}`);
    const key = await getHmacKey(secret, 'verify');
    const sigBin = Uint8Array.from(base64urlDecode(sig), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify('HMAC', key, sigBin, data);
    if (!isValid) return false;

    const p = JSON.parse(base64urlDecode(payload));
    const expSec = Number(p?.exp);
    if (!Number.isFinite(expSec) || expSec <= 0) return false;
    const expMs = expSec * 1000;
    if (Date.now() >= expMs) return false;

    return p;
  } catch { return false; }
}
