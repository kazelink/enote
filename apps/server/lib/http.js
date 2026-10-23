export function jsonError(c, message, status) {
  return c.json({ error: message }, status);
}

export function textError(c, message, status) {
  return c.text(message, status);
}

export function getContentLength(c) {
  const value = Number.parseInt(c.req.header('Content-Length') || '', 10);
  return Number.isFinite(value) ? value : null;
}

export function getQueryString(c, key, fallback = '') {
  const value = c.req.query(key);
  const first = Array.isArray(value) ? value[0] : value;
  return first == null ? fallback : String(first);
}

export async function parseJsonBody(c, invalidMessage = 'Invalid JSON payload') {
  try {
    return { value: await c.req.json(), response: null };
  } catch {
    return { value: null, response: jsonError(c, invalidMessage, 400) };
  }
}
