import { Utils, State, escapeHtml } from "./dom.js";
import { API, authHeaders, Nonce, Token, getApiBase, setApiBase } from "./api.js";
import { UI } from "./ui.js";
import { swalConfirm, swalAlert, swalPrompt } from "./swal.js";
import { Editor } from "./editor.js?v=5.8";
import { Auth } from "./auth.js";
import * as LocalDB from "./localdb.js";
import { startSyncEngine, syncNow, SyncStatus, queueNoteDelete } from "./sync.js";
import { renderArchivePayload } from "../shared/render.js";

const MAX_RESTORE_FILE_BYTES = 100 * 1024 * 1024;
const STATUS_RESET_DELAY_MS = 2e3;
const TAG_PREVIEW_LIMIT = 5;

function nextFrame() { return new Promise(r => requestAnimationFrame(r)); }
function encodeInlineParam(val) { return encodeURIComponent(String(val ?? "")).replace(/'/g, "%27"); }
/**
 * Point media URLs at the real server when the UI is served from a packaged
 * bundle. In a browser the API base is empty and this is a no-op.
 *
 * The token goes in the query string because native <img>/<video> requests
 * cannot attach headers, and cross-origin cookies are not sent without
 * SameSite=None + HTTPS, which a LAN setup usually does not have.
 */
function rewriteMediaUrls(html) {
  const base = getApiBase();
  if (!base) return html;

  const token = Token.get() || "";
  const nonce = Nonce.get() || "";
  const qs = token ? `?t=${encodeURIComponent(token)}&n=${encodeURIComponent(nonce)}` : "";

  return html.replace(
    /(src|href)=(["'])\/(img|video)\/([^"']+)\2/gi,
    (_m, attr, quote, kind, key) => `${attr}=${quote}${base}/${kind}/${key}${qs}${quote}`
  );
}

function ensureLazyMedia(content) {
  const html = String(content || "").replace(/<img (?![^>]*\bloading=["']?lazy)/gi, '<img loading="lazy" ');
  return rewriteMediaUrls(html);
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
function showRestoreMessage(kind, text) {
  const box = Utils.$("restore-msg");
  if (!box) return;
  box.innerHTML = "";
  if (text) {
    const el = document.createElement("div");
    el.className = kind === "error" ? "auth-err" : "auth-ok";
    el.textContent = text;
    box.appendChild(el);
  }
}

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
  ['category', 'subcategory', 'note', 'q', 'tag'].forEach(k => State[k] = String(State[k] || "").trim());
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
  ['category', 'subcategory', 'note', 'q', 'tag'].forEach(k => State[k] = p.get(k) || "");
  State.page = parseInt(p.get("page") || "1", 10);
  State.view = ["index", "category", "list", "note", "backup"].includes(p.get("view")) ? p.get("view") : "index";
  normalizeState();
}

function buildLocationSearch() {
  const p = new URLSearchParams();
  if (State.view !== "index") p.set("view", State.view);
  ['category', 'subcategory', 'note', 'q', 'tag'].forEach(k => State[k] && p.set(k, State[k]));
  if (State.page > 1) p.set("page", String(State.page));
  const query = p.toString();
  return query ? `?${query}` : location.pathname;
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
  _views: {}, _popstateHandler: null, _restoreInFlight: false, _searchPanelOpen: false, _folderTreeCache: null, _tagCloudCache: null, _tagCloudExpanded: false, _tagCloudPanelCollapsed: true, _collapsedCategories: new Set(), _collapsedStateLoaded: false, _folderPanelCollapsed: false, _currentNote: null, _currentNoteFresh: false, _notePathHint: null, _treeContextState: { scope: "root", category: "" }, _lastFolderTreeHtml: null, _lastTagCloudHtml: null, _loadSeq: 0, _pendingTree: null, _pendingNav: null,

  _resetListContent() {
    ["home-entry-list", "category-entry-list", "entry-list"].forEach(id => {
      const el = Utils.$(id);
      if (!el) return;
      // Keep existing rows visible while the next batch loads (stale-while-revalidate);
      // only seed a loading placeholder when the container is empty.
      if (el.children.length === 0) {
        el.innerHTML = id === "home-entry-list" ? renderNotesHomeState() : renderLoading();
      }
      // Drop any stale "loading" dimming before a fresh navigation renders.
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

  /**
   * Kick off background sync and switch the UI to local data once the first
   * pull succeeds. Before that the list is served by the server, so nothing
   * looks empty while the local store is still filling up.
   */
  _startLocalSync() {
    if (this._syncStarted) return;
    this._syncStarted = true;

    startSyncEngine();

    SyncStatus.on((s) => {
      if (s.state !== "idle" || this._localReady) return;
      this._localReady = true;
      // Sidebar caches were built from server responses; drop them so the
      // folder tree and tag cloud are rebuilt from local data too.
      this._invalidateSidebarCaches();
      this.loadView({ quiet: true }).catch(() => {});
    });
  },

  /**
   * Packaged shells (Tauri / Capacitor) serve the UI from the app bundle, so a
   * relative `/api/...` would resolve against that bundle instead of the real
   * server. Ask for the server address once and persist it in localStorage.
   * In a browser this is a no-op.
   */
  async _ensureServerAddress() {
    const isShell = location.hostname === "tauri.localhost"
      || location.protocol === "tauri:"
      || Boolean(window.__TAURI_INTERNALS__);

    if (!isShell || getApiBase()) return true;

    for (let attempt = 0; attempt < 5; attempt++) {
      const entered = await swalPrompt(
        "Server Address",
        "Enter the eNote server URL, for example http://192.168.1.20:3000",
        "http://192.168.1.20:3000"
      );

      if (!entered) continue;

      let normalized = String(entered).trim();
      if (!/^https?:\/\//i.test(normalized)) normalized = `http://${normalized}`;
      normalized = normalized.replace(/\/+$/, "");

      try {
        new URL(normalized);
      } catch {
        continue;
      }

      setApiBase(normalized);
      return true;
    }

    return false;
  },

  async init() {
    try {
      Auth.init(); Editor.init();

      // SweetAlert's container is z-index 2400 while the login overlay is 9999,
      // so any dialog opened from the auth screen renders underneath it and the
      // click looks like it did nothing. Injected at runtime rather than fixed
      // in the stylesheet, which browsers may still hold a cached copy of.
      const dialogLayer = document.createElement("style");
      dialogLayer.textContent = ".swal2-container{z-index:10000!important}";
      document.head.appendChild(dialogLayer);

      Editor.bindSuggestion(Utils.$("backup-category"), "category");
      this._loadCollapsedState();['index', 'category', 'list', 'note', 'backup'].forEach(v => this._views[v] = Utils.$(`v-${v}`));
      window.App = this;
      this._setupHtmxListeners();
      this._setupTreeContextMenu();
      UI.initGlobalEvents();

      // Show the shell before anything that can await on network or user input.
      // `body` starts at opacity 0 and only becomes visible with this class, so
      // a transparent body would also hide the server-address dialog (it is
      // appended inside body) and deadlock init waiting for an invisible prompt.
      document.body.classList.add("ready");

      // Runs after the UI is ready (the prompt needs it) but before any API
      // request: in a packaged shell this resolves the server URL.
      await this._ensureServerAddress();

      if (Nonce.get() && Token.get()) {
        // No dedicated auth-status probe: the first data request doubles as the
        // auth check, and a 401 lands in the API layer's showAuth() path. This
        // saves one serial round trip on every cold load.
        // Decide local-vs-server BEFORE the first render: on an offline start
        // the sidebar must not fire requests that are bound to fail.
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
    // On a slow link, responses from an abandoned navigation can arrive after a
    // newer one; each loadView invalidates all earlier in-flight renders.
    const seq = ++this._loadSeq;
    // A page turn keeps the current list and pagination in place so the row of
    // page controls never flickers; only fresh navigations reset content.
    if (!options.quiet && !options.pageTurn) this._resetListContent();
    // In-place navigations (page turn, tree, tag, breadcrumb, back) all report
    // progress next to the control that was used, so the header spinner stays out.
    const inPlaceNav = !!(options.pageTurn || options.treeNav || options.navPending);
    // Set here rather than in changePage(): route() bails out when the user
    // cancels the unsaved-changes dialog, and a page control marked busy at
    // click time would then be stuck spinning forever.
    if (options.pageTurn) this._setPaginationBusy(options.dir);
    // Same idea for tree navigation: the click handler only passes the target,
    // and the pending marker is applied once the navigation is committed.
    if (options.treeNav) this._pendingTree = options.treeNav;
    if (options.navPending) this._pendingNav = options.navPending;
    syncStateFromLocation();
    if (State.view !== "note") this._currentNote = this._notePathHint = null;

    applyActiveView(this._views, State.view);
    UI.renderBreadcrumb(this._breadcrumbContext());

    const backBtn = Utils.$("btn-header-back");
    if (backBtn) {
      backBtn.classList.toggle("visible", State.view !== "index");
      backBtn.disabled = State.view === "index";
      backBtn.classList.toggle("is-loading", this._pendingNav?.kind === "back");
    }

    // The backup entry is a corner action on the home list only; elsewhere it
    // would float over content that already has its own controls.
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
        } else {
          el.innerHTML = renderLoading();
        }
      }
    }

    if (State.view === "backup") {
      // This branch returns before the block that clears transient loading state.
      this._clearTreePending(seq);
      this._clearNavPending(seq);
      try {
        await this._loadFolderTree();
      } catch (e) {
        console.error("Folder tree load failed:", e);
      }
      return;
    }
    if (!options.quiet && !inPlaceNav) UI.setStatus("loading");

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
      UI.setStatus("");
      this._clearTreePending(seq);
      this._clearNavPending(seq);
    } catch (e) {
      this._clearPaginationBusy();
      this._clearTreePending(seq);
      this._clearNavPending(seq);
      if (e?.code === "UNAUTHORIZED") { UI.setStatus(""); return; }
      console.error("View load failed:", e);
      UI.setStatus("err");
    }
  },

  async _loadNoteCollection({ listId, params = {}, seq }) {
    const el = Utils.$(listId);
    if (!el) return;
    const viewEl = el.closest(".view-container");
    if (!el.children.length) el.innerHTML = renderLoading();
    // Dim whatever is on screen (old rows or the placeholder) while the next
    // batch is on the wire, so the swap reads as an in-place update.
    el.classList.add("is-updating");
    try {
      // Treat the local store as ready once a sync or a local save has
      // initialised it; before that fall back to the server so a fresh
      // install renders immediately instead of showing an empty list.
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
      // The server clamps an out-of-range page; mirror it so prev/next stay in
      // sync with what the user actually sees.
      const shownPage = parseInt(pgData?.dataset.page, 10);
      if (Number.isFinite(shownPage) && shownPage > 0) State.page = shownPage;
    } catch (e) {
      this._clearPaginationBusy(el);
      throw e;
    }
  },

  /**
   * Render the note list from the local store using the shared templates, so
   * the markup is byte-identical to what the server would have produced.
   * Mirrors the server query semantics in list.js.
   */
  async _renderLocalList(params = {}) {
    const page = Number(params.page) || 1;
    const size = Number(params.size) || 10;

    const rows = await LocalDB.allNotes();
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

  /**
   * Folder tree derived from local notes, matching the shape returned by
   * /api/folders/tree: [{ category, count, updated_at, subfolders: [...] }].
   */
  async _localFolderTree() {
    const rows = await LocalDB.allNotes();
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

    return [...cats.values()]
      .sort((a, b) => a.category.toLowerCase().localeCompare(b.category.toLowerCase()))
      .map((c) => ({
        category: c.category,
        count: c.count,
        updated_at: c.updated_at,
        subfolders: [...c.subfolders.values()]
      }));
  },

  /** Tag cloud derived from local notes, matching /api/tags: [{ tag, count }]. */
  async _localTags() {
    const rows = await LocalDB.allNotes();
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
    if (!force && this._folderTreeCache) return (this._renderFolderTree(), this._updateDatalists());
    if (!target.querySelector('.tree-group')) target.innerHTML = renderLoading();

    const tree = this._localReady ? await this._localFolderTree() : await API.req("folders/tree");
    this._folderTreeCache = Array.isArray(tree) ? tree : [];
    this._renderFolderTree();
    this._updateDatalists();
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

    const pendTag = this._pendingNav?.kind === "tag" ? this._pendingNav.key : null;
    const chipsHtml = visibleRows.map(r => {
      const tag = String(r?.tag || "").trim();
      const enc = encodeInlineParam(tag);
      const isPend = !!tag && tag === pendTag;
      return tag ? `<button class="tag-cloud-chip${activeTag === tag ? " active" : ""}${isPend ? " is-loading" : ""}" type="button" onclick="App.openSidebarTagByEncoded('${enc}')" oncontextmenu="return App.openTreeContextMenu(event, 'tag', '', '', '${enc}')">${isPend ? '<span class="tag-chip-spin"></span>' : "#"}${escapeHtml(tag)}</button>` : "";
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

  _invalidateSidebarCaches() { this._folderTreeCache = this._tagCloudCache = null; this._tagCloudExpanded = false; this._lastFolderTreeHtml = this._lastTagCloudHtml = null; },
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
      const pend = this._pendingTree;
      const isPendCat = !!pend && pend.category === cat && !pend.subcategory;

      return `
        <div class="tree-group ${isOpen ? "open" : ""}">
          <div class="tree-node tree-category ${isActSub ? "active-parent" : isActCat ? "active" : ""}${isPendCat ? " is-loading" : ""}" onclick="App.openCategoryByEncoded('${encCat}')" oncontextmenu="return App.openTreeContextMenu(event, 'category', '${encCat}')">
            <button class="tree-toggle" type="button" onclick="event.stopPropagation(); App.toggleCategoryFoldByEncoded('${encCat}')"><svg class="ri-icon" viewBox="0 0 24 24"><path d="M10 6l6 6-6 6"></path></svg></button>
            <span class="tree-label">${escapeHtml(cat || "Imported")}</span>${this._treeCountCell(r?.count, isPendCat)}
            <span class="tree-delete-slot"><button class="tree-delete-btn" type="button" onclick="event.stopPropagation(); App.deleteCategoryByEncoded('${encCat}')"><i class="ri-close-line"></i></button></span>
          </div>
          <div class="tree-children">
            ${subs.length ? subs.map(s => {
        const sub = String(s?.subcategory || "General"), encSub = encodeInlineParam(sub);
        const isPendSub = !!pend && pend.category === cat && pend.subcategory === sub;
        return `
                <div class="tree-node tree-subcategory ${cat === aCat && sub === aSub ? "active" : ""}${isPendSub ? " is-loading" : ""}" onclick="App.openSubcategoryByEncoded('${encCat}', '${encSub}')" oncontextmenu="return App.openTreeContextMenu(event, 'subcategory', '${encCat}', '${encSub}')">
                  <span class="tree-leaf"></span><span class="tree-label">${escapeHtml(sub)}</span>${this._treeCountCell(s?.count, isPendSub)}
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

  // The pending folder swaps its count pill for an inline spinner, mirroring the
  // page-turn feedback: the thing you clicked shows the loading state itself.
  _treeCountCell(count, isPending) {
    return isPending
      ? '<span class="tree-count tree-count-loading"><span class="tree-spin"></span></span>'
      : `<span class="tree-count">${Number(count || 0)}</span>`;
  },

  _clearTreePending(seq) {
    // A superseded load must not clear the marker of a newer navigation.
    if (!this._pendingTree || (seq !== undefined && seq !== this._loadSeq)) return;
    this._pendingTree = null;
    this._renderFolderTree();
  },

  // Tag chips, breadcrumbs and the back button all report their own progress, so
  // clearing means refreshing whichever of those surfaces is on screen.
  _clearNavPending(seq) {
    const pending = this._pendingNav;
    if (!pending || (seq !== undefined && seq !== this._loadSeq)) return;
    this._pendingNav = null;
    // Clear only the surface that was actually marked, so a failed tag-cloud
    // fetch is never mistaken for an empty tag list.
    if (pending.kind === "tag") { if (this._tagCloudCache) this._renderTagCloud(); }
    else if (pending.kind === "crumb") UI.renderBreadcrumb(this._breadcrumbContext());
    else if (pending.kind === "back") Utils.$("btn-header-back")?.classList.remove("is-loading");
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
      pendingKey: this._pendingNav?.kind === "crumb" ? this._pendingNav.key : null,
      onNavigate: (next) => this.route(next, { navPending: { kind: "crumb", key: next.view } })
    };
  },

  async _loadNote() {
    const el = Utils.$("note-detail");
    if (!el) return;
    const id = String(State.note || "").trim();
    if (this._currentNote?.id === id) {
      UI.renderBreadcrumb(this._breadcrumbContext()); el.innerHTML = this._renderNoteDetail(this._currentNote); this._renderFolderTree();
      // Just saved: the save response was the canonical content, skip the refetch.
      if (this._currentNoteFresh) { this._currentNoteFresh = false; return; }
    } else el.innerHTML = renderLoading();

    const note = await API.req("list", { id });
    if (String(State.note || "").trim() !== id) return;

    if (!note?.id) { el.innerHTML = '<div class="loading-hint">Note not found.</div>'; this._currentNote = null; return; }
    this.primeSavedNote(note);
    UI.renderBreadcrumb(this._breadcrumbContext()); el.innerHTML = this._renderNoteDetail(note); this._renderFolderTree();
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
    this.route({ view: "category", category, subcategory: "", note: "", q: "", tag: "", page: 1 }, { treeNav: { category, subcategory: "" } });
  },
  openSubcategoryByEncoded(eC, eS) {
    const category = decodeURIComponent(eC || ""), subcategory = decodeURIComponent(eS || "");
    this.route({ view: "list", category, subcategory, note: "", q: "", tag: "", page: 1 }, { treeNav: { category, subcategory } });
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
    await withLoading(async () => {
      await API.req("folders", params, "DELETE");
      this._invalidateSidebarCaches();
      if (successRoute) this.route(successRoute); else await this.loadView();
    }, "Delete Failed", "Unable to delete folder.");
  },
  deleteCategoryByEncoded(e) { const c = decodeURIComponent(e || ""); if (c) this._deleteFolder({ category: c }, c, true, State.category === c ? { view: "index", category: "", subcategory: "", note: "", q: "", tag: "", page: 1 } : null); },
  deleteSubcategoryByEncoded(eC, eS) { const c = decodeURIComponent(eC || ""), s = decodeURIComponent(eS || ""); if (c && s) this._deleteFolder({ category: c, subcategory: s }, s, false, State.category === c && State.subcategory === s ? { view: "category", category: c, subcategory: "", note: "", q: "", tag: "", page: 1 } : null); },

  toggleTagByEncoded(e) {
    const tag = decodeURIComponent(e || ""), next = State.tag === tag ? "" : tag;
    this._searchPanelOpen = false;
    this.route({ note: "", tag: next, page: 1 }, { navPending: { kind: "tag", key: next } });
  },
  openSidebarTagByEncoded(e) {
    const t = decodeURIComponent(e || ""), n = State.tag === t ? "" : t;
    this._searchPanelOpen = false;
    this.route({ category: "", subcategory: "", note: "", q: "", tag: n, page: 1 }, { navPending: { kind: "tag", key: n } });
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
      if (next && next !== State.page && next <= State.data.totalPg) this.route({ page: next }, { pageTurn: true, dir: next > State.page ? 1 : -1 });
    }
  },

  /** Opens the backup / restore view. */
  openBackup() {
    this.route({ view: "backup" }, { quiet: true });
  },

  /** Expands/collapses the inline server field on the login card. */
  toggleServerPanel() {
    const panel = Utils.$("auth-server-panel");
    const input = Utils.$("auth-server-input");
    const hint = Utils.$("auth-server-hint");
    if (!panel) return;

    const willOpen = panel.hasAttribute("hidden");

    // Closing is the common case once the address has been checked, so the
    // button doubles as a toggle instead of stacking more dialogs.
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
      input.value = getApiBase() || "";
      input.focus();
      input.select();
    }
  },

  /** Validates, probes, then stores the address typed into the inline panel. */
  async saveServerAddress() {
    const input = Utils.$("auth-server-input");
    const hint = Utils.$("auth-server-hint");
    const setHint = (text, kind) => {
      if (!hint) return;
      hint.textContent = text;
      hint.className = `auth-server-hint${kind ? ` ${kind}` : ""}`;
    };

    let value = String(input?.value || "").trim();
    if (!value) {
      setHint("请输入服务器地址", "error");
      return;
    }
    if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
    value = value.replace(/\/+$/, "");

    try {
      new URL(value);
    } catch {
      setHint("地址格式不正确，例如 http://192.168.1.20:3000", "error");
      return;
    }

    setHint("正在连接…", "");
    const probe = await this._probeServer(value);
    if (!probe.ok) {
      setHint(`连接失败：${probe.reason}`, "error");
      return;
    }

    setApiBase(value);
    setHint("已连接，正在重新载入…", "ok");
    location.reload();
  },

  /**
   * Lets the user point this client at a different server. Mainly for the
   * packaged app: a browser build already talks to its own origin.
   */
  async openServerSettings() {
    const entered = await swalPrompt(
      "Server Address",
      "服务器地址，例如 http://192.168.1.20:3000",
      "http://192.168.1.20:3000",
      getApiBase()
    );

    if (entered == null) return;

    let normalized = String(entered).trim();
    if (!normalized) return;
    if (!/^https?:\/\//i.test(normalized)) normalized = `http://${normalized}`;
    normalized = normalized.replace(/\/+$/, "");

    try {
      new URL(normalized);
    } catch {
      await swalAlert("地址格式不正确", "请输入形如 http://192.168.1.20:3000 的地址", "error");
      return;
    }

    // Probe before saving. Without this an unreachable address just reloads
    // into a login screen that silently fails, which looks like a freeze.
    const probe = await this._probeServer(normalized);
    if (!probe.ok) {
      const keep = await swalConfirm(
        "无法连接服务器",
        `${normalized}\n\n${probe.reason}\n\n仍然保存这个地址吗？`
      );
      if (!keep) return;
    }

    setApiBase(normalized);
    // A full reload is the simplest way to re-run init against the new origin.
    location.reload();
  },

  /**
   * Checks that a server answers before it is saved. A 401/404 still proves the
   * host is there, so only transport errors and 5xx count as failures.
   */
  async _probeServer(base) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    try {
      const res = await fetch(`${base}/api/sync/state`, {
        method: "GET",
        signal: controller.signal
      });

      if (res.status >= 500) return { ok: false, reason: `服务器返回 HTTP ${res.status}` };
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: error?.name === "AbortError"
          ? "连接超时（6 秒无响应）"
          : "网络不可达，请检查地址、端口和防火墙"
      };
    } finally {
      clearTimeout(timer);
    }
  },

  async newEntry() { if (await Editor.close()) await Editor.open("new", { title: "", category: State.category || "", subcategory: State.subcategory || "", tags: [], content: "", createdAt: "", updatedAt: "" }); },
  async editEntry(btn, id) {
    if (!await Editor.close()) return;
    const row = btn?.closest(".note-detail-shell, .archive-row") || (State.view === "note" ? Utils.$("note-detail")?.querySelector(".note-detail-shell") : null);
    // Read the note from the local store so editing also works offline; the
    // server is only consulted if the record is not cached yet.
    const target = this._currentNote?.id === id
      ? this._currentNote
      : (await LocalDB.getNote(id)) || await API.req("list", { id });
    await Editor.open("edit", target, row);
  },
  async deleteEntry(id) {
    if (!await swalConfirm("Delete Note?", "This note and its unused local media will be removed.")) return;
    const d = Utils.$("note-detail"); if (d) d.innerHTML = renderLoading();
    document.querySelectorAll(`.archive-row[data-id="${CSS.escape(id)}"]`).forEach(el => el.remove());
    await withLoading(async () => {
      if (this._localReady) {
        // Tombstone locally first: the row disappears immediately and the
        // deletion survives a refresh even while offline. The sync engine
        // forwards it once connectivity returns.
        await queueNoteDelete(id);
      } else {
        await API.req("delete", { id }, "DELETE");
      }
      this._invalidateSidebarCaches();
      if (State.view === "note" && State.note === id) {
        this.route({ note: "" }, { quiet: true });
      } else await this.loadView({ quiet: true });
    });
  },

  changePage(dir) {
    const n = State.page + dir;
    if (n < 1 || n > State.data.totalPg) return;
    // Navigate quietly so the global header spinner stays out of the way; the
    // inline spinner is applied by loadView() once the navigation is committed.
    this.route({ page: n }, { pageTurn: true, dir });
  },

  _activeViewEl() { return Object.values(this._views).find(v => v?.classList.contains("active")) || null; },

  _setPaginationBusy(dir) {
    const pg = this._activeViewEl()?.querySelector("[data-pagination]");
    if (!pg) return;
    pg.classList.add("is-busy");
    const btns = pg.querySelectorAll(".pg-btn");
    (dir > 0 ? btns[1] : btns[0])?.classList.add("is-loading");
    const listEl = pg.parentElement;
    if (listEl) listEl.classList.add("is-updating");
  },

  _clearPaginationBusy(listEl = this._activeViewEl()?.querySelector("[data-pagination]")?.parentElement) {
    if (!listEl) return;
    listEl.classList.remove("is-updating");
    const pg = listEl.querySelector("[data-pagination]");
    if (!pg) return;
    pg.classList.remove("is-busy");
    pg.querySelectorAll(".pg-btn.is-loading").forEach(btn => btn.classList.remove("is-loading"));
  },

  async goBack() {
    const back = { navPending: { kind: "back" } };
    if (State.view === "note") this.route({ note: "" }, back);
    else if (State.view === "list" && State.category && State.subcategory) this.route({ subcategory: "", page: 1 }, back);
    else this.route({ view: "index", category: "", subcategory: "", note: "", q: "", tag: "", page: 1 }, back);
  },
  closeEditor: () => Editor.close(),
  pickRestoreFile() { const i = getRestoreInput(); if (i) { try { if (typeof i.showPicker === "function") i.showPicker(); else i.click(); } catch { i.click(); } } },

  async restoreBackup(file) {
    if (!file || this._restoreInFlight) return;
    this._restoreInFlight = true; UI.setStatus("loading"); showRestoreMessage("info", "Uploading backup...");
    try {
      if (file.size > MAX_RESTORE_FILE_BYTES) throw new Error("Backup file too large (max 100MB).");
      await nextFrame();
      const res = await fetch("/api/backup/restore", { method: "POST", headers: authHeaders({ "Content-Type": "application/json", "X-Backup-Upload": "file", "X-Backup-Size": String(file.size) }), body: file, credentials: "include", cache: "no-store" });
      if (res.status === 401) { Nonce.clear(); Token.clear(); UI.showAuth(); throw new Error("Unauthorized"); }
      showRestoreMessage("info", "Restoring backup...");
      const payload = (res.headers.get("content-type") || "").toLowerCase().includes("application/json") ? await res.json().catch(() => null) : { error: await res.text().catch(() => "") };
      if (!res.ok) throw new Error(payload?.error || "Restore failed.");

      const count = Number(payload?.count ?? 0), skipped = Number(payload?.skipped ?? 0);
      showRestoreMessage("success", `Restore successful. Processed ${count} notes, skipped ${skipped} invalid notes.`);
      UI.setStatus("ok"); resetStatusLater("ok"); this._invalidateSidebarCaches(); await this.loadView();
      swalAlert("Restore Complete", `Notes processed: ${count}\nInvalid skipped: ${skipped}`, "success");
    } catch (e) {
      showRestoreMessage("error", `Restore Failed: ${e?.message || "Restore failed."}`); UI.setStatus("err"); resetStatusLater("err");
    } finally { clearRestoreInput(); this._restoreInFlight = false; }
  },
  async downloadBackup() {
    UI.setStatus("loading");
    try {
      const cat = Utils.$("backup-category")?.value?.trim() === '(All Categories)' ? '' : Utils.$("backup-category")?.value?.trim() || "";
      const res = await fetch(`/api/backup/export${cat ? `?category=${encodeURIComponent(cat)}` : ""}`, { headers: authHeaders() });
      if (res.status === 401) { Nonce.clear(); Token.clear(); UI.showAuth(); throw new Error("Unauthorized"); }
      if (!res.ok) throw new Error((await res.json().catch(() => { })).error || "Download failed");
      await saveResponseToFile(res, getDownloadFilename(res.headers.get("content-disposition") || ""));
      UI.setStatus("");
    } catch (e) { if (e?.name !== "AbortError") { console.error("Download failed:", e); UI.setStatus("err"); } else UI.setStatus(""); }
  },

  _updateDatalists() {
    const catList = Utils.$("category-options"), subList = Utils.$("subcategory-options");
    if (!catList || !subList) return;
    const catSeen = new Set(), subSeen = new Set(), catHtml = [], subHtml = [];
    (this._folderTreeCache || []).forEach(r => {
      const cat = String(r?.category || "").trim();
      if (cat && !catSeen.has(cat)) { catSeen.add(cat); catHtml.push(`<option value="${escapeHtml(cat)}"></option>`); }
      (Array.isArray(r?.subfolders) ? r.subfolders : []).forEach(s => {
        const sub = String(s?.subcategory || "").trim();
        if (sub && !subSeen.has(sub)) { subSeen.add(sub); subHtml.push(`<option value="${escapeHtml(sub)}"></option>`); }
      });
    });
    catList.innerHTML = catHtml.join(''); subList.innerHTML = subHtml.join('');
  },

  _setupHtmxListeners() {
    document.addEventListener("htmx:configRequest", e => {
      const nonce = Nonce.get();
      if (nonce) e.detail.headers["X-Session-Nonce"] = nonce;

      // htmx paths in the markup are absolute (`/api/login`). In a packaged
      // shell the page origin is the app bundle, so those must be prefixed with
      // the configured server, otherwise Tauri looks for a local asset.
      const base = getApiBase();
      if (base && typeof e.detail.path === "string"
        && e.detail.path.startsWith("/") && !e.detail.path.startsWith("//")) {
        e.detail.path = base + e.detail.path;
      }
    });
    document.addEventListener("htmx:beforeRequest", e => { if (e.target.id !== "auth-form") UI.setStatus("loading"); });

    // A transport-level failure (server down, wrong address, firewall) produces
    // no HTTP response at all, so htmx renders nothing and the login just spins.
    // Surface it on the login card instead.
    document.addEventListener("htmx:sendError", e => {
      if (e.target?.id !== "auth-form") return;
      const msg = Utils.$("auth-messages");
      if (msg) {
        msg.innerHTML = '<div class="auth-err">无法连接服务器。请检查网络，或点击下方「服务器设置」更改地址。</div>';
      }
    });
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
