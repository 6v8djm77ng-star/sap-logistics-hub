/**
 * Picking Page - warehouse worker picks items for a run's wave.
 * Real SAP data, barcode scan, partial picks, shortage marking.
 */
import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { runsApi } from '../services/api.js';
import BarcodeScanner from '../components/BarcodeScanner.jsx';
import { toast } from 'sonner';
import {
  ChevronRight, MapPin, Check, Download, Zap, QrCode, Package,
  AlertTriangle, RotateCcw, Printer, Minus, Plus,
} from 'lucide-react';

const pickingApi = {
  get: (id) => api.get(`/picking/${id}`).then((r) => r.data),
  getWaveForRun: (runId) => api.get(`/runs/${runId}/wave`).then((r) => r.data).catch(() => null),
  createWave: (runId) => api.post(`/runs/${runId}/wave`).then((r) => r.data),
  pick: (lineId, qty) => api.post(`/picking/lines/${lineId}/pick`, { pickedQuantity: qty }).then((r) => r.data),
  scan: (waveId, barcode) => api.post(`/picking/${waveId}/scan`, { barcode }).then((r) => r.data),
  shortage: (lineId, notes) => api.post(`/picking/lines/${lineId}/shortage`, { notes }).then((r) => r.data),
  reset: (lineId) => api.post(`/picking/lines/${lineId}/reset`).then((r) => r.data),
  // Per-allocation (per-row) picking
  pickAllocation: (allocId, qty) =>
    api.post(`/picking/allocations/${allocId}/pick`, { pickedQuantity: qty }).then((r) => r.data),
  resetAllocation: (allocId) =>
    api.post(`/picking/allocations/${allocId}/reset`).then((r) => r.data),
};

/**
 * Per-row picking. Each allocation has its own pick / reset / "all" buttons
 * and shows its own status (✓ done / partial / pending). The pulsing green
 * Pick-by-Light highlight is per-row, not per-card, so the picker sees
 * exactly which row to handle next.
 */
function PickedAllocations({ allocations, onPick, onReset }) {
  if (!allocations?.length) return null;
  // Find the FIRST allocation that is not yet fully picked - that's the
  // current row to highlight (Pick-by-Light per row).
  const firstPendingId = allocations.find(
    (a) => Number(a.PickedQuantity || 0) < Number(a.Quantity)
  )?.AllocationId;

  return (
    <div className="text-[11px] mt-1.5 space-y-1.5">
      <div className="text-gray-500 font-medium">משויך ל:</div>
      {allocations.map((a) => {
        const picked = Number(a.PickedQuantity || 0);
        const total = Number(a.Quantity || 0);
        const remaining = total - picked;
        const isDone = picked >= total;
        const isCurrent = a.AllocationId === firstPendingId;
        return (
          <div
            key={a.AllocationId}
            className={`flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded border-2 transition-all ${
              isDone ? 'border-green-300 bg-green-50' :
              isCurrent ? 'border-green-500 bg-green-50 ring-2 ring-green-300/50 animate-pickbylight' :
              'border-gray-200 bg-white'
            }`}
          >
            {/* Status icon */}
            <span className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
              isDone ? 'bg-green-500 text-white' : isCurrent ? 'bg-green-200 text-green-800' : 'bg-gray-200 text-gray-500'
            }`}>
              {isDone ? <Check size={11} /> : ''}
            </span>

            <span className={`px-1.5 rounded font-medium ${a.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
              {a.CompanyCode === 'A' ? 'OIG' : 'Unico'}
            </span>
            <span className="font-mono text-gray-600">#{a.SapDocNum}</span>
            <span className="text-gray-700 font-medium">{a.BranchName || a.SapCardName || '—'}</span>
            {a.City && <span className="text-gray-500">· {a.City}</span>}

            <span className="mr-auto bg-white border border-gray-200 rounded px-1.5 text-gray-700">
              <span className={`font-semibold ${isDone ? 'text-green-700' : ''}`}>{picked}</span>
              <span className="text-gray-400">/{total}</span>
            </span>

            {/* Per-row pick buttons */}
            {!isDone && onPick && (
              <div className="flex gap-1 mt-1 sm:mt-0 w-full sm:w-auto">
                <button
                  onClick={() => onPick(a.AllocationId, 1)}
                  className="inline-flex items-center gap-0.5 px-2 py-1 bg-brand-600 text-white rounded text-[10px] font-bold hover:bg-brand-700"
                  title="ליקוט יחידה אחת"
                >
                  <Plus size={10} />1
                </button>
                {remaining > 1 && (
                  <button
                    onClick={() => onPick(a.AllocationId, remaining)}
                    className="inline-flex items-center gap-0.5 px-2 py-1 bg-green-600 text-white rounded text-[10px] font-bold hover:bg-green-700"
                    title="ליקוט כל היתרה"
                  >
                    <Check size={10} />הכל ({remaining})
                  </button>
                )}
              </div>
            )}
            {isDone && onReset && (
              <button
                onClick={() => onReset(a.AllocationId)}
                className="text-[10px] text-gray-500 hover:text-red-600 inline-flex items-center gap-0.5"
                title="אפס שורה זו"
              >
                <RotateCcw size={9} />אפס
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function PickingPage() {
  const { runId } = useParams();
  const queryClient = useQueryClient();
  const [pickingValues, setPickingValues] = useState({});
  const [scannerOpen, setScannerOpen] = useState(false);
  const [lastScan, setLastScan] = useState({ code: null, at: 0 });
  const [hideCompleted, setHideCompleted] = useState(false);

  const { data: wave, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['wave-for-run', runId],
    queryFn: () => pickingApi.getWaveForRun(runId),
    refetchInterval: 10_000,
  });

  const buildWaveMutation = useMutation({
    mutationFn: () => pickingApi.createWave(runId),
    onSuccess: () => {
      toast.success('גל ליקוט נוצר');
      refetch();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה ביצירת גל'),
  });

  // Per-allocation (per-row) pick / reset
  const pickAllocationMutation = useMutation({
    mutationFn: ({ allocId, qty }) => pickingApi.pickAllocation(allocId, qty),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wave-for-run', runId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה בליקוט'),
  });
  const resetAllocationMutation = useMutation({
    mutationFn: (allocId) => pickingApi.resetAllocation(allocId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wave-for-run', runId] });
    },
  });

  const pickMutation = useMutation({
    mutationFn: ({ lineId, qty }) => pickingApi.pick(lineId, qty),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['wave-for-run', runId] });
      setPickingValues((prev) => {
        const next = { ...prev };
        delete next[data.WaveLineId];
        return next;
      });
      if (data.Status === 'COMPLETED') toast.success(`✓ ${data.SapItemName}`, { duration: 1500 });
    },
  });

  const scanMutation = useMutation({
    mutationFn: (barcode) => pickingApi.scan(wave.WaveId, barcode),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['wave-for-run', runId] });
      toast.success(`+1 ${data.SapItemName}`);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה בסריקה'),
  });

  const shortageMutation = useMutation({
    mutationFn: ({ lineId, notes }) => pickingApi.shortage(lineId, notes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wave-for-run', runId] });
      toast.info('סומן כחוסר במלאי');
    },
  });

  const resetMutation = useMutation({
    mutationFn: (lineId) => pickingApi.reset(lineId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['wave-for-run', runId] }),
  });

  // QC review (gate between picking complete and document generation)
  const qcApproveMutation = useMutation({
    mutationFn: (notes) => api.post(`/picking/${wave?.WaveId}/qc-approve`, { notes }).then((r) => r.data),
    onSuccess: () => {
      toast.success('הליקוט אושר - נוצרו תעודות משלוח/חשבוניות אוטומטית');
      queryClient.invalidateQueries({ queryKey: ['wave-for-run', runId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });
  const qcRejectMutation = useMutation({
    mutationFn: (notes) => api.post(`/picking/${wave?.WaveId}/qc-reject`, { notes }).then((r) => r.data),
    onSuccess: () => {
      toast.info('הליקוט הוחזר לבדיקה חוזרת');
      queryClient.invalidateQueries({ queryKey: ['wave-for-run', runId] });
    },
  });

  const handlePick = (line) => {
    const val = pickingValues[line.WaveLineId];
    const qty = val != null ? Number(val) : Number(line.TotalQuantity) - Number(line.PickedQuantity);
    if (qty <= 0) return;
    pickMutation.mutate({ lineId: line.WaveLineId, qty });
  };

  const handleBarcode = (code) => {
    const now = Date.now();
    if (lastScan.code === code && now - lastScan.at < 1500) return;
    setLastScan({ code, at: now });
    scanMutation.mutate(code);
  };

  const handleShortage = (line) => {
    const notes = prompt(`סימון חוסר עבור "${line.SapItemName}". תיאור:`);
    if (notes !== null) {
      shortageMutation.mutate({ lineId: line.WaveLineId, notes: notes || null });
    }
  };

  // No wave yet - offer to create one
  if (!isLoading && !wave) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Link to="/warehouse" className="text-sm text-gray-500 flex items-center gap-1 mb-4">
          <ChevronRight size={14} /> חזרה לרשימת הגלים
        </Link>
        <div className="bg-white rounded-xl border p-12 text-center">
          <Package className="mx-auto text-gray-400 mb-3" size={40} />
          <p className="text-gray-600 mb-2">אין גל ליקוט פעיל למסלול זה</p>
          <p className="text-xs text-gray-500 mb-4">
            יצירת גל תשלוף את כל שורות ההזמנות מ-SAP ותצבור פריטים זהים
          </p>
          <button
            onClick={() => buildWaveMutation.mutate()}
            disabled={buildWaveMutation.isPending}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50"
          >
            <Zap size={16} /> {buildWaveMutation.isPending ? 'יוצר...' : 'צור גל ליקוט'}
          </button>
        </div>
      </div>
    );
  }

  if (isLoading || !wave) return <div className="p-6">טוען...</div>;

  const lines = wave.lines || [];
  const completed = lines.filter((l) => l.Status === 'COMPLETED').length;
  const shortage = lines.filter((l) => l.Status === 'SHORTAGE').length;
  const total = lines.length;
  const progress = total > 0 ? Math.round(((completed + shortage) / total) * 100) : 0;
  const totalPicked = lines.reduce((s, l) => s + Number(l.PickedQuantity || 0), 0);
  const totalNeeded = lines.reduce((s, l) => s + Number(l.TotalQuantity || 0), 0);

  const visibleLines = hideCompleted
    ? lines.filter((l) => l.Status !== 'COMPLETED')
    : lines;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <Link to="/warehouse" className="text-sm text-gray-500 flex items-center gap-1 mb-3">
        <ChevronRight size={14} /> חזרה לרשימת הגלים
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">{wave.WaveNumber}</h1>
          <div className="flex items-center gap-2 text-sm text-gray-600 mt-1">
            <span>מסלול {wave.RunNumber}</span>
            <span>·</span>
            <span className={`px-2 py-0.5 text-xs rounded-full ${
              wave.Status === 'COMPLETED' ? 'bg-green-100 text-green-700' :
              wave.Status === 'PENDING_QC' ? 'bg-amber-100 text-amber-800 ring-2 ring-amber-400' :
              wave.Status === 'IN_PROGRESS' ? 'bg-amber-100 text-amber-700' :
              'bg-gray-100 text-gray-700'
            }`}>
              {wave.Status === 'COMPLETED' ? 'הושלם' :
               wave.Status === 'PENDING_QC' ? 'ממתין לבקרה' :
               wave.Status === 'IN_PROGRESS' ? 'בתהליך' : 'ממתין'}
            </span>
            {wave.PickedByName && (
              <>
                <span>·</span>
                <span className="text-xs">לקט: {wave.PickedByName}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setScannerOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700"
          >
            <QrCode size={16} /> סרוק ברקוד
          </button>
          <button
            onClick={() => {
              const url = `/api/reports/waves/${wave.WaveId}/picking.pdf`;
              window.open(url, '_blank');
              toast.info('PDF נפתח בלשונית חדשה');
            }}
            className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
          >
            <Printer size={16} /> PDF
          </button>
          <button
            onClick={() => {
              const url = `/api/reports/waves/${wave.WaveId}/picking.xlsx`;
              const a = document.createElement('a');
              a.href = url;
              a.download = `picking-${wave.WaveNumber}.csv`;
              a.target = '_blank';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              toast.success('Excel הורד - בדוק תיקיית Downloads');
            }}
            className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
          >
            <Download size={16} /> Excel
          </button>
        </div>
      </div>

      {/* Barcode scanner */}
      {scannerOpen && (
        <BarcodeScanner
          onScan={handleBarcode}
          onClose={() => setScannerOpen(false)}
          hint="סרוק ברקוד פריט - הכמות תעלה ב-1"
        />
      )}

      {/* Progress */}
      <div className="bg-white rounded-xl border p-4 mb-4">
        <div className="flex items-center justify-between text-sm mb-2">
          <div>
            <span className="font-semibold">{completed}</span>/{total} פריטים הושלמו
            {shortage > 0 && (
              <span className="text-amber-700 mr-2">({shortage} חוסר)</span>
            )}
          </div>
          <div className="text-gray-600">
            נאסף: <span className="font-semibold">{totalPicked}</span> / {totalNeeded} יחידות
          </div>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-brand-600 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-3">
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={hideCompleted}
              onChange={(e) => setHideCompleted(e.target.checked)}
            />
            הסתר פריטים שהושלמו
          </label>
          <span className="text-xs text-gray-500">{progress}%</span>
        </div>
      </div>

      {/* Lines - grouped by city */}
      <div className="space-y-2">
        {visibleLines.map((line, idx) => {
          const remaining = Number(line.TotalQuantity) - Number(line.PickedQuantity);
          const isDone = line.Status === 'COMPLETED';
          const isShortage = line.Status === 'SHORTAGE';
          // Pick-by-Light: highlight the FIRST pending item so the picker
          // immediately knows what to grab next. Like a green light on the shelf.
          const isPending = !isDone && !isShortage;
          const firstPendingIdx = visibleLines.findIndex(
            (l) => l.Status !== 'COMPLETED' && l.Status !== 'SHORTAGE'
          );
          const isCurrent = isPending && idx === firstPendingIdx;
          // Show a city banner whenever the city changes between consecutive lines
          const prevCity = idx > 0 ? (visibleLines[idx - 1].PrimaryCity || '') : null;
          const showCityHeader = (line.PrimaryCity || '') && line.PrimaryCity !== prevCity;
          // Count items going to this city
          const cityItemCount = visibleLines.filter((l) => (l.PrimaryCity || '') === line.PrimaryCity).length;

          return (
            <div key={line.WaveLineId}>
              {showCityHeader && (
                <div className="sticky top-0 z-10 -mx-1 px-3 py-2 mb-2 mt-3 bg-brand-100 border-r-4 border-brand-600 rounded-r-lg flex items-center gap-2">
                  <MapPin size={16} className="text-brand-700" />
                  <span className="font-bold text-brand-900">{line.PrimaryCity}</span>
                  <span className="text-xs text-brand-700">· {cityItemCount} פריטים</span>
                </div>
              )}
              <div
                className={`bg-white border rounded-xl p-3 transition-all ${
                  isDone ? 'opacity-60 border-green-300' :
                  isShortage ? 'border-amber-300 bg-amber-50' :
                  isCurrent ? 'border-green-400 bg-green-50/30 shadow' :
                  'border-gray-200'
                }`}
              >
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0
                  ${isDone ? 'bg-green-100 text-green-700' :
                    isShortage ? 'bg-amber-100 text-amber-700' :
                    line.Status === 'PARTIAL' ? 'bg-amber-100 text-amber-700' :
                    'bg-gray-100 text-gray-500'}`}>
                  {isDone ? <Check size={18} /> :
                   isShortage ? <AlertTriangle size={16} /> :
                   <MapPin size={16} />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs text-gray-500 mb-1 flex-wrap">
                    {line.BinLocation && (
                      <span className="bg-blue-100 text-blue-700 px-1.5 rounded font-medium">
                        {line.BinLocation}
                      </span>
                    )}
                    <span className="font-mono">{line.SapItemCode}</span>
                    {line.Barcode && (
                      <span className="text-[10px] text-gray-400 font-mono">#{line.Barcode}</span>
                    )}
                  </div>
                  <div className="font-medium text-sm">{line.SapItemName}</div>

                  <div className="flex items-center gap-3 mt-1.5 text-sm">
                    <div>
                      <span className="text-gray-500">נדרש:</span>
                      <span className="font-semibold mx-1 text-lg">{Number(line.TotalQuantity)}</span>
                      <span className="text-xs text-gray-500">{line.UomCode || 'יח׳'}</span>
                    </div>
                    <span className="text-gray-300">·</span>
                    <div>
                      <span className="text-gray-500">נאסף:</span>
                      <span className="font-semibold mx-1 text-green-600">{Number(line.PickedQuantity)}</span>
                    </div>
                    {remaining > 0 && !isShortage && (
                      <>
                        <span className="text-gray-300">·</span>
                        <span className="text-amber-600 font-semibold">נותר: {remaining}</span>
                      </>
                    )}
                  </div>

                  <PickedAllocations
                    allocations={line.allocations}
                    onPick={(allocId, qty) => pickAllocationMutation.mutate({ allocId, qty })}
                    onReset={(allocId) => resetAllocationMutation.mutate(allocId)}
                  />

                  {line.Notes && (
                    <div className="mt-1.5 text-xs text-amber-700 bg-amber-100 rounded p-1.5">
                      {line.Notes}
                    </div>
                  )}

                  {!isDone && !isShortage && (
                    <div className="flex items-center gap-2 mt-3 flex-wrap">
                      <button
                        onClick={() => pickMutation.mutate({ lineId: line.WaveLineId, qty: 1 })}
                        className="inline-flex items-center gap-1 px-3 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700"
                      >
                        <Plus size={14} /> 1
                      </button>
                      <input
                        type="number"
                        min="0"
                        max={remaining}
                        value={pickingValues[line.WaveLineId] ?? ''}
                        onChange={(e) => setPickingValues((p) => ({ ...p, [line.WaveLineId]: e.target.value }))}
                        placeholder={String(remaining)}
                        className="w-20 px-2 py-1.5 border border-gray-300 rounded-lg text-sm text-center"
                      />
                      <button
                        onClick={() => handlePick(line)}
                        className="px-3 py-1.5 bg-brand-50 text-brand-700 border border-brand-200 rounded-lg text-sm hover:bg-brand-100"
                      >
                        סמן
                      </button>
                      <button
                        onClick={() => {
                          // Mark all remaining as picked
                          pickMutation.mutate({ lineId: line.WaveLineId, qty: remaining });
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-50 text-green-700 border border-green-200 rounded-lg text-sm hover:bg-green-100"
                      >
                        <Check size={13} /> הכל
                      </button>
                      <button
                        onClick={() => handleShortage(line)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-lg text-sm hover:bg-amber-100"
                        title="סמן חוסר במלאי"
                      >
                        <AlertTriangle size={13} /> חוסר
                      </button>
                    </div>
                  )}

                  {(isDone || isShortage || line.Status === 'PARTIAL') && (
                    <button
                      onClick={() => resetMutation.mutate(line.WaveLineId)}
                      className="mt-2 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-red-600"
                    >
                      <RotateCcw size={11} /> אפס פריט זה
                    </button>
                  )}
                </div>
              </div>
              </div> {/* end city-grouped wrapper */}
            </div>
          );
        })}

        {visibleLines.length === 0 && hideCompleted && (
          <div className="text-center py-8 text-gray-500 text-sm">
            כל הפריטים הושלמו ✓
          </div>
        )}
      </div>

      {wave.Status === 'PENDING_QC' && (
        <div className="mt-6 bg-amber-50 border-2 border-amber-400 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-amber-600 shrink-0 mt-1" size={32} />
            <div className="flex-1">
              <p className="font-bold text-amber-900 text-lg">בקרת איכות (QC) - דרושה אישור</p>
              <p className="text-sm text-amber-800 mt-1">
                הליקוט הסתיים: {completed} פריטים נלקטו, {shortage} חוסרים.
                <br />
                לפני יצירת תעודות משלוח/חשבוניות, אשר שכל הפריטים נלקטו נכון.
              </p>
              <div className="flex gap-2 mt-3 flex-wrap">
                <button
                  onClick={() => {
                    if (confirm('לאשר את הליקוט? יווצרו אוטומטית תעודות משלוח / חשבוניות לפי מדיניות הלקוח.')) {
                      qcApproveMutation.mutate(null);
                    }
                  }}
                  disabled={qcApproveMutation.isPending}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg font-bold hover:bg-green-700 disabled:opacity-50"
                >
                  <Check size={16} /> אשר ויצר תעודות
                </button>
                <button
                  onClick={() => {
                    const notes = prompt('סיבת הדחייה (לא חובה):');
                    if (notes !== null) qcRejectMutation.mutate(notes || null);
                  }}
                  disabled={qcRejectMutation.isPending}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-white text-amber-800 border border-amber-400 rounded-lg hover:bg-amber-50"
                >
                  <RotateCcw size={16} /> החזר לליקוט
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {wave.Status === 'COMPLETED' && (
        <div className="mt-6 bg-green-50 border border-green-300 rounded-xl p-4 text-center">
          <Check className="mx-auto text-green-600 mb-2" size={32} />
          <p className="font-semibold text-green-800">הליקוט אושר!</p>
          <p className="text-sm text-green-700 mt-1">
            {completed} פריטים נלקטו, {shortage} חוסרים. נוצרו תעודות משלוח/חשבוניות. המסלול עברה לסטטוס "הועמס".
          </p>
          {wave.QcApprovedBy && (
            <p className="text-xs text-green-600 mt-1">אושר על ידי {wave.QcApprovedBy}</p>
          )}
        </div>
      )}
    </div>
  );
}
