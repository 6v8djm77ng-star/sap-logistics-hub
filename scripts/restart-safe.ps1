# =============================================================================
# Safe PM2 restart guard for sap-logistics.
#
# Background:
#   On 2026-05-14 22:43 a `pm2 restart sap-logistics --update-env` (the second
#   restart of a JWT_SECRET rotation) silently truncated backend/data/store.json
#   from ~2.5 MB / 69 runs down to 3 KB / 0 runs. The cause is not yet isolated,
#   but a plain `pm2 restart` does NOT reproduce the wipe — only --update-env
#   restarts that cross an env-var change do. See cowork/INCIDENTS.md.
#
# This script makes EVERY operator-initiated restart safe by:
#   1. Refusing to run if store.json is missing or below a minimum size.
#   2. Taking a timestamped backup BEFORE touching PM2.
#   3. Running `pm2 restart sap-logistics --update-env`.
#   4. Re-checking the store post-restart (size + entity counts).
#   5. If the post-restart store is damaged, AUTO-RESTORING from the backup,
#      issuing a plain `pm2 restart` (NOT --update-env, since that's what broke
#      it), and exiting with a non-zero code so the caller knows recovery ran.
#
# Usage (operator):
#   powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1
#
# Optional flags for testing:
#   -StorePath <path>   Override store path (for unit-testing against a fake
#                       file; default is backend/data/store.json from repo root).
#   -DryRun             Run preflight + backup, skip the actual PM2 restart and
#                       post-restart checks. Use to validate the script against
#                       a crafted test store without touching production PM2.
#
# Exit codes:
#   0  success — restart completed, store intact
#   1  store.json not found
#   2  store.json below minimum size (refuse to restart)
#   3  backup verification failed (size mismatch)
#   4  store.json disappeared after restart (auto-recovered)
#   5  store.json shrunk below minimum after restart (auto-recovered)
#   6  runs count dropped suspiciously after restart (auto-recovered)
#   7  server not responding after restart
# =============================================================================

param(
  [string]$StorePath = $null,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Force English console output — Hebrew status messages would render as
# mojibake in Windows PowerShell 5.1 with cp862. The store and the data
# stay in UTF-8; only this script's log lines are ASCII.
$ProgressPreference = 'SilentlyContinue'

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
$REPO_ROOT = Split-Path -Parent $PSScriptRoot

# Resolve the store path. Priority: explicit -StorePath > LOGISTICS_STORE_PATH
# in backend/.env (live data was moved OUT of OneDrive) > the legacy default.
# Single source of truth with the app (persistentStore.js reads the same var).
function Get-ConfiguredStorePath {
    param([string]$RepoRoot)
    $envFile = Join-Path $RepoRoot 'backend\.env'
    if (Test-Path $envFile) {
        $m = Select-String -Path $envFile -Pattern '^\s*LOGISTICS_STORE_PATH\s*=\s*(.+?)\s*$' |
             Select-Object -First 1
        if ($m) {
            $val = $m.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'")
            if ($val) { return $val }
        }
    }
    return (Join-Path $RepoRoot 'backend\data\store.json')
}
$STORE = if ($StorePath) { $StorePath } else { Get-ConfiguredStorePath -RepoRoot $REPO_ROOT }
$DATA_DIR = Split-Path -Parent $STORE
$PM2_NAME = 'sap-logistics'
$MIN_SIZE_BYTES = 100KB     # well below the expected ~2 MB of a healthy store
$MAX_RUNS_DROP = 5          # runs may legitimately fluctuate by a few

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
function Log($msg) { Write-Host "[restart-safe] $msg" }
function LogErr($msg) { Write-Host "[restart-safe] ERROR: $msg" -ForegroundColor Red }
function LogWarn($msg) { Write-Host "[restart-safe] WARN:  $msg" -ForegroundColor Yellow }
function LogOk($msg) { Write-Host "[restart-safe] OK:    $msg" -ForegroundColor Green }

function Get-StoreStats {
    param([string]$Path)
    $item = Get-Item $Path
    $raw = Get-Content $Path -Raw -Encoding UTF8
    $data = $raw | ConvertFrom-Json
    return [pscustomobject]@{
        Size  = $item.Length
        Runs  = if ($data.runs)  { $data.runs.Count }  else { 0 }
        Users = if ($data.users) { $data.users.Count } else { 0 }
        Drivers = if ($data.drivers) { $data.drivers.Count } else { 0 }
    }
}

function Restore-FromBackup {
    param([string]$BackupPath)
    LogWarn "Restoring store.json from backup: $(Split-Path -Leaf $BackupPath)"
    & pm2 stop $PM2_NAME 2>&1 | Out-Null
    Copy-Item $BackupPath $STORE -Force
    Start-Sleep -Seconds 1
    LogWarn "Starting PM2 WITHOUT --update-env (plain restart) to avoid the wipe bug"
    & pm2 start $PM2_NAME 2>&1 | Out-Null
    Start-Sleep -Seconds 4
}

# -----------------------------------------------------------------------------
# STEP 1: preflight
# -----------------------------------------------------------------------------
Log "================================================================"
Log "Safe restart guard — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Log "Target: $STORE"
if ($DryRun) { Log "Mode: DRY-RUN (PM2 will NOT be touched)" }
Log "================================================================"

Log "STEP 1: preflight"

if (-not (Test-Path $STORE)) {
    LogErr "store.json not found at $STORE"
    exit 1
}

$preStats = Get-StoreStats -Path $STORE
Log ("  size:    {0:N1} KB ({1} bytes)" -f ($preStats.Size / 1KB), $preStats.Size)
Log ("  runs:    {0}" -f $preStats.Runs)
Log ("  users:   {0}" -f $preStats.Users)
Log ("  drivers: {0}" -f $preStats.Drivers)

if ($preStats.Size -lt $MIN_SIZE_BYTES) {
    LogErr ("store.json is suspiciously small: {0:N1} KB < {1:N1} KB minimum" -f ($preStats.Size / 1KB), ($MIN_SIZE_BYTES / 1KB))
    LogErr "Refusing to restart. Investigate manually before continuing."
    LogErr "Likely-good backups in $DATA_DIR\store.backup.*.json"
    exit 2
}

LogOk "Preflight passed"

# -----------------------------------------------------------------------------
# STEP 2: backup
# -----------------------------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$backupName = "store.backup.PRE-RESTART-$stamp.json"
$backup = Join-Path $DATA_DIR $backupName

Log "STEP 2: backup -> $backupName"
Copy-Item $STORE $backup

$backupSize = (Get-Item $backup).Length
if ($backupSize -ne $preStats.Size) {
    LogErr ("Backup size mismatch (source {0}, copy {1})" -f $preStats.Size, $backupSize)
    Remove-Item $backup -ErrorAction SilentlyContinue
    exit 3
}
LogOk ("Backup verified: {0:N1} KB" -f ($backupSize / 1KB))

# -----------------------------------------------------------------------------
# STEP 3: PM2 restart
# -----------------------------------------------------------------------------
if ($DryRun) {
    Log "STEP 3: skipped (DRY-RUN)"
    Log "STEP 4: skipped (DRY-RUN)"
    Log "STEP 5: skipped (DRY-RUN)"
    LogOk "DRY-RUN complete. Backup left at $backupName"
    exit 0
}

# (2026-05-28) Use `pm2 reload ecosystem.config.cjs` instead of plain
# `pm2 restart` so the .env file is re-read on every restart. Plain
# `pm2 restart --update-env` only refreshes env from the current PM2
# session — it does NOT re-execute ecosystem.config.cjs, so backend/.env
# edits silently never reach the child. Discovered when a CORS_ORIGINS
# update appeared in .env but the running process kept blocking the new
# origin. `pm2 reload` re-executes the ecosystem file → fs.readFileSync
# of backend/.env runs → child gets the fresh env. Auto-recovery from
# the wipe bug below still applies if the reload damages the store.
$ECOSYSTEM = Join-Path $REPO_ROOT 'ecosystem.config.cjs'
Log "STEP 3: pm2 reload $ECOSYSTEM --only $PM2_NAME --update-env"
& pm2 reload $ECOSYSTEM --only $PM2_NAME --update-env 2>&1 | Out-Null
Start-Sleep -Seconds 5

# -----------------------------------------------------------------------------
# STEP 4: post-restart verification
# -----------------------------------------------------------------------------
Log "STEP 4: post-restart verification"

if (-not (Test-Path $STORE)) {
    LogErr "store.json DISAPPEARED after restart"
    Restore-FromBackup -BackupPath $backup
    LogErr "Recovery complete. Old behaviour suggests --update-env wiped the store; future restarts should avoid --update-env unless env actually changed."
    exit 4
}

$postStats = Get-StoreStats -Path $STORE
Log ("  size:    {0:N1} KB (was {1:N1} KB)" -f ($postStats.Size / 1KB), ($preStats.Size / 1KB))
Log ("  runs:    {0} (was {1})" -f $postStats.Runs, $preStats.Runs)
Log ("  users:   {0} (was {1})" -f $postStats.Users, $preStats.Users)

if ($postStats.Size -lt $MIN_SIZE_BYTES) {
    LogErr ("store.json shrunk below minimum after restart: {0:N1} KB < {1:N1} KB" -f ($postStats.Size / 1KB), ($MIN_SIZE_BYTES / 1KB))
    Restore-FromBackup -BackupPath $backup
    LogErr "Recovery complete. The --update-env restart truncated the store."
    exit 5
}

if ($postStats.Runs -lt ($preStats.Runs - $MAX_RUNS_DROP)) {
    LogErr ("runs count dropped by more than {0}: {1} -> {2}" -f $MAX_RUNS_DROP, $preStats.Runs, $postStats.Runs)
    Restore-FromBackup -BackupPath $backup
    LogErr "Recovery complete."
    exit 6
}

LogOk "Store intact post-restart"

# -----------------------------------------------------------------------------
# STEP 5: HTTP liveness
# -----------------------------------------------------------------------------
Log "STEP 5: HTTP liveness"

$httpCode = $null
try {
    # /api/auth/me returns 401 unauthenticated — that's a valid liveness signal.
    # /api/health returns 404 in demo mode, so we don't use it here.
    $code = & curl.exe -s -o NUL -w '%{http_code}' --max-time 10 'http://localhost:4000/api/auth/me' 2>&1
    $httpCode = [int]$code
} catch {
    LogErr "curl failed: $_"
    exit 7
}

if ($httpCode -lt 200 -or $httpCode -ge 500) {
    LogErr "Server returned HTTP $httpCode — not healthy"
    exit 7
}
LogOk "/api/auth/me -> HTTP $httpCode (server is responding)"

# -----------------------------------------------------------------------------
# DONE
# -----------------------------------------------------------------------------
Log "================================================================"
LogOk "Safe restart COMPLETE"
Log ("Backup retained: {0}" -f $backupName)
Log "================================================================"
exit 0
