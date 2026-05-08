/**
 * Hook to report the driver's GPS position periodically.
 * Uses the browser Geolocation API with high accuracy.
 */
import { useEffect, useRef, useState } from 'react';
import { sendOrQueue } from '../services/offlineQueue.js';

const REPORT_INTERVAL_MS = 60_000; // report every minute

export function useGpsTracking({ enabled = true, runId = null } = {}) {
  const watchIdRef = useRef(null);
  const lastReportRef = useRef(0);
  const [position, setPosition] = useState(null);
  const [error, setError] = useState(null);
  const [batteryLevel, setBatteryLevel] = useState(null);

  useEffect(() => {
    if (!enabled || !navigator.geolocation) return;

    // Battery API (where supported)
    if (navigator.getBattery) {
      navigator.getBattery().then((b) => {
        setBatteryLevel(Math.round(b.level * 100));
        b.addEventListener('levelchange', () => setBatteryLevel(Math.round(b.level * 100)));
      });
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      async (pos) => {
        const { latitude, longitude, accuracy, heading, speed } = pos.coords;
        setPosition({ latitude, longitude, accuracy, at: new Date(pos.timestamp) });
        setError(null);

        // Throttle server reports
        const now = Date.now();
        if (now - lastReportRef.current < REPORT_INTERVAL_MS) return;
        lastReportRef.current = now;

        await sendOrQueue('POST', '/tracking/position', {
          latitude,
          longitude,
          accuracy: accuracy ? Math.round(accuracy) : undefined,
          heading: heading != null ? Number(heading.toFixed(2)) : undefined,
          speedKmh: speed != null ? Number((speed * 3.6).toFixed(2)) : undefined,
          batteryLevel: batteryLevel != null ? batteryLevel : undefined,
          runId,
        });
      },
      (err) => {
        setError(err.message);
      },
      {
        enableHighAccuracy: true,
        timeout: 30_000,
        maximumAge: 10_000,
      }
    );

    return () => {
      if (watchIdRef.current != null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [enabled, runId, batteryLevel]);

  return { position, error, batteryLevel };
}
