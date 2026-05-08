/**
 * Background worker - keeps SAP in sync when operations fail temporarily.
 *
 * Runs every 30 seconds inside the main Node process (no separate daemon).
 * Handles:
 *   1. Failed Delivery Notes - orders marked DELIVERED but no SAP DocEntry
 *   2. Failed Return Requests - returns marked PICKED_UP but no SAP DocEntry
 *   3. SapRetryQueue entries - explicit retry jobs
 *
 * Exponential backoff: 1m → 5m → 15m → 1h → 4h (then marked FAILED_PERMANENT).
 */
import * as db from '../db/logisticsDb.js';
import * as deliveryNotes from '../services/deliveryNotes.js';
import { getServiceLayer } from '../services/sap/serviceLayer.js';
import { apiLogger, sapLogger } from '../utils/logger.js';
import { format } from 'date-fns';

const BACKOFF_MINUTES = [1, 5, 15, 60, 240]; // try 5 times total
const RUN_INTERVAL_MS = 30_000; // every 30s

let running = false;
let timer = null;

function nextAttemptTime(attemptCount) {
  const mins = BACKOFF_MINUTES[Math.min(attemptCount, BACKOFF_MINUTES.length - 1)];
  return new Date(Date.now() + mins * 60_000);
}

/**
 * Find orders that are delivered in our DB but failed to create a SAP Delivery Note.
 * Retry each one.
 */
async function retryDeliveryNotes() {
  const pending = await db.query(
    `SELECT TOP 20 ro.RunOrderId, c.Code AS CompanyCode
     FROM dbo.RunOrders ro
     INNER JOIN dbo.Companies c ON c.CompanyId = ro.CompanyId
     INNER JOIN dbo.DeliveryStops s ON s.StopId = ro.StopId
     WHERE ro.Status = 'DELIVERED'
       AND ro.SapDeliveryDocEntry IS NULL
       AND s.CompletedAt > DATEADD(HOUR, -24, SYSUTCDATETIME())`
  );

  if (pending.length === 0) return { processed: 0 };

  apiLogger.info(`[worker] Retrying ${pending.length} failed Delivery Notes`);

  let ok = 0, failed = 0;
  for (const p of pending) {
    try {
      await deliveryNotes.createDeliveryNoteForOrder(p.RunOrderId);
      ok++;
    } catch (err) {
      failed++;
      apiLogger.warn('[worker] Delivery Note still failing', {
        runOrderId: p.RunOrderId, error: err.message,
      });
      // Log to retry queue for permanent tracking after 24h
      await enqueue({
        operation: 'CREATE_DELIVERY',
        entityType: 'RunOrder',
        entityId: p.RunOrderId,
        companyCode: p.CompanyCode,
        lastError: err.message,
      });
    }
  }
  return { processed: pending.length, ok, failed };
}

/**
 * Find returns that were picked up but failed to create SAP Return Request.
 */
async function retryReturnRequests() {
  const pending = await db.query(
    `SELECT TOP 20 r.ReturnId, c.Code AS CompanyCode
     FROM dbo.ReturnRequests r
     INNER JOIN dbo.Companies c ON c.CompanyId = r.CompanyId
     WHERE r.Status = 'PICKED_UP'
       AND r.SapReturnRequestDocEntry IS NULL
       AND r.UpdatedAt > DATEADD(HOUR, -24, SYSUTCDATETIME())`
  );

  if (pending.length === 0) return { processed: 0 };

  apiLogger.info(`[worker] Retrying ${pending.length} failed Return Requests`);

  let ok = 0, failed = 0;
  for (const p of pending) {
    try {
      // Load lines + rebuild payload
      const lines = await db.query(
        `SELECT SapItemCode, COALESCE(ActualQuantity, Quantity) AS Quantity
         FROM dbo.ReturnRequestLines WHERE ReturnId = @id`,
        { id: p.ReturnId }
      );
      const ret = await db.queryOne(
        `SELECT ReturnNumber, SapCardCode FROM dbo.ReturnRequests WHERE ReturnId = @id`,
        { id: p.ReturnId }
      );

      const sl = getServiceLayer(p.CompanyCode);
      const sapDoc = await sl.createReturnRequest({
        cardCode: ret.SapCardCode,
        docDate: format(new Date(), 'yyyy-MM-dd'),
        lines: lines.map((l) => ({
          itemCode: l.SapItemCode,
          quantity: l.Quantity,
          warehouseCode: '01',
        })),
        comments: `Retry from Logistics Hub - ${ret.ReturnNumber}`,
      });

      await db.execute(
        `UPDATE dbo.ReturnRequests
         SET SapReturnRequestDocEntry = @docEntry, UpdatedAt = SYSUTCDATETIME()
         WHERE ReturnId = @id`,
        { id: p.ReturnId, docEntry: sapDoc.DocEntry }
      );
      ok++;
    } catch (err) {
      failed++;
      apiLogger.warn('[worker] Return Request still failing', {
        returnId: p.ReturnId, error: err.message,
      });
    }
  }
  return { processed: pending.length, ok, failed };
}

/**
 * Process the explicit retry queue (for ops that need tracking beyond 24h).
 */
async function processRetryQueue() {
  const jobs = await db.query(
    `SELECT TOP 10 * FROM dbo.SapRetryQueue
     WHERE Status = 'PENDING'
       AND NextAttemptAt <= SYSUTCDATETIME()
     ORDER BY NextAttemptAt`
  );

  if (jobs.length === 0) return { processed: 0 };

  for (const job of jobs) {
    const nextAttempt = nextAttemptTime(job.AttemptCount);
    const isLastAttempt = job.AttemptCount >= BACKOFF_MINUTES.length - 1;

    try {
      if (job.Operation === 'CREATE_DELIVERY') {
        await deliveryNotes.createDeliveryNoteForOrder(job.EntityId);
      }
      // Other operations can be added here

      await db.execute(
        `UPDATE dbo.SapRetryQueue
         SET Status = 'SUCCESS', LastAttemptAt = SYSUTCDATETIME()
         WHERE QueueId = @id`,
        { id: job.QueueId }
      );
    } catch (err) {
      await db.execute(
        `UPDATE dbo.SapRetryQueue
         SET AttemptCount = AttemptCount + 1,
             LastAttemptAt = SYSUTCDATETIME(),
             NextAttemptAt = @next,
             LastError = @err,
             Status = CASE WHEN @last = 1 THEN 'FAILED_PERMANENT' ELSE 'PENDING' END
         WHERE QueueId = @id`,
        {
          id: job.QueueId,
          next: nextAttempt,
          err: err.message.slice(0, 1000),
          last: isLastAttempt ? 1 : 0,
        }
      );
    }
  }

  return { processed: jobs.length };
}

/**
 * Enqueue a retry job (called from service layer error handlers).
 */
async function enqueue({ operation, entityType, entityId, companyCode, lastError = null }) {
  await db.execute(
    `IF NOT EXISTS (
       SELECT 1 FROM dbo.SapRetryQueue
       WHERE Operation = @op AND EntityType = @type AND EntityId = @id
         AND Status = 'PENDING'
     )
     INSERT INTO dbo.SapRetryQueue
       (Operation, EntityType, EntityId, CompanyCode, LastError, NextAttemptAt)
     VALUES (@op, @type, @id, @company, @err, DATEADD(MINUTE, 1, SYSUTCDATETIME()))`,
    { op: operation, type: entityType, id: entityId, company: companyCode, err: lastError }
  );
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await Promise.all([
      retryDeliveryNotes(),
      retryReturnRequests(),
      processRetryQueue(),
    ]);
  } catch (err) {
    apiLogger.error('[worker] tick failed', { error: err.message });
  } finally {
    running = false;
  }
}

export function startWorker() {
  if (timer) return;
  apiLogger.info('[worker] SAP sync worker starting');
  timer = setInterval(tick, RUN_INTERVAL_MS);
  // Run immediately on boot
  setTimeout(tick, 5000);
}

export function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    apiLogger.info('[worker] SAP sync worker stopped');
  }
}

export { enqueue };
