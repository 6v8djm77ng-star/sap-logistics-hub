# ===============================================================
# SAP Logistics Hub - Remote LAN Installer
# Creates desktop shortcuts on a SECOND computer on the same network
# pointing to the server at http://192.168.0.14:4000
# ===============================================================

$ErrorActionPreference = 'Stop'

# === SERVER ADDRESS ON THE LAN ===
$ServerUrl    = 'http://192.168.0.14:4000'
$DriverUrl    = 'http://192.168.0.14:4000/driver/login'
$AdminUrl     = 'http://192.168.0.14:4000/login'

# === DESKTOP PATH ===
$Desktop = [Environment]::GetFolderPath('Desktop')
if (-not (Test-Path $Desktop)) {
    Write-Host "Desktop path not found." -ForegroundColor Red
    exit 1
}

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host " SAP Logistics Hub - LAN Client Installer" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Server URL : $ServerUrl"   -ForegroundColor White
Write-Host "Desktop    : $Desktop"     -ForegroundColor White
Write-Host ""

function Test-Server {
    param([string]$Url)
    try {
        $req = [System.Net.WebRequest]::Create($Url)
        $req.Timeout = 5000
        $req.Method  = 'HEAD'
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch {
        return $false
    }
}

# Test connectivity
Write-Host "Testing connection to server..." -ForegroundColor Yellow
$ok = Test-Server -Url $ServerUrl
if ($ok) {
    Write-Host "  [OK] Server is reachable." -ForegroundColor Green
} else {
    Write-Host "  [WARN] Cannot reach $ServerUrl" -ForegroundColor Yellow
    Write-Host "         Make sure:" -ForegroundColor Yellow
    Write-Host "          1. Both computers are on the same network." -ForegroundColor Yellow
    Write-Host "          2. The server computer is turned on." -ForegroundColor Yellow
    Write-Host "          3. Windows Firewall on the server allows port 4000." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Continuing with shortcut creation anyway..." -ForegroundColor Yellow
}
Write-Host ""

# Create .url shortcut file (opens in default browser)
function New-UrlShortcut {
    param(
        [string]$Path,
        [string]$Url
    )
    $content = @"
[InternetShortcut]
URL=$Url
IconIndex=0
"@
    Set-Content -Path $Path -Value $content -Encoding ASCII -Force
}

# 1) Main app shortcut
$mainShortcut = Join-Path $Desktop 'SAP Logistics Hub.url'
New-UrlShortcut -Path $mainShortcut -Url $ServerUrl
Write-Host "  [OK] Created: SAP Logistics Hub.url" -ForegroundColor Green

# 2) Driver login shortcut
$driverShortcut = Join-Path $Desktop 'SAP Logistics - Driver.url'
New-UrlShortcut -Path $driverShortcut -Url $DriverUrl
Write-Host "  [OK] Created: SAP Logistics - Driver.url" -ForegroundColor Green

# 3) Admin login shortcut
$adminShortcut = Join-Path $Desktop 'SAP Logistics - Admin.url'
New-UrlShortcut -Path $adminShortcut -Url $AdminUrl
Write-Host "  [OK] Created: SAP Logistics - Admin.url" -ForegroundColor Green

Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host " Installation complete!" -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Three shortcuts created on your Desktop:" -ForegroundColor White
Write-Host "  - SAP Logistics Hub        (main system)"      -ForegroundColor Gray
Write-Host "  - SAP Logistics - Driver   (driver login)"     -ForegroundColor Gray
Write-Host "  - SAP Logistics - Admin    (admin login)"      -ForegroundColor Gray
Write-Host ""
Write-Host "Login credentials:" -ForegroundColor White
Write-Host "  Username: admin" -ForegroundColor Gray
Write-Host "  Password: admin123" -ForegroundColor Gray
Write-Host ""
Write-Host "If a shortcut does not work, contact the system owner" -ForegroundColor Yellow
Write-Host "and ask to verify port 4000 is open on the server." -ForegroundColor Yellow
Write-Host ""

Read-Host "Press Enter to exit"
