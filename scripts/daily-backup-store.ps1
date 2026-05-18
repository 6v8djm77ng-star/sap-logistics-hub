# scripts/daily-backup-store.ps1
#
# Daily backup of backend/data/store.json. Designed to run via Windows
# Task Scheduler at 03:00 every day. Atomic copy (no PM2 stop) - Node's
# fs.writeFileSync in persistentStore writes to a temp file and renames
# (write-rename), so a copy at any moment yields either the previous
# committed state or the brand-new state, never a torn write.
#
# Layout:
#   backend/data/store.json                                     ← source
#   backend/data/backups/store-YYYYMMDD-HHmmss.json             ← created here
#   logs/store-backup.log                                       ← appended
#
# Retention: 30 days. Anything older is purged at the end of every run.
#
# Safety guards:
#   - refuses to copy if source < 100 KB (truncation guard)
#   - validates the backup with JSON.parse equivalent before keeping it
#   - never deletes the source store.json
#   - never deletes manual backups (file patterns store.PRE-* are kept
#     forever - only store-YYYYMMDD-HHmmss.json files are pruned)
#
# Exit codes:
#   0  success (or no-op if source unchanged this hour)
#   1  source missing
#   2  source too small (truncation guard tripped)
#   3  invalid JSON in source
#   4  copy failed
#   5  post-copy JSON validation failed (backup is bad, kept anyway with .CORRUPT suffix)
#
# Run manually:
#   powershell -ExecutionPolicy Bypass -File scripts\daily-backup-store.ps1

$ErrorActionPreference = 'Stop'

# --- paths -----------------------------------------------------------------
$repoRoot   = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$sourcePath = Join-Path $repoRoot 'backend\data\store.json'
$backupDir  = Join-Path $repoRoot 'backend\data\backups'
$logDir     = Join-Path $repoRoot 'logs'
$logPath    = Join-Path $logDir   'store-backup.log'

$minSizeBytes  = 100KB
$retentionDays = 30

# --- helpers ---------------------------------------------------------------
function Write-Log {
  param([string]$Level, [string]$Message)
  $ts   = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
  $line = "[$ts] [$Level] $Message"
  Write-Output $line
  try {
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    Add-Content -Path $logPath -Value $line -Encoding UTF8
  } catch {
    # If log can't be written, don't abort - the main task is the backup
    Write-Output "[$ts] [WARN] log write failed: $($_.Exception.Message)"
  }
}

# --- pre-flight ------------------------------------------------------------
if (-not (Test-Path $sourcePath)) {
  Write-Log 'ERROR' "store.json missing: $sourcePath"
  exit 1
}

$sourceInfo = Get-Item $sourcePath
if ($sourceInfo.Length -lt $minSizeBytes) {
  Write-Log 'ERROR' "store.json too small ($($sourceInfo.Length) bytes < $minSizeBytes) - truncation guard"
  exit 2
}

# Validate source is parseable JSON before copying
try {
  $null = Get-Content $sourcePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
} catch {
  Write-Log 'ERROR' "source store.json is invalid JSON: $($_.Exception.Message)"
  exit 3
}

if (-not (Test-Path $backupDir)) {
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}

# --- copy ------------------------------------------------------------------
$timestamp  = (Get-Date).ToString('yyyyMMdd-HHmmss')
$backupName = "store-$timestamp.json"
$backupPath = Join-Path $backupDir $backupName

try {
  Copy-Item -Path $sourcePath -Destination $backupPath -Force
} catch {
  Write-Log 'ERROR' "copy failed: $($_.Exception.Message)"
  exit 4
}

# --- verify the copy is valid JSON ----------------------------------------
try {
  $null = Get-Content $backupPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
} catch {
  $corruptPath = $backupPath + '.CORRUPT'
  Rename-Item -Path $backupPath -NewName ([System.IO.Path]::GetFileName($corruptPath)) -Force
  Write-Log 'ERROR' "post-copy JSON validation failed - renamed to ${corruptPath} ::: $($_.Exception.Message)"
  exit 5
}

$backupSizeKB = [math]::Round((Get-Item $backupPath).Length / 1KB, 1)
Write-Log 'OK' "backup created: $backupName ($backupSizeKB KB)"

# --- retention purge -------------------------------------------------------
# Only prunes our own pattern (store-YYYYMMDD-HHmmss.json). Manual backups
# created by other scripts (store.PRE-*.json) are NEVER touched.
$cutoff = (Get-Date).AddDays(-$retentionDays)
$pruned = 0
$keptOld = 0
Get-ChildItem -Path $backupDir -Filter 'store-*.json' | ForEach-Object {
  if ($_.Name -match '^store-\d{8}-\d{6}\.json$') {
    if ($_.LastWriteTime -lt $cutoff) {
      try {
        Remove-Item $_.FullName -Force
        $pruned++
      } catch {
        Write-Log 'WARN' "could not delete old backup $($_.Name): $($_.Exception.Message)"
      }
    } else {
      $keptOld++
    }
  }
}

Write-Log 'OK' "retention: pruned $pruned old daily backups, kept $keptOld within $retentionDays-day window"
exit 0
