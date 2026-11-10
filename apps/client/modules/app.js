import { Utils, State, escapeHtml } from "./dom.js";
import { API, authHeaders, Nonce, Token, getApiBase, setApiBase, isDesktopShell } from "./api.js";
import { UI } from "./ui.js";
import { swalConfirm, swalAlert, swalPrompt } from "./swal.js";
import { Editor } from "./editor.js?v=5.8";
import { Auth } from "./auth.js";
import * as LocalDB from "./localdb.js";
import { startSyncEngine, SyncStatus, queueNoteDelete, syncNow } from "./sync.js";
import { hydrateMedia, pruneOrphanMedia, absolutizeMediaHtml } from "./media.js";
import { renderArchivePayload } from "../shared/render.js";

const MAX_RESTORE_FILE_BYTES = 100 * 1024 * 1024;
const STATUS_RESET_DELAY_MS = 2e3;
const TAG_PREVIEW_LIMIT = 5;
const STATE_KEYS = ["category", "subcategory", "note", "q", "tag"];

function nextFrame() { return new Promise(r => requestAnimationFrame(r)); }
function encodeInlineParam(val) { return encodeURIComponent(String(val ?? "")).replace(/'/g, "%27"); }
function byFolderNameKey(a, b) { return String(a || "").toLowerCase().localeCompare(String(b || "").toLowerCase()); }

function normalizeServerUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  value = value.replace(/\/+$/, "");
  try {
    new URL(value);
    return value;
  } catch {
    return null;
  }
}
function ensureLazyMedia(content) {
  const html = String(content || "").replace(/<img (?![^>]*\bloading=["']?lazy)/gi, '<img loading="lazy" ');
  return absolutizeMediaHtml(html);
}

function renderNotesHomeState() {
  return `
    <div class="notes-home-state" aria-label="Open notes from folders">
      <div class="notes-home-icon" aria-hidden="true">
        <svg class="notes-home-glyph" viewBox="0 0 24 24">
          <path d="M4.75 6.25h4.2c.37 0 .73.13 1.01.37l1.16.98c.14.11.31.18.49.18h6.64A1.75 1.75 0 0 1 20 9.53v7.22A1.75 1.75 0 0 1 18.25 18.5H5.75A1.75 1.75 0 0 1 4 16.75V8a1.75 1.75 0 0 1 1.75-1.75Z"></path>
          <path d="M8 11.25h8"></path><path d="M8 14.25h5"></path><path d="M6.75 10.75v3"></path>
        </svg>
      </div>
      <p>Open a folder to browse notes.</p>
    </div>`;
}

function renderLoading() {
  return '<div class="loading-hint">Loading...</div>';
}

function getRestoreInput() { return Utils.$("restore-input"); }
function clearRestoreInput() { const i = getRestoreInput(); if (i) i.value = ""; }

function getDownloadFilename(disposition) {
  const utf = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf?.[1]) { try { return decodeURIComponent(utf[1]); } catch { } }
  return disposition.match(/filename="([^"]+)"/i)?.[1] || `note-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

async function saveResponseToFile(res, filename) {
  if (typeof window.showSaveFilePicker === "function" && res.body) {
    const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: "JSON Backup", accept: { "application/json": [".json"] } }] });
    await res.body.pipeTo(await handle.createWritable());
    return;
  }
  const blobUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = blobUrl; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
}

function applyActiveView(views, activeView) {
  Object.entries(views).forEach(([name, el]) => el?.classList.toggle("active", name === activeView));
}

function normalizeState() {
  if (State.view === "backup") {
    Object.assign(State, { category: "", subcategory: "", note: "", q: "", tag: "", page: 1 });
    return;
  }
  STATE_KEYS.forEach(k => State[k] = String(State[k] || "").trim());
  State.page = Number.isFinite(State.page) && State.page > 0 ? State.page : 1;

  if (!State.category) {
    State.subcategory = "";
    State.view = State.note ? "note" : (State.view === "list" || State.q || State.tag ? "list" : "index");
    if (State.view === "index") State.q = State.tag = "";
  } else if (!State.subcategory) {
    State.view = State.note ? "note" : "category";
  } else {
    State.view = State.note ? "note" : "list";
  }
}

function syncStateFromLocation() {
  const p = new URLSearchParams(location.search);
  STATE_KEYS.forEach(k => State[k] = p.get(k) || "");
  State.page = parseInt(p.get("page") || "1", 10);
  State.view = ["index", "category", "list", "note", "backup"].includes(p.get("view")) ? p.get("view") : "index";
  normalizeState();
}

function buildLocationSearch() {
  const p = new URLSearchParams();
  if (State.view !== "index") p.set("view", State.view);
  STATE_KEYS.forEach(k => State[k] && p.set(k, State[k]));
  if (State.page > 1) p.set("page", String(State.page));
  const query = p.toString();
  const path = location.pathname || "/";
  return query ? `${path}?${query}` : path;
}

function resetStatusLater(statusKind) {
  setTimeout(() => { if (statusKind !== "err" || !App._restoreInFlight) UI.setStatus(""); }, STATUS_RESET_DELAY_MS);
}

async function withLoading(fn, errorTitle = null, errorFallback = "Operation failed.") {
  UI.setStatus("loading");
  try {
    const res = await fn();
    UI.setStatus("ok"); resetStatusLater("ok");
    return res;
  } catch (e) {
    UI.setStatus("err"); resetStatusLater("err");
    if (errorTitle) swalAlert(errorTitle, e?.message || errorFallback, "error");
  }
}

const COLLAPSE_STORAGE_KEY = "enote_collapsed_categories";

const App = {
  _views: {}, _popstateHandler: null, _restoreInFlight: false, _searchPanelOpen: false, _folderTreeCache: null, _tagCloudCache: null, _tagCloudExpanded: false, _tagCloudPanelCollapsed: true, _collapsedCategories: new Set(), _collapsedStateLoaded: false, _folderPanelCollapsed: false, _currentNote: null, _currentNoteFresh: false, _notePathHint: null, _treeContextState: { scope: "root", category: "" }, _lastFolderTreeHtml: null, _lastTagCloudHtml: null, _loadSeq: 0, _localRowsCache: null, _localRowsRev: -1, _refreshTimer: null,

  _resetListContent() {
    ["home-entry-list", "category-entry-list", "entry-list"].forEach(id => {
      const el = Utils.$(id);
      if (!el) return;
      if (el.children.length === 0) {
        el.innerHTML = id === "home-entry-list" ? renderNotesHomeState() : renderLoading();
      }
      el.classList.remove("is-updating");
      const pg = el.closest(".view-container")?.querySelector("[data-pagination]");
      if (pg) pg.style.display = "none";
    });
  },
  _loadCollapsedState() {
    try {
      const arr = JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY));
      if (Array.isArray(arr)) { this._collapsedCategories = new Set(arr); this._collapsedStateLoaded = true; }
    } catch { }
  },
  _saveCollapsedState() {
    try { localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...this._collapsedCategories])); } catch { }
  },

  async _startLocalSync() {
    if (this._syncStarted) return;
    this._syncStarted = true;

    await LocalDB.migrateTombstones().catch(() => {});
    startSyncEngine();
    this._renderSyncBadge(SyncStatus);

    if (!this._dataChangedBound) {
      this._dataChangedBound = true;
      window.addEventListener("enote:data-changed", () => {
        this._invalidateSidebarCaches();
        if (Editor.wrapper && Editor.wrapper.style.display !== "none") return;
        this.loadView({ quiet: true }).catch(() => {});
      });
    }

    SyncStatus.on((s) => {
      this._renderSyncBadge(s);

      if (s.state !== "idle" || this._localReady) return;
      this._localReady = true;
      this._invalidateSidebarCaches();
      this.loadView({ quiet: true }).catch(() => {});

      pruneOrphanMedia().catch(() => {});
    });
  },

  _renderSyncBadge(s) {
    const el = Utils.$("sync-stat");
    if (!el) return;

    clearTimeout(this._syncBadgeHideTimer);
    clearTimeout(this._syncBadgeShowTimer);
    el.title = "";

    const pending = Number(s.pending) || 0;
    const rejected = Array.isArray(s.rejectedIds) ? s.rejectedIds.length : 0;

    if (s.state === "idle" && !s.lastSyncAt) {
      el.textContent = pending ? `待上传 ${pending}` : "";
      el.className = pending ? "sync-stat active" : "sync-stat";
      return;
    }

    if (s.state === "idle") {
      if (pending) {
        el.textContent = `待上传 ${pending}`;
        el.className = "sync-stat active";
      } else if (rejected) {
        // 被服务端拒绝的笔记已隔离在本地，正文没丢，但要让人知道没同步上去。
        el.textContent = `${rejected} 条未同步`;
        el.className = "sync-stat active warn";
        el.title = "有笔记被服务器拒绝，打开后重新保存即可再次尝试";
      } else if (s.didWork) {
        el.textContent = "已同步";
        el.className = "sync-stat active success";
        this._syncBadgeHideTimer = setTimeout(() => {
          el.textContent = "";
          el.className = "sync-stat";
        }, STATUS_RESET_DELAY_MS);
      } else {
        el.textContent = "";
        el.className = "sync-stat";
      }
    } else if (s.state === "syncing") {
      this._syncBadgeShowTimer = setTimeout(() => {
        el.textContent = "同步中";
        el.className = "sync-stat active";
      }, 400);
    } else if (s.state === "offline") {
      el.textContent = "离线 · 本地可用";
      el.className = "sync-stat active warn";
    } else if (s.state === "error") {
      el.textContent = "同步失败";
      el.className = "sync-stat active error";
      el.title = s.lastError ? `同步失败：${s.lastError}` : "同步失败，稍后自动重试";
    } else {
      el.textContent = "需重新登录";
      el.className = "sync-stat active warn";
      el.title = "登录状态已失效，请重新输入密码";
    }
  },

  async _ensureServerAddress() {
    if (!isDesktopShell() || getApiBase()) return true;

    for (let attempt = 0; attempt < 5; attempt++) {
      const entered = await swalPrompt(
        "Server Address",
        "Enter the eNote server URL",
        ""
      );

      if (!entered) continue;

      const normalized = normalizeServerUrl(entered);
      if (!normalized) continue;

      setApiBase(normalized);
      return true;
    }

    return false;
  },

  async init() {
    try {
      Auth.init(); Editor.init();

      const dialogLayer = document.createElement("style");
      dialogLayer.textContent = ".swal2-container{z-index:10000!important}";
      document.head.appendChild(dialogLayer);

      Editor.bindSuggestion(Utils.$("backup-category"), "category");
      this._loadCollapsedState();['index', 'category', 'list', 'note', 'backup'].forEach(v => this._views[v] = Utils.$(`v-${v}`));
      window.App = this;
      this._setupDocumentListeners();
      this._setupTreeContextMenu();
      this._disableNativeContextMenu();
      UI.initGlobalEvents();

      document.body.classList.add("ready");

      await this._ensureServerAddress();
      this._renderAuthServerAddress();

      if (Nonce.get() && Token.get()) {
        // 旧版本的墓碑要先迁到删除队列并清出主表，否则会既占空间又被当正常数据读。
        await LocalDB.migrateTombstones().catch(() => {});
        this._localReady = (await LocalDB.readMeta("initialized", 0)) === 1;
        this._startLocalSync();
        await this.loadView();
      } else {
        Nonce.clear();
        Token.clear();
        UI.showAuth();
      }
      if (!this._popstateHandler) window.addEventListener("popstate", (this._popstateHandler = () => this.loadView()));
    } catch (e) {
      console.error("App init failed:", e);
      try { UI.showAuth(); } catch (_) {}
      const msg = Utils.$("auth-messages");
      if (msg) msg.innerHTML = `<div class="auth-err">INIT ERROR: ${String(e?.message || e).replace(/[<>]/g, '')}</div>`;
    } finally {
      document.body.classList.add("ready");
    }
  },

  async route(nextState, options = {}) {
    if (!await Editor.close()) return;
    this.closeTreeContextMenu();
    Object.assign(State, nextState);
    normalizeState();
    history.pushState(null, "", buildLocationSearch());
    this.loadView(options);
  },

  async loadView(options = {}) {
    const seq = ++this._loadSeq;
    if (!options.quiet && !options.pageTurn) this._resetListContent();
    if (options.pageTurn) this._setPaginationBusy();
    syncStateFromLocation();
    if (State.view !== "note") this._currentNote = this._notePathHint = null;

    applyActiveView(this._views, State.view);
    UI.renderBreadcrumb(this._breadcrumbContext());

    const backBtn = Utils.$("btn-header-back");
    if (backBtn) {
      backBtn.classList.toggle("visible", State.view !== "index");
      backBtn.disabled = State.view === "index";
    }

    const backupFab = Utils.$("btn-backup");
    if (backupFab) backupFab.classList.toggle("visible", State.view === "index");

    const input = Utils.$("note-search");
    if (input) input.value = State.q || "";
    const resetSearch = Utils.$("search-reset");
    if (resetSearch) resetSearch.style.display = State.q || State.tag ? "inline-flex" : "none";

    Utils.$("btn-search-toggle")?.classList.toggle("active", this._searchPanelOpen || !!State.q);
    Utils.$("global-note-tools")?.classList.toggle("active", State.view !== "backup" && (this._searchPanelOpen || !!State.q));

    if (State.view === "note") {
      const el = Utils.$("note-detail");
      const id = String(State.note || "").trim();
      if (el) {
        if (this._currentNote?.id === id) {
          el.innerHTML = this._renderNoteDetail(this._currentNote);
          hydrateMedia(el).catch(() => {});
        } else {
          el.innerHTML = renderLoading();
        }
      }
    }

    if (State.view === "backup") {
      try {
        await this._loadFolderTree();
      } catch (e) {
        console.error("Folder tree load failed:", e);
      }
      return;
    }

    try {
      await Promise.all([
        this._loadFolderTree(),
        this._loadTagCloud().catch(e => { console.error(e); const t = Utils.$("tag-cloud"); if (t) t.innerHTML = '<div class="tag-cloud-empty">Tags unavailable.</div>'; })
      ]);

      if (State.view === "index") {
        const el = Utils.$("home-entry-list");
        if (el) el.innerHTML = renderNotesHomeState();
      } else if (State.view === "category" || State.view === "list") {
        await this._loadNoteCollection({
          listId: State.view === "category" ? "category-entry-list" : "entry-list",
          params: { category: State.category, subcategory: State.view === "category" ? "" : State.subcategory, q: State.q, tag: State.tag, page: State.page },
          seq
        });
      } else if (State.view === "note") {
        await this._loadNote();
      }
    } catch (e) {
      this._clearPaginationBusy();
      if (e?.code === "UNAUTHORIZED") return;
      console.error("View load failed:", e);
      UI.setStatus("err");
      resetStatusLater("err");
    }
  },

  async _loadNoteCollection({ listId, params = {}, seq }) {
    const el = Utils.$(listId);
    if (!el) return;
    const viewEl = el.closest(".view-container");
    if (!el.children.length) el.innerHTML = renderLoading();
    el.classList.add("is-updating");
    try {
      if (!this._localReady && (await LocalDB.readMeta("initialized", 0)) === 1) {
        this._localReady = true;
      }
      const html = this._localReady
        ? await this._renderLocalList(params)
        : await API.html("list", params);
      if (seq !== undefined && seq !== this._loadSeq) return;
      el.innerHTML = html;
      this._clearPaginationBusy(el);
      const pgData = viewEl?.querySelector(".pg-data");
      State.data.totalPg = parseInt(pgData?.dataset.total, 10) || 1;
      const shownPage = parseInt(pgData?.dataset.page, 10);
      if (Number.isFinite(shownPage) && shownPage > 0) State.page = shownPage;
    } catch (e) {
      this._clearPaginationBusy(el);
      throw e;
    }
  },

  async _renderLocalList(params = {}) {
    const page = Number(params.page) || 1;
    const size = Number(params.size) || 10;

    const rows = await this._localRows();
    const filtered = LocalDB.queryNotes(rows, {
      category: params.category || "",
      subcategory: params.subcategory || "",
      q: params.q || "",
      tag: params.tag || ""
    });
    const result = LocalDB.paginate(LocalDB.sortNotes(filtered), page, size);

    return renderArchivePayload({
      notes: result.notes,
      page: result.page,
      totalPages: result.totalPages,
      hasFolderScope: !!(params.category && params.subcategory),
      hasAnyFilter: !!String(params.q || "").trim() || !!String(params.tag || "").trim()
    });
  },

  _localRows() {
    // 只在本地库真的被写过之后才重读。以前是在每次 loadView 开头无条件清空，
    // 于是切目录、翻页、开关笔记都要 getAll() 一遍全库（含所有正文）。
    const revision = LocalDB.notesRevision();
    if (!this._localRowsCache || this._localRowsRev !== revision) {
      this._localRowsRev = revision;
      this._localRowsCache = LocalDB.allNotes().catch((e) => {
        this._localRowsCache = null;
        this._localRowsRev = -1;
        throw e;
      });
    }
    return this._localRowsCache;
  },

  async _localFolderTree() {
    const rows = await this._localRows();
    const cats = new Map();

    for (const n of rows) {
      if (n._deleted || !n.category) continue;

      let cat = cats.get(n.category);
      if (!cat) {
        cat = { category: n.category, count: 0, updated_at: "", subfolders: new Map() };
        cats.set(n.category, cat);
      }
      cat.count += 1;
      if (String(n.updatedAt || "") > cat.updated_at) cat.updated_at = n.updatedAt || "";

      if (n.subcategory) {
        let sub = cat.subfolders.get(n.subcategory);
        if (!sub) {
          sub = { category: n.category, subcategory: n.subcategory, count: 0, updated_at: "" };
          cat.subfolders.set(n.subcategory, sub);
        }
        sub.count += 1;
        if (String(n.updatedAt || "") > sub.updated_at) sub.updated_at = n.updatedAt || "";
      }
    }

    return [...cats.values()].map((c) => ({
      category: c.category,
      count: c.count,
      updated_at: c.updated_at,
      subfolders: [...c.subfolders.values()]
    }));
  },

  _normalizeFolderTree(tree) {
    if (!Array.isArray(tree)) return [];

    return tree
      .map((row) => ({
        ...row,
        subfolders: (Array.isArray(row?.subfolders) ? row.subfolders : [])
          .slice()
          .sort((a, b) => byFolderNameKey(a?.subcategory, b?.subcategory))
      }))
      .sort((a, b) => byFolderNameKey(a?.category, b?.category));
  },

  async _localTags() {
    const rows = await this._localRows();
    const counts = new Map();

    for (const n of rows) {
      if (n._deleted) continue;
      for (const raw of n.tags || []) {
        const key = String(raw).toLowerCase();
        const cur = counts.get(key) || { tag: String(raw), count: 0 };
        cur.count += 1;
        counts.set(key, cur);
      }
    }

    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, value]) => value);
  },

  async _loadFolderTree(force = false) {
    const target = Utils.$("folder-tree");
    if (!target) return;
    if (!force && this._folderTreeCache) return this._renderFolderTree();
    if (!target.querySelector('.tree-group')) target.innerHTML = renderLoading();

    const tree = this._localReady ? await this._localFolderTree() : await API.req("folders/tree");
    this._folderTreeCache = this._normalizeFolderTree(tree);
    this._renderFolderTree();
  },

  async _loadTagCloud(force = false) {
    const target = Utils.$("tag-cloud");
    if (!target) return;
    if (!force && this._tagCloudCache) return this._renderTagCloud();
    if (!target.querySelector('.tag-cloud-list')) target.innerHTML = renderLoading();

    const tags = this._localReady ? await this._localTags() : await API.req("tags");
    this._tagCloudCache = Array.isArray(tags) ? tags : [];
    this._renderTagCloud();
  },

  _renderTagCloud() {
    const target = Utils.$("tag-cloud");
    if (!target) return;
    const rows = this._tagCloudCache || [];
    if (!rows.length) {
      const emptyHtml = '<div class="tag-cloud-empty"><em>No tags yet.</em></div>';
      if (this._lastTagCloudHtml !== emptyHtml) { this._lastTagCloudHtml = emptyHtml; target.innerHTML = emptyHtml; }
      return;
    }

    const activeTag = String(State.tag || "").trim();
    const hasOverflow = rows.length > TAG_PREVIEW_LIMIT;
    let visibleRows = rows;

    if (!this._tagCloudExpanded && hasOverflow) {
      visibleRows = rows.slice(0, TAG_PREVIEW_LIMIT);
      if (activeTag && !visibleRows.some(r => String(r?.tag || "").trim() === activeTag)) {
        const activeRow = rows.find(r => String(r?.tag || "").trim() === activeTag);
        if (activeRow) visibleRows = [...rows.slice(0, TAG_PREVIEW_LIMIT - 1), activeRow];
      }
    }

    const chipsHtml = visibleRows.map(r => {
      const tag = String(r?.tag || "").trim();
      const enc = encodeInlineParam(tag);
      return tag ? `<button class="tag-cloud-chip${activeTag === tag ? " active" : ""}" type="button" onclick="App.openSidebarTagByEncoded('${enc}')" oncontextmenu="return App.openTreeContextMenu(event, 'tag', '', '', '${enc}')">#${escapeHtml(tag)}</button>` : "";
    }).join("");

    const footerMarkup = hasOverflow ? `<div class="tag-cloud-footer"><button class="tag-cloud-more${this._tagCloudExpanded ? " is-expanded" : ""}" type="button" aria-label="${this._tagCloudExpanded ? "Show fewer tags" : "Show more tags"}" onclick="App.toggleTagCloudExpanded()"><i class="ri-arrow-right-s-line"></i></button></div>` : "";
    const html = `<div class="tag-cloud-list">${chipsHtml}</div>${footerMarkup}`;
    if (this._lastTagCloudHtml !== html) {
      this._lastTagCloudHtml = html;
      target.innerHTML = html;
    }
    target.querySelector(".tag-cloud-more")?.removeAttribute("title");
    this._syncTagCloudPanelControls();
  },

  _invalidateSidebarCaches() { this._localRowsCache = null; this._localRowsRev = -1; this._folderTreeCache = this._tagCloudCache = null; this._tagCloudExpanded = false; this._lastFolderTreeHtml = this._lastTagCloudHtml = null; },
  toggleTagCloudExpanded() { if ((this._tagCloudCache || []).length > TAG_PREVIEW_LIMIT) { this._tagCloudExpanded = !this._tagCloudExpanded; this._renderTagCloud(); } },
  toggleTagCloudPanel() {
    this._tagCloudPanelCollapsed = !this._tagCloudPanelCollapsed;
    this._syncTagCloudPanelControls();
  },
  togglePrintMode() {
    const active = document.body.classList.toggle('print-mode');
    const btn = Utils.$('btn-print-mode');
    if (btn) btn.dataset.state = active ? 'collapsed' : 'expanded';
  },
  _syncTagCloudPanelControls() {
    const cloud = Utils.$("tag-cloud");
    if (cloud) cloud.classList.toggle("collapsed", this._tagCloudPanelCollapsed);
    const toggle = Utils.$("btn-tag-cloud-toggle");
    if (toggle) {
      toggle.setAttribute("aria-label", this._tagCloudPanelCollapsed ? "Show tags" : "Hide tags");
      toggle.dataset.state = this._tagCloudPanelCollapsed ? "collapsed" : "expanded";
    }
    const label = Utils.$("tag-cloud-toggle-label");
    if (label) label.textContent = "";
  },

  _syncFolderPanelControls() {
    Utils.$("folder-tree-shell")?.classList.toggle("collapsed", this._folderPanelCollapsed);
    const folderToggle = Utils.$("btn-folder-dom-toggle");
    if (folderToggle) {
      folderToggle.setAttribute("aria-label", this._folderPanelCollapsed ? "Show folder panel content" : "Hide folder panel content");
      folderToggle.dataset.state = this._folderPanelCollapsed ? "collapsed" : "expanded";
    }
    const categories = (this._folderTreeCache || []).map(r => String(r?.category || "").trim()).filter(Boolean);
    const treeToggle = Utils.$("btn-tree-toggle");
    if (treeToggle) {
      const allCollapsed = categories.length > 0 && categories.every(c => this._collapsedCategories.has(c));
      treeToggle.setAttribute("aria-label", allCollapsed ? "Expand all folders" : "Collapse all folders");
      treeToggle.dataset.state = allCollapsed ? "collapsed" : "expanded";
      treeToggle.disabled = categories.length === 0;
    } ["folder-dom-toggle-label", "tree-toggle-label"].forEach(id => { const el = Utils.$(id); if (el) el.textContent = ""; });
  },

  _renderFolderTree() {
    const target = Utils.$("folder-tree");
    if (!target) return;
    const tree = this._folderTreeCache || [];
    const aCat = State.view === "note" && !State.category ? String(this._currentNote?.category || "") : State.category;
    const aSub = State.view === "note" && !State.subcategory ? String(this._currentNote?.subcategory || "") : State.subcategory;

    if (!tree.length) {
      const emptyHtml = '<div class="loading-hint">No folders yet. Save a note to create one.</div>';
      if (this._lastFolderTreeHtml !== emptyHtml) { this._lastFolderTreeHtml = emptyHtml; target.innerHTML = emptyHtml; }
      return this._syncFolderPanelControls();
    }

    if (!this._collapsedStateLoaded) {
      tree.forEach(r => { if (r?.category) this._collapsedCategories.add(String(r.category).trim()); });
      this._collapsedStateLoaded = true; this._saveCollapsedState();
    }

    const html = tree.map(r => {
      const cat = String(r?.category || ""), encCat = encodeInlineParam(cat), subs = Array.isArray(r?.subfolders) ? r.subfolders : [];
      const isOpen = !this._collapsedCategories.has(cat);
      const isActCat = cat === aCat && !aSub, isActSub = cat === aCat && !!aSub;

      return `
        <div class="tree-group ${isOpen ? "open" : ""}">
          <div class="tree-node tree-category ${isActSub ? "active-parent" : isActCat ? "active" : ""}" onclick="App.openCategoryByEncoded('${encCat}')" oncontextmenu="return App.openTreeContextMenu(event, 'category', '${encCat}')">
            <button class="tree-toggle" type="button" onclick="event.stopPropagation(); App.toggleCategoryFoldByEncoded('${encCat}')"><svg class="ri-icon" viewBox="0 0 24 24"><path d="M10 6l6 6-6 6"></path></svg></button>
            <span class="tree-label">${escapeHtml(cat || "Imported")}</span><span class="tree-count">${Number(r?.count || 0)}</span>
            <span class="tree-delete-slot"><button class="tree-delete-btn" type="button" onclick="event.stopPropagation(); App.deleteCategoryByEncoded('${encCat}')"><i class="ri-close-line"></i></button></span>
          </div>
          <div class="tree-children">
            ${subs.length ? subs.map(s => {
        const sub = String(s?.subcategory || "General"), encSub = encodeInlineParam(sub);
        return `
                <div class="tree-node tree-subcategory ${cat === aCat && sub === aSub ? "active" : ""}" onclick="App.openSubcategoryByEncoded('${encCat}', '${encSub}')" oncontextmenu="return App.openTreeContextMenu(event, 'subcategory', '${encCat}', '${encSub}')">
                  <span class="tree-leaf"></span><span class="tree-label">${escapeHtml(sub)}</span><span class="tree-count">${Number(s?.count || 0)}</span>
                  <span class="tree-delete-slot"><button class="tree-delete-btn" type="button" onclick="event.stopPropagation(); App.deleteSubcategoryByEncoded('${encCat}', '${encSub}')"><i class="ri-close-line"></i></button></span>
                </div>`;
      }).join("") : '<div class="tree-empty">No subfolders yet.</div>'}
          </div>
        </div>`;
    }).join("");
    if (this._lastFolderTreeHtml !== html) {
      this._lastFolderTreeHtml = html;
      target.innerHTML = html;
    }
    this._syncFolderPanelControls();
  },

  primeSavedNote(note, fresh = false) {
    if (!note?.id) return null;
    this._currentNote = { ...note, id: String(note.id || ""), title: String(note.title || ""), category: String(note.category || ""), subcategory: String(note.subcategory || ""), content: typeof note.content === "string" ? note.content : "", tags: Array.isArray(note.tags) ? note.tags.map(t => String(t || "").trim()).filter(Boolean) : [] };
    this._notePathHint = { category: this._currentNote.category, subcategory: this._currentNote.subcategory };
    this._currentNoteFresh = !!fresh;
    return this._currentNote;
  },

  _breadcrumbContext() {
    return {
      view: State.view,
      category: State.category,
      subcategory: State.subcategory,
      q: State.q,
      tag: State.tag,
      currentNote: this._currentNote,
      notePathHint: this._notePathHint,
      onNavigate: (next) => this.route(next)
    };
  },

  _paintNoteDetail(el, note) {
    UI.renderBreadcrumb(this._breadcrumbContext());
    el.innerHTML = this._renderNoteDetail(note);
    this._renderFolderTree();
  },

  async _loadNote() {
    const el = Utils.$("note-detail");
    if (!el) return;
    const id = String(State.note || "").trim();
    if (this._currentNote?.id === id) {
      this._paintNoteDetail(el, this._currentNote);
      if (this._currentNoteFresh) { this._currentNoteFresh = false; return; }
    } else el.innerHTML = renderLoading();

    const local = this._localReady ? await LocalDB.getNote(id) : null;
    const note = local || await API.req("list", { id });
    if (String(State.note || "").trim() !== id) return;

    if (!note?.id) { el.innerHTML = '<div class="loading-hint">Note not found.</div>'; this._currentNote = null; return; }
    this.primeSavedNote(note);
    this._paintNoteDetail(el, note);
    hydrateMedia(el).catch(() => {});
  },

  _renderNoteDetail(note) {
    const sId = escapeHtml(note.id), tags = Array.isArray(note.tags) ? note.tags : [];
    return `
      <article class="note-detail-shell" tabindex="0">
        <div class="note-detail-header"><div class="note-title-block">
          <div class="note-title note-detail-title">${escapeHtml(note.title || "Untitled Note")}</div>
          <div class="note-detail-meta">
            <div class="note-date-muted">${escapeHtml(String(note.updatedAt || "").slice(0, 10))}</div>
            <div class="item-actions">
              <span class="btn-icon-s edit" onclick="App.editEntry(this, '${sId}')"><i class="ri-edit-line"></i></span>
              <span class="btn-del" onclick="App.deleteEntry('${sId}')"><i class="ri-delete-bin-line"></i></span>
            </div>
          </div>
        </div></div>
        <div class="dc-text note-detail-body">${ensureLazyMedia(note.content)}</div>
        ${tags.length ? `<div class="note-detail-footer"><div class="note-detail-tags">${tags.map(t => `<button class="note-detail-tag" type="button" onclick="App.toggleTagByEncoded('${encodeInlineParam(t)}')">#${escapeHtml(t)}</button>`).join("")}</div></div>` : ""}
      </article>`;
  },

  _setupTreeContextMenu() {
    const tree = Utils.$("folder-tree");
    if (tree) tree.addEventListener("contextmenu", e => { if (!e.target.closest(".tree-node")) this.openTreeContextMenu(e, "root", ""); });
    document.addEventListener("click", () => this.closeTreeContextMenu());
    document.addEventListener("contextmenu", e => { if (!e.target.closest("#folder-tree") && !e.target.closest("#tree-context-menu")) this.closeTreeContextMenu(); });
    window.addEventListener("scroll", () => this.closeTreeContextMenu(), { passive: true });
    window.addEventListener("resize", () => this.closeTreeContextMenu());
  },

  _disableNativeContextMenu() {
    document.addEventListener("contextmenu", e => e.preventDefault());
  },

  openTreeContextMenu(event, scope = "root", encodedCategory = "", encodedSubcategory = "", encodedTag = "") {
    event.preventDefault(); event.stopPropagation();
    const menu = Utils.$("tree-context-menu");
    const newCatBtn = Utils.$("tree-context-new-category");
    const subBtn = Utils.$("tree-context-subfolder");
    const renBtn = Utils.$("tree-context-rename");
    if (!menu || !subBtn) return false;

    const category = decodeURIComponent(encodedCategory || "");
    const subcategory = decodeURIComponent(encodedSubcategory || "");
    const tag = decodeURIComponent(encodedTag || "");
    this._treeContextState = { scope, category, subcategory, tag };

    if (newCatBtn) newCatBtn.style.display = scope === "tag" ? "none" : "flex";
    subBtn.style.display = "none";
    if (renBtn) renBtn.style.display = "none";

    if (scope === "category" || scope === "subcategory") {
      if (scope === "category") {
        subBtn.style.display = "flex";
        subBtn.textContent = `NEW SUBFOLDER IN ${category || "CATEGORY"}`;
      }
      if (renBtn) { renBtn.style.display = "flex"; renBtn.textContent = `RENAME ${scope === "category" ? category : subcategory}`; }
    } else if (scope === "tag" && renBtn) {
      renBtn.style.display = "flex";
      renBtn.textContent = `RENAME #${tag}`;
    }

    menu.style.display = "flex";
    requestAnimationFrame(() => {
      menu.style.left = `${Math.min(event.clientX, Math.max(8, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.min(event.clientY, Math.max(8, window.innerHeight - menu.offsetHeight - 8))}px`;
    });
    return false;
  },
  closeTreeContextMenu() { const m = Utils.$("tree-context-menu"); if (m) m.style.display = "none"; },

  openCategoryByEncoded(e) {
    const category = decodeURIComponent(e || "");
    this.route({ view: "category", category, subcategory: "", note: "", q: "", tag: "", page: 1 });
  },
  openSubcategoryByEncoded(eC, eS) {
    const category = decodeURIComponent(eC || ""), subcategory = decodeURIComponent(eS || "");
    this.route({ view: "list", category, subcategory, note: "", q: "", tag: "", page: 1 });
  },

  toggleCategoryFoldByEncoded(e) {
    const c = decodeURIComponent(e || "");
    if (!c) return;
    if (this._collapsedCategories.has(c)) this._collapsedCategories.delete(c); else this._collapsedCategories.add(c);
    this._saveCollapsedState(); this._renderFolderTree();
  },
  toggleAllFolders() {
    const cats = (this._folderTreeCache || []).map(r => String(r?.category || "").trim()).filter(Boolean);
    if (!cats.length) return this._syncFolderPanelControls();
    if (cats.every(c => this._collapsedCategories.has(c))) this._collapsedCategories.clear(); else cats.forEach(c => this._collapsedCategories.add(c));
    this._saveCollapsedState(); this._renderFolderTree();
  },
  toggleFolderPanel() { this._folderPanelCollapsed = !this._folderPanelCollapsed; this._syncFolderPanelControls(); },
  openNoteById(id, eC = "", eS = "") {
    if (String(id || "").trim()) { this._notePathHint = { category: decodeURIComponent(eC), subcategory: decodeURIComponent(eS) }; this.route({ view: "note", note: String(id).trim() }); }
  },

  async _handleFolderAction(method, params, promptTitle, promptMsg, promptLabel, routeCallback, oldName = "") {
    this.closeTreeContextMenu();
    const newName = await swalPrompt(promptTitle, promptMsg, promptLabel, oldName, oldName ? "Rename" : "OK");
    if (!newName || newName === oldName) return;

    await withLoading(async () => {
      const res = await API.req("folders", { ...params, [method === "PUT" ? "newName" : (params.subcategory !== undefined ? "subcategory" : "category")]: newName }, method);
      this._folderTreeCache = null;
      const nextRoute = routeCallback ? routeCallback(res, newName) : null;
      if (nextRoute) this.route(nextRoute); else await this.loadView();
      // 目录树是从本地笔记聚合出来的：服务端改完了，本地库还是旧的。
      // 不拉一次的话，改名/新建在界面上毫无反应，要等下一次自动同步。
      syncNow({ force: true }).catch(() => {});
    }, `${oldName ? 'Rename' : 'Create'} Failed`);
  },
  async createCategory() { this._handleFolderAction("POST", { category: "" }, "New Category", "Create a top-level folder for your notes.", "Major category", (res) => ({ view: "category", category: res.category, subcategory: "", note: "", q: "", tag: "", page: 1 })); },
  async createSubcategory(override = "") {
    const cat = String(override || State.category || "").trim();
    if (cat) this._handleFolderAction("POST", { category: cat, subcategory: "" }, "New Subfolder", `Create a subfolder inside "${cat}".`, "Minor category", (res) => ({ view: "list", category: res.category, subcategory: res.subcategory, note: "", q: "", tag: "", page: 1 }));
  },
  createCategoryFromContextMenu() { this.createCategory(); },
  createSubcategoryFromContextMenu() { const c = String(this._treeContextState?.category || "").trim(); if (c) this.createSubcategory(c); },
  async renameFromContextMenu() {
    const { scope, category, subcategory, tag } = this._treeContextState;
    if (scope === "tag") {
      this.closeTreeContextMenu();
      if (!tag) return;
      const newName = await swalPrompt("Rename Tag", `Enter a new name for "#${tag}"`, "", tag, "Rename");
      if (!newName || newName === tag) return;
      await withLoading(async () => {
        await API.req("tags", { oldName: tag, newName }, "PUT");
        this._invalidateSidebarCaches();
        if (String(State.tag || "") === tag) this.route({ tag: newName });
        else await this.loadView();
        syncNow({ force: true }).catch(() => {});
      }, "Rename Failed");
      return;
    }
    if (!category) return;
    const isCat = scope === "category", oldName = isCat ? category : subcategory;
    this._handleFolderAction("PUT", { oldCategory: category, oldSubcategory: isCat ? "" : subcategory }, "Rename", `Enter a new name for "${oldName}"`, "", (res, newName) => {
      if (State.category === category && (isCat || State.subcategory === subcategory)) {
        return { category: isCat ? newName : category, subcategory: !isCat ? newName : State.subcategory, page: 1 };
      }
      return null;
    }, oldName);
  },

  async _deleteFolder(params, name, isCategory, successRoute) {
    if (!await swalConfirm(`Delete ${isCategory ? 'Category' : 'Subfolder'}?`, `This will delete "${name}" and all notes inside it.`)) return;

    // 本地库还没就绪（首次打开、同步中）只能走在线接口。
    if (!this._localReady) {
      await withLoading(async () => {
        await API.req("folders", params, "DELETE");
        this._invalidateSidebarCaches();
        if (successRoute) this.route(successRoute); else await this.loadView();
        syncNow({ force: true }).catch(() => {});
      }, "Delete Failed", "Unable to delete folder.");
      return;
    }

    // 本地优先：目录树是按 notes 的 category/subcategory 聚合出来的，
    // 所以把这个目录下的笔记从本地库物理删掉，树会立刻少一项，无需等网络。
    const sub = params.subcategory || "";
    const rows = await this._localRows();
    const targets = rows
      .filter((n) => !n._deleted && n.category === params.category && (!sub || n.subcategory === sub))
      .map((n) => ({ id: n.id, baseSeq: n._baseSeq }));

    if (targets.length) await LocalDB.deleteNotesLocal(targets);

    this._invalidateSidebarCaches();
    if (successRoute) this.route(successRoute);
    else this._scheduleListRefresh();

    UI.setStatus("loading");
    try {
      await API.req("folders", params, "DELETE");
      // 服务端是整批删的，本地排队等待逐条推送的删除可以一并清掉。
      if (targets.length) await LocalDB.clearDeletions(targets.map((item) => item.id));
      UI.setStatus("ok"); resetStatusLater("ok");
    } catch (e) {
      // 不回滚本地：删除队列还在，下一轮 push 会逐条补推，最终一致。
      UI.setStatus("err"); resetStatusLater("err");
      swalAlert("Delete Failed", e?.message || "Removed locally; it will sync when the server is reachable.", "error");
    }
  },
  deleteCategoryByEncoded(e) { const c = decodeURIComponent(e || ""); if (c) this._deleteFolder({ category: c }, c, true, State.category === c ? { view: "index", category: "", subcategory: "", note: "", q: "", tag: "", page: 1 } : null); },
  deleteSubcategoryByEncoded(eC, eS) { const c = decodeURIComponent(eC || ""), s = decodeURIComponent(eS || ""); if (c && s) this._deleteFolder({ category: c, subcategory: s }, s, false, State.category === c && State.subcategory === s ? { view: "category", category: c, subcategory: "", note: "", q: "", tag: "", page: 1 } : null); },

  toggleTagByEncoded(e) {
    const tag = decodeURIComponent(e || ""), next = State.tag === tag ? "" : tag;
    this._searchPanelOpen = false;
    this.route({ note: "", tag: next, page: 1 });
  },
  openSidebarTagByEncoded(e) {
    const t = decodeURIComponent(e || ""), n = State.tag === t ? "" : t;
    this._searchPanelOpen = false;
    this.route({ category: "", subcategory: "", note: "", q: "", tag: n, page: 1 });
  },
  applySearch() {
    const q = String(Utils.$("note-search")?.value || "").trim();
    if (!q) return this.clearSearch();
    this._searchPanelOpen = true; this.route({ category: "", subcategory: "", note: "", q, tag: "", page: 1 });
  },
  toggleSearchBox() {
    if (State.view === "backup") return;
    const input = Utils.$("note-search");
    if ((State.q || State.tag) && !String(input?.value || "").trim()) return this.clearSearch();
    this._searchPanelOpen = (State.q || State.tag) ? true : !this._searchPanelOpen;
    Utils.$("btn-search-toggle")?.classList.toggle("active", this._searchPanelOpen || !!State.q);
    Utils.$("global-note-tools")?.classList.toggle("active", this._searchPanelOpen || !!State.q);
    if (this._searchPanelOpen || State.q || State.tag) requestAnimationFrame(() => input?.focus({ preventScroll: true }));
  },
  clearSearch() {
    const i = Utils.$("note-search"); if (i) i.value = "";
    this._searchPanelOpen = false;
    this.route({ note: "", q: "", tag: "", page: 1 });
  },
  handleSearchKeydown(e) { if (e.key === "Enter") { e.preventDefault(); this.applySearch(); } },
  toggleJump(show) {
    const scopeEl = this._activeViewEl();
    const txt = scopeEl?.querySelector(".pg-status-txt"), inp = scopeEl?.querySelector(".pg-inp");
    if (!txt || !inp) return;
    if (show) { txt.style.display = "none"; inp.style.display = "inline-block"; inp.value = State.page; requestAnimationFrame(() => inp.focus({ preventScroll: true })); }
    else {
      txt.style.display = "inline"; inp.style.display = "none";
      const next = parseInt(inp.value, 10);
      if (next && next !== State.page && next <= State.data.totalPg) this.route({ page: next }, { pageTurn: true });
    }
  },

  openBackup() {
    this.route({ view: "backup" }, { quiet: true });
  },

  toggleServerPanel() {
    const panel = Utils.$("auth-server-panel");
    const input = Utils.$("auth-server-input");
    const hint = Utils.$("auth-server-hint");
    if (!panel) return;

    const willOpen = panel.hasAttribute("hidden");

    if (!willOpen) {
      panel.setAttribute("hidden", "");
      return;
    }

    panel.removeAttribute("hidden");
    if (hint) {
      hint.textContent = "";
      hint.className = "auth-server-hint";
    }
    if (input) {
      input.value = "";
      input.focus();
    }
  },

  _renderAuthServerAddress() {
    const el = Utils.$("auth-server-current");
    if (!el) return;

    const base = getApiBase();
    if (!base) {
      el.hidden = true;
      el.textContent = "";
      return;
    }

    el.hidden = false;
    el.textContent = base;
    el.title = `当前服务器：${base}（点击修改）`;
  },

  async saveServerAddress() {
    const input = Utils.$("auth-server-input");
    const hint = Utils.$("auth-server-hint");
    const setHint = (text, kind) => {
      if (!hint) return;
      hint.textContent = text;
      hint.className = `auth-server-hint${kind ? ` ${kind}` : ""}`;
    };

    if (!String(input?.value || "").trim()) {
      setHint("Please enter a server address", "error");
      return;
    }

    const value = normalizeServerUrl(input?.value);
    if (!value) {
      setHint("Invalid address, e.g. http://192.168.1.20:3000", "error");
      return;
    }

    setHint("Connecting...", "");
    const probe = await this._probeServer(value);
    if (!probe.ok) {
      setHint(`Connection failed: ${probe.reason}`, "error");
      return;
    }

    setApiBase(value);
    setHint("Connected, reloading...", "ok");
    location.reload();
  },

  async _probeServer(base) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    try {
      const res = await fetch(`${base}/api/sync/state`, {
        method: "GET",
        signal: controller.signal
      });

      if (res.status >= 500) return { ok: false, reason: `Server returned HTTP ${res.status}` };
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: error?.name === "AbortError"
          ? "Connection timed out (no response in 6s)"
          : "Network unreachable — check address, port and firewall"
      };
    } finally {
      clearTimeout(timer);
    }
  },

  async newEntry() { if (await Editor.close()) await Editor.open("new", { title: "", category: State.category || "", subcategory: State.subcategory || "", tags: [], content: "", createdAt: "", updatedAt: "" }); },
  async editEntry(btn, id) {
    if (!await Editor.close()) return;
    const row = btn?.closest(".note-detail-shell, .archive-row") || (State.view === "note" ? Utils.$("note-detail")?.querySelector(".note-detail-shell") : null);
    const target = this._currentNote?.id === id
      ? this._currentNote
      : (await LocalDB.getNote(id)) || await API.req("list", { id });
    await Editor.open("edit", target, row);
  },
  async deleteEntry(id) {
    if (!await swalConfirm("Delete Note?", "This note and its unused local media will be removed.")) return;

    // 先做即时反馈：行立刻消失、详情区显示占位，不必等落库和重新渲染。
    const d = Utils.$("note-detail"); if (d) d.innerHTML = renderLoading();
    document.querySelectorAll(`.archive-row[data-id="${CSS.escape(id)}"]`).forEach(el => el.remove());

    UI.setStatus("loading");
    try {
      if (this._localReady) {
        await queueNoteDelete(id);
      } else {
        await API.req("delete", { id }, "DELETE");
      }
      UI.setStatus("ok"); resetStatusLater("ok");
    } catch (e) {
      UI.setStatus("err"); resetStatusLater("err");
      swalAlert("Delete failed", e?.message || "Operation failed.", "error");
      await this.loadView({ quiet: true });
      return;
    }

    this._invalidateSidebarCaches();

    if (State.view === "note" && State.note === id) {
      this.route({ note: "" }, { quiet: true });
    } else {
      // 连续删除只重建一次列表：每次重建都要读全库并重画树/标签，
      // 600 条约 50ms，连删 5 条就是 250ms 的纯浪费。
      this._scheduleListRefresh();
    }
  },

  _scheduleListRefresh() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.loadView({ quiet: true }).catch(() => {});
    }, 80);
  },

  changePage(dir) {
    const n = State.page + dir;
    if (n < 1 || n > State.data.totalPg) return;
    this.route({ page: n }, { pageTurn: true });
  },

  _activeViewEl() { return Object.values(this._views).find(v => v?.classList.contains("active")) || null; },

  _setPaginationBusy() {
    const pg = this._activeViewEl()?.querySelector("[data-pagination]");
    if (!pg) return;
    pg.classList.add("is-busy");
    const listEl = pg.parentElement;
    if (listEl) listEl.classList.add("is-updating");
  },

  _clearPaginationBusy(listEl = this._activeViewEl()?.querySelector("[data-pagination]")?.parentElement) {
    if (!listEl) return;
    listEl.classList.remove("is-updating");
    const pg = listEl.querySelector("[data-pagination]");
    if (!pg) return;
    pg.classList.remove("is-busy");
  },

  async goBack() {
    if (State.view === "note") this.route({ note: "" });
    else if (State.view === "list" && State.category && State.subcategory) this.route({ subcategory: "", page: 1 });
    else this.route({ view: "index", category: "", subcategory: "", note: "", q: "", tag: "", page: 1 });
  },
  closeEditor: () => Editor.close(),
  pickRestoreFile() { const i = getRestoreInput(); if (i) { try { if (typeof i.showPicker === "function") i.showPicker(); else i.click(); } catch { i.click(); } } },

  async restoreBackup(file) {
    if (!file || this._restoreInFlight) return;
    this._restoreInFlight = true; UI.setStatus("loading");
    try {
      if (file.size > MAX_RESTORE_FILE_BYTES) throw new Error("Backup file too large (max 100MB).");
      await nextFrame();
      const res = await fetch(`${getApiBase()}/api/backup/restore`, { method: "POST", headers: authHeaders({ "Content-Type": "application/json", "X-Backup-Upload": "file", "X-Backup-Size": String(file.size) }), body: file, credentials: "include", cache: "no-store" });
      if (res.status === 401) { Nonce.clear(); Token.clear(); UI.showAuth(); throw new Error("Unauthorized"); }
      const payload = (res.headers.get("content-type") || "").toLowerCase().includes("application/json") ? await res.json().catch(() => null) : { error: await res.text().catch(() => "") };
      if (!res.ok) throw new Error(payload?.error || "Restore failed.");

      const count = Number(payload?.count ?? 0), skipped = Number(payload?.skipped ?? 0);
      UI.setStatus("ok"); resetStatusLater("ok"); this._invalidateSidebarCaches(); await this.loadView();
      // 恢复直接改的是服务端数据，本地库要靠一次拉取才能看到恢复的内容。
      await syncNow({ force: true }).catch(() => {});
      swalAlert("Restore Complete", `Notes processed: ${count}\nInvalid skipped: ${skipped}`, "success");
    } catch (e) {
      UI.setStatus("err"); resetStatusLater("err");
      swalAlert("Restore Failed", e?.message || "Restore failed.", "error");
    } finally { clearRestoreInput(); this._restoreInFlight = false; }
  },
  async downloadBackup() {
    UI.setStatus("loading");
    try {
      const cat = Utils.$("backup-category")?.value?.trim() === '(All Categories)' ? '' : Utils.$("backup-category")?.value?.trim() || "";
      const res = await fetch(`${getApiBase()}/api/backup/export${cat ? `?category=${encodeURIComponent(cat)}` : ""}`, { headers: authHeaders() });
      if (res.status === 401) { Nonce.clear(); Token.clear(); UI.showAuth(); throw new Error("Unauthorized"); }
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Download failed");
      await saveResponseToFile(res, getDownloadFilename(res.headers.get("content-disposition") || ""));
      UI.setStatus("");
    } catch (e) { if (e?.name !== "AbortError") { console.error("Download failed:", e); UI.setStatus("err"); } else UI.setStatus(""); }
  },

  _setupDocumentListeners() {
    document.addEventListener("change", async e => {
      const inp = e.target;
      if (inp?.id === "restore-input" && inp.files?.[0]) {
        if (!await swalConfirm("Restore Backup?", "This will overwrite notes with matching IDs.")) inp.value = "";
        else await this.restoreBackup(inp.files[0]);
      }
    });
  }
};

App.init();

