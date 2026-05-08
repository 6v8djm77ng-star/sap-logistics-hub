/**
 * Geofence hook - watches the driver's GPS position and fires onEnter / onExit
 * when they cross a 'radius' boundary around any of the supplied stops.
 *
 * Used to auto-mark "Arrived" when the driver gets close to a stop.
 */
import { useEffect, useRef, useState } from 'react';

const DEFAULT_RADIUS_M = 80; // 80 metres = parking-lot accuracy

function haversineMetres(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(lat1)) * Math.cos(toRad(lat2));
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * @param {Array<{StopId, Lat, Lng, Status}>} stops - stops to monitor
 * @param {Object} options
 * @param {number} [options.radiusM=80]
 * @param {(stop) => void} options.onEnter - called once when driver enters geofence
 */
export function useGeofence(stops, options = {}) {
  const { radiusM = DEFAULT_RADIUS_M, onEnter, enabled = true } = options;
  const [position, setPosition] = useState(null);
  const [error, setError] = useState(null);
  const insideRef = useRef(new Set()); // stop ids currently inside

  useEffect(() => {
    if (!enabled || !navigator.geolocation) {
      if (!navigator.geolocation) setError('GPS לא זמין במכשיר');
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => setError(err.message),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [enabled]);

  useEffect(() => {
    if (!position || !stops || stops.length === 0) return;
    for (const stop of stops) {
      if (!stop.Lat || !stop.Lng) continue;
      // Don't trigger for already-delivered or already-arrived stops
      if (['DELIVERED', 'ARRIVED', 'CANCELLED', 'FAILED'].includes(stop.Status)) {
        insideRef.current.delete(stop.StopId);
        continue;
      }
      const dist = haversineMetres(
        position.lat, position.lng,
        Number(stop.Lat), Number(stop.Lng)
      );
      const wasInside = insideRef.current.has(stop.StopId);
      const isInside = dist <= radiusM;
      if (isInside && !wasInside) {
        insideRef.current.add(stop.StopId);
        onEnter && onEnter(stop, dist);
      } else if (!isInside && wasInside) {
        insideRef.current.delete(stop.StopId);
      }
    }
  }, [position, stops, radiusM, onEnter]);

  return { position, error };
}
