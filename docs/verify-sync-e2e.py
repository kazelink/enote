"""End-to-end check of the sync API against a running server.

Simulates two devices sharing one account:
  device A creates a note via the normal /api/save path
  -> device B pulls it (first sync, since=0)
  -> device B edits it and pushes
  -> device A pulls only the delta (since=<cursor>)
  -> device A deletes it, device B receives the tombstone
"""
import json
import time
import urllib.error
import urllib.request
import uuid

BASE = 'http://127.0.0.1:3100'


def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


# Wait for the server to accept connections.
for attempt in range(40):
    try:
        urllib.request.urlopen(BASE + '/', timeout=2)
        break
    except urllib.error.HTTPError:
        break
    except Exception:
        time.sleep(0.5)
else:
    raise SystemExit('服务没有启动')

status, login = call('POST', '/api/login', {'password': 'testpass'})
assert status == 200, f'登录失败: {status} {login}'
AUTH = {'X-Auth-Token': login['token'], 'X-Session-Nonce': login['nonce']}
print('[OK] 登录成功')

status, state = call('GET', '/api/sync/state', headers=AUTH)
assert status == 200, state
print(f"[OK] 初始状态: 笔记 {state['noteCount']} 条, 游标 {state['latestSeq']}")
start_cursor = state['latestSeq']

# --- device A: create a note through the ordinary save endpoint -------------
note_a = str(uuid.uuid4())
status, saved = call('POST', '/api/save', {
    'id': note_a,
    'title': '设备A创建的笔记',
    'category': '测试目录',
    'subcategory': '子目录',
    'tags': ['同步', '测试'],
    'content': '<p>来自设备A的内容</p>',
    'date': '2026-10-22',
}, AUTH)
assert status == 200, f'保存失败: {status} {saved}'
print(f'[OK] 设备A通过 /api/save 创建笔记 {note_a[:8]}…')

# --- device B: first sync ---------------------------------------------------
status, pull1 = call('GET', f'/api/sync/pull?since=0&limit=50', headers=AUTH)
assert status == 200, pull1
ids = [n['id'] for n in pull1['notes']]
assert note_a in ids, f'首次全量拉取应包含该笔记，实际: {ids}'
got = next(n for n in pull1['notes'] if n['id'] == note_a)
assert got['title'] == '设备A创建的笔记', got['title']
assert '同步' in got['tags'], got['tags']
assert '来自设备A' in got['content'], got['content']
assert pull1['folders'] is not None, '首次同步应返回目录树'
cursor_b = pull1['nextSeq']
print(f"[OK] 设备B首次同步拿到 {len(pull1['notes'])} 条笔记，游标推进到 {cursor_b}")

# --- device A: incremental pull must be empty ------------------------------
status, pull_noop = call('GET', f'/api/sync/pull?since={cursor_b}&limit=50', headers=AUTH)
assert status == 200, pull_noop
assert pull_noop['notes'] == [] and pull_noop['deleted'] == [], pull_noop
print('[OK] 无新改动时，增量拉取返回空（不重复下载全库）')

# --- device B: edit and push ----------------------------------------------
status, push1 = call('POST', '/api/sync/push', {
    'notes': [{
        'id': note_a,
        'title': '设备B改过的标题',
        'category': '测试目录',
        'subcategory': '子目录',
        'tags': ['同步'],
        'content': '<p>设备B追加的内容</p>',
        'createdAt': got['createdAt'],
        'updatedAt': '2026-10-22T00:00:00.000Z',
        'baseSeq': cursor_b,
    }]
}, AUTH)
assert status == 200, push1
assert push1['applied'] == 1, push1
assert push1['conflicts'] == [], f'基线一致时不应报冲突: {push1["conflicts"]}'
print(f'[OK] 设备B推送修改成功，服务端游标 {push1["latestSeq"]}')

# --- device A: pull only the delta -----------------------------------------
status, pull2 = call('GET', f'/api/sync/pull?since={cursor_b}&limit=50', headers=AUTH)
assert status == 200, pull2
assert len(pull2['notes']) == 1, f'增量应只含 1 条，实际 {len(pull2["notes"])}'
assert pull2['notes'][0]['title'] == '设备B改过的标题', pull2['notes'][0]['title']
print('[OK] 设备A增量拉取只拿到被改动的那 1 条')

# --- conflict detection ----------------------------------------------------
status, push_conflict = call('POST', '/api/sync/push', {
    'notes': [{
        'id': note_a,
        'title': '设备A基于旧版本改的',
        'category': '测试目录',
        'subcategory': '子目录',
        'tags': [],
        'content': '<p>旧基线</p>',
        'createdAt': got['createdAt'],
        'updatedAt': '2026-10-22T00:00:00.000Z',
        'baseSeq': cursor_b,
    }]
}, AUTH)
assert status == 200, push_conflict
assert len(push_conflict['conflicts']) == 1, f'应检测到 1 处冲突: {push_conflict}'
c0 = push_conflict['conflicts'][0]
assert c0['baseSeq'] == cursor_b and c0['serverSeq'] > cursor_b, c0
print(f"[OK] 并发写被识别为冲突 (baseSeq={c0['baseSeq']} < serverSeq={c0['serverSeq']})")

# --- delete propagates as a tombstone --------------------------------------
status, state2 = call('GET', '/api/sync/state', headers=AUTH)
cursor_before_delete = state2['latestSeq']

status, deleted = call('DELETE', f'/api/delete?id={note_a}', headers=AUTH)
assert status == 200, deleted
print('[OK] 设备B删除笔记')

status, pull3 = call('GET', f'/api/sync/pull?since={cursor_before_delete}&limit=50', headers=AUTH)
assert status == 200, pull3
assert any(d['id'] == note_a for d in pull3['deleted']), f'应收到删除墓碑: {pull3}'
print('[OK] 设备A收到删除墓碑')

# --- validation guard ------------------------------------------------------
status, bad = call('POST', '/api/sync/push', {'notes': [{'id': 'not-a-uuid', 'title': 'x'}]}, AUTH)
assert status == 400, f'非法 ID 应被拒绝: {status} {bad}'
print('[OK] 非法 ID 被拒绝')

status, unauthorized = call('GET', '/api/sync/pull?since=0')
assert unauthorized == 401 or status == 401, f'未登录应 401: {unauthorized}'
print('[OK] 未登录访问同步接口返回 401')

print('\n端到端同步全部通过')
