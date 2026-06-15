@echo off
REM CodeKeeper startup script for Windows
REM Usage: start.bat [run|daemon|review|learn|status]

set CODEKEEPER_DIR=%~dp0..
cd /d "%CODEKEEPER_DIR%"

if "%1"=="" set CMD=run
if not "%1"=="" set CMD=%1

if "%CMD%"=="daemon" (
    echo Starting CodeKeeper in daemon mode...
    start /min cmd /c "node dist/index.js --daemon > %USERPROFILE%\Logs\codekeeper\codekeeper.log 2>&1"
    echo Daemon started. Logs: %USERPROFILE%\Logs\codekeeper\
) else (
    node dist/index.js %CMD% %2 %3 %4 %5
)
