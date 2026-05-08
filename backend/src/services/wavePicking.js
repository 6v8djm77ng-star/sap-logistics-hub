/**
 * Wave Picking Service - unified picking for a delivery run.
 *
 * Traditional SAP picking: pick per sales order (separately for each company).
 * Wave Picking: aggregate all items needed across both companies for one run,
 *               pick them in one warehouse sweep, then allocate to orders.
 *
 * Benefits:
 *   - Warehouse worker walks once per SKU, not once per order
 *   - Same item going to same truck - picked together
 *   - Still maintains per-order accounting via PickingAllocations
 */
import * as db from '../db/logisticsDb.js';
import * as sapSql from './sap/sqlReader.js';
import { format } from 'date-fns';
import { apiLogger } from '../utils/logger.js';

async function generateWaveNumber(runId) {
  const run = await db.queryOne(
    `SELECT RunNumber FROM dbo.DeliveryRuns WHERE RunId = @runId`,
    { runId }
  );
  return `WAVE-${run.RunNumber}`;
}

/**
 * Build a picking wave for a delivery run.
 * Pulls all order lines from both companies, aggregates by ItemCode.
 */
export async function buildWaveForRun(runId) {
  apiLogger.info('Building picking wave', { runId });

  // Get all orders in this run
  const runOrders = await db.query(
    `SELECT ro.RunOrderId, ro.SapDocEntry, c.Code AS CompanyCode
     FROM dbo.RunOrders ro
     INNER JOIN dbo.Companies c ON c.CompanyId = ro.CompanyId
     INNER JOIN dbo.DeliveryStops s ON s.StopId = ro.StopId
     WHERE s.RunId = @runId
       AND ro.Status = 'PENDING'`,
    { runId }
  );

  if (runOrders.length === 0) {
    throw new Error(`No pending orders in run ${runId}`);
  }

  // Fetch all order lines from SAP (both companies)
  const allLines = []; // { runOrderId, companyCode, lineNum, itemCode, itemName, quantity, warehouseCode, binLocation }
  for (const ro of runOrders) {
    const lines = await sapSql.getOrderLines(ro.CompanyCode, ro.SapDocEntry);
    for (const line of lines) {
      allLines.push({
        runOrderId: ro.RunOrderId,
        companyCode: ro.CompanyCode,
        lineNum: line.LineNum,
        itemCode: line.ItemCode,
        itemName: line.ItemName,
        quantity: line.OpenQty,
        warehouseCode: line.WarehouseCode,
        binLocation: line.BinLocation,
      });
    }
  }

  // Aggregate by ItemCode (sum quantities)
  const aggregates = new Map(); // itemCode -> { itemName, totalQty, binLocation, allocations: [] }
  for (const line of allLines) {
    if (!aggregates.has(line.itemCode)) {
      aggregates.set(line.itemCode, {
        itemCode: line.itemCode,
        itemName: line.itemName,
        totalQty: 0,
        binLocation: line.binLocation,
        allocations: [],
      });
    }
    const agg = aggregates.get(line.itemCode);
    agg.totalQty += Number(line.quantity);
    agg.allocations.push({
      runOrderId: line.runOrderId,
      lineNum: line.lineNum,
      quantity: line.quantity,
    });
  }

  // Create wave + wave lines + allocations in one transaction
  return db.transaction(async (tx) => {
    // Cancel any existing wave for this run
    await tx.query(
      `UPDATE dbo.PickingWaves SET Status = 'CANCELLED'
       WHERE RunId = @runId AND Status IN ('PENDING', 'IN_PROGRESS')`,
      { runId }
    );

    const waveNumber = await generateWaveNumber(runId);
    const wave = await tx.queryOne(
      `INSERT INTO dbo.PickingWaves (WaveNumber, RunId, Status)
       OUTPUT INSERTED.*
       VALUES (@number, @runId, 'PENDING')`,
      { number: waveNumber, runId }
    );

    for (const agg of aggregates.values()) {
      const waveLine = await tx.queryOne(
        `INSERT INTO dbo.PickingWaveLines
           (WaveId, SapItemCode, SapItemName, TotalQuantity, BinLocation, Status)
         OUTPUT INSERTED.WaveLineId
         VALUES (@waveId, @code, @name, @qty, @bin, 'PENDING')`,
        {
          waveId: wave.WaveId,
          code: agg.itemCode,
          name: agg.itemName || null,
          qty: agg.totalQty,
          bin: agg.binLocation || null,
        }
      );

      for (const alloc of agg.allocations) {
        await tx.query(
          `INSERT INTO dbo.PickingAllocations
             (WaveLineId, RunOrderId, SapOrderLineNum, Quantity)
           VALUES (@wl, @ro, @ln, @qty)`,
          {
            wl: waveLine.WaveLineId,
            ro: alloc.runOrderId,
            ln: alloc.lineNum,
            qty: alloc.quantity,
          }
        );
      }
    }

    apiLogger.info('Wave created', {
      waveId: wave.WaveId,
      waveNumber,
      itemCount: aggregates.size,
    });
    return wave;
  });
}

/**
 * Record a pick - warehouse worker scanned an item and put it in the cart.
 */
export async function recordPick(waveLineId, pickedQuantity, pickedBy = null) {
  return db.transaction(async (tx) => {
    const line = await tx.queryOne(
      `SELECT * FROM dbo.PickingWaveLines WHERE WaveLineId = @id`,
      { id: waveLineId }
    );
    if (!line) throw new Error(`Wave line ${waveLineId} not found`);

    const newPicked = Number(line.PickedQuantity) + Number(pickedQuantity);
    const newStatus =
      newPicked >= line.TotalQuantity ? 'COMPLETED' :
      newPicked > 0 ? 'PARTIAL' :
      'PENDING';

    await tx.query(
      `UPDATE dbo.PickingWaveLines
       SET PickedQuantity = @picked, Status = @status
       WHERE WaveLineId = @id`,
      { id: waveLineId, picked: newPicked, status: newStatus }
    );

    // Check if whole wave is done
    const pendingLines = await tx.queryOne(
      `SELECT COUNT(*) AS Cnt FROM dbo.PickingWaveLines
       WHERE WaveId = @waveId AND Status NOT IN ('COMPLETED', 'SHORTAGE')`,
      { waveId: line.WaveId }
    );

    if (pendingLines.Cnt === 0) {
      await tx.query(
        `UPDATE dbo.PickingWaves
         SET Status = 'COMPLETED', CompletedAt = SYSUTCDATETIME()
         WHERE WaveId = @id`,
        { id: line.WaveId }
      );
      // Auto-advance the run to LOADED status
      const wave = await tx.queryOne(
        `SELECT RunId FROM dbo.PickingWaves WHERE WaveId = @id`,
        { id: line.WaveId }
      );
      await tx.query(
        `UPDATE dbo.DeliveryRuns SET Status = 'LOADED', UpdatedAt = SYSUTCDATETIME()
         WHERE RunId = @runId AND Status IN ('PICKING', 'PLANNED')`,
        { runId: wave.RunId }
      );
    }

    return { waveLineId, pickedQuantity: newPicked, status: newStatus };
  });
}

export async function getWaveDetails(waveId) {
  const wave = await db.queryOne(
    `SELECT w.*, r.RunNumber, r.RunDate
     FROM dbo.PickingWaves w
     INNER JOIN dbo.DeliveryRuns r ON r.RunId = w.RunId
     WHERE w.WaveId = @waveId`,
    { waveId }
  );
  if (!wave) return null;

  wave.lines = await db.query(
    `SELECT
       l.*,
       (SELECT COUNT(*) FROM dbo.PickingAllocations WHERE WaveLineId = l.WaveLineId) AS AllocationCount
     FROM dbo.PickingWaveLines l
     WHERE l.WaveId = @waveId
     ORDER BY l.BinLocation, l.SapItemCode`,
    { waveId }
  );
  return wave;
}
