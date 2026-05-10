# External Reachability Report

**Investigation date:** 2026-05-10. Read-only probes only. No code, env, PM2, or migration changes.

---

## Classification

> # 🔴 PUBLIC_INTERNET_EXPOSED

The currently-running `demoServer.js` on `http://localhost:4000` **is reachable from the public internet** via an active Cloudflare quick-tunnel. All four tested anonymous endpoints respond with real production data to unauthenticated requests from anywhere on the internet.

**Active public URL:** `https://contribute-maker-archives-metres.trycloudflare.com`

This is a more severe exposure than the prior `security-reaudit.md` documented and elevates several P0 findings (F31, F34, F35, F36, F4-family) from "latent risk" to "actively exploitable from anywhere right now".

---

## 1. Tunnel inventory (PM2 + processes)

Source: `C:\Users\izik\.pm2\dump.pm2` parsed via Node + `tasklist | grep -iE 'cloudflared|ngrok'`.

| App (pm_id) | Process | Target | Status | pm_uptime | Public URL |
|---|---|---|---|---|---|
| **`cloudflare-tunnel`** (5) | `cloudflared.exe tunnel --url http://localhost:4000` | **localhost:4000 (sap-logistics / demoServer)** | **online** | 2026-05-07T06:45:54Z (3 days) | **`https://contribute-maker-archives-metres.trycloudflare.com`** |
| `sap-bi-tunnel` (1) | `cloudflared.exe tunnel --url http://localhost:3001 --no-autoupdate` | localhost:3001 (different app) | online | 2026-05-07T06:45:59Z | not us |
| `sap-bi-ngrok` (3) | `ngrok.exe http --domain=jarrett-seral-debonairly.ngrok-free.dev 3001` | localhost:3001 (different app) | online | 2026-05-08T09:53:10Z | `https://jarrett-seral-debonairly.ngrok-free.dev` (sap-bi only) |
| `tunnel-url-watcher` (7) | `node sap-bi/scripts/tunnel-url-watcher.mjs` | (cron-driven, watches sap-bi-tunnel URL) | stopped | 2026-05-09T04:40:00Z | not us |

OS-level confirmation that processes are alive (from `tasklist`):
```
cloudflared.exe   pid 6100   ← cloudflare-tunnel (port 4000)
cloudflared.exe   pid 25392  ← sap-bi-tunnel (port 3001)
cloudflared.exe   pid 18532  ← (third instance — likely a child of one of the above)
ngrok.exe         pid 7524   ← sap-bi-ngrok (port 3001)
```

Three cloudflared.exe processes confirms the dump is live.

---

## 2. Public URL evidence chain

Source of the URL: `backend/logs/cf-tunnel-error.log` (40 KB).

**URL history (extracted via grep `https://[a-z0-9-]+\.trycloudflare\.com`):**
```
https://cities-giants-sep-transmitted.trycloudflare.com
https://contribute-maker-archives-metres.trycloudflare.com   ← current (most recent)
https://evening-discuss-reputation-faq.trycloudflare.com
https://incidence-eva-welding-preserve.trycloudflare.com
https://lined-classroom-plaza-clinton.trycloudflare.com
https://superintendent-publications-surface-boston.trycloudflare.com
```

**Most recent activation (cf-tunnel-error.log):**
```
2026-05-07T06:45:53Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-05-07T06:45:59Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-05-07T06:45:59Z INF |  https://contribute-maker-archives-metres.trycloudflare.com                                |
2026-05-07T06:45:59Z INF Settings: map[ha-connections:1 protocol:quic url:http://localhost:4000]
2026-05-07T06:46:01Z INF Registered tunnel connection ... location=tlv01 protocol=quic
```

**Liveness signal:**
- Latest log entry today: `2026-05-10T06:46:11Z WRN Your version 2025.8.1 is outdated. We recommend upgrading it to 2026.3.0` — daily heartbeat from cloudflared, confirming tunnel is alive.

> **Important:** Cloudflare quick-tunnels publish to `*.trycloudflare.com` with **no auth at the tunnel layer**. The whole API is world-reachable. Cloudflare's own quick-tunnel info banner explicitly warns: *"these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use ... If you intend to use Tunnels in production you should use a pre-created named tunnel"* (cf-tunnel-error.log:line for this banner).

---

## 3. Other exposure vectors checked

### 3.1 Windows firewall
- Profile state: **Domain ON, BlockInbound, AllowOutbound** (`netsh advfirewall show currentprofile`).
- No explicit inbound rule for port 4000 found in rule dump.
- However, **the LAN probe succeeded (see §4)** — meaning Windows Firewall is permitting port 4000 from `192.168.0.0/24`. Most likely the rule comes from `node.exe` having a Network-app exception, OR Windows asked the operator on first launch and got "allow" clicked (which becomes a private-network app rule).
- **Cloudflare tunnel does NOT need an inbound firewall rule.** `cloudflared` makes an outbound QUIC connection to Cloudflare's edge, then Cloudflare routes traffic back through that connection. So firewall posture is irrelevant to the public exposure.

### 3.2 LAN IP
- LAN IPv4: `192.168.0.14` (gateway `192.168.0.254`).
- Subnet `192.168.0.0/24` based on the gateway.
- Reachable from any host on the same LAN — see §4.

### 3.3 ngrok configs
- `C:\Users\izik\AppData\Local\ngrok\ngrok.yml` exists with an authtoken and `region: us`.
- `sap-bi-ngrok` PM2 app uses the dedicated free domain `jarrett-seral-debonairly.ngrok-free.dev` for **port 3001 only** (different app — sap-bi-api).
- `backend/ngrok/` directory in this repo is empty.
- **No ngrok exposure of port 4000 found.**

### 3.4 Router/NAT forwarding
- Not directly observable from this host.
- Operator should confirm with whoever administers the office router.
- **However, the Cloudflare tunnel makes router/NAT exposure moot** — cloudflared bypasses NAT by making the outbound connection.

### 3.5 PUBLIC_URL / tunnel URL env values
- `backend/.env` does NOT contain a `PUBLIC_URL=` line (verified via grep).
- `dump.pm2` does NOT contain `PUBLIC_URL` for any sap-logistics-related app.
- demoServer's `mobile-link` endpoint dynamically reads the latest URL from `cf-tunnel-error.log` (`demoServer.js:200-208` — known F37 pattern).
- No `.url` shortcut files found in the repo.

### 3.6 Other tunnel apps
- `sap-bi-tunnel` and `sap-bi-ngrok`: target port 3001 (different project: `sap-bi/apps/api`). Their public URLs do NOT expose sap-logistics. Out of scope for this report.

---

## 4. Reachability probes (read-only GET only)

All probes used `GET` requests with `User-Agent: phase0-reachability-test`. No write requests. No SAP write endpoints touched. No credential probing.

### 4.1 Probe matrix

| Endpoint | localhost (127.0.0.1:4000) | LAN (192.168.0.14:4000) | Public (contribute-maker-archives-metres.trycloudflare.com) |
|---|---|---|---|
| `/health` | **200** (342 B, 0.26s) — `mode:DEMO+SAP`, sapConnected | **200** (0.07s) — same body | **200** (0.60s) — same body |
| `/api/customers/search?q=test` | **200** (302 B) — real SAP customer rows incl. phone numbers (verified e.g. CardCode 220 with phone 054-xxxxxxx) | **200** | **200** — same payload, public internet |
| `/api/drivers` | **200** (549 B) — full driver PII (FullName, Phone, Email, VehiclePlate) | **200** | **200** — full driver PII to public internet |
| `/api/analytics/anomalies` | **200** (42 KB) — 42 KB of customer/order anomaly data including CardName, DocEntry, etc. | **200** | **200** — 42 KB analytics blob to public internet |

### 4.2 What the probes returned

- **`/api/customers/search?q=test`** returned `{"customers":[{"CardCode":"220","CardName":"test12011 test120111","Phone1":"054...","City":"אבטין","ZipCode":"...","CompanyCode":"A"}, …]}` — real SAP customer data including phone numbers.

- **`/api/drivers`** returned `{"drivers":[{"DriverId":1,"Code":"DRV-01","FullName":"דניאל","Phone":"050-1234567","Email":"","VehiclePlate":"12-345-67",…}, …]}` — real driver PII (full name, phone, plate, vehicle capacity, zone assignments).

- **`/api/analytics/anomalies`** returned a 42 KB JSON blob with 1000s of anomaly records: customer names, codEntries, dates, dollar amounts. Operational analytics that should be ADMIN/PLANNER only.

### 4.3 Probe consistency

The localhost, LAN, and public URL probes returned **identical payloads** (same byte counts within the same second). This proves:
1. The Cloudflare tunnel is forwarding to localhost:4000 transparently.
2. demoServer is serving the same data regardless of source IP.
3. There is no edge-side filter or auth gate.

### 4.4 What was NOT probed (per task constraint)

- `POST /api/users` — would create a user (write).
- `POST /api/users/:id/reset-password` — would change a password (write).
- `POST /api/sap/write/delivery-note/:id` — env-gated; would attempt SAP write.
- `POST /api/runs/auto-plan` — would mutate state.
- `GET /m/admin/:shortId` with brute-forced shortIds — explicitly excluded.

These remain documented anonymous attack surface in `security-reaudit.md` F31-F36, and based on the §4 read probes, they would respond identically — i.e., the writes WOULD execute from the public URL.

---

## 5. Sensitive anonymous endpoints reachable from the public URL

Based on `route-matrix.md` cross-referenced with the §4 probe results, the following demoServer endpoints are reachable from the public internet today **with no authentication**:

### 5.1 Confirmed reachable (probed during this investigation)
- `GET /health` — system status
- `GET /api/customers/search?q=...` — real SAP customer list with phones
- `GET /api/drivers` — driver PII
- `GET /api/analytics/anomalies` — operational analytics

### 5.2 Strongly implied reachable (same code path, not probed to stay read-only)
Per `security-reaudit.md` and `route-matrix.md`:

**P0 — account takeover vectors:**
- `POST /api/users` — create admin (anonymous)
- `PATCH /api/users/:id` — modify any user
- `POST /api/users/:id/reset-password` — reset any password (incl. admin)
- `DELETE /api/users/:id`
- `GET /m/admin/:shortId` — credential vending HTML page

**P0 — operational disruption:**
- `POST /api/runs` / `PATCH /api/runs/:id` / `DELETE /api/runs/:id`
- `POST /api/runs/auto-plan` / `force-include` / `optimize`
- `POST /api/runs/:id/approve-departure` / `cancel-departure`
- `DELETE /api/stops/:stopId`, all stop mutations
- `POST /api/auth/picker-login` (issues 30-day token from anonymous-input)
- `GET/POST/PATCH/DELETE /api/pickers`

**P0 — SAP write (currently env-gated, fail-closed):**
- `POST /api/sap/write/delivery-note/:id`
- `POST /api/sap/write/invoice/:id`

**P0 — PII reads (same family as the 3 probed):**
- `GET /api/analytics/customer-profitability` — revenue per customer
- `GET /api/analytics/driver-performance` — driver KPIs
- `GET /api/analytics/stock-prediction`
- `GET /api/orders/open` — open SAP orders
- `GET /api/orders/:company/:docEntry/lines` — order line items
- `GET /api/customers/:company/:cardCode` — full customer detail
- `GET /api/customers/:company/:cardCode/recent-items` — 90-day item purchase history
- `GET /api/tracking/drivers` — live GPS of every driver

**Note on what's NOT reachable:**
- `/api/davo-mix/*` is server.js-only; demoServer doesn't have it. Public URL returns 404 for these (DAVO Mix is "dead today" per `route-matrix.md`).
- `/api/audit/*` returns `{trail:[]}` (stub) — endpoint exists but data is empty.

---

## 6. What this changes vs. prior assumptions

| Document | Prior assumption | Today's finding |
|---|---|---|
| `security-reaudit.md` §10 | "Until [reachability is] confirmed, **assume the worst-case (publicly reachable)**." | **Worst-case is true.** Drop the conditional language. |
| `exposure-reduction-options.md` §10 | "If publicly reachable: recommend the full band-aid bundle." | **Trigger condition met.** Recommend full bundle now. |
| `risk-register.md` E1 | "H if internet-reachable" | Probability **H confirmed**. Impact **C** (account takeover from anywhere). |
| `risk-register.md` E5 | "H if internet-reachable" | Probability **H confirmed**. Impact **H** (PII exfil from anywhere). |
| `risk-register.md` D2 | "L latent — env unset" | **L stays L** for now (the env IS unset and that's the only safe-gate). But if `SAP_WRITE_ENABLED` flips, instant escalation to P0-active. |
| `freeze-policy.md` §4 | "Default position: do NOT band-aid" | **Recommendation pivots to "DO band-aid F34 + F4-family immediately"** per the freeze policy's exception clause for "active exploit attempts observed" — and an open public URL counts. |

---

## 7. Recommendation

### 7.1 Immediate recommended action — within next business hours

In priority order:

#### Step 1 — disable the public tunnel if not business-critical (1 minute, fully reversible)
This is the **single highest-impact mitigation possible**. Stops all public exposure in one PM2 command.

**Decision needed first:** is `https://contribute-maker-archives-metres.trycloudflare.com` actively used by anyone (customer SMS tracking links, mobile drivers, external integrations)?

- If NO → stop it: `pm2 stop cloudflare-tunnel; pm2 save`. Public exposure ends instantly. LAN access continues.
- If YES → cannot simply stop. Skip to Step 2 + plan a named-tunnel migration.

The decision hinges on what the tunnel is used for. From the evidence:
- demoServer's `POST /api/auth/mobile-link` (line 168) generates URLs that include this tunnel — it's used for the "send install link to my phone" admin onboarding flow (frontend `MobileLinkDialog.jsx`).
- demoServer's `POST /api/runs/stops/:stopId/tracking-link` (per `route-matrix.md`) generates SMS tracking links that go through this URL to `pages/TrackingPage.jsx`.

**So the tunnel IS in active business use** — disabling it breaks customer tracking SMS and mobile admin onboarding. **Cannot stop without coordination.**

→ **Decision goes to operator. Recommendation: stop the tunnel during a short maintenance window AFTER deploying the band-aid (Step 2), then either restart it as a Cloudflare named-tunnel with Access policies OR keep the band-aid as the durable answer.**

#### Step 2 — deploy the F34 / F4-family band-aid bundle (1-2 hours; see exposure-reduction-options.md §8)

Apply the ~50-line patch from `exposure-reduction-options.md` §8.1. Routes that go from anonymous to auth-required:
- `/api/users/*` (CRUD, reset-password) — `adminOnly`
- `/api/customers/*` — `requireAuthBasic`
- `/api/drivers` (CRUD) — `adminOnly`
- `/api/zones/*` mutations — `adminOnly`
- `/api/runs/*` and `/api/stops/*` mutations — `plannerOrAdmin`
- `/api/pickers/*` — `adminOnly`
- `/api/cod/*` — `requireAuthBasic`
- `/api/analytics/*` — `requireAuthBasic`
- `/api/picking/*` — `requireAuthBasic`
- `/api/delivery-notes`, `/api/invoices`, `/api/documents/*` — `requireAuthBasic`
- `/api/reports/*` — `requireAuthBasic`
- `/api/sap/write/*` — `adminOnly` (belt-and-suspenders for already-env-gated routes)

Plus:
- F31 Option D: TTL → 1h, single-use on `/m/admin/:shortId`
- F36: picker token TTL → 12h

**This is the fastest meaningful exposure reduction without ripping out the tunnel.**

**Sequence:**
1. **First:** complete `pm2-maintenance-runbook.md` (drain the orphan-on-port-4001, leave sap-logistics undisturbed). Required because the band-aid deploy needs a working `pm2 restart`.
2. **Then:** deploy band-aid as a single PR; restart sap-logistics per the runbook.
3. **Then:** verify with the same curls in §4 — every gated endpoint should now return 401.

#### Step 3 — also routine work in parallel (per Phase 0 plan)
- Set up daily store.json backups + monitoring (per `backup-automation-plan.md`, `monitoring-setup.md`).
- Document the public URL leak in `cowork/INCIDENTS.md` with timestamp = today; close it as "addressed" once Step 2 deploys.

### 7.2 Routes to block FIRST (in case Step 2 needs to be split into multiple deploys)

If 50 lines feels too big for one change, split by impact-rank:

**Wave A (highest impact, ~15 lines):**
- `/api/users/*` (account takeover)
- `/api/customers/*` (PII)
- `/api/drivers` (PII)
- `/api/sap/write/*` (latent SAP write)

**Wave B (operational disruption, ~10 lines):**
- `/api/runs/*` mutations
- `/api/stops/*` mutations
- `/api/pickers/*`

**Wave C (analytics PII, ~10 lines):**
- `/api/analytics/*`
- `/api/picking/*`
- `/api/cod/*`

**Wave D (cleanup, ~10 lines):**
- everything else

Each wave is its own PR, its own restart. Sequential risk, smaller blast radius per wave.

### 7.3 Tunnel posture decision (separate from band-aid)

After band-aid is in place, the operator should still decide:
- **Keep quick-tunnel** — risk that the URL leaks via WhatsApp/email/log; URL changes occasionally (cloudflared restart → new random URL).
- **Migrate to Cloudflare named-tunnel** — stable URL, can attach Cloudflare Access policies (zero-trust / device certificate / SSO); ~2-4 hours operator time.
- **Drop external access entirely** — keep on LAN only, drivers connect via VPN.

This is a post-Phase-0 decision, but Step 7.2 makes it less urgent.

---

## 8. What NOT to do

| ❌ Don't | Why |
|---|---|
| `pm2 stop cloudflare-tunnel` blindly without confirming nothing depends on the URL | Customer SMS tracking links, mobile-onboarding QR codes, external integrations may break instantly |
| Issue a `pm2 restart sap-logistics` to deploy the band-aid before the PM2 maintenance runbook is executed | High risk of orphan-on-port-4000 (per `pm2-stabilization.md`) — could take production down for hours |
| Start probing the public URL with write requests to "see what works" | Out of scope; risks creating real users / SAP writes |
| Brute-force the 8-char shortIds on `/m/admin/:shortId` to test F31 | Out of scope; risks legitimate session interference |
| Edit demoServer.js without backups + rollback notes | violates `freeze-policy.md` §3 |
| Set `SAP_WRITE_ENABLED=true` while the tunnel is up | would convert F32/F33 from latent to immediate P0 exploitable from the internet |
| Trust that `*.trycloudflare.com` URLs are obscure / unguessable | URL is in this repo's logs, in the demoServer's `/api/auth/mobile-link` response, and is in cf-tunnel-error.log under git-tracked path. Plus crawlers index Cloudflare's tunnels. Treat as public. |
| Wait for cutover to fix this | Cutover is 4-6 weeks away (`cutover-plan.md`). Do not leave anonymous user-CRUD on the public internet for 6 weeks. |

---

## 9. Final operator summary

> **Classification: PUBLIC_INTERNET_EXPOSED.**
>
> **Evidence:**
> - PM2 app `cloudflare-tunnel` (online since 2026-05-07) runs `cloudflared tunnel --url http://localhost:4000`.
> - Public URL `https://contribute-maker-archives-metres.trycloudflare.com` (in `backend/logs/cf-tunnel-error.log`).
> - Direct read-only probes from this host returned 200 on `/health`, `/api/customers/search?q=test`, `/api/drivers`, `/api/analytics/anomalies` — same body as localhost.
> - Real SAP customer phone numbers, real driver PII, real operational analytics returned to the public URL with no auth.
>
> **Sensitive anonymous endpoints reachable RIGHT NOW from the public internet:**
> - `POST /api/users` (account takeover)
> - `POST /api/users/:id/reset-password` (admin password reset)
> - `GET /api/customers/search` + `GET /api/drivers` + 5 more analytics endpoints (PII exfil)
> - `POST /api/runs/auto-plan` + 10 more run/stop mutations (operational disruption)
> - `GET /m/admin/:shortId` (credential vending; 30-day JWT)
> - `POST /api/sap/write/delivery-note/:id` (latent — env-gated; instantly active if `SAP_WRITE_ENABLED=true`)
>
> **Immediate recommended action:**
> 1. Execute `pm2-maintenance-runbook.md` (PM2 stabilization). 60 min Sunday window.
> 2. Deploy the `exposure-reduction-options.md` §8 band-aid bundle (Wave A first if splitting). 1-2 hours.
> 3. Verify with the §4 probe matrix — every gated endpoint should return 401 from the public URL post-deploy.
> 4. Decide on long-term tunnel posture (keep quick / migrate to named / drop external).
>
> **What NOT to do:**
> - Do not blindly stop `cloudflare-tunnel`; it powers the customer SMS tracking flow.
> - Do not set `SAP_WRITE_ENABLED=true` until band-aid is deployed AND idempotency UDF is in place (`sync-analysis.md` 1.1).
> - Do not deploy the band-aid before PM2 stabilization completes (orphan-on-port-4000 risk).
> - Do not assume a stale URL means the tunnel is gone — the latest log entry is from today.

---

## 10. Document references

- `security-reaudit.md` — F31-F37 source list
- `exposure-reduction-options.md` §8 — band-aid bundle ready to deploy
- `pm2-stabilization.md`, `pm2-maintenance-runbook.md` — required first
- `risk-register.md` E1, E5 — probabilities now confirmed H
- `freeze-policy.md` §4 — exception clause justifies the band-aid given the active exposure
- `route-matrix.md` — full endpoint inventory with criticality
- `cowork/INCIDENTS.md` — where to log the discovery + remediation

End of reachability report.
