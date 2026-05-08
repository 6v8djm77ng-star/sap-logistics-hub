/**
 * Mobile-first failure reporting dialog for drivers.
 * Shows categorized reasons, enforces photo/notes when required.
 */
import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import api from '../services/api.js';
import { sendOrQueue } from '../services/offlineQueue.js';
import { toast } from 'sonner';
import { X, AlertTriangle, Camera, ChevronRight } from 'lucide-react';

const CATEGORY_LABELS = {
  CUSTOMER: '👤 לקוח',
  STORE: '🏪 חנות',
  ADDRESS: '📍 כתובת',
  GOODS: '📦 סחורה',
  OTHER: '⚠️ אחר',
};

export default function FailureReportDialog({ stopId, customerName, onClose, onReported }) {
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedReason, setSelectedReason] = useState(null);
  const [notes, setNotes] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState(null);
  const fileInputRef = useRef(null);

  const { data: reasons } = useQuery({
    queryKey: ['failure-reasons'],
    queryFn: () => api.get('/failures/reasons').then((r) => r.data.reasons),
    staleTime: 10 * 60_000,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await sendOrQueue('POST', '/failures/report', {
        stopId,
        reasonCode: selectedReason.ReasonCode,
        notes: notes || undefined,
        photoDataUrl: photoDataUrl || undefined,
      });
      return result;
    },
    onSuccess: (result) => {
      if (result.queued) {
        toast.info('נשמר בתור - יישלח כשיחזור חיבור');
      } else {
        toast.success('הכשל דווח למנהל הלוגיסטיקה');
      }
      onReported?.();
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה בדיווח'),
  });

  // Group reasons by category
  const byCategory = (reasons || []).reduce((acc, r) => {
    (acc[r.Category] ||= []).push(r);
    return acc;
  }, {});

  const handlePhotoCapture = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setPhotoDataUrl(ev.target.result);
    reader.readAsDataURL(file);
  };

  const canSubmit = selectedReason && (
    !selectedReason.RequiresNotes || notes.trim().length > 0
  ) && (
    !selectedReason.RequiresPhoto || photoDataUrl
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <AlertTriangle className="text-red-500" size={20} />
            <h2 className="font-bold">דיווח כשל במסירה</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        {customerName && (
          <div className="px-4 py-2 bg-gray-50 border-b text-sm">
            <span className="text-gray-500">לקוח:</span> <span className="font-medium">{customerName}</span>
          </div>
        )}

        <div className="flex-1 overflow-auto p-4">
          {!selectedCategory ? (
            /* Step 1: Choose category */
            <>
              <h3 className="text-sm font-medium mb-3">מה הסיבה לכשל?</h3>
              <div className="grid grid-cols-1 gap-2">
                {Object.keys(byCategory).map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className="flex items-center justify-between p-4 border-2 border-gray-200 rounded-xl text-right hover:border-brand-400 active:bg-brand-50"
                  >
                    <span className="text-gray-400"><ChevronRight /></span>
                    <div>
                      <div className="font-medium">{CATEGORY_LABELS[cat] || cat}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {byCategory[cat].length} סיבות
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : !selectedReason ? (
            /* Step 2: Choose specific reason */
            <>
              <button
                onClick={() => setSelectedCategory(null)}
                className="text-sm text-brand-600 mb-3 inline-flex items-center gap-1"
              >
                <ChevronRight size={14} /> חזרה לקטגוריות
              </button>
              <h3 className="text-sm font-medium mb-3">{CATEGORY_LABELS[selectedCategory]}</h3>
              <div className="space-y-2">
                {byCategory[selectedCategory].map((r) => (
                  <button
                    key={r.ReasonCode}
                    onClick={() => setSelectedReason(r)}
                    className="w-full p-3 border-2 border-gray-200 rounded-xl text-right hover:border-brand-400 active:bg-brand-50"
                  >
                    <div className="font-medium">{r.Name}</div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                      <span className={`px-1.5 py-0.5 rounded ${r.Severity === 'HIGH' ? 'bg-red-100 text-red-700' : r.Severity === 'MEDIUM' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100'}`}>
                        {r.Severity === 'HIGH' ? 'קריטי' : r.Severity === 'MEDIUM' ? 'בינוני' : 'נמוך'}
                      </span>
                      {r.RequiresPhoto && <span>📷 תמונה נדרשת</span>}
                      {r.RequiresNotes && <span>✏️ פירוט נדרש</span>}
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            /* Step 3: Add photo/notes */
            <>
              <button
                onClick={() => { setSelectedReason(null); setPhotoDataUrl(null); setNotes(''); }}
                className="text-sm text-brand-600 mb-3 inline-flex items-center gap-1"
              >
                <ChevronRight size={14} /> שנה סיבה
              </button>

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4">
                <div className="font-medium">{selectedReason.Name}</div>
                <div className="text-xs text-gray-600 mt-0.5">
                  {CATEGORY_LABELS[selectedReason.Category]}
                </div>
              </div>

              {/* Notes */}
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">
                  פירוט {selectedReason.RequiresNotes && <span className="text-red-500">*</span>}
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={selectedReason.RequiresNotes ? 'פרט מה קרה...' : 'פירוט נוסף (אופציונלי)'}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                  rows={3}
                />
              </div>

              {/* Photo */}
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">
                  תמונה {selectedReason.RequiresPhoto && <span className="text-red-500">*</span>}
                </label>
                {photoDataUrl ? (
                  <div className="relative">
                    <img src={photoDataUrl} alt="Preview" className="w-full rounded-lg border" />
                    <button
                      onClick={() => setPhotoDataUrl(null)}
                      className="absolute top-2 left-2 bg-red-500 text-white p-1 rounded-full"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full py-4 border-2 border-dashed border-gray-300 rounded-xl text-sm text-gray-500 inline-flex items-center justify-center gap-2 active:bg-gray-50"
                  >
                    <Camera size={18} /> צלם / העלה תמונה
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoCapture}
                  className="hidden"
                />
              </div>
            </>
          )}
        </div>

        {selectedReason && (
          <div className="p-4 border-t bg-gray-50">
            <button
              onClick={() => mutation.mutate()}
              disabled={!canSubmit || mutation.isPending}
              className="w-full py-3 bg-red-600 text-white rounded-xl font-medium disabled:opacity-50 active:bg-red-700"
            >
              {mutation.isPending ? 'שולח דיווח...' : 'שלח דיווח כשל'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
