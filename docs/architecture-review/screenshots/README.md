# Screenshots — capture instructions

Backend is running at `http://localhost:4000` (verified `/health` returned 200 during this review).

Automated capture during this review failed: the Chrome window connected to the MCP extension does not permit tab grouping ("Grouping is not supported by tabs in this window"), which the browser-automation MCP requires to operate. To preserve the review's read-only constraint, no Chrome instance was launched and no PM2 / dev-server restart was attempted.

Capture these URLs manually (login required for all except `/wallboard` and `/t/<token>`):

| File to save | URL | Page (frontend/src/pages) | Role required |
|---|---|---|---|
| `executive-dashboard.png` | `http://localhost:4000/` | `DashboardPage.jsx` | any auth |
| `wallboard.png` | `http://localhost:4000/wallboard` | `WallboardPage.jsx` | **public** |
| `sales-analytics.png` | `http://localhost:4000/analytics` | `AnalyticsPage.jsx` | any auth |
| `sales-weekly-report.png` | `http://localhost:4000/weekly` | `WeeklyReportPage.jsx` | any auth |
| `sales-davo-mix.png` | `http://localhost:4000/davo-mix` | `DavoMixPage.jsx` | any auth |
| `inventory-stock-prediction.png` | `http://localhost:4000/stock-prediction` | `StockPredictionPage.jsx` | any auth |
| `finance-customer-profitability.png` | `http://localhost:4000/profitability` | `CustomerProfitabilityPage.jsx` | any auth |
| `finance-cash-on-delivery.png` | `http://localhost:4000/cod` | `CashOnDeliveryPage.jsx` | any auth |
| `finance-daily-closure.png` | `http://localhost:4000/closure` | `DailyClosurePage.jsx` | any auth |
| `alerts-anomalies.png` | `http://localhost:4000/anomalies` | `AnomaliesPage.jsx` | any auth |
| `alerts-exceptions.png` | `http://localhost:4000/exceptions` | `ExceptionsPage.jsx` | any auth |
| `alerts-failures.png` | `http://localhost:4000/failures` | `FailuresPage.jsx` | any auth |

> **Security context** for these pages: as documented in `../security-analysis.md`, the routes that back these dashboards (`/api/analytics`, `/api/davo-mix`, `/api/reports`, `/api/customers`, `/api/audit`) currently require only `requireAuth` — no `requireRole` gate. Any DRIVER token can fetch the same data. This is a P0 finding regardless of what the screenshots show.

## Capture procedure (suggested)

1. Open Chrome (any window — does not need to be the MCP-attached one).
2. Navigate to `http://localhost:4000/login`. Log in with an ADMIN account.
3. For each URL above, navigate, wait for data to load, take a full-page screenshot, save to this folder using the filename in the table.
4. For `/wallboard` and `/t/<token>` no login is needed.

A tool like the Chrome built-in "Capture full size screenshot" (DevTools → Cmd/Ctrl+Shift+P → "Capture full size screenshot") works well for these dashboards because they often exceed viewport height.
