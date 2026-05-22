/**
 * SendToPickingModal — Commit 3b (real submit + progress).
 *
 * Flow lives in this single component:
 *   1. open  → mint a fresh Idempotency-Key (one per modal opening),
 *              fetch /api/runs/from-selected-orders/preview, show the
 *              structured preview (per-zone, reuse/create, unassigned,
 *              conflicts).
 *   2. אשר ושלח → phase='submitting': POST /api/runs/from-selected-orders
 *              with the same Idempotency-Key (so a double-click or network
 *              retry replays the backend's prior response rather than
 *              double-creating runs), then sequentially POST /runs/:id/wave
 *              per created run. Each wave update bumps the progress counter
 *              so the operator sees "בונה גל N/M…".
 *   3. done   → summary card with runs/waves built + failed, per-run rows,
 *              "פתח גל ליקוט ראשון" button. The modal stays open until the
 *              operator dismisses it.
 *   4. error  → submission-level error card with a retry button (same
 *              Idempotency-Key, so the backend may replay the cached
 *              response if the prior request actually went through).
 *
 * Errors handled separately at the preview step:
 *   - 409 ALREADY_ASSIGNED → conflict table with existing run/wave links
 *   - 400 ORDERS_MISSING   → explicit notice (refresh-from-SAP cue)
 *   - other (incl. network) → generic error card + retry button
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  X, Loader2, AlertTriangle, Send, MapPin, Truck, CheckCircle2, ChevronLeft, User,
} from 'lucide-react';
import { runsApi, pickableUsersApi } from '../services/api.js';

// Phase machine — kept as plain strings so the JSX can switch on them
// without a state-machine library. Order: preview → submitting → done|error.
const PHASE_PREVIEW    = 'preview';
const PHASE_SUBMITTING = 'submitting';
const PHASE_DONE       = 'done';
const PHASE_ERROR      = 'error';

// crypto.randomUUID is available in every browser this app targets
// (Chrome 92+, Firefox 95+, Safari 15.4+). Tiny fallback retained just so
// a stale browser does not lose idempotency protection entirely.
function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export default function SendToPickingModal({ open, orderRefs, onClose }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [phase, setPhase]             = useState(PHASE_PREVIEW);
  const [errorBody, setErrorBody]     = useState(null);           // preview-step errors only
  const [idempotencyKey, setKey]      = useState(null);
  const [progress, setProgress]       = useState({ runsTotal: 0, wavesBuilt: 0, wavesFailed: 0, currentStep: '' });
  const [finalResult, setFinalResult] = useState(null);           // { runsCreated, waveResults, summary, unassigned }
  const [finalError, setFinalError]   = useState(null);           // submit-step error body
  // Per-zone picker assignment: { [zoneCode]: userId }. Cleared on each
  // modal open so a previous selection can't bleed into a new submit.
  const [pickerByZoneCode, setPickerByZoneCode] = useState({});

  // List of users the planner can assign as the picker for a zone. Fetched
  // once on mount + on each modal open. The query is cheap (≤ a few rows).
  const pickableUsersQuery = useQuery({
    queryKey: ['pickable-users'],
    queryFn:  pickableUsersApi.list,
    enabled:  open,
    staleTime: 60_000,
  });
  const pickableUsers = pickableUsersQuery.data || [];

  const previewMutation = useMutation({
    mutationFn: () => runsApi.previewFromSelectedOrders({ orders: orderRefs || [] }),
    onSuccess: () => setErrorBody(null),
    onError: (err) => {
      setErrorBody(
        err.response?.data || { error: err.message || 'שגיאת רשת', code: 'NETWORK_ERROR' }
      );
    },
  });

  // Refire preview whenever the modal opens or the selection changes. Also
  // mint a brand-new Idempotency-Key per opening so a previous successful
  // submit can never replay-merge into a new selection.
  useEffect(() => {
    if (open && Array.isArray(orderRefs) && orderRefs.length > 0) {
      setPhase(PHASE_PREVIEW);
      setErrorBody(null);
      setFinalResult(null);
      setFinalError(null);
      setProgress({ runsTotal: 0, wavesBuilt: 0, wavesFailed: 0, currentStep: '' });
      setKey(newIdempotencyKey());
      setPickerByZoneCode({});
      previewMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, JSON.stringify(orderRefs || [])]);

  if (!open) return null;

  const preview        = previewMutation.data;
  const isLoading      = previewMutation.isPending;
  const hasPreviewError = !!errorBody;
  const conflicts      = errorBody?.code === 'ALREADY_ASSIGNED' ? errorBody.conflicts : null;
  const ordersMissing  = errorBody?.code === 'ORDERS_MISSING' ? errorBody.missing : null;

  // Confirm is allowed only when: we're in the preview phase, the preview
  // succeeded, there are no conflicts, no missing orders, and at least one
  // order is in a recognized zone (ordersAssigned > 0). Per-zone-picker-
  // assignment (2026-05-21) adds a final gate — every runsPreview row must
  // have a picker assigned in pickerByZoneCode.
  const runsPreviewRows = preview?.runsPreview || [];
  const everyZoneHasPicker =
    runsPreviewRows.length > 0 &&
    runsPreviewRows.every((r) => pickerByZoneCode[r.zoneCode]);
  const canConfirm =
    phase === PHASE_PREVIEW &&
    !isLoading &&
    !hasPreviewError &&
    preview &&
    (preview.summary?.ordersAssigned || 0) > 0 &&
    everyZoneHasPicker;

  const totalStops = (preview?.runsPreview || []).reduce((sum, r) => sum + (r.stopCount || 0), 0);

  async function handleConfirm() {
    if (!canConfirm || !idempotencyKey) return;
    setPhase(PHASE_SUBMITTING);
    setProgress({ runsTotal: 0, wavesBuilt: 0, wavesFailed: 0, currentStep: 'יוצר מסלולים…' });

    let submitResult;
    try {
      submitResult = await runsApi.fromSelectedOrders({ orders: orderRefs }, idempotencyKey);
    } catch (err) {
      setFinalError(err.response?.data || { error: err.message || 'שגיאת רשת', code: 'NETWORK_ERROR' });
      setPhase(PHASE_ERROR);
      return;
    }

    const runsCreated = submitResult.runsCreated || [];
    const waveResults = [];
    setProgress({ runsTotal: runsCreated.length, wavesBuilt: 0, wavesFailed: 0, currentStep: 'בונה גלי ליקוט…' });

    // Sequential — SAP-friendly + lets us update the progress bar one wave
    // at a time. Parallel would shave seconds at the cost of harder error
    // surfacing and heavier SAP load.
    //
    // Per-zone-picker-assignment: pair each created run with the picker
    // the planner selected for its zone. The submit response carries
    // zoneCode on each runsCreated[i], which keys back into pickerByZoneCode.
    for (let i = 0; i < runsCreated.length; i++) {
      const run = runsCreated[i];
      const assignedPickerId = pickerByZoneCode[run.zoneCode] || null;
      setProgress((prev) => ({ ...prev, currentStep: `בונה גל ליקוט ${i + 1}/${runsCreated.length}…` }));
      try {
        const wave = await runsApi.buildWave(run.runId, assignedPickerId ? { assignedPickerId } : undefined);
        waveResults.push({
          runId: run.runId, runNumber: run.runNumber, zoneName: run.zoneName, zoneCode: run.zoneCode,
          reusedExisting: !!run.reusedExisting, stopCount: run.stopCount, orderCount: run.orderCount,
          waveId: wave?.WaveId || null, waveNumber: wave?.WaveNumber || null, error: null,
        });
        setProgress((prev) => ({ ...prev, wavesBuilt: prev.wavesBuilt + 1 }));
      } catch (waveErr) {
        waveResults.push({
          runId: run.runId, runNumber: run.runNumber, zoneName: run.zoneName, zoneCode: run.zoneCode,
          reusedExisting: !!run.reusedExisting, stopCount: run.stopCount, orderCount: run.orderCount,
          waveId: null, waveNumber: null,
          error: waveErr.response?.data?.error || waveErr.message || 'שגיאה לא ידועה',
        });
        setProgress((prev) => ({ ...prev, wavesFailed: prev.wavesFailed + 1 }));
      }
    }

    setFinalResult({
      runsCreated, waveResults,
      summary: submitResult.summary || {},
      unassigned: submitResult.unassigned || [],
    });
    setPhase(PHASE_DONE);

    // Refresh adjacent caches so OpenOrdersPage sees the new state when
    // the modal is dismissed. Runs are also invalidated for RunsPage.
    queryClient.invalidateQueries({ queryKey: ['open-orders'] });
    queryClient.invalidateQueries({ queryKey: ['orders-with-plan-eval'] });
    queryClient.invalidateQueries({ queryKey: ['runs'] });
  }

  function handleOpenFirstWave() {
    const firstWave = (finalResult?.waveResults || []).find((w) => w.waveId);
    if (firstWave) navigate(`/picking/${firstWave.waveId}`);
  }

  function handleClose() {
    // Block close mid-submit so we don't leave the user wondering whether
    // the run was created. Header X + footer "סגור" both call this.
    if (phase === PHASE_SUBMITTING) return;
    // Tell the parent whether a real submit happened. Only PHASE_DONE
    // means runs were actually created — PHASE_ERROR is "POST rejected
    // before any state changed" (e.g. ALREADY_ASSIGNED) and PHASE_PREVIEW
    // close is a plain cancel. The parent uses this to decide whether to
    // clear the checkbox selection.
    onClose?.({ submitted: phase === PHASE_DONE });
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Send size={18} className={phase === PHASE_DONE ? 'text-emerald-600' : phase === PHASE_ERROR ? 'text-red-600' : 'text-emerald-600'} />
              {phase === PHASE_DONE   ? 'נשלח לליקוט' :
               phase === PHASE_ERROR  ? 'שגיאה בשליחה' :
                                        'תצוגה מקדימה לשליחה לליקוט'}
            </h2>
            <div className="text-xs text-gray-500 mt-1">
              {orderRefs?.length || 0} הזמנות נבחרו
            </div>
          </div>
          <button
            onClick={handleClose}
            disabled={phase === PHASE_SUBMITTING}
            className="p-1.5 hover:bg-gray-100 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="סגור"
            title={phase === PHASE_SUBMITTING ? 'לא ניתן לסגור באמצע שליחה' : 'סגור'}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {/* PREVIEW phase */}
          {phase === PHASE_PREVIEW && isLoading && (
            <div className="text-center py-12 text-gray-500">
              <Loader2 size={32} className="animate-spin mx-auto mb-3" />
              <div className="text-sm">טוען תצוגה מקדימה...</div>
            </div>
          )}
          {phase === PHASE_PREVIEW && !isLoading && conflicts && (
            <ConflictsView conflicts={conflicts} />
          )}
          {phase === PHASE_PREVIEW && !isLoading && ordersMissing && !conflicts && (
            <OrdersMissingView count={ordersMissing.length} />
          )}
          {phase === PHASE_PREVIEW && !isLoading && hasPreviewError && !conflicts && !ordersMissing && (
            <GenericErrorView
              title="שגיאה בטעינת תצוגה מקדימה"
              errorBody={errorBody}
              onRetry={() => previewMutation.mutate()}
            />
          )}
          {phase === PHASE_PREVIEW && !isLoading && !hasPreviewError && preview && (
            <PreviewView
              preview={preview}
              totalStops={totalStops}
              pickableUsers={pickableUsers}
              pickersLoading={pickableUsersQuery.isLoading}
              pickersError={pickableUsersQuery.error}
              pickerByZoneCode={pickerByZoneCode}
              onPickerChange={(zoneCode, userId) =>
                setPickerByZoneCode((prev) => ({ ...prev, [zoneCode]: userId }))
              }
            />
          )}

          {/* SUBMITTING phase */}
          {phase === PHASE_SUBMITTING && (
            <SubmittingView progress={progress} />
          )}

          {/* DONE phase */}
          {phase === PHASE_DONE && finalResult && (
            <DoneView result={finalResult} />
          )}

          {/* ERROR phase (submit-step only — preview errors render inline above) */}
          {phase === PHASE_ERROR && finalError && (
            <GenericErrorView
              title="שגיאה בשליחה לליקוט"
              errorBody={finalError}
              onRetry={() => handleConfirm()}
              retryLabel="נסה שוב (אותו Idempotency-Key)"
            />
          )}
        </div>

        {/* Footer — buttons change with the phase */}
        <div className="flex items-center justify-end gap-2 p-4 border-t bg-gray-50">
          {phase === PHASE_PREVIEW && (
            <>
              <button onClick={handleClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-white">
                בטל
              </button>
              <button
                disabled={!canConfirm}
                onClick={handleConfirm}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send size={14} />
                אשר ושלח ({preview?.summary?.ordersAssigned ?? 0})
              </button>
            </>
          )}
          {phase === PHASE_SUBMITTING && (
            <button
              disabled
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg opacity-60 cursor-not-allowed"
            >
              <Loader2 size={14} className="animate-spin" />
              שולח...
            </button>
          )}
          {phase === PHASE_DONE && (
            <>
              <button onClick={handleClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-white">
                סגור
              </button>
              {(finalResult?.waveResults || []).some((w) => w.waveId) && (
                <button
                  onClick={handleOpenFirstWave}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700"
                >
                  <ChevronLeft size={14} />
                  פתח גל ליקוט ראשון
                </button>
              )}
            </>
          )}
          {phase === PHASE_ERROR && (
            <button onClick={handleClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-white">
              סגור
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Sub-views
// ──────────────────────────────────────────────────────────────────────

function PreviewView({
  preview, totalStops,
  pickableUsers, pickersLoading, pickersError,
  pickerByZoneCode, onPickerChange,
}) {
  return (
    <>
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

      {preview.unassigned && preview.unassigned.length > 0 && (
        <UnassignedWarning unassigned={preview.unassigned} />
      )}

      <div>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <Truck size={14} /> פירוט לפי אזור — בחר מלקט לכל אזור
        </h3>
        {pickersError && (
          <div className="bg-amber-50 border border-amber-300 text-amber-800 text-xs rounded p-2 mb-2">
            לא ניתן לטעון רשימת מלקטים. נסה לרענן את העמוד.
          </div>
        )}
        <div className="space-y-2">
          {(preview.runsPreview || []).map((r) => (
            <ZoneCard
              key={r.zoneCode}
              run={r}
              pickableUsers={pickableUsers}
              pickersLoading={pickersLoading}
              selectedPickerId={pickerByZoneCode[r.zoneCode] || ''}
              onPickerChange={(userId) => onPickerChange(r.zoneCode, userId)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function SubmittingView({ progress }) {
  const { runsTotal, wavesBuilt, wavesFailed, currentStep } = progress;
  const wavesTouched = wavesBuilt + wavesFailed;
  const pct = runsTotal > 0 ? Math.round((wavesTouched / runsTotal) * 100) : 0;
  return (
    <div className="py-8 space-y-4">
      <div className="text-center">
        <Loader2 size={36} className="animate-spin mx-auto mb-3 text-emerald-600" />
        <div className="text-sm font-medium">{currentStep || 'שולח...'}</div>
      </div>
      {runsTotal > 0 && (
        <div className="px-2">
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-gray-600">
            <span>{wavesTouched} / {runsTotal} גלי ליקוט</span>
            {wavesFailed > 0 && <span className="text-red-700">{wavesFailed} נכשלו</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function DoneView({ result }) {
  const { runsCreated = [], waveResults = [], summary = {}, unassigned = [] } = result;
  const wavesBuilt  = waveResults.filter((w) => w.waveId).length;
  const wavesFailed = waveResults.filter((w) => !w.waveId).length;
  const allWavesOk  = wavesBuilt === runsCreated.length;
  const partial     = wavesBuilt > 0 && wavesFailed > 0;
  // The real submit returns summary.runsCreated / summary.runsReused (counts),
  // while the preview returns summary.runsToCreate / summary.runsToReuse.
  // Support both shapes so the banner is correct regardless of which one
  // populates `result.summary`.
  const reusedCount  = summary.runsReused  ?? summary.runsToReuse  ?? 0;
  const createdCount = summary.runsCreated ?? summary.runsToCreate ?? 0;

  return (
    <div className="space-y-3">
      <div className={`rounded-lg p-3 border ${
        allWavesOk ? 'bg-emerald-50 border-emerald-300'
        : partial  ? 'bg-amber-50 border-amber-300'
                   : 'bg-red-50 border-red-300'
      }`}>
        <div className="flex items-start gap-2">
          {allWavesOk
            ? <CheckCircle2 size={18} className="text-emerald-600 flex-shrink-0 mt-0.5" />
            : <AlertTriangle size={18} className={`${partial ? 'text-amber-600' : 'text-red-600'} flex-shrink-0 mt-0.5`} />}
          <div className="text-sm">
            <div className={`font-bold ${allWavesOk ? 'text-emerald-900' : partial ? 'text-amber-900' : 'text-red-900'}`}>
              {allWavesOk ? 'הליקוט נשלח בהצלחה' : partial ? 'הליקוט נשלח חלקית' : 'מסלולים נוצרו אך ללא גלי ליקוט'}
            </div>
            <div className="text-xs mt-1 text-gray-700">
              {runsCreated.length} מסלולים · {reusedCount} קיימים, {createdCount} חדשים
              {' · '}
              {wavesBuilt}/{runsCreated.length} גלי ליקוט מוכנים
              {wavesFailed > 0 && (
                <span className="text-red-700"> · {wavesFailed} נכשלו</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr>
              <th className="px-3 py-2 text-right font-medium">מסלול</th>
              <th className="px-3 py-2 text-right font-medium">אזור</th>
              <th className="px-3 py-2 text-center font-medium">תחנות</th>
              <th className="px-3 py-2 text-center font-medium">הזמנות</th>
              <th className="px-3 py-2 text-right font-medium">גל ליקוט</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {waveResults.map((w) => (
              <tr key={w.runId}>
                <td className="px-3 py-2 font-mono text-xs">
                  {w.runNumber}
                  {w.reusedExisting && (
                    <span className="ml-1 px-1 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px]">
                      קיים
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">{w.zoneName}</td>
                <td className="px-3 py-2 text-center text-xs">{w.stopCount}</td>
                <td className="px-3 py-2 text-center text-xs">{w.orderCount}</td>
                <td className="px-3 py-2 text-xs">
                  {w.waveId ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded">
                      <CheckCircle2 size={10} /> {w.waveNumber}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-red-700" title={w.error}>
                      <AlertTriangle size={10} /> {w.error?.slice(0, 40) || 'נכשל'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {unassigned && unassigned.length > 0 && (
        <UnassignedWarning unassigned={unassigned} />
      )}
    </div>
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

function ZoneCard({ run, pickableUsers, pickersLoading, selectedPickerId, onPickerChange }) {
  const hasPicker = !!selectedPickerId;
  return (
    <div className={`border rounded-lg p-3 ${hasPicker ? 'border-gray-200' : 'border-amber-300 bg-amber-50/40'}`}>
      <div className="flex items-center justify-between">
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

      <div className="mt-2 pt-2 border-t border-gray-100 flex items-center gap-2">
        <User size={12} className={hasPicker ? 'text-emerald-600' : 'text-amber-700'} />
        <label className="text-xs text-gray-700 whitespace-nowrap">מלקט:</label>
        <select
          value={selectedPickerId}
          onChange={(e) => onPickerChange(e.target.value ? Number(e.target.value) : null)}
          disabled={pickersLoading}
          className={`flex-1 text-sm px-2 py-1 border rounded ${
            hasPicker ? 'border-gray-300 bg-white' : 'border-amber-400 bg-white'
          } disabled:opacity-60`}
        >
          <option value="">{pickersLoading ? 'טוען מלקטים…' : '— בחר מלקט —'}</option>
          {(pickableUsers || []).map((u) => (
            <option key={u.userId} value={u.userId}>
              {u.fullName} ({u.role === 'WAREHOUSE' ? 'מחסן' : u.role === 'PLANNER' ? 'מתכנן' : 'מנהל'})
            </option>
          ))}
        </select>
      </div>
      {run.wouldReuseExistingRunId && (
        <div className="mt-1 text-[11px] text-blue-700/80">
          ⓘ אם קיים גל ליקוט פעיל ל-{run.wouldReuseExistingRunNumber}, השליחה תיחסם (WAVE_IN_PROGRESS)
        </div>
      )}
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

function GenericErrorView({ title = 'שגיאה', errorBody, onRetry, retryLabel = 'נסה שוב' }) {
  return (
    <div className="bg-red-50 border border-red-300 rounded-lg p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm flex-1">
          <div className="font-bold text-red-900">{title}</div>
          <div className="text-red-700 text-xs mt-1">
            {errorBody?.error || 'נסה שוב'}
            {errorBody?.code && (
              <span className="ml-2 font-mono">({errorBody.code})</span>
            )}
          </div>
        </div>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 px-3 py-1.5 text-sm border rounded-lg hover:bg-white"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
