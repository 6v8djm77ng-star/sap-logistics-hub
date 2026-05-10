# KPI / Metric Architecture Review — sap-logistics-hub

Scope: every metric calculated server-side or derived in the frontend. Source files are
absolute paths under the repo. Line numbers are from the files as committed at review
time.

---

## 1. KPI inventory table

Legend for **Source**:

- LOG = Logistics SQL Server (`dbo.*` tables: `DeliveryRuns`, `DeliveryStops`, `RunOrders`, `Drivers`, `Zones`, `FailureReasons`, `StopFailures`, `NormalizedAddresses`, `ReturnRequests`, `SapRetryQueue`, `PickingWaves`, `PickingWaveLines`, `PickingAllocations`).
- SAP-SQL = SAP B1 SQL (HANA/MSSQL) via `services/sap/sqlReader.js` (`OINV`, `INV1`, `ORDR`, `RDR1`, `OITM`, `OITW`, `OCRD`).
- SAP-SL = SAP Service Layer through `sapBridge` open-orders feed (`getOpenOrdersFlat`, `getBulkOrderLines`, `getItemsStock`, `getOverallStats`).
- IN-MEM = `persistentStore` (JSON file in `backend/data/`), driver perf rollups updated on stop completion.
- DERIVED-FE = recomputed in browser from raw lists.

**Freshness**: every server-side KPI in this codebase is **query-time, no cache**. No Redis,
no materialized views, no `setInterval` warmers. Frontend pages set
`refetchInterval` (5 s wallboard, 30 s leaderboard/COD, 60 s dashboard) which means
the heavy SQL is re-issued on that cadence per connected client.

| # | KPI (he label) | File:Line | Formula (compact) | Source | Caching |
|---|---|---|---|---|---|
| 1 | TotalRuns / CompletedRuns | `backend/src/services/analytics.js:18-39` | `COUNT(DISTINCT r.RunId)` and same with `Status='COMPLETED'` filter on `DeliveryRuns r` joined to stops/orders, ranged by `r.RunDate BETWEEN @fromDate AND @toDate` | LOG | query-time |
| 2 | TotalStops / DeliveredStops / PartialStops / FailedStops | `analytics.js:22-25` | `COUNT(DISTINCT CASE WHEN s.Status = 'DELIVERED'/'PARTIAL'/'FAILED' THEN s.StopId END)` | LOG | query-time |
| 3 | TotalOrders / DeliveredOrders | `analytics.js:26-27` | `COUNT(DISTINCT ro.RunOrderId)` with `ro.Status = 'DELIVERED'` filter | LOG | query-time |
| 4 | OrdersCompanyA / OrdersCompanyB (split by CompanyId 1/2 — hard-coded) | `analytics.js:28-29` | `COUNT(DISTINCT CASE WHEN ro.CompanyId = 1 THEN ro.RunOrderId END)` | LOG | query-time |
| 5 | AvgStopMinutes | `analytics.js:30-31` | `AVG(CAST(DATEDIFF(MINUTE, s.ArrivedAt, s.CompletedAt) AS FLOAT))` | LOG | query-time |
| 6 | AvgRunMinutes | `analytics.js:32-33` | `AVG(CAST(DATEDIFF(MINUTE, r.ActualStartTime, r.ActualEndTime) AS FLOAT))` | LOG | query-time |
| 7 | successRate (יחס הצלחה) | `analytics.js:59-61, 76` | `(deliveredStops + partialStops) / totalStops`, JS divide; PARTIAL counts as success | LOG (derived JS) | query-time |
| 8 | failureRate | `analytics.js:77` | `failedStops / totalStops` | LOG | query-time |
| 9 | mergerRatio (יחס איחוד) | `analytics.js:41-57, 78-82` | `mergedStops / unifiedStops` where merged = stops that have both Company A and Company B orders, computed by CROSS APPLY with MAX-CASE on `Companies.Code` | LOG | query-time |
| 10 | Daily trend (Runs/Stops/Delivered/Failed/Orders per RunDate) | `analytics.js:89-105` | Same buckets as overall, GROUP BY `r.RunDate` | LOG | query-time |
| 11 | Per-driver: Runs / TotalStops / DeliveredStops / FailedStops / AvgStop / AvgRun | `analytics.js:111-129` | LEFT JOIN `Drivers` -> `DeliveryRuns` -> `DeliveryStops`. Drivers with `IsActive = 1`. | LOG | query-time |
| 12 | Per-zone: Runs / Stops / Delivered / Failed / Orders | `analytics.js:135-153` | LEFT JOIN `Zones` -> runs -> stops -> ro | LOG | query-time |
| 13 | Failure breakdown (per ReasonCode: Count/Rescheduled/Resolved/Cancelled/StillOpen) | `analytics.js:159-175` | LEFT JOIN with `CAST(sf.CreatedAt AS DATE) BETWEEN ...` | LOG | query-time |
| 14 | SAP sync health (PendingDeliveryNotes / SyncedDeliveryNotes / PendingReturnRequests / QueueBacklog / PermanentFailures) | `analytics.js:181-194` | 5 scalar subqueries against `RunOrders`, `ReturnRequests`, `SapRetryQueue` | LOG | query-time |
| 15 | DAVO Mix headline: mixerShare / nonMixerShare | `services/davoMix.js:80-93` | `mixerRev / totalRev` and `nonMixerRev / totalRev`, where revenue is `SUM(L.LineTotal)` from `OINV+INV1` filtered by DAVO_FILTER_SQL (line 14-18) and `H.CANCELED='N'`, `H.DocDate >= DATEADD(DAY,-@days,GETDATE())` | SAP-SQL (Company A only) | query-time |
| 16 | DAVO monthly run-rate / target gap | `davoMix.js:81-104` | `monthlyMixer = mixerRev / months`, `targetMonthlyTotal = monthlyMixer / 0.4`, `gap = targetMonthlyNonMixer - monthlyNonMixer` (assumes mixers held flat at current run-rate) | SAP-SQL (A) | query-time |
| 17 | DAVO category breakdown (categories[].revenue / qty / share) | `davoMix.js:111-144` | Same OINV+INV1 query; then JS `categorize()` heuristic on ItemCode prefix + Hebrew name regex (`davoMix.js:24-41`) | SAP-SQL (A) + JS heuristic | query-time |
| 18 | DAVO attach-rate | `davoMix.js:150-205` | `mixerWithAttach / withMixer` invoice counts, derived by grouping line rows in JS by DocEntry, with `isMixer()` heuristic | SAP-SQL (A) + JS | query-time |
| 19 | DAVO target attach rate | `davoMix.js:197` & `davoMixWeeklyReport.js:12` | hard-coded `0.22` in two places | constant | n/a |
| 20 | AOV mixer-only / mixer+attach / attachPortion / nonMixerOnly | `davoMix.js:198-204` | Plain JS averages over filtered invoice arrays | SAP-SQL (A) + JS | query-time |
| 21 | DAVO top-attach items (Top N non-mixer SKUs that ride along with mixers) | `davoMix.js:210-246` | Re-pulls all DAVO lines, identifies mixer invoices, counts non-mixer attaches per ItemCode | SAP-SQL (A) + JS | query-time |
| 22 | DAVO buyer breakdown (per CardCode) | `davoMix.js:252-315` | Per-customer mixerRev/nonMixerRev/attachRate over the days window | SAP-SQL (A) + JS | query-time |
| 23 | DAVO top buyers | `davoMix.js:320-338` | `SELECT TOP n CardCode, SUM(L.LineTotal)` filtered by DAVO_FILTER_SQL | SAP-SQL (A) | query-time |
| 24 | DAVO weekly delta (this 7d vs prior 7d) | `services/davoMixWeeklyReport.js:45-72` | Calls `getMixSummary({days:7})` and `getMixSummary({days:14})`, subtracts to get prior week — i.e. **prior week is computed by subtraction, not directly queried** | SAP-SQL (A) | query-time per email |
| 25 | DAVO Phase-1 gap-to-target (16% milestone) | `davoMixWeeklyReport.js:13, 92-93` | `PHASE_1_NON_MIXER_TARGET (0.16) - thisWeek.nonMixerShare` | constant | n/a |
| 26 | Daily sales: OrderCount / Revenue / AvgOrderValue per company per day | `services/sap/financialReader.js:47-61` | `COUNT(*), SUM(H.DocTotal), AVG(H.DocTotal)` from OINV grouped by date; **runs against both companies in parallel** via `queryAll()` (line 20-35) | SAP-SQL (A+B) | query-time, fan-out |
| 27 | Top items by revenue | `financialReader.js:67-84` | `SUM(L.LineTotal)` from OINV+INV1, TOP N | SAP-SQL (A+B) | query-time |
| 28 | Low stock items (below MinLevel) | `financialReader.js:94-114` | `SUM(W.OnHand - W.IsCommited) < I.MinLevel * @mult` per item across all warehouses | SAP-SQL (A+B) | query-time |
| 29 | Dead stock | `financialReader.js:120-153` | OITM with positive OnHand and `DATEDIFF(DAY, MAX(H.DocDate from OINV), GETDATE()) >= @days` — uses correlated subquery per item, twice (in SELECT and HAVING) | SAP-SQL (A+B) | query-time |
| 30 | Margin by item: Revenue / Cost / GrossMargin / MarginPct | `financialReader.js:169-191` | `Cost = Quantity * OITM.AvgPrice`. `MarginPct = (Revenue - Cost) * 100.0 / Revenue` | SAP-SQL (A+B) | query-time |
| 31 | Top customers by Revenue | `financialReader.js:201-217` | `SUM(H.DocTotal)` grouped by CardCode | SAP-SQL (A+B) | query-time |
| 32 | Churn-risk customers (DaysSilent, PriorOrders, PriorRevenue) | `financialReader.js:225-250` | Bought ≥3× in last `lookbackDays` window AND no order in last `silentDays` (NOT EXISTS subquery) | SAP-SQL (A+B) | query-time |
| 33 | Stock-prediction shortage / ratio / level | `backend/src/demo/demoServer.js:571-661` | JS-side: `demand = sum of OpenQty across open ORDR lines` (via `getOpenOrdersFlat` + `getBulkOrderLines`), `stock = SUM(Available) per item across warehouses`, `ratio = demand/stock`, level=`shortage|critical|warn|ok` thresholds 0.8 / 0.5 | SAP-SL + SAP-SQL items stock | query-time, multi-roundtrip |
| 34 | Anomalies (high_value / spike / low_value / many_lines / no_address) | `demoServer.js:667-785` | p95 of all open-order DocTotals; per-customer baseline avg; spike if `total > avg*3`; low_value if `<200₪`; many_lines if `LinesCount > 30`; severities high/medium/low | SAP-SL (open orders) | query-time |
| 35 | Customer profitability: revenue / cost / margin / marginPct / rank A-F | `demoServer.js:794-864` | revenue = `SUM(DocTotal)` of OPEN orders grouped by parent name; cost = `orderCount * 48₪` (hard-coded `COST_PER_STOP=48`); `marginPct = margin/revenue`; rank thresholds 0.6/0.4/0.2/0/<0 | SAP-SL only | query-time |
| 36 | Driver leaderboard `Score` and `SuccessRate` | `frontend/src/pages/DriverLeaderboardPage.jsx:170-177` and `backend/src/demo/persistentStore.js:851-878` | Frontend recomputes: `succ = Delivered/TotalStops`, `speed = clamp((30-AvgMinutesPerStop)/20, 0, 1)`, `exp = min(1, TotalStops/100)`, `score = (succ*0.5 + speed*0.3 + exp*0.2) * 100`. Backend has the **same formula** for `suggestDriversForZone` | IN-MEM (persistentStore.driverStats) + DERIVED-FE | query-time |
| 37 | Wallboard tile: totalRuns / inTransit / completed / totalStops / totalOrders / openFailures | `frontend/src/pages/WallboardPage.jsx:38-44` | Counts on the runs array fetched from `runsApi.list()`; `openFailures` counts failures with `Status==='OPEN'` | LOG (raw runs feed) | DERIVED-FE, 5–30 s polling |
| 38 | SAP company widgets (Customers/Items/OpenOrders) | `demoServer.js:1725-1743` and `sapBridge.js:333-350` | `SELECT COUNT(*) FROM OCRD WHERE CardType='C' AND validFor='Y'`; `COUNT(*) FROM OITM`; `COUNT(*) FROM ORDR WHERE DocStatus='O' AND CANCELED='N'` per company | SAP-SQL (A+B) | query-time |
| 39 | Orders/stats fudge KPIs: totalStops/stopsSaved/mergeRatio/mergedStops | `demoServer.js:1730-1735` | `totalStops = ceil(totalOpen*0.8)`, `stopsSaved = floor(totalOpen*0.2)`, `mergeRatio = 0.2`, `mergedStops = floor(totalOpen*0.15)` — **ALL HARD-CODED ESTIMATES, marked "// estimate"** | fabricated | n/a |
| 40 | Daily Closure: completionPct / 4-stage funnel | `frontend/src/pages/DailyClosurePage.jsx:38-58` | `completionPct = round(runsByStatus.completed / runsList.length * 100)`; pickComplete/inProgress/pending counts | DERIVED-FE | per page mount |
| 41 | Weekly Report aggregates (totalRuns/totalStops/totalOrders/completedRuns; per-day, per-driver, per-zone) | `frontend/src/pages/WeeklyReportPage.jsx:35-77` | 7 separate `runsApi.list({runDate})` queries (one per day) flattened, summed in JS | LOG (raw runs feed) | DERIVED-FE |
| 42 | COD totals: grandTotal / grandPending, per-driver pending | `frontend/src/pages/CashOnDeliveryPage.jsx:30-52` | `sum(Amount where Status !== 'DEPOSITED')` over records | IN-MEM | DERIVED-FE, 30 s poll |
| 43 | Customer Profitability page totals (totalRevenue / totalCost / totalMargin) | `frontend/src/pages/CustomerProfitabilityPage.jsx:73-80` | Pre-computed by backend in `demoServer.js:857-859` then re-displayed | SAP-SL | query-time |
| 44 | Stock-prediction summary card counts (shortage/critical/warn/ok) | `demoServer.js:650-656` | `items.filter(i => i.level === 'shortage').length` etc. | SAP-SL+SQL | query-time |
| 45 | Anomalies summary counts | `demoServer.js:774-779` | `anomalies.filter(a => a.maxSeverity === 'high').length` etc. | SAP-SL | query-time |
| 46 | Exceptions report counts (addressesWithoutZone / failedStops / unassignedReturns / failedDeliveryNotes) | `services/reports/exceptions.js:14-92` | 4 parallel SQL queries on logistics DB — addresses without `ZoneId`, stops with `Status='FAILED'`, open returns due ≤ tomorrow, RunOrders DELIVERED with NULL `SapDeliveryDocEntry` | LOG | query-time |

---

## 2. Duplicated KPI logic (the same metric, multiple definitions, won't tie out)

### 2.1 "Revenue" is at least three different things across the codebase

- `analytics.js` does not compute revenue at all (logistics-side has no money).
- `financialReader.getDailySales` (`financialReader.js:53`) — `SUM(H.DocTotal)`. `DocTotal` in SAP B1 Israeli localization is **gross, tax-inclusive** (includes VAT).
- `financialReader.getTopCustomers` (`financialReader.js:208`) — also `SUM(H.DocTotal)` (gross/VAT-inclusive).
- `davoMix.getMixSummary` (`davoMix.js:55`) — `SUM(L.LineTotal)`. `LineTotal` in SAP B1 is **net of VAT, before discount header**. So a "DAVO revenue" number reported by the weekly report uses a different basis than "Daily revenue" reported by the CEO Brief.
- `financialReader.getTopItems` (`financialReader.js:74`) — `SUM(L.LineTotal)`, net.
- `financialReader.getMarginByItem` (`financialReader.js:177`) — `SUM(L.LineTotal)`, net (correct for margin math).
- `demoServer customer-profitability` (`demoServer.js:819`) — `SUM(o.DocTotal)` from `getOpenOrdersFlat` (open ORDR, **not** invoiced OINV). So "Revenue" on the Customer Profitability page is **open-order pipeline**, not booked revenue. The page label says "סה״כ הכנסה" but the underlying number is open order book.
- `demoServer anomalies` (`demoServer.js:682, 696`) — `DocTotal` on open ORDR, again open-pipeline.
- Wallboard "totalOrders" comes from `r.OrderCount` on logistics runs (count, not money).

Risk: if two execs ask "what was DAVO revenue last 30 days?" — the weekly report (LineTotal, net) and any future MTD calc using DocTotal (gross) will differ by ~17% (Israeli VAT 17–18%) plus discount handling.

### 2.2 "Attach rate" — single source today, but split semantics

- `davoMix.getAttachRate` (`davoMix.js:150-205`) defines attach as: `mixerWithAttach / withMixer` where mixer-vs-attach is decided by `isMixer()` heuristic on ItemCode prefix `^(DSM|DHM)` or Hebrew `מיקסר` in name (`davoMix.js:11-12, 20-22`).
- Per-buyer attach rate (`davoMix.js:311`) uses the **same** `isMixer()` but recounts per-customer.
- Top-attach items list (`davoMix.js:210-246`) again iterates the same lines but adds an extra Set to identify "mixer invoices" (re-derives the same partition).
- The weekly report (`davoMixWeeklyReport.js:45-72`) computes a "prior week" attach rate by **subtracting 7-day from 14-day windows**. This is mathematically wrong if any invoice from the prior week was canceled inside the window: `mixerWithAttach` is a count, and `count(14d) - count(7d) ≠ count(prior 7d)` if cancellations toggled in between.

Each of these would round to the same number today (because they all hit the same OINV+INV1 + same regex), but they are **three separate pieces of code with three slightly different ways of partitioning lines into mixer/non-mixer**. The next time someone tweaks `isMixer()` or `DAVO_FILTER_SQL` they will only update one site.

### 2.3 Driver score formula in two places

- `frontend/src/pages/DriverLeaderboardPage.jsx:170-177` recomputes `Score` from `succ * 0.5 + speed * 0.3 + exp * 0.2`.
- `backend/src/demo/persistentStore.js:863-873` has the **identical formula** with the same magic numbers (`30`, `20`, `100`, `0.5`, `0.3`, `0.2`) used by `suggestDriversForZone`.

If the formula is ever rebalanced, the two will drift. Worse: the persistentStore version uses backslash escapes (`r.Delivered \ r.TotalStops` line 865, `\ Lower minutes...` line 866) — these look like file-corruption (Windows path-style backslash where `/` was intended). That function is therefore likely throwing at runtime and `suggestDriversForZone` may be dead code. **Verify `persistentStore.js:865-866`.**

### 2.4 Driver success rate computed three ways

- `services/analytics.js:117` → `DeliveredStops` = stops with status `DELIVERED` OR `PARTIAL`. Success rate = `(delivered + partial) / total`. (PARTIAL counts as success.)
- `demo/demoServer.js:1025` → `SuccessRate = s.Delivered / s.TotalStops` where `s.Delivered` is whatever `persistentStore.driverStats` keeps. Doesn't necessarily include PARTIAL.
- `DriverLeaderboardPage.jsx:171` → same as demoServer (`Delivered / TotalStops`), recomputed in browser.

A driver who has 8 deliveries + 2 partials would show 100% success in the analytics dashboard and 80% on the leaderboard.

### 2.5 "Open orders" — three different definitions

- `getOverallStats` (`sapBridge.js:340-343`) — `COUNT(*) FROM ORDR WHERE DocStatus='O' AND CANCELED='N'`. Raw open sales orders.
- `getOpenOrdersFlat` (used by stock-prediction, anomalies, customer profitability) — appears to add additional joins/filters; the count from there can differ.
- Frontend `DashboardPage.jsx:42` sums `companyA.OpenOrders + companyB.OpenOrders` and labels it `totalOpenOrders`.
- `demoServer.js:1730` exposes `totalOrders` = same sum, but on the same line `totalStops = Math.ceil(totalOpen * 0.8)` is **fabricated** as 80% of orders, and `stopsSaved`, `mergeRatio`, `mergedStops` are all hard-coded estimates with a `// estimate` comment. Anything reading `/api/orders/stats` for "stops saved" or "merge ratio" is reading a fairy tale, not data.

### 2.6 Failed-stops counted twice with different time semantics

- `analytics.getOverallKpis` filters by `r.RunDate BETWEEN @from AND @to` (run-day-based).
- `analytics.getFailureBreakdown` filters by `CAST(sf.CreatedAt AS DATE) BETWEEN @from AND @to` (failure-record-creation-date-based, server local time depending on collation).
- `exceptions.getExceptionsReport` (`exceptions.js:42`) filters failed stops by `r.RunDate >= @date` (just a one-sided "today and later" window on the run, not the failure record).

If a stop fails late at night on day N but the failure row is written shortly after midnight (server tz), the failure breakdown counts it on N+1 while the overall KPIs count the failed stop on N. The numbers will not reconcile.

### 2.7 Customer "revenue" buckets — invoiced vs. open-order

- "Top customers" page (`financialReader.getTopCustomers`) → invoiced revenue (OINV).
- "Customer Profitability" page → open-order DocTotal (`demoServer.js:819`).

Two pages, same word "הכנסה", two different numbers, same customer.

### 2.8 Daily completion % vs. delivery success rate

- `DailyClosurePage.jsx:56-58` — `completionPct = round(runsByStatus.completed / runsList.length * 100)`. **Run-based.**
- `analytics.getOverallKpis successRate` — **Stop-based**, `(delivered+partial)/totalStops`.

A day with 10 runs of which 9 are COMPLETED but those 9 runs collectively had 8 failed stops would be `90% completion` on the closure page and a much-lower `successRate` on Analytics.

---

## 3. Query-time KPI risks (will not scale)

Every KPI in this code is recomputed from raw fact tables on each request. There is no
caching layer (`grep cache|redis|memoize` against `services/analytics.js` and `services/davoMix.js`
returns nothing). The riskiest:

1. **`davoMix.getMixSummary` and friends** (`davoMix.js`). Every call scans `OINV INNER JOIN INV1` over up to 365 days, filtered by `DAVO_FILTER_SQL` which is 7 OR'd `LIKE` patterns plus `Dscription LIKE N'%DAVO%'` — none of these are sargable, so this is a full scan of `INV1` for every page load of the DAVO Mix dashboard. `getMixSummary`, `getCategoryBreakdown`, `getAttachRate`, `getTopAttachItems`, `getBuyerBreakdown`, `getTopDavoBuyers` each run their own copy of essentially the same scan.
   - Worst case: the DAVO Mix page (`DavoMixPage.jsx`) loads several of these in parallel on every visit.
   - Weekly report (`davoMixWeeklyReport.js:45-55`) calls **seven** of them in parallel every Sunday.
2. **`financialReader.getDeadStock`** (`financialReader.js:120-153`). Has a correlated subquery `(SELECT MAX(H.DocDate) FROM OINV ... WHERE L.ItemCode = I.ItemCode)` evaluated **twice** (once in SELECT, once in HAVING) for every item in OITM. On a catalog of 5–10k items × OINV with multi-year history this is the slowest query in the system. Also runs twice (Company A + Company B) via `queryAll`.
3. **`financialReader.getDailySales` / `getTopItems` / `getTopCustomers` / `getMarginByItem` / `getChurnRiskCustomers`** all use `queryAll` (`financialReader.js:20-35`) which fans out to both companies in parallel. The CEO Brief agent (`agents/ceoBrief.js`) is encouraged by its system prompt to compare today vs yesterday vs last 7d vs prior 7d vs MTD vs prior MTD — that is up to 6 ranges × 5 tools × 2 companies = 60 raw SQL hits per brief.
4. **`/api/analytics/stock-prediction`** (`demoServer.js:571-661`). Per request: 1 open-orders fetch + N item-line fetches (chunked 200 at a time) + 2× `getItemsStock` (companies A and B) — roundtrips O(uniqueItems/200). On a busy planning day with 500 open orders this is dozens of round-trips on a single GET. The page sets `staleTime: 5*60_000` but no server cache, so each tab refetches.
5. **`/api/analytics/anomalies`** (`demoServer.js:667-785`) re-fetches all open orders, computes p95 in JS, builds per-customer baselines in JS — fine for 500 orders, will collapse at 5 000.
6. **`analytics.getDashboardSummary`** (`analytics.js:200-210`) runs 6 KPI queries in parallel for every analytics-page hit. Routed via `/api/analytics/summary` (`routes/analytics.js:16-23`) with no caching. The Wallboard's 5-second poll plus any open analytics tabs will each trigger this fan-out.
7. **`getOverallStats`** (`sapBridge.js:333-350`) hits SAP B1 with three `COUNT(*)` queries on every call — `OCRD`, `OITM`, `ORDR`. `OITM` is typically a few thousand rows and a full count is cheap; `OCRD` and `ORDR` are larger. The Dashboard polls this every 60 s (`DashboardPage.jsx:18`), Wallboard every 30 s, and Analytics on each visit. Each open browser is its own polling client.

None of these has rate-limiting, none has a server-side dedupe / coalescing layer, none warms.

---

## 4. Missing KPI governance

- **No central definitions file.** "Revenue" is redefined in 8 places (see §2.1). Nothing
  in the repo says which metric is canonical. There is no `metrics/` directory, no SQL
  view layer in either DB, no dbt-style semantic model.
- **No versioning.** A change to `isMixer()` or `DAVO_FILTER_SQL` (`davoMix.js:14-22`) silently changes every DAVO KPI retroactively, including the historical numbers in already-sent weekly emails. No metric version tag.
- **No owner per metric.** `analytics.js`, `davoMix.js`, `financialReader.js`, `demoServer.js` (the 1700-line god file) all carry KPI logic; ownership is implicit-by-author.
- **No validation against SAP source-of-truth.** Nothing reconciles `davoMix.getMixSummary.revenue.total` against an SAP standard sales report. No "expected vs actual" alerts. The CEO Brief agent's prompt (`ceoBrief.js:24, 34`) says "Every number you report MUST come from a tool result" — that is a runtime constraint on the LLM, not a governance check on the metrics themselves.
- **No semantic / metrics layer.** No Cube, dbt, LookML, MetricFlow, etc. KPIs live inline in JS service files mixed with HTTP plumbing.
- **No metric-level access control.** Most analytics routes only require `requireAuth` (e.g. `routes/davoMix.js:12`); only `/api/analytics/summary` adds `requireRole('ADMIN','PLANNER')`. Anyone who can log in can pull the DAVO buyer-by-CardCode breakdown, including pricing.
- **No data-lineage.** `customer-profitability` advertises "revenue – delivery cost" but `cost = orderCount × 48₪` with `48` hard-coded inline at `demoServer.js:830`. Nobody looking at the page knows that.
- **Hard-coded targets duplicated.** `0.22` attach target (`davoMix.js:197`, `davoMixWeeklyReport.js:12`), `0.6` non-mixer share (`davoMixWeeklyReport.js:11`), `0.16` Phase-1 (`davoMixWeeklyReport.js:13`). No config table, no audit trail when they change.

---

## 5. Time-window inconsistency

"Today" / "now" / "this period" mean different things across KPIs:

- `analytics.js` ranges: `r.RunDate BETWEEN @fromDate AND @toDate`. `RunDate` is a `DATE` type (no time component). Routes `routes/analytics.js:11-13` default `toDate = format(new Date(), 'yyyy-MM-dd')` and `fromDate = today - 29 days` (server local time of node process, no timezone awareness).
- `analytics.getFailureBreakdown` filters `CAST(sf.CreatedAt AS DATE)` — uses the **SQL Server's** local time interpretation of a datetime, not the same clock as `RunDate` (which is set by JS server). Cross-timezone deployments diverge.
- `davoMix.*` uses `H.DocDate >= DATEADD(DAY, -@days, GETDATE())` — `GETDATE()` is **the SAP SQL server's clock**. So "last 7 days" in DAVO is "from 7 days ago in SAP-server-time until SAP server now" (datetime, not date — meaning early-morning runs may include partial yesterday vs. include all of 7 days ago).
- `financialReader.*` uses `H.DocDate BETWEEN @fromDate AND @toDate` — caller-supplied. The CEO Brief agent constructs ranges from `format(anchor, 'yyyy-MM-dd')` in the **node process timezone** (`ceoBrief.js:204-220`).
- `getChurnRiskCustomers` uses `DATEADD(DAY, -@silent, GETDATE())` and `DATEADD(DAY, -@lookback, GETDATE())` — **SAP server clock again, datetime not date**. So 30-day silence is actually "30 × 24h ago", not "30 calendar days ago".
- `getDailyTrend` (`analytics.js:89-105`) groups by `r.RunDate` but does not handle missing days — gaps just disappear. Frontend bar charts show variable bar widths.
- Wallboard's `today = now.toISOString().slice(0,10)` (`WallboardPage.jsx:20`) — that's **UTC**, not Asia/Jerusalem. From 22:00 to 24:00 Israel time, the wallboard is showing tomorrow's wallboard (UTC has flipped, IL hasn't).
- Dashboard's `today = format(new Date(), 'yyyy-MM-dd')` (`DashboardPage.jsx:13`) — **browser local time**, which contradicts the wallboard.
- WeeklyReportPage builds its 7-day list from `endDate` to `endDate-6` in browser local (`WeeklyReportPage.jsx:18-19`). DAVO weekly report builds "7 days" from SAP server `GETDATE() - 7`. These two reports for "this week" can differ by a calendar day at any UTC-vs-IL boundary.

There is no shared "business day" / "today in IL" helper.

---

## 6. Currency, rounding, tax

- **Unit ambiguity.** No code in this codebase uses agorot. All money is treated as decimal NIS — `H.DocTotal`, `L.LineTotal`, etc. are returned as floats by the mssql driver. There is no central money type.
- **Tax inclusion is inconsistent and undocumented.**
  - `OINV.DocTotal` in SAP B1 Israeli localization is **gross, VAT-inclusive** — used by `getDailySales`, `getTopCustomers`, anomalies, customer-profitability.
  - `INV1.LineTotal` is **net, before VAT** — used by `getTopItems`, `getMarginByItem`, all of `davoMix.*`, `getTopDavoBuyers`.
  - The DAVO weekly report tells the executive "סה"כ DAVO ₪X" (`davoMixWeeklyReport.js:177`); X is a net figure, but the user reading the email sees a gross-looking shekel amount. If they cross-check against a SAP P&L (gross) it won't tie.
- **Margin math uses `OITM.AvgPrice`** as cost (`financialReader.js:177-180`). AvgPrice is moving-average cost in SAP B1; it's null for items where cost has never been set, which the SQL handles with `ISNULL(I.AvgPrice, 0)` — which **silently gives 100% margin** on items with no cost maintained. The CEO Brief agent prompt notes this risk (`ceoBrief.js:24` "Distinguish data-quality issues (cost = 0 in OITM, ...)" but the SQL itself does not flag the rows.
- **Rounding.**
  - `davoMix` and `financialReader` return raw floats (no rounding server-side).
  - `customer-profitability` rounds with `Math.round` per record (`demoServer.js:838-842`) so `marginPct` is already integer-percent before going to the wire.
  - `davoMixWeeklyReport.fmtNis` (`davoMixWeeklyReport.js:15-20`) rounds to compact `M`/`k` in display only.
  - Analytics rounds `avgStopMinutes` and `avgRunMinutes` (`analytics.js:74-75`) but leaves rates as floats.
  - `Math.round(marginPct * 100) / 100` (`demoServer.js:841`) rounds to 2 decimals — fine until summed; the page-level `totalMargin = sum(round(margin))` (`demoServer.js:859`) loses pennies on every row.
- **Currency formatting.**
  - Frontend has at least 3 formatters: `toLocaleString('he-IL', {style:'currency',currency:'ILS'})` in `CustomerProfitabilityPage.jsx:43`, `Math.round(total).toLocaleString('he-IL') + '₪'` in anomaly messages (`demoServer.js:705,716,726`), and `fmtNis` with `M`/`k` compact (`davoMixWeeklyReport.js:15-20`). They round to different precisions.
- **Cross-company aggregation ignores currency.** `queryAll` (`financialReader.js:20-35`) flattens results from Company A and Company B into one array. Code assumes both are in NIS (the file comment at line 11 says so). If Company B is ever set up with a different OADM `MainCurncy`, these numbers will silently be summed across currencies.
- **No FX, no consolidation rules, no rounding policy.** Nothing documents a "round half-up to nearest agora" or "carry full precision until display" rule.

---

## Quick wins (not requested but obvious from the review)

1. Pick one revenue definition (OINV.DocTotal vs LineTotal, gross vs net) and write it into a single `services/metrics/revenue.js` that all callers use. The DAVO report currently disagrees with the CEO brief by VAT.
2. Fix `persistentStore.js:865-866` — those literal `\` characters are likely a copy-paste from a Markdown render and `suggestDriversForZone` is broken.
3. Stop fabricating `totalStops`/`stopsSaved`/`mergeRatio` in `demoServer.js:1730-1735`. Either compute them or remove the keys; frontend currently displays whatever lands there.
4. Cache the DAVO scan (single underlying query feeds 6 KPIs). One `WITH davoLines AS (...)` CTE materialized per request would fold 6 scans into 1.
5. Move metric targets (`0.22`, `0.6`, `0.16`, `48`, `30/20/100` driver-score weights) to a `config/metrics.json` with a version field and a changelog.
