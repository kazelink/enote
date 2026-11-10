import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 用临时数据库按生产方式起一个服务端（与 Docker 里跑的是同一个入口）。
 * 测试之间通过不同的 category / 新 UUID 隔离，避免互相污染。
 */
export async function startServer({ serveWeb = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enote-test-'));
  const dbPath = path.join(dir, 'e.db');
  const port = await freePort();

  const proc = spawn(process.execPath, ['apps/server/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SERVE_WEB: serveWeb ? 'true' : 'false',
      APP_PASSWORD: 'test-pw',
      JWT_SECRET: 'test-secret',
      DB_PATH: dbPath,
      STORAGE_PATH: path.join(dir, 'storage')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;

  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/api/sync/state`);
      if (res.status === 401) break;
    } catch {
      // 还没起来
    }
    await sleep(150);
  }

  const login = await (await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-pw' })
  })).json();

  if (!login?.token) {
    proc.kill();
    throw new Error(`登录失败，服务端日志：\n${log}`);
  }

  const headers = {
    'content-type': 'application/json',
    'X-Auth-Token': login.token,
    'X-Session-Nonce': login.nonce
  };

  return {
    base,
    headers,
    dbPath,
    dir,
    log: () => log,
    async stop() {
      proc.kill();
      await sleep(300);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  };
}

export function note(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: 'note',
    category: 'TEST',
    subcategory: 'SUB',
    tags: [],
    content: '<p>body</p>',
    createdAt: now,
    updatedAt: now,
    baseSeq: 0,
    ...overrides
  };
}

export async function push(server, body) {
  const res = await fetch(`${server.base}/api/sync/push`, {
    method: 'POST',
    headers: server.headers,
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

export async function pull(server, since, limit = 100) {
  const res = await fetch(`${server.base}/api/sync/pull?since=${since}&limit=${limit}`, {
    headers: server.headers
  });
  return { status: res.status, body: await res.json() };
}
