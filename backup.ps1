# ============================================================================
# SAP Logistics Hub - Daily Backup Script
# ----------------------------------------------------------------------------
# Backs up:
#   1. Logistics DB to .bak file (compressed)
#   2. Uploads folder (signatures, photos) to zip
#   3. .env file (encrypted via DPAPI - only this user can decrypt)
#
# Retention:
#   - Keeps last 30 days
#   - Removes older backups automatically
#
# Schedule via Windows Task Scheduler:
#   Action:    powershell.exe
#   Arguments: -ExecutionPolicy Bypass -File C:\path\backup.ps1
#   Schedule:  Daily at 02:00 AM
# ============================================================================

param(
  [string]$BackupRoot = 'D:\Backups\LogisticsHub',
  [string]$DbName = 'SAP_Logistics_Hub',
  [string]$SqlServer = 'localhost',
  [string]$SqlUser = 'sa',
  [string]$SqlPasswordEnv = 'BACKUP_SQL_PASSWORD',  # env var name (NOT the password)
  [int]$RetentionDays = 30
)

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$logFile = Join-Path $BackupRoot "backup_$timestamp.log"

function Write-Log($msg) {
  $line = "[$((Get-Date).ToString('HH:mm:ss'))] $msg"
  Write-Host $line
  Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

# Ensure backup directory exists
if (-not (Test-Path $BackupRoot)) {
  New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
}

Write-Log "=== Starting backup: $timestamp ==="
Write-Log "Backup root: $BackupRoot"

# ----------------------------------------------------------------------------
# 1. SQL Server backup
# ----------------------------------------------------------------------------
try {
  $sqlBackupFile = Join-Path $BackupRoot "db_${DbName}_$timestamp.bak"
  $sqlPassword = [Environment]::GetEnvironmentVariable($SqlPasswordEnv, 'User')
  if (-not $sqlPassword) {
    $sqlPassword = [Environment]::GetEnvironmentVariable($SqlPasswordEnv, 'Machine')
  }
  if (-not $sqlPassword) {
    Write-Log "⚠  SQL password not found in env var '$SqlPasswordEnv'. Using Windows auth."
    $authFlag = '-E'
    $userArgs = @()
  } else {
    $authFlag = ''
    $userArgs = @('-U', $SqlUser, '-P', $sqlPassword)
  }

  $query = @"
BACKUP DATABASE [$DbName] TO DISK = N'$sqlBackupFile'
WITH COMPRESSION, CHECKSUM, INIT,
  NAME = N'$DbName-Daily-$timestamp';
"@

  Write-Log "→ Backing up DB $DbName..."
  if ($authFlag -eq '-E') {
    & sqlcmd -S $SqlServer -E -Q $query | Out-Null
  } else {
    & sqlcmd -S $SqlServer @userArgs -Q $query | Out-Null
  }

  if ($LASTEXITCODE -ne 0) {
    throw "sqlcmd exited with code $LASTEXITCODE"
  }

  $sizeMB = [Math]::Round((Get-Item $sqlBackupFile).Length / 1MB, 1)
  Write-Log "✓ DB backup complete: $sqlBackupFile ($sizeMB MB)"
} catch {
  Write-Log "✗ DB backup FAILED: $_"
  exit 1
}

# ----------------------------------------------------------------------------
# 2. Uploads folder
# ----------------------------------------------------------------------------
try {
  $uploadsPath = Join-Path $scriptRoot 'backend\uploads'
  if (Test-Path $uploadsPath) {
    $uploadsZip = Join-Path $BackupRoot "uploads_$timestamp.zip"
    Write-Log "→ Compressing uploads..."
    Compress-Archive -Path "$uploadsPath\*" -DestinationPath $uploadsZip -Force -ErrorAction Stop
    $sizeMB = [Math]::Round((Get-Item $uploadsZip).Length / 1MB, 1)
    Write-Log "✓ Uploads backed up: $uploadsZip ($sizeMB MB)"
  } else {
    Write-Log "→ No uploads folder found, skipping"
  }
} catch {
  Write-Log "⚠  Uploads backup failed: $_ (non-critical, continuing)"
}

# ----------------------------------------------------------------------------
# 3. .env file (encrypted with DPAPI - bound to this Windows user)
# ----------------------------------------------------------------------------
try {
  $envPath = Join-Path $scriptRoot 'backend\.env'
  if (Test-Path $envPath) {
    $envContent = Get-Content $envPath -Raw
    $secureString = ConvertTo-SecureString $envContent -AsPlainText -Force
    $encrypted = ConvertFrom-SecureString $secureString
    $encPath = Join-Path $BackupRoot "env_$timestamp.enc"
    Set-Content -Path $encPath -Value $encrypted
    Write-Log "✓ .env encrypted (DPAPI): $encPath"
  }
} catch {
  Write-Log "⚠  .env backup failed: $_"
}

# ----------------------------------------------------------------------------
# 4. Retention - remove old backups
# ----------------------------------------------------------------------------
try {
  $cutoff = (Get-Date).AddDays(-$RetentionDays)
  $oldFiles = Get-ChildItem -Path $BackupRoot -File | Where-Object { $_.LastWriteTime -lt $cutoff }
  if ($oldFiles) {
    Write-Log "→ Removing $($oldFiles.Count) backup(s) older than $RetentionDays days"
    foreach ($file in $oldFiles) {
      Remove-Item -Path $file.FullName -Force
    }
  }
} catch {
  Write-Log "⚠  Retention cleanup failed: $_"
}

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
$totalBackups = (Get-ChildItem -Path $BackupRoot -Filter '*.bak').Count
$totalSizeGB = [Math]::Round(((Get-ChildItem -Path $BackupRoot -File | Measure-Object -Property Length -Sum).Sum) / 1GB, 2)
Write-Log "=== Backup complete: $totalBackups DB backups, $totalSizeGB GB total ==="
