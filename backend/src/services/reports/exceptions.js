/**
 * Exceptions Report - things the planner needs to manually fix.
 *
 * What counts as an exception:
 *   - Orders without a recognized zone
 *   - Orders with addresses that don't match any normalized address
 *   - Stops that failed (driver couldn't deliver)
 *   - Returns with no assigned run
 *   - SAP Delivery Notes that failed to create
 */
import * as db from '../../db/logisticsDb.js';
import * as sapSql from '../sap/sqlReader.js';

export async function getExceptionsReport({ fromDate, toDate } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const dateFilter = fromDate || today;

  const [ordersWithoutZone, failedStops, unassignedReturns, failedDeliveryNotes] = await Promise.all([
    // Orders whose addresses don't map to a zone
    (async () => {
      const all = await db.query(
        `SELECT na.AddressId, na.Street, na.BuildingNumber, na.City, na.BranchName,
                COUNT(cal.LinkId) AS CustomerLinks
         FROM dbo.NormalizedAddresses na
         LEFT JOIN dbo.CustomerAddressLinks cal ON cal.AddressId = na.AddressId
         WHERE na.ZoneId IS NULL
         GROUP BY na.AddressId, na.Street, na.BuildingNumber, na.City, na.BranchName
         HAVING COUNT(cal.LinkId) > 0`
      );
      return all;
    })(),

    // Stops that failed
    db.query(
      `SELECT s.StopId, s.Status, s.Notes, s.CompletedAt,
              r.RunNumber, r.RunDate,
              a.Street, a.BuildingNumber, a.City
       FROM dbo.DeliveryStops s
       INNER JOIN dbo.DeliveryRuns r ON r.RunId = s.RunId
       INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = s.AddressId
       WHERE s.Status = 'FAILED'
         AND r.RunDate >= @date
       ORDER BY s.CompletedAt DESC`,
      { date: dateFilter }
    ),

    // Returns without a run assignment
    db.query(
      `SELECT r.*, c.Code AS CompanyCode, c.Name AS CompanyName,
              a.Street, a.BuildingNumber, a.City
       FROM dbo.ReturnRequests r
       INNER JOIN dbo.Companies c ON c.CompanyId = r.CompanyId
       INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = r.AddressId
       WHERE r.Status = 'OPEN'
         AND r.RequestedDate <= DATEADD(DAY, 1, @date)
       ORDER BY r.RequestedDate`,
      { date: dateFilter }
    ),

    // Orders delivered in our DB but missing SAP Delivery Note (sync issue)
    db.query(
      `SELECT ro.RunOrderId, ro.SapDocNum, ro.SapCardName,
              c.Code AS CompanyCode, r.RunNumber
       FROM dbo.RunOrders ro
       INNER JOIN dbo.Companies c ON c.CompanyId = ro.CompanyId
       INNER JOIN dbo.DeliveryStops s ON s.StopId = ro.StopId
       INNER JOIN dbo.DeliveryRuns r ON r.RunId = s.RunId
       WHERE ro.Status = 'DELIVERED'
         AND ro.SapDeliveryDocEntry IS NULL
         AND r.RunDate >= @date`,
      { date: dateFilter }
    ),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    dateRange: { from: dateFilter, to: toDate || dateFilter },
    summary: {
      addressesWithoutZone: ordersWithoutZone.length,
      failedStops: failedStops.length,
      unassignedReturns: unassignedReturns.length,
      failedDeliveryNotes: failedDeliveryNotes.length,
      total: ordersWithoutZone.length + failedStops.length + unassignedReturns.length + failedDeliveryNotes.length,
    },
    exceptions: {
      addressesWithoutZone: ordersWithoutZone,
      failedStops,
      unassignedReturns,
      failedDeliveryNotes,
    },
  };
}
