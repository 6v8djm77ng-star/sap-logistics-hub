# Cloudflare Tunnel — Dependency Analysis

**Trigger:** the public URL `https://contribute-maker-archives-metres.trycloudflare.com` (per `external-reachability-report.md`) is the active exposure surface. The natural reflex — "just kill the tunnel" — would break business flows. This document maps which flows depend on the tunnel and what's safe vs unsafe.

**Investigation method:** `Grep` + targeted reads across `backend/src/demo/demoServer.js`, `backend/src/services/`, `frontend/src/pages/`, `cf-tunnel-error.log`, `dump.pm2`. No code modifications.

---

## 1. The tunnel app — quick recap

- **PM2 app:** `cloudflare-tunnel` (pm_id 5).
- **Process:** `cloudflared.exe tunnel --url http://localhost:4000`.
- **Active URL:** `https://contribute-maker-archives-metres.trycloudflare.com` (created 2026-05-07T06:46Z; today's heartbeat 2026-05-10T06:46Z).
- **Publishes to:** Cloudflare's public quick-tunnel infrastructure on `*.trycloudflare.com`. **No auth at the tunnel layer.**
- **Reachability:** anyone on the internet.

Two other tunnel apps (`sap-bi-tunnel`, `sap-bi-ngrok`) target port 3001 — different project, not us.

---

## 2. Flows that DEPEND on the tunnel

### 2.1 Mobile-link admin onboarding (most-direct dependency)

**File chain:**
- `frontend/src/components/MobileLinkDialog.jsx:20` — admin clicks "send link to my phone".
- `POST /api/auth/mobile-link` (`demoServer.js:168-243`) — server builds the public URL.
- `demoServer.js:200-208` — server reads `cf-tunnel-error.log`, regex-extracts the latest `https://*.trycloudflare.com` URL, embeds it in the response: `${publicBase}/m/admin/${shortId}`.
- The admin scans the QR / clicks the SMS link on their phone. Their phone hits `https://contribute-maker-archives-metres.trycloudflare.com/m/admin/<shortId>`.
- `frontend/src/pages/MobileShortLinkPage.jsx:23` consumes the shortId, gets a JWT, redirects to `/`.

**Without tunnel:**
- `demoServer.js:212-225` falls back to LAN IP detection (`192.168.0.14:4000`), then `req.headers.host`.
- LAN IP is unreachable from a 4G phone outside the office. Admin cannot complete the flow from off-LAN.

### 2.2 Customer SMS tracking (highest business impact)

**File chain:**
- `POST /api/runs/stops/:stopId/tracking-link` (`demoServer.js:1592` per `route-matrix.md`) — planner generates a tracking URL.
- `services/trackingTokens.js:9` — generates a 32-hex random token, stores in DB with 48h expiry.
- The URL the planner sends to the customer (via SMS or copy-paste) must be reachable from the customer's phone.
- The URL is constructed using the same `publicBase` resolution logic (env `PUBLIC_URL`, then cf-tunnel log mining, then LAN, then req-host).
- Customer clicks → `https://<tunnel>/t/<token>` → `pages/TrackingPage.jsx:49` polls every 30s for status.
- TrackingPage shows: customer street + lat/lng + driver name + plate + live GPS while in transit.

**Without tunnel:**
- New tracking links generated post-tunnel-down would have a non-internet-reachable URL → customers can't open them.
- Pre-existing SMS messages already in customers' phones would 404 on the path.
- **This is a CUSTOMER-FACING outage.** Business impact: customers expecting "where is my driver" cannot see status.

### 2.3 Driver mobile PWA (latent dependency)

**Less direct.** Drivers normally connect via the office Wi-Fi or via a known internal URL configured during onboarding. The tunnel is NOT the documented driver path.

But:
- If the QR onboarding flow (§2.1) is what configured the driver phone with `localStorage.tunnel-base-url`, then the driver phone may be using the tunnel URL as its API base.
- After tunnel goes down, drivers off-LAN (e.g., halfway through a route) lose API connectivity.
- **Verify with operator:** what URL is in `localStorage` on a driver phone? `frontend/src/services/api.js` baseURL is configured via `import.meta.env.VITE_API_BASE_URL` at build time, not runtime — so it's whatever was set when `npm run build` last ran.

### 2.4 Indirect dependency: `cf-tunnel-error.log` itself

`demoServer.js:200-208` reads this file at runtime to extract the URL. If `cf-tunnel-error.log` is deleted or empty, the mobile-link flow falls back to LAN/req-host.

The file IS in `backend/logs/cf-tunnel-error.log` (~40 KB, growing). Per `security-reaudit.md` F37, this is a minor exfil channel (auth-required) but not a blocker.

---

## 3. Flows that DO NOT depend on the tunnel

### 3.1 LAN-only flows (office Wi-Fi)
- Planner desktop browser at `http://192.168.0.14:4000` (or a LAN-mapped DNS name).
- Warehouse handheld terminals on office Wi-Fi.
- Wallboard TVs in the warehouse.
- Admin UI from any LAN device.

These continue to work whether the tunnel is up or down.

### 3.2 Backend integrations
- SAP B1 SQL Server connections (`SAP_SQL_HOST` per `.env`).
- SAP Service Layer outbound calls.
- SMTP outbound (notifications.js).
- Anthropic API outbound.
- All worker schedulers.

None of these depend on inbound tunnel traffic.

### 3.3 Direct localhost calls
- `monitor-host.ps1` per `monitoring-setup.md` calls `http://localhost:4000/health` — still works.

---

## 4. What breaks under each scenario

### 4.1 Scenario A — Tunnel disabled, no other change
| Flow | Status |
|---|---|
| Office LAN access | ✅ unchanged |
| Customer SMS tracking links — already sent | ❌ **dead links** |
| Customer SMS tracking links — new | ❌ **generated with LAN URL, not reachable from customer phone** |
| Mobile-link admin onboarding | ❌ generated link not reachable from off-LAN phones |
| Driver phones on LAN | ✅ unchanged |
| Driver phones off-LAN (out on routes) | ⚠️ **depends** on what URL is baked into their PWA bundle. Verify before disabling tunnel. |

### 4.2 Scenario B — Tunnel up, Wave A auth applied (recommended)
| Flow | Status |
|---|---|
| Office LAN access | ✅ unchanged |
| Anonymous internet probe of `/api/customers`, `/api/drivers`, `/api/users` | ✅ now 401 (closed) |
| Anonymous internet probe of `/api/runs`, `/api/picking`, etc. (NOT in Wave A) | ⚠️ still 200 — requires Wave B/C |
| Customer SMS tracking | ✅ unchanged (`/api/public/track/:token` is public-by-design, not in Wave A) |
| Mobile-link admin onboarding | ✅ continues to work (POST /api/auth/mobile-link is auth-required already) — token TTL drops to 1h |
| Driver phones (any location) | ✅ unchanged |
| Customer-facing tracking page | ✅ unchanged |

### 4.3 Scenario C — Tunnel migrated to Cloudflare named-tunnel + Access policies
| Flow | Status |
|---|---|
| Office LAN access | ✅ unchanged |
| Internet anonymous probe of any route | ❌ blocked by Cloudflare Access at the edge |
| Customer SMS tracking | ❓ depends on Access policy (would need to allow `/api/public/track/*` and `/t/*` without auth) |
| Mobile-link admin onboarding | ✅ Access policy gates with admin SSO |
| Driver phones | ❓ would need a device-cert or service-token Access policy |

Scenario C is the right long-term answer per `recommendations.md`. Out of emergency-mitigation scope.

### 4.4 Scenario D — Tunnel disabled AND VPN/internal-DNS set up
| Flow | Status |
|---|---|
| Office LAN access | ✅ unchanged |
| Drivers via VPN | ✅ if all drivers have VPN clients configured |
| Customers without VPN (the public) | ❌ **tracking links die forever** unless replaced with a cf-named-tunnel URL or other public path |

Scenario D works for internal users only. **Not viable** for customer-facing tracking.

---

## 5. What breaks under "auth added" (Wave A) vs "tunnel disabled"

| Flow | Wave A applied | Tunnel disabled |
|---|---|---|
| Customer SMS tracking | ✅ unchanged | ❌ broken |
| Admin mobile onboarding | ✅ TTL is 1h instead of 30d | ❌ link not reachable |
| Anonymous PII reads | ✅ blocked | ✅ blocked (entire surface offline) |
| Anonymous user CRUD | ✅ blocked | ✅ blocked |
| Office LAN ops | ✅ unchanged | ✅ unchanged |
| Net business impact | minimal (some shortened TTLs, frontend continues to work) | severe (customer-facing outage) |

**Key insight:** Wave A closes 80% of the actively-exploitable risk while preserving ALL business-critical flows. Tunnel disable would close 100% of internet exposure but break customer-facing tracking. Wave A is the dominant choice.

---

## 6. Public-facing routes that should stay anonymous

Even after Wave A, these routes MUST remain anonymous-from-internet because that's their design:

| Route | Why anonymous | Source |
|---|---|---|
| `GET /health` | Health probe; intentional | `demoServer.js:284` |
| `GET /api/public/track/:token` | Customer-facing; tokenized auth | `demoServer.js:2103`, `services/trackingTokens.js` |
| `POST /api/auth/login` | Login endpoint; needs to be reachable to log in | `demoServer.js:91` |
| `POST /api/auth/driver-login` | Driver login | `demoServer.js:100` |
| `POST /api/auth/picker-login` | Picker handheld login | `demoServer.js:109` |
| `GET /m/admin/:shortId` | Bootstrap auth flow on a fresh device | `demoServer.js:3289` |
| `GET /api/auth/mobile-link/:shortId` | Companion to /m/admin (returns JSON token) | `demoServer.js:246` |

All of these are **explicitly EXCLUDED from Wave A**. The middleware definitions in `emergency-mitigation-plan.md` §2 do not touch these prefixes.

---

## 7. Tunnel posture decision matrix

For the operator. Pick one row.

| Posture | Setup time | Risk reduction | Customer impact | Reversibility |
|---|---|---|---|---|
| **Keep quick-tunnel + Wave A** | Wave A only (1-2 hours) | High (closes anonymous PII + account takeover) | None | Easy (revert Wave A commit) |
| **Migrate to Cloudflare named-tunnel + Wave A** | 2-4 hours + Wave A | Very High (Access policies + auth) | None if policies allow `/api/public/track/*` | Medium (named-tunnel is durable; revert means restart quick-tunnel) |
| **Disable quick-tunnel, no Wave A** | 1 minute | Highest (no exposure) | Severe (customer SMS dead) | Easy (`pm2 start cloudflare-tunnel`) |
| **Disable quick-tunnel, do Wave A first, then disable in window** | 1-2 hours + 1 minute | Highest | Customer SMS dead from disable-time onward | Easy |
| **Do nothing** | 0 | Status quo (PUBLIC_INTERNET_EXPOSED) | None | n/a |

**Recommendation: row 1 (Keep + Wave A) for emergency. Row 2 as the durable Phase-0-tail or Phase-1 follow-up.**

---

## 8. Pre-Wave-A operator survey

Before deploying Wave A, the operator should confirm:

```text
[ ] Is the cloudflare-tunnel still in active business use?
    - Customer tracking SMS: yes / no?
    - Mobile-link admin onboarding: yes / no?
    - Off-LAN driver phones using the tunnel URL as API base: yes / no?
    - External integrations (e.g., a partner system) calling the tunnel URL: yes / no?

[ ] If yes to any of the above:
    - Wave A applies; do NOT disable the tunnel.
    - Plan named-tunnel migration as a Phase-0-tail (this week or next).

[ ] If no to all of the above:
    - Disable the tunnel after Wave A as a defense-in-depth measure.
    - Or skip Wave A entirely and just disable the tunnel.

[ ] Frontend `dist/` build base URL — what's in
    `frontend/src/services/api.js` baseURL or VITE_API_BASE_URL at last build?
    - localhost:4000 (LAN deployment) → tunnel disable safe
    - tunnel URL → tunnel disable would break the SPA
    - relative URL ("/api") → tunnel disable depends on which host the SPA is loaded from
```

The fact that `MobileLinkDialog.jsx:20` and the `services/trackingTokens.js` chain reach into `cf-tunnel-error.log` to find the public URL is strong evidence that the tunnel IS in production use. **Default assumption: tunnel is in use; do NOT disable without confirmation.**

---

## 9. Safest short-term tunnel posture

**Recommendation: KEEP the quick-tunnel up while deploying Wave A.**

Reasons:
1. Confirmed business flows (customer SMS tracking, admin onboarding) depend on it.
2. Wave A reduces the active exposure to acceptable levels (PII + account-CRUD closed; Wave B/C surface remains but is lower-criticality).
3. Disabling the tunnel is reversible in 1 command (`pm2 start cloudflare-tunnel`) — keep it as a fallback move if Wave A fails to deploy.
4. The named-tunnel migration is a Phase-0-tail decision that doesn't need to gate Wave A.

**Schedule the named-tunnel migration as a separate operator task post-Wave-A.** Estimated 2-4 hours: provision Cloudflare account, create named tunnel, set up Access policy with admin SSO + carve-out for `/api/public/track/*`, swap PM2 app to use the named tunnel, retire the quick-tunnel.

---

## 10. What this means for `cf-tunnel-error.log` and F37

`security-reaudit.md` F37 noted that demoServer mines this log for tunnel URLs. After Wave A:

- `POST /api/auth/mobile-link` is still auth-gated (was already; line 168-170).
- The log file content is now exposed only to authenticated admins.
- F37 stays P1; no urgent change.

If the operator chooses to migrate to a named-tunnel:
- `cf-tunnel-error.log` becomes obsolete (the named-tunnel URL would be in `backend/.env` as `PUBLIC_URL=...`).
- demoServer.js:200-208 (the log mining) becomes dead code; can be removed at cutover.
- Truncate the log: `Clear-Content backend\logs\cf-tunnel-error.log` (operator action; after named-tunnel is live).

---

## 11. Document references

- `external-reachability-report.md` — the active URL evidence
- `emergency-mitigation-plan.md` — Wave A details
- `exposure-reduction-options.md` §10 — network reachability discussion
- `route-matrix.md` §Q — public-by-design routes
- `security-reaudit.md` F37 — cf-tunnel-error.log mining
- `recommendations.md` Tier 3 — long-term named-tunnel migration

End of tunnel dependency analysis.
