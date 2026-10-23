/**
 * Builds `dist/` — the asset tree that the desktop/mobile shells package.
 *
 * `client/` stays exactly as the server serves it; nothing here mutates
 * the source. The shell build needs three transformations that a plain HTTP
 * server makes unnecessary:
 *
 * 1. Version query strings (`app.js?v=5.15`) are stripped everywhere.
 *    `express`/Hono ignore the query when resolving a file, but Tauri's embedded
 *    asset resolver matches on the full path, so every `?v=` module import fails
 *    with 404. Because a failed import aborts the whole ES module graph, the app
 *    never boots and `body.ready` is never added — the window stays blank.
 * 2. Absolute asset paths (`/modules/...`) become relative. The shell origin has
 *    no meaningful document root.
 * 3. A boot marker and error reporter are injected into the HTML so a future
 *    load failure is visible without a console.
 */
import { readFile, writeFile, readdir, rm, mkdir, rename } from 'fs/promises';
import { cpSync, existsSync } from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const srcDir = path.join(root, 'apps', 'client');
const distDir = path.join(root, 'dist');

// `?v=5.15`, `?v=5.8` … immediately before a quote. Restricting the match to a
// quote boundary avoids touching unrelated strings that merely contain "?v=".
const VERSION_QUERY = /\?v=[\w.\-]+(?=['"`])/g;

/* --------------------------------------------------------------- copy tree */

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
cpSync(srcDir, distDir, { recursive: true });

/* ------------------------------------------------------ strip ?v= from code */

async function stripVersionQueries(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    let touched = 0;

    for (const entry of entries) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            touched += await stripVersionQueries(full);
            continue;
        }

        if (!/\.(js|mjs|css)$/i.test(entry.name)) continue;

        const before = await readFile(full, 'utf8');
        const after = before.replace(VERSION_QUERY, '');
        if (after !== before) {
            await writeFile(full, after, 'utf8');
            touched += 1;
        }
    }

    return touched;
}

const stripped = await stripVersionQueries(distDir);

/* --------------------------------------------------- normalise .mjs to .js */

/**
 * Tauri's embedded asset resolver types files by extension it knows; `.mjs` is
 * not among them, so it can be served with a non-JavaScript MIME type. A module
 * served as `text/plain` is rejected by the browser, which aborts the importing
 * graph — `app.js` never runs and the window stays blank. Renaming to `.js` and
 * rewriting the import specifiers avoids depending on that mapping.
 */
async function rewriteMjsReferences(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    let changed = 0;

    for (const entry of entries) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            changed += await rewriteMjsReferences(full);
            continue;
        }

        if (!/\.(js|mjs)$/i.test(entry.name)) continue;

        const before = await readFile(full, 'utf8');
        const after = before.replace(/\.mjs(?=['"])/g, '.js');
        if (after !== before) {
            await writeFile(full, after, 'utf8');
            changed += 1;
        }
    }

    return changed;
}

const mjsRewritten = await rewriteMjsReferences(distDir);

const mjsFile = path.join(distDir, 'assets', 'squire.mjs');
if (existsSync(mjsFile)) {
    await rename(mjsFile, path.join(distDir, 'assets', 'squire.js'));
}

/* ------------------------------------------------------------- build shell HTML */

const ERROR_REPORTER = `<script>
(function () {
  function show(msg) {
    try {
      var box = document.createElement('pre');
      box.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
        'margin:0', 'padding:10px 12px', 'background:#fdecec', 'color:#8a1f1f',
        'font:12px/1.5 Consolas,monospace', 'white-space:pre-wrap',
        'border-bottom:2px solid #b3261e', 'max-height:100vh', 'overflow:auto'
      ].join(';');
      box.textContent = msg;
      (document.body || document.documentElement).appendChild(box);
    } catch (e) { /* nothing else we can do */ }
  }

  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && e.target.tagName) {
      show('资源加载失败 / failed to load: <' + e.target.tagName.toLowerCase() + '> ' +
        (e.target.src || e.target.href || ''));
      return;
    }
    show('脚本错误 / script error: ' + e.message + '\\n' + (e.filename || '') + ':' + (e.lineno || 0));
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    show('未处理的 Promise / unhandled rejection: ' + ((r && (r.stack || r.message)) || r));
  });
})();
</script>`;

let html = await readFile(path.join(distDir, 'app.html'), 'utf8');

html = html.replace(VERSION_QUERY, '');
// The module file was renamed to .js above; any <link rel="modulepreload"> that
// still points at the old .mjs name would 500 and abort module loading.
html = html.replace(/\.mjs(?=["'])/g, '.js');
html = html.replace(
    /(<(?:link|script|img|source)\b[^>]*?\b(?:href|src))="\/(?!\/)/gi,
    '$1="./'
);
html = html.replace(
    /<head([^>]*)>/i,
    `<head$1>\n    <base href="./">\n    ${ERROR_REPORTER}`
);

// Tauri normalises a url of "index.html" to the bare origin, which its resolver
// does not serve as a directory index, so the shell entry uses a distinct name.
await writeFile(path.join(distDir, 'main.html'), html, 'utf8');

console.log(
    `Prepared dist/ for packaging (${stripped} files stripped of ?v=, ${mjsRewritten} files rewrote .mjs refs)`
);
