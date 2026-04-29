# Start KTV dev environment locally (Windows PowerShell).
# Launches FastAPI (port 8000) and Next.js (port 3000) in two new windows.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "🎤 Starting KTV dev environment..." -ForegroundColor Cyan
Write-Host "Project root: $root"

# 1. API
$apiCmd = "cd `"$root\api`"; python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"
Start-Process pwsh -ArgumentList "-NoExit", "-Command", $apiCmd
Write-Host "  → API window started (http://localhost:8000)" -ForegroundColor Green

Start-Sleep -Seconds 2

# 2. Web
$webCmd = "cd `"$root\web`"; if (-not (Test-Path node_modules)) { npm install }; npm run dev"
Start-Process pwsh -ArgumentList "-NoExit", "-Command", $webCmd
Write-Host "  → Web window started (http://localhost:3000)" -ForegroundColor Green

Write-Host "`nLAN URL for phones:" -ForegroundColor Yellow
& "$PSScriptRoot\lan-ip.ps1"
