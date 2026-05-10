# `backend/data/store.json` - Migration Analysis

> Read-only forensic analysis of the live production state held by the demo server, prepared as input to the planned MS SQL Server migration (move from `backend/src/demo/demoServer.js` → `backend/src/server.js`).

- **File:** `backend/data/store.json`
- **Size on disk:** 1,642,288 bytes (1.57 MB) / 58,726 lines
- **JSON payload:** ~1,090,846 bytes (raw `JSON.stringify`, no pretty-print)
- **Last write:** 2026-05-05 09:59
- **Schema definition:** `backend/src/demo/persistentStore.js` (2,038 lines)
- **Producer:** `backend/src/demo/demoServer.js` (single in-memory cache, full file rewrite on every mutation via `fs.writeFileSync` at `persistentStore.js:65-74`)
- **Consumer:** every demoServer route reads through `store.*` helpers; no direct file reads from elsewhere

The store is a single root JSON object with **20 top-level keys** (15 arrays + 5 scalar `next*Id` counters and 2 dictionary maps). All `next*Id` counters are monotonic and rewritten on every mutation, so they can be discarded after migration (SQL `IDENTITY` columns supersede them).

---

## A. Top-level inventory

| Key | Records | Earliest | Latest | Approx size | SQL table | Notes |
|---|---|---|---|---|---|---|
| `drivers` | 3 | n/a | n/a | ~50 lines | `dbo.Drivers` | Adds `VehicleType`, `VehicleCapacityL`, `VehicleCapacityKg`, `LoadingMode`, `Zones` (CSV) over migration 001. |
| `nextDriverId` | scalar=4 | – | – | 1 line | – | Discard. |
| `users` | 2 | CreatedAt 2026-04-23 | LastLoginAt 2026-04-29 | ~40 lines | `dbo.Users` | Stored bcrypt hashes; admin + 1 PLANNER. Adds `Phone`, `PreferredLanguage` over migration 001. |
| `nextUserId` | scalar=3 | – | – | 1 line | – | Discard. |
| `zones` | 9 | n/a | n/a | ~110 lines | `dbo.Zones` | 7 default zones + 2 added live (incl. `NORTHWEST` ZoneId=9, `SortOrder=15`). |
| `nextZoneId` | scalar=10 | – | – | 1 line | – | Discard. |
| `runs` | 54 | CreatedAt 2026-04-24T03:49:44 | CreatedAt 2026-05-05T06:58:52 | ~1,100 lines | `dbo.DeliveryRuns` | Status mix: 37 OPEN, 16 PICKING, 1 LOADED. RunDate range 2026-04-24 → 2026-05-05. Denormalised fields (`ZoneCode/Name/Color`, `DriverName/Phone/Plate`, `StopCount/OrderCount`) need to be dropped or recomputed at read time. |
| `nextRunId` | scalar=56 | – | – | 1 line | – | Discard. |
| `stops` | 816 | n/a (no CreatedAt) | n/a | ~25,500 lines | `dbo.DeliveryStops` | All 816 are `Status='PENDING'` - **no completed deliveries yet.** Embeds full address (Street/BuildingNumber/City/BranchName) instead of normalised `AddressId` (the SQL FK target). |
| `nextStopId` | scalar=818 | – | – | 1 line | – | Discard. |
| `runOrders` | 1,307 | n/a | n/a | ~22,500 lines | `dbo.RunOrders` | All 1,307 are `Status='PENDING'`. Carries denormalised `CompanyName`, `SapCardName`. |
| `nextRunOrderId` | scalar=1310 | – | – | 1 line | – | Discard. |
| `waves` | 21 | CreatedAt 2026-04-24T04:10:52 | CreatedAt 2026-05-05T06:59:17 | ~290 lines | `dbo.PickingWaves` | StartedAt range 2026-04-25 → 2026-04-29 (only 6 actually started). |
| `nextWaveId` | scalar=22 | – | – | 1 line | – | Discard. |
| `waveLines` | 505 | n/a | n/a | ~6,800 lines | `dbo.PickingWaveLines` | Adds `Barcode`, `UomCode`, `AllocationCount`, `Notes` over migration 001. |
| `nextWaveLineId` | scalar=506 | – | – | 1 line | – | Discard. |
| `waveAllocations` | 826 | n/a | n/a | ~10,500 lines | `dbo.PickingAllocations` | **Schema mismatch:** stores `SapDocEntry` + `SapOrderLineNum` directly; SQL expects `RunOrderId` FK. Newer rows also carry `City`, `BranchName`, `SapCardName` (denormalised). |
| `waveAllocations[*].PickedQuantity` | (in-row) | – | – | – | – | Field added at runtime by `pickAllocation()` (`persistentStore.js:1625`). |
| `deliveryNotes` | 12 | CreatedAt 2026-04-29T09:02:39.547Z | CreatedAt 2026-04-29T09:02:39.648Z | ~520 lines | **NEW - no SQL equivalent** | All 12 created in a single second on 2026-04-29 (one wave QC approval). Status all `PENDING_EXPORT`. Embeds `SourceOrders[]` array + nested `Address` object. |
| `nextDeliveryNoteId` | scalar=13 | – | – | 1 line | – | Discard. |
| `invoices` | 1 | CreatedAt 2026-04-29T09:02:39.577Z | same | ~30 lines | **NEW - no SQL equivalent** | Single invoice, `Status='PENDING_EXPORT'`. Has VAT @ 17%. |
| `nextInvoiceId` | scalar=2 | – | – | 1 line | – | Discard. |
| `cityZoneOverrides` | 26 entries (object) | – | – | ~30 lines | **NEW - no SQL equivalent** | Plain `{city: zoneCode}` map. Most entries (24/26) re-route Haifa & coastal cities to the new `NORTHWEST` zone added via UI. |
| `customerDocPolicies` | 15 entries (object) | – | – | ~20 lines | **NEW - no SQL equivalent** | `{parentName: 'DELIVERY_NOTE'\|'INVOICE'}`. 14 DELIVERY_NOTE, 1 INVOICE. |
| `pickers` | 1 | CreatedAt 2026-04-29T13:25:23 | same | ~10 lines | **NEW - no SQL equivalent** | Warehouse handheld user. Test record only (`FullName='vrtk'`). |
| `nextPickerId` | scalar=2 | – | – | 1 line | – | Discard. |
| `lineDeliveries` | 0 | – | – | 1 line | **NEW - no SQL equivalent** | Schema defined (`recordLineDeliveries`, `persistentStore.js:670`) but never written. |
| `nextLineDeliveryId` | scalar=1 | – | – | 1 line | – | Discard. |

Implicit (not present in current store but defined in code):
- `customerHours` (object map of business hours per parent customer) - written by `setCustomerHours` (`persistentStore.js:907`); **0 records currently.**
- `codCollections[]` + `nextCodId` - written by `recordCodCollection` (`persistentStore.js:750`); **0 records currently.**
- `driverStats` (object keyed by `driverId|zoneCode`) - written by `recordDriverPerformance` (`persistentStore.js:817`); **0 records currently.**

Together this shows: **the system has been used for planning and picking, but never for actual completed deliveries.** No driver has marked a stop delivered, no COD has been collected, no SAP delivery doc has been confirmed. Every "downstream" field (`ActualStartTime`, `CompletedAt`, `SapDeliveryDocEntry`, `ConfirmedAt`) is `null` across the dataset.

---

## B. Per-entity deep dive

Numbers in `()` are SQL column names from `database/migrations/001_initial_schema.sql` unless noted.

### B.1 `drivers` (3 records) - migration **S**

| Field | JS type | SQL column |
|---|---|---|
| `DriverId` | int | `Drivers.DriverId` (IDENTITY) |
| `Code` | string | `Drivers.Code` |
| `FullName` | string | `Drivers.FullName` |
| `Phone` | string | `Drivers.Phone` |
| `Email` | string | `Drivers.Email` |
| `VehiclePlate` | string | `Drivers.VehiclePlate` |
| `VehicleCapacity` | int | `Drivers.VehicleCapacity` (legacy) |
| `IsActive` | bool | `Drivers.IsActive` |
| `Zones` | string (CSV) | **no equivalent** - SQL uses `dbo.DriverZones` join table |
| `VehicleType` *(new field, not always present)* | string `TRUCK\|COMMERCIAL` | **no SQL column** |
| `VehicleCapacityL` *(new)* | number | **no SQL column** |
| `VehicleCapacityKg` *(new)* | number | **no SQL column** |
| `LoadingMode` *(new)* | string `BY_ITEM\|BY_CUSTOMER` | **no SQL column** |

- **FK in JSON:** none (drivers are roots).
- **Used by:** `app.get/post/patch/delete '/api/drivers'` (demoServer.js:1100-1131); referenced by `runs.DriverId`.
- **Sample (PII redacted):** `{ DriverId: 1, Code: 'DRV-01', FullName: '<REDACTED>', Phone: '<REDACTED>', Email: '', VehiclePlate: '<REDACTED>', VehicleCapacity: 14, IsActive: true, Zones: 'NORTH,SHARON,CENTER,JERUSALEM' }`
- **Migration difficulty: S.** Direct INSERT for the 3 rows. **But:** the `Zones` CSV needs to be expanded into `DriverZones` rows; the new vehicle-type columns need `ALTER TABLE Drivers ADD VehicleType, VehicleCapacityL, VehicleCapacityKg, LoadingMode` (or punt them - currently 1/3 drivers has them populated).
- **Corruption risk:** trivial - 3 rows. The `Code`/`UNIQUE` constraint matches on import.
- **Duplicate risk on re-run:** `Code` is the natural dedupe key (UNIQUE). Use `MERGE ON Code`.

### B.2 `users` (2 records) - migration **S**

| Field | JS type | SQL column |
|---|---|---|
| `UserId` | int | `Users.UserId` |
| `Username` | string | `Users.Username` |
| `FullName` | string | `Users.FullName` |
| `Email` | string | `Users.Email` |
| `Phone` | string | **no SQL column** (extension needed) |
| `Role` | string | `Users.Role` |
| `IsActive` | bool | `Users.IsActive` |
| `PreferredLanguage` | string `'he'` | **no SQL column** |
| `PasswordHash` | string (bcrypt $2a$10$…) | `Users.PasswordHash` |
| `LastLoginAt` | ISO ts \| null | `Users.LastLoginAt` |
| `CreatedAt` | ISO ts | `Users.CreatedAt` |

- **FK in JSON:** none.
- **Used by:** `auth/login` (demoServer.js:91), `'/api/users'` (1135-1167), `'/api/auth/me'` (252).
- **Sample (PII redacted):** `{ UserId: 1, Username: 'admin', FullName: '<REDACTED>', Email: '<REDACTED>', Role: 'ADMIN', IsActive: true, PreferredLanguage: 'he', PasswordHash: '<REDACTED bcrypt>', LastLoginAt: '2026-04-29T20:51:14.289Z', CreatedAt: '2026-04-23T19:18:33.386Z' }`
- **Migration difficulty: S** if `Phone` + `PreferredLanguage` columns are added; otherwise **M** (drop them or store in a JSON column).
- **Corruption risk:** none (2 rows; both bcrypt hashes are well-formed `$2a$10$…`). Migrating preserves the hashes and admin login keeps working.
- **Duplicate risk on re-run:** `Username` is the natural dedupe key.

### B.3 `zones` (9 records) - migration **S**

| Field | JS type | SQL column |
|---|---|---|
| `ZoneId` | int | `Zones.ZoneId` |
| `Code` | string | `Zones.Code` (UNIQUE) |
| `Name` | string (he) | `Zones.Name` |
| `Description` | string (he) | `Zones.Description` |
| `ColorHex` | `#RRGGBB` | `Zones.ColorHex` |
| `SortOrder` | int | `Zones.SortOrder` |
| `IsActive` | bool | `Zones.IsActive` |

- **FK in JSON:** none.
- **Used by:** every run (`runs.ZoneId`), city-zone resolution (`findZoneByCity` at `persistentStore.js:501`), `'/api/zones'` (demoServer.js:311-1093).
- **Migration difficulty: S.** Migration 002 already seeds 7 of these by `Code`; the 2 added live (incl. `NORTHWEST` ZoneId=9) just need `MERGE ON Code`.
- **Corruption risk:** none.
- **Duplicate risk on re-run:** `Code` is UNIQUE.

### B.4 `runs` (54 records) - migration **M**

| Field | JS type | SQL column |
|---|---|---|
| `RunId` | int | `DeliveryRuns.RunId` |
| `RunNumber` | `RUN-YYYY-MM-DD-NN` | `DeliveryRuns.RunNumber` (UNIQUE) |
| `RunDate` | `YYYY-MM-DD` | `DeliveryRuns.RunDate` |
| `ZoneId` | int | `DeliveryRuns.ZoneId` (FK Zones) |
| `ZoneCode/Name/Color` | string (denorm) | **drop** - JOIN to Zones |
| `DriverId` | int \| null | `DeliveryRuns.DriverId` |
| `DriverName/Phone/VehiclePlate` | string (denorm) | **drop** - JOIN to Drivers |
| `Status` | enum | `DeliveryRuns.Status` |
| `PlannedStartTime`/`ActualStartTime`/`ActualEndTime` | ISO ts \| null | same |
| `Notes` | string \| null | `DeliveryRuns.Notes` |
| `CreatedAt` | ISO ts | `DeliveryRuns.CreatedAt` |
| `StopCount`/`OrderCount` | int (denorm cache) | **drop** - aggregate from `DeliveryStops` / `RunOrders` |
| `DepartureApprovedAt`/`DepartureApprovedBy`/`DepartureNotes`/`DepartureChecklist`/`DepartureRejectedAt`/`DepartureRejectedBy`/`DepartureRejectReason` | optional fields written by `approveRunDeparture` (persistentStore.js:607) | **no SQL columns** - schema extension needed |

- **FK in JSON:** `runs.ZoneId → zones.ZoneId`, `runs.DriverId → drivers.DriverId`.
- **Used by:** `'/api/runs*'` (demoServer.js:1192-1296), planner (`/api/runs/auto-plan` 1308), wave creation (1543), driver app (`/api/driver/my-runs` 1952).
- **Sample (PII redacted):** `{ RunId: 1, RunNumber: 'RUN-2026-04-24-01', RunDate: '2026-04-24', ZoneId: 2, ZoneCode: 'SHARON', DriverId: null, Status: 'PICKING', Notes: 'תכנון אוטומטי - 2026-04-24', CreatedAt: '2026-04-24T03:49:44.478Z', StopCount: 18, OrderCount: 27 }`
- **Migration difficulty: M.** Strip denormalised columns; preserve identity (use `SET IDENTITY_INSERT DeliveryRuns ON`); decide on `DepartureChecklist` (recommend new column `DepartureChecklist NVARCHAR(MAX)` JSON, or 5 BIT cols). Status enum has values not in 001's comment list (`PENDING_QC`, `READY_TO_DEPART`, `PENDING_DEPARTURE`) - widen the column or add a CHECK update.
- **Corruption risk:** none across the 54 rows (all `ZoneId` values resolve, all `DriverId`s are null or resolve). However the 16 PICKING-status rows reference a wave that may also be PICKING/CANCELLED (see B.7).
- **Duplicate risk on re-run:** `RunNumber` is UNIQUE in SQL - safe natural key.

### B.5 `stops` (816 records) - migration **L**

| Field | JS type | SQL column |
|---|---|---|
| `StopId` | int | `DeliveryStops.StopId` |
| `RunId` | int | `DeliveryStops.RunId` (FK CASCADE) |
| `AddressId` | always `null` (in current data) | `DeliveryStops.AddressId` (NOT NULL FK NormalizedAddresses) |
| `StopOrder` | int | `DeliveryStops.StopOrder` |
| `Status` | `'PENDING'` (all 816) | same |
| `ArrivedAt`/`CompletedAt` | null | same |
| `SignatureUrl`/`PhotoUrl` | null | same |
| `Notes` | string \| null | `DeliveryStops.Notes` |
| `Street` | string | **on `NormalizedAddresses`, not `DeliveryStops`** |
| `BuildingNumber` | string | same |
| `City` | string | same |
| `BranchName` | string | `NormalizedAddresses.BranchName` |
| `Latitude`/`Longitude` | null in data | `NormalizedAddresses.Latitude`/`Longitude` |
| `DeliveryWindowStart`/`DeliveryWindowEnd`/`DeliveryDays` | null in data | `NormalizedAddresses.DeliveryWindowStart`… (migration 007) |
| `ContactPhone`/`ContactName` | string \| null | `NormalizedAddresses.ContactPhone`/`ContactName` (migration 007) |
| `DeliveryNotes` | string \| null | `NormalizedAddresses.DeliveryNotes` (migration 007) |
| `SuggestedZoneId`/`SuggestedZoneName` | int/string \| null | **no SQL column** |

- **FK in JSON:** `stops.RunId → runs.RunId` (verified: 0 orphans across 816 stops).
- **Used by:** `'/api/stops*'`, route optimisation (`'/api/runs/:id/optimize-order'` 1585), wave creation, driver app (`/api/driver/runs/:id/manifest` 1963).
- **Sample (PII redacted):** `{ StopId: 1, RunId: 1, AddressId: null, StopOrder: 1, Status: 'PENDING', Street: 'מתחם ביג גלילות', BuildingNumber: '', City: 'רמת השרון', BranchName: '<REDACTED chain branch>', Latitude: null, Longitude: null, ContactPhone: '<REDACTED>', SuggestedZoneId: 2, SuggestedZoneName: 'שרון' }`
- **Migration difficulty: L.** This is the hard one. The SQL schema requires `AddressId NOT NULL` - the JSON has `AddressId=null` on **all 816 stops**. Migration must:
  1. For each stop, build a `NormalizedKey` (e.g. `street|buildingNumber|city|branchName`),
  2. Insert/upsert into `NormalizedAddresses` (with `DeliveryWindow*`, `Contact*`, `DeliveryNotes` from the stop),
  3. Then insert into `DeliveryStops` with the resolved `AddressId`.
  This is a 1-to-many denormalisation reverse: ~816 stops will probably collapse to ~400-500 unique addresses (chains repeat).
- **Corruption risk:** dedup key is fragile - the same physical store appears with slightly different `BranchName` strings (e.g. with and without quotes around `בע"מ`); naive dedup will create duplicate addresses. `City` field has values like `'נתניה 4247021'` (city + ZIP smashed together) - need to split. `ContactPhone` has values like `'דלפק-3 09-8338811'` (label prefix) which violate `VARCHAR(20)`.
- **Duplicate risk on re-run:** `StopId` itself is the safe key if `IDENTITY_INSERT` is used; but address-side dedup needs `NormalizedKey` to be deterministic.

### B.6 `runOrders` (1,307 records) - migration **M**

| Field | JS type | SQL column |
|---|---|---|
| `RunOrderId` | int | `RunOrders.RunOrderId` |
| `StopId` | int | `RunOrders.StopId` (FK CASCADE) |
| `CompanyId` | 1 (A=OIG) or 2 (B=Unico) | `RunOrders.CompanyId` (FK Companies) |
| `CompanyCode` | `'A'` / `'B'` | **drop** - JOIN to Companies |
| `CompanyName` | denorm | **drop** |
| `SapDocEntry` | int | `RunOrders.SapDocEntry` |
| `SapDocNum` | int | `RunOrders.SapDocNum` |
| `SapCardCode` | string | `RunOrders.SapCardCode` |
| `SapCardName` | string | `RunOrders.SapCardName` |
| `OrderTotal` | number | `RunOrders.OrderTotal` |
| `LinesCount` | int | `RunOrders.LinesCount` |
| `Status` | `'PENDING'` (all 1,307) | same |
| `SapDeliveryDocEntry` | null | same |

- **FK in JSON:** `runOrders.StopId → stops.StopId` (verified: 0 orphans across 1,307 rows).
- **Used by:** `'/api/run-orders'` (1297), `'/api/stops/:stopId/orders'` (1290), wave creation (line aggregation), DN generation (1804).
- **Sample (PII redacted):** `{ RunOrderId: 1, StopId: 1, CompanyId: 2, CompanyCode: 'B', CompanyName: 'Unico', SapDocEntry: 20751, SapDocNum: 20751, SapCardCode: '2000050', SapCardName: '<REDACTED>', OrderTotal: 35, LinesCount: 1, Status: 'PENDING', SapDeliveryDocEntry: null }`
- **Migration difficulty: M.** SQL has `UNIQUE (CompanyId, SapDocEntry)` - in the JSON, the same SapDocEntry can theoretically appear in multiple runs across history (though demos so far do not show this). Need to verify with `SELECT CompanyCode, SapDocEntry, COUNT(*)` before insert.
- **Corruption risk:** the unique constraint will break the import if any (CompanyId, SapDocEntry) pair repeats. **A pre-flight check is mandatory.**
- **Duplicate risk on re-run:** safe natural key is `(CompanyId, SapDocEntry)` per the SQL UNIQUE - use `MERGE`.

### B.7 `waves` (21 records) - migration **M**

| Field | JS type | SQL column |
|---|---|---|
| `WaveId` | int | `PickingWaves.WaveId` |
| `WaveNumber` | string | `PickingWaves.WaveNumber` (UNIQUE) |
| `RunId` | int | `PickingWaves.RunId` |
| `RunNumber`/`RunDate` | denorm | **drop** |
| `Status` | `PENDING\|IN_PROGRESS\|PENDING_QC\|COMPLETED\|CANCELLED` | same (widen vs migration 001) |
| `PickedBy` | int \| null | `PickingWaves.PickedBy` |
| `PickedByName` | denorm | **no SQL col** (drop or add) |
| `StartedAt`/`CompletedAt`/`CreatedAt` | ISO ts | same |
| `TotalLines`/`CompletedLines` | int | **no SQL col** (recompute from `PickingWaveLines`) |
| `QcApprovedAt`/`QcApprovedBy`/`QcNotes`/`QcRejectedAt`/`QcRejectedBy` | optional, written by `approveWaveQc` (persistentStore.js:1542) | **no SQL cols** - schema extension |

- **FK in JSON:** `waves.RunId → runs.RunId`, `waves.PickedBy → users.UserId` (or pickers.PickerId? Code uses `users` table on login but writes whatever `userName` was passed - inconsistent).
- **Used by:** `'/api/runs/:id/wave'` (1543), `'/api/picking/*'` (2407-).
- **Sample:** `{ WaveId: 1, WaveNumber: 'WAVE-RUN-2026-04-24-01-01', RunId: 1, Status: 'CANCELLED', PickedBy: null, StartedAt: null, CompletedAt: null, CreatedAt: '2026-04-24T04:10:52.375Z', TotalLines: 23, CompletedLines: 0 }`
- **Migration difficulty: M.** Status `PENDING_QC` is not in migration 001's enum comment - widen. Need new columns for QC approval + checklist. `PickedBy` needs reconciliation - if it points to a Picker, the schema needs a `PickedByPickerId` column instead of (or alongside) `PickedByUserId`.
- **Corruption risk:** `WaveNumber` UNIQUE collisions are unlikely (already unique in JSON). Some waves are `CANCELLED` because a run had a wave recreated - migration must preserve all of them, not just the active one.
- **Duplicate risk on re-run:** `WaveNumber` is the safe key.

### B.8 `waveLines` (505 records) - migration **M**

| Field | JS type | SQL column |
|---|---|---|
| `WaveLineId` | int | `PickingWaveLines.WaveLineId` |
| `WaveId` | int | `PickingWaveLines.WaveId` |
| `SapItemCode` | string | same |
| `SapItemName` | string | same |
| `Barcode` | string | **no SQL col** |
| `UomCode` | string | **no SQL col** |
| `BinLocation` | string | `PickingWaveLines.BinLocation` |
| `TotalQuantity` | number | same |
| `PickedQuantity` | number | same |
| `Status` | `PENDING\|PARTIAL\|COMPLETED\|SHORTAGE` | same |
| `AllocationCount` | int (denorm) | **drop** |
| `Notes` | string \| null | **no SQL col** |

- **FK in JSON:** `waveLines.WaveId → waves.WaveId` (verified: 0 orphans).
- **Used by:** `'/api/picking/*'`.
- **Migration difficulty: M.** Schema extension needed: `Barcode`, `UomCode`, `Notes`. Drop `AllocationCount`.
- **Corruption risk:** none across 505 rows.

### B.9 `waveAllocations` (826 records) - migration **L**

| Field | JS type | SQL column |
|---|---|---|
| `AllocationId` | int | `PickingAllocations.AllocationId` |
| `WaveLineId` | int | `PickingAllocations.WaveLineId` (CASCADE) |
| `CompanyCode` | `'A'`/`'B'` | indirectly via RunOrder |
| `SapDocEntry` | int | indirectly via RunOrder |
| `SapDocNum` | int | redundant |
| `SapOrderLineNum` | int | `PickingAllocations.SapOrderLineNum` |
| `SapCardName` | denorm | **drop** |
| `City`/`BranchName` | denorm (newer rows only) | **drop** |
| `Quantity` | number | `PickingAllocations.Quantity` |
| `PickedQuantity`/`Status`/`LastPickedAt`/`LastPickedBy` | written by `pickAllocation` (persistentStore.js:1623) | **no SQL cols** - extension required |

- **FK in JSON:** `waveAllocations.WaveLineId → waveLines.WaveLineId` (0 orphans). The SQL FK target `RunOrderId` is **NOT** stored in JSON - it's encoded as `(CompanyCode, SapDocEntry, SapOrderLineNum)`.
- **Used by:** `'/api/picking/allocations/:id/pick'` (2454), wave reads (`getWave` at persistentStore.js:1459).
- **Migration difficulty: L.** Two distinct issues:
  1. The SQL FK is `RunOrderId` but the JSON has only `(CompanyCode, SapDocEntry)`. The migration must JOIN to `RunOrders` on `(CompanyCode → CompanyId, SapDocEntry)` to find the right `RunOrderId`. **If a RunOrder has been deleted/archived in between, the FK will fail.**
  2. Picking state (`PickedQuantity`, `Status`, `LastPickedAt`, `LastPickedBy`) needs new columns or a side `PickingAllocationProgress` table.
- **Corruption risk:** the join in (1) may produce zero matches for waves whose runs were deleted with `deleteRun` (persistentStore.js:421-430) since `deleteRun` doesn't cascade-delete waveAllocations. **Verify FK resolution before INSERT.** Also note: `PickedQuantity` and `Status` only exist on rows that have actually been picked - majority of rows lack them.
- **Duplicate risk:** safe natural key = `(WaveLineId, CompanyCode, SapDocEntry, SapOrderLineNum)` - need a UNIQUE constraint added.

### B.10 `deliveryNotes` (12 records) - migration **L**

No SQL table exists. Schema (per persistentStore.js:1842):

| Field | JS type | Notes |
|---|---|---|
| `DeliveryNoteId` | int | PK candidate |
| `DocNumber` | `DN-{stopId}-{company}-{seq4}` | UNIQUE candidate |
| `StopId` | int | FK DeliveryStops |
| `RunId` | int | FK DeliveryRuns (redundant with StopId.RunId) |
| `CompanyCode`/`CompanyName` | denorm | resolve via Companies |
| `SapCardCode`/`SapCardName` | string | direct |
| `SourceOrders` | array of `{ RunOrderId, SapDocEntry, SapDocNum, OrderTotal, LinesCount }` | **needs unnest into a child table** `DeliveryNoteOrders` |
| `TotalAmount`/`LineCount` | number/int | direct |
| `Status` | `PENDING_EXPORT\|EXPORTED\|SAP_CONFIRMED\|FAILED\|CANCELLED` | direct |
| `SapDeliveryDocEntry`/`SapDeliveryDocNum` | int \| null | direct |
| `ExportedAt`/`SentToSapAt`/`ConfirmedAt` | ISO ts \| null | direct |
| `ErrorMessage` | string \| null | direct |
| `Notes` | string \| null | direct |
| `Address` | nested `{ Street, BuildingNumber, City, BranchName }` | denorm of stop's address - drop, JOIN to NormalizedAddresses via Stop |
| `DeliveryDate` | `YYYY-MM-DD` | direct |
| `CreatedAt` | ISO ts | direct |
| `Method` | `AUTO\|PICKING_AUTO\|QC_APPROVED` | direct |

- **FK in JSON:** `deliveryNotes.StopId → stops.StopId` (0 orphans), `deliveryNotes.RunId → runs.RunId` (0 orphans), `deliveryNotes.SourceOrders[*].RunOrderId → runOrders.RunOrderId`.
- **Used by:** `'/api/delivery-notes'` (2323), `'/api/sap/write/delivery-note/:id'` (412), `'/api/stops/:stopId/generate-delivery-notes'` (2276), `'/api/reports/delivery-notes.xlsx'` (2345).
- **Migration difficulty: L.** Requires a new schema (proposal: `DeliveryNotes` parent table + `DeliveryNoteOrders` link table). The `Address` nested object can be discarded (resolve via `StopId → AddressId`). The `SourceOrders` array must be normalised.
- **Corruption risk:** all 12 are `PENDING_EXPORT` and were written in the same second on 2026-04-29. Once SAP write happens, the delta with the migrated copy will be problematic - **the production cutover must guarantee no DN export happens between the snapshot and the import**.

### B.11 `invoices` (1 record) - migration **L**

Same shape as deliveryNotes plus `VatAmount`/`GrossAmount`/`InvoiceDate`/`SapInvoiceDocEntry`/`SapInvoiceDocNum`. No SQL table. New schema needed: `Invoices` parent + (optionally) child link to DeliveryNotes via `DeliveryNoteId`.

- **FK in JSON:** `invoices.DeliveryNoteId → deliveryNotes.DeliveryNoteId` (1/1 valid).
- **Used by:** `'/api/invoices'` (2330), `'/api/delivery-notes/:id/generate-invoice'` (2286), `'/api/sap/write/invoice/:id'` (434), `'/api/reports/invoices.xlsx'` (2376).
- **Migration difficulty: L** (same reasoning as deliveryNotes; only 1 row to move so the data part is trivial - the schema design is the work).

### B.12 `cityZoneOverrides` (26 entries) - migration **M**

`{ city: zoneCode }` map. Used by `findZoneByCity` (persistentStore.js:507) and `'/api/zones/cities'` (demoServer.js:318).

- **No SQL equivalent.** Proposal: new table `CityZoneOverrides (City NVARCHAR(100) PRIMARY KEY, ZoneCode VARCHAR(20) FK Zones.Code, UpdatedAt)`.
- **Sample:** `{'חיפה': 'NORTHWEST', 'נשר': 'NORTHWEST', 'חדרה': 'NORTHWEST', ...}` - 24 of 26 entries reroute coastal/Haifa cities to the new `NORTHWEST` zone.
- **Migration difficulty: M.** Tiny dataset, but requires schema extension. Easy to seed from JSON.
- **Risk:** if migration creates the table but forgets to copy these overrides, planner will revert to the hardcoded `CITY_TO_ZONE` map (persistentStore.js:449) which assigns Haifa to `NORTH` not `NORTHWEST`. **User-visible regression.**

### B.13 `customerDocPolicies` (15 entries) - migration **M**

`{ parentCustomerName: 'DELIVERY_NOTE'|'INVOICE' }`. Used by `resolveDocTypeForCardName` (persistentStore.js:994), called from `approveWaveQc` to decide whether each delivery note becomes an invoice (1565).

- **No SQL equivalent.** Proposal: `CustomerDocPolicies (ParentName NVARCHAR(200) PK, DocType VARCHAR(20))`.
- **Migration difficulty: M.** Trivial data, schema extension required.
- **Risk:** if not migrated, `DEFAULT_DOC_TYPE = 'INVOICE'` (persistentStore.js:966) kicks in and creates invoices for chains that explicitly want delivery notes. **Direct billing impact.**

### B.14 `pickers` (1 record) - migration **S**

| Field | Type |
|---|---|
| `PickerId`/`Code`/`FullName`/`Phone`/`IsActive`/`CreatedAt` | as documented |

No SQL table. Proposal: `Pickers (PickerId IDENTITY, Code UNIQUE, FullName, Phone, IsActive, CreatedAt)`.

- **Used by:** `'/api/auth/picker-login'` (109), `'/api/pickers'` (134-150), `wave.PickedBy` may store a PickerId.
- **Migration difficulty: S** (1 row).

### B.15 `lineDeliveries` (0 records) - migration **N/A**

Schema defined (`recordLineDeliveries`, persistentStore.js:670) but never written. No data to migrate. Just create the SQL table for future use (`StopLineDeliveries (LineDeliveryId, StopId, RunId, AllocationId, WaveLineId, ItemCode, ItemName, OrderedQty, DeliveredQty, DamagedQty, MissingQty, DamageNotes, DamagePhotoUrl, DeliveryStatus, RecordedBy, RecordedAt)`).

### B.16 Implicit (defined-but-empty) collections

| Collection | First-write fn | Records | Action |
|---|---|---|---|
| `customerHours` | `setCustomerHours` (l.907) | 0 | Create empty SQL table; no data to migrate. |
| `codCollections` + `nextCodId` | `recordCodCollection` (l.750) | 0 | Same. |
| `driverStats` | `recordDriverPerformance` (l.817) | 0 | Same. |

---

## C. Cross-entity relationships

### C.1 FK graph (text)

```
zones (9)
  ↑ ZoneId
  └── runs (54) ─────────────────────────┐
        ↑ RunId                          │ DriverId
        ├── stops (816)                  ↓
        │     ↑ StopId             drivers (3)
        │     └── runOrders (1307) ─┐
        │                            │ (RunOrderId target needed for SQL FK,
        │                            │  but JSON only has CompanyCode+SapDocEntry)
        ├── waves (21) ──────────────│──┐
        │     ↑ WaveId               │  │
        │     └── waveLines (505)    │  │ PickedBy
        │           ↑ WaveLineId     │  │
        │           └── waveAllocations (826) ──┘
        │
        ├── deliveryNotes (12)
        │     ↑ DeliveryNoteId
        │     └── invoices (1)
        │
        └── (lineDeliveries: 0)

users (2) - referenced by waves.PickedBy / approvals (loose ref - not enforced)
pickers (1) - same (loose ref)

cityZoneOverrides {city → zoneCode} - by zone Code, not ID
customerDocPolicies {parent → 'DELIVERY_NOTE'|'INVOICE'} - by name string
```

### C.2 Orphan check results

| Edge | Orphans / Total |
|---|---|
| `runs.DriverId → drivers.DriverId` | 0 / 54 |
| `runs.ZoneId → zones.ZoneId` | 0 / 54 |
| `stops.RunId → runs.RunId` | 0 / 816 |
| `runOrders.StopId → stops.StopId` | 0 / 1307 |
| `waves.RunId → runs.RunId` | (not checked exhaustively, but `waveLines.WaveId → waves.WaveId` is 0/505) |
| `waveLines.WaveId → waves.WaveId` | 0 / 505 |
| `waveAllocations.WaveLineId → waveLines.WaveLineId` | 0 / 826 |
| `deliveryNotes.RunId → runs.RunId` | 0 / 12 |
| `deliveryNotes.SourceOrders[*].RunOrderId → runOrders.RunOrderId` | (not checked - need scan) |
| `invoices.DeliveryNoteId → deliveryNotes.DeliveryNoteId` | 0 / 1 |

**The store is internally consistent.** No orphans in the structural FK graph at the snapshot time. (This is largely because nothing has been deleted - all the cascade-delete code paths in `deleteRun`/`deleteStop` simply haven't been exercised on any data still in the file.)

### C.3 Ambiguous / circular references

- `waves.PickedBy` is typed `int|null` but the calling code passes either `userId` (from a logged-in user) or nothing. No circularity. The migration must decide: is `PickedBy` a `Users.UserId` or a `Pickers.PickerId`? Currently both can write to it; pickers usually log in via `/api/auth/picker-login` which may carry a different ID space.
- `waveAllocations` has indirect FK `(CompanyCode, SapDocEntry, SapOrderLineNum) → runOrders.(CompanyCode, SapDocEntry, ?)` but `runOrders` does **not** store `SapOrderLineNum`. The line-num link only resolves through the SAP source data fetched live, not from store.json. **The SQL FK `PickingAllocations.RunOrderId` cannot be perfectly recovered from JSON alone for waveAllocations.SapOrderLineNum > 0 cases** - need to fall back to `(CompanyCode, SapDocEntry) → RunOrderId` and lose the line-level join.

---

## D. Operational dependencies

### D.1 Daily writes (high-frequency)

These collections grow every working day; a one-shot migration becomes stale quickly:

- `runs` (auto-plan creates ~5-10/day per `'/api/runs/auto-plan'` 1308)
- `stops` (auto-plan creates ~50-200/day)
- `runOrders` (auto-plan creates ~100-300/day)
- `waves`, `waveLines`, `waveAllocations` (warehouse runs ~5/day)
- `codCollections` (deferred until field crews start using it)
- `driverStats` (every completed stop writes 1 entry)
- `lineDeliveries` (every door-step write)
- `deliveryNotes` (one batch per wave QC approval)
- `invoices` (subset of deliveryNotes per `customerDocPolicies`)

### D.2 Per-page-load reads (operational hot path)

Read on basically every dashboard load:
- `runs`, `stops`, `runOrders` - dashboard, list views
- `zones`, `drivers` - filters/dropdowns everywhere
- `waves`, `waveLines`, `waveAllocations` - warehouse handheld UI

Read frequently:
- `users` - auth + admin pages
- `cityZoneOverrides` - planner zone resolution
- `customerDocPolicies` - QC approval flow

### D.3 Write-once / read-rarely (migrate last)

- `pickers` (configured rarely)
- `customerHours` (configured rarely; currently empty)
- `customerDocPolicies` (configured rarely)
- `cityZoneOverrides` (configured rarely)

---

## E. Migration gap analysis

### E.1 Already in SQL (migrations 001-008) - dual-source risk

| store.json key | SQL table | Dual-source risk |
|---|---|---|
| `drivers` | `dbo.Drivers` | server.js may have run between 2026-05-05 → 2026-05-06 and inserted DRV-rows directly. Migration must `MERGE ON Code`, **not** straight INSERT. |
| `users` | `dbo.Users` | Same risk - `MERGE ON Username`. |
| `zones` | `dbo.Zones` | Already merged by `Code` in migration 002. The 2 added zones (`NORTHWEST`, the 9th custom one) need a top-up `MERGE`. |
| `runs` | `dbo.DeliveryRuns` | Demo server uses identity values 1..55; if SQL has any DeliveryRuns rows from server.js runs between 2026-05-05 → 2026-05-06, the IDs **will collide**. Cannot use `SET IDENTITY_INSERT` blindly - need to check existing max. |
| `stops` | `dbo.DeliveryStops` | Same collision risk. Plus the `AddressId NOT NULL` blocker. |
| `runOrders` | `dbo.RunOrders` | UNIQUE(CompanyId, SapDocEntry) is the dedup natural key. |
| `waves`, `waveLines`, `waveAllocations` | `dbo.PickingWaves`, `PickingWaveLines`, `PickingAllocations` | ID collision risk + `AllocationId` FK gap (see B.9). |

### E.2 Store-only (need new SQL tables)

| Key | Proposed SQL table |
|---|---|
| `deliveryNotes` | `dbo.DeliveryNotes` + `dbo.DeliveryNoteOrders` (unnest `SourceOrders[]`) |
| `invoices` | `dbo.Invoices` |
| `cityZoneOverrides` | `dbo.CityZoneOverrides` |
| `customerDocPolicies` | `dbo.CustomerDocPolicies` |
| `customerHours` | `dbo.CustomerHours` (defined-but-empty in store) |
| `pickers` | `dbo.Pickers` |
| `lineDeliveries` | `dbo.StopLineDeliveries` (defined-but-empty in store) |
| `codCollections` | `dbo.CodCollections` (defined-but-empty in store) |
| `driverStats` | `dbo.DriverPerformanceStats` (defined-but-empty in store) |
| `runs.DepartureChecklist`/`DepartureApprovedAt`/… | columns to add to `dbo.DeliveryRuns` |
| `waves.QcApprovedAt`/… | columns to add to `dbo.PickingWaves` |

### E.3 SQL-only (no store data; expect NULLs/defaults)

These SQL tables are defined by migrations 001-008 and have no counterpart in `store.json`:

- `dbo.Companies` - **already seeded** by migration 002.
- `dbo.NormalizedAddresses` - empty in JSON, must be **synthesised** from `stops.Street/City/...` during migration (see B.5).
- `dbo.CustomerAddressLinks` - same; can be derived from `(runOrders.CompanyId, runOrders.SapCardCode) → stops.AddressId`.
- `dbo.ReturnRequests` + `dbo.ReturnRequestLines` - empty in store (the demoServer keeps `runtimeReturns` in process memory only - **lost on restart, no need to migrate**).
- `dbo.DriverLocations` + `dbo.DriverLocationHistory` - empty in store (`runtimeDriverLocations` is also process-memory only).
- `dbo.SapRetryQueue` - process-memory only.
- `dbo.FailureReasons` - seeded by migration 004.
- `dbo.StopFailures` - empty in store (no failures recorded).
- `dbo.TrackingTokens` - process-memory only (`'/api/runs/stops/:stopId/tracking-link'` 1592).
- `dbo.SystemSettings` - seeded by migration 005.
- `dbo.AuditLog` - never written by the demo.
- `dbo.AgentRuns` + `dbo.AgentToolCalls` - never written by the demo.

### E.4 Estimated daily growth (for cutover staleness)

Based on the 12-day window 2026-04-24 → 2026-05-05 in the snapshot:
- `runs`: 54 / 12 days ≈ **4.5/day**
- `stops`: 816 / 12 ≈ **68/day**
- `runOrders`: 1,307 / 12 ≈ **109/day**
- `waves`: 21 / 12 ≈ **1.75/day**
- `waveLines`: 505 / 12 ≈ **42/day**
- `waveAllocations`: 826 / 12 ≈ **69/day**

**Conclusion: a one-shot migration is viable only if the demo server is paused during the cutover.** A 24-hour gap means roughly 100 stops + 110 orders + 70 wave allocations of un-migrated data.

---

## F. Risks and recommendations

### F.1 Top-3 corruption risks

1. **`stops.AddressId NOT NULL` blocker.** All 816 stops have `AddressId=null`. The migration **must** synthesise NormalizedAddresses first; naive INSERT fails on the FK constraint. Strict dedup logic needed because `City` field has trailing ZIP codes (`'נתניה 4247021'`), `BranchName` has variations of `בע"מ` quoting, and `ContactPhone` has label prefixes (`'דלפק-3 09-8338811'`).
2. **`PickingAllocations.RunOrderId` recovery.** SQL has FK to `RunOrders` but JSON stores `(CompanyCode, SapDocEntry, SapOrderLineNum)`. JOIN must run before INSERT; rows that fail to resolve must be quarantined or assigned a placeholder.
3. **IDENTITY collision.** If `server.js` has been writing to SQL between 2026-05-05 and the migration date, the auto-incremented IDs (`RunId 1..55`, `StopId 1..817`, `RunOrderId 1..1309`, `WaveAllocationId 1..826`) will already be partially used. Migration must either (a) renumber on the fly with an `OldId → NewId` map, or (b) use `IDENTITY_INSERT` only after verifying no overlap.

### F.2 Top-3 duplicate risks (re-running migration)

1. `RunOrders` has `UNIQUE (CompanyId, SapDocEntry)` - second run fails without `MERGE`.
2. `Drivers.Code`, `Users.Username`, `Zones.Code`, `DeliveryRuns.RunNumber`, `PickingWaves.WaveNumber` are all UNIQUE - all need MERGE-style upserts.
3. Synthesised `NormalizedAddresses` rows have no natural key - if migration runs twice without first checking `NormalizedKey`, duplicates pile up.

### F.3 Data-loss risks

- The denormalised cache fields (`run.StopCount`, `run.OrderCount`, `wave.TotalLines`, `waveLine.AllocationCount`, etc.) are not stored in SQL - they need to be recomputed by triggers or read-side aggregation. **If consumers depend on them being in the response payload**, the API layer needs to populate them.
- `DepartureChecklist` (object), `SourceOrders` (array), `Address` (object) embedded in JSON are nested structures with no SQL home unless explicitly designed. Recommendation: store as `NVARCHAR(MAX)` JSON column (`DepartureChecklist`, embedded `SourceOrders` table, drop `Address`).
- `lineDeliveries` is empty now but the schema and routes are wired; if migration omits the table, future writes fail silently in server.js.

### F.4 Consistency check at snapshot time

- ✅ All structural FKs resolve (no orphans across 7 tested edges, 3,500+ rows checked).
- ✅ `bcrypt` hashes are well-formed; admin can log in after migration.
- ✅ Status enums all map onto demoServer-defined values (no garbage data).
- ⚠️ 0 stops have `Status != 'PENDING'` - confirms the production system has never completed a delivery; the migration's "real" data is currently **planning data only**.
- ⚠️ Only 12 deliveryNotes and 1 invoice exist - tiny SAP-export footprint.
- ⚠️ JSON validity itself: `JSON.parse` succeeds end-to-end, no truncation.

### F.5 What MUST be migrated first

1. **`zones` (9 rows)** - referenced by every `runs.ZoneId`. Already partially in SQL via migration 002; just MERGE the 2 missing custom zones. The `cityZoneOverrides` map should land at the same time so the planner doesn't regress.
2. **`drivers` (3) + `users` (2) + `pickers` (1)** - tiny but referenced everywhere. Auth fails without users.
3. **`customerDocPolicies` (15)** - one-shot table, but **financial impact** if missed (wrong doc type → wrong tax handling).
4. **Then:** `runs → stops (with synthesised addresses) → runOrders → waves → waveLines → waveAllocations`. Order matters because of FK dependencies; CASCADE deletes in SQL mean a missed parent breaks the child.

### F.6 What can be deferred

- `deliveryNotes`, `invoices` - 13 rows total, all `PENDING_EXPORT`. If the cutover happens before the operator clicks "send to SAP", the data can be re-generated by re-running QC approval against the fresh SQL state. This is the single safest place to take a fresh-start cut.
- `lineDeliveries`, `codCollections`, `customerHours`, `driverStats` - empty in the current store; just create the tables.
- `nextDriverId`/`nextUserId`/etc. counters - SQL `IDENTITY` makes them obsolete.

### F.7 Recommended migration approach (summary)

1. **Freeze writes** to demoServer (read-only mode for the cutover window).
2. **Snapshot** `store.json` to a versioned filename.
3. **Run a pre-flight script** that reads the snapshot and verifies (in this order): bcrypt hash format on users, FK closure on each parent→child edge, no `(CompanyId, SapDocEntry)` duplicates in `runOrders`, no `RunNumber`/`WaveNumber` collisions, address synthesis dry-run produces unique `NormalizedKey`s.
4. **Apply schema extensions** for the new tables (deliveryNotes, invoices, cityZoneOverrides, customerDocPolicies, pickers, customerHours, codCollections, driverStats, lineDeliveries) plus column additions on `Drivers`, `Users`, `DeliveryRuns`, `PickingWaves`, `PickingWaveLines`, `PickingAllocations`.
5. **Import in dependency order** with `MERGE` upserts on natural keys; treat IDENTITY columns by remapping (build an `OldId → NewId` table) rather than `IDENTITY_INSERT` to avoid collision with server.js writes.
6. **Spot-check** critical KPIs match between demo and SQL (count of OPEN runs, sum of `OrderTotal` per company, list of customer policies).
7. **Re-point** the application to `server.js` and re-enable writes.

---

*Compiled from a read-only inspection of `backend/data/store.json` at snapshot 2026-05-05 09:59. No source files were modified.*
