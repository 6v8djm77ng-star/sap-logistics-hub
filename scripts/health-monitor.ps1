# =============================================================================
# Access health monitor for sap-logistics.
#
# Why this exists:
#   On 2026-06-01 operator "moti" got ERR_CONNECTION_TIMED_OUT reaching the app
#   from another LAN device. Root cause: the NlaSvc (Network Location Awareness)
#   service was stopped -> Windows classified the office Ethernet as "Public" ->
#   Windows Firewall blocked inbound port 4000 (the only allow rule was scoped
#   to the Domain profile). The server itself was perfectly healthy, so nothing
#   in the app logs hinted at it. This monitor watches the *leading indicators*
#   so the next occurrence is caught in minutes, not after a support call.
#
# What it checks (read-only — it NEVER changes firewall / services / network):
#   1. NlaSvc is Running            (stopped => network falls back to Public)
#   2. No active profile is "Public" (Public => inbound 4000 blocked for LAN)
#   3. Firewall allow-rule present   (the port-4000 inbound rule, enabled)
#   4. App responds on localhost:4000 (process actually serving)
#
# On any failure it writes a timestamped ALERT (with the exact fix command) to
# the log and, if possible, pops a desktop message. It does NOT self-heal:
# restoring NlaSvc / firewall are security-surface changes left to an operator.
#
# Usage (manual):
#   powershell -ExecutionPolicy Bypass -File scripts/health-monitor.ps1
#
# Schedule (run every 5 min as the logged-in user, highest privileges):
#   $a = New-ScheduledTaskAction -Execute 'powershell.exe' `
#        -Argument '-NoProfile -ExecutionPolicy Bypass -File "<REPO>\scripts\health-monitor.ps1"'
#   $t = New-ScheduledTaskTrigger -Once -At (Get-Date) `
#        -RepetitionInterval (New-TimeSpan -Minutes 5)
#   Register-ScheduledTask -TaskName 'sap-logistics-health' -Action $a -Trigger $t `
#        -RunLevel Highest -Description 'Watches port-4000 LAN reachability preconditions'
#
# Exit codes: 0 = all healthy, 1 = one or more problems detected (alert raised).
# =============================================================================

param(
  [int]$Port = 4000,
  [string]$LogPath = $null
)

$ProgressPreference = 'SilentlyContinue'
$REPO_ROOT = Split-Path -Parent $PSScriptRoot
if (-not $LogPath) { $LogPath = Join-Path $REPO_ROOT 'backend\logs\health-monitor.log' }

function Write-Line($level, $msg) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $line = "$stamp [$level] $msg"
  try { Add-Content -Path $LogPath -Value $line -Encoding UTF8 } catch {}
  Write-Host $line
}

$problems = @()

# ---- Check 1: NlaSvc running -------------------------------------------------
try {
  $nla = Get-Service NlaSvc -ErrorAction Stop
  if ($nla.Status -ne 'Running') {
    $problems += "NlaSvc is '$($nla.Status)' (must be Running). FIX (admin): Set-Service NlaSvc -StartupType Automatic; Start-Service NlaSvc"
  }
} catch {
  $problems += "NlaSvc could not be queried: $($_.Exception.Message)"
}

# ---- Check 2: no active profile classified Public ----------------------------
# The Tailscale adapter is legitimately Private; the office Ethernet must be
# Domain/Private. Any 'Public' profile means inbound 4000 is blocked for LAN.
try {
  $public = Get-NetConnectionProfile -ErrorAction Stop |
            Where-Object { $_.NetworkCategory -eq 'Public' }
  foreach ($p in $public) {
    $problems += "Network '$($p.Name)' ($($p.InterfaceAlias)) is Public -> LAN devices blocked. FIX (admin): Set-NetConnectionProfile -InterfaceIndex $($p.InterfaceIndex) -NetworkCategory Private"
  }
} catch {
  $problems += "Get-NetConnectionProfile failed (needs a normal user context): $($_.Exception.Message)"
}

# ---- Check 3: firewall allow-rule present & enabled --------------------------
try {
  $rule = Get-NetFirewallRule -DisplayName 'SAP Logistics 4000' -ErrorAction SilentlyContinue
  if (-not $rule) {
    $problems += "Firewall rule 'SAP Logistics 4000' is MISSING. FIX (admin): New-NetFirewallRule -DisplayName 'SAP Logistics 4000' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain"
  } elseif ($rule.Enabled -ne 'True') {
    $problems += "Firewall rule 'SAP Logistics 4000' is DISABLED. FIX (admin): Enable-NetFirewallRule -DisplayName 'SAP Logistics 4000'"
  }
} catch {
  # Reading firewall rules can require elevation; treat as a soft warning.
  Write-Line 'WARN' "Could not read firewall rules (run elevated to include this check): $($_.Exception.Message)"
}

# ---- Check 4: app actually serving on localhost ------------------------------
try {
  $resp = Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 8
  if ([int]$resp.StatusCode -ge 500) {
    $problems += "App on port $Port returned HTTP $($resp.StatusCode). FIX: check pm2 logs sap-logistics"
  }
} catch {
  $problems += "App on port $Port not responding ($($_.Exception.Message)). FIX: pm2 restart via scripts/restart-safe.ps1"
}

# ---- Report ------------------------------------------------------------------
if ($problems.Count -eq 0) {
  Write-Line 'OK' "All access preconditions healthy (NlaSvc, network profile, firewall rule, app on :$Port)."
  exit 0
}

foreach ($p in $problems) { Write-Line 'ALERT' $p }

# Best-effort desktop popup so a stopped service is noticed without reading logs.
try {
  $summary = "sap-logistics access problem detected ($($problems.Count)). See backend\logs\health-monitor.log"
  & msg.exe * $summary 2>$null
} catch {}

exit 1
