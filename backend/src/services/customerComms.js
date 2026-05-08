/**
 * Customer Communications - SMS and Email to end customers.
 *
 * Triggered at:
 *   1. Run starts (IN_TRANSIT) → SMS with tracking link
 *   2. Stop completes (DELIVERED) → Email proof of delivery
 *   3. Stop fails → Optional SMS apology + reschedule
 */
import * as db from '../db/logisticsDb.js';
import * as notifications from './notifications.js';
import * as trackingTokens from './trackingTokens.js';
import { formatWindow } from './timeWindows.js';
import { env } from '../config/env.js';
import { apiLogger } from '../utils/logger.js';
import { format } from 'date-fns';

/**
 * Send arrival SMS to all stops of a run that opt-in.
 * Called when run status changes to IN_TRANSIT.
 */
export async function sendRunStartNotifications(runId) {
  const stops = await db.query(
    `SELECT
       s.StopId, s.StopOrder,
       a.AddressId, a.ContactPhone, a.ContactName, a.SmsOptIn,
       a.Street, a.BuildingNumber, a.City,
       a.DeliveryWindowStart, a.DeliveryWindowEnd, a.DeliveryDays,
       r.RunNumber,
       d.FullName AS DriverName,
       d.Phone AS DriverPhone
     FROM dbo.DeliveryStops s
     INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = s.AddressId
     INNER JOIN dbo.DeliveryRuns r ON r.RunId = s.RunId
     LEFT JOIN dbo.Drivers d ON d.DriverId = r.DriverId
     WHERE s.RunId = @runId
       AND s.Status IN ('PENDING', 'ARRIVED')
       AND a.SmsOptIn = 1
       AND a.ContactPhone IS NOT NULL`,
    { runId }
  );

  apiLogger.info(`Sending run start SMS to ${stops.length} customers`, { runId });

  const results = [];
  for (const stop of stops) {
    try {
      const token = await trackingTokens.createTokenForStop(stop.StopId);
      const trackingUrl = trackingTokens.getTrackingUrl(token);

      const windowInfo = formatWindow(stop) ? ` (חלון: ${formatWindow(stop)})` : '';
      const message = [
        `שלום${stop.ContactName ? ` ${stop.ContactName}` : ''},`,
        `המשלוח שלכם יצא לדרך. עצירה #${stop.StopOrder}${windowInfo}.`,
        `הנהג: ${stop.DriverName || '—'}.`,
        `מעקב בזמן אמת: ${trackingUrl}`,
      ].join(' ');

      const result = await notifications.sendSms({
        to: stop.ContactPhone,
        message,
        eventType: 'RUN_STARTED',
        entity: { type: 'DeliveryStop', id: stop.StopId },
      });
      results.push({ stopId: stop.StopId, ...result });
    } catch (err) {
      apiLogger.error('Failed to send start SMS', { stopId: stop.StopId, error: err.message });
      results.push({ stopId: stop.StopId, sent: false, error: err.message });
    }
  }
  return { total: stops.length, sent: results.filter((r) => r.sent).length, results };
}

/**
 * Send Proof of Delivery email after a stop is completed.
 * Includes items delivered + signature.
 */
export async function sendProofOfDeliveryEmail(stopId) {
  const stopData = await db.queryOne(
    `SELECT
       s.StopId, s.Status, s.CompletedAt, s.SignatureUrl, s.PhotoUrl, s.Notes,
       a.Street, a.BuildingNumber, a.City, a.BranchName,
       a.ContactEmail, a.ContactName, a.EmailOptIn,
       r.RunNumber, r.RunDate,
       d.FullName AS DriverName,
       d.VehiclePlate
     FROM dbo.DeliveryStops s
     INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = s.AddressId
     INNER JOIN dbo.DeliveryRuns r ON r.RunId = s.RunId
     LEFT JOIN dbo.Drivers d ON d.DriverId = r.DriverId
     WHERE s.StopId = @stopId`,
    { stopId }
  );

  if (!stopData) return { sent: false, reason: 'stop-not-found' };
  if (!stopData.EmailOptIn || !stopData.ContactEmail) {
    return { sent: false, reason: 'no-email-optin' };
  }
  if (!['DELIVERED', 'PARTIAL'].includes(stopData.Status)) {
    return { sent: false, reason: 'not-delivered' };
  }

  const orders = await db.query(
    `SELECT
       ro.SapDocNum, ro.SapCardName, ro.Status,
       c.Code AS CompanyCode, c.Name AS CompanyName,
       ro.SapDeliveryDocEntry
     FROM dbo.RunOrders ro
     INNER JOIN dbo.Companies c ON c.CompanyId = ro.CompanyId
     WHERE ro.StopId = @stopId`,
    { stopId }
  );

  const subject = `אישור מסירה - ${stopData.RunNumber}`;

  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #10b981, #047857); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 22px;">✓ המשלוח נמסר בהצלחה</h1>
        <p style="margin: 4px 0 0; opacity: 0.9;">
          ${format(new Date(stopData.CompletedAt), 'dd/MM/yyyy HH:mm')}
        </p>
      </div>

      <div style="background: white; padding: 20px; border: 1px solid #e5e7eb; border-top: none;">
        ${stopData.ContactName ? `<p>שלום ${stopData.ContactName},</p>` : '<p>שלום,</p>'}
        <p>ברצוננו לאשר כי המשלוח נמסר בהצלחה.</p>

        <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">כתובת מסירה:</td>
            <td style="padding: 8px 0;"><strong>${stopData.Street || ''} ${stopData.BuildingNumber || ''}, ${stopData.City || ''}</strong></td>
          </tr>
          ${stopData.BranchName ? `
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">סניף:</td>
            <td style="padding: 8px 0;">${stopData.BranchName}</td>
          </tr>` : ''}
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">נהג מוסר:</td>
            <td style="padding: 8px 0;">${stopData.DriverName || '—'}${stopData.VehiclePlate ? ` (${stopData.VehiclePlate})` : ''}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">מספר מסלול:</td>
            <td style="padding: 8px 0;"><code>${stopData.RunNumber}</code></td>
          </tr>
        </table>

        <h3 style="margin-top: 24px; font-size: 16px; color: #111827;">מסמכים</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <thead>
            <tr style="background: #f3f4f6; text-align: right;">
              <th style="padding: 8px;">חברה</th>
              <th style="padding: 8px;">לקוח</th>
              <th style="padding: 8px;">הזמנה</th>
              <th style="padding: 8px;">תעודה ב-SAP</th>
            </tr>
          </thead>
          <tbody>
            ${orders.map((o) => `
              <tr style="border-bottom: 1px solid #e5e7eb;">
                <td style="padding: 8px;">${o.CompanyName || o.CompanyCode}</td>
                <td style="padding: 8px;">${o.SapCardName || '—'}</td>
                <td style="padding: 8px; font-family: monospace;">#${o.SapDocNum}</td>
                <td style="padding: 8px; font-family: monospace;">${o.SapDeliveryDocEntry ? '#' + o.SapDeliveryDocEntry : '<span style="color:#f59e0b;">בסנכרון...</span>'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        ${stopData.SignatureUrl ? `
          <h3 style="margin-top: 24px; font-size: 16px; color: #111827;">חתימת קבלה</h3>
          <div style="background: #f9fafb; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px;">
            <img src="${env.PORTAL_BASE_URL}${stopData.SignatureUrl}" style="max-width: 100%; max-height: 200px;" />
          </div>
        ` : ''}

        ${stopData.Notes ? `
          <div style="margin-top: 16px; padding: 12px; background: #fef3c7; border-radius: 8px;">
            <strong>הערות:</strong> ${stopData.Notes}
          </div>
        ` : ''}

        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px;">
          אישור זה נשלח אוטומטית מ-SAP Logistics Hub.<br>
          אם יש שאלה או בעיה במשלוח, פנה לשירות הלקוחות.
        </div>
      </div>
    </div>
  `;

  const text = [
    `המשלוח נמסר בהצלחה ב-${format(new Date(stopData.CompletedAt), 'dd/MM/yyyy HH:mm')}`,
    `כתובת: ${stopData.Street} ${stopData.BuildingNumber}, ${stopData.City}`,
    `נהג: ${stopData.DriverName}`,
    `מסלול: ${stopData.RunNumber}`,
    `מסמכים: ${orders.map((o) => `${o.CompanyCode} #${o.SapDocNum}`).join(', ')}`,
  ].join('\n');

  return notifications.sendEmail({
    to: stopData.ContactEmail,
    subject,
    html,
    text,
    eventType: 'PROOF_OF_DELIVERY',
    entity: { type: 'DeliveryStop', id: stopId },
  });
}

/**
 * Send SMS to customer when their delivery fails.
 * Triggered from failures service on HIGH severity only.
 */
export async function sendFailureNotificationToCustomer(stopId, reasonName) {
  const address = await db.queryOne(
    `SELECT a.ContactPhone, a.ContactName, a.SmsOptIn
     FROM dbo.DeliveryStops s
     INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = s.AddressId
     WHERE s.StopId = @stopId`,
    { stopId }
  );

  if (!address?.SmsOptIn || !address.ContactPhone) return { sent: false };

  const message = [
    `שלום${address.ContactName ? ` ${address.ContactName}` : ''},`,
    `לא הצלחנו למסור את המשלוח (${reasonName}).`,
    `שירות הלקוחות יתקשר בהקדם לתיאום מחודש.`,
  ].join(' ');

  return notifications.sendSms({
    to: address.ContactPhone,
    message,
    eventType: 'DELIVERY_FAILED_CUSTOMER',
    entity: { type: 'DeliveryStop', id: stopId },
  });
}
