import sqlite3, sys

con = sqlite3.connect(':memory:')
con.executescript('''
CREATE TABLE notes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL,
  subcategory TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE folders (
  category TEXT NOT NULL, subcategory TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (category, subcategory)
);
''')

NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
con.executescript(f'''
CREATE TABLE sync_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  op TEXT NOT NULL, changed_at TEXT NOT NULL
);
CREATE INDEX idx_sync_changes_entity ON sync_changes(entity, entity_id, seq DESC);
CREATE TRIGGER sync_notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO sync_changes(entity,entity_id,op,changed_at) VALUES ('note',NEW.id,'upsert',{NOW});
END;
CREATE TRIGGER sync_notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO sync_changes(entity,entity_id,op,changed_at) VALUES ('note',NEW.id,'upsert',{NOW});
END;
CREATE TRIGGER sync_notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO sync_changes(entity,entity_id,op,changed_at) VALUES ('note',OLD.id,'delete',{NOW});
END;
CREATE TRIGGER sync_folders_ai AFTER INSERT ON folders BEGIN
  INSERT INTO sync_changes(entity,entity_id,op,changed_at) VALUES ('folder',NEW.category||'/'||NEW.subcategory,'upsert',{NOW});
END;
CREATE TRIGGER sync_folders_ad AFTER DELETE ON folders BEGIN
  INSERT INTO sync_changes(entity,entity_id,op,changed_at) VALUES ('folder',OLD.category||'/'||OLD.subcategory,'delete',{NOW});
END;
''')

# 场景：新建2条、其中1条连改2次、建文件夹、删1条
con.execute("INSERT INTO notes(id,title,category,subcategory,content) VALUES ('n1','A','Cat','Sub','v1')")
con.execute("INSERT INTO notes(id,title,category,subcategory,content) VALUES ('n2','B','Cat','Sub','v1')")
con.execute("UPDATE notes SET content='v2' WHERE id='n1'")
con.execute("UPDATE notes SET content='v3' WHERE id='n1'")
con.execute("INSERT INTO folders(category,subcategory) VALUES ('Cat','Sub')")
con.execute("DELETE FROM notes WHERE id='n2'")
con.commit()

print("原始变更流:")
for r in con.execute("SELECT seq,entity,entity_id,op FROM sync_changes ORDER BY seq"):
    print("  ", r)

print("\n格式化时间戳:", con.execute("SELECT changed_at FROM sync_changes LIMIT 1").fetchone()[0])

PULL = '''
WITH latest AS (
  SELECT entity_id, MAX(seq) AS max_seq FROM sync_changes
  WHERE entity = 'note' AND seq > ? GROUP BY entity_id ORDER BY max_seq ASC LIMIT ?
)
SELECT c.entity_id, c.op, c.seq FROM sync_changes c
JOIN latest l ON l.entity_id=c.entity_id AND l.max_seq=c.seq
ORDER BY c.seq ASC
'''

rows = con.execute(PULL, (0, 50)).fetchall()
print("\npull(since=0, limit=50):")
for r in rows:
    print("  ", r)

note_rows = [r for r in rows if r[0] in ('n1','n2')]
assert not [r for r in rows if '/' in r[0]], f"folder 变更不应进入 note 变更流: {rows}"
ids = [r[0] for r in note_rows]
assert len(set(ids)) == len(ids), f"同一笔记在窗口内重复出现: {ids}"
n1 = [r for r in note_rows if r[0] == 'n1']
n2 = [r for r in note_rows if r[0] == 'n2']
assert len(n1) == 1 and n1[0][1] == 'upsert', f"n1 应只出现一次且为 upsert: {n1}"
assert len(n2) == 1 and n2[0][1] == 'delete', f"n2 应为 delete 墓碑: {n2}"
print("\n[OK] 三次修改的 n1 被折叠成一条 upsert，删除的 n2 变成 delete 墓碑")

# 分页：limit=1 应返回最早1条，且还有剩余
page = con.execute(PULL, (0, 1)).fetchall()
print("\npull(since=0, limit=1):", page)
last = page[-1][2]
more = con.execute("SELECT 1 FROM sync_changes WHERE seq > ? LIMIT 1", (last,)).fetchone()
assert more, "应报告 hasMore"

# 续拉
page2 = con.execute(PULL, (last, 50)).fetchall()
print(f"pull(since={last}, limit=50):", page2)
assert not [r for r in page2 if r[0] in [p[0] for p in page]], "续拉重复返回了已拉过的记录"
print("[OK] 分页游标不重不漏")

# 增量：只拉 since=最新 之后
maxseq = con.execute("SELECT MAX(seq) FROM sync_changes").fetchone()[0]
con.execute("INSERT INTO notes(id,title,category,subcategory) VALUES ('n3','C','Cat','Sub')")
con.commit()
delta = con.execute(PULL, (maxseq, 50)).fetchall()
print("\n新增1条后的增量拉取:", delta)
assert len(delta) == 1 and delta[0][0] == 'n3', f"增量应只含 n3: {delta}"
print("[OK] 增量拉取只返回差异数据")

# 乐观锁判定
cur = dict(con.execute(
    "SELECT entity_id, MAX(seq) FROM sync_changes WHERE entity='note' GROUP BY entity_id").fetchall())
con.execute("UPDATE notes SET content='server-change' WHERE id='n1'")
con.commit()
cur2 = con.execute(
    "SELECT MAX(seq) FROM sync_changes WHERE entity='note' AND entity_id='n1'").fetchone()[0]
print(f"\nn1 服务端最新 seq：改前 {cur.get('n1')} → 改后 {cur2}")
assert cur2 > cur['n1'], "UPDATE 应推进 seq"
print("[OK] baseSeq 比较可以检测出并发写")

print("\n全部通过")
