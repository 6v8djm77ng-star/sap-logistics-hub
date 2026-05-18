/**
 * SendToPickingModal — Commit 3a (preview only).
 *
 * Replaces the legacy window.confirm in OpenOrdersPage. Calls
 * /api/runs/from-selected-orders/preview on open, shows a structured
 * preview (per-zone breakdown, reuse vs create, unassigned warning,
 * ALREADY_ASSIGNED conflict table). The "אשר ושלח" button is rendered
 * but kept inert in 3a — Commit 3b will wire the real submit, progress
 * surfacing, and Idempotency-Key.
 *
 * Errors:
 *   - 409 ALREADY_ASSIGNED → conflict table with existing run/wave links
 *   - 400 ORDERS_MISSING   → explicit notice (refresh-from-SAP cue)
 *   - other (incl. network) → generic error card + retry button
 */
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  X, Loader2, AlertTriangle, Send, MapPin, Truck, Info,
} from 'lucide-react';
import { runsApi } from '../services/api.js';

export default function SendToPickingModal({ open, orderRefs, onClose }) {
  const [errorBody, setErrorBody] = useState(null);

  const previewMutation = useMutation({
    mutationFn: () => runsApi.previewFromSelectedOrders({ orders: orderRefs || [] }),
    onSuccess: () => setErrorBody(null),
    onError: (err) => {
      setErrorBody(
        err.response?.data || { error: err.message || 'שגיאת רשת', code: 'NETWORK_ERROR' }
      );
    },
  });

  // Refire preview whenever the modal opens or the selection changes.
  // JSON.stringify is fine here — the refs list is small (max 500 entries
  // by the backend guard) and we only want to detect identity changes.
  useEffect(() => {
    if (open && Array.isArray(orderRefs) && orderRefs.length > 0) {
      setErrorBody(null);
      previewMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, JSON.stringify(orderRefs || [])]);

  if (!open) return null;

  const preview = previewMutation.data;
  const isLoading = previewMutation.isPending;
  const hasError = !!errorBody;
  const conflicts = errorBody?.code === 'ALREADY_ASSIGNED' ? errorBody.conflicts : null;
  const ordersMissing = errorBody?.code === 'ORDERS_MISSING' ? errorBody.missing : null;
  const canConfirm = !isLoading && !hasError && preview && (preview.summary?.ordersAssigned || 0) > 0;

  const totalStops = (preview?.runsPreview || []).reduce((sum, r) => sum + (r.stopCount || 0), 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Send size={18} className="text-emerald-600" />
              תצוגה מקדימה לשליחה לליקוט
            </h2>
            <div className="text-xs text-gray-500 mt-1">
              {orderRefs?.length || 0} הזמנות נבחרו
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg"
            aria-label="סגור"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {isLoading && (
            <div className="text-center py-12 text-gray-500">
              <Loader2 size={32} className="animate-spin mx-auto mb-3" />
              <div className="text-sm">טוען תצוגה מקדימה...</div>
            </div>
          )}

          {!isLoading && conflicts && (
            <ConflictsView conflicts={conflicts} />
          )}

          {!isLoading && ordersMissing && !conflicts && (
            <OrdersMissingView count={ordersMissing.length} />
          )}

          {!isLoading && hasError && !conflicts && !ordersMissing && (
            <GenericErrorView
              errorBody={errorBody}
              onRetry={() => previewMutation.mutate()}
            />
          )}

          {!isLoading && !hasError && preview && (
            <PreviewView preview={preview} totalStops={totalStops} />
          )}

          {/* Commit 3a tag — explains that "Confirm" is intentionally inert */}
          {!isLoading && !hasError && preview && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800 flex items-start gap-2">
              <Info size={14} className="flex-shrink-0 mt-0.5" />
              <span>
                שלב 3a — תצוגה מקדימה בלבד. לחצן "אשר ושלח" יהפוך פעיל ב-Commit 3b
                (יוסיף את ה-progress + Idempotency-Key).
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-white"
          >
            בטל
          </button>
          <button
            disabled={!canConfirm}
            onClick={() => toast.info('שליחה בפועל תתווסף ב-Commit 3b')}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
            title="שליחה בפועל תתווסף ב-Commit 3b"
          >
            <Send size={14} />
            אשר ושלח (Commit 3b)
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Sub-views — kept inline rather than separate files since they only
// belong to this modal and are not used elsewhere.
// ──────────────────────────────────────────────────────────────────────

function PreviewView({ preview, totalStops }) {
  return (
    <>
      {/* Stat tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat label="הזמנות נבחרו" value={preview.selectedCount} color="blue" />
        <Stat
          label="מסלולים"
          value={preview.runsPreview?.length || 0}
          color="emerald"
          sub={`${preview.summary.runsToCreate} חדשים · ${preview.summary.runsToReuse} קיימים`}
        />
        <Stat label="תחנות" value={totalStops} color="purple" />
        <Stat label="הזמנות משויכות" value={preview.summary.ordersAssigned} color="gray" />
      </div>

      {/* Unassigned warning */}
      {preview.unassigned && preview.unassigned.length > 0 && (
        <UnassignedWarning unassigned={preview.unassigned} />
      )}

      {/* Per-zone breakdown */}
      <div>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <Truck size={14} /> פירוט לפי אזור
        </h3>
        <div className="space-y-2">
          {(preview.runsPreview || []).map((r) => (
            <ZoneCard key={r.zoneCode} run={r} />
          ))}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, color, sub }) {
  const palette = {
    blue:    'bg-blue-50    border-blue-200    text-blue-700    text-blue-900',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700 text-emerald-900',
    purple:  'bg-purple-50  border-purple-200  text-purple-700  text-purple-900',
    gray:    'bg-gray-50    border-gray-200    text-gray-700    text-gray-900',
  }[color] || 'bg-gray-50 border-gray-200 text-gray-700 text-gray-900';
  const [bg, border, labelClr, valueClr] = palette.split(/\s+/);
  return (
    <div className={`${bg} ${border} border rounded-lg p-2 text-center`}>
      <div className={`text-xs ${labelClr}`}>{label}</div>
      <div className={`text-2xl font-bold ${valueClr}`}>{value}</div>
      {sub && <div className={`text-xs ${labelClr} mt-0.5`}>{sub}</div>}
    </div>
  );
}

function ZoneCard({ run }) {
  return (
    <div className="border border-gray-200 rounded-lg p-3 flex items-center justify-between">
      <div>
        <div className="font-semibold text-sm">{run.zoneName}</div>
        <div className="text-xs text-gray-500 font-mono">{run.zoneCode}</div>
      </div>
      <div className="text-left">
        {run.wouldReuseExistingRunId ? (
          <div className="text-xs text-blue-700">
            <span className="font-semibold">+ צירוף ל-{run.wouldReuseExistingRunNumber}</span>
          </div>
        ) : (
          <div className="text-xs text-emerald-700 font-semibold">מסלול חדש</div>
        )}
        <div className="text-xs text-gray-600 mt-0.5">
          <MapPin size={10} className="inline ml-0.5" />
          {run.stopCount} תחנות · {run.orderCount} הזמנות
        </div>
      </div>
    </div>
  );
}

function UnassignedWarning({ unassigned }) {
  return (
    <div className="bg-amber-50 border border-amber-300 rounded-lg p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm flex-1">
          <div className="font-bold text-amber-900">
            {unassigned.length} הזמנות ללא אזור חלוקה
          </div>
          <div className="text-amber-700 text-xs mt-1">
            העיר אינה מופה לאזור — הן יישארו ברשימה הפתוחה ולא יישלחו לליקוט.
          </div>
          <ul className="mt-2 space-y-0.5 text-xs">
            {unassigned.slice(0, 5).map((u, i) => (
              <li key={i}>
                <span className="font-mono">#{u.docNum}</span> · {u.customerName} ·{' '}
                <span className="font-semibold">{u.city || 'ללא עיר'}</span>
              </li>
            ))}
            {unassigned.length > 5 && (
              <li className="text-amber-700">ועוד {unassigned.length - 5}…</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

function ConflictsView({ conflicts }) {
  return (
    <div className="space-y-3">
      <div className="bg-amber-50 border border-amber-300 rounded-lg p-3">
        <div className="flex items-start gap-2">
          <AlertTriangle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-bold text-amber-900">
              {conflicts.length} הזמנות כבר משויכות למסלול קיים
            </div>
            <div className="text-amber-700 text-xs mt-1">
              לא ניתן לשלוח לליקוט עד שתסיר את ההזמנות הללו מהבחירה או תבטל את המסלול הקיים.
            </div>
          </div>
        </div>
      </div>
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr>
              <th className="px-3 py-2 text-right font-medium">הזמנה</th>
              <th className="px-3 py-2 text-right font-medium">לקוח</th>
              <th className="px-3 py-2 text-right font-medium">מסלול קיים</th>
              <th className="px-3 py-2 text-right font-medium">סטטוס</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {conflicts.map((c) => (
              <tr key={c.key}>
                <td className="px-3 py-2 font-mono">#{c.docNum}</td>
                <td className="px-3 py-2">{c.cardName}</td>
                <td className="px-3 py-2 font-mono text-xs text-blue-700">
                  {c.existingRunNumber || '—'}
                </td>
                <td className="px-3 py-2 text-xs">
                  {c.existingRunStatus || '—'}
                  {c.existingWaveNumber && (
                    <span className="ml-1 px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded text-xs">
                      גל {c.existingWaveNumber}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OrdersMissingView({ count }) {
  return (
    <div className="bg-red-50 border border-red-300 rounded-lg p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm">
          <div className="font-bold text-red-900">{count} הזמנות לא נמצאו ב-SAP</div>
          <div className="text-red-700 text-xs mt-1">
            ייתכן שההזמנות נסגרו, בוטלו, או שונו לקו חלוקה אחר. רענן את הרשימה ונסה שוב.
          </div>
        </div>
      </div>
    </div>
  );
}

function GenericErrorView({ errorBody, onRetry }) {
  return (
    <div className="bg-red-50 border border-red-300 rounded-lg p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm flex-1">
          <div className="font-bold text-red-900">שגיאה בטעינת תצוגה מקדימה</div>
          <div className="text-red-700 text-xs mt-1">
            {errorBody.error || 'נסה שוב'}
            {errorBody.code && (
              <span className="ml-2 font-mono">({errorBody.code})</span>
            )}
          </div>
        </div>
      </div>
      <button
        onClick={onRetry}
        className="mt-3 px-3 py-1.5 text-sm border rounded-lg hover:bg-white"
      >
        נסה שוב
      </button>
    </div>
  );
}
