# eNote 三端同步与打包设计

> 目标：云端、电脑、手机各自持有本地数据，只传输差异部分；界面与当前使用方式保持一致。

## 1. 现状与结论

eNote 目前是**纯在线 B/S 架构**：浏览器打开页面，所有读写都直接打服务端 API，服务端 SQLite 是唯一数据源。

要达成"三端各有本地库 + 增量同步"，需要新增三块能力：

| 能力 | 现状 | 要做什么 |
|---|---|---|
| 服务端增量同步 | 无 | 变更流 + 游标拉取（**已完成**，见第 4 节） |
| 客户端本地库 | 无（只有 `fetch`） | IndexedDB 存储层 + 本地优先读写 |
| 客户端同步引擎 | 无 | pull / push 编排、冲突处理、离线队列 |
| 桌面 exe | 无 | Electron 打包 |
| 手机 App | 无 | Capacitor 打包 |

## 2. 一个关键取舍：本地库用什么

| 方案 | 电脑 | 手机 | 代码量 | 结论 |
|---|---|---|---|---|
| **IndexedDB** | Electron WebView | Capacitor WebView | **一套** | ✅ 采用 |
| 原生 SQLite | better-sqlite3 | capacitor-sqlite | 两套 + 双份同步逻辑 | ❌ 暂不采用 |

三端的 WebView 都支持 IndexedDB，所以本地库用 IndexedDB 可以让**同一份前端代码跑在浏览器、exe、手机 App 里**。缺点是失去 SQLite 的 FTS5 全文检索，本地搜索需在 JS 里做——个人笔记量级（数千条以内）完全够用。

> 如果将来本地数据涨到几万条或需要复杂查询，再换 WASM SQLite 存进 IndexedDB，表层接口不变。

## 3. 数据分层

```
云端 enote 服务（Node + SQLite）
        ↕  /api/sync/pull  /api/sync/push   （只传差异）
┌───────────────┴───────────────┐
电脑 exe（Electron）        手机 App（Capacitor）
本地库 IndexedDB            本地库 IndexedDB
```

- **云端是权威源**，但客户端**不等它**——写入先落本地，立刻返回，后台再推。
- 断网可正常读写；网络恢复后自动补推、补拉。

## 4. 同步协议（已实现）

### 4.1 版本号：为什么不复用 updated_at

`notes.updated_at` 存的是**用户选的笔记日期**（`save.js` 里写成 `${date}T00:00:00.000Z`），精度只到天，语义上属于业务字段，不能当版本号。

因此新增一张**只追加**的变更流表，用其自增主键当全局游标：

```sql
CREATE TABLE sync_changes (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT    NOT NULL,   -- 'note' | 'folder'
  entity_id  TEXT    NOT NULL,
  op         TEXT    NOT NULL,   -- 'upsert' | 'delete'
  changed_at TEXT    NOT NULL
);
```

`seq` 严格单调递增、全局唯一，天然解决了"多端时钟不一致"的问题——**不需要比时间戳，只比序号**。

写入由触发器自动捕获（`notes` / `folders` 的 INSERT / UPDATE / DELETE 各一个），**现有业务代码一行没改**。触发器只往 `sync_changes` 插入，不回写原表，因此不会递归、不改变现有行为。

### 4.2 拉取

```
GET /api/sync/pull?since=<cursor>&limit=50
→ {
    notes:   [{ id, title, category, subcategory, tags, content, createdAt, updatedAt, seq }],
    deleted: [{ id, seq }],
    nextSeq, latestSeq, hasMore,
    folders: [...]          // 仅 since=0 时返回
  }
```

同一笔记在窗口内被改多次时，只取其**最大 seq** 那一次的状态（整体覆盖式应用，不传字段级 diff），避免协议复杂化。

`hasMore=true` 时客户端用 `nextSeq` 继续循环，直到拉完。

### 4.3 推送

```
POST /api/sync/push
{ notes: [{ id, ..., baseSeq }], deletions: [{ id, baseSeq }] }
→ { applied, deleted, conflicts, latestSeq }
```

`baseSeq` = 该记录在客户端上次同步时的 seq，即"我是在这个版本上改的"，属于乐观并发控制。

服务端比对当前最新 seq：

- `serverSeq <= baseSeq` → 无冲突，正常应用
- `serverSeq > baseSeq` → 期间别的设备改过 → **记为冲突**

冲突处理采用 **last-write-wins（客户端覆盖）**，同时把冲突项原样返回，供 UI 提示。这是 Joplin `handleConflictAction` 的简化版：Joplin 会额外生成"冲突副本"笔记保留双方内容，eNote 先做 LWW，后续可升级为副本策略（见第 7 节）。

推送内容在服务端一律过 `sanitizeContent()`，**不信任任何客户端提交的 HTML**。

### 4.4 附件

图片/视频在 `bucket` 文件系统里，`note_media` 仅作索引。做法：

- `GET /api/sync/media` → 返回全部 `media_key` 清单（轻量）
- 客户端对比本地已缓存 key，**只下载缺的**，走现有 `/img/:key`、`/video/:key`
- 本地存为 Blob 放进 IndexedDB，按 LRU 设上限淘汰

## 5. 本地库设计

```
IndexedDB: enote-local
  store notes     keyPath: id      索引: category, updatedAt, dirty
  store folders   keyPath: key
  store media     keyPath: key     { blob, size, accessedAt }
  store meta      keyPath: key     { lastSeq, deviceId, lastSyncAt }
```

读写流程：

1. **打开应用** → 读 `meta.lastSeq` → 触发一次 pull（有网时）
2. **用户编辑** → 写本地 `notes`，置 `dirty=1`，**立即返回**（不等网络）
3. **后台同步** → 取所有 `dirty=1` 的记录 push → 成功后清 dirty、更新 `lastSeq`
4. **定时** → 每 30s / 窗口聚焦 / 网络恢复 时各触发一次 pull
5. **冲突** → 保留本地版本，同时把服务端版本存为一条 `conflict` 记录供查看

首次启动（`lastSeq=0`）走全量分页拉取，按 `hasMore` 循环。

## 6. 打包

### 6.1 桌面 exe（Tauri）

采用 Tauri 而非 Electron：体积 5–10MB（Electron 约 80–100MB），用系统自带 WebView2，不捆绑 Chromium。

- **不捆绑 Node**。前端静态资源直接打进安装包，Tauri 只提供窗口 + WebView2。
- 因为本地库在 IndexedDB、渲染走 `public/shared/render.js`，桌面端与浏览器端是**同一套代码**，无需为桌面单独维护分支。
- 这是"一次修改、三端复用"的关键：如果改成捆绑 Node（sidecar），手机端就跑不了，反而要维护两套。
- 前置条件：Rust 工具链 + MSVC（当前受阻，见第 9 节）。

### 6.2 手机 App（Capacitor）

- 前端资源打包进 App（而非指向远端 URL），配合本地库才能真正离线
- 需要 Android SDK + JDK 17 + Gradle
- 输出 apk，可分发给内部使用；上架 Google Play 需额外配置
- **iOS 必须在 macOS 上构建**，Windows 无法完成

## 7. 实施顺序

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 服务端变更流 + pull/push/media | ✅ 端到端 12 项测试通过 |
| 2 | 前端本地库 + 本地优先读写 | ✅ 浏览器实测通过 |
| 3 | 同步引擎（pull/push 编排、dirty 队列、冲突提示） | ✅ 双向实测通过 |
| 4 | Tauri 打包 exe | ⛔ 构建链受阻（MS CDN 不可达） |
| 5 | Capacitor 打包 apk | 待开始 |

### 已完成部分的实测记录

在真实 Chromium 中（playwright-cli）验证：

| 场景 | 结果 |
|---|---|
| 登录后建库 | IndexedDB `enote` v1，notes/folders/media/meta 四库齐全 |
| 服务端 → 本地 | 拉到 1 条笔记，`lastSeq=13`，`dirty=0` |
| 本地新建 → 服务端 | 通过 UI 保存，服务端笔记数 1→2，tags 正确为 `["离线","同步"]` |
| 本地删除 → 服务端 | 墓碑推送后归零，服务端 2→1 |
| **后端全部 503** | 侧栏仍显示"测试目录 1"，列表渲染出笔记标题与标签，**完全来自本地** |

修复的两个问题：

1. `auth.js` 的 `loginSuccess` 未启动同步引擎 —— 首次登录走的是 Auth 流程而不是 `App.init` 的已登录分支，导致同步引擎从不启动、本地库永不建立。已补 `_startLocalSync()`。
2. `App.init` 在首次渲染后才判定 `_localReady` —— 离线启动时侧栏会先发注定失败的请求。改为在 `loadView()` 之前读取 `meta.initialized`。

## 8. 明确的取舍与风险

1. **不做 CRDT**。个人笔记场景，LWW + 冲突提示足够；CRDT 复杂度高一个量级，收益不明显。
2. **不做字段级合并**。整条笔记覆盖，简单可预测。
3. **变更流会增长**。需要定期清理（建议保留 90 天）；清理后落后太多的客户端靠 `fullReset` 全量重拉。该路径已在响应里预留 `fullReset` 字段，尚未实现。
4. **folders 是 notes 的投影**。文件夹改名在客户端表现为"旧目录消失 + 新目录出现"，语义正确但不保留操作历史。
5. **AGPL-3.0**。本方案是参考 Joplin 的同步思路自研，未复制其代码；若将来直接引入 Joplin 代码，需评估开源义务。

## 9. 当前构建阻塞（Tauri 编译链）

| 依赖 | 状态 |
|---|---|
| Rust 工具链 | ✅ 已装（1.99.1，经清华镜像） |
| WebView2 | ✅ 系统已有 |
| Tauri CLI | ✅ 已装（npm） |
| **MSVC 编译器 + Windows SDK** | ⛔ **装不上** |

原因：`download.visualstudio.microsoft.com` 与 `aka.ms` 均连接超时，微软 CDN 没有可用的国内镜像；GitHub 与各 MSYS2 镜像路径也不通。Rust 本身不携带 Windows 导入库（`kernel32.lib` 等），所以 `rust-lld` 也无法替代。

**解除条件**：需要一个能访问微软 CDN 的网络环境，装 VS Build Tools 的 "C++ 生成工具 + Windows SDK" 工作负载（约 2–3 GB）。安装需管理员权限。

在此之前，代码本身可继续开发与在浏览器中验证——本地库、同步、渲染三条链路均已实测通过，不依赖编译。

