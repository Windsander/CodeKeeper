@echo off
REM CodeKeeper startup script for Windows
REM Usage: start.bat [start|register|unregister|list|status|process|history|undo]

set CODEKEEPER_DIR=%~dp0..
cd /d "%CODEKEEPER_DIR%"

if "%1"=="" set CMD=start
if not "%1"=="" set CMD=%1

if "%CMD%"=="start" (
    echo Starting CodeKeeper daemon...
    start /min cmd /c "node dist/advance/cli-entry.js start > %USERPROFILE%\Logs\codekeeper\codekeeper.log 2>&1"
    echo Daemon started. Logs: %USERPROFILE%\Logs\codekeeper\
) else (
    node dist/advance/cli-entry.js %CMD% %2 %3 %4 %5
)
