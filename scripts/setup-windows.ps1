# CodeKeeper Windows Service Setup (via Scheduled Task)
# Run as Administrator: powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1

$ErrorActionPreference = "Stop"

$CornDir = Resolve-Path "$PSScriptRoot\.."
$TaskName = "CornReview"
$LogDir = "$env:USERPROFILE\Logs\codekeeper"

Write-Host "=== CodeKeeper Windows Service Setup ===" -ForegroundColor Cyan
Write-Host "CodeKeeper directory: $CornDir"

# Ensure log directory exists
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Check if Node.js is available
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
    Write-Error "Node.js not found in PATH. Please install Node.js >= 22 first."
    exit 1
}

Write-Host "Node.js found: $NodePath"

# Remove existing task if present
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Create scheduled task (runs every 30 minutes)
$Action = New-ScheduledTaskAction -Execute $NodePath -Argument "dist/index.js --daemon" -WorkingDirectory $CornDir

$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType ServiceAccount -RunLevel Highest

$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RunOnlyIfNetworkAvailable

# Environment variables
$EnvVars = @{
    CODEKEEPER_CONFIG = "$CornDir\config\projects.yaml"
    CODEKEEPER_LOG_DIR = $LogDir
    PATH = $env:PATH
}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null

Write-Host "`n✅ CodeKeeper scheduled task installed!" -ForegroundColor Green
Write-Host "   Task name: $TaskName"
Write-Host "   Schedule: Every 30 minutes"
Write-Host "   Logs: $LogDir"
Write-Host ""
Write-Host "Commands:" -ForegroundColor Yellow
Write-Host "   Start:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "   Stop:   Stop-ScheduledTask -TaskName $TaskName"
Write-Host "   Remove: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host "   Logs:   Get-Content $LogDir\codekeeper.log -Wait"
