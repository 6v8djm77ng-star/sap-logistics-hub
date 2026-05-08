/**
 * Tracking tokens - one per delivery stop, shared with customer via SMS.
 * Public (no auth) endpoint uses them to show tracking page.
 */
import crypto from 'crypto';
import * as db from '../db/logisticsDb.js';
import { env } from '../config/env.js';

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Create a tracking token for a stop (or return existing).
 */
export async function createTokenForStop(stopId, { expiresInHours = 48 } = {}) {
  // Reuse existing unexpired token if any
  const existing = await db.queryOne(
    `SELECT Token FROM dbo.TrackingTokens
     WHERE StopId = @stopId AND ExpiresAt > SYSUTCDATETIME()`,
    { stopId }
  );
  if (existing) return existing.Token;

  const token = generateToken();
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

  await db.execute(
    `INSERT INTO dbo.TrackingTokens (Token, StopId, ExpiresAt)
     VALUES (@token, @stopId, @expires)`,
    { token, stopId, expires: expiresAt }
  );

  return token;
}

export function getTrackingUrl(token) {
  return `${env.PORTAL_BASE_URL}/t/${token}`;
}

/**
 * Get public tracking info - limited fields only (no PII beyond what customer needs).
 */
export async function getTrackingInfo(token) {
  const result = await db.queryOne(
    `SELECT
       s.StopId, s.Status, s.StopOrder, s.ArrivedAt, s.CompletedAt,
       a.Street, a.BuildingNumber, a.City, a.Latitude, a.Longitude, a.BranchName,
       r.RunId, r.RunNumber, r.RunDate, r.Status AS RunStatus,
       z.Name AS ZoneName, z.ColorHex AS ZoneColor,
       d.FullName AS DriverName, d.VehiclePlate,
       dl.Latitude AS DriverLat, dl.Longitude AS DriverLng, dl.UpdatedAt AS DriverLocUpdatedAt,
       t.ExpiresAt
     FROM dbo.TrackingTokens t
     INNER JOIN dbo.DeliveryStops s ON s.StopId = t.StopId
     INNER JOIN dbo.NormalizedAddresses a ON a.AddressId = s.AddressId
     INNER JOIN dbo.DeliveryRuns r ON r.RunId = s.RunId
     LEFT JOIN dbo.Zones z ON z.ZoneId = r.ZoneId
     LEFT JOIN dbo.Drivers d ON d.DriverId = r.DriverId
     LEFT JOIN dbo.DriverLocations dl ON dl.DriverId = d.DriverId AND dl.RunId = r.RunId
     WHERE t.Token = @token
       AND t.ExpiresAt > SYSUTCDATETIME()`,
    { token }
  );

  if (!result) return null;

  // Increment view count
  await db.execute(
    `UPDATE dbo.TrackingTokens
     SET LastViewedAt = SYSUTCDATETIME(), ViewCount = ViewCount + 1
     WHERE Token = @token`,
    { token }
  );

  // Calculate ETA based on run status + stop order + driver position
  const eta = calculateEta(result);

  // Get aggregated stop count + progress for context
  const runProgress = await db.queryOne(
    `SELECT
       COUNT(*) AS TotalStops,
       COUNT(CASE WHEN Status IN ('DELIVERED', 'PARTIAL', 'FAILED', 'SKIPPED') THEN 1 END) AS CompletedStops,
       MIN(CASE WHEN Status = 'PENDING' OR Status = 'ARRIVED' THEN StopOrder END) AS CurrentStopOrder
     FROM dbo.DeliveryStops
     WHERE RunId = @runId`,
    { runId: result.RunId }
  );

  return {
    // Stop info
    stopId: result.StopId,
    status: result.Status,
    stopOrder: result.StopOrder,
    completedAt: result.CompletedAt,
    arrivedAt: result.ArrivedAt,
    // Delivery address (what customer expects)
    address: {
      street: result.Street,
      buildingNumber: result.BuildingNumber,
      city: result.City,
      latitude: result.Latitude,
      longitude: result.Longitude,
      branchName: result.BranchName,
    },
    // Run info (driver, zone)
    run: {
      runNumber: result.RunNumber,
      runDate: result.RunDate,
      status: result.RunStatus,
      zoneName: result.ZoneName,
      zoneColor: result.ZoneColor,
      driverName: result.DriverName,
      vehiclePlate: result.VehiclePlate,
    },
    // Driver live location (only if in_transit)
    driverLocation: (result.DriverLat && ['IN_TRANSIT', 'LOADED'].includes(result.RunStatus))
      ? {
          latitude: Number(result.DriverLat),
          longitude: Number(result.DriverLng),
          updatedAt: result.DriverLocUpdatedAt,
        }
      : null,
    // Progress through the run
    progress: {
      totalStops: runProgress?.TotalStops || 0,
      completedStops: runProgress?.CompletedStops || 0,
      currentStopOrder: runProgress?.CurrentStopOrder || null,
      yourPosition: result.StopOrder,
    },
    eta,
    expiresAt: result.ExpiresAt,
  };
}

/**
 * Simple ETA calculation based on where we are in the run.
 * TODO: integrate with routing API for more accurate ETAs.
 */
function calculateEta(result) {
  if (result.Status === 'DELIVERED' || result.Status === 'FAILED') {
    return { status: 'COMPLETED' };
  }
  if (result.RunStatus === 'OPEN' || result.RunStatus === 'PLANNED') {
    return { status: 'NOT_YET_DEPARTED', message: 'המשלוח מתוכנן אך טרם יצא' };
  }
  if (result.RunStatus === 'PICKING') {
    return { status: 'PREPARING', message: 'המשלוח בהכנה במחסן' };
  }
  if (result.RunStatus === 'LOADED') {
    return { status: 'READY_TO_DEPART', message: 'המשלוח הועמס ובדרך יציאה' };
  }
  if (result.RunStatus === 'IN_TRANSIT') {
    // Rough estimate: 20 minutes per stop
    return {
      status: 'IN_TRANSIT',
      message: `המשלוח בדרך אליך`,
      approximateMinutes: Math.max(10, result.StopOrder * 20),
    };
  }
  return { status: 'UNKNOWN' };
}

/**
 * Cleanup expired tokens (housekeeping).
 */
export async function cleanupExpiredTokens() {
  const result = await db.execute(
    `DELETE FROM dbo.TrackingTokens WHERE ExpiresAt < DATEADD(DAY, -7, SYSUTCDATETIME())`
  );
  return { deleted: result.rowsAffected };
}
