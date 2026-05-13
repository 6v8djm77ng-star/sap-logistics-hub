# ============================================================================
# SAP Logistics Hub - Production Installation Script
# ----------------------------------------------------------------------------
# Run this ONCE on the production server. It will:
#   1. Verify prerequisites (Node.js, SQL Server connectivity)
#   2. Install backend + frontend dependencies
#   3. Configure .env interactively
#   4. Run database migrations
#   5. Build frontend for production
#   6. Configure Windows service (via NSSM if available) or PM2
#
# Usage:  powershell -ExecutionPolicy Bypass -File install.ps1
# ============================================================================

$ErrorActionPreference = 'Stop'

Write-Host "`n===============================================" -ForegroundColor Cyan
Write-Host "  🚚 SAP Logistics Hub - Installer" -ForegroundColor Cyan
Write-Host "===============================================`n" -ForegroundColor Cyan

# ----------------------------------------------------------------------------
# Step 1: Prerequisites
# ----------------------------------------------------------------------------
Write-Host "[1/6] בדיקת דרישות מערכת..." -ForegroundColor Yellow

try {
    $nodeVer = & node --version
    Write-Host "  ✓ Node.js $nodeVer" -ForegroundColor Green

    $major = [int]($nodeVer -replace 'v([0-9]+)\..*', '$1')
    if ($major -lt 20) {
        Write-Host "  ⚠  Node.js 20+ נדרש, נמצא $nodeVer" -ForegroundColor Red
        Write-Host "     הורד מ: https://nodejs.org" -ForegroundColor Yellow
        exit 1
    }
} catch {
    Write-Host "  ✗ Node.js לא מותקן. הורד מ: https://nodejs.org" -ForegroundColor Red
    exit 1
}

try {
    & npm --version | Out-Null
    Write-Host "  ✓ npm זמין" -ForegroundColor Green
} catch {
    Write-Host "  ✗ npm לא זמין" -ForegroundColor Red
    exit 1
}

# ----------------------------------------------------------------------------
# Step 2: Install dependencies
# ----------------------------------------------------------------------------
Write-Host "`n[2/6] התקנת חבילות..." -ForegroundColor Yellow

Push-Location backend
if (-not (Test-Path node_modules)) {
    Write-Host "  → מתקין backend (זה ייקח דקה)..." -ForegroundColor Cyan
    & npm install --production --no-audit --no-fund
} else {
    Write-Host "  ✓ backend כבר מותקן" -ForegroundColor Green
}
Pop-Location

Push-Location frontend
if (-not (Test-Path node_modules)) {
    Write-Host "  → מתקין frontend (זה ייקח דקה)..." -ForegroundColor Cyan
    & npm install --no-audit --no-fund
} else {
    Write-Host "  ✓ frontend כבר מותקן" -ForegroundColor Green
}
Pop-Location

# ----------------------------------------------------------------------------
# Step 3: Configure .env
# ----------------------------------------------------------------------------
Write-Host "`n[3/6] הגדרת משתני סביבה..." -ForegroundColor Yellow

$envPath = "backend\.env"
if (Test-Path $envPath) {
    Write-Host "  ℹ  backend\.env כבר קיים" -ForegroundColor Cyan
    $overwrite = Read-Host "  האם לחולל קובץ חדש? (y/N)"
    if ($overwrite -ne 'y') {
        Write-Host "  → משאיר את הקובץ הקיים" -ForegroundColor Green
    } else {
        Copy-Item "backend\.env.example" $envPath -Force
        Write-Host "  ✓ נוצר backend\.env מתבנית" -ForegroundColor Green
    }
} else {
    Copy-Item "backend\.env.example" $envPath
    Write-Host "  ✓ נוצר backend\.env מתבנית" -ForegroundColor Green
}

# Generate a strong JWT_SECRET if still placeholder
$envContent = Get-Content $envPath -Raw
if ($envContent -match 'JWT_SECRET=change-me-in-production-please') {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = [Convert]::ToBase64String($bytes)
    $envContent = $envContent -replace 'JWT_SECRET=change-me-in-production-please', "JWT_SECRET=$secret"
    Set-Content $envPath $envContent
    Write-Host "  ✓ חולל JWT_SECRET אקראי חדש" -ForegroundColor Green
}

Write-Host ""
Write-Host "  ⚠  עליך לערוך את $envPath ולמלא:" -ForegroundColor Yellow
Write-Host "     - LOGISTICS_SQL_* (מסד נתונים שלנו - חובה)" -ForegroundColor Yellow
Write-Host "     - SAP_SL_* + SAP_SQL_* (אפשר לדלג - ניתן להגדיר מאוחר יותר בממשק)" -ForegroundColor Yellow
Write-Host ""
$openEnv = Read-Host "  האם לפתוח את .env לעריכה עכשיו? (Y/n)"
if ($openEnv -ne 'n') {
    Start-Process notepad.exe $envPath -Wait
    Write-Host "  ✓ עריכה נשמרה" -ForegroundColor Green
}

# ----------------------------------------------------------------------------
# Step 4: Database migrations
# ----------------------------------------------------------------------------
Write-Host "`n[4/6] הרצת migrations..." -ForegroundColor Yellow

Push-Location backend
try {
    & node src/db/migrate.js
    Write-Host "  ✓ Migrations הושלמו" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Migration נכשל: $_" -ForegroundColor Red
    Write-Host "     בדוק את LOGISTICS_SQL_* ב-.env וש-SQL Server נגיש" -ForegroundColor Yellow
    Pop-Location
    exit 1
}
Pop-Location

# ----------------------------------------------------------------------------
# Step 5: Build frontend
# ----------------------------------------------------------------------------
Write-Host "`n[5/6] Build frontend..." -ForegroundColor Yellow

Push-Location frontend
try {
    & npx vite build
    Write-Host "  ✓ Build הושלם → frontend\dist\" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Build נכשל: $_" -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

# ----------------------------------------------------------------------------
# Step 6: Service setup
# ----------------------------------------------------------------------------
Write-Host "`n[6/6] הגדרת service..." -ForegroundColor Yellow

$pm2Installed = $null
try { $pm2Installed = & pm2 --version 2>$null } catch {}

if (-not $pm2Installed) {
    Write-Host "  ⚠  PM2 לא מותקן" -ForegroundColor Yellow
    $installPm2 = Read-Host "  התקן PM2 גלובלית לניהול process? (Y/n)"
    if ($installPm2 -ne 'n') {
        & npm install -g pm2 pm2-windows-startup
        Write-Host "  ✓ PM2 הותקן" -ForegroundColor Green
        $pm2Installed = $true
    }
}

if ($pm2Installed) {
    Write-Host "  → מפעיל שירותים דרך PM2..." -ForegroundColor Cyan
    & pm2 start ecosystem.config.cjs
    & pm2 save
    Write-Host "  ✓ השירותים רצים ברקע" -ForegroundColor Green
    Write-Host ""
    Write-Host "  לניהול:" -ForegroundColor Gray
    Write-Host "    pm2 status        - סטטוס" -ForegroundColor Gray
    Write-Host "    pm2 logs          - לוגים" -ForegroundColor Gray
    Write-Host "    pm2 restart all   - restart" -ForegroundColor Gray
    Write-Host "    pm2 stop all      - עצירה" -ForegroundColor Gray
}

# ----------------------------------------------------------------------------
# Done
# ----------------------------------------------------------------------------
Write-Host "`n===============================================" -ForegroundColor Green
Write-Host "  ✓ ההתקנה הושלמה בהצלחה!" -ForegroundColor Green
Write-Host "===============================================" -ForegroundColor Green
Write-Host ""
Write-Host "🌐 המערכת זמינה ב:" -ForegroundColor Cyan
Write-Host "   http://localhost:4000  (API)" -ForegroundColor White
if (Test-Path "frontend\dist") {
    Write-Host "   http://localhost:4000  (Frontend - served by backend in prod)" -ForegroundColor White
}
Write-Host ""
Write-Host "👤 כניסה ראשונה:" -ForegroundColor Cyan
Write-Host "   משתמש: admin" -ForegroundColor White
Write-Host "   סיסמה: בקש ממנהל המערכת. הסיסמה אינה מתועדת בקוד." -ForegroundColor White
Write-Host "   🔐 אם זוהי התקנה ראשונה - אפס את הסיסמה דרך הממשק מיד אחרי הכניסה." -ForegroundColor Yellow
Write-Host ""
Write-Host "🔌 לחיבור SAP:" -ForegroundColor Cyan
Write-Host "   1. התחבר כ-admin" -ForegroundColor White
Write-Host "   2. עבור ל'הגדרות + SAP' בתפריט" -ForegroundColor White
Write-Host "   3. לחץ 'בדוק חיבור' - תקבל משוב מדויק לכל בעיה" -ForegroundColor White
Write-Host ""
