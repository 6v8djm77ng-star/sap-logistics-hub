# Stops SAP Logistics Hub server
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$port = 4000
function W($text, $color='White') { Write-Host $text -ForegroundColor $color }

$Host.UI.RawUI.WindowTitle = 'Stop SAP Logistics Hub'

W ""
W "Stopping SAP Logistics Hub..." Yellow

$connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $connections) {
    W "Server is not running." DarkGray
    Start-Sleep -Seconds 2
    exit 0
}

$stopped = 0
$connections | ForEach-Object {
    try {
        $proc = Get-Process -Id $_.OwningProcess -ErrorAction Stop
        W "  Stopping: $($proc.ProcessName) (PID: $($_.OwningProcess))" Yellow
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop
        $stopped++
    } catch {}
}

W ""
W "[OK] Stopped $stopped process(es). System is down." Green
W ""
Start-Sleep -Seconds 2
