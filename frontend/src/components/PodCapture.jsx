/**
 * Proof of Delivery (POD) capture - photo + signature + GPS + notes.
 * Used by drivers when completing a stop.
 */
import { useState, useRef, useEffect } from 'react';
import SignaturePad from './SignaturePad.jsx';
import api from '../services/api.js';
import { Camera, MapPin, X, Check, RotateCcw, Loader2, AlertTriangle, PackageX, Package } from 'lucide-react';

export default function PodCapture({ stop, onComplete, onClose }) {
  const [photo, setPhoto] = useState(null); // dataURL
  const [showSig, setShowSig] = useState(false);
  const [signature, setSignature] = useState(null);
  const [notes, setNotes] = useState('');
  const [gps, setGps] = useState(null);
  const [gpsStatus, setGpsStatus] = useState('idle');
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef(null);

  // Per-line delivery state: { allocationId → { delivered, damaged, missing, notes } }
  // Lines come from the stop's orders (each runOrder has aggregated qty).
  const initialLines = (stop.orders || []).flatMap((ord) =>
    (ord.lines || [{ AllocationId: ord.RunOrderId, ItemCode: '_total_', ItemName: ord.SapCardName, Quantity: ord.LinesCount }])
      .map((ln) => ({
        allocationId: ln.AllocationId || `${ord.RunOrderId}-${ln.LineNum || 0}`,
        itemCode: ln.ItemCode || ord.SapCardName,
        itemName: ln.ItemName || ord.SapCardName,
        orderedQty: Number(ln.Quantity || ln.OpenQty || ord.LinesCount || 1),
        deliveredQty: Number(ln.Quantity || ln.OpenQty || ord.LinesCount || 1),
        damagedQty: 0,
        missingQty: 0,
        notes: '',
      }))
  );
  const [lines, setLines] = useState(initialLines);
  const [showLineDetail, setShowLineDetail] = useState(false);
  const hasIssues = lines.some((l) => l.damagedQty > 0 || l.missingQty > 0 || l.deliveredQty < l.orderedQty);

  // Get GPS on mount
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsStatus('unavailable');
      return;
    }
    setGpsStatus('loading');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        });
        setGpsStatus('ok');
      },
      () => setGpsStatus('denied'),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 }
    );
  }, []);

  const handlePhotoSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      // Compress image - draw onto a canvas at max 1280px wide
      const img = new Image();
      img.onload = () => {
        const maxW = 1280;
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        setPhoto(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const updateLine = (idx, patch) => {
    setLines((arr) => arr.map((l, i) => {
      if (i !== idx) return l;
      const next = { ...l, ...patch };
      // Auto-balance: delivered + damaged + missing should equal ordered
      const ordered = Number(next.orderedQty || 0);
      const delivered = Math.max(0, Math.min(ordered, Number(next.deliveredQty || 0)));
      const damaged = Math.max(0, Math.min(ordered - delivered, Number(next.damagedQty || 0)));
      const missing = Math.max(0, ordered - delivered - damaged);
      return { ...next, deliveredQty: delivered, damagedQty: damaged, missingQty: missing };
    }));
  };

  const submit = async () => {
    if (!signature) {
      alert('חובה לקבל חתימה');
      return;
    }
    setSubmitting(true);
    try {
      // Persist per-line delivery records (partial / damaged) before completing the stop
      if (lines.length > 0 && hasIssues) {
        try {
          await api.post(`/stops/${stop.StopId}/line-deliveries`, { items: lines });
        } catch (e) {
          console.warn('[POD] line-deliveries save failed:', e.message);
        }
      }
      await onComplete({
        signatureDataUrl: signature,
        photoDataUrl: photo,
        notes: notes || null,
        gps,
        capturedAt: new Date().toISOString(),
        lineDeliveries: lines,
        hasIssues,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-0 md:p-4">
      <div className="bg-white rounded-t-3xl md:rounded-2xl max-w-md w-full max-h-[95vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="font-bold text-lg">סיום מסירה</h2>
            <p className="text-xs text-gray-500">{stop.BranchName} · {stop.City}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* GPS status */}
          <div className={`flex items-center gap-2 p-2 rounded-lg text-sm ${
            gpsStatus === 'ok' ? 'bg-green-50 text-green-800 border border-green-200' :
            gpsStatus === 'loading' ? 'bg-blue-50 text-blue-800' :
            'bg-amber-50 text-amber-800 border border-amber-200'
          }`}>
            <MapPin size={16} />
            {gpsStatus === 'ok' && (
              <span>GPS תקין · דיוק {Math.round(gps.accuracy)}מ׳</span>
            )}
            {gpsStatus === 'loading' && (
              <span className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> מאתר מיקום...</span>
            )}
            {gpsStatus === 'denied' && <span>הגישה ל-GPS נדחתה - אישור חובה</span>}
            {gpsStatus === 'unavailable' && <span>GPS לא זמין במכשיר</span>}
          </div>

          {/* Photo */}
          <div>
            <label className="block text-sm font-bold mb-2">📸 תמונת מסירה (חובה)</label>
            {photo ? (
              <div className="relative">
                <img src={photo} alt="POD" className="w-full rounded-lg border" />
                <button
                  onClick={() => { setPhoto(null); fileInputRef.current && (fileInputRef.current.value = ''); }}
                  className="absolute top-2 left-2 p-1.5 bg-red-600 text-white rounded-full"
                  title="צלם שוב"
                >
                  <RotateCcw size={14} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-12 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center gap-2 hover:bg-gray-50"
              >
                <Camera size={32} className="text-gray-400" />
                <span className="text-sm text-gray-600">לחץ לצילום / בחירה מהגלריה</span>
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handlePhotoSelect}
              className="hidden"
            />
          </div>

          {/* Signature */}
          <div>
            <label className="block text-sm font-bold mb-2">✍️ חתימת לקוח (חובה)</label>
            {signature ? (
              <div className="relative">
                <img src={signature} alt="Signature" className="w-full max-h-32 object-contain border rounded-lg bg-white" />
                <button
                  onClick={() => setSignature(null)}
                  className="absolute top-2 left-2 p-1.5 bg-red-600 text-white rounded-full"
                  title="חתום שוב"
                >
                  <RotateCcw size={14} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowSig(true)}
                className="w-full py-6 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center gap-2 hover:bg-gray-50"
              >
                <span className="text-3xl">✍️</span>
                <span className="text-sm text-gray-600">לחץ כדי לחתום</span>
              </button>
            )}
          </div>

          {/* Per-line delivery (partial / damaged) */}
          {lines.length > 0 && (
            <div>
              <button
                onClick={() => setShowLineDetail((v) => !v)}
                className={`w-full px-3 py-2.5 rounded-lg text-sm font-bold flex items-center justify-between border-2 ${
                  hasIssues
                    ? 'bg-amber-50 border-amber-400 text-amber-900'
                    : 'bg-green-50 border-green-300 text-green-800'
                }`}
              >
                <span className="flex items-center gap-2">
                  {hasIssues ? <AlertTriangle size={16} /> : <Check size={16} />}
                  {hasIssues ? `יש בעיות במסירה (${lines.filter((l) => l.deliveredQty < l.orderedQty).length})` : 'הכל נמסר תקין'}
                </span>
                <span className="text-xs">{showLineDetail ? '▲ סגור' : '▼ ערוך'}</span>
              </button>
              {showLineDetail && (
                <div className="mt-2 space-y-2 max-h-72 overflow-y-auto bg-gray-50 rounded-lg p-2">
                  {lines.map((line, idx) => {
                    const isFull = line.deliveredQty >= line.orderedQty;
                    const isDamaged = line.damagedQty > 0;
                    const isMissing = line.missingQty > 0;
                    return (
                      <div
                        key={line.allocationId}
                        className={`p-2 rounded border-2 ${
                          isDamaged ? 'border-red-300 bg-red-50' :
                          isMissing ? 'border-amber-300 bg-amber-50' :
                          isFull ? 'border-green-300 bg-white' :
                          'border-gray-200 bg-white'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-sm truncate">{line.itemName}</div>
                            {line.itemCode !== '_total_' && (
                              <div className="text-[10px] text-gray-500 font-mono">{line.itemCode}</div>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 shrink-0">הזמין: <span className="font-bold text-gray-900">{line.orderedQty}</span></div>
                        </div>
                        <div className="grid grid-cols-3 gap-1.5 text-xs">
                          <label className="flex flex-col">
                            <span className="text-green-700 mb-0.5">✓ נמסר</span>
                            <input
                              type="number"
                              min="0"
                              max={line.orderedQty}
                              value={line.deliveredQty}
                              onChange={(e) => updateLine(idx, { deliveredQty: Number(e.target.value) })}
                              className="px-2 py-1 border-2 border-green-300 rounded font-bold text-center"
                            />
                          </label>
                          <label className="flex flex-col">
                            <span className="text-red-700 mb-0.5">⚠ פגום</span>
                            <input
                              type="number"
                              min="0"
                              max={line.orderedQty - line.deliveredQty}
                              value={line.damagedQty}
                              onChange={(e) => updateLine(idx, { damagedQty: Number(e.target.value) })}
                              className="px-2 py-1 border-2 border-red-300 rounded font-bold text-center"
                            />
                          </label>
                          <label className="flex flex-col">
                            <span className="text-amber-700 mb-0.5">✗ חסר</span>
                            <input
                              type="number"
                              min="0"
                              max={line.orderedQty}
                              value={line.missingQty}
                              readOnly
                              className="px-2 py-1 border-2 border-amber-300 rounded font-bold text-center bg-amber-50 text-amber-800"
                            />
                          </label>
                        </div>
                        {(isDamaged || isMissing) && (
                          <input
                            type="text"
                            placeholder="הסבר (לדוגמה: הארגז שבור, הלקוח דחה)"
                            value={line.notes}
                            onChange={(e) => updateLine(idx, { notes: e.target.value })}
                            className="w-full mt-1.5 px-2 py-1 border rounded text-xs"
                          />
                        )}
                      </div>
                    );
                  })}
                  <div className="text-[10px] text-gray-500 mt-1 px-1">
                    💡 לחוסר/פגום ייווצר אוטומטית בקשת זיכוי. הסחורה הפגומה תחזור למחסן 99.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-sm font-bold mb-1">הערות (לא חובה)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="לדוגמה: השארתי עם השכן בקומה 3"
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>
        </div>

        <div className="p-3 border-t bg-gray-50 flex gap-2">
          <button onClick={onClose} disabled={submitting} className="flex-1 py-3 border rounded-lg">
            ביטול
          </button>
          <button
            onClick={submit}
            disabled={!photo || !signature || submitting}
            className="flex-1 py-3 bg-green-600 text-white rounded-lg font-bold disabled:opacity-50 inline-flex items-center justify-center gap-1"
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
            סיים מסירה
          </button>
        </div>

        {showSig && (
          <SignaturePad
            onSave={(dataUrl) => { setSignature(dataUrl); setShowSig(false); }}
            onClose={() => setShowSig(false)}
          />
        )}
      </div>
    </div>
  );
}
