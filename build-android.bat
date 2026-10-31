@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo ============================================
echo   eNote Android APK build
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-android.ps1"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
    echo ============================================
    echo   BUILD FAILED - see the messages above
    echo ============================================
) else (
    echo ============================================
    echo   BUILD OK - APK is in dist-android\
    echo ============================================
)
pause
exit /b %RC%