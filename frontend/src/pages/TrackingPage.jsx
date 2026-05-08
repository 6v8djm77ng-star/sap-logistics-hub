/**
 * PUBLIC customer tracking page - shown via /t/:token SMS link.
 * No auth required. Limited data shown (no PII beyond what customer needs).
 */
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { format } from 'date-fns';
import {
  Truck, MapPin, Clock, CheckCircle, AlertCircle,
  Package, User,
} from 'lucide-react';

// Fix Leaflet default icons for Vite
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const truckIcon = L.divIcon({
  className: 'custom-truck',
  html: `<div style="background:#2563eb;border:3px solid white;border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M1 3h15v13H1zm15 5h3l3 3v5h-6V8z"/><circle cx="5.5" cy="18.5" r="2.5" fill="#1f2937"/><circle cx="18.5" cy="18.5" r="2.5" fill="#1f2937"/></svg>
  </div>`,
  iconSize: [36, 36],
  iconAnchor: [18, 18],
});

const destIcon = L.divIcon({
  className: 'custom-dest',
  html: `<div style="background:#10b981;border:3px solid white;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7z"/></svg>
  </div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 32],
});

export default function TrackingPage() {
  const { token } = useParams();

  const { data, isLoading, error } = useQuery({
    queryKey: ['track', token],
    queryFn: () => axios.get(`/api/public/track/${token}`).then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  });

  useEffect(() => { document.title = 'מעקב משלוח | SAP Logistics Hub'; }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-gray-500">טוען פרטי משלוח...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
        <div className="bg-white rounded-2xl p-8 max-w-sm text-center">
          <AlertCircle className="mx-auto text-red-500 mb-3" size={40} />
          <h1 className="font-bold text-lg mb-2">קישור לא תקין</h1>
          <p className="text-sm text-gray-600">
            הקישור פג תוקף או שגוי. אם אתה צריך עזרה, פנה לשירות הלקוחות.
          </p>
        </div>
      </div>
    );
  }

  const isDelivered = data.status === 'DELIVERED' || data.status === 'PARTIAL';
  const isFailed = data.status === 'FAILED';
  const isInTransit = data.eta?.status === 'IN_TRANSIT';

  const destLat = data.address.latitude ? Number(data.address.latitude) : null;
  const destLng = data.address.longitude ? Number(data.address.longitude) : null;
  const driverLat = data.driverLocation?.latitude;
  const driverLng = data.driverLocation?.longitude;

  const mapCenter = driverLat && driverLng
    ? [driverLat, driverLng]
    : destLat && destLng
      ? [destLat, destLng]
      : [31.7683, 35.2137];

  const statusCard = (() => {
    if (isDelivered) {
      return {
        bg: 'from-green-500 to-green-700',
        icon: CheckCircle,
        title: 'המשלוח נמסר בהצלחה',
        subtitle: data.completedAt ? `ב-${format(new Date(data.completedAt), 'HH:mm')}` : '',
      };
    }
    if (isFailed) {
      return {
        bg: 'from-red-500 to-red-700',
        icon: AlertCircle,
        title: 'בעיה במסירה',
        subtitle: 'אנא פנה לשירות הלקוחות',
      };
    }
    if (isInTransit) {
      return {
        bg: 'from-blue-500 to-blue-700',
        icon: Truck,
        title: 'המשלוח בדרך אליך',
        subtitle: data.eta?.approximateMinutes ? `הגעה משוערת בעוד כ-${data.eta.approximateMinutes} דקות` : '',
      };
    }
    return {
      bg: 'from-amber-500 to-amber-700',
      icon: Clock,
      title: data.eta?.message || 'המשלוח בהכנה',
      subtitle: data.run.runDate ? `מתוכנן ל-${format(new Date(data.run.runDate), 'dd/MM/yyyy')}` : '',
    };
  })();

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Status banner */}
      <div className={`bg-gradient-to-br ${statusCard.bg} text-white p-6`}>
        <div className="max-w-lg mx-auto">
          <div className="flex items-center gap-3 mb-2">
            <statusCard.icon size={32} />
            <h1 className="text-xl font-bold">{statusCard.title}</h1>
          </div>
          {statusCard.subtitle && (
            <p className="text-sm opacity-90 mr-11">{statusCard.subtitle}</p>
          )}
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 -mt-2">
        {/* Details card */}
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-3">
          <div className="space-y-3 text-sm">
            <div className="flex items-start gap-2">
              <MapPin className="text-gray-400 mt-0.5" size={16} />
              <div className="flex-1">
                <div className="text-xs text-gray-500">כתובת מסירה</div>
                <div className="font-medium">
                  {data.address.street} {data.address.buildingNumber}
                </div>
                <div className="text-xs text-gray-600">{data.address.city}</div>
                {data.address.branchName && (
                  <div className="text-xs text-gray-400 mt-0.5">{data.address.branchName}</div>
                )}
              </div>
            </div>

            {data.run.driverName && (
              <div className="flex items-start gap-2">
                <User className="text-gray-400 mt-0.5" size={16} />
                <div className="flex-1">
                  <div className="text-xs text-gray-500">נהג</div>
                  <div className="font-medium">{data.run.driverName}</div>
                  {data.run.vehiclePlate && (
                    <div className="text-xs text-gray-500 font-mono">{data.run.vehiclePlate}</div>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-start gap-2">
              <Package className="text-gray-400 mt-0.5" size={16} />
              <div className="flex-1">
                <div className="text-xs text-gray-500">התקדמות מסלול</div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {data.progress.completedStops}/{data.progress.totalStops}
                  </span>
                  <span className="text-xs text-gray-500">עצירות הושלמו</span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  אתה עצירה #{data.progress.yourPosition}
                </div>
                {/* Progress bar */}
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mt-2">
                  <div
                    className="h-full bg-brand-600 transition-all"
                    style={{
                      width: `${data.progress.totalStops > 0 ? (data.progress.completedStops / data.progress.totalStops) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Map */}
        {(destLat || driverLat) && (
          <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-3">
            <div style={{ height: '320px' }}>
              <MapContainer
                center={mapCenter}
                zoom={12}
                style={{ height: '100%', width: '100%' }}
              >
                <TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution='&copy; OpenStreetMap'
                />
                {destLat && destLng && (
                  <Marker position={[destLat, destLng]} icon={destIcon}>
                    <Popup><div dir="rtl">כתובת המסירה</div></Popup>
                  </Marker>
                )}
                {driverLat && driverLng && (
                  <Marker position={[driverLat, driverLng]} icon={truckIcon}>
                    <Popup><div dir="rtl">מיקום הנהג<br/>{data.run.driverName}</div></Popup>
                  </Marker>
                )}
              </MapContainer>
            </div>
            {data.driverLocation && (
              <div className="p-3 text-xs text-gray-500 text-center">
                מיקום הנהג עודכן ב-{format(new Date(data.driverLocation.updatedAt), 'HH:mm')}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="text-center text-xs text-gray-400 py-4">
          דף זה מתעדכן אוטומטית • אם יש שאלות פנה לשירות הלקוחות
        </div>
      </div>
    </div>
  );
}
