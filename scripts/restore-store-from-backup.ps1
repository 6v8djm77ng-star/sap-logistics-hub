# scripts/restore-store-from-backup.ps1
#
# Restores a backup file over the live store.json. Used when:
#   - store.json got corrupted by a buggy script
#   - someone deleted records by mistake
#   - need to roll back to a known-good state
#
# Flow:
#   1. Validates the chosen backup is a real file + valid JSON
#   2. Saves the CURRENT store.json as store.PRE-RESTORE-<ts>.json
#      (so the restore itself is reversible)
#   3. Stops PM2 sap-logistics
#   4. Copies the backup over store.json
#   5. Starts PM2 sap-logistics
#   6. Waits for HTTP liveness (401 on /api/auth/me)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\restore-store-from-backup.ps1 store-20260518-030000.json
#
# Exit codes:
#   0  restore succeeded + server back online
#   1  backup path missing or invalid
#   2  backup is not valid JSON
#   3  PM2 stop failed
#   4  copy failed
#   5  PM2 start failed
#   6  liveness check failed after restart (server did not return 401 within 15s)

$ErrorActionPreference = 'Stop'

param(
  [Parameter(Mandatory=$true)]
  [string]$BackupName
)

$repoRoot   = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$sourcePath = Join-Path $repoRoot 'backend\data\store.json'
$backupDir  = Join-Path $repoRoot 'backend\data\backups'
$backupPath = if ([System.IO.Path]::IsPathRooted($BackupName)) {
  $BackupName
} else {
  Join-Path $backupDir $BackupName
}

function Log { param([string]$Level, [string]$Message)
  $ts = (Get-Date).ToString('HH:mm:ss')
  Write-Output "[$ts] [$Level] $Message"
}

# --- pre-flight ------------------------------------------------------------
if (-not (Test-Path $backupPath)) {
  Log 'ERROR' "backup not found: $backupPath"
  exit 1
}

try {
  $null = Get-Content $backupPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
} catch {
  Log 'ERROR' "backup is not valid JSON: $($_.Exception.Message)"
  exit 2
}
Log 'OK' "backup validated: $(Split-Path $backupPath -Leaf)"

# --- save current as PRE-RESTORE ------------------------------------------
if (Test-Path $sourcePath) {
  $ts = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $preRestore = Join-Path $backupDir "store.PRE-RESTORE-$ts.json"
  Copy-Item -Path $sourcePath -Destination $preRestore -Force
  Log 'OK' "current state saved: $(Split-Path $preRestore -Leaf)"
}

# --- stop PM2 --------------------------------------------------------------
$node = "C:\Program Files\nodejs\node.exe"
$pm2  = "$env:APPDATA\npm\node_modules\pm2\bin\pm2"
Log 'INFO' "pm2 stop sap-logistics"
try {
  & $node $pm2 stop sap-logistics 2>&1 | Out-Null
} catch {
  Log 'ERROR' "pm2 stop failed: $($_.Exception.Message)"
  exit 3
}

# --- copy ------------------------------------------------------------------
try {
  Copy-Item -Path $backupPath -Destination $sourcePath -Force
  Log 'OK' "restored from $(Split-Path $backupPath -Leaf)"
} catch {
  Log 'ERROR' "copy failed: $($_.Exception.Message)"
  Log 'WARN' "attempting to start PM2 to recover"
  & $node $pm2 start sap-logistics 2>&1 | Out-Null
  exit 4
}

# --- start PM2 -------------------------------------------------------------
Log 'INFO' "pm2 start sap-logistics"
try {
  & $node $pm2 start sap-logistics 2>&1 | Out-Null
} catch {
  Log 'ERROR' "pm2 start failed: $($_.Exception.Message)"
  exit 5
}

# --- liveness --------------------------------------------------------------
Log 'INFO' "waiting for HTTP 401 on /api/auth/me ..."
$live = $false
for ($i = 1; $i -le 30; $i++) {
  try {
    Invoke-WebRequest -Uri 'http://localhost:4000/api/auth/me' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
  } catch {
    $sc = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($sc -eq 401) {
      $live = $true
      Log 'OK' "liveness up (HTTP 401) after $i attempts"
      break
    }
  }
  Start-Sleep -Milliseconds 500
}

if (-not $live) {
  Log 'ERROR' "server did not respond with 401 within ~15 seconds"
  exit 6
}

Log 'OK' "restore complete. Server is back online with restored state."
exit 0
