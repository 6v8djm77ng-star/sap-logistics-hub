# Updates SAP Logistics Hub to the latest version
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Continue'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$Host.UI.RawUI.WindowTitle = 'Update SAP Logistics Hub'

function W($text, $color='White') { Write-Host $text -ForegroundColor $color }

Clear-Host
W ""
W "==============================================================" Cyan
W "         SAP Logistics Hub - Update                            " Cyan
W "==============================================================" Cyan
W ""

# Stop server first
W "[1/5] Stopping server..." Yellow
& (Join-Path $PSScriptRoot 'stop-app.ps1')

# Git pull if repo exists
if (Test-Path (Join-Path $projectRoot '.git')) {
    W ""
    W "[2/5] Pulling latest code..." Yellow
    Push-Location $projectRoot
    & git pull 2>&1 | Out-Host
    Pop-Location
} else {
    W ""
    W "[2/5] No git repo - skipping pull" DarkGray
}

# Backend deps
W ""
W "[3/5] Updating backend dependencies..." Yellow
Push-Location (Join-Path $projectRoot 'backend')
& npm install --no-audit --no-fund 2>&1 | Select-Object -Last 3 | Out-Host
Pop-Location

# Frontend deps + build
W ""
W "[4/5] Updating frontend dependencies..." Yellow
Push-Location (Join-Path $projectRoot 'frontend')
& npm install --no-audit --no-fund 2>&1 | Select-Object -Last 3 | Out-Host

W ""
W "[5/5] Building frontend..." Yellow
& npx vite build 2>&1 | Select-Object -Last 3 | Out-Host
Pop-Location

W ""
W "==============================================================" Green
W "              UPDATE COMPLETE                                  " Green
W "==============================================================" Green
W ""
W "Launch the app again to see the changes." Cyan
W ""
Read-Host "Press Enter to close"
