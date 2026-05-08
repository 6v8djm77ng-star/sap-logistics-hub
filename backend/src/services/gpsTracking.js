/**
 * GPS Tracking - driver position updates.
 *
 * Mobile app POSTs its coordinates every 30-60 seconds (configurable).
 * We update the current position (upsert) and append to history.
 */
import * as db from '../db/logisticsDb.js';
import { apiLogger } from '../utils/logger.js';

/**
 * Upsert driver's current position + append to history.
 */
export async function recordPosition({
  driverId,
  runId = null,
  latitude,
  longitude,
  accuracy = null,
  heading = null,
  speedKmh = null,
  batteryLevel = null,
}) {
  if (latitude == null || longitude == null) {
    throw new Error('latitude and longitude are required');
  }

  // Upsert current position
  await db.execute(
    `MERGE dbo.DriverLocations AS target
     USING (SELECT @driverId AS DriverId) AS source
     ON target.DriverId = source.DriverId
     WHEN MATCHED THEN UPDATE SET
       RunId = @runId, Latitude = @lat, Longitude = @lng,
       Accuracy = @acc, Heading = @hdg, SpeedKmh = @speed,
       BatteryLevel = @battery, UpdatedAt = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT
       (DriverId, RunId, Latitude, Longitude, Accuracy, Heading, SpeedKmh, BatteryLevel)
       VALUES (@driverId, @runId, @lat, @lng, @acc, @hdg, @speed, @battery);`,
    {
      driverId, runId, lat: latitude, lng: longitude,
      acc: accuracy, hdg: heading, speed: speedKmh, battery: batteryLevel,
    }
  );

  // Append to history (throttled - only if moved > 50m or > 60s since last)
  await db.execute(
    `INSERT INTO dbo.DriverLocationHistory
       (DriverId, RunId, Latitude, Longitude, Accuracy, SpeedKmh)
     SELECT @driverId, @runId, @lat, @lng, @acc, @speed
     WHERE NOT EXISTS (
       SELECT 1 FROM dbo.DriverLocationHistory h
       WHERE h.DriverId = @driverId
         AND h.RecordedAt > DATEADD(SECOND, -60, SYSUTCDATETIME())
     )`,
    {
      driverId, runId, lat: latitude, lng: longitude,
      acc: accuracy, speed: speedKmh,
    }
  );
}

/**
 * Get all drivers' current positions (for live map).
 */
export async function getAllDriverLocations() {
  return db.query(
    `SELECT
       dl.DriverId, dl.RunId, dl.Latitude, dl.Longitude,
       dl.Accuracy, dl.Heading, dl.SpeedKmh, dl.BatteryLevel, dl.UpdatedAt,
       d.FullName AS DriverName, d.VehiclePlate,
       r.RunNumber, r.Status AS RunStatus,
       z.Name AS ZoneName, z.ColorHex AS ZoneColor
     FROM dbo.DriverLocations dl
     INNER JOIN dbo.Drivers d ON d.DriverId = dl.DriverId
     LEFT JOIN dbo.DeliveryRuns r ON r.RunId = dl.RunId
     LEFT JOIN dbo.Zones z ON z.ZoneId = r.ZoneId
     WHERE d.IsActive = 1
       AND dl.UpdatedAt > DATEADD(HOUR, -4, SYSUTCDATETIME())`
  );
}

/**
 * Get history trail for a specific driver + run (for review).
 */
export async function getDriverTrail(driverId, { runId, fromTime, toTime } = {}) {
  const filters = ['DriverId = @driverId'];
  const params = { driverId };

  if (runId) { filters.push('RunId = @runId'); params.runId = runId; }
  if (fromTime) { filters.push('RecordedAt >= @from'); params.from = fromTime; }
  if (toTime) { filters.push('RecordedAt <= @to'); params.to = toTime; }

  return db.query(
    `SELECT Latitude, Longitude, Accuracy, SpeedKmh, RecordedAt
     FROM dbo.DriverLocationHistory
     WHERE ${filters.join(' AND ')}
     ORDER BY RecordedAt`,
    params
  );
}
