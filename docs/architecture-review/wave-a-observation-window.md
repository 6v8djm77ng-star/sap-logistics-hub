# Wave A Observation Window — 5-7 days

**Window:** 2026-05-10 12:21 → 2026-05-17 (7 days post-deploy)
**Owner:** the operator. Operator owns the daily log.
**Purpose:** detect any regression from the Wave A patch and the surrounding remediation work, **before** considering Wave B / C.

This is a checklist + log. Print it; tick boxes; or copy into a daily ops note.

---

## 1. Baseline (captured 2026-05-10 12:21 — immediately post-deploy)

| Signal | Baseline value | Source |
|---|---|---|
| sap-logistics PM2 status | online | `pm2 list` |
| sap-logistics PM2 pid | 2148 | `pm2 list` |
| sap-logistics restart_time | 1 | `pm2 list` |
| sap-logistics memory | ~57 MB | `pm2 list` |
| /health localhost response | 200 in <100ms | `curl http://localhost:4000/health` |
| /health public URL | 200 | curl public URL |
| Public URL (current) | `https://automatic-incoming-rankings-kept.trycloudflare.com` | `cf-tunnel-error.log` tail |
| `/api/users` anon (public) | 401 (Wave A closed) | curl |
| `/api/customers/search` anon | 401 | curl |
| `/api/drivers` anon | 401 | curl |
| `/api/sap/write/delivery-note/1` anon | 401 | curl |
| `/api/runs` anon (still open) | 200 (NOT in Wave A) | curl |
| `/api/public/track/*` anon | 200/404 (intentional public) | curl |
| pm2-error.log fresh patterns | only env warnings (existing) | `tail` |
| store.json mtime | growing on demoServer writes (~50 KB/day) | `ls -la` |

---

## 2. Daily verification routine (~5 min/day)

Run once per business day during the window. Record results in §6 daily log.

```powershell
# A. PM2 health (single line: pm_id=6 sap-logistics should be online + restart_time still 1)
pm2 jlist | ConvertFrom-Json | Where { $_.name -eq 'sap-logistics' } |
  Select pid, @{n='status';e={$_.pm2_env.status}}, @{n='restart_time';e={$_.pm2_env.restart_time}}, @{n='mem_mb';e={[math]::Round($_.monit.memory/1MB,1)}}

# B. /health localhost
curl -s -o NUL -w "code=%{http_code} time=%{time_total}s`n" http://localhost:4000/health

# C. /health public URL (find current via cf-tunnel log)
$pub = (Select-String 'trycloudflare\.com' "...\backend\logs\cf-tunnel-error.log" |
        Select -Last 1).Line -replace '.*?(https://[a-z0-9-]+\.trycloudflare\.com).*','$1'
curl -s -o NUL -w "code=%{http_code} time=%{time_total}s`n" "$pub/health"

# D. Wave A gates (anon must stay 401)
foreach ($p in '/api/users','/api/customers/search?q=test','/api/drivers') {
  curl -s -o NUL -w "$p code=%{http_code}`n" "$pub$p"
}

# E. error.log fresh entries (count of NEW errors since yesterday's log)
$today = Get-Content "...\backend\logs\error.log" | Where { $_ -match (Get-Date -Format 'yyyy-MM-dd') }
Write-Host "errors today: $($today.Count)"
$today | Where { $_ -notmatch 'tick failed Connection is closed|trustServerCertificate|SAP is not fully configured' } | Select -Last 5
# (filter known-noise patterns; print last 5 fresh)

# F. pm2.log restart events for sap-logistics (count)
Select-String 'sap-logistics.*starting|sap-logistics.*exited' "$env:USERPROFILE\.pm2\pm2.log" |
  Where { $_.Line -match (Get-Date -Format 'yyyy-MM-dd') } | Measure
# expect 0 (no restarts during the day)

# G. store.json size + mtime (slow growth expected ~50 KB/day from demoServer)
Get-Item "...\backend\data\store.json" | Select Length, LastWriteTime

# H. Disk space
Get-PSDrive C | Select Used, Free | ForEach { "Free: $([math]::Round($_.Free/1GB,1)) GB" }
```

---

## 3. What to monitor (signal taxonomy)

### 3.1 Auth failures (401/403 spikes)
- **Where:** `backend/logs/pm2-out.log` lines containing `:authenticate` errors OR `Authentication required` OR `Admin role required`
- **Baseline:** ~0-5/hr (from misconfigured external integrations or browser tabs with expired tokens)
- **Alert threshold:** sustained >100/hr for 30+ min → investigate WHO is calling and from where (could be a frontend page hitting a now-gated endpoint without sending Bearer)
- **Possible cause if spike:** Wave A gates broke an integration we didn't know about. Find the source IP, identify the team.

### 3.2 PM2 restarts
- **Where:** `pm2.log` lines `App [sap-logistics:6] starting in -fork mode-`
- **Baseline:** 0/day — Wave A restart was the only intentional one. Any further restart = unexpected.
- **Alert threshold:** ANY unexpected restart → investigate immediately. Could be memory cap, fatal error, OS event.
- **Action on alert:** check `pm2-error.log` and `pm2-out.log` around the restart timestamp.

### 3.3 Memory growth
- **Where:** `pm2 list` `mem` column or `pm2 jlist | ConvertFrom-Json | Select monit.memory`
- **Baseline:** ~57 MB at deploy.
- **Alert thresholds:**
  - >300 MB sustained → memory leak; investigate before approaching 1 GB cap (auto-restart)
  - >700 MB → page on-call
  - >1 GB → cap-trigger imminent → orphan-on-port-4000 risk per `pm2-stabilization.md`
- **Specific Wave A concern:** the new middleware allocates JWT verification on every request. If we see steady linear growth ~5-10 MB/hour, that's an mssql/jwt cache issue (not Wave A's fault but worth cross-checking).

### 3.4 Tunnel instability
- **Where:** `cf-tunnel-error.log`. Look for new "Your quick Tunnel has been created" entries (= URL changed).
- **Baseline:** URL stable for days at a time; restarts only on cloudflared restart.
- **Alert threshold:** any new URL appearing during the observation window → inform stakeholders that customer SMS tracking links from the OLD URL are now dead. Update any external systems pointing at the URL.
- **Mitigation:** see `tunnel-dependency-analysis.md` §7 for the named-tunnel migration plan.

### 3.5 Customer tracking failures
- **Where:** `pm2-out.log` lines `GET /api/public/track/`. Look for 404s (token not found) or 500s.
- **Baseline:** very rare — tokens are valid for 48h, customers click within minutes of receiving SMS.
- **Alert threshold:** sustained 4xx/5xx on `/api/public/track/*` → Wave A may have inadvertently affected the public path (it shouldn't have — verify by curl).
- **Customer-facing signal:** any direct customer complaint "tracking link doesn't work" → priority investigate.

### 3.6 Mobile-driver issues
- **Where:** `pm2-out.log` lines `POST /api/auth/driver-login` and `GET /api/driver/`
- **Baseline:** drivers log in once per shift; my-runs polls every 30s.
- **Alert threshold:**
  - Driver reports "can't log in" → check `/api/auth/driver-login` response codes for that IP. If 401, check JWT_SECRET hasn't been rotated.
  - Driver reports "manifest empty" → not Wave A's fault (Wave A doesn't touch driver routes), but verify.
  - Driver reports "can't mark stop delivered" → check `/api/driver/stops/:id/status` response codes. NOT in Wave A — should be unchanged.

### 3.7 Login anomalies
- **Where:** `pm2-out.log` lines `POST /api/auth/login`. Watch for:
  - Sudden spike in anonymous-IP failed logins (brute-force attempt)
  - Successful logins from unfamiliar IPs (outside office subnet 192.168.0.0/24 + known remote-worker IPs)
- **Baseline:** ~handful per day.
- **Alert threshold:** >20 failed logins/hour from same IP → likely brute-force; rate limiter at line 80 (`loginLimiter` 10/5min/IP) should already cap it. Verify it's working.

### 3.8 Frontend unexpected breakage
- **Detection:** user reports of "page X doesn't load" or "button Y returns error".
- **Most likely culprit (Wave A-specific):** a frontend page that hits `/api/customers/*`, `/api/drivers`, or `/api/users` without sending the Bearer token. If a page worked yesterday and breaks today, that's the smoking gun.
- **Diagnosis:** open browser devtools → Network tab → look for 401s on the requests from that page. Confirm the request's `Authorization` header is missing.
- **Triage:** if the page is critical, deploy a frontend hotfix to attach the header. If non-critical, defer.

### 3.9 error.log patterns
- **Where:** `backend/logs/error.log`
- **Pre-Wave-A baseline:** entries are exclusively env.js warnings (SAP not configured / TLS trustServerCertificate / Logistics SQL warnings) — these are static.
- **Alert on NEW patterns:**
  - `TypeError: Cannot read property` → likely Wave A middleware bug (e.g., `req.headers.authorization` of undefined)
  - `jwt malformed` → token parse error; could be anyone sending a corrupted token
  - `ReferenceError` → undefined symbol — would have been caught by `node --check` but worth watching
  - `EBUSY: resource busy or locked` → OneDrive file lock during demoServer write → store.json write may fail
  - `EADDRINUSE` → orphan-on-port-4000 reappearance (would only happen on restart)
- **Action:** any new pattern appearing >3 times → investigate.

### 3.10 Restart anomalies
- **Where:** `pm2.log` for sap-logistics events
- **Baseline:** zero restarts during observation window.
- **Specific scenarios to watch for:**
  - `sap-logistics ... will restart in 100ms` (PM2 auto-restart) → why? Memory? Crash?
  - `sap-logistics ... could not be stopped` → OneDrive lock recurring; same as 2026-05-09 21:01:28 → bookkeeping mismatch returns
  - `New PM2 Daemon started` → daemon itself restarted (machine reboot or `pm2 kill`); resurrect from current dump.pm2 (which records sap-logistics correctly post-Wave-A) so should re-launch with the patch active.

### 3.11 OneDrive lock events
- **Why care:** the project lives under `OneDrive - OIG`. OneDrive sync can hold file handles open mid-write. Two specific risks:
  - During PM2 restart: `taskkill` of sap-logistics may hang on file handles → orphan-on-port-4000 pattern
  - During `store.json` write: demoServer's `fs.writeFileSync` may EBUSY or partial-write
- **Detection:**
  - Restart anomaly per §3.10
  - `error.log` `EBUSY|EPERM` on store.json
  - OneDrive sync indicator in Windows tray showing constant activity
- **Mitigation:** if observed, pause OneDrive sync on `backend/data/` and `backend/src/` during sensitive operations.

---

## 4. Alert thresholds — consolidated

| Severity | Trigger | Action |
|---|---|---|
| 🔴 Page on-call | `/health` != 200 for 2 consecutive checks (60s apart) | Investigate immediately; rollback per §5 if Wave A-related |
| 🔴 Page on-call | sap-logistics PM2 status != online | Same |
| 🔴 Page on-call | Anonymous probe of `/api/users` returns 200 (Wave A regression) | Immediate Wave A rollback per §5 |
| 🔴 Page on-call | Memory >1 GB | Cap-trigger restart imminent; clear orphans before |
| 🔴 Page on-call | Customer reports "tracking link broken" | Verify `/api/public/track/<their-token>`; if broken, escalate |
| 🟡 Investigate (next business hour) | New error pattern in `error.log` (>3 occurrences) | Read context, decide |
| 🟡 Investigate | Sustained 401 spike >100/hr for 30+ min | Find source IP; identify integration |
| 🟡 Investigate | Memory >300 MB sustained 30+ min | Likely leak; profile before cap |
| 🟡 Investigate | Tunnel URL changed | Notify stakeholders; update external integrations |
| 🟢 Trend (daily review) | Memory delta day-over-day | Track linearity |
| 🟢 Trend | store.json growth rate | Should stay ~50 KB/day |
| 🟢 Trend | pm2.log size growth | Should stay <1 MB/day |

---

## 5. Rollback triggers + procedure

### 5.1 Rollback IF
- Anonymous `/api/users` returns 200 from public URL (Wave A failed in production)
- ADMIN-authed `/api/users` returns 401 (Wave A blocking legitimate admin access)
- `/health` not 200 for 2 consecutive 60s checks
- Multiple frontend pages broken simultaneously
- `error.log` shows persistent fatal patterns introduced by Wave A
- Customer SMS tracking confirmed broken (verify with `/api/public/track/<known-good-token>` first)

### 5.2 Rollback procedure
```powershell
cd "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub"
git revert ae18787 --no-edit

# Pre-restart orphan check (per pm2-maintenance-runbook.md)
$port_pid = (Get-NetTCPConnection -LocalPort 4000 -State Listen -EA SilentlyContinue).OwningProcess
$pm2_pid  = (pm2 jlist | ConvertFrom-Json | Where { $_.name -eq 'sap-logistics' }).pid
if ($port_pid -and $port_pid -ne $pm2_pid) { Stop-Process -Id $port_pid -Force }

pm2 restart sap-logistics

# Verify rollback
curl -s http://localhost:4000/api/users -o NUL -w "code=%{http_code}`n"
# expect 200 (back to anonymous = rollback succeeded)

# pm2 save + snapshot post-rollback
pm2 save
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.POST-WAVE-A-ROLLBACK-$ts"
```

### 5.3 After rollback
- Update `cowork/INCIDENTS.md` with rollback record + trigger reason
- Re-run external probes to confirm exposure is back open (and accept it for now)
- Plan a Wave A v2 with the bug fixed before re-attempting

---

## 6. Daily log (template — fill in during the window)

Copy this block per day:

```text
─────────────────────────────────────────────────
DAY N — YYYY-MM-DD (HH:MM Israel)
Operator: <name>
─────────────────────────────────────────────────

A. PM2 health         pid=____  status=____  restart_time=____  mem=____MB
B. /health localhost  code=____ time=____s
C. /health public     URL=__________________ code=____
D. Wave A gates       /users=____ /customers=____ /drivers=____  (all expect 401)
E. error.log          new errors today: ____  (paste any non-baseline)
F. pm2.log            sap-logistics restart events today: ____
G. store.json         size=____ delta from yesterday=____
H. Disk free          ____ GB

OBSERVATIONS / ANOMALIES:
  ☐ Auth failure spike?     y/n  (if y: source, count)
  ☐ Tunnel URL changed?     y/n  (if y: new URL, who notified)
  ☐ Customer complaint?     y/n  (if y: ticket #, summary)
  ☐ Driver complaint?       y/n  (if y: driver code, summary)
  ☐ Frontend page broken?   y/n  (if y: page name, devtools network finding)
  ☐ New error pattern?      y/n  (if y: pattern, count)
  ☐ OneDrive sync issue?    y/n  (if y: window, files)

VERDICT: continue / escalate / rollback / hotfix

NEXT-DAY ATTENTION:
  -
─────────────────────────────────────────────────
```

---

## 7. Specific watch items (Wave A-related)

These are the most-likely-to-go-wrong items. Watch hard for the first 48 hours:

### 7.1 Frontend pages that may hit gated endpoints anonymously
Per `route-matrix.md`, these frontend pages call Wave A endpoints:
- `pages/UsersPage.jsx` — calls `/api/users` → must send Bearer (does, via api.js wrapper)
- `pages/CustomerPolicyPage.jsx` — calls `/api/customers/policies` → must send Bearer
- `pages/DriversPage.jsx` — calls `/api/drivers` → must send Bearer
- `components/MobileLinkDialog.jsx` — calls `/api/auth/mobile-link` → already auth-required
- `components/CustomerSearchInput.jsx` — calls `/api/customers/search` → must send Bearer
- `pages/ReturnsPage.jsx` — uses customer search

If any of these break, the symptom is "page loads but data doesn't appear" or "401 in network tab". Check Bearer header presence.

### 7.2 External integrations
Any cron / external system that hit:
- `/api/customers/search` (data exporters)
- `/api/drivers` (sync to other systems)
- `/api/users` (audit / SSO sync)

These are the unknown-unknowns. Watch `pm2-out.log` for 401s from non-frontend User-Agents (curl, python-requests, axios outside browsers, etc.). If found, contact the integration owner.

### 7.3 mobile-link 1h TTL
Per Wave A, mobile-link tokens now expire in 1 hour (was 30 days). Watch for admin reports:
- "I sent myself a link and by the time I scanned it, it was expired" → bump TTL to 6h or 24h (operator decision; Wave A 1h was conservative)
- "The link works once but not twice" → that's the single-use guard working as designed; document in operator runbook

### 7.4 PM2 daemon health
The daemon was unhealthy until the prerequisite remediation. After Wave A:
- sap-bi-api should remain `stopped` (we drained the crash loop)
- tunnel-url-watcher remains errored (out of scope)
- sap-logistics should remain online with restart_time staying at 1

If sap-bi-api restarts on its own (PM2 autorestart): the orphan-EADDRINUSE pattern will return. Stop-Process the orphan + pm2 stop 2 again.

---

## 8. End-of-window decision (Day 7)

After 7 days of the daily log, decide:

| State | Recommended action |
|---|---|
| Zero anomalies, all daily logs ✓ | Proceed to Wave B planning |
| Minor anomalies, all explainable | Proceed to Wave B with extra caveats |
| Auth-related anomalies (frontend or integration regressions) | Fix root causes; observe another 7 days; THEN Wave B |
| Memory leak observed | Investigate + fix BEFORE Wave B (don't compound) |
| Multiple PM2 restarts | Investigate; may need pm2-stabilization v2; delay Wave B |
| Customer-facing breakage | Rollback consideration; root-cause; only Wave B after stable |

**Default: continue observation if any item above the green line moved.** Wave B/C will still be there next week.

---

## 9. Document references

- `wave-a-mitigation-report.md` — what was deployed
- `wave-a-readiness-check.md` — pre-deploy verdict
- `pm2-maintenance-runbook.md` — orphan-handling procedure
- `pm2-stabilization.md` — root cause of pre-existing daemon issues
- `tunnel-dependency-analysis.md` — tunnel posture decisions
- `external-reachability-report.md` — original exposure context
- `cowork/INCIDENTS.md` — operator audit trail
- `wave-a-24h-review-template.md` — 24h checkpoint template

End of observation window plan.
