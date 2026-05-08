/**
 * Smart navigation button - lets the driver pick between Waze, Google Maps,
 * or Apple Maps with one tap. Auto-detects platform and shows the right options.
 */
import { useState } from 'react';
import { Navigation, X } from 'lucide-react';

export default function NavigateButton({ stop, label = 'נווט', className = '', size = 'md' }) {
  const [open, setOpen] = useState(false);

  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);

  const address = encodeURIComponent(
    `${stop.Street || ''} ${stop.BuildingNumber || ''}, ${stop.City || ''}`.trim()
  );
  const hasCoords = stop.Lat && stop.Lng;
  const coords = hasCoords ? `${stop.Lat},${stop.Lng}` : null;

  // Waze URL - prefers coords, falls back to address
  const wazeUrl = hasCoords
    ? `https://waze.com/ul?ll=${coords}&navigate=yes`
    : `https://waze.com/ul?q=${address}&navigate=yes`;

  // Google Maps URL - works on every platform
  const googleUrl = hasCoords
    ? `https://www.google.com/maps/dir/?api=1&destination=${coords}&travelmode=driving`
    : `https://www.google.com/maps/dir/?api=1&destination=${address}&travelmode=driving`;

  // Apple Maps - only on iOS
  const appleUrl = hasCoords
    ? `maps://?daddr=${coords}&dirflg=d`
    : `maps://?daddr=${address}&dirflg=d`;

  // Default click - one-tap to most popular option (Waze in Israel)
  const handleClick = (e) => {
    e.stopPropagation();
    // If alt-clicked or long pressed, show menu. Otherwise open Waze directly.
    if (e.altKey || e.ctrlKey) {
      setOpen(true);
    } else {
      window.open(wazeUrl, '_blank');
    }
  };

  const sizeClass = size === 'sm'
    ? 'px-2 py-1 text-xs'
    : 'px-3 py-2 text-sm';

  return (
    <div className="relative inline-block">
      <button
        onClick={handleClick}
        onContextMenu={(e) => { e.preventDefault(); setOpen(true); }}
        className={`inline-flex items-center gap-1.5 ${sizeClass} bg-blue-600 text-white rounded-lg hover:bg-blue-700 ${className}`}
        title="קליק = Waze · קליק ימני = בחר אפליקציה"
      >
        <Navigation size={size === 'sm' ? 12 : 14} />
        {label}
        <button
          onClick={(e) => { e.stopPropagation(); setOpen(true); }}
          className="opacity-60 hover:opacity-100 mr-1"
          aria-label="עוד אופציות"
        >
          ▾
        </button>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 right-0 bg-white border border-gray-200 rounded-lg shadow-xl min-w-[200px] overflow-hidden">
            <div className="px-3 py-2 border-b text-xs text-gray-500 flex items-center justify-between">
              נווט באמצעות:
              <button onClick={() => setOpen(false)}><X size={12} /></button>
            </div>
            <a
              href={wazeUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 border-b"
            >
              <span className="text-2xl">🚗</span>
              <div>
                <div className="font-bold">Waze</div>
                <div className="text-[10px] text-gray-500">מומלץ - תנועה חיה</div>
              </div>
            </a>
            <a
              href={googleUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 border-b"
            >
              <span className="text-2xl">🗺️</span>
              <div>
                <div className="font-bold">Google Maps</div>
                <div className="text-[10px] text-gray-500">תאימות מלאה</div>
              </div>
            </a>
            {isIOS && (
              <a
                href={appleUrl}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50"
              >
                <span className="text-2xl">🍎</span>
                <div>
                  <div className="font-bold">Apple Maps</div>
                  <div className="text-[10px] text-gray-500">iPhone</div>
                </div>
              </a>
            )}
            {!hasCoords && (
              <div className="px-3 py-1.5 text-[10px] text-amber-700 bg-amber-50 border-t">
                ⚠ אין קואורדינטות - חיפוש לפי כתובת בלבד
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Build a multi-stop Waze URL from a list of stops (in order).
 * Waze supports up to 1 destination per click - so we open the first pending,
 * but can build a Google Maps URL with all waypoints.
 */
export function buildMultiStopGoogleUrl(stops) {
  if (!stops || stops.length === 0) return null;
  const points = stops
    .map((s) => s.Lat && s.Lng
      ? `${s.Lat},${s.Lng}`
      : encodeURIComponent(`${s.Street || ''} ${s.BuildingNumber || ''}, ${s.City || ''}`)
    )
    .filter(Boolean);
  if (points.length === 0) return null;
  const destination = points[points.length - 1];
  const waypoints = points.slice(0, -1).join('|');
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}` +
    (waypoints ? `&waypoints=${waypoints}` : '') + '&travelmode=driving';
}
