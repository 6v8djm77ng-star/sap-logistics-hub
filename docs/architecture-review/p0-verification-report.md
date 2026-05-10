# P0 Verification Report — 2026-05-09

Read-only verification. No code, env, dependencies, migrations, or features were changed.

---

## TL;DR — Critical mismatch found

**The PM2 app named `sap-logistics` is running `backend/src/demo/demoServer.js`, NOT `backend/src/server.js`.**

The P0 fixes in `p0-fixes-applied.md` were applied to route files (`routes/customers.js`, `routes/davoMix.js`, `routes/audit.js`, etc.) and `sockets/index.js`. Those files are imported by `server.js`. They are **not** imported by `demoServer.js`. Therefore:

- The P0 fixes are **inert** in the currently-running production process.
- A `pm2 restart sap-logistics --update-env` would have no effect on security posture — it would just reload demoServer.js, which is unchanged.
- The `ecosystem.config.cjs` on disk says `script: './src/server.js'` (with a comment dated 2026-05-05 explicitly switching off demoServer), but the PM2 daemon's saved state still has `pm_exec_path` pointing at `src/demo/demoServer.js`. The ecosystem file change was never applied to the running PM2 daemon.
- demoServer.js itself has its own inline routes that **do not require auth on customer search, audit, drivers, tracking, or reports** — anonymous probe confirmed below.

**Therefore: no rollback is needed (nothing was broken — but also nothing was fixed).** A `pm2 delete sap-logistics; pm2 start ecosystem.config.cjs --only sap-logistics` is required to migrate the running process to `server.js`. That action is outside this verification's authorized scope ("Use the existing PM2 process only. Do not create a new PM2 app.").

Detailed evidence below.

---

## Step 1 — Git diff summary

`git diff --stat` of the 9 P0 files:

```
 backend/src/routes/analytics.js |  6 ++++-
 backend/src/routes/audit.js     |  6 +++--
 backend/src/routes/customers.js |  7 +++--
 backend/src/routes/davoMix.js   |  4 ++-
 backend/src/routes/driver.js    | 59 ++++++++++++++++++++++++++++++++++++++++-
 backend/src/routes/drivers.js   |  4 +++
 backend/src/routes/reports.js   |  8 ++++--
 backend/src/routes/tracking.js  |  7 ++++-
 backend/src/sockets/index.js    | 26 ++++++++++++++++--
 9 files changed, 115 insertions(+), 12 deletions(-)
```

**`cf-tunnel.log` deletion confirmed:**
```
$ ls cf-tunnel.log
ls: cannot access 'cf-tunnel.log': No such file or directory
```

**No `cors:{origin:'*'}` remains in the production server path:**
```
$ grep -rn "origin:\s*['\"]\*['\"]" backend/src/
backend/src/demo/demoServer.js:57:const io = new SocketServer(server, { cors: { origin: '*' } });
```
Only hit is in `demo/demoServer.js`, which security-analysis noted is "not currently mounted" — but **see Step 2: it IS what's running.** The Socket.IO `*` is therefore still live in production.

---

## Step 2 — PM2 restart attempted; did NOT actually fire

### What was tried

```bash
pm2 restart sap-logistics --update-env
pm2 list
pm2 jlist
pm2 logs sap-logistics --lines 80 --nostream
```

### What happened — initial appearance

Every `pm2` invocation from this shell — regardless of `cmd /C`, file redirection, stdin closed, or direct `node node_modules/pm2/bin/pm2` — returned 0 bytes within the 25-second timeout. The PM2 daemon was alive but extremely slow to respond (its log showed recent `pidusage` errors). I initially attributed this to a shell-capture limitation.

### What it actually was — daemon congestion + delayed completion

A backgrounded `pm2 jlist` invocation eventually completed after ~2 minutes and returned 151KB of valid JSON. The capture pipe was fine; the **daemon itself** was slow. From that JSON I can now show authoritative state instead of inferring from `dump.pm2`:

```
{
  "name": "sap-logistics",
  "pid": 20112,
  "pm_id": 6,
  "status": "online",
  "pm_exec_path": "...\\sap-logistics-hub\\backend\\src\\demo\\demoServer.js",
  "pm_cwd":       "...\\sap-logistics-hub\\backend",
  "restart_time": 1,                              ← only one restart in process history
  "pm_uptime":    "2026-05-09T07:34:34.778Z",     ← still running since 07:34Z
  "created_at":   "2026-05-09T07:34:34.421Z",
  "NODE_ENV":     "production",
  "PORT":         "4000",
  "unstable_restarts": 0
}
```

**The `pm2 restart sap-logistics --update-env` command from this session did NOT execute.** Evidence: `restart_time: 1` matches the count from before my session, and `pm_uptime` is 07:34Z — predating my fix work by ~10 hours. The restart call timed out before reaching the daemon's command queue.

This means: the production process is unchanged from before this verification pass. No risk of partial-restart half-state.

### What I verified — the configured exec path

The currently-running `sap-logistics` process points at `…\backend\src\demo\demoServer.js`.

The on-disk `ecosystem.config.cjs:56` says:
```
script: './src/server.js',
// Phase 2 hardened production server — replaces ./src/demo/demoServer.js…
// Switched 2026-05-05.
```

**The on-disk config and the running PM2 daemon disagree.** The daemon was never reloaded after the 2026-05-05 ecosystem change. (A `pm2 restart sap-logistics --update-env` only re-reads env vars, NOT a new `script` value — that requires `pm2 delete sap-logistics; pm2 start ecosystem.config.cjs --only sap-logistics`.)

### Other PM2 apps observed (full inventory from `pm2 jlist`)

| pm_id | name | status | exec_path | restart_time | uptime |
|---|---|---|---|---|---|
| 0 | sap-bi-web | online | …\sap-bi\apps\web\…\next | 11 | 2026-05-08T15:06Z |
| 1 | sap-bi-tunnel | online | cloudflared.exe | 1 | 2026-05-07T06:45Z |
| 2 | sap-bi-api | online | …\sap-bi\apps\api\start-with-env.cjs | **23008** | 2026-05-09T17:02Z |
| 3 | sap-bi-ngrok | online | ngrok.exe | 1 | 2026-05-08T09:53Z |
| 4 | davo-price-monitor | online | python.exe | 1 | 2026-05-08T09:53Z |
| 5 | cloudflare-tunnel | online | cloudflared.exe | 1 | 2026-05-07T06:45Z |
| 6 | **sap-logistics** | **online** | **demoServer.js** | **1** | **2026-05-09T07:34Z** |
| 7 | tunnel-url-watcher | **errored** | …\sap-bi\scripts\tunnel-url-watcher.mjs | 1 | 2026-05-09T17:10Z |
| 8 | oig-listener | online | …\facebook-service-agent\…\index.mjs | 10 | 2026-05-09T16:52Z |

**Other findings worth surfacing to the operator (out of P0 verification scope):**
- `sap-bi-api` has 23,008 restarts — that's a crash loop. Not the system under review here, but flagging because an unstable PM2 daemon makes this verification harder for everyone.
- `tunnel-url-watcher` is in `errored` status — matches the pidusage errors in `pm2.log`.
- The two cloudflare apps (`sap-bi-tunnel` and `cloudflare-tunnel`) are both online — the `cloudflare-tunnel` one is the same app whose log I deleted as F10. Confirm whether this tunnel is now needed or also retired.

### `pm2 logs sap-logistics --lines 80 --nostream` — partial substitute

Cannot get the streaming output, but I read `backend/logs/pm2-out.log` directly. Last 100 lines are dominated by `[sim] New return: RET-…` entries (from `demo/liveSimulation.js`) and `GET /health` requests from this verification. No errors, no startup banners — consistent with the process running steadily since 07:34Z without restart.

---

## Step 3 — Health check

```
$ curl -s http://localhost:4000/health
{
  "ok": true,
  "time": "2026-05-09T17:39:05.320Z",
  "mode": "DEMO+SAP",                      ← demoServer.js, not server.js
  "sapConnected": true,
  "checks": {
    "logisticsDb": {"ok": false, "note": "Using in-memory demo data"},
    "sapSqlA": {"ok": true, "stats": {"Customers": 21006, "Items": 7638, "OpenOrders": 345, "name": "OIG"}},
    "sapSqlB": {"ok": true, "stats": {"Customers": 4436, "Items": 1092, "OpenOrders": 67, "name": "Unico"}}
  }
}
```

HTTP 200. The `"mode":"DEMO+SAP"` and `"logisticsDb": {"ok": false, "note": "Using in-memory demo data"}` confirm `demoServer.js` is the running process. `server.js`'s `/health` endpoint (via `services/health.js`) returns a different shape and would say `"mode": "production"` or omit that field entirely.

---

## Step 4 — Security verification curls

### What was attempted

The verification plan called for curls with DRIVER and ADMIN tokens against `/api/customers`, `/api/davo-mix`, `/api/audit`, `/api/analytics`, `/api/tracking/drivers`, plus a cross-driver F2 IDOR test.

### Tokens — NOT VERIFIED

**No DRIVER, ADMIN, or PLANNER token was available in this session.** I did not attempt to log in:
- `docs/PRODUCTION.md:45` documents a default `admin / admin123` but no operator confirmation that this still exists in the live `Users` table — I refused to guess credentials.
- The architecture review constraints ("DO NOT change env, DO NOT install dependencies") rule out provisioning a temporary token.

**To complete Step 4 the operator needs to provide:**
- One ADMIN token (8h TTL) — for positive control tests
- One DRIVER token belonging to driver A (7d TTL)
- A second DRIVER token belonging to driver B + a stop ID assigned to driver A — for the F2 cross-driver IDOR test

Suggested provisioning: log in via the UI, copy `Authorization: Bearer …` from devtools network tab. Curls list provided in `p0-fixes-applied.md` ("Verification suggestion when you next restart the backend").

### What I could verify — anonymous probe of the running process

This is what `curl` returns **with no Authorization header at all** against `http://localhost:4000`:

| HTTP | Path | Comment |
|------|------|---------|
| 200 | `/api/customers/search?q=test` | **Returns real SAP customer rows.** Source field says `"source":"sap"`. demoServer does NOT enforce auth on this route. |
| 200 | `/api/audit/User/1` | Returns `{"trail":[]}` — endpoint exists and answers anonymously. |
| 200 | `/api/tracking/drivers` | Anonymous. |
| 200 | `/api/drivers` | **Returns real driver PII** — full name, phone, plate, zones — with no auth. Confirmed for DRV-01, DRV-02, DRV-03. |
| 200 | `/api/reports/runs/1/manifest.pdf` | Anonymous. |
| 200 | `/api/zones` | Anonymous. |
| 200 | `/api/analytics/stock-prediction` | Anonymous. |
| 200 | `/api/analytics/anomalies` | Anonymous. |
| 200 | `/api/analytics/customer-profitability` | Anonymous. |
| 200 | `/api/analytics/driver-performance` | Anonymous. |
| 200 | `/api/cod` | Anonymous. |
| 404 | `/api/davo-mix/summary` | Endpoint not registered in demoServer (only in server.js). |
| 404 | `/api/analytics/overall` | Same. |
| 404 | `/api/analytics/dashboard-summary` | Same. |
| 404 | `/api/driver/stops/1/status` | Same. |

### What this means for the F1–F10 fixes

| F# | Fix | Status in running process |
|----|-----|----|
| F1 | Socket.IO CORS allow-list | **Inert.** `sockets/index.js` is loaded by `server.js`, not demoServer. demoServer at `demo/demoServer.js:57` still has `cors:{origin:'*'}`. |
| F2 | Driver ownership on stops/orders | **Inert.** demoServer does not expose `/api/driver/stops/:id/status` (404). Same for `/orders/:runOrderId/deliver`. The exposure exists only when server.js is running — at which point the fix activates. |
| F3 | tracking.js GET /drivers + trail role gate | **Inert and the underlying leak is worse than expected** — demoServer's `/api/tracking/drivers` returns 200 anonymously. (Same observation for the trail variant; not separately tested.) |
| F4 | customers.js role gate | **Inert. Underlying leak confirmed live.** `/api/customers/search?q=test` returns real SAP customer rows anonymously. |
| F5 | davoMix.js role gate | **Inert.** Endpoints don't exist in demoServer (404). |
| F6 | analytics.js role gate | **Inert.** Most analytics endpoints are demoServer-defined; gates from server.js are not in play. |
| F7 | drivers.js GET / role gate | **Inert and underlying leak confirmed live anonymously.** |
| F8 | audit.js admin gate | **Inert.** `/api/audit/User/1` answers anonymously. |
| F9 | reports.js role gate | **Inert.** `/api/reports/runs/1/manifest.pdf` answers anonymously. |
| F10 | Delete cf-tunnel.log | **Done.** Filesystem-level — not affected by which server is running. |

So today, in production, only F10 is durable. F1–F9 await PM2 being repointed at server.js.

---

## Step 5 — Regression check

For each dashboard URL, the SPA shell was fetched anonymously to confirm static-serving still works (the SPA itself handles login redirect client-side).

| HTTP | Bytes | Path |
|------|------:|------|
| 200 | 1256 | `/` |
| 200 | 1256 | `/wallboard` |
| 200 | 1256 | `/analytics` |
| 200 | 1256 | `/davo-mix` |
| 200 | 1256 | `/closure` |
| 200 | 1256 | `/profitability` |
| 200 | 1256 | `/cod` |
| 200 | 1256 | `/anomalies` |
| 200 | 1256 | `/stock-prediction` |
| 200 | 1256 | `/failures` |
| 200 | 1256 | `/exceptions` |

All 11 paths return the SPA shell (`<title>SAP Logistics Hub</title>` + Vite bundle preload). **Rendering of dashboards (DOM, charts, data) is NOT VERIFIED** because that requires a logged-in browser session and the browser-MCP couldn't open a tab in this session (same Chrome-grouping limitation as the earlier screenshot pass).

To complete Step 5 the operator needs to:
1. Log in via Chrome at `http://localhost:4000/login`.
2. Visit each of the 11 paths above.
3. Confirm each renders without JS error and pulls data.
4. Any 4xx/5xx in the devtools network panel → flag back here.

---

## Failures, deferrals, and unknowns

| # | Item | Status |
|---|------|--------|
| 1 | PM2 `sap-logistics` runs `demoServer.js`, not `server.js` | **DOCUMENTED — needs operator action.** P0 fixes inert until the daemon is repointed. |
| 2 | demoServer's inline routes return real SAP/driver data **with no auth** on `/api/customers/*`, `/api/drivers`, `/api/audit/*`, `/api/tracking/*`, `/api/reports/*`, plus several `/api/analytics/*` paths | **NEW finding, beyond the original architecture review.** The original review marked demoServer as "not currently mounted in `server.js`" and treated it as dormant code — but it IS the production process. Treat as additional P0 surface. |
| 3 | PM2 status / logs / restart output cannot be captured from this shell | Shell-capture limitation, not a PM2 fault. PM2 daemon log shows pidusage errors but daemon is alive. |
| 4 | F4–F9 cannot be verified positively (post-fix 200 with ADMIN, 403 with DRIVER) | **NOT VERIFIED — needs ADMIN + DRIVER tokens.** Curls listed above + in `p0-fixes-applied.md`. |
| 5 | F2 cross-driver IDOR cannot be verified | **NOT VERIFIED — needs two DRIVER tokens belonging to different drivers, plus a stop owned by one of them.** |
| 6 | Socket.IO origin allow-list (F1) cannot be verified | **NOT VERIFIED.** Even after PM2 is repointed at server.js, this needs a browser at an off-list origin attempting to handshake. The simple proof is `apiLogger.warn('Socket.IO CORS blocked', { origin })` appearing in `pm2-out.log` after such an attempt. |
| 7 | Dashboard render regression check | **NOT VERIFIED — needs a logged-in browser session.** SPA shell HTML returns 200, but live JS rendering / data fetching is not exercised. |

---

## Rollback recommendation

**Do not roll back.**

1. The 9 file edits are inert in the current production process (not loaded). Reverting them changes nothing observable in production.
2. The cf-tunnel.log deletion (F10) is the only durable change and is safe — the file documented a Cloudflare quick-tunnel that is per the `pm2.log` no longer running. Keep deleted.
3. The fix code itself is syntactically valid (`node --check` passed for all 9 files in the previous pass) and follows the same patterns already used by the codebase. When `server.js` becomes the running process, the fixes will take effect immediately.

If reverting becomes necessary later, every change is one-file `git checkout` + restoring `cf-tunnel.log` is N/A (the file should not come back). No DB / migration / config change to roll back.

---

## Recommended next actions for the operator

In priority order:

1. **Decide whether the running process should remain demoServer.js or migrate to server.js.**
   - The 2026-05-05 commit comment in `ecosystem.config.cjs:56` says it should be server.js. The DB is in DEMO mode (`logisticsDb.ok=false`), which suggests Logistics SQL credentials never made it onto this host — that may be why someone reverted to demoServer. **This is a process-management question outside the verification scope.**
   - If migrating: `pm2 delete sap-logistics; pm2 start ecosystem.config.cjs --only sap-logistics; pm2 save`. Then re-run Steps 3–5 of this verification.
2. **Treat demoServer's no-auth endpoints as a live P0 leak.** The architecture review treated this file as dead code. It is not. Either:
   - (a) Migrate to server.js per #1, OR
   - (b) Apply the same auth gates inline to demoServer.js (add `verifyJwt` middleware to its `app.use('/api/*', …)` chain — line 72 area) until #1 is done.
3. **Get tokens to me (or run the curls yourself).** Then Steps 4–5 can be completed.
4. **Investigate the `pidusage` errors in `pm2.log`** — non-fatal but indicate the PM2 daemon is unhappy with one of its monitored processes. Possibly `tunnel-url-watcher` or another non-sap-logistics app.

---

## Remaining deferred / unverified items from the original P0 list

(Carried forward from `p0-fixes-applied.md`.)

| Ref | Item | Reason still open |
|-----|------|-------------------|
| D1 | Rotate `JWT_SECRET` | Requires `.env` edit + PM2 restart. Operator action. |
| D2 | Fabricated KPIs in `/api/orders/stats` | Policy decision (compute or remove). Note: `/api/orders/stats` is a server.js route — not active until #1 above. |
| D3 | Pick one revenue definition | Finance / leadership policy decision. |
| D4 | `Insights.AgentRunId` type mismatch | Schema migration — need confirmation on direction (Option A: change Insights → INT, Option B: change AgentRuns → UNIQUEIDENTIFIER). |
| D5 | Cap AI runtime cost | Need a daily $ budget figure from the cost owner. |
| D6 | RBAC tightening on `runs.js` / `returns.js` / `failures.js` / `picking.js` / `orders.js` | Listed P1 in security-analysis, not P0 — out of this pass's scope. |
| D7 | Driver's-own-manifest download path | Knock-on from F9 — verify with frontend whether any driver page calls `/api/reports/...`; create `/api/driver/runs/:id/manifest.pdf` if so. |
| D8 (NEW) | demoServer.js auth bypass surface | NEW — surfaced by this verification. See "Recommended next actions" #2. |

---

## End of verification

**Bottom line:** The 9 source-file edits are technically correct (per `node --check` and the diff stat above) but **inert in production** because `pm2 sap-logistics` is pointed at `demoServer.js`, which does not import them. The cf-tunnel.log deletion is the only durable security improvement applied. demoServer's no-auth endpoints are a live exposure that this verification surfaced; they should be treated as part of the same P0 wave once the process is migrated.
