/**
 * Delivery Note Service - creates SAP Delivery Notes when driver confirms delivery.
 *
 * The flow:
 *   1. Driver taps "נמסר" on an order in the mobile app
 *   2. We pull the original SAP order lines
 *   3. Create a DeliveryNote in SAP (referencing the original order as BaseEntry)
 *   4. Store the SAP DocEntry back in our RunOrder table
 *
 * Critical: Each order creates ITS OWN Delivery Note in its OWN company.
 * We never cross-book between companies (keeps accounting clean).
 */
import * as db from '../db/logisticsDb.js';
import * as sapSql from './sap/sqlReader.js';
import { getServiceLayer } from './sap/serviceLayer.js';
import { format } from 'date-fns';
import { apiLogger } from '../utils/logger.js';

/**
 * Create a SAP Delivery Note for a single RunOrder.
 * Returns { runOrderId, sapDocEntry, sapDocNum } on success.
 * Throws on failure - caller should catch and keep status as PENDING for retry.
 */
export async function createDeliveryNoteForOrder(runOrderId, { actualQuantities = null } = {}) {
  // 1. Get our run order + SAP context
  const runOrder = await db.queryOne(
    `SELECT ro.*, c.Code AS CompanyCode
     FROM dbo.RunOrders ro
     INNER JOIN dbo.Companies c ON c.CompanyId = ro.CompanyId
     WHERE ro.RunOrderId = @id`,
    { id: runOrderId }
  );

  if (!runOrder) throw new Error(`RunOrder ${runOrderId} not found`);
  if (runOrder.SapDeliveryDocEntry) {
    apiLogger.info('Delivery Note already exists, skipping', {
      runOrderId, docEntry: runOrder.SapDeliveryDocEntry,
    });
    return {
      runOrderId,
      sapDocEntry: runOrder.SapDeliveryDocEntry,
      alreadyExisted: true,
    };
  }

  // 2. Pull original order lines from SAP
  const sapLines = await sapSql.getOrderLines(runOrder.CompanyCode, runOrder.SapDocEntry);
  if (sapLines.length === 0) {
    throw new Error(`No open lines for SAP order ${runOrder.SapDocEntry} in company ${runOrder.CompanyCode}`);
  }

  // 3. Build Delivery Note lines - respect actual quantities if provided
  // (driver may deliver partial quantities on short-supply days)
  const lines = sapLines.map((line) => {
    const actual = actualQuantities?.find((a) => a.lineNum === line.LineNum);
    const qty = actual?.quantity != null ? actual.quantity : line.OpenQty;
    return {
      itemCode: line.ItemCode,
      quantity: qty,
      warehouseCode: line.WarehouseCode || '01',
      baseLine: line.LineNum,
    };
  }).filter((l) => Number(l.quantity) > 0);

  if (lines.length === 0) {
    throw new Error('All line quantities are zero - nothing to deliver');
  }

  // 4. Call SAP Service Layer
  const sl = getServiceLayer(runOrder.CompanyCode);
  const sapDoc = await sl.createDeliveryNote({
    cardCode: runOrder.SapCardCode,
    docDate: format(new Date(), 'yyyy-MM-dd'),
    baseOrderEntry: runOrder.SapDocEntry,
    lines,
    comments: `Logistics Hub - Order #${runOrder.SapDocNum}`,
  });

  apiLogger.info('SAP Delivery Note created', {
    runOrderId,
    company: runOrder.CompanyCode,
    sapDocEntry: sapDoc.DocEntry,
    sapDocNum: sapDoc.DocNum,
  });

  // 5. Update our state
  await db.execute(
    `UPDATE dbo.RunOrders
     SET Status = 'DELIVERED',
         SapDeliveryDocEntry = @docEntry
     WHERE RunOrderId = @id`,
    { id: runOrderId, docEntry: sapDoc.DocEntry }
  );

  return {
    runOrderId,
    sapDocEntry: sapDoc.DocEntry,
    sapDocNum: sapDoc.DocNum,
    alreadyExisted: false,
  };
}

/**
 * Create Delivery Notes for all orders at a stop.
 * Atomic-ish: if one order fails, the others still succeed (tracked per-row).
 */
export async function deliverStop(stopId, { signatureUrl, photoUrl, notes } = {}) {
  const orders = await db.query(
    `SELECT RunOrderId FROM dbo.RunOrders
     WHERE StopId = @stopId AND Status = 'PENDING'`,
    { stopId }
  );

  const results = [];
  for (const order of orders) {
    try {
      const result = await createDeliveryNoteForOrder(order.RunOrderId);
      results.push({ runOrderId: order.RunOrderId, success: true, ...result });
    } catch (err) {
      apiLogger.error('Delivery Note failed - will retry later', {
        runOrderId: order.RunOrderId, error: err.message,
      });
      results.push({ runOrderId: order.RunOrderId, success: false, error: err.message });
    }
  }

  // Mark stop complete
  const allSuccess = results.every((r) => r.success);
  const anySuccess = results.some((r) => r.success);
  const stopStatus = allSuccess ? 'DELIVERED' : anySuccess ? 'PARTIAL' : 'FAILED';

  await db.execute(
    `UPDATE dbo.DeliveryStops
     SET Status = @status,
         CompletedAt = SYSUTCDATETIME(),
         SignatureUrl = COALESCE(@sig, SignatureUrl),
         PhotoUrl = COALESCE(@photo, PhotoUrl),
         Notes = COALESCE(@notes, Notes)
     WHERE StopId = @stopId`,
    {
      status: stopStatus,
      sig: signatureUrl || null,
      photo: photoUrl || null,
      notes: notes || null,
      stopId,
    }
  );

  // Send Proof of Delivery email (fire and forget)
  if (stopStatus === 'DELIVERED' || stopStatus === 'PARTIAL') {
    import('./customerComms.js').then(({ sendProofOfDeliveryEmail }) => {
      sendProofOfDeliveryEmail(stopId).catch((err) =>
        apiLogger.warn('PoD email failed', { stopId, error: err.message })
      );
    });
  }

  return { stopId, stopStatus, orders: results };
}

/**
 * Retry failed Delivery Notes (run by background job or manual trigger).
 * Finds orders marked as delivered in our DB but with no SAP DocEntry.
 */
export async function retryFailedDeliveryNotes() {
  const pending = await db.query(
    `SELECT ro.RunOrderId
     FROM dbo.RunOrders ro
     INNER JOIN dbo.DeliveryStops s ON s.StopId = ro.StopId
     WHERE ro.Status = 'DELIVERED'
       AND ro.SapDeliveryDocEntry IS NULL
       AND s.CompletedAt > DATEADD(HOUR, -24, SYSUTCDATETIME())`
  );

  const results = [];
  for (const order of pending) {
    try {
      const result = await createDeliveryNoteForOrder(order.RunOrderId);
      results.push({ ...result, success: true });
    } catch (err) {
      results.push({ runOrderId: order.RunOrderId, success: false, error: err.message });
    }
  }

  apiLogger.info('Delivery Note retry batch complete', {
    total: pending.length,
    success: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
  });

  return results;
}
