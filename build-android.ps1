# Builds a sideloadable arm64 APK for eNote.
#
# Why this does not simply call `tauri android build`:
#   * tauri-cli creates a symlink from target/<triple>/release/lib*.so into
#     gen/android/app/src/main/jniLibs. Windows refuses that unless Developer Mode
#     (or SeCreateSymbolicLinkPrivilege) is enabled, and the build aborts.
#     -> we build the .so with cargo and copy it, then skip the rust task in Gradle.
#   * the Gradle wrapper downloads its distribution from services.gradle.org, which
#     may be unreachable; set GRADLE_BIN to a local gradle(.bat) to bypass it.
#   * release builds default `usesCleartextTraffic` to false, so the app could not
#     reach an http:// server; scripts/patch-android.mjs flips it to true.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File build-android.ps1
# Optional environment:
#   JAVA_HOME, ANDROID_HOME, NDK_HOME   -> toolchain locations
#   GRADLE_BIN                          -> full path to gradle.bat (skips the wrapper)
#   ANDROID_MAVEN_MIRROR                -> e.g. https://maven.aliyun.com/repository
#   ENOTE_KEYSTORE_PASS                 -> signing password (default below)
#   ANDROID_TARGET                      -> default aarch64 (arm64 phones)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

$target   = if ($env:ANDROID_TARGET) { $env:ANDROID_TARGET } else { 'aarch64' }
$abiDir   = if ($target -eq 'aarch64') { 'arm64-v8a' } else { 'armeabi-v7a' }
$flavor   = if ($target -eq 'aarch64') { 'Arm64' } else { 'Arm' }
$flavorDir = if ($target -eq 'aarch64') { 'arm64' } else { 'arm' }
$ksPass   = if ($env:ENOTE_KEYSTORE_PASS) { $env:ENOTE_KEYSTORE_PASS } else { 'enote123456' }
$genAndroid = 'src-tauri/gen/android'

function Fail($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

# ---- toolchain -------------------------------------------------------------
if (-not $env:JAVA_HOME) {
    $candidate = 'C:\Users\GX\tools\jdk\jdk-17.0.20.1+1'
    if (Test-Path "$candidate\bin\java.exe") { $env:JAVA_HOME = $candidate }
    else { Fail 'JAVA_HOME is not set and no local JDK 17 was found.' }
}
if (-not (Test-Path "$env:JAVA_HOME\bin\java.exe")) { Fail "No java.exe under $env:JAVA_HOME" }

if (-not $env:ANDROID_HOME) {
    $env:ANDROID_HOME = if ($env:LOCALAPPDATA) { "$env:LOCALAPPDATA\Android\Sdk" } else { '' }
}
if (-not $env:ANDROID_HOME -or -not (Test-Path $env:ANDROID_HOME)) { Fail 'ANDROID_HOME is not set / missing.' }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

if (-not $env:NDK_HOME) {
    $ndk = Get-ChildItem "$env:ANDROID_HOME\ndk" -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($ndk) { $env:NDK_HOME = $ndk.FullName }
}
if (-not $env:NDK_HOME -or -not (Test-Path $env:NDK_HOME)) { Fail 'NDK not found. Install it with sdkmanager "ndk;26.1.10909125".' }

$env:PATH = "$env:JAVA_HOME\bin;$env:USERPROFILE\.cargo\bin;$env:PATH"

$buildTools = Get-ChildItem "$env:ANDROID_HOME\build-tools" -Directory -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.Name -replace '[^\d.]', '') } -Descending | Select-Object -First 1
if (-not $buildTools) { Fail 'No Android build-tools installed.' }

Write-Host "JAVA_HOME   = $env:JAVA_HOME"
Write-Host "ANDROID_HOME= $env:ANDROID_HOME"
Write-Host "NDK_HOME    = $env:NDK_HOME"
Write-Host "build-tools = $($buildTools.Name)"
Write-Host "target      = $target ($abiDir)"

# A stale cargo/rustc from an interrupted build keeps .cargo-build-lock open.
Get-Process cargo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process rustc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# ---- 1. android project ----------------------------------------------------
if (-not (Test-Path $genAndroid)) {
    Write-Host "`n[1/6] tauri android init ..."
    & 'node_modules\.bin\tauri.cmd' android init --ci --skip-targets-install
    if ($LASTEXITCODE -ne 0) { Fail 'tauri android init failed.' }
} else {
    Write-Host "`n[1/6] android project present."
}

# ---- 2. patches ------------------------------------------------------------
Write-Host "[2/6] patching generated gradle files ..."
& node 'scripts\patch-android.mjs'
if ($LASTEXITCODE -ne 0) { Fail 'patch-android failed.' }
if (-not $env:ANDROID_MAVEN_MIRROR) { $env:ANDROID_MAVEN_MIRROR = 'https://maven.aliyun.com/repository' }
& node 'scripts\patch-android-mirrors.mjs'

# Keep the launcher icon identical to the desktop one. tauri icon writes its set
# into src-tauri/icons, but an already-initialised gen/android keeps the copy it
# got at init time, so it has to be re-synced here.
# The adaptive-icon xml is dropped on purpose: its foreground is full-bleed and
# the launcher mask crops the artwork's edges, which makes the app look like it
# has a different icon. Without it Android falls back to ic_launcher.png, which
# is the plain original artwork on a transparent background.
$iconSrc = 'src-tauri\icons\android'
$iconDst = "$genAndroid\app\src\main\res"
if (Test-Path $iconSrc) {
    Get-ChildItem $iconSrc -Directory | ForEach-Object {
        $targetDir = Join-Path $iconDst $_.Name
        New-Item -ItemType Directory -Force $targetDir | Out-Null
        Copy-Item (Join-Path $_.FullName '*') $targetDir -Force -Recurse
    }
    Get-ChildItem (Join-Path $iconDst 'mipmap-anydpi-v26') -File -Filter 'ic_launcher*.xml' -ErrorAction SilentlyContinue |
        Remove-Item -Force
    Write-Host '      synced launcher icons (adaptive xml removed)'
}

# ---- 3. rust library -------------------------------------------------------
# cargo does not know about the NDK, so without these it falls back to whatever
# `cc` is on PATH (e.g. MinGW ld, which rejects --eh-frame-hdr). tauri-cli sets
# them for us; calling cargo directly means doing it ourselves.
$ndkBin = Join-Path $env:NDK_HOME 'toolchains\llvm\prebuilt\windows-x86_64\bin'
if (-not (Test-Path $ndkBin)) { Fail "NDK toolchain not found at $ndkBin" }
$clangPrefix = if ($target -eq 'aarch64') { 'aarch64-linux-android' } else { 'armv7a-linux-androideabi' }
$clang = Join-Path $ndkBin "$clangPrefix`24-clang.cmd"
if (-not (Test-Path $clang)) { Fail "NDK clang wrapper not found: $clang" }
$env:PATH = "$ndkBin;$env:PATH"
Set-Item -Path "env:CARGO_TARGET_$($target.ToUpper())_LINUX_ANDROID_LINKER" -Value $clang -ErrorAction SilentlyContinue
$envVarTriple = $target -replace '-', '_'
Set-Item -Path "env:CC_$envVarTriple`_linux_android" -Value $clang -ErrorAction SilentlyContinue
Set-Item -Path "env:AR_$envVarTriple`_linux_android" -Value (Join-Path $ndkBin 'llvm-ar.exe') -ErrorAction SilentlyContinue
Write-Host "      linker = $clang"

# The Rust lib embeds ../dist at compile time, so dist must be regenerated first.
# Skipping this silently ships a stale frontend (CSS/JS changes never reach the APK).
Write-Host "      building frontend into dist/ ..."
& node 'scripts/build-web.mjs'
if ($LASTEXITCODE -ne 0) { Fail 'build-web.mjs failed.' }

Write-Host "[3/6] cargo build --release --target $target-linux-android ..."
Push-Location 'src-tauri'
# --features tauri/custom-protocol is mandatory: tauri's build.rs computes
# `dev = !custom_protocol`, and a "dev" build makes the asset protocol proxy every
# request to the dev server instead of serving the embedded files, which surfaces
# at runtime as "Failed to request http://tauri.localhost/index.html".
& "$env:USERPROFILE\.cargo\bin\cargo.exe" build --release --target "$target-linux-android" --lib --features tauri/custom-protocol
$cargoExit = $LASTEXITCODE
Pop-Location
if ($cargoExit -ne 0) { Fail 'cargo build failed.' }

$soSrc = "src-tauri\target\$target-linux-android\release\libenote_lib.so"
if (-not (Test-Path $soSrc)) { Fail "Missing $soSrc" }
New-Item -ItemType Directory -Force "$genAndroid\app\src\main\jniLibs\$abiDir" | Out-Null
Copy-Item $soSrc "$genAndroid\app\src\main\jniLibs\$abiDir\libenote_lib.so" -Force
Write-Host "      copied libenote_lib.so -> jniLibs/$abiDir"

# ---- 4. gradle -------------------------------------------------------------
Write-Host "[4/6] gradle assemble${flavor}Release ..."
$gradle = $env:GRADLE_BIN
if (-not $gradle) {
    $candidates = @(
        Get-ChildItem "$env:USERPROFILE\tools" -Directory -Filter 'gradle-*' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'bin\gradle.bat' } |
            Where-Object { Test-Path $_ }
    )
    $gradle = if ($candidates.Count -gt 0) { $candidates[0] } else { Join-Path $genAndroid 'gradlew.bat' }
}
Write-Host "      gradle = $gradle"
$aabOut = Join-Path $genAndroid "app\build\outputs\apk"
Push-Location $genAndroid
& $gradle "assemble${flavor}Release" "-x" "rustBuild${flavor}Release" --console=plain --no-configuration-cache
$gradleExit = $LASTEXITCODE
Pop-Location
if ($gradleExit -ne 0) { Fail 'gradle build failed.' }

$unsigned = Get-ChildItem (Join-Path $aabOut $flavorDir) -Recurse -Filter '*unsigned*.apk' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $unsigned) {
    $unsigned = Get-ChildItem $aabOut -Recurse -Filter '*unsigned*.apk' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if (-not $unsigned) { Fail 'No unsigned APK produced by gradle.' }

# ---- 5. sign ---------------------------------------------------------------
Write-Host "[5/6] zipalign + apksigner ..."
$keystore = Join-Path $genAndroid 'enote-release.jks'
if (-not (Test-Path $keystore)) {
    Write-Host '      generating a new signing key (keep it: updates must use the same key)'
    & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -keystore $keystore -alias enote `
        -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 `
        -storepass $ksPass -keypass $ksPass `
        -dname 'CN=eNote, OU=Personal, O=eNote, C=CN'
    if ($LASTEXITCODE -ne 0) { Fail 'keytool failed.' }
}

$aligned = $unsigned.FullName -replace '\.apk$', '-aligned.apk'
& "$($buildTools.FullName)\zipalign.exe" -f -p 4 $unsigned.FullName $aligned
if ($LASTEXITCODE -ne 0) { Fail 'zipalign failed.' }

New-Item -ItemType Directory -Force 'dist-android' | Out-Null
$final = (Resolve-Path 'dist-android').Path + "\eNote-arm64-$target.apk"
& "$($buildTools.FullName)\apksigner.bat" sign --ks $keystore --ks-pass "pass:$ksPass" `
    --key-pass "pass:$ksPass" --ks-key-alias enote --out $final $aligned
if ($LASTEXITCODE -ne 0) { Fail 'apksigner failed.' }

# Not piped into Select-Object: truncating the pipeline kills apksigner mid-run
# and turns a successful verification into a non-zero exit code.
$verifyOut = & "$($buildTools.FullName)\apksigner.bat" verify --verbose $final 2>&1 | Out-String
$verifyExit = $LASTEXITCODE
($verifyOut -split "`n" | Select-Object -First 3) -join "`n"
if ($verifyExit -ne 0) { Fail 'signature verification failed.' }

# ---- 6. report -------------------------------------------------------------
Write-Host "`n[6/6] done."
Write-Host ("APK: {0}  ({1} MB)" -f $final, [math]::Round((Get-Item $final).Length / 1MB, 2)) -ForegroundColor Green
Write-Host 'Copy it to the phone, allow "install unknown apps", then enter the server'
Write-Host 'address on first launch (e.g. http://192.168.1.20:3000).'
