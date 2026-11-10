import { readFile, readdir, access } from 'fs/promises';
import { constants } from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const srcDir = path.join(root, 'apps', 'client');
const distDir = path.join(root, 'dist');

const VERSION_QUERY = /\?v=[\w.-]+(?=['"`])/g;

function normalize(text) {
  return text.replace(VERSION_QUERY, '').replace(/\.mjs(?=['"])/g, '.js');
}

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

if (!(await exists(distDir))) {
  console.error('[MISSING] dist/ does not exist. Run: npm run build:dist');
  process.exit(1);
}

const srcFiles = (await walk(srcDir)).filter((f) => /\.(js|mjs|css|html)$/i.test(f));
const stale = [];
const missing = [];

for (const rel of srcFiles) {
  // index.html is rewritten in place by build-web.mjs (base href, relative
  // asset paths), so it never matches the source byte-for-byte. Validated
  // separately by the entry-html check below.
  if (rel.replace(/\\/g, '/') === 'index.html') continue;

  const srcPath = path.join(srcDir, rel);
  const distPath = path.join(distDir, rel.replace(/\.mjs$/i, '.js'));

  if (!(await exists(distPath))) {
    missing.push(rel);
    continue;
  }

  const srcText = await readFile(srcPath, 'utf8');
  const distText = await readFile(distPath, 'utf8');

  if (normalize(srcText) !== normalize(distText)) {
    stale.push(rel);
  }
}

const required = ['index.html'];
for (const name of required) {
  if (!(await exists(path.join(distDir, name)))) missing.push(name);
}

const entryHtml = (await exists(path.join(distDir, 'index.html')))
  ? await readFile(path.join(distDir, 'index.html'), 'utf8')
  : '';
const entryOk = entryHtml.includes('<base href="./">') && !VERSION_QUERY.test(entryHtml);

if (!entryOk && entryHtml) {
  stale.push('index.html (missing <base href="./"> or still has ?v= queries)');
}

if (!stale.length && !missing.length) {
  console.log(`[OK] dist/ is up to date (${srcFiles.length} files checked, ?v= and .mjs normalised).`);
  process.exit(0);
}

if (stale.length) {
  console.log('[STALE] dist/ differs from apps/client:');
  for (const f of stale) console.log(`  - ${f}`);
}
if (missing.length) {
  console.log('[MISSING] present in source but absent from dist:');
  for (const f of missing) console.log(`  - ${f}`);
}
console.log('\nRun: npm run build:dist');
process.exit(1);
