# =============================================================================
# Store integrity check for sap-logistics.
#
# Read-only inspection of backend/data/store.json — does NOT touch PM2 and
# does NOT mutate anything. Safe to run any time.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/check-store-integrity.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/check-store-integrity.ps1 -StorePath <path>
#
# Exit codes:
#   0  healthy (above min size, parseable, has runs)
#   1  store.json missing
#   2  store.json below min size (likely the wipe bug fired)
#   3  store.json unparseable JSON
# =============================================================================

param(
  [string]$StorePath = $null
)

$ErrorActionPreference = 'Stop'

$REPO_ROOT = Split-Path -Parent $PSScriptRoot
$STORE = if ($StorePath) { $StorePath } else { Join-Path $REPO_ROOT 'backend\data\store.json' }
$DATA_DIR = Split-Path -Parent $STORE
$MIN_SIZE_BYTES = 100KB

if (-not (Test-Path $STORE)) {
    Write-Host "store.json: MISSING at $STORE" -ForegroundColor Red
    exit 1
}

$item = Get-Item $STORE
$size = $item.Length

# Try to parse — corruption is treated as worse than just "small".
$data = $null
try {
    $raw = Get-Content $STORE -Raw -Encoding UTF8
    $data = $raw | ConvertFrom-Json
} catch {
    Write-Host "store.json: UNPARSEABLE JSON" -ForegroundColor Red
    Write-Host "  parse error: $($_.Exception.Message)"
    Write-Host "  size: $([math]::Round($size/1KB,1)) KB"
    exit 3
}

$counts = @{
    users     = if ($data.users)     { $data.users.Count }     else { 0 }
    drivers   = if ($data.drivers)   { $data.drivers.Count }   else { 0 }
    zones     = if ($data.zones)     { $data.zones.Count }     else { 0 }
    runs      = if ($data.runs)      { $data.runs.Count }      else { 0 }
    stops     = if ($data.stops)     { $data.stops.Count }     else { 0 }
    runOrders = if ($data.runOrders) { $data.runOrders.Count } else { 0 }
}

# Latest backup
$backups = Get-ChildItem -Path $DATA_DIR -Filter 'store.backup.*.json' -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending
$latest = $backups | Select-Object -First 1

# Report
Write-Host ""
Write-Host "=== store.json integrity ==="
Write-Host ("  path:           {0}" -f $STORE)
Write-Host ("  size:           {0:N1} KB ({1} bytes)" -f ($size / 1KB), $size)
Write-Host ("  modified:       {0}" -f $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))

$healthFlag = "OK"
if ($size -lt $MIN_SIZE_BYTES) {
    $healthFlag = ("BELOW MIN ({0:N1} KB < {1:N1} KB) — likely the wipe bug" -f ($size / 1KB), ($MIN_SIZE_BYTES / 1KB))
}
Write-Host ("  health:         {0}" -f $healthFlag) -ForegroundColor $(if ($healthFlag -eq 'OK') { 'Green' } else { 'Red' })

Write-Host ""
Write-Host "=== entity counts ==="
Write-Host ("  users:          {0}" -f $counts.users)
Write-Host ("  drivers:        {0}" -f $counts.drivers)
Write-Host ("  zones:          {0}" -f $counts.zones)
Write-Host ("  runs:           {0}" -f $counts.runs)
Write-Host ("  stops:          {0}" -f $counts.stops)
Write-Host ("  runOrders:      {0}" -f $counts.runOrders)

Write-Host ""
Write-Host "=== backups ==="
Write-Host ("  total:          {0}" -f $backups.Count)
if ($latest) {
    Write-Host ("  latest:         {0}" -f $latest.Name)
    Write-Host ("  latest size:    {0:N1} KB" -f ($latest.Length / 1KB))
    Write-Host ("  latest mtime:   {0}" -f $latest.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
} else {
    Write-Host "  (no store.backup.*.json files found)"
}
Write-Host ""

if ($size -lt $MIN_SIZE_BYTES) {
    exit 2
}
exit 0
