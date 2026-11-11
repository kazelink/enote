import fs from 'node:fs';

const BASE = (process.env.ANDROID_MAVEN_MIRROR || '').trim().replace(/\/+$/, '');
if (!BASE) {
    console.log('[skip] ANDROID_MAVEN_MIRROR not set — leaving repositories untouched');
    process.exit(0);
}

const MAVEN = [`${BASE}/google`, `${BASE}/public`, `${BASE}/gradle-plugin`];
const MARK = 'mirror-patch';
const ROOT = 'src-tauri/gen/android';

if (!fs.existsSync(ROOT)) {
    console.error(`[ERROR] ${ROOT} not found. Run "npx tauri android init" first.`);
    process.exit(1);
}

const ktsLines = MAVEN.map((u) => `        maven("${u}") // ${MARK}`).join('\n');
const groovyLines = MAVEN.map((u) => `        maven { url = uri('${u}') } // ${MARK}`).join('\n');

let changed = 0;

function edit(relPath, transform) {
    const full = `${ROOT}/${relPath}`;
    if (!fs.existsSync(full)) {
        console.log(`[skip] ${relPath} (missing)`);
        return;
    }
    const before = fs.readFileSync(full, 'utf8');
    const after = transform(before);
    if (after === before) {
        console.log(`[ok] ${relPath} unchanged`);
        return;
    }
    fs.writeFileSync(full, after, 'utf8');
    changed += 1;
    console.log(`[ok] ${relPath} patched`);
}

function prependKtsRepos(src) {
    if (src.includes(MARK)) return src;
    return src.replace(/(\r?\n([ \t]*)repositories[ \t]*\{\r?\n)/g, `$1${ktsLines}\n`);
}

{
    const rel = 'buildSrc/settings.gradle.kts';
    const full = `${ROOT}/${rel}`;
    const block = `pluginManagement {\r\n    repositories {\r\n${ktsLines}\r\n        gradlePluginPortal()\r\n    }\r\n}\r\n`;
    if (!fs.existsSync(full)) {
        fs.writeFileSync(full, block, 'utf8');
        changed += 1;
        console.log(`[ok] ${rel} created`);
    } else {
        edit(rel, (src) => (src.includes(MARK) ? src : `${block}\r\n${src}`));
    }
}

edit('buildSrc/build.gradle.kts', prependKtsRepos);
edit('build.gradle.kts', prependKtsRepos);



edit('settings.gradle', (src) => {
    if (src.includes(MARK)) return src;
    return `pluginManagement {\n    repositories {\n${groovyLines}\n        gradlePluginPortal()\n    }\n}\n\n${src}`;
});

console.log(`\n${changed} file(s) patched using ${BASE}`);
