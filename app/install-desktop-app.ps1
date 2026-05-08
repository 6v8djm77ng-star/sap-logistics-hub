# ============================================================================
# SAP Logistics Hub - Desktop App Installer
# ----------------------------------------------------------------------------
# יוצר קיצורי דרך בשולחן העבודה לניהול האפליקציה:
#   🚚 SAP Logistics Hub       - הפעלה
#   ⏹  Stop SAP Logistics Hub  - עצירה
#   🔄 Update SAP Logistics Hub - עדכון
# ============================================================================

$ErrorActionPreference = 'Continue'
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')

function W($text, $color='White') { Write-Host $text -ForegroundColor $color }

Clear-Host
W ""
W "╔══════════════════════════════════════════════════╗" Cyan
W "║  התקנת קיצורי דרך - SAP Logistics Hub              ║" Cyan
W "╚══════════════════════════════════════════════════╝" Cyan
W ""

# Generate icons (PNG versions from SVG for .ico)
# Windows prefers .ico for shortcuts. We'll use PowerShell's built-in to create one.
$iconSvg = Join-Path $appDir 'icon.svg'
$iconIco = Join-Path $appDir 'icon.ico'

# If no .ico file exists, use a placeholder (PowerShell can't easily convert SVG to ICO)
# We'll use a Unicode emoji in the shortcut name instead as visual differentiator.
if (-not (Test-Path $iconIco)) {
    # Create a minimal .ico by embedding base64 - use a pre-made truck icon
    $iconBase64 = 'AAABAAEAMDAAAAEAIACoJQAAFgAAACgAAAAwAAAAYAAAAAEAIAAAAAAAgCUAAAAAAAAAAAAAAAAAAAAAAAA='
    # Actually just skip icon customization; shortcut will use default
}

$wshell = New-Object -ComObject WScript.Shell

# ---- Main shortcut: Start App ----
W "[1/3] יוצר: SAP Logistics Hub (הפעלה)..." Yellow
$startShortcut = $wshell.CreateShortcut("$desktop\🚚 SAP Logistics Hub.lnk")
$startShortcut.TargetPath = 'powershell.exe'
$startShortcut.Arguments = "-ExecutionPolicy Bypass -File `"$appDir\start-app.ps1`""
$startShortcut.WorkingDirectory = $appDir
$startShortcut.WindowStyle = 1
$startShortcut.Description = 'הפעלת מערכת הלוגיסטיקה'
$startShortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,239"  # Truck/box icon
$startShortcut.Save()
W "      ✓ נוצר בשולחן העבודה" Green

# ---- Stop shortcut ----
W ""
W "[2/3] יוצר: עצירת שרת..." Yellow
$stopShortcut = $wshell.CreateShortcut("$desktop\⏹ Stop SAP Logistics Hub.lnk")
$stopShortcut.TargetPath = 'powershell.exe'
$stopShortcut.Arguments = "-ExecutionPolicy Bypass -File `"$appDir\stop-app.ps1`""
$stopShortcut.WorkingDirectory = $appDir
$stopShortcut.WindowStyle = 1
$stopShortcut.Description = 'עצירת שרת המערכת'
$stopShortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,131"  # Stop icon
$stopShortcut.Save()
W "      ✓ נוצר בשולחן העבודה" Green

# ---- Update shortcut ----
W ""
W "[3/3] יוצר: עדכון אוטומטי..." Yellow
$updateShortcut = $wshell.CreateShortcut("$desktop\🔄 Update SAP Logistics Hub.lnk")
$updateShortcut.TargetPath = 'powershell.exe'
$updateShortcut.Arguments = "-ExecutionPolicy Bypass -File `"$appDir\update-app.ps1`""
$updateShortcut.WorkingDirectory = $appDir
$updateShortcut.WindowStyle = 1
$updateShortcut.Description = 'עדכון לגרסה אחרונה'
$updateShortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,238"  # Refresh icon
$updateShortcut.Save()
W "      ✓ נוצר בשולחן העבודה" Green

W ""
W "╔══════════════════════════════════════════════════╗" Green
W "║         ✓ התקנה הושלמה!                            ║" Green
W "╚══════════════════════════════════════════════════╝" Green
W ""
W "עכשיו בשולחן העבודה שלך יש 3 קיצורי דרך:" White
W ""
W "   🚚 SAP Logistics Hub          ← הפעלה" Cyan
W "   ⏹ Stop SAP Logistics Hub     ← עצירה" Cyan
W "   🔄 Update SAP Logistics Hub   ← עדכון" Cyan
W ""
W "פשוט דבל-קליק על האייקון ⬆ 🚚 SAP Logistics Hub" Yellow
W "זה יפעיל את המערכת ויפתח דפדפן עם המערכת." White
W ""
Read-Host "לחץ Enter לסגירה"
