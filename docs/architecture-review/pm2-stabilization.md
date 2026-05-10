# PM2 Stabilization Analysis

Read-only investigation. Source data: `C:\Users\izik\.pm2\pm2.log` (23 MB), `C:\Users\izik\.pm2\dump.pm2`, per-app logs in `C:\Users\izik\.pm2\logs\`, `sap-bi/logs/api-err.log`, OS-level `Get-NetTCPConnection` and `Get-CimInstance Win32_Process`. No file modifications.

---

## TL;DR

The PM2 daemon on this Windows host has **two interlocking failures** that explain every symptom we've observed:

1. **`sap-bi-api` is in a permanent EADDRINUSE crash loop.** Around 2026-05-09 22:50:49 it tripped its 1 GB `max_memory_restart` cap. The replacement fork (pid 24420) bound port 4001 successfully but PM2 marked it "exited via SIGINT" anyway (a known Windows PM2 fork bug). Pid 24420 is **still alive and holding port 4001**. PM2 has tried to spawn replacement forks ~23,000 times, each immediately dying with `listen EADDRINUSE 0.0.0.0:4001`.

2. **PM2 cannot kill orphan children on Windows.** The `pidusage` package times out invoking WMI (`Win32_Process`) every few seconds (55 occurrences in `pm2.log`). When PM2 then issues a `tree-kill`/`taskkill /F`, the request hangs because the child's cwd is on OneDrive and Windows holds file handles open. After 1600ms PM2 logs `Process with pid X could not be killed`. PM2 then internal-state-corrupts: `Process with pid X already exists`.

Combined: the daemon's event loop is permanently busy reaping failed forks of sap-bi-api and retrying SIGKILLs that don't land. **This is why every `pm2 list` / `pm2 jlist` / `pm2 restart` from this shell hangs ~2 minutes** before returning.

`sap-logistics` itself is not in a crash loop — it has been the original 2026-05-06 child since the dump regression — but it shares the orphan-resistance bug. **Today at 20:59:14, an attempted `pm2 stop sap-logistics` failed: pid 20112 "could not be killed" (`pm2.log:539-540`).** Any future `pm2 restart sap-logistics` is at risk of repeating sap-bi-api's exact pattern: kill fails → new fork → EADDRINUSE on port 4000 → looping.

---

## 1. Root causes

### 1.1 RC-A — `sap-bi-api` orphan + EADDRINUSE crash loop

**Evidence:**
- `~/.pm2/pm2.log:621` (2026-05-09T22:50:49):
  ```
  [PM2][WORKER] Process 2 restarted because it exceeds --max-memory-restart value
  (current_memory=1179127808 max_memory_limit=1073741824 [octets])
  ```
  → 1.1 GB usage exceeded the 1 GB cap defined in `sap-bi/ecosystem.config.cjs`.
- `pm2.log:622-625`: PM2 stops process 2 (`pid=37640 msg=process killed`), starts a fresh fork.
- `pm2.log:627+`: every fork "online" then "exited code 1 via signal SIGINT" within 2-3s.
- `sap-bi/logs/api-err.log` (last ~80 lines): every failed boot prints `Failed to bootstrap API: Error: listen EADDRINUSE: address already in use 0.0.0.0:4001` (errno -4091).
- `Get-NetTCPConnection -LocalPort 4001 | Select OwningProcess` returns pid **24420**.
- `Get-CimInstance Win32_Process -Filter "ProcessId=24420"` — `node.exe`, command `start-with-env.cjs`, **CreationDate 2026-05-09 22:50:49** — exact moment of the memory restart.

**Causal chain:** old fork (37640) hit memory cap → PM2 issued `taskkill` on it → new fork (24420) launched and bound port 4001 → PM2's WMI-based pidusage timed out checking pid 24420 → PM2's accounting marked it "exited via SIGINT" while it was actually still alive → PM2 spawned replacement fork → EADDRINUSE → replacement died → PM2 repeats. 23,000 times.

### 1.2 RC-B — Windows + pidusage + SIGKILL fragility

**Evidence:**
- 55 occurrences of `Error caught while calling pidusage / Error: Node - IZIK-WIN10 ERROR: Description = Call cancelled` in `pm2.log`. This is `pidusage` invoking `Win32_Process` via WMI; WMI returns "Call cancelled" when the system is busy.
- 3 occurrences of `Process with pid X could not be killed`:
  - pid 39108 (`tunnel-url-watcher`, 2026-05-09T20:21–22:06) at `pm2.log:301-340`
  - pid 20112 (**`sap-logistics`** — the production process), 2026-05-09T21:00:16–21:01:28 at `pm2.log:447-540`
- After "could not be killed", PM2 logs `Process with pid X already exists` (`pm2.log:332-340, 540`). Daemon's in-memory pid map and the OS reality are out of sync.
- PM2 on Windows uses `tree-kill` → `taskkill /pid X /T /F`. With cwd on OneDrive (the project lives under `C:\Users\izik\OneDrive - OIG\…`), file-handle release blocks the kill request.

### 1.3 RC-C — `tunnel-url-watcher` cron + kill mismatch

**Evidence:**
- `dump.pm2:1841+` shows `"cron_restart": "*/10 * * * *"`.
- `pm2.log:189-300` shows the canonical 10-minute cycle: deregister cron → register → start fork → watcher exits cleanly with code 0 in ~2s → PM2 issues `Stopping app:tunnel-url-watcher` → "failed to kill - retrying" loop because PM2's pidusage didn't notice the natural exit.
- The watcher itself is fine — `sap-bi/scripts/tunnel-url-watcher.mjs` is a one-shot script that polls the cf-tunnel log, detects URL changes, and updates Vercel env.
- Log noise only — no functional impact on the watcher's job.

---

## 2. Affected apps

### 2.1 In scope (matters for sap-logistics-hub)

| App (pm_id) | Status | Concern |
|---|---|---|
| `sap-logistics` (6) | online, restart_time=1, healthy | At risk of orphan-and-EADDRINUSE on next restart (RC-B). Was target of failed `pm2 stop` at 20:59:14 today. |

### 2.2 Out of scope (different projects, not our remit)

| App (pm_id) | Status | Reason |
|---|---|---|
| `sap-bi-api` (2) | crash loop, ~23,000 restarts | Different project (`sap-bi/apps/api`). Causes daemon congestion that affects us indirectly, but fixing it is outside this migration's scope. |
| `sap-bi-tunnel` (1) | online | Different project. |
| `sap-bi-web` (0) | online | Different project. |
| `sap-bi-ngrok` (3) | online | Different project. |
| `davo-price-monitor` (4) | online | Different project. |
| `cloudflare-tunnel` (5) | online | Used to expose `sap-logistics` historically. May not be needed in Phase 0; verify with operator. |
| `tunnel-url-watcher` (7) | errored | Different project. Noise only. |
| `oig-listener` (8) | online | Different project (facebook-service-agent). |

---

## 3. Is `sap-logistics` impacted?

**Currently: no active impact**, but at significant operational risk.

### Evidence for "no current impact"
- `dump.pm2` shows `sap-logistics` `online` since 2026-05-06T22:16:32; restart_time=1 (no auto-restart since regression).
- `/health` returns 200 with mode `"DEMO+SAP"` — process answering normally.
- No `sap-logistics` events in `pm2.log` between the 2026-05-06 start and the 2026-05-09 20:59:14 stop attempt (other than routine pidusage error noise).

### Evidence for "at operational risk"
- The 2026-05-09 20:59:14 stop attempt (`pm2.log:446`) hung for ~62s and ended with "pid 20112 could not be killed" (`pm2.log:539`). This means the production process is in the same orphan-resistance bucket as sap-bi-api. The next operator-issued `pm2 restart sap-logistics` will likely recreate sap-bi-api's exact failure mode on port 4000.
- PM2 daemon CPU is constantly busy with sap-bi-api crash-looping (~0.5 Hz). Every PM2 RPC takes 1-2 minutes. **In an actual incident requiring a fast restart, the daemon will not respond promptly.**
- The dump.pm2 still has `demoServer.js` baked in for `sap-logistics`. A daemon restart now would `pm2 resurrect` from that dump → demoServer.js comes back. **Intentional and desired during Phase 0.**

---

## 4. Safe cleanup procedure

This procedure does NOT migrate anything. It only stabilizes the PM2 daemon to make Phase 1+ work safely. **Run during the maintenance window (§6).**

### 4.1 Pre-flight

```powershell
# Save the current dump as a recovery point
pm2 save
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.PRE-CLEANUP-$ts" -Force

# Snapshot store.json (in case anything goes wrong with sap-logistics during cleanup)
$root = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend"
Copy-Item "$root\data\store.json" "$root\data\archive\store.json.PRE-PM2-CLEANUP-$ts" -Force

# Identify orphans on relevant ports
Get-NetTCPConnection -LocalPort 4000,4001,3001 -ErrorAction SilentlyContinue |
  Select-Object LocalPort, State, OwningProcess |
  Format-Table

# Map pids to commandlines (so you don't kill the wrong node.exe)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, CreationDate, @{n='CmdLine';e={$_.CommandLine}} |
  Format-Table -Wrap
```

### 4.2 Step 1 — drain the sap-bi-api crash loop

```powershell
# Tell PM2 to stop trying. Will hang ~60-120s (daemon busy). Wait.
pm2 stop 2

# If pm2 stop times out: kill the orphan manually
# 4001 should be owned by the orphan we identified (e.g. pid 24420)
$orphan = (Get-NetTCPConnection -LocalPort 4001 -ErrorAction SilentlyContinue).OwningProcess
if ($orphan) {
  Stop-Process -Id $orphan -Force
  # Now PM2's stop call should return; if not, give it 30s
}

# Confirm no node.exe is bound to 4001 anymore
Get-NetTCPConnection -LocalPort 4001 -ErrorAction SilentlyContinue
# Should output nothing
```

### 4.3 Step 2 — verify the daemon's responsiveness

```powershell
# pm2 list should now return in <5s (was 60-120s)
$start = Get-Date
pm2 list
$elapsed = (Get-Date) - $start
Write-Host "pm2 list took $($elapsed.TotalSeconds) seconds"
# Expect <10s. If still >30s, daemon hasn't fully drained — wait 1 minute, retry.
```

### 4.4 Step 3 — sap-logistics health check (NO RESTART)

```powershell
# Verify sap-logistics is still healthy AFTER the daemon settled
pm2 describe sap-logistics
curl http://localhost:4000/health
# Expect: status online, /health returns 200 with mode=DEMO+SAP

# DO NOT restart sap-logistics here. The whole point is to leave it alone.
```

### 4.5 Step 4 — persist the cleaned state

```powershell
pm2 save
# This writes a new dump.pm2 with sap-bi-api in "stopped" status
# Snapshot the new dump as a recovery point
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.POST-CLEANUP-$ts" -Force
```

### 4.6 Step 5 — confirm tunnel-url-watcher noise is contained

```powershell
# tunnel-url-watcher will keep running every 10 min and keep producing
# "failed to kill" log noise. That is expected and unrelated to our system.
# To silence the noise (optional, operator decision):
pm2 stop tunnel-url-watcher
# But: that disables the Vercel env update for the OTHER project. Verify
# with the sap-bi project owner before disabling.
```

### 4.7 Validation gate

After the procedure, all of these must be true:

- [ ] `Get-NetTCPConnection -LocalPort 4001` returns nothing OR shows ONLY a PM2-managed `sap-bi-api` process if the operator chose to restart it.
- [ ] `pm2 list` returns in <10 seconds.
- [ ] `pm2 describe sap-logistics` shows `status: online`, `pid: 20112` (or whatever the original 2026-05-06 child's pid was).
- [ ] `curl http://localhost:4000/health` returns 200 with `"mode":"DEMO+SAP"`.
- [ ] `dump.pm2` POST-CLEANUP snapshot exists in `C:\backups\pm2\`.
- [ ] No new errors in `backend/logs/error.log` since the cleanup window started.

If ANY validation fails, stop and consult the rollback in §5.

---

## 5. Risks of `pm2 kill && pm2 resurrect`

This is a hammer that we explicitly recommend against during Phase 0. Reasons:

### 5.1 Orphans survive
`pm2 kill` only kills the PM2 daemon and the children it can reach. The pid 24420 holding port 4001 (and possibly pid 20112 for sap-logistics) will survive. After `pm2 resurrect` PM2 will try to launch the apps from `dump.pm2`, find ports already taken, and start a *fresh* crash loop — this time potentially on **all** apps simultaneously. Worst case: 4-5 orphans need manual `Stop-Process` before the daemon stabilizes.

### 5.2 sap-bi-api comes right back
`pm2 resurrect` re-applies `dump.pm2` exactly as saved. That includes `sap-bi-api`, which will hit memory cap → restart cycle within minutes. Same problem, fresh log file.

### 5.3 OneDrive file locks
The cwd `cowork\sap-logistics-hub\backend` is under OneDrive. If `pm2 kill` happens while OneDrive is syncing demoServer's `data/` files, Windows can hold file handles after the parent dies. The new daemon then fails to read those files. Symptom: `EBUSY` or `EPERM` on the next start. **This is the exact path to a 2026-05-06-style stale-dump regression.**

### 5.4 Recommended alternative
If the daemon is genuinely too unhealthy to stabilize via §4, the right move is:
1. Extract the dump (`Copy-Item dump.pm2 backup`)
2. Identify EVERY orphan pid via `Get-NetTCPConnection` + `Get-CimInstance` for ports 3001, 4000, 4001, 5173 (any port any pm2-managed app might use).
3. `Stop-Process -Force` each orphan.
4. `pm2 kill` (now safe).
5. `pm2 resurrect` (now safe — no port conflicts).

This is a 10-minute hands-on procedure. Don't do it alone; have a second person watch.

---

## 6. Recommended maintenance window

### 6.1 Best time
- **Sunday 22:00 → Sunday 23:00 Israel time (one hour).** Same window as the eventual cutover, but a smaller scope.
- Warehouse closed, no live driver runs.
- Light external traffic on `sap-logistics`.

### 6.2 Pre-window checklist
- [ ] Operator + 1 backup person available.
- [ ] Phase 0 freeze in effect (no concurrent code changes).
- [ ] Backups per `backup-inventory.md` taken in the last 12 hours.
- [ ] cf-tunnel quick-tunnel taken down so external traffic can't hit during the daemon dance: `taskkill /IM cloudflared.exe /F` (verify no live tunnel needed first).
- [ ] OneDrive sync paused on `cowork/sap-logistics-hub/backend/data/`.

### 6.3 Window allocation
- 0-15 min: pre-flight + step 1 (drain sap-bi-api).
- 15-30 min: steps 2-4 (verify daemon, sap-logistics health, save dump).
- 30-45 min: validation gate; observe one full pidusage cycle (~30s) for new errors.
- 45-60 min: buffer for rollback if needed.

### 6.4 Post-window
- Resume OneDrive sync.
- Restart cf-tunnel if it was needed.
- Update `cowork/INCIDENTS.md` with the cleanup record.
- Push the new `dump.pm2` snapshot to off-host backup.

---

## 7. Do NOT do list

| ❌ Don't | Why |
|---|---|
| `pm2 delete sap-bi-api` | Orphan child won't be cleaned up. Future `pm2 start` of anything wanting port 4001 fails invisibly. |
| `pm2 kill` without first stopping orphans | See §5.1, §5.3. |
| `pm2 update` or `pm2 install pm2-windows-startup` mid-window | Both fork a new daemon and try to migrate state. With this much in-flight crash data they will silently lose the cron config on tunnel-url-watcher. |
| `pm2 restart all` | Restarts in pm_id order (sap-logistics is id 6, after broken sap-bi-api id 2). The crash loop on sap-bi-api will starve the daemon's RPC queue. sap-logistics restart may time out half-way. |
| Delete `dump.pm2` | Still has the demoServer baseline that we want to keep through Phase 0. |
| Flip `SAP_WRITE_ENABLED=true` | A SAP write triggered during a daemon-confused window is the recipe for the regression we don't want. |
| Remove `cron_restart` on tunnel-url-watcher to "fix" the kill failure | Watcher does real work (Vercel env updates). Either accept the noise or rewrite it as a long-running process post-Phase-6. Either way: not now. |
| `pm2 restart sap-logistics --update-env` | This was the command that hung at 20:59:14 today. Don't repeat without first stabilizing the daemon. |
| Edit `backend/.env` while sap-logistics is running | demoServer doesn't watch .env; but operator habit is to restart after .env change, which would trigger the 4.4 risk. |

---

## 8. Files referenced

- `C:\Users\izik\.pm2\pm2.log` — daemon log (rotates; ~23 MB at investigation time)
- `C:\Users\izik\.pm2\dump.pm2` — saved process registry (mtime 2026-05-09 07:41:55 — the snapshot that PM2 will use on next resurrect)
- `C:\Users\izik\.pm2\logs\tunnel-url-watcher-error.log`, `tunnel-url-watcher-out.log`
- `C:\Users\izik\OneDrive - OIG\שולחן העבודה\sap-bi\logs\api-err.log` — sap-bi-api EADDRINUSE storm (~30 MB)
- `C:\Users\izik\OneDrive - OIG\שולחן העבודה\sap-bi\ecosystem.config.cjs` — defines sap-bi-api memory cap
- `backend/logs/pm2-error.log` — sap-logistics-specific error log (small; no recent activity)
- `backend/logs/pm2-out.log` — sap-logistics stdout (1.13 MB; mostly `[sim]` simulator messages from demoServer)

End of stabilization analysis.
