/**
 * Returns Service (Reverse Logistics).
 *
 * Customer-initiated returns: they call/email us saying "pick up damaged goods".
 * We:
 *   1. Create a Return Request record in our DB (not yet in SAP)
 *   2. Assign it to an existing Delivery Stop OR create a new stop at that address
 *   3. Driver sees it on their manifest alongside deliveries
 *   4. After pickup, we create a SAP Return Request + Return documents
 */
import * as db from '../db/logisticsDb.js';
import { getServiceLayer } from './sap/serviceLayer.js';
import { format } from 'date-fns';
import { apiLogger } from '../utils/logger.js';

async function generateReturnNumber() {
  const dateStr = format(new Date(), 'yyyy-MM-dd');
  const existing = await db.queryOne(
    `SELECT COUNT(*) AS Cnt FROM dbo.ReturnRequests
     WHERE CAST(CreatedAt AS DATE) = CAST(GETDATE() AS DATE)`
  );
  const seq = String((existing?.Cnt || 0) + 1).padStart(3, '0');
  return `RET-${dateStr}-${seq}`;
}

/**
 * Create a new customer return request.
 */
export async function createReturnRequest({
  companyCode,
  cardCode,
  cardName,
  addressId,
  requestedDate,
  reason,
  lines, // [{ itemCode, itemName, quantity, reasonCode, reasonText }]
  notes,
}) {
  return db.transaction(async (tx) => {
    const company = await tx.queryOne(
      `SELECT CompanyId FROM dbo.Companies WHERE Code = @code`,
      { code: companyCode }
    );
    if (!company) throw new Error(`Unknown company: ${companyCode}`);

    const returnNumber = await generateReturnNumber();

    const ret = await tx.queryOne(
      `INSERT INTO dbo.ReturnRequests
         (ReturnNumber, CompanyId, SapCardCode, SapCardName, AddressId,
          RequestedDate, Reason, Status, Notes)
       OUTPUT INSERTED.*
       VALUES (@num, @companyId, @cardCode, @cardName, @addressId,
               @reqDate, @reason, 'OPEN', @notes)`,
      {
        num: returnNumber,
        companyId: company.CompanyId,
        cardCode,
        cardName: cardName || null,
        addressId,
        reqDate: requestedDate,
        reason: reason || null,
        notes: notes || null,
      }
    );

    for (const line of lines) {
      await tx.query(
        `INSERT INTO dbo.ReturnRequestLines
           (ReturnId, SapItemCode, SapItemName, Quantity, ReasonCode, ReasonText)
         VALUES (@rid, @code, @name, @qty, @rcode, @rtext)`,
        {
          rid: ret.ReturnId,
          code: line.itemCode,
          name: line.itemName || null,
          qty: line.quantity,
          rcode: line.reasonCode || null,
          rtext: line.reasonText || null,
        }
      );
    }

    apiLogger.info('Return request created', { returnId: ret.ReturnId, returnNumber });
    return ret;
  });
}

/**
 * Attach a return to a delivery run.
 * If a stop exists at the return's address, use it. Otherwise create a new stop.
 */
export async function assignReturnToRun(returnId, runId) {
  return db.transaction(async (tx) => {
    const ret = await tx.queryOne(
      `SELECT * FROM dbo.ReturnRequests WHERE ReturnId = @id`,
      { id: returnId }
    );
    if (!ret) throw new Error(`Return ${returnId} not found`);

    let stop = await tx.queryOne(
      `SELECT StopId FROM dbo.DeliveryStops
       WHERE RunId = @runId AND AddressId = @addressId`,
      { runId, addressId: ret.AddressId }
    );

    if (!stop) {
      // Create new stop at the end of the run
      const maxStop = await tx.queryOne(
        `SELECT ISNULL(MAX(StopOrder), 0) AS Max FROM dbo.DeliveryStops WHERE RunId = @runId`,
        { runId }
      );
      stop = await tx.queryOne(
        `INSERT INTO dbo.DeliveryStops (RunId, AddressId, StopOrder, Status)
         OUTPUT INSERTED.StopId
         VALUES (@runId, @addressId, @order, 'PENDING')`,
        { runId, addressId: ret.AddressId, order: (maxStop.Max || 0) + 1 }
      );
    }

    await tx.query(
      `UPDATE dbo.ReturnRequests
       SET StopId = @stopId, Status = 'ASSIGNED', UpdatedAt = SYSUTCDATETIME()
       WHERE ReturnId = @id`,
      { id: returnId, stopId: stop.StopId }
    );

    apiLogger.info('Return assigned to run', { returnId, runId, stopId: stop.StopId });
    return { returnId, runId, stopId: stop.StopId };
  });
}

/**
 * Mark a return as picked up (driver reports from mobile).
 * Creates the SAP Return Request document.
 */
export async function markReturnPickedUp(returnId, { actualLines = [] }) {
  const ret = await db.queryOne(
    `SELECT r.*, c.Code AS CompanyCode
     FROM dbo.ReturnRequests r
     INNER JOIN dbo.Companies c ON c.CompanyId = r.CompanyId
     WHERE r.ReturnId = @id`,
    { id: returnId }
  );
  if (!ret) throw new Error(`Return ${returnId} not found`);

  const lines = await db.query(
    `SELECT * FROM dbo.ReturnRequestLines WHERE ReturnId = @id`,
    { id: returnId }
  );

  // Update actual quantities from driver input
  for (const actual of actualLines) {
    await db.execute(
      `UPDATE dbo.ReturnRequestLines
       SET ActualQuantity = @qty
       WHERE ReturnLineId = @id`,
      { id: actual.returnLineId, qty: actual.actualQuantity }
    );
  }

  // Create SAP Return Request document
  const sapLines = lines.map((l) => {
    const actual = actualLines.find((a) => a.returnLineId === l.ReturnLineId);
    const qty = actual ? actual.actualQuantity : l.Quantity;
    return {
      itemCode: l.SapItemCode,
      quantity: qty,
      warehouseCode: '01', // TODO: map from zone/product
    };
  }).filter((l) => Number(l.quantity) > 0);

  let sapDocEntry = null;
  try {
    const sl = getServiceLayer(ret.CompanyCode);
    const sapDoc = await sl.createReturnRequest({
      cardCode: ret.SapCardCode,
      docDate: format(new Date(), 'yyyy-MM-dd'),
      lines: sapLines,
      comments: `Return pickup from Logistics Hub - ${ret.ReturnNumber}`,
    });
    sapDocEntry = sapDoc.DocEntry;
  } catch (err) {
    apiLogger.error('Failed to create SAP Return Request - will retry', {
      returnId, error: err.message,
    });
    // Continue - keep local state as picked up, retry SAP sync later
  }

  await db.execute(
    `UPDATE dbo.ReturnRequests
     SET Status = 'PICKED_UP',
         SapReturnRequestDocEntry = @docEntry,
         UpdatedAt = SYSUTCDATETIME()
     WHERE ReturnId = @id`,
    { id: returnId, docEntry: sapDocEntry }
  );

  return { returnId, sapDocEntry };
}

export async function listPendingReturns({ companyCode, runId } = {}) {
  const filters = [`r.Status IN ('OPEN', 'ASSIGNED')`];
  const params = {};
  if (companyCode) {
    filters.push('c.Code = @companyCode');
    params.companyCode = companyCode;
  }
  if (runId) {
    filters.push('s.RunId = @runId');
    params.runId = runId;
  }

  return db.query(
    `SELECT r.*, c.Code AS CompanyCode, c.Name AS CompanyName,
            a.Street, a.BuildingNumber, a.City, a.BranchName,
            (SELECT COUNT(*) FROM dbo.ReturnRequestLines WHERE ReturnId = r.ReturnId) AS LinesCount
     FROM dbo.ReturnRequests r
     INNER JOIN dbo.Companies c ON c.CompanyId = r.CompanyId
     INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = r.AddressId
     LEFT JOIN dbo.DeliveryStops s ON s.StopId = r.StopId
     WHERE ${filters.join(' AND ')}
     ORDER BY r.RequestedDate, r.CreatedAt`,
    params
  );
}

export async function getReturnDetails(returnId) {
  const ret = await db.queryOne(
    `SELECT r.*, c.Code AS CompanyCode, c.Name AS CompanyName,
            a.Street, a.BuildingNumber, a.City, a.BranchName
     FROM dbo.ReturnRequests r
     INNER JOIN dbo.Companies c ON c.CompanyId = r.CompanyId
     INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = r.AddressId
     WHERE r.ReturnId = @id`,
    { id: returnId }
  );
  if (!ret) return null;

  ret.lines = await db.query(
    `SELECT * FROM dbo.ReturnRequestLines WHERE ReturnId = @id ORDER BY ReturnLineId`,
    { id: returnId }
  );
  return ret;
}
