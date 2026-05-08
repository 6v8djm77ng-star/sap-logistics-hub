/**
 * Stop Failure Management.
 *
 * Workflow:
 *   1. Driver marks a stop as FAILED with a structured reason
 *   2. StopFailure record created + linked to stop
 *   3. Real-time socket event → planner dashboard
 *   4. Email/SMS alert to subscribers (immediate for HIGH severity)
 *   5. Appears in "Failure Inbox" UI
 *   6. Planner takes action: reschedule / contact customer / cancel
 *   7. On resolution - StopFailure.ResolutionStatus updated, appears in daily digest
 */
import * as db from '../db/logisticsDb.js';
import { saveDataUrl } from './fileStorage.js';
import * as notifications from './notifications.js';
import { logAudit } from './auditLog.js';
import { apiLogger } from '../utils/logger.js';

export async function listReasons() {
  return db.query(
    `SELECT * FROM dbo.FailureReasons WHERE IsActive = 1 ORDER BY SortOrder`
  );
}

export async function getReason(reasonCode) {
  return db.queryOne(
    `SELECT * FROM dbo.FailureReasons WHERE ReasonCode = @code`,
    { code: reasonCode }
  );
}

/**
 * Report a stop failure.
 * Called from the driver mobile app when they can't deliver.
 */
export async function reportFailure({
  stopId,
  reasonCode,
  notes = null,
  photoDataUrl = null,
  driverId = null,
}) {
  const reason = await getReason(reasonCode);
  if (!reason) throw new Error(`Invalid failure reason: ${reasonCode}`);

  // Validate required fields per reason config
  if (reason.RequiresNotes && !notes) {
    throw new Error(`סיבה "${reason.Name}" דורשת תיאור`);
  }
  if (reason.RequiresPhoto && !photoDataUrl) {
    throw new Error(`סיבה "${reason.Name}" דורשת תמונה`);
  }

  // Save photo if provided
  const photoUrl = photoDataUrl
    ? await saveDataUrl(photoDataUrl, { prefix: `fail-${stopId}`, category: 'failures' })
    : null;

  // Transaction: create failure + mark stop as FAILED
  return db.transaction(async (tx) => {
    const failure = await tx.queryOne(
      `INSERT INTO dbo.StopFailures
         (StopId, ReasonCode, Notes, PhotoUrl, ReportedByDriverId, ResolutionStatus)
       OUTPUT INSERTED.*
       VALUES (@stopId, @reasonCode, @notes, @photoUrl, @driverId, 'OPEN')`,
      { stopId, reasonCode, notes, photoUrl, driverId }
    );

    await tx.query(
      `UPDATE dbo.DeliveryStops
       SET Status = 'FAILED',
           CompletedAt = SYSUTCDATETIME(),
           Notes = COALESCE(@notes, Notes),
           PhotoUrl = COALESCE(@photoUrl, PhotoUrl)
       WHERE StopId = @stopId`,
      { stopId, notes, photoUrl }
    );

    // Orders at this stop are marked PENDING (they'll need rescheduling)
    await tx.query(
      `UPDATE dbo.RunOrders
       SET Status = 'PENDING'
       WHERE StopId = @stopId AND Status NOT IN ('DELIVERED', 'CANCELLED')`,
      { stopId }
    );

    return { failure, reason };
  }).then(async ({ failure, reason }) => {
    // Fire alerts AFTER transaction commits
    await sendFailureAlerts(failure.FailureId, reason);

    await logAudit({
      entityType: 'StopFailure',
      entityId: failure.FailureId,
      action: 'CREATE',
      userId: null,
      newValue: { stopId, reasonCode, notes: notes?.slice(0, 200) },
    });

    apiLogger.info('Stop failure reported', {
      failureId: failure.FailureId,
      stopId,
      reasonCode,
      severity: reason.Severity,
    });

    return failure;
  });
}

/**
 * Send alerts based on failure severity.
 * HIGH: immediate email + SMS + socket
 * MEDIUM: email + socket
 * LOW: socket only (shows in dashboard)
 */
async function sendFailureAlerts(failureId, reason) {
  const context = await db.queryOne(
    `SELECT
       sf.FailureId, sf.Notes, sf.PhotoUrl, sf.CreatedAt,
       fr.Name AS ReasonName, fr.Category, fr.Severity,
       s.StopId,
       r.RunId, r.RunNumber,
       d.FullName AS DriverName, d.Phone AS DriverPhone,
       z.Name AS ZoneName,
       a.Street, a.BuildingNumber, a.City, a.BranchName,
       (SELECT STRING_AGG(CONCAT('#', ro.SapDocNum), ', ')
        FROM dbo.RunOrders ro WHERE ro.StopId = s.StopId) AS OrderNumbers,
       (SELECT TOP 1 ro.SapCardName
        FROM dbo.RunOrders ro WHERE ro.StopId = s.StopId) AS CustomerName
     FROM dbo.StopFailures sf
     INNER JOIN dbo.FailureReasons fr ON fr.ReasonCode = sf.ReasonCode
     INNER JOIN dbo.DeliveryStops s ON s.StopId = sf.StopId
     INNER JOIN dbo.DeliveryRuns r ON r.RunId = s.RunId
     INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = s.AddressId
     LEFT JOIN dbo.Drivers d ON d.DriverId = r.DriverId
     LEFT JOIN dbo.Zones z ON z.ZoneId = r.ZoneId
     WHERE sf.FailureId = @id`,
    { id: failureId }
  );

  if (!context) return;

  const urgencyPrefix = reason.Severity === 'HIGH' ? '🚨 ' : '⚠️ ';
  const subject = `${urgencyPrefix}כשל במסירה: ${context.CustomerName || 'לקוח'} - ${context.ReasonName}`;
  const eventType = reason.Severity === 'HIGH' ? 'STOP_FAILED_HIGH' : 'STOP_FAILED';

  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px;">
      <div style="background: ${reason.Severity === 'HIGH' ? '#dc2626' : '#f59e0b'}; color: white; padding: 16px; border-radius: 8px 8px 0 0;">
        <h2 style="margin:0;">${urgencyPrefix}כשל במסירה</h2>
        <p style="margin: 4px 0 0; opacity: 0.9;">דרגה: ${reason.Severity === 'HIGH' ? 'קריטי' : reason.Severity === 'MEDIUM' ? 'בינוני' : 'נמוך'}</p>
      </div>
      <div style="background: #fff; padding: 16px; border: 1px solid #e5e7eb; border-top: none;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 4px 0; color: #6b7280;">לקוח:</td><td style="padding: 4px 0;"><strong>${context.CustomerName || '—'}</strong></td></tr>
          <tr><td style="padding: 4px 0; color: #6b7280;">כתובת:</td><td style="padding: 4px 0;">${context.Street || ''} ${context.BuildingNumber || ''}, ${context.City || ''}</td></tr>
          ${context.BranchName ? `<tr><td style="padding: 4px 0; color: #6b7280;">סניף:</td><td style="padding: 4px 0;">${context.BranchName}</td></tr>` : ''}
          <tr><td style="padding: 4px 0; color: #6b7280;">סיבה:</td><td style="padding: 4px 0;"><strong>${context.ReasonName}</strong></td></tr>
          ${context.Notes ? `<tr><td style="padding: 4px 0; color: #6b7280; vertical-align: top;">פירוט:</td><td style="padding: 4px 0;">${context.Notes}</td></tr>` : ''}
          <tr><td style="padding: 4px 0; color: #6b7280;">הזמנות:</td><td style="padding: 4px 0;">${context.OrderNumbers || '—'}</td></tr>
          <tr><td style="padding: 4px 0; color: #6b7280;">נהג:</td><td style="padding: 4px 0;">${context.DriverName || '—'}${context.DriverPhone ? ` (${context.DriverPhone})` : ''}</td></tr>
          <tr><td style="padding: 4px 0; color: #6b7280;">מסלול:</td><td style="padding: 4px 0;">${context.RunNumber} - ${context.ZoneName}</td></tr>
        </table>
        ${context.PhotoUrl ? `<div style="margin-top: 12px;"><img src="${context.PhotoUrl}" style="max-width: 100%; border-radius: 8px;" /></div>` : ''}
        <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
          <p style="margin: 0; color: #6b7280; font-size: 13px;">
            יש לטפל בכשל: <a href="http://localhost:5173/failures/${failureId}" style="color: #2563eb;">פתח בלוחם הבקרה →</a>
          </p>
        </div>
      </div>
    </div>
  `;

  const text = `כשל במסירה\n\nלקוח: ${context.CustomerName}\nכתובת: ${context.Street} ${context.BuildingNumber}, ${context.City}\nסיבה: ${context.ReasonName}\n${context.Notes ? 'פירוט: ' + context.Notes + '\n' : ''}הזמנות: ${context.OrderNumbers}\nנהג: ${context.DriverName}`;

  const smsMessage = `${urgencyPrefix}כשל: ${context.CustomerName || ''} - ${context.ReasonName}. ${context.Street || ''} ${context.BuildingNumber || ''}, ${context.City || ''}. ${context.OrderNumbers || ''}`;

  await notifications.notifyEvent(eventType, {
    subject, html, text, smsMessage,
    entity: { type: 'StopFailure', id: failureId },
  });
}

/**
 * List open failures (failure inbox).
 */
export async function listOpenFailures({ includeResolved = false } = {}) {
  const statusFilter = includeResolved
    ? ''
    : `AND sf.ResolutionStatus = 'OPEN'`;

  return db.query(
    `SELECT
       sf.FailureId, sf.StopId, sf.Notes, sf.PhotoUrl, sf.CreatedAt,
       sf.ResolutionStatus, sf.ResolvedAt, sf.RescheduledToRunId,
       fr.ReasonCode, fr.Name AS ReasonName, fr.Category, fr.Severity,
       fr.SuggestedAction,
       r.RunId, r.RunNumber, r.RunDate,
       d.FullName AS DriverName,
       z.Name AS ZoneName, z.ColorHex AS ZoneColor,
       a.Street, a.BuildingNumber, a.City, a.BranchName,
       a.AddressId,
       (SELECT TOP 1 ro.SapCardName FROM dbo.RunOrders ro WHERE ro.StopId = s.StopId) AS CustomerName,
       (SELECT TOP 1 ro.SapCardCode FROM dbo.RunOrders ro WHERE ro.StopId = s.StopId) AS CardCode,
       (SELECT TOP 1 c.Code FROM dbo.RunOrders ro
         INNER JOIN dbo.Companies c ON c.CompanyId = ro.CompanyId
         WHERE ro.StopId = s.StopId) AS CompanyCode,
       (SELECT COUNT(*) FROM dbo.RunOrders ro WHERE ro.StopId = s.StopId) AS OrdersCount
     FROM dbo.StopFailures sf
     INNER JOIN dbo.FailureReasons fr ON fr.ReasonCode = sf.ReasonCode
     INNER JOIN dbo.DeliveryStops s ON s.StopId = sf.StopId
     INNER JOIN dbo.DeliveryRuns r ON r.RunId = s.RunId
     INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = s.AddressId
     LEFT JOIN dbo.Drivers d ON d.DriverId = r.DriverId
     LEFT JOIN dbo.Zones z ON z.ZoneId = r.ZoneId
     WHERE 1=1 ${statusFilter}
     ORDER BY
       CASE fr.Severity WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
       sf.CreatedAt DESC`
  );
}

/**
 * Reschedule a failed stop to a new run.
 * Creates orders + stop in the target run, moves everything over.
 */
export async function rescheduleFailure(failureId, { targetRunId, notes = null, userId = null }) {
  return db.transaction(async (tx) => {
    const failure = await tx.queryOne(
      `SELECT sf.*, s.AddressId
       FROM dbo.StopFailures sf
       INNER JOIN dbo.DeliveryStops s ON s.StopId = sf.StopId
       WHERE sf.FailureId = @id`,
      { id: failureId }
    );
    if (!failure) throw new Error(`Failure ${failureId} not found`);
    if (failure.ResolutionStatus !== 'OPEN') {
      throw new Error(`Failure already resolved as ${failure.ResolutionStatus}`);
    }

    // Validate target run exists + is not started
    const targetRun = await tx.queryOne(
      `SELECT RunId, Status FROM dbo.DeliveryRuns WHERE RunId = @id`,
      { id: targetRunId }
    );
    if (!targetRun) throw new Error('Target run not found');
    if (['COMPLETED', 'CANCELLED'].includes(targetRun.Status)) {
      throw new Error(`Cannot reschedule to ${targetRun.Status} run`);
    }

    // Does target run already have a stop at this address?
    let newStop = await tx.queryOne(
      `SELECT StopId FROM dbo.DeliveryStops
       WHERE RunId = @runId AND AddressId = @addressId`,
      { runId: targetRunId, addressId: failure.AddressId }
    );

    if (!newStop) {
      const maxOrder = await tx.queryOne(
        `SELECT ISNULL(MAX(StopOrder), 0) AS Max FROM dbo.DeliveryStops WHERE RunId = @runId`,
        { runId: targetRunId }
      );
      newStop = await tx.queryOne(
        `INSERT INTO dbo.DeliveryStops (RunId, AddressId, StopOrder, Status, Notes)
         OUTPUT INSERTED.StopId
         VALUES (@runId, @addressId, @order, 'PENDING', @notes)`,
        {
          runId: targetRunId,
          addressId: failure.AddressId,
          order: (maxOrder.Max || 0) + 1,
          notes: `נקבע מחדש מכשל #${failureId}`,
        }
      );
    }

    // Move pending orders from failed stop to new stop
    await tx.query(
      `UPDATE dbo.RunOrders
       SET StopId = @newStopId
       WHERE StopId = @oldStopId
         AND Status NOT IN ('DELIVERED', 'CANCELLED')`,
      { oldStopId: failure.StopId, newStopId: newStop.StopId }
    );

    // Mark failure as rescheduled
    await tx.query(
      `UPDATE dbo.StopFailures
       SET ResolutionStatus = 'RESCHEDULED',
           ResolvedAt = SYSUTCDATETIME(),
           ResolvedByUserId = @userId,
           RescheduledToRunId = @runId,
           ResolutionNotes = @notes
       WHERE FailureId = @id`,
      { id: failureId, userId, runId: targetRunId, notes }
    );

    return { failureId, newStopId: newStop.StopId, targetRunId };
  });
}

/**
 * Resolve a failure without rescheduling (e.g. customer cancelled).
 */
export async function resolveFailure(failureId, { status, notes, userId }) {
  if (!['RESOLVED', 'CANCELLED'].includes(status)) {
    throw new Error(`Invalid resolution status: ${status}`);
  }

  await db.execute(
    `UPDATE dbo.StopFailures
     SET ResolutionStatus = @status,
         ResolvedAt = SYSUTCDATETIME(),
         ResolvedByUserId = @userId,
         ResolutionNotes = @notes
     WHERE FailureId = @id`,
    { id: failureId, status, userId, notes }
  );

  // If CANCELLED, also cancel the orders (they won't be rescheduled)
  if (status === 'CANCELLED') {
    await db.execute(
      `UPDATE dbo.RunOrders
       SET Status = 'CANCELLED'
       WHERE StopId = (SELECT StopId FROM dbo.StopFailures WHERE FailureId = @id)
         AND Status NOT IN ('DELIVERED')`,
      { id: failureId }
    );
  }

  return { failureId, status };
}
