/**
 * Live map showing all drivers' current positions.
 * Uses OpenStreetMap tiles via Leaflet (no API key needed).
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, Popup, Circle } from 'react-leaflet';
import { trackingApi } from '../services/api.js';
import { getSocket } from '../services/socket.js';
import { format } from 'date-fns';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix default Leaflet icon paths (breaks with Vite bundling)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// Custom truck icon based on zone color
const truckIcon = (color = '#2563eb') => L.divIcon({
  className: 'custom-truck-marker',
  html: `<div style="background:${color};border:2px solid white;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.3);">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M1 3h15v13H1zm15 5h3l3 3v5h-6V8z"/><circle cx="5.5" cy="18.5" r="2.5" fill="#1f2937"/><circle cx="18.5" cy="18.5" r="2.5" fill="#1f2937"/></svg>
  </div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

export default function LiveMapPage() {
  const queryClient = useQueryClient();

  const { data: locations } = useQuery({
    queryKey: ['driver-locations'],
    queryFn: trackingApi.driverLocations,
    refetchInterval: 15_000,
  });

  useEffect(() => {
    const socket = getSocket();
    const handler = () => queryClient.invalidateQueries({ queryKey: ['driver-locations'] });
    socket.on('driver:position', handler);
    return () => socket.off('driver:position', handler);
  }, [queryClient]);

  const center = locations && locations.length > 0
    ? [Number(locations[0].Latitude), Number(locations[0].Longitude)]
    : [31.7683, 35.2137]; // Jerusalem

  const lastUpdate = (at) => {
    const mins = Math.floor((Date.now() - new Date(at).getTime()) / 60000);
    if (mins < 1) return 'עכשיו';
    if (mins < 60) return `לפני ${mins} דק'`;
    return `לפני ${Math.floor(mins / 60)} שעות`;
  };

  return (
    <div className="h-screen flex flex-col">
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">מפה חיה - מיקום נהגים</h1>
            <p className="text-xs text-gray-500">
              {locations?.length || 0} נהגים פעילים
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            <span className="text-xs text-gray-500">מתעדכן בזמן אמת</span>
          </div>
        </div>
      </div>

      <div className="flex-1">
        <MapContainer
          center={center}
          zoom={9}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://osm.org/copyright">OpenStreetMap</a>'
          />

          {locations?.map((loc) => (
            <div key={loc.DriverId}>
              <Marker
                position={[Number(loc.Latitude), Number(loc.Longitude)]}
                icon={truckIcon(loc.ZoneColor || '#2563eb')}
              >
                <Popup>
                  <div className="text-sm min-w-[200px]" dir="rtl">
                    <div className="font-bold text-base mb-1">{loc.DriverName}</div>
                    {loc.VehiclePlate && (
                      <div className="text-gray-600 text-xs mb-2">{loc.VehiclePlate}</div>
                    )}
                    {loc.RunNumber && (
                      <div className="text-xs mb-1">
                        <span className="text-gray-500">מסלול:</span>{' '}
                        <span className="font-medium">{loc.RunNumber}</span>
                      </div>
                    )}
                    {loc.ZoneName && (
                      <div className="text-xs mb-1">
                        <span className="text-gray-500">אזור:</span> {loc.ZoneName}
                      </div>
                    )}
                    {loc.SpeedKmh != null && (
                      <div className="text-xs mb-1">
                        <span className="text-gray-500">מהירות:</span>{' '}
                        {Math.round(Number(loc.SpeedKmh))} קמ"ש
                      </div>
                    )}
                    {loc.BatteryLevel != null && (
                      <div className="text-xs mb-1">
                        <span className="text-gray-500">סוללה:</span>{' '}
                        {Math.round(Number(loc.BatteryLevel))}%
                      </div>
                    )}
                    <div className="text-xs text-gray-400 mt-2 pt-2 border-t">
                      {lastUpdate(loc.UpdatedAt)}
                    </div>
                  </div>
                </Popup>
              </Marker>
              {loc.Accuracy && Number(loc.Accuracy) < 500 && (
                <Circle
                  center={[Number(loc.Latitude), Number(loc.Longitude)]}
                  radius={Number(loc.Accuracy)}
                  pathOptions={{
                    color: loc.ZoneColor || '#2563eb',
                    fillColor: loc.ZoneColor || '#2563eb',
                    fillOpacity: 0.1,
                    weight: 1,
                  }}
                />
              )}
            </div>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
