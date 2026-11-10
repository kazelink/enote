import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, note, push, pull } from './helpers.mjs';

describe('同步协议（push / pull）', () => {
  let server;

  before(async () => { server = await startServer(); });
  after(async () => { await server.stop(); });

  it('首次推送落库并分配 seq', async () => {
    const n = note({ category: 'P1', title: '首次' });
    const { status, body } = await push(server, { notes: [n] });

    assert.equal(status, 200);
    assert.equal(body.applied, 1);
    assert.equal(body.conflicts.length, 0);

    const seq = body.notes.find((x) => x.id === n.id)?.seq;
    assert.ok(seq > 0, '应返回该笔记的 seq');

    const { body: page } = await pull(server, 0);
    const stored = page.notes.find((x) => x.id === n.id);
    assert.equal(stored?.title, '首次');
  });

  it('同一份内容重复推送视为幂等，不产生冲突副本', async () => {
    const n = note({ category: 'P2', title: '幂等' });
    const first = await push(server, { notes: [n] });
    const seq = first.body.notes.find((x) => x.id === n.id).seq;

    // 模拟「服务端已落库、但响应在路上丢了，客户端重推」
    const again = await push(server, { notes: [{ ...n, baseSeq: 0 }] });

    assert.equal(again.body.applied, 0, '重推不应重复入库');
    assert.equal(again.body.conflicts.length, 0, '相同内容不应判为冲突');
    assert.equal(again.body.confirmed?.length ?? again.body.notes.length, 1);

    const { body: page } = await pull(server, 0);
    const copies = page.notes.filter((x) => x.category === 'P2');
    assert.equal(copies.length, 1, '不应多出冲突副本');
    assert.equal(copies[0].id, n.id);
    assert.ok(seq > 0);
  });

  it('baseSeq 落后且内容不同 → 客户端版本占原 id，服务端旧版存为副本', async () => {
    const n = note({ category: 'P3', title: '原始' });
    const first = await push(server, { notes: [n] });
    const seq = first.body.notes.find((x) => x.id === n.id).seq;

    const updated = { ...n, title: '客户端改的', content: '<p>client</p>', updatedAt: new Date(Date.now() + 1000).toISOString(), baseSeq: 0 };
    const { body } = await push(server, { notes: [updated] });

    assert.equal(body.conflicts.length, 1);
    assert.equal(body.conflicts[0].kind, 'update');
    assert.ok(body.conflicts[0].copyId, '应给出副本 id');

    const { body: page } = await pull(server, 0);
    const group = page.notes.filter((x) => x.category === 'P3');
    assert.equal(group.length, 2, '原笔记 + 冲突副本');
    assert.equal(group.find((x) => x.id === n.id)?.title, '客户端改的');
    assert.ok(group.some((x) => x.title.includes('冲突副本')), '服务端旧版应存为副本');
    assert.ok(seq > 0);
  });

  it('一条坏笔记被单独拒绝，同批其它笔记照常入库', async () => {
    const good1 = note({ category: 'P4', title: '好1' });
    const tooLong = note({ category: 'P4', title: '超长', content: `<p>${'x'.repeat(600_000)}</p>` });
    const good2 = note({ category: 'P4', title: '好2' });

    const { status, body } = await push(server, { notes: [good1, tooLong, good2] });

    assert.equal(status, 200, '不应整批失败');
    assert.equal(body.applied, 2);
    assert.equal(body.rejected.length, 1);
    assert.equal(body.rejected[0].id, tooLong.id);
    assert.equal(body.rejected[0].status, 413);

    const { body: page } = await pull(server, 0);
    const stored = page.notes.filter((x) => x.category === 'P4').map((x) => x.title).sort();
    assert.deepEqual(stored, ['好1', '好2']);
  });

  it('整批都被拒绝时返回 200 而不是 500（空 IN 列表边界）', async () => {
    const bad = [
      note({ content: 'y'.repeat(600_000) }),
      { id: 'not-a-uuid', title: 'x', category: 'C', subcategory: 'S', content: 'x' }
    ];

    const { status, body } = await push(server, { notes: bad });

    assert.equal(status, 200);
    assert.equal(body.applied, 0);
    assert.equal(body.rejected.length, 2);
    assert.equal(body.error, undefined);
  });

  it('删除冲突：服务端有更新版本时保留服务端数据并回传', async () => {
    const n = note({ category: 'P5', title: '删冲突' });
    await push(server, { notes: [n] });

    // 客户端再改一次（服务端 seq 前进），但客户端仍拿旧 baseSeq 去删
    await push(server, { notes: [{ ...n, title: '服务端新版本', updatedAt: new Date(Date.now() + 2000).toISOString(), baseSeq: 0 }] });

    const { body } = await push(server, { deletions: [{ id: n.id, baseSeq: 1 }] });

    assert.equal(body.deleted, 0, '冲突时不应删除');
    assert.equal(body.conflicts.length, 1);
    assert.equal(body.conflicts[0].kind, 'delete');
    assert.ok(body.conflicts[0].note, '应回传服务端版本供客户端恢复');
    assert.equal(body.conflicts[0].note.id, n.id);
  });

  it('删除时 baseSeq 匹配则正常删除并返回 deletedIds', async () => {
    const n = note({ category: 'P6', title: '删正常' });
    const first = await push(server, { notes: [n] });
    const seq = first.body.notes.find((x) => x.id === n.id).seq;

    const { body } = await push(server, { deletions: [{ id: n.id, baseSeq: seq }] });

    assert.equal(body.deleted, 1);
    assert.deepEqual(body.deletedIds, [n.id]);

    const { body: page } = await pull(server, 0);
    assert.equal(page.notes.some((x) => x.id === n.id), false);
    assert.ok(page.deleted.some((d) => d.id === n.id), '删除应出现在变更流里');
  });

  it('服务端已删除该笔记时，再提交删除应确认成功而不是返回冲突', async () => {
    const n = note({ category: 'P8', title: '已被别的设备删掉' });
    const first = await push(server, { notes: [n] });
    const seq = first.body.notes.find((x) => x.id === n.id).seq;

    // 设备 A 先删并同步成功
    const delA = await push(server, { deletions: [{ id: n.id, baseSeq: seq }] });
    assert.equal(delA.body.deleted, 1);

    // 设备 B 离线时也要删同一篇，拿的是旧 baseSeq（服务端 seq 已前进、笔记已不存在）
    const delB = await push(server, { deletions: [{ id: n.id, baseSeq: 0 }] });

    assert.equal(delB.body.conflicts.length, 0, '服务端已无此笔记，不应判为冲突');
    assert.equal(delB.body.deleted, 1, '应确认为删除成功');
    assert.deepEqual(delB.body.deletedIds, [n.id], '要回传 id 让客户端清掉删除队列');
  });

  it('游标超过 latestSeq 时返回 fullReset，不会永久卡死', async () => {
    const { body: far } = await pull(server, 999_999);
    assert.equal(far.fullReset, true);
    assert.equal(far.nextSeq, 0);

    const { body: normal } = await pull(server, 0);
    assert.equal(normal.fullReset, false);
    assert.ok(Array.isArray(normal.notes));
  });

  it('分页：hasMore 与 nextSeq 能逐页走完', async () => {
    const batch = Array.from({ length: 6 }, (_, i) => note({ category: 'P7', title: `分页${i}` }));
    await push(server, { notes: batch });

    const seen = [];
    let cursor = 0;
    for (let page = 0; page < 20; page++) {
      const { body } = await pull(server, cursor, 2);
      seen.push(...body.notes.map((n) => n.id));
      if (body.nextSeq > cursor) cursor = body.nextSeq;
      if (!body.hasMore) break;
    }

    for (const n of batch) assert.ok(seen.includes(n.id), `应拉到 ${n.title}`);
  });
});
