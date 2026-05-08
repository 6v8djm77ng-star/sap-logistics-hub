/**
 * Daily Digest Worker - morning email to logistics manager at 07:00.
 *
 * Contains:
 *   - Yesterday's stats (runs, deliveries, failure %)
 *   - Open failures still needing attention
 *   - Delivery Notes that didn't sync to SAP
 *   - Today's plan status (runs created, stops, drivers assigned)
 *   - Unassigned returns
 *
 * Subscribers configured via AlertSubscriptions with EventType='DAILY_DIGEST'.
 */
import * as db from '../db/logisticsDb.js';
import * as notifications from '../services/notifications.js';
import { apiLogger } from '../utils/logger.js';
import { format, subDays } from 'date-fns';

let lastRunDate = null;
let timer = null;

async function buildDigestData() {
  const today = new Date();
  const yesterday = subDays(today, 1);
  const todayStr = format(today, 'yyyy-MM-dd');
  const yesterdayStr = format(yesterday, 'yyyy-MM-dd');

  const [
    yesterdayStats,
    openFailures,
    failedDeliveryNotes,
    todayPlan,
    openReturns,
  ] = await Promise.all([
    // Yesterday's performance
    db.queryOne(
      `SELECT
         COUNT(DISTINCT r.RunId) AS TotalRuns,
         COUNT(DISTINCT s.StopId) AS TotalStops,
         COUNT(DISTINCT CASE WHEN s.Status = 'DELIVERED' THEN s.StopId END) AS DeliveredStops,
         COUNT(DISTINCT CASE WHEN s.Status = 'PARTIAL' THEN s.StopId END) AS PartialStops,
         COUNT(DISTINCT CASE WHEN s.Status = 'FAILED' THEN s.StopId END) AS FailedStops,
         COUNT(DISTINCT ro.RunOrderId) AS TotalOrders,
         COUNT(DISTINCT CASE WHEN ro.Status = 'DELIVERED' THEN ro.RunOrderId END) AS DeliveredOrders
       FROM dbo.DeliveryRuns r
       LEFT JOIN dbo.DeliveryStops s ON s.RunId = r.RunId
       LEFT JOIN dbo.RunOrders ro ON ro.StopId = s.StopId
       WHERE r.RunDate = @date`,
      { date: yesterdayStr }
    ),

    // Open failures (not resolved yet)
    db.query(
      `SELECT TOP 20
         sf.FailureId, sf.CreatedAt, sf.Notes,
         fr.Name AS ReasonName, fr.Severity,
         a.Street, a.BuildingNumber, a.City,
         (SELECT TOP 1 ro.SapCardName FROM dbo.RunOrders ro WHERE ro.StopId = sf.StopId) AS CustomerName
       FROM dbo.StopFailures sf
       INNER JOIN dbo.FailureReasons fr ON fr.ReasonCode = sf.ReasonCode
       INNER JOIN dbo.DeliveryStops s ON s.StopId = sf.StopId
       INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = s.AddressId
       WHERE sf.ResolutionStatus = 'OPEN'
       ORDER BY
         CASE fr.Severity WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
         sf.CreatedAt`
    ),

    // Delivery Notes that failed to create in SAP
    db.query(
      `SELECT TOP 20
         ro.RunOrderId, ro.SapDocNum, ro.SapCardName,
         c.Code AS CompanyCode, r.RunNumber, r.RunDate
       FROM dbo.RunOrders ro
       INNER JOIN dbo.Companies c ON c.CompanyId = ro.CompanyId
       INNER JOIN dbo.DeliveryStops s ON s.StopId = ro.StopId
       INNER JOIN dbo.DeliveryRuns r ON r.RunId = s.RunId
       WHERE ro.Status = 'DELIVERED'
         AND ro.SapDeliveryDocEntry IS NULL
         AND r.RunDate >= DATEADD(DAY, -3, @date)`,
      { date: todayStr }
    ),

    // Today's plan
    db.query(
      `SELECT
         r.RunId, r.RunNumber, r.Status,
         z.Name AS ZoneName, z.ColorHex AS ZoneColor,
         d.FullName AS DriverName,
         (SELECT COUNT(*) FROM dbo.DeliveryStops WHERE RunId = r.RunId) AS StopCount,
         (SELECT COUNT(*) FROM dbo.RunOrders ro
          INNER JOIN dbo.DeliveryStops s ON s.StopId = ro.StopId
          WHERE s.RunId = r.RunId) AS OrderCount
       FROM dbo.DeliveryRuns r
       LEFT JOIN dbo.Zones z ON z.ZoneId = r.ZoneId
       LEFT JOIN dbo.Drivers d ON d.DriverId = r.DriverId
       WHERE r.RunDate = @date
       ORDER BY z.SortOrder`,
      { date: todayStr }
    ),

    // Open returns awaiting assignment
    db.query(
      `SELECT
         r.ReturnNumber, r.SapCardName, r.RequestedDate,
         c.Code AS CompanyCode,
         a.Street, a.BuildingNumber, a.City,
         (SELECT COUNT(*) FROM dbo.ReturnRequestLines WHERE ReturnId = r.ReturnId) AS LinesCount
       FROM dbo.ReturnRequests r
       INNER JOIN dbo.Companies c ON c.CompanyId = r.CompanyId
       INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = r.AddressId
       WHERE r.Status = 'OPEN'
         AND r.RequestedDate <= DATEADD(DAY, 2, @date)
       ORDER BY r.RequestedDate`,
      { date: todayStr }
    ),
  ]);

  return {
    todayStr,
    yesterdayStr,
    yesterdayStats: yesterdayStats || {},
    openFailures,
    failedDeliveryNotes,
    todayPlan,
    openReturns,
    successRate: yesterdayStats?.TotalStops > 0
      ? Math.round((yesterdayStats.DeliveredStops / yesterdayStats.TotalStops) * 100)
      : null,
  };
}

function buildHtml(data) {
  const severityColor = { HIGH: '#dc2626', MEDIUM: '#f59e0b', LOW: '#6b7280' };

  return `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #2563eb, #1e3a8a); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 22px;">☀️ סיכום לוגיסטי יומי</h1>
        <p style="margin: 4px 0 0; opacity: 0.9;">${format(new Date(data.todayStr), 'dd/MM/yyyy')}</p>
      </div>

      <div style="background: white; padding: 0; border: 1px solid #e5e7eb; border-top: none;">

        <!-- Yesterday stats -->
        <div style="padding: 20px; border-bottom: 1px solid #e5e7eb;">
          <h2 style="margin: 0 0 12px; font-size: 16px; color: #1e3a8a;">📊 אתמול - ${data.yesterdayStr}</h2>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr>
              <td style="padding: 8px; background: #f3f4f6; text-align: center; border-radius: 4px;" width="25%">
                <div style="font-size: 24px; font-weight: bold;">${data.yesterdayStats.TotalRuns || 0}</div>
                <div style="color: #6b7280; font-size: 11px;">מסלולים</div>
              </td>
              <td width="2%"></td>
              <td style="padding: 8px; background: #f3f4f6; text-align: center; border-radius: 4px;" width="25%">
                <div style="font-size: 24px; font-weight: bold;">${data.yesterdayStats.DeliveredStops || 0}/${data.yesterdayStats.TotalStops || 0}</div>
                <div style="color: #6b7280; font-size: 11px;">מסירות</div>
              </td>
              <td width="2%"></td>
              <td style="padding: 8px; background: ${data.successRate >= 90 ? '#d1fae5' : data.successRate >= 70 ? '#fef3c7' : '#fee2e2'}; text-align: center; border-radius: 4px;" width="22%">
                <div style="font-size: 24px; font-weight: bold;">${data.successRate != null ? data.successRate + '%' : '—'}</div>
                <div style="color: #6b7280; font-size: 11px;">הצלחה</div>
              </td>
              <td width="2%"></td>
              <td style="padding: 8px; background: ${data.yesterdayStats.FailedStops > 0 ? '#fee2e2' : '#f3f4f6'}; text-align: center; border-radius: 4px;" width="22%">
                <div style="font-size: 24px; font-weight: bold; color: ${data.yesterdayStats.FailedStops > 0 ? '#dc2626' : 'inherit'};">${data.yesterdayStats.FailedStops || 0}</div>
                <div style="color: #6b7280; font-size: 11px;">כשלים</div>
              </td>
            </tr>
          </table>
        </div>

        <!-- Open failures -->
        ${data.openFailures.length > 0 ? `
        <div style="padding: 20px; border-bottom: 1px solid #e5e7eb;">
          <h2 style="margin: 0 0 12px; font-size: 16px; color: #dc2626;">🚨 כשלים פתוחים (${data.openFailures.length})</h2>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <tr style="background: #f3f4f6;">
              <th style="padding: 6px; text-align: right;">לקוח</th>
              <th style="padding: 6px; text-align: right;">סיבה</th>
              <th style="padding: 6px; text-align: right;">כתובת</th>
            </tr>
            ${data.openFailures.slice(0, 10).map((f) => `
              <tr>
                <td style="padding: 6px; border-bottom: 1px solid #f3f4f6;">
                  <div style="display: inline-block; width: 8px; height: 8px; background: ${severityColor[f.Severity]}; border-radius: 50%; margin-left: 4px;"></div>
                  ${f.CustomerName || '—'}
                </td>
                <td style="padding: 6px; border-bottom: 1px solid #f3f4f6;">${f.ReasonName}</td>
                <td style="padding: 6px; border-bottom: 1px solid #f3f4f6; color: #6b7280;">${f.Street || ''} ${f.BuildingNumber || ''}, ${f.City || ''}</td>
              </tr>
            `).join('')}
          </table>
          ${data.openFailures.length > 10 ? `<p style="margin: 8px 0 0; font-size: 12px; color: #6b7280;">ועוד ${data.openFailures.length - 10} נוספים...</p>` : ''}
        </div>
        ` : ''}

        <!-- Today's plan -->
        <div style="padding: 20px; border-bottom: 1px solid #e5e7eb;">
          <h2 style="margin: 0 0 12px; font-size: 16px; color: #1e3a8a;">🚚 היום - ${data.todayStr}</h2>
          ${data.todayPlan.length === 0 ? `
            <p style="color: #f59e0b; margin: 0;">⚠️ עדיין אין מסלולים מתוכננות להיום. נדרש תכנון!</p>
          ` : `
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              ${data.todayPlan.map((r) => `
                <tr>
                  <td style="padding: 6px; border-bottom: 1px solid #f3f4f6;">
                    <span style="display: inline-block; width: 10px; height: 10px; background: ${r.ZoneColor || '#9ca3af'}; border-radius: 50%; margin-left: 6px;"></span>
                    <strong>${r.RunNumber}</strong> - ${r.ZoneName || '—'}
                  </td>
                  <td style="padding: 6px; border-bottom: 1px solid #f3f4f6; color: #6b7280;">${r.DriverName || 'ללא נהג'}</td>
                  <td style="padding: 6px; border-bottom: 1px solid #f3f4f6; text-align: center;">${r.StopCount} עצירות · ${r.OrderCount} הזמנות</td>
                </tr>
              `).join('')}
            </table>
          `}
        </div>

        <!-- Failed SAP syncs -->
        ${data.failedDeliveryNotes.length > 0 ? `
        <div style="padding: 20px; border-bottom: 1px solid #e5e7eb;">
          <h2 style="margin: 0 0 12px; font-size: 16px; color: #f59e0b;">⚠️ תעודות משלוח שלא נוצרו ב-SAP (${data.failedDeliveryNotes.length})</h2>
          <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">
            הזמנות שסומנו כנמסרו אך ה-SAP Service Layer לא זמין. ה-retry worker מנסה שוב אוטומטית.
          </p>
          <ul style="margin: 0; padding-right: 20px; font-size: 13px;">
            ${data.failedDeliveryNotes.slice(0, 5).map((d) => `
              <li>חברה ${d.CompanyCode} - ${d.SapCardName} - #${d.SapDocNum}</li>
            `).join('')}
          </ul>
        </div>
        ` : ''}

        <!-- Open returns -->
        ${data.openReturns.length > 0 ? `
        <div style="padding: 20px; border-bottom: 1px solid #e5e7eb;">
          <h2 style="margin: 0 0 12px; font-size: 16px; color: #1e3a8a;">🔄 חזרות ממתינות לשיוך (${data.openReturns.length})</h2>
          <ul style="margin: 0; padding-right: 20px; font-size: 13px;">
            ${data.openReturns.slice(0, 10).map((r) => `
              <li>${r.ReturnNumber} - ${r.SapCardName} (${r.LinesCount} שורות) - ${r.Street || ''} ${r.BuildingNumber || ''}, ${r.City || ''}</li>
            `).join('')}
          </ul>
        </div>
        ` : ''}

        <div style="padding: 16px 20px; background: #f9fafb; text-align: center; font-size: 12px; color: #6b7280;">
          <a href="http://localhost:5173/" style="color: #2563eb; text-decoration: none;">פתח את לוחם הבקרה →</a>
        </div>
      </div>
    </div>
  `;
}

export async function sendDailyDigest() {
  try {
    const data = await buildDigestData();
    const html = buildHtml(data);
    const text = `סיכום לוגיסטי ${data.todayStr}\n\nאתמול: ${data.yesterdayStats.TotalRuns} מסלולים, ${data.yesterdayStats.DeliveredStops}/${data.yesterdayStats.TotalStops} מסירות (${data.successRate}%), ${data.yesterdayStats.FailedStops} כשלים\n\nהיום: ${data.todayPlan.length} מסלולים מתוכננות\nכשלים פתוחים: ${data.openFailures.length}\nחזרות ממתינות: ${data.openReturns.length}`;

    const result = await notifications.notifyEvent('DAILY_DIGEST', {
      subject: `📋 סיכום לוגיסטי יומי - ${format(new Date(data.todayStr), 'dd/MM/yyyy')}`,
      html,
      text,
      entity: null,
    });

    apiLogger.info('[digest] Daily digest sent', result);
    return result;
  } catch (err) {
    apiLogger.error('[digest] Failed to build/send digest', { error: err.message });
    throw err;
  }
}

// Run at 07:00 every day
function scheduleNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(7, 0, 0, 0);
  if (now.getHours() >= 7) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export function startDigestWorker() {
  if (timer) return;
  const schedule = () => {
    const ms = scheduleNextRun();
    apiLogger.info(`[digest] Next daily digest in ${Math.round(ms / 3600000)}h`);
    timer = setTimeout(async () => {
      const today = format(new Date(), 'yyyy-MM-dd');
      if (lastRunDate !== today) {
        lastRunDate = today;
        await sendDailyDigest();
      }
      schedule(); // schedule next day
    }, ms);
  };
  schedule();
}

export function stopDigestWorker() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
