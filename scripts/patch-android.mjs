import fs from 'node:fs';

const ROOT = 'src-tauri/gen/android';
const manifestPath = `${ROOT}/app/src/main/AndroidManifest.xml`;
const gradlePath = `${ROOT}/app/build.gradle.kts`;
const activityPath = `${ROOT}/app/src/main/java/com/enote/desktop/MainActivity.kt`;

if (!fs.existsSync(manifestPath)) {
    console.error(`[ERROR] ${manifestPath} not found. Run "npx tauri android init" first.`);
    process.exit(1);
}

let failed = false;

function edit(label, file, transform) {
    if (!fs.existsSync(file)) {
        console.error(`[ERROR] ${file} not found`);
        failed = true;
        return;
    }
    const before = fs.readFileSync(file, 'utf8');
    const after = transform(before);
    if (after === before) {
        console.log(`[ok] ${label}: already patched`);
        return;
    }
    fs.writeFileSync(file, after, 'utf8');
    console.log(`[ok] ${label}: patched`);
}

edit('manifest cleartext', manifestPath, (src) => {
    if (/android:usesCleartextTraffic/.test(src)) return src;
    return src.replace(/<application\b/, '<application android:usesCleartextTraffic="true"');
});

edit('gradle cleartext', gradlePath, (src) => {
    const NEEDLE = 'manifestPlaceholders["usesCleartextTraffic"] = "false"';
    return src.includes(NEEDLE) ? src.replace(NEEDLE, NEEDLE.replace('"false"', '"true"')) : src;
});

edit('gradle targetSdk', gradlePath, (src) =>
    src.replace(/^(\s*targetSdk\s*=\s*)(3[5-9]|[4-9]\d)\s*$/m, '$134')
);

edit('activity edge-to-edge', activityPath, (src) => {
    let out = src.replace(/^\s*import androidx\.activity\.enableEdgeToEdge\r?\n/m, '');
    out = out.replace(/^(\s*)enableEdgeToEdge\(\)\s*\r?\n/m, '');
    return out;
});

process.exit(failed ? 1 : 0);
