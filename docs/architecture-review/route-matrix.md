# Route Matrix — server.js vs demoServer.js vs frontend

Cross-references the production process (currently `demoServer.js`), the intended target (`server.js`), and which frontend page actually calls each endpoint.

**Backend status legend:**
- **R** — handled in `backend/src/routes/*.js` (server.js path)
- **D** — handled inline in `backend/src/demo/demoServer.js`
- **R+D** — both
- **D-only** — only in demoServer; switching to server.js would 404 this route
- **R-only** — only in server.js; route is dead today

**Auth model legend:**
- **anon** — no auth check
- **JWT-advisory** — JWT decoded if present (audit fields), but route runs anonymously if missing
- **JWT-required** — 401 without valid JWT, but no role check
- **role:X** — `requireAuth` + `requireRole(X)`

**Criticality legend:**
- **CRITICAL** — operational hot path; outage stops business (auth, planner, driver, picker, SAP writes, tracking)
- **IMPORTANT** — frequent daily use; outage degrades operations significantly (dashboards, reports, customer policy)
- **OPTIONAL** — low-frequency or read-only nice-to-have (anomalies, profitability, leaderboard)
- **LEGACY** — not actively used / dev tooling (`/api/demo/reset`, mobile-link short URLs)

---

## A. Auth / login

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller (file:line) | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| POST | `/api/auth/login` | R+D | rate-limit + signToken | rate-limit + signToken | `pages/LoginPage.jsx` via `services/api.js:40` | none | CRITICAL |
| POST | `/api/auth/driver-login` | R+D | rate-limit + signDriverToken | rate-limit + signDriverToken | `pages/driver/DriverLoginPage.jsx`, `pages/driver/AutoLoginPage.jsx:26` | none | CRITICAL |
| POST | `/api/auth/picker-login` | **D-only** | — | rate-limit | `pages/PickerAutoLoginPage.jsx:25` | none | CRITICAL (warehouse) |
| GET | `/api/auth/me` | R+D | JWT-required | JWT-required | bootstrap `services/api.js:42` | none | CRITICAL |
| POST | `/api/auth/mobile-link` | **D-only** | — | JWT-required | `components/MobileLinkDialog.jsx:20` | none | OPTIONAL |
| GET | `/api/auth/mobile-link/:shortId` | **D-only** | — | anon | `pages/MobileShortLinkPage.jsx:23` | none | OPTIONAL |
| GET | `/m/admin/:shortId` | **D-only** | — | anon (HTML, mints JWT) | direct browser URL | none | LEGACY (security risk) |
| POST | `/api/users/me/change-password` | R+D | JWT-required | JWT-required | `pages/UsersPage.jsx`, `pages/SettingsPage.jsx` | none | IMPORTANT |

## B. Planner board

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/orders/open` | R+D | role:ADMIN/PLANNER | anon | `pages/OpenOrdersPage.jsx:13` (poll 60s), `components/AddStopDialog.jsx:13` | SAP read | CRITICAL |
| GET | `/api/orders/unified` | R+D | role:ADMIN/PLANNER | anon | wrapper unused | SAP read | OPTIONAL |
| GET | `/api/orders/stats` | R+D | role:ADMIN/PLANNER | anon | `pages/WallboardPage.jsx:29` (poll 5s), `pages/DashboardPage.jsx:17` (poll 60s) | SAP read | CRITICAL |
| GET | `/api/orders/:company/:docEntry/lines` | R+D | role:ADMIN/PLANNER | anon | `pages/OpenOrdersPage.jsx:15` | SAP read | IMPORTANT |
| GET | `/api/runs` | R+D | requireAuth | anon | many — Wallboard, Dashboard, LiveTracking, WeeklyReport, RunsPage, Picking | DB | CRITICAL |
| POST | `/api/runs` | R+D | role:ADMIN/PLANNER | anon | `pages/RunsPage.jsx:23` | DB | CRITICAL |
| POST | `/api/runs/auto-plan` | R+D | role:ADMIN/PLANNER | anon | `pages/PlannerPage.jsx` | DB + SAP read | CRITICAL |
| POST | `/api/runs/force-include` | **D-only** | — | anon | `pages/PlannerPage.jsx:22` | DB | IMPORTANT |
| GET | `/api/runs/:id` | R+D | requireAuth | anon | `pages/RunDetailsPage.jsx` | DB | CRITICAL |
| PATCH | `/api/runs/:id` | **D-only** | — | anon | `components/AssignDriverDialog.jsx:15` (assign driver) | DB | CRITICAL |
| PATCH | `/api/runs/:id/status` | R+D | role:ADMIN/PLANNER | anon | wrapper `runsApi.updateStatus` | DB | CRITICAL |
| POST | `/api/runs/:id/optimize` | **D-only** | — | anon | `pages/RunDetailsPage.jsx:51` | DB | IMPORTANT |
| POST | `/api/runs/:id/optimize-order` | R+D | role:ADMIN/PLANNER | anon | wrapper | DB | IMPORTANT |
| GET | `/api/runs/:id/wave` | R+D | role | anon | `pages/PickingPage.jsx:19` | DB | CRITICAL |
| POST | `/api/runs/:id/wave` | R+D | role:WAREHOUSE | anon | `pages/PickingPage.jsx:20` | DB | CRITICAL |
| POST | `/api/runs/:id/duplicate` | **D-only** | — | anon | `pages/RunsPage.jsx:129` | DB | OPTIONAL |
| POST | `/api/runs/:id/split` | **D-only** | — | anon | `pages/RunDetailsPage.jsx:96` | DB | IMPORTANT |
| GET | `/api/runs/:id/loading-plan` | **D-only** | — | anon | `pages/RunDetailsPage.jsx:75` | DB | CRITICAL |
| POST | `/api/runs/:id/approve-departure` | **D-only** | — | JWT-advisory | `components/DepartureApprovalDialog.jsx:31` | DB | CRITICAL |
| POST | `/api/runs/:id/cancel-departure` | **D-only** | — | JWT-advisory | `pages/RunDetailsPage.jsx:65` | DB | CRITICAL |
| DELETE | `/api/runs/:id` | **D-only** | — | anon | `pages/RunsPage.jsx:120` | DB | IMPORTANT |
| POST | `/api/runs/:id/generate-invoices` | **D-only** | — | anon | `pages/DocumentsPage.jsx:24` | DB + SAP-write-gated | IMPORTANT |
| POST | `/api/runs/:runId/stops` | **D-only** | — | anon | `components/AddStopDialog.jsx:74,104` | DB | CRITICAL |

## C. Stops (planner-board mutations)

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| PATCH | `/api/stops/:stopId` | **D-only** | — | anon | `pages/RunDetailsPage.jsx` | DB | IMPORTANT |
| DELETE | `/api/stops/:stopId` | **D-only** | — | anon | `pages/RunDetailsPage.jsx:112` | DB | IMPORTANT |
| POST | `/api/stops/:stopId/move-up` | **D-only** | — | anon | `pages/RunDetailsPage.jsx:107` | DB | IMPORTANT |
| POST | `/api/stops/:stopId/move-down` | **D-only** | — | anon | `pages/RunDetailsPage.jsx:107` | DB | IMPORTANT |
| POST | `/api/stops/:stopId/move-to-run` | **D-only** | — | anon | `components/MoveStopDialog.jsx:22` | DB | IMPORTANT |
| POST | `/api/stops/:stopId/orders` | **D-only** | — | anon | `components/AddStopDialog.jsx:84` | DB | IMPORTANT |
| GET | `/api/stops/:id/line-deliveries` | **D-only** | — | JWT-advisory | `components/PodCapture.jsx` | DB | IMPORTANT |
| POST | `/api/stops/:stopId/line-deliveries` | **D-only** | — | JWT-advisory | `components/PodCapture.jsx:108` | DB | CRITICAL |
| GET | `/api/stops/:stopId/document-preview` | **D-only** | — | anon | `pages/DocumentsPage.jsx` | DB | OPTIONAL |
| POST | `/api/stops/:stopId/generate-delivery-notes` | **D-only** | — | anon | `pages/DocumentsPage.jsx` | DB + SAP-write-gated | IMPORTANT |
| DELETE | `/api/run-orders/:runOrderId` | **D-only** | — | anon | `pages/RunDetailsPage.jsx:120` | DB | IMPORTANT |

## D. Warehouse / picking / pickers

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/picking/waves` | **D-only** | — | anon | `pages/WarehousePage.jsx:27` (poll 15-20s), `pages/DailyClosurePage.jsx:26` | DB | CRITICAL |
| GET | `/api/picking/:id` | R+D | role | anon | `pages/PickingPage.jsx:18` (poll 10s) | DB | CRITICAL |
| POST | `/api/picking/:waveId/scan` | **D-only** | — | anon | `pages/PickingPage.jsx:22` | DB | CRITICAL |
| POST | `/api/picking/:waveId/qc-approve` | **D-only** | — | anon | `pages/PickingPage.jsx:195` | DB | CRITICAL |
| POST | `/api/picking/:waveId/qc-reject` | **D-only** | — | anon | `pages/PickingPage.jsx:203` | DB | CRITICAL |
| POST | `/api/picking/lines/:lineId/pick` | R+D | role:ADMIN/WAREHOUSE | anon | `pages/PickingPage.jsx:21` | DB | CRITICAL |
| POST | `/api/picking/lines/:lineId/shortage` | **D-only** | — | anon | `pages/PickingPage.jsx:23` | DB | CRITICAL |
| POST | `/api/picking/lines/:lineId/reset` | **D-only** | — | anon | `pages/PickingPage.jsx:24` | DB | IMPORTANT |
| POST | `/api/picking/allocations/:allocId/pick` | **D-only** | — | anon | `pages/PickingPage.jsx:27` | DB | CRITICAL |
| POST | `/api/picking/allocations/:allocId/reset` | **D-only** | — | anon | `pages/PickingPage.jsx:29` | DB | IMPORTANT |
| GET | `/api/pickers` | **D-only** | — | anon | `pages/PickersPage.jsx:14` | DB | IMPORTANT |
| POST | `/api/pickers` | **D-only** | — | anon | `pages/PickersPage.jsx:15` | DB | IMPORTANT |
| PATCH | `/api/pickers/:id` | **D-only** | — | anon | `pages/PickersPage.jsx:16` | DB | IMPORTANT |
| DELETE | `/api/pickers/:id` | **D-only** | — | anon | `pages/PickersPage.jsx:17` | DB | OPTIONAL |

## E. Driver mobile PWA

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/driver/my-runs` | R+D | role:DRIVER/ADMIN | anon | `pages/driver/DriverRunsPage.jsx` (poll 30s) | DB | CRITICAL |
| GET | `/api/driver/runs/:id/manifest` | R+D | role:DRIVER/ADMIN | anon | `pages/driver/DriverManifestPage.jsx` (poll 30s) | DB | CRITICAL |
| PATCH | `/api/driver/stops/:stopId/status` | R+D | role:DRIVER/ADMIN + ownership (F2) | anon | `services/api.js:79` | DB + filesystem | CRITICAL |
| POST | `/api/driver/stops/:stopId/complete` | R+D | role:DRIVER/ADMIN + ownership (F2) | anon | `services/api.js:80` | DB + **SAP write** | CRITICAL |
| POST | `/api/driver/orders/:runOrderId/deliver` | R+D | role:DRIVER/ADMIN + ownership (F2) | anon | `services/api.js:82` | DB + **SAP write** | CRITICAL |
| GET | `/api/notify/eta/:stopId` | **D-only** | — | anon | `components/NotifyEtaButton.jsx:19` | SMS | IMPORTANT |

## F. Live tracking + map

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| POST | `/api/tracking/position` | R+D | requireAuth + driverId | JWT-advisory | `useGpsTracking` hook | DB | CRITICAL |
| GET | `/api/tracking/drivers` | R+D | role:ADMIN/PLANNER (after F3) | anon | `pages/LiveMapPage.jsx:35` (poll 15s) | DB | IMPORTANT |
| GET | `/api/tracking/drivers/:id/trail` | R-only | role:ADMIN/PLANNER (after F3) | — | `services/api.js:110` | DB | OPTIONAL |
| GET | `/api/public/track/:token` | R+D | none (token-based) | none (token-based) | `pages/TrackingPage.jsx:49` (poll 30s) | DB | CRITICAL (customer SMS) |

## G. Wallboard / dashboards / analytics

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/analytics/summary` | R+D | role:ADMIN/PLANNER (after F6) | anon | `pages/AnalyticsPage.jsx:15` | DB + SAP read | IMPORTANT |
| GET | `/api/analytics/overall` / `daily` / `drivers` / `zones` / `failures` / `sap-health` | R-only | role:ADMIN/PLANNER (after F6) | — | `pages/AnalyticsPage.jsx` | DB + SAP read | IMPORTANT |
| GET | `/api/analytics/anomalies` | **D-only** | — | anon | `pages/AnomaliesPage.jsx:19` (poll 60s) | DB | OPTIONAL |
| GET | `/api/analytics/customer-profitability` | **D-only** | — | anon | `pages/CustomerProfitabilityPage.jsx:28` | SAP read | IMPORTANT |
| GET | `/api/analytics/driver-performance` | **D-only** | — | anon | `pages/DriverLeaderboardPage.jsx:15` (poll 30s) | DB | OPTIONAL |
| GET | `/api/analytics/stock-prediction` | **D-only** | — | anon | `pages/StockPredictionPage.jsx:22` | SAP read | IMPORTANT |
| GET | `/api/analytics/suggest-drivers/:zoneCode` | **D-only** | — | anon | `pages/PlannerPage.jsx` (impl-dependent) | DB | OPTIONAL |

## H. Sales / DAVO Mix

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/davo-mix/summary` | **R-only** | role:ADMIN/PLANNER (F5) | — | `pages/DavoMixPage.jsx:69` | SAP read | IMPORTANT |
| GET | `/api/davo-mix/categories` | **R-only** | role:ADMIN/PLANNER | — | `pages/DavoMixPage.jsx:74` | SAP read | IMPORTANT |
| GET | `/api/davo-mix/attach` | **R-only** | role:ADMIN/PLANNER | — | `pages/DavoMixPage.jsx:79` | SAP read | IMPORTANT |
| GET | `/api/davo-mix/attach/top-items` | **R-only** | role:ADMIN/PLANNER | — | `pages/DavoMixPage.jsx:84` | SAP read | IMPORTANT |
| GET | `/api/davo-mix/buyers` | **R-only** | role:ADMIN/PLANNER | — | `pages/DavoMixPage.jsx:89` | SAP read | IMPORTANT |
| GET | `/api/davo-mix/buyers/:cardCode` | **R-only** | role:ADMIN/PLANNER | — | `pages/DavoMixPage.jsx` (drill-down) | SAP read | IMPORTANT |
| GET | `/api/davo-mix/weekly-report/preview` | **R-only** | role:ADMIN/PLANNER | — | `pages/DavoMixPage.jsx` | SAP read | OPTIONAL |
| POST | `/api/davo-mix/weekly-report/run` | **R-only** | role:ADMIN | — | `pages/DavoMixPage.jsx` | SAP read + SMTP | OPTIONAL |

> **Note:** these endpoints are **dead today** — the running demoServer.js does not implement them, so `pages/DavoMixPage.jsx` is broken in production right now. This is the inverse migration risk: the page won't START working until cutover.

## I. Finance

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/cod` | **D-only** | — | anon | `pages/CashOnDeliveryPage.jsx:18` (poll 30s) | DB | IMPORTANT |
| POST | `/api/cod` | **D-only** | — | anon | `pages/CashOnDeliveryPage.jsx` | DB | IMPORTANT |
| PATCH | `/api/cod/:codId/deposit` | **D-only** | — | anon | `pages/CashOnDeliveryPage.jsx:23` | DB | IMPORTANT |
| GET | `/api/cod/driver/:driverId/summary` | **D-only** | — | anon | (driver app, conditional) | DB | OPTIONAL |
| (DailyClosurePage uses `/picking/waves` + `/failures`) | — | — | — | — | `pages/DailyClosurePage.jsx` | DB | IMPORTANT |

## J. Documents Hub

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/delivery-notes` | **D-only** | — | anon | `pages/DocumentsPage.jsx:20` (poll 30s) | DB | IMPORTANT |
| GET | `/api/invoices` | **D-only** | — | anon | `pages/DocumentsPage.jsx:21` (poll 30s) | DB | IMPORTANT |
| GET | `/api/documents/stats` | **D-only** | — | anon | `pages/DocumentsPage.jsx:22` (poll 30s) | DB | IMPORTANT |
| POST | `/api/delivery-notes/:dnId/generate-invoice` | **D-only** | — | anon | `pages/DocumentsPage.jsx:23` | DB + SAP-write-gated | IMPORTANT |
| POST | `/api/documents/:type/:id/confirm-sap` | **D-only** | — | anon | `pages/DocumentsPage.jsx:26` | DB | IMPORTANT |
| POST | `/api/documents/mark-exported` | **D-only** | — | anon | `pages/DocumentsPage.jsx` | DB | OPTIONAL |
| GET | `/api/sap/writer/status` | **D-only** | — | anon | `pages/DocumentsPage.jsx`, `pages/SettingsPage.jsx` | none | OPTIONAL |
| POST | `/api/sap/write/delivery-note/:id` | **D-only** | — | anon (env-gated) | document detail | **SAP write** (gated) | CRITICAL when enabled |
| POST | `/api/sap/write/invoice/:id` | **D-only** | — | anon (env-gated) | document detail | **SAP write** (gated) | CRITICAL when enabled |

## K. Reports / PDF / XLSX

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/reports/exceptions` | R+D | role:ADMIN/PLANNER/WAREHOUSE (F9) | anon | `pages/ExceptionsPage.jsx` (poll 60s) | DB | IMPORTANT |
| GET | `/api/reports/runs/:id/manifest.pdf` | R+D | role (F9) | anon | URL helper, browser anchor | DB | CRITICAL |
| GET | `/api/reports/runs/bulk-manifest.pdf` | **D-only** | — | anon | `pages/RunsPage.jsx` | DB | IMPORTANT |
| GET | `/api/reports/runs/:id/distribution-summary.pdf` | **D-only** | — | anon | run details | DB | OPTIONAL |
| GET | `/api/reports/runs/:id/loading-manifest.pdf` | **D-only** | — | anon | run details | DB | IMPORTANT |
| GET | `/api/reports/waves/:id/picking.xlsx` | R+D | role (F9) | anon | URL helper | DB | IMPORTANT |
| GET | `/api/reports/waves/:id/picking.pdf` | **D-only** | — | anon | warehouse | DB | IMPORTANT |
| GET | `/api/reports/delivery-notes.xlsx` | **D-only** | — | anon | documents | DB | IMPORTANT |
| GET | `/api/reports/invoices.xlsx` | **D-only** | — | anon | documents | DB | IMPORTANT |

> **Latent prod bug:** the PDF/XLSX URLs are used as raw `<a href>` (`services/api.js:86-87`) without an Authorization header. demoServer's anon model lets that work; server.js's `requireAuth` would 401 a direct anchor click. This is a porting requirement, not just a route move.

## L. Returns

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/returns` | R+D | requireAuth | anon | `pages/ReturnsPage.jsx`, `pages/DashboardPage.jsx:29` | DB | IMPORTANT |
| GET | `/api/returns/:id` | **R-only** | requireAuth | — | wrapper | DB | IMPORTANT |
| POST | `/api/returns` | R+D | role:ADMIN/PLANNER | anon | wrapper | DB | IMPORTANT |
| POST | `/api/returns/:id/assign-to-run/:runId` | **R-only** | role:ADMIN/PLANNER | — | wrapper | DB | IMPORTANT |
| POST | `/api/returns/:id/pickup` | **R-only** | role:ADMIN/DRIVER | — | wrapper | DB + SAP write | CRITICAL |

> **Inverse migration risk:** `/returns/:id`, `/assign-to-run`, `/pickup` are R-only — calling them today (under demoServer) returns 404. The Returns flow's "assign to run" and "pickup" buttons are dead in production right now.

## M. Customers

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/customers/search` | R+D | role:ADMIN/PLANNER (F4) | anon | wrapper, `pages/ReturnsPage.jsx`, `components/CustomerSearchInput.jsx` | SAP read | IMPORTANT |
| GET | `/api/customers/:company/:cardCode` | **R-only** | role:ADMIN/PLANNER (F4) | — | wrapper | SAP read | IMPORTANT |
| GET | `/api/customers/:company/:cardCode/recent-items` | **R-only** | role:ADMIN/PLANNER | — | wrapper, returns dialog | SAP read | OPTIONAL |
| POST | `/api/customers/:company/:cardCode/ensure-address` | **R-only** | role:ADMIN/PLANNER | — | wrapper | DB | IMPORTANT |
| GET | `/api/customers/policies` | **D-only** | — | anon | `pages/CustomerPolicyPage.jsx:17` | DB | IMPORTANT |
| PATCH | `/api/customers/policies/:parentName` | **D-only** | — | anon | `pages/CustomerPolicyPage.jsx:19` | DB | IMPORTANT |
| POST | `/api/customers/policies/bulk` | **D-only** | — | anon | `pages/CustomerPolicyPage.jsx:21` | DB | IMPORTANT |
| GET | `/api/customers/hours/:parentName` | **D-only** | — | anon | `components/CustomerHoursDialog.jsx:28` | DB | IMPORTANT |
| PATCH | `/api/customers/hours/:parentName` | **D-only** | — | anon | `components/CustomerHoursDialog.jsx:35,45` | DB | IMPORTANT |

## N. Settings / users / zones / drivers / addresses

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/settings` | R+D | role:ADMIN | anon | `pages/SettingsPage.jsx` | DB | IMPORTANT |
| PUT | `/api/settings/:key` | R+D | role:ADMIN | anon | `pages/SettingsPage.jsx` | DB | IMPORTANT |
| GET | `/api/users` | R+D | role:ADMIN | anon | `pages/UsersPage.jsx:27` | DB | IMPORTANT |
| POST | `/api/users` | R+D | role:ADMIN | anon | `pages/UsersPage.jsx:28` | DB | IMPORTANT |
| PATCH | `/api/users/:id` | R+D | role:ADMIN | anon | `pages/UsersPage.jsx:29` | DB | IMPORTANT |
| DELETE | `/api/users/:id` | R+D | role:ADMIN | anon | `pages/UsersPage.jsx:30` | DB | OPTIONAL |
| POST | `/api/users/:id/reset-password` | R+D | role:ADMIN | anon | `pages/UsersPage.jsx:31` | DB | IMPORTANT |
| GET | `/api/users/me/subscriptions` | R+D | requireAuth | anon | `pages/UsersPage.jsx:32` | DB | OPTIONAL |
| PUT | `/api/users/me/subscriptions` | R+D | requireAuth | anon | `pages/UsersPage.jsx:33` | DB | OPTIONAL |
| GET | `/api/zones` | R+D | requireAuth | anon | `pages/ZonesPage.jsx:12`, `pages/RunsPage.jsx` | DB | CRITICAL |
| POST | `/api/zones` | R+D | role:ADMIN | anon | `pages/ZonesPage.jsx:13` | DB | IMPORTANT |
| PATCH | `/api/zones/:id` | **D-only** | — | anon | `pages/ZonesPage.jsx:14` | DB | IMPORTANT |
| DELETE | `/api/zones/:id` | **D-only** | — | anon | `pages/ZonesPage.jsx:15` | DB | OPTIONAL |
| GET | `/api/zones/cities` | **D-only** | — | anon | `pages/ZonesPage.jsx:16` | DB | IMPORTANT |
| PATCH | `/api/zones/cities/:city` | **D-only** | — | anon | `pages/ZonesPage.jsx:18` | DB | IMPORTANT |
| GET | `/api/zones/suggest` | **D-only** | — | anon | `components/AddStopDialog.jsx:17` | DB | IMPORTANT |
| POST | `/api/zones/:zoneId/assign-address/:addressId` | R+D | role:ADMIN/PLANNER | anon | wrapper | DB | IMPORTANT |
| GET | `/api/drivers` | R+D | role:ADMIN/PLANNER (F7) | anon | `pages/DriversPage.jsx:11`, `pages/WeeklyReportPage.jsx:31`, `pages/RunsPage.jsx` | DB | CRITICAL |
| POST | `/api/drivers` | R+D | role:ADMIN | anon | `pages/DriversPage.jsx:12` | DB | IMPORTANT |
| PATCH | `/api/drivers/:id` | **D-only** | — | anon | `pages/DriversPage.jsx:13` | DB | IMPORTANT |
| PATCH | `/api/drivers/:id/zones` | R+D | role:ADMIN | anon | wrapper | DB | IMPORTANT |
| DELETE | `/api/drivers/:id` | **D-only** | — | anon | `pages/DriversPage.jsx:14` | DB | OPTIONAL |
| GET | `/api/addresses/:id` | R+D | requireAuth | anon | wrapper | DB | OPTIONAL |
| PATCH | `/api/addresses/:id` | R+D | role:ADMIN/PLANNER | anon | wrapper | DB | IMPORTANT |

## O. Failures

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/failures` | R+D | requireAuth | anon | `pages/FailuresPage.jsx:31`, `pages/DashboardPage.jsx:34` (poll 30s), `pages/WallboardPage.jsx:34` (poll 10s), `pages/DailyClosurePage.jsx:31` | DB | IMPORTANT |
| GET | `/api/failures/reasons` | R+D | requireAuth | anon | `pages/FailuresPage.jsx:32`, `components/FailureReportDialog.jsx:29` | DB | IMPORTANT |
| POST | `/api/failures/report` | R+D | requireAuth | anon | `components/FailureReportDialog.jsx` | DB | IMPORTANT |
| POST | `/api/failures/:id/reschedule` | R+D | role:ADMIN/PLANNER | anon | `pages/FailuresPage.jsx:34` | DB | IMPORTANT |
| POST | `/api/failures/:id/resolve` | R+D | role:ADMIN/PLANNER | anon | `pages/FailuresPage.jsx:36` | DB | IMPORTANT |

## P. SAP diagnostics + agents

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/api/sap/diagnose` | R+D | role:ADMIN | anon | `pages/SettingsPage.jsx` | SAP read | IMPORTANT |
| GET | `/api/sap/test/sql/:company` | **R-only** | role:ADMIN | — | wrapper | SAP read | OPTIONAL |
| GET | `/api/sap/test/sl/:company` | **R-only** | role:ADMIN | — | wrapper | SAP SL ping | OPTIONAL |
| GET | `/api/sap/sample/:company` | R+D | role:ADMIN/PLANNER | anon | wrapper | SAP read | OPTIONAL |
| `/api/agents/*` (multi) | R+D (mounted in BOTH) | role:ADMIN | role:ADMIN | `pages/SettingsPage.jsx`/`AnalyticsPage.jsx` | LLM + SAP read | OPTIONAL |
| GET | `/api/audit/:entityType/:entityId` | R+D | role:ADMIN (F8) | anon (returns `[]`) | wrapper | DB | OPTIONAL |

## Q. Public + system

| Method | URL | Backend | server.js auth | demoServer auth | Frontend caller | SAP r/w | Criticality |
|---|---|---|---|---|---|---|---|
| GET | `/health` | R+D | none | none | (monitor) | DB+SAP probe | CRITICAL |
| GET | `/api/public/track/:token` | R+D | token-based | token-based | `pages/TrackingPage.jsx:49` (poll 30s) | DB | CRITICAL |
| POST | `/api/demo/reset` | **D-only** | — | anon (!) | dev tooling only | wipes store.json | LEGACY |

---

## Summary by quadrant

|  | Exists in server.js | Demo-only |
|---|---|---|
| **CRITICAL** | auth/login, auth/me, /orders/*, /runs CRUD, /runs/auto-plan, /runs/:id/wave, /picking/lines/:id/pick, /driver/* (already F2-protected), /tracking/position, /returns CRUD, /reports/runs/:id/manifest.pdf, /tracking/drivers (F3), /health | **picker-login**, **PATCH /runs/:id (assign driver)**, **/runs/:id/loading-plan**, **/runs/:id/approve-departure**, **/runs/:id/cancel-departure**, **/runs/:runId/stops**, **/picking/waves**, **/picking/:waveId/scan**, **/picking/:waveId/qc-approve**, **/picking/:waveId/qc-reject**, **/picking/lines/:lineId/shortage**, **/picking/allocations/:allocId/pick**, **/sap/write/delivery-note/:id (env-gated)**, **/sap/write/invoice/:id (env-gated)** |
| **IMPORTANT** | /returns/* mutations, /reports/exceptions, /customers/* (after F4), /settings, /users, /zones (limited), /drivers (limited), /failures/*, /davo-mix/* (R-only — dead today), /analytics/summary | /pickers CRUD, /cod, /delivery-notes, /invoices, /documents/stats, /delivery-notes/:id/generate-invoice, /documents/:type/:id/confirm-sap, /reports/{bulk-manifest,distribution-summary,loading-manifest,waves/:id/picking}.{pdf,xlsx}, /reports/{delivery-notes,invoices}.xlsx, /customers/policies, /customers/hours, /zones/cities*, /drivers/:id PATCH, /analytics/customer-profitability, /analytics/stock-prediction, /notify/eta/:stopId |
| **OPTIONAL** | /tracking/drivers/:id/trail (R-only), /agents/*, /addresses/:id, /audit/:type/:id | /runs/:id/duplicate, /runs/:id/optimize, /stops/:stopId/move-up/down/to-run, /run-orders/:runOrderId DELETE, /analytics/anomalies, /analytics/driver-performance, /analytics/suggest-drivers/:zoneCode, /m/admin/:shortId, /auth/mobile-link, /demo/reset |

## Top-line findings

- **~46 routes are demo-only.** Switching today 404s every one of them.
- **8 demo-only routes are CRITICAL** (warehouse picking flow, picker-login, departure approval, run-stop creation, run-driver assignment, two SAP-write endpoints, run loading plan).
- **5 demo-only routes are polled every 15-30s by the frontend** (`/picking/waves`, `/cod`, `/analytics/driver-performance`, `/delivery-notes`, `/invoices`, `/documents/stats`). After cutover without ports, these 404 loops will spam the backend until clients reload.
- **6 R-only routes are dead today** (`/returns/:id/pickup`, `/returns/:id/assign-to-run/:runId`, `/customers/:company/:cardCode/*`, `/davo-mix/*`, etc.) — buttons in production are silently broken right now.
- **2 demo-only routes lead to SAP writes** (`/api/sap/write/{delivery-note,invoice}/:id`). Currently fail-closed because `SAP_WRITE_ENABLED` and `SAP_SERVICE_LAYER_URL` are absent from `.env`. **The day either is enabled, both endpoints become anonymous SAP write vectors.**
