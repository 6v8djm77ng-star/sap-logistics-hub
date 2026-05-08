/**
 * Analytics service - KPIs for management dashboard.
 *
 * Metrics:
 *   - Overall: delivery success rate, avg stop time, merger ratio
 *   - Trends: daily/weekly/monthly comparisons
 *   - Per-driver performance
 *   - Per-zone performance
 *   - Failure breakdown by reason
 *   - SAP sync health
 */
import * as db from '../db/logisticsDb.js';

/**
 * Overall KPIs for a date range.
 */
export async function getOverallKpis({ fromDate, toDate }) {
  const stats = await db.queryOne(
    `SELECT
       COUNT(DISTINCT r.RunId) AS TotalRuns,
       COUNT(DISTINCT CASE WHEN r.Status = 'COMPLETED' THEN r.RunId END) AS CompletedRuns,
       COUNT(DISTINCT s.StopId) AS TotalStops,
       COUNT(DISTINCT CASE WHEN s.Status = 'DELIVERED' THEN s.StopId END) AS DeliveredStops,
       COUNT(DISTINCT CASE WHEN s.Status = 'PARTIAL'   THEN s.StopId END) AS PartialStops,
       COUNT(DISTINCT CASE WHEN s.Status = 'FAILED'    THEN s.StopId END) AS FailedStops,
       COUNT(DISTINCT ro.RunOrderId) AS TotalOrders,
       COUNT(DISTINCT CASE WHEN ro.Status = 'DELIVERED' THEN ro.RunOrderId END) AS DeliveredOrders,
       COUNT(DISTINCT CASE WHEN ro.CompanyId = 1 THEN ro.RunOrderId END) AS OrdersCompanyA,
       COUNT(DISTINCT CASE WHEN ro.CompanyId = 2 THEN ro.RunOrderId END) AS OrdersCompanyB,
       AVG(CAST(DATEDIFF(MINUTE, s.ArrivedAt, s.CompletedAt) AS FLOAT))
         AS AvgStopMinutes,
       AVG(CAST(DATEDIFF(MINUTE, r.ActualStartTime, r.ActualEndTime) AS FLOAT))
         AS AvgRunMinutes
     FROM dbo.DeliveryRuns r
     LEFT JOIN dbo.DeliveryStops s ON s.RunId = r.RunId
     LEFT JOIN dbo.RunOrders ro ON ro.StopId = s.StopId
     WHERE r.RunDate BETWEEN @fromDate AND @toDate`,
    { fromDate, toDate }
  );

  const mergerStats = await db.queryOne(
    `SELECT
       COUNT(DISTINCT s.StopId) AS UnifiedStops,
       SUM(CASE WHEN perStop.HasA = 1 AND perStop.HasB = 1 THEN 1 ELSE 0 END) AS MergedStops
     FROM dbo.DeliveryStops s
     INNER JOIN dbo.DeliveryRuns r ON r.RunId = s.RunId
     CROSS APPLY (
       SELECT
         MAX(CASE WHEN c.Code = 'A' THEN 1 ELSE 0 END) AS HasA,
         MAX(CASE WHEN c.Code = 'B' THEN 1 ELSE 0 END) AS HasB
       FROM dbo.RunOrders ro
       INNER JOIN dbo.Companies c ON c.CompanyId = ro.CompanyId
       WHERE ro.StopId = s.StopId
     ) AS perStop
     WHERE r.RunDate BETWEEN @fromDate AND @toDate`,
    { fromDate, toDate }
  );

  const successRate = stats.TotalStops > 0
    ? (stats.DeliveredStops + stats.PartialStops) / stats.TotalStops
    : null;

  return {
    totalRuns: stats.TotalRuns || 0,
    completedRuns: stats.CompletedRuns || 0,
    totalStops: stats.TotalStops || 0,
    deliveredStops: stats.DeliveredStops || 0,
    partialStops: stats.PartialStops || 0,
    failedStops: stats.FailedStops || 0,
    totalOrders: stats.TotalOrders || 0,
    deliveredOrders: stats.DeliveredOrders || 0,
    ordersCompanyA: stats.OrdersCompanyA || 0,
    ordersCompanyB: stats.OrdersCompanyB || 0,
    avgStopMinutes: stats.AvgStopMinutes ? Math.round(stats.AvgStopMinutes) : null,
    avgRunMinutes: stats.AvgRunMinutes ? Math.round(stats.AvgRunMinutes) : null,
    successRate,
    failureRate: stats.TotalStops > 0 ? stats.FailedStops / stats.TotalStops : null,
    unifiedStops: mergerStats.UnifiedStops || 0,
    mergedStops: mergerStats.MergedStops || 0,
    mergerRatio: mergerStats.UnifiedStops > 0
      ? mergerStats.MergedStops / mergerStats.UnifiedStops
      : null,
  };
}

/**
 * Daily trend data - each day in range as a bar/line point.
 */
export async function getDailyTrend({ fromDate, toDate }) {
  return db.query(
    `SELECT
       r.RunDate,
       COUNT(DISTINCT r.RunId) AS Runs,
       COUNT(DISTINCT s.StopId) AS Stops,
       COUNT(DISTINCT CASE WHEN s.Status IN ('DELIVERED', 'PARTIAL') THEN s.StopId END) AS Delivered,
       COUNT(DISTINCT CASE WHEN s.Status = 'FAILED' THEN s.StopId END) AS Failed,
       COUNT(DISTINCT ro.RunOrderId) AS Orders
     FROM dbo.DeliveryRuns r
     LEFT JOIN dbo.DeliveryStops s ON s.RunId = r.RunId
     LEFT JOIN dbo.RunOrders ro ON ro.StopId = s.StopId
     WHERE r.RunDate BETWEEN @fromDate AND @toDate
     GROUP BY r.RunDate
     ORDER BY r.RunDate`,
    { fromDate, toDate }
  );
}

/**
 * Per-driver performance.
 */
export async function getDriverPerformance({ fromDate, toDate }) {
  return db.query(
    `SELECT
       d.DriverId, d.FullName, d.Code,
       COUNT(DISTINCT r.RunId) AS Runs,
       COUNT(DISTINCT s.StopId) AS TotalStops,
       COUNT(DISTINCT CASE WHEN s.Status IN ('DELIVERED', 'PARTIAL') THEN s.StopId END) AS DeliveredStops,
       COUNT(DISTINCT CASE WHEN s.Status = 'FAILED' THEN s.StopId END) AS FailedStops,
       AVG(CAST(DATEDIFF(MINUTE, s.ArrivedAt, s.CompletedAt) AS FLOAT)) AS AvgStopMinutes,
       AVG(CAST(DATEDIFF(MINUTE, r.ActualStartTime, r.ActualEndTime) AS FLOAT)) AS AvgRunMinutes
     FROM dbo.Drivers d
     LEFT JOIN dbo.DeliveryRuns r ON r.DriverId = d.DriverId
       AND r.RunDate BETWEEN @fromDate AND @toDate
     LEFT JOIN dbo.DeliveryStops s ON s.RunId = r.RunId
     WHERE d.IsActive = 1
     GROUP BY d.DriverId, d.FullName, d.Code
     ORDER BY DeliveredStops DESC`,
    { fromDate, toDate }
  );
}

/**
 * Per-zone performance.
 */
export async function getZonePerformance({ fromDate, toDate }) {
  return db.query(
    `SELECT
       z.ZoneId, z.Code, z.Name, z.ColorHex,
       COUNT(DISTINCT r.RunId) AS Runs,
       COUNT(DISTINCT s.StopId) AS TotalStops,
       COUNT(DISTINCT CASE WHEN s.Status IN ('DELIVERED', 'PARTIAL') THEN s.StopId END) AS DeliveredStops,
       COUNT(DISTINCT CASE WHEN s.Status = 'FAILED' THEN s.StopId END) AS FailedStops,
       COUNT(DISTINCT ro.RunOrderId) AS TotalOrders
     FROM dbo.Zones z
     LEFT JOIN dbo.DeliveryRuns r ON r.ZoneId = z.ZoneId
       AND r.RunDate BETWEEN @fromDate AND @toDate
     LEFT JOIN dbo.DeliveryStops s ON s.RunId = r.RunId
     LEFT JOIN dbo.RunOrders ro ON ro.StopId = s.StopId
     WHERE z.IsActive = 1
     GROUP BY z.ZoneId, z.Code, z.Name, z.ColorHex, z.SortOrder
     ORDER BY z.SortOrder`,
    { fromDate, toDate }
  );
}

/**
 * Failure reason breakdown.
 */
export async function getFailureBreakdown({ fromDate, toDate }) {
  return db.query(
    `SELECT
       fr.ReasonCode, fr.Name, fr.Category, fr.Severity,
       COUNT(sf.FailureId) AS Count,
       COUNT(CASE WHEN sf.ResolutionStatus = 'RESCHEDULED' THEN 1 END) AS Rescheduled,
       COUNT(CASE WHEN sf.ResolutionStatus = 'RESOLVED'    THEN 1 END) AS Resolved,
       COUNT(CASE WHEN sf.ResolutionStatus = 'CANCELLED'   THEN 1 END) AS Cancelled,
       COUNT(CASE WHEN sf.ResolutionStatus = 'OPEN'        THEN 1 END) AS StillOpen
     FROM dbo.FailureReasons fr
     LEFT JOIN dbo.StopFailures sf ON sf.ReasonCode = fr.ReasonCode
       AND CAST(sf.CreatedAt AS DATE) BETWEEN @fromDate AND @toDate
     GROUP BY fr.ReasonCode, fr.Name, fr.Category, fr.Severity
     HAVING COUNT(sf.FailureId) > 0
     ORDER BY COUNT(sf.FailureId) DESC`,
    { fromDate, toDate }
  );
}

/**
 * SAP sync health - how many Delivery Notes failed to sync.
 */
export async function getSapSyncHealth() {
  return db.queryOne(
    `SELECT
       (SELECT COUNT(*) FROM dbo.RunOrders
         WHERE Status = 'DELIVERED' AND SapDeliveryDocEntry IS NULL) AS PendingDeliveryNotes,
       (SELECT COUNT(*) FROM dbo.RunOrders
         WHERE Status = 'DELIVERED' AND SapDeliveryDocEntry IS NOT NULL) AS SyncedDeliveryNotes,
       (SELECT COUNT(*) FROM dbo.ReturnRequests
         WHERE Status = 'PICKED_UP' AND SapReturnRequestDocEntry IS NULL) AS PendingReturnRequests,
       (SELECT COUNT(*) FROM dbo.SapRetryQueue
         WHERE Status = 'PENDING') AS QueueBacklog,
       (SELECT COUNT(*) FROM dbo.SapRetryQueue
         WHERE Status = 'FAILED_PERMANENT') AS PermanentFailures`
  );
}

/**
 * Summary for a date range - bundles everything the dashboard needs.
 */
export async function getDashboardSummary({ fromDate, toDate }) {
  const [overall, daily, drivers, zones, failures, syncHealth] = await Promise.all([
    getOverallKpis({ fromDate, toDate }),
    getDailyTrend({ fromDate, toDate }),
    getDriverPerformance({ fromDate, toDate }),
    getZonePerformance({ fromDate, toDate }),
    getFailureBreakdown({ fromDate, toDate }),
    getSapSyncHealth(),
  ]);
  return { overall, daily, drivers, zones, failures, syncHealth };
}
