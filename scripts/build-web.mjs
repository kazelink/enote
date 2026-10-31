import { readFile, writeFile, readdir, rm, mkdir, rename } from 'fs/promises';
import { cpSync, existsSync } from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const srcDir = path.join(root, 'apps', 'client');
const distDir = path.join(root, 'dist');

const VERSION_QUERY = /\?v=[\w.\-]+(?=['"`])/g;

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
cpSync(srcDir, distDir, { recursive: true });

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
      show('Failed to load: <' + e.target.tagName.toLowerCase() + '> ' +
        (e.target.src || e.target.href || ''));
      return;
    }
    show('Script error: ' + e.message + '\\n' + (e.filename || '') + ':' + (e.lineno || 0));
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    show('Unhandled rejection: ' + ((r && (r.stack || r.message)) || r));
  });
})();
</script>`;

let html = await readFile(path.join(distDir, 'app.html'), 'utf8');

html = html.replace(VERSION_QUERY, '');
html = html.replace(/\.mjs(?=["'])/g, '.js');
html = html.replace(
    /(<(?:link|script|img|source)\b[^>]*?\b(?:href|src))="\/(?!\/)/gi,
    '$1="./'
);
html = html.replace(
    /<head([^>]*)>/i,
    `<head$1>\n    <base href="./">\n    ${ERROR_REPORTER}`
);

await writeFile(path.join(distDir, 'main.html'), html, 'utf8');
// Tauri resolves a reload of "/" to index.html; without this alias F5 on the
// root URL fails with "asset not found: index.html".
await writeFile(path.join(distDir, 'index.html'), html, 'utf8');

console.log(
    `Prepared dist/ for packaging (${stripped} files stripped of ?v=, ${mjsRewritten} files rewrote .mjs refs)`
);

