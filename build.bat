@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo ============================================
echo   eNote desktop build
echo ============================================
echo.

if not exist "node_modules\.bin\tauri.cmd" (
    echo [ERROR] Tauri CLI not found. Run "npm install" first.
    echo.
    pause
    exit /b 1
)

if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
) else (
    echo [WARN] Rust not found in %%USERPROFILE%%\.cargo\bin
    echo        Install it from https://rustup.rs if the build fails.
    echo.
)

taskkill /F /IM cargo.exe >nul 2>&1
taskkill /F /IM rustc.exe >nul 2>&1
if exist "src-tauri\target\release\.cargo-build-lock" (
    del /F /Q "src-tauri\target\release\.cargo-build-lock" >nul 2>&1
)

if exist "dist" rd /S /Q "dist" >nul 2>&1

echo [1/1] Building and packaging the exe...
echo       (first run takes 3-5 minutes, later runs are faster)
echo.

call "node_modules\.bin\tauri.cmd" build
if errorlevel 1 goto fail

echo.
echo ============================================
echo   BUILD OK
echo ============================================
echo   exe:       src-tauri\target\release\enote.exe
echo   installer: src-tauri\target\release\bundle\nsis\eNote_1.0.0_x64-setup.exe
echo.
echo   Close any running eNote window before installing.
echo.
pause
exit /b 0

:fail
echo.
echo ============================================
echo   BUILD FAILED - see the messages above
echo ============================================
echo.
pause
exit /b 1
