# RUNBOOK — sap-logistics-hub

Operational guide for maintaining sap-logistics-hub on **Izik-win10**
without Claude Code. Print a copy and tape it next to the server.

Last updated: 2026-05-30.

---

## 0. Quick reference card

| Need to... | Command |
|---|---|
| See what's running | `pm2 list` |
| Restart sap-logistics (safely, with store backup) | `powershell -File scripts\restart-safe.ps1` |
| Restart sap-logistics + pick up new `.env` | `pm2 reload ecosystem.config.cjs --only sap-logistics --update-env` |
| Tail backend logs | `pm2 logs sap-logistics --lines 50` |
| Public URL (stable, Tailscale Funnel) | `https://izik-win10.tailbe99fc.ts.net` |
| Run a backup now | `powershell -ExecutionPolicy Bypass -File scripts\daily-backup-store.ps1` |
| Restore from backup | `powershell -ExecutionPolicy Bypass -File scripts\restore-store-from-backup.ps1 store-YYYYMMDD-HHmmss.json` |
| Reset a user's password | See section **5** |
| Free a stuck port 4000 | `netstat -ano \| findstr :4000` → `taskkill /F /PID <pid>` |

### ⚠️ `pm2 restart --update-env` does NOT re-read `.env`

If you change `backend/.env` (CORS_ORIGINS, PUBLIC_URL, JWT_*, ANTHROPIC_*, ...)
and want the running PM2 child to pick it up, use either:

```
powershell -File scripts\restart-safe.ps1
# or, if you know what you're doing and want zero downtime:
pm2 reload ecosystem.config.cjs --only sap-logistics --update-env
```

Why: `pm2 restart sap-logistics --update-env` only refreshes env from
the CURRENT shell session, not from `ecosystem.config.cjs`. Our
`ecosystem.config.cjs` parses `backend/.env` manually at evaluation
time — so re-evaluating it (= `reload <file>`) is the only way to pull
fresh env values into the child. A plain `restart --update-env`
silently leaves the child on the OLD env.

This bug was silently live for months before being noticed — see
`cowork/INCIDENTS.md` "2026-05-28 — sap-logistics: `pm2 restart
--update-env` לא קורא מחדש את `.env`".

`scripts/restart-safe.ps1` already uses `pm2 reload ecosystem.config.cjs`
internally (since commit `e68411a`), so the safest answer is **always
use restart-safe.ps1** unless you're doing a deliberate one-off.

---

## 1. Architecture (what runs where)

| Component | Where | Port | Owner |
|---|---|---|---|
| Backend (Node 20, Express, demoServer.js) | PM2 process `sap-logistics` | 4000 | izik |
| Frontend (Vite/React, built bundle) | Served by the backend on / | (via 4000) | izik |
| Persistent store | `backend/data/store.json` (file, ~2.7 MB) | — | izik |
| Public tunnel | PM2 process `cloudflare-tunnel` → `cloudflared --url http://localhost:4000` | rotates | izik |
| SAP Business One | 192.168.0.220 (separate machine) | 1433 SQL · 50000 SL | SAP admin |
| Frontend dev server (optional) | `cd frontend && npm run dev` | 5173 | izik |

8 PM2 processes total on this machine. Only `sap-logistics` + `cloudflare-tunnel`
are essential for the logistics UI. The rest belong to other projects
(sap-bi, davo, oig-listener).

---

## 2. Cold start (after reboot)

1. Wait for Windows to finish booting and the user to log in.
2. PM2 auto-startup (`pm2-startup install`) will resurrect the saved
   process list within ~30s. Verify:
   ```
   pm2 list
   ```
   Expect all 8 services with state `online`.
3. If any are missing or stopped:
   ```
   pm2 resurrect
   ```
4. Wait for `sap-logistics` to bind port 4000. Health-check:
   ```
   curl http://localhost:4000/health
   ```
   Expect HTTP 200 with `{"ok":true, "sapConnected":true, ...}`.
5. Verify the public tunnel responds:
   ```
   pm2 logs cloudflare-tunnel --lines 200 --nostream | findstr trycloudflare
   ```
   Take the most recent URL and try it in a browser. The page title
   should say "SAP Logistics Hub" (not "SAP BI").
6. If the tunnel URL is new, tell the operators. Currently the URL
   rotates on every restart — see `docs/cloudflare-tunnel-setup.md` for
   the planned migration to a stable named tunnel.

---

## 3. Health check (manual, 30 seconds)

Three commands, in this order:

```
pm2 list
curl http://localhost:4000/health
curl http://localhost:4000/api/auth/me
```

| Output | Means |
|---|---|
| `pm2 list` shows `sap-logistics` `online` and `cloudflare-tunnel` `online` | processes OK |
| `/health` returns `{"ok":true,"sapConnected":true,...}` | backend OK, SAP reachable |
| `/health` returns `{"ok":true,"sapConnected":false,...}` | backend OK, SAP unreachable (degraded; reads work for cached, writes fail) |
| `/api/auth/me` returns HTTP **401 Unauthorized** | server alive, auth working (this is the expected response when not logged in) |
| `/api/auth/me` returns HTTP 500 | something is wrong server-side → check logs |
| Anything returns HTTP 502/503 from the tunnel URL | tunnel up, backend down. Restart `sap-logistics`. |

---

## 4. Deploying new code

```
cd <repo-root>
git pull origin wave-a-mitigation
cd backend && npm install         # only if package.json changed
cd ../frontend && npm install     # only if package.json changed
cd ../frontend && npm run build   # always — bundles new UI for the backend to serve
cd ..
pm2 reload sap-logistics          # zero-downtime-ish reload (5s gap)
curl http://localhost:4000/api/auth/me   # expect 401 → liveness confirmed
```

**Rollback** if something breaks:
```
git log --oneline -5              # find the last-known-good commit
git checkout <commit-hash>
cd frontend && npm run build
cd ..
pm2 reload sap-logistics
```

---

## 5. User management

### Reset a user's password (admin task)

This is documented because the in-browser "forgot password" flow needs
SMTP to be configured (it currently isn't — `backend/.env` has empty
`SMTP_*` fields).

Procedure (e.g., for user `moti`):
1. Make sure PM2 is running and you have the user's UserId:
   ```
   node -e "const s=require('./backend/data/store.json'); console.log(s.users.map(u=>({id:u.UserId,username:u.Username,name:u.FullName,active:u.IsActive})))"
   ```
2. There is a Node script at `scripts/moti-pwreset.js` (rebuild from
   git history if needed — it's been used 3x as of 2026-05-17).
   Pattern: takes `<storePath> <userId> <expectedUsername>` and outputs
   a JSON block with the new password.
3. Generic flow inside the script:
   - Stop PM2 sap-logistics
   - Take a timestamped backup → `backend/data/backups/store.PRE-PWRESET-<USER>-<TS>.json`
   - Generate a 16-char strong password
   - Bcrypt-hash it (cost 12)
   - Write only `PasswordHash`, `MustChangePassword=true`,
     `PasswordChangedAt`, `PasswordResetReason`, `FailedLoginCount=0`,
     `LockedUntil=null` for the target user
   - Verify other users untouched
   - Start PM2, wait for liveness, login-test the new password
   - Print the new password ONCE to stdout
4. Pass the new password to the user via a private channel (WhatsApp,
   SMS, in person). Do NOT email it. Tell them they must change it on
   first login.

### Add a new user

There's no admin UI for adding users — they're added by either:
- a seed/migration script in `backend/src/db/`, or
- directly editing `store.json` (then `pm2 reload sap-logistics`).

For safety: use the seed script pattern. Direct edits can corrupt the
file mid-write — always stop PM2 first.

---

## 6. Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Moti can't log in, no `login.failure` audit in store | He's at the wrong URL (probably SAP BI) | Send him the current sap-logistics URL (see section 0) |
| Moti can't log in, `login.failure` audit visible | Wrong password OR account locked | Check `FailedLoginCount` + `LockedUntil` in store.users for him. Reset password (sec 5) or clear lock |
| `/health` returns `sapConnected: false` | SAP Service Layer or SQL Server unreachable | Ask SAP admin to check 192.168.0.220. Reads via SQL still work; writes via SL won't |
| Public URL gives 502 | Tunnel up, backend down | `pm2 restart sap-logistics` |
| Public URL gives "Tunnel offline" or "DNS_PROBE_FINISHED_NXDOMAIN" | Cloudflare tunnel process died and URL got reissued | `pm2 logs cloudflare-tunnel --lines 50` → find new URL; restart cloudflare-tunnel if needed |
| Page loads but shows SAP BI title | You're on the SAP BI tunnel URL, not sap-logistics | Switch URL (different process) |
| 401 on every API call after login | JWT_SECRET in .env was rotated | All sessions invalidated by design; user re-logs in |
| Stuck wave in `PENDING_QC` with run still `OPEN` | Picking flow interrupted | Operator approves QC via UI, or run `scripts/recovery-stuck-qc-waves.js --apply` after editing ALLOWED_RUN_IDS |
| store.json size dropped suddenly (< 100 KB) | Truncated write or accidental edit | STOP everything. Restore from `backend/data/backups/`. See section 7 |
| Port 4000 in use, can't start | Some stale process is binding it | `netstat -ano \| findstr :4000` → `taskkill /F /PID <pid>` |
| `pm2 list` shows process keeps restarting | Some bug in the latest deploy | Check `pm2 logs sap-logistics --lines 100`. If unfixable in 5 min — git checkout previous commit + rebuild |

---

## 7. Backups & restore

### Where backups live

`backend/data/backups/` contains everything:
- `store-YYYYMMDD-HHmmss.json` — daily auto-snapshots (kept 30 days)
- `store.PRE-PWRESET-MOTI-*.json` — created before any password reset
- `store.PRE-RECOVERY-STUCK-QC-*.json` — created before recovery scripts
- `store.PRE-RESTART-TEST-*.json`, `store.PRE-SEED-*.json` etc. —
  created by various operational scripts
- `store.PRE-RESTORE-*.json` — created by the restore script itself

The directory is in `.gitignore` so backups stay local.

### When to restore

- store.json got corrupted (won't parse as JSON, or `pm2 logs
  sap-logistics` shows errors about missing fields)
- A bad migration or script wiped data
- Someone did a manual edit that broke things

### How to restore

```
cd <repo-root>

# 1. List backups
ls backend/data/backups/ | Sort-Object -Descending

# 2. Pick the one just BEFORE the corruption
$pick = "store-20260518-030000.json"   # or whichever fits

# 3. Run the restore script — it handles PM2 stop/start/liveness
powershell -ExecutionPolicy Bypass -File scripts/restore-store-from-backup.ps1 $pick
```

The restore script:
1. Validates the chosen backup is parseable JSON
2. Saves the CURRENT broken state as `store.PRE-RESTORE-<ts>.json`
   (so the restore is reversible)
3. Stops PM2 `sap-logistics`
4. Copies the backup over `store.json`
5. Starts PM2 back up
6. Waits for HTTP 401 on `/api/auth/me`

### Daily auto-backup at 03:00

Windows Task Scheduler runs `scripts/daily-backup-store.ps1` at 03:00
every day. To check:
```
Get-ScheduledTask -TaskName "sap-logistics-daily-store-backup" | Format-List
```

To see the log of past backups:
```
type logs\store-backup.log
```

---

## 8. Tunnel URLs

Currently sap-logistics is exposed via a Cloudflare **quick tunnel**,
which means the URL changes every time the tunnel restarts. To find the
current URL:

```
pm2 logs cloudflare-tunnel --lines 400 --nostream | findstr trycloudflare
```

The MOST RECENT URL is the active one. If multiple appear, take the last
one in the output.

**As of 2026-05-18 the active URL is**:
`https://flavor-lone-automatically-referrals.trycloudflare.com`

**This will change** when the tunnel restarts. The plan to migrate to a
stable named tunnel is in `docs/cloudflare-tunnel-setup.md`.

⚠️ Do **not** give operators the URL `sunglasses-bend-timber-fabrics.trycloudflare.com` —
that's the SAP BI tunnel, a different system on the same machine.

### Verifying you have the right URL

Open the URL in a browser and check the `<title>`:
- `SAP Logistics Hub` — correct
- `SAP BI` — wrong, that's the management dashboard

---

## 9. Logs

| File | What it records |
|---|---|
| `~/.pm2/logs/sap-logistics-out.log` | Backend stdout (every request, every print) |
| `~/.pm2/logs/sap-logistics-error.log` | Backend stderr (errors only) |
| `~/.pm2/logs/cloudflare-tunnel-*.log` | (often empty — `cloudflared` writes to stderr which PM2 captures depending on config) |
| `logs/store-backup.log` | Daily backup runs (OK / errors) |

To tail the backend in real time:
```
pm2 logs sap-logistics
```

Ctrl+C to stop tailing.

---

## 10. Escalation

| Issue | Who | How |
|---|---|---|
| SAP B1 server (192.168.0.220) down | SAP partner / IT | Phone |
| Windows server hanged / disk full | Local IT | Phone |
| Cloudflare account / billing | izik (account owner) | dashboard.cloudflare.com |
| GitHub repo access | izik | github.com/settings |
| Anthropic API billing | izik | console.anthropic.com |

---

## 11. Architecture decisions worth remembering

| Decision | Rationale |
|---|---|
| Persistent store = JSON file, not SQL | Simplicity. Single-machine deployment, no concurrent writers, fits in RAM. If load grows or we need ACID guarantees, migration to SQLite or Postgres is straightforward (store.js is the only touch-point). |
| PM2 instead of Windows Service | Cross-platform, easier process management UX, lower friction for `pm2 reload`. |
| Cloudflare quick tunnel (currently) | Zero setup. To be replaced by named tunnel for URL stability. |
| Frontend built and served by backend | Single port (4000), single tunnel, single deploy. Vite dev server (5173) is only for development. |
| No CI/CD yet | Builds run manually on this machine; commits go to GitHub for backup, not for automated deploys. |
| AI features (Anthropic API) are optional | The core picking/distribution flow has zero AI dependency. AI features fail gracefully if `ANTHROPIC_API_KEY` is empty. |
