import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, note, push, pull } from './helpers.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

describe('维护任务与备份', () => {
  let server;
  let raw;

  before(async () => {
    server = await startServer();
    raw = new Database(server.dbPath);
    raw.pragma('busy_timeout = 5000');
  });

  after(async () => {
    try { raw.close(); } catch { /* 忽略 */ }
    await server.stop();
  });

  it('清理同步记录时保留每条笔记的最新一行，新设备仍能全量拉取', async () => {
    const notes = ['旧1', '旧2', '新'].map((t) => note({ category: 'GC', title: t }));
    await push(server, { notes });

    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    // 把三篇笔记的变更记录都改成 40 天前，其中第一篇再补一条更早的被取代记录
    raw.prepare('UPDATE sync_changes SET changed_at = ? WHERE entity = ?').run(old, 'note');

    const maxSeq = raw.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM sync_changes').get().s;
    raw.prepare(
      "INSERT INTO sync_changes (entity, entity_id, op, seq, changed_at) VALUES ('note', ?, 'upsert', ?, ?)"
    ).run(notes[0].id, maxSeq + 1, old);

    const before = raw.prepare('SELECT COUNT(*) AS n FROM sync_changes WHERE entity = ?').get('note').n;
    assert.ok(before >= 4);

    // 用服务端自己的实现来清理（不复制 SQL，避免测试与实现脱节）
    process.env.DB_PATH = server.dbPath;
    const { pruneSyncChanges } = await import('../apps/server/lib/sync.js');
    await pruneSyncChanges({ retainDays: 30 });

    const rows = raw.prepare(
      "SELECT entity_id, COUNT(*) AS n FROM sync_changes WHERE entity = 'note' GROUP BY entity_id"
    ).all();
    for (const n of notes) {
      const row = rows.find((r) => r.entity_id === n.id);
      assert.ok(row, `${n.title} 的变更行不能被清空`);
      assert.equal(row.n, 1, `${n.title} 只保留最新一行`);
    }

    const { body } = await pull(server, 0);
    const pulledIds = new Set(body.notes.map((n) => n.id));
    for (const n of notes) {
      assert.ok(pulledIds.has(n.id), `新设备应能拉到 ${n.title}`);
    }
  });

  it('备份导出 → 恢复：删除的笔记能回来', async () => {
    const keep = note({ category: 'BK', title: '保留' });
    const gone = note({ category: 'BK', title: '会被删' });
    await push(server, { notes: [keep, gone] });

    const exportRes = await fetch(`${server.base}/api/backup/export`, { headers: server.headers });
    assert.equal(exportRes.status, 200);
    const backup = JSON.parse(await exportRes.text());
    assert.ok(Array.isArray(backup.notes));

    const seqMap = new Map();
    for (const item of (await pull(server, 0)).body.notes) seqMap.set(item.id, item.seq);
    await push(server, { deletions: [{ id: gone.id, baseSeq: seqMap.get(gone.id) || 0 }] });

    const afterDelete = (await pull(server, 0)).body.notes;
    assert.equal(afterDelete.some((n) => n.id === gone.id), false);

    const restoreRes = await fetch(`${server.base}/api/backup/restore`, {
      method: 'POST',
      headers: server.headers,
      body: JSON.stringify(backup)
    });
    assert.equal(restoreRes.status, 200);
    const result = await restoreRes.json();
    assert.equal(result.success, true);

    const afterRestore = (await pull(server, 0)).body.notes;
    assert.ok(afterRestore.some((n) => n.id === gone.id), '恢复后笔记应回来');
    assert.ok(afterRestore.some((n) => n.id === keep.id));
  });

  it('恢复后同步序号继续前进，客户端不会卡在旧游标', async () => {
    const state = await (await fetch(`${server.base}/api/sync/state`, { headers: server.headers })).json();
    const latest = state.latestSeq;

    const { body } = await pull(server, latest);
    assert.equal(body.fullReset, false, '正常游标不应触发全量重置');
    assert.ok(body.nextSeq >= 0);
  });
});
