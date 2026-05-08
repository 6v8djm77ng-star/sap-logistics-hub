# ============================================================================
# SAP Logistics Hub - Desktop App Launcher
# ============================================================================

$ErrorActionPreference = 'Continue'

# Ensure UTF-8 console output
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$backendPath = Join-Path $projectRoot 'backend'
$port = 4000
$url = "http://localhost:$port"

$Host.UI.RawUI.WindowTitle = 'SAP Logistics Hub'

function W($text, $color='White') { Write-Host $text -ForegroundColor $color }

Clear-Host
W ""
W "==============================================================" Cyan
W "         SAP Logistics Hub - Distribution System              " Cyan
W "==============================================================" Cyan
W ""

# -------- Check Node.js --------
try {
    $nodeVer = & node --version 2>$null
    W "  [OK] Node.js $nodeVer" Green
} catch {
    W "  [ERROR] Node.js not found. Install from https://nodejs.org" Red
    Read-Host "Press Enter to exit"
    exit 1
}

# -------- Stop previous instance --------
W ""
W "[1/4] Stopping any previous instance..." Yellow
$old = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($old) {
    $old | ForEach-Object {
        try {
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
            W "      Killed process $($_.OwningProcess)" Green
        } catch {}
    }
    Start-Sleep -Seconds 1
} else {
    W "      No previous instance" Green
}

# -------- Verify frontend build --------
W ""
W "[2/4] Checking frontend build..." Yellow
$distPath = Join-Path $projectRoot 'frontend\dist\index.html'
if (-not (Test-Path $distPath)) {
    W "      Frontend not built - building now (about 30 seconds)..." Yellow
    Push-Location (Join-Path $projectRoot 'frontend')
    & npx vite build 2>&1 | Out-Null
    Pop-Location
}
W "      [OK] Frontend ready" Green

# -------- Start server --------
W ""
W "[3/4] Starting server..." Yellow
$env:NODE_ENV = 'production'

$job = Start-Process -FilePath 'node.exe' `
    -ArgumentList 'src/demo/demoServer.js' `
    -WorkingDirectory $backendPath `
    -WindowStyle Minimized `
    -PassThru

W "      [OK] Server started (PID: $($job.Id))" Green

# -------- Wait for ready --------
W ""
W "[4/4] Waiting for server to be ready..." Yellow
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $response = Invoke-WebRequest -Uri "$url/health" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Write-Host "." -NoNewline -ForegroundColor Yellow
}
W ""

if (-not $ready) {
    W "      [ERROR] Server did not respond in time" Red
    Read-Host "Press Enter to exit"
    exit 1
}

W "      [OK] Server is ready" Green

# -------- Open browser --------
W ""
W "Opening browser..." Cyan
Start-Process $url

W ""
W "==============================================================" Green
W "   SYSTEM RUNNING                                              " Green
W "                                                               " Green
W "   Local:  $url                                    " Green
W "   Login:  admin / (any password)                              " Green
W "==============================================================" Green
W ""
W "Network access (from other computers):" White
$ipv4s = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' }
foreach ($ip in $ipv4s) {
    W "   http://$($ip.IPAddress):$port" Cyan
}
W ""
W "--------------------------------------------------------------" DarkGray
W "Server running in background. This window shows live activity." DarkGray
W "To close: close this window or press Ctrl+C" DarkGray
W "--------------------------------------------------------------" DarkGray
W ""

# -------- Live monitoring --------
try {
    while ($true) {
        Start-Sleep -Seconds 30
        try {
            $h = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2 -ErrorAction Stop
            $time = (Get-Date).ToString('HH:mm:ss')
            W "[$time] System healthy" Green
        } catch {
            $time = (Get-Date).ToString('HH:mm:ss')
            W "[$time] Server not responding" Yellow
            break
        }
    }
} finally {
    W ""
    W "Stopping server..." Yellow
    try { Stop-Process -Id $job.Id -Force -ErrorAction SilentlyContinue } catch {}
    W "Server stopped." Green
}
