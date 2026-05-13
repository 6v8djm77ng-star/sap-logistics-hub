/**
 * Delivery Runs Service - manages the core entity "מסלול הפצה".
 *
 * A Run = one truck, one day, one zone. It contains:
 *   - Multiple Stops (addresses)
 *   - Each Stop has N Orders (from Company A and/or B)
 *   - Optionally Return pickups at the same stops
 *
 * Runs are the unit of planning, picking, and execution.
 */
import * as db from '../db/logisticsDb.js';
import * as unif from './orderUnification.js';
import { logAudit } from './auditLog.js';
import * as trackingTokens from './trackingTokens.js';
import { apiLogger } from '../utils/logger.js';
import { format } from 'date-fns';

const VALID_STATUSES = ['OPEN', 'PLANNED', 'PICKING', 'LOADED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED'];

/**
 * Generate a human-readable run number: RUN-YYYY-MM-DD-NN (NN = zone sort order or seq)
 */
async function generateRunNumber(runDate, zoneId) {
  const dateStr = format(new Date(runDate), 'yyyy-MM-dd');
  const existing = await db.queryOne(
    `SELECT COUNT(*) AS Cnt FROM dbo.DeliveryRuns
     WHERE RunDate = @date`,
    { date: runDate }
  );
  const seq = String((existing?.Cnt || 0) + 1).padStart(2, '0');
  return `RUN-${dateStr}-${seq}`;
}

/**
 * Create a new (empty) delivery run.
 */
export async function createRun({ runDate, zoneId, driverId = null, notes = null, createdBy = null }) {
  const runNumber = await generateRunNumber(runDate, zoneId);

  const run = await db.queryOne(
    `INSERT INTO dbo.DeliveryRuns
       (RunNumber, RunDate, ZoneId, DriverId, Status, Notes, CreatedBy)
     OUTPUT INSERTED.*
     VALUES (@runNumber, @runDate, @zoneId, @driverId, 'OPEN', @notes, @createdBy)`,
    { runNumber, runDate, zoneId, driverId, notes, createdBy }
  );

  apiLogger.info('Delivery run created', { runId: run.RunId, runNumber });
  await logAudit({
    entityType: 'DeliveryRun',
    entityId: run.RunId,
    action: 'CREATE',
    userId: createdBy,
    newValue: { runNumber, runDate, zoneId, driverId },
  });
  return run;
}

/**
 * Auto-plan: take all open orders for a date, unify them by address,
 * group by zone, and create one run per zone. Assigns default drivers.
 *
 * This is the "one-click planner" for the logistics manager.
 */
export async function autoPlanDay({ runDate, createdBy = null }) {
  apiLogger.info('Auto-planning day', { runDate });

  const groups = await unif.unifyOrdersByAddress({
    fromDate: runDate,
    toDate: runDate,
  });

  // Group by zone
  const byZone = new Map(); // zoneId -> [ groups ]
  const unassigned = [];
  for (const g of groups) {
    if (g.zoneId) {
      if (!byZone.has(g.zoneId)) byZone.set(g.zoneId, []);
      byZone.get(g.zoneId).push(g);
    } else {
      unassigned.push(g);
    }
  }

  const createdRuns = [];
  for (const [zoneId, zoneGroups] of byZone) {
    // Find default driver for this zone
    const defaultDriver = await db.queryOne(
      `SELECT TOP 1 dz.DriverId
       FROM dbo.DriverZones dz
       INNER JOIN dbo.Drivers d ON d.DriverId = dz.DriverId
       WHERE dz.ZoneId = @zoneId AND d.IsActive = 1
       ORDER BY dz.Priority`,
      { zoneId }
    );

    const run = await createRun({
      runDate,
      zoneId,
      driverId: defaultDriver?.DriverId || null,
      notes: `Auto-planned - ${zoneGroups.length} stops`,
      createdBy,
    });

    // Add stops
    for (let i = 0; i < zoneGroups.length; i++) {
      const group = zoneGroups[i];
      await addStopToRun(run.RunId, {
        addressId: group.addressId,
        stopOrder: i + 1,
        orders: group.orders,
      });
    }

    createdRuns.push({ run, stopCount: zoneGroups.length });
  }

  apiLogger.info(`Auto-plan done: ${createdRuns.length} runs created`, {
    unassignedGroups: unassigned.length,
  });

  return {
    runsCreated: createdRuns,
    unassignedAddresses: unassigned.length > 0 ? unassigned : null,
  };
}

/**
 * Add a stop with its orders to a run.
 * If stop for this address already exists, merge orders into it.
 */
export async function addStopToRun(runId, { addressId, stopOrder = 0, orders = [] }) {
  return db.transaction(async (tx) => {
    let stop = await tx.queryOne(
      `SELECT StopId, StopOrder FROM dbo.DeliveryStops
       WHERE RunId = @runId AND AddressId = @addressId`,
      { runId, addressId }
    );

    if (!stop) {
      stop = await tx.queryOne(
        `INSERT INTO dbo.DeliveryStops (RunId, AddressId, StopOrder, Status)
         OUTPUT INSERTED.StopId, INSERTED.StopOrder
         VALUES (@runId, @addressId, @stopOrder, 'PENDING')`,
        { runId, addressId, stopOrder }
      );
      // Generate tracking token for this new stop (for customer portal)
      // Note: done outside transaction would be cleaner, but for simplicity we
      // include it here - token table has no dependencies that can conflict.
    }

    for (const order of orders) {
      const companyRow = await tx.queryOne(
        `SELECT CompanyId FROM dbo.Companies WHERE Code = @code`,
        { code: order.companyCode }
      );
      if (!companyRow) continue;

      // IF NOT EXISTS pattern prevents duplicates on re-planning
      await tx.query(
        `IF NOT EXISTS (
           SELECT 1 FROM dbo.RunOrders
           WHERE CompanyId = @companyId AND SapDocEntry = @docEntry
         )
         INSERT INTO dbo.RunOrders
           (StopId, CompanyId, SapDocEntry, SapDocNum, SapCardCode, SapCardName,
            OrderTotal, LinesCount, Status)
         VALUES
           (@stopId, @companyId, @docEntry, @docNum, @cardCode, @cardName,
            @total, @lines, 'PENDING')`,
        {
          stopId: stop.StopId,
          companyId: companyRow.CompanyId,
          docEntry: order.docEntry,
          docNum: order.docNum,
          cardCode: order.cardCode,
          cardName: order.cardName,
          total: order.total || null,
          lines: order.linesCount || null,
        }
      );
    }

    return stop;
  }).then(async (stop) => {
    // Generate tracking token after transaction commits (so stop exists)
    try {
      await trackingTokens.createTokenForStop(stop.StopId);
    } catch (err) {
      apiLogger.warn('Failed to create tracking token', { stopId: stop.StopId, error: err.message });
    }
    return stop;
  });
}

/**
 * Update run status with validation.
 */
export async function updateRunStatus(runId, newStatus) {
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const run = await db.queryOne(
    `SELECT Status FROM dbo.DeliveryRuns WHERE RunId = @runId`,
    { runId }
  );
  if (!run) throw new Error(`Run ${runId} not found`);

  // Timestamp transitions
  const timestampUpdate = {
    IN_TRANSIT: 'ActualStartTime',
    COMPLETED: 'ActualEndTime',
  }[newStatus];

  const timestampSql = timestampUpdate ? `, ${timestampUpdate} = SYSUTCDATETIME()` : '';

  await db.execute(
    `UPDATE dbo.DeliveryRuns
     SET Status = @status, UpdatedAt = SYSUTCDATETIME() ${timestampSql}
     WHERE RunId = @runId`,
    { runId, status: newStatus }
  );

  apiLogger.info('Run status changed', { runId, oldStatus: run.Status, newStatus });
  await logAudit({
    entityType: 'DeliveryRun',
    entityId: runId,
    action: 'STATUS_CHANGE',
    oldValue: { status: run.Status },
    newValue: { status: newStatus },
  });

  // Fire customer notifications when run starts moving
  if (newStatus === 'IN_TRANSIT' && run.Status !== 'IN_TRANSIT') {
    // Fire and forget - don't block the status change
    import('./customerComms.js').then(({ sendRunStartNotifications }) => {
      sendRunStartNotifications(runId).catch((err) =>
        apiLogger.error('Customer notifications failed', { runId, error: err.message })
      );
    });
  }

  return { runId, oldStatus: run.Status, newStatus };
}

/**
 * Get a run with all its stops and orders (full details).
 */
export async function getRunDetails(runId) {
  const run = await db.queryOne(
    `SELECT
       r.*,
       z.Code AS ZoneCode, z.Name AS ZoneName, z.ColorHex AS ZoneColor,
       d.FullName AS DriverName, d.Phone AS DriverPhone, d.VehiclePlate
     FROM dbo.DeliveryRuns r
     LEFT JOIN dbo.Zones z ON z.ZoneId = r.ZoneId
     LEFT JOIN dbo.Drivers d ON d.DriverId = r.DriverId
     WHERE r.RunId = @runId`,
    { runId }
  );

  if (!run) return null;

  const stops = await db.query(
    `SELECT
       s.*,
       a.Street, a.BuildingNumber, a.City, a.BranchName, a.Latitude, a.Longitude,
       a.DeliveryWindowStart, a.DeliveryWindowEnd, a.DeliveryDays,
       a.ContactPhone, a.ContactName, a.DeliveryNotes
     FROM dbo.DeliveryStops s
     INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = s.AddressId
     WHERE s.RunId = @runId
     ORDER BY s.StopOrder`,
    { runId }
  );

  const orders = await db.query(
    `SELECT
       ro.*,
       c.Code AS CompanyCode, c.Name AS CompanyName
     FROM dbo.RunOrders ro
     INNER JOIN dbo.Companies c ON c.CompanyId = ro.CompanyId
     INNER JOIN dbo.DeliveryStops s ON s.StopId = ro.StopId
     WHERE s.RunId = @runId`,
    { runId }
  );

  const returns = await db.query(
    `SELECT rq.*, c.Code AS CompanyCode, c.Name AS CompanyName
     FROM dbo.ReturnRequests rq
     INNER JOIN dbo.Companies c ON c.CompanyId = rq.CompanyId
     INNER JOIN dbo.DeliveryStops s ON s.StopId = rq.StopId
     WHERE s.RunId = @runId`,
    { runId }
  );

  // Attach orders + returns to their stops
  for (const stop of stops) {
    stop.orders = orders.filter((o) => o.StopId === stop.StopId);
    stop.returns = returns.filter((r) => r.StopId === stop.StopId);
  }

  run.stops = stops;
  return run;
}

export async function listRuns({ runDate, zoneId, driverId, status } = {}) {
  const filters = ['1=1'];
  const params = {};
  if (runDate) { filters.push('r.RunDate = @runDate'); params.runDate = runDate; }
  if (zoneId)  { filters.push('r.ZoneId = @zoneId');   params.zoneId = zoneId; }
  if (driverId){ filters.push('r.DriverId = @driverId'); params.driverId = driverId; }
  if (status)  { filters.push('r.Status = @status');   params.status = status; }

  return db.query(
    `SELECT
       r.RunId, r.RunNumber, r.RunDate, r.Status, r.PlannedStartTime,
       r.ActualStartTime, r.ActualEndTime,
       z.Code AS ZoneCode, z.Name AS ZoneName, z.ColorHex AS ZoneColor,
       d.FullName AS DriverName,
       (SELECT COUNT(*) FROM dbo.DeliveryStops WHERE RunId = r.RunId) AS StopCount,
       (SELECT COUNT(*) FROM dbo.RunOrders ro
          INNER JOIN dbo.DeliveryStops s ON s.StopId = ro.StopId
          WHERE s.RunId = r.RunId) AS OrderCount
     FROM dbo.DeliveryRuns r
     LEFT JOIN dbo.Zones z ON z.ZoneId = r.ZoneId
     LEFT JOIN dbo.Drivers d ON d.DriverId = r.DriverId
     WHERE ${filters.join(' AND ')}
     ORDER BY r.RunDate DESC, z.SortOrder`,
    params
  );
}

/**
 * Optimize stop order within a run (simple nearest-neighbor by lat/lon).
 * Can be replaced with a real routing API (Google Directions, OSRM) later.
 */
export async function optimizeStopOrder(runId) {
  const stops = await db.query(
    `SELECT s.StopId, a.Latitude, a.Longitude, s.StopOrder
     FROM dbo.DeliveryStops s
     INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = s.AddressId
     WHERE s.RunId = @runId`,
    { runId }
  );

  // Naive: if no coords, keep existing order.
  if (stops.every((s) => s.Latitude && s.Longitude)) {
    // Nearest-neighbor starting from the main warehouse:
    // הגנן 8, מודיעין מכבים-רעות (Lig'ad industrial zone).
    // Override via env: WAREHOUSE_LAT, WAREHOUSE_LNG.
    const ordered = [];
    let remaining = [...stops];
    let current = {
      Latitude: Number(process.env.WAREHOUSE_LAT) || 31.8952,
      Longitude: Number(process.env.WAREHOUSE_LNG) || 35.0024,
    };

    while (remaining.length > 0) {
      let nearestIdx = 0;
      let nearestDist = distance(current, remaining[0]);
      for (let i = 1; i < remaining.length; i++) {
        const d = distance(current, remaining[i]);
        if (d < nearestDist) {
          nearestDist = d;
          nearestIdx = i;
        }
      }
      const next = remaining.splice(nearestIdx, 1)[0];
      ordered.push(next);
      current = next;
    }

    for (let i = 0; i < ordered.length; i++) {
      await db.execute(
        `UPDATE dbo.DeliveryStops SET StopOrder = @order WHERE StopId = @id`,
        { order: i + 1, id: ordered[i].StopId }
      );
    }
  }

  return getRunDetails(runId);
}

function distance(a, b) {
  // Haversine-lite (good enough for small distances)
  const dx = (a.Longitude - b.Longitude) * Math.cos(((a.Latitude + b.Latitude) / 2) * Math.PI / 180);
  const dy = a.Latitude - b.Latitude;
  return Math.sqrt(dx * dx + dy * dy);
}
