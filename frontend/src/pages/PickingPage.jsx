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
function PickedAllocations({ allocations, onPick, onReset, onApproveOrder }) {
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
            {isDone && a.RunOrderId && onApproveOrder && !a.QcApproved && (
              <button
                onClick={() => onApproveOrder(a)}
                className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-600 text-white rounded text-[10px] font-bold hover:bg-emerald-700 mr-1"
                title="אשר את ההזמנה והפק מסמך לפי מדיניות הלקוח"
              >
                <Check size={10} /> אשר הזמנה
              </button>
            )}
            {a.QcApproved && a.AggregatePending && !a.DeliveryNoteId && !a.InvoiceId && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-sky-100 text-sky-900 border border-sky-400 rounded text-[10px] font-medium" title="ההזמנה אושרה. תעודת משלוח / חשבונית מאוחדת תופק בסיום ה-run">
                <Check size={10} /> ממתין לאיחוד
              </span>
            )}
            {a.QcApproved && !a.AggregatePending && !a.PartialFulfillment && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-300 rounded text-[10px] font-medium" title="ההזמנה אושרה ומסמכים הופקו">
                <Check size={10} /> מאושרת
                {a.DeliveryNoteId && <span className="text-emerald-700 mr-1">·ת.משלוח</span>}
                {a.InvoiceId && <span className="text-emerald-700">·חשבונית</span>}
              </span>
            )}
            {a.QcApproved && a.PartialFulfillment && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-100 text-amber-900 border border-amber-400 rounded text-[10px] font-medium" title="ההזמנה אושרה חלקית — היתרה נשארת פתוחה ב-SAP">
                <AlertTriangle size={10} /> חלקית
                {a.DeliveryNoteId && <span className="text-amber-800 mr-1">·ת.משלוח חלקית</span>}
                {a.InvoiceId && <span className="text-amber-800">·חשבונית</span>}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function PickingPage() {
  // A2g-FIX-PICKING-ROUTE (2026-05-21): mounted under TWO routes —
  //   /warehouse/runs/:runId  (legacy, gives runId)
  //   /picking/:waveId        (post-submit redirect, gives waveId)
  // Detect which and fetch via the right endpoint. Avoids the
  // 'wave-for-run(<waveId>)' miss that produced the post-submit blank page.
  const params = useParams();
  const waveIdParam = params.waveId;
  const runId = params.runId;
  const queryClient = useQueryClient();
  const [pickingValues, setPickingValues] = useState({});
  const [scannerOpen, setScannerOpen] = useState(false);
  const [lastScan, setLastScan] = useState({ code: null, at: 0 });
  const [hideCompleted, setHideCompleted] = useState(false);

  const { data: wave, isLoading, refetch, isRefetching } = useQuery({
    queryKey: waveIdParam ? ['wave', waveIdParam] : ['wave-for-run', runId],
    queryFn: () => (waveIdParam ? pickingApi.get(waveIdParam) : pickingApi.getWaveForRun(runId)),
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

  // ------------------------------------------------------------------
  // Pallet-mode controls — moved here from the planner's RunDetailsPage
  // because the decision of HOW to organize the picked goods belongs to
  // the warehouse / logistics manager, not to the route planner.
  // PATCH endpoints (run + stops) are unchanged.
  // ------------------------------------------------------------------
  const palletModeMutation = useMutation({
    mutationFn: (palletMode) =>
      api.patch(`/runs/${runId}`, { palletMode }).then((r) => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['wave-for-run', runId] }),
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה בעדכון מצב ליקוט'),
  });

  const palletLabelMutation = useMutation({
    mutationFn: ({ stopId, palletLabel }) =>
      api.patch(`/stops/${stopId}`, { palletLabel }).then((r) => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['wave-for-run', runId] }),
  });

  // Per-order QC approve — Feature C, DRY-RUN. Creates the SAP documents the
  // customer's DocPolicy asks for (delivery note, tax invoice, or both),
  // stored locally as PENDING_EXPORT. Empty-policy → 422 with a link to
  // /customer-doc-policy. Idempotent re-clicks are a no-op.
  const approveOrderMutation = useMutation({
    mutationFn: (alloc) =>
      api.post(`/orders/${alloc.RunOrderId}/qc-approve`).then((r) => r.data),
    onSuccess: (result, alloc) => {
      // Phase 3 — aggregate-pending orders won't produce a per-order DN here;
      // their toast says "approved, waiting for run-level flush" instead.
      if (result.aggregatePending) {
        toast.success(
          'הזמנה ' + alloc.SapDocNum + ' אושרה — ממתינה לאיחוד בסיום ה-run',
          { duration: 5000 },
        );
        queryClient.invalidateQueries({ queryKey: ['wave-for-run', runId] });
        return;
      }
      const parts = [];
      if (result.deliveryNote) parts.push('תעודת משלוח ' + result.deliveryNote.DocNumber);
      if (result.invoice)      parts.push('חשבונית '       + result.invoice.DocNumber);
      const prefix = result.idempotent
        ? 'הזמנה ' + alloc.SapDocNum + ' כבר אושרה'
        : (result.isPartial ? 'אושר חלקית: ' : 'אושר: ') + (parts.join(' + ') || '(ללא מסמך)');
      if (result.isPartial) {
        // Partial pick — show the picked-of-ordered ratio and the missing items
        // so the operator can decide whether to chase the leftover today or
        // leave it open in SAP for the next run.
        const shortageNames = (result.deliveryNote?.Shortages || [])
          .map((sh) => `${sh.ItemName || sh.ItemCode} (חסר ${sh.Missing})`)
          .join(', ');
        toast.success(
          (t) => (
            <div className="flex flex-col gap-0.5 text-sm">
              <div className="font-bold">{prefix}</div>
              <div className="text-xs">נלקטו {result.totalPicked}/{result.totalOrdered} יחידות</div>
              {shortageNames && <div className="text-xs text-amber-200">חוסר: {shortageNames}</div>}
            </div>
          ),
          { duration: 7000 },
        );
      } else {
        toast.success(prefix, { duration: 4000 });
      }
      queryClient.invalidateQueries({ queryKey: ['wave-for-run', runId] });
    },
    onError: (err) => {
      const data = err.response?.data || {};
      if (data.code === 'NO_POLICY') {
        toast.error(
          (t) => (
            <div className="flex flex-col gap-1">
              <div>{data.error || 'מדיניות חסרה'}</div>
              <a
                href="/customer-doc-policy"
                target="_blank"
                rel="noreferrer"
                className="text-xs underline text-blue-200 hover:text-white"
              >
                ← פתח דף מדיניות מסמכים
              </a>
            </div>
          ),
          { duration: 8000 },
        );
      } else if (data.code === 'NOTHING_PICKED') {
        toast.error(data.error || 'לא נלקטה אף יחידה — לקט פריט אחד לפחות לפני אישור', { duration: 6000 });
      } else if (data.code === 'INVALID_POLICY') {
        toast.error(
          (t) => (
            <div className="flex flex-col gap-1">
              <div>{data.error || 'מדיניות המסמכים שגויה'}</div>
              <a
                href="/customer-doc-policy"
                target="_blank"
                rel="noreferrer"
                className="text-xs underline text-blue-200 hover:text-white"
              >
                ← תקן ב-מדיניות מסמכים
              </a>
            </div>
          ),
          { duration: 8000 },
        );
      } else {
        toast.error(data.error || 'שגיאה באישור ההזמנה');
      }
    },
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

  // Group key per line, mirroring the picker-page banner logic. Used to
  // re-sort lines so all rows belonging to the same pallet/customer sit
  // together regardless of city order.
  const groupKey = (l) => {
    const first = l.allocations?.[0];
    if (wave.PalletMode === 'BY_PALLET')   return first?.PalletLabel || 'zzz_no_pallet';
    if (wave.PalletMode === 'BY_CUSTOMER') return String(first?.StopOrder || first?.StopId || 'zzz') + '|' + (first?.BranchName || '');
    return l.PrimaryCity || 'zzz';
  };
  const sortedLines = (wave.PalletMode && wave.PalletMode !== 'SINGLE')
    ? [...lines].sort((a, b) => {
        const aDone = a.Status === 'COMPLETED' || a.Status === 'SHORTAGE';
        const bDone = b.Status === 'COMPLETED' || b.Status === 'SHORTAGE';
        if (aDone !== bDone) return aDone ? 1 : -1;
        return String(groupKey(a)).localeCompare(String(groupKey(b)), 'he');
      })
    : lines;
  const visibleLines = hideCompleted
    ? sortedLines.filter((l) => l.Status !== 'COMPLETED')
    : sortedLines;

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
            {/* Per-zone-picker-assignment (2026-05-21): AssignedPickerName
                is the planner's choice at SendToPicking time; PickedByName
                is the user who actually started picking. Both can appear
                independently — the wave keeps them as separate fields. */}
            {wave.AssignedPickerName && (
              <>
                <span>·</span>
                <span className="text-xs">הוקצה: {wave.AssignedPickerName}</span>
              </>
            )}
            {wave.PickedByName && wave.PickedByName !== wave.AssignedPickerName && (
              <>
                <span>·</span>
                <span className="text-xs">ליקט בפועל: {wave.PickedByName}</span>
              </>
            )}
            {wave.PickedByName && wave.PickedByName === wave.AssignedPickerName && (
              <>
                <span>·</span>
                <span className="text-xs">✓ ליקט</span>
              </>
            )}
            {!wave.AssignedPickerName && wave.PickedByName && (
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

      <PalletModePanel
        wave={wave}
        onChangeMode={(m) => palletModeMutation.mutate(m)}
        onChangeLabel={(stopId, palletLabel) => palletLabelMutation.mutate({ stopId, palletLabel })}
        modeChanging={palletModeMutation.isPending}
      />

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
          // Group banner: changes meaning per PalletMode.
          //   SINGLE      → group by city (current behavior)
          //   BY_PALLET   → group by the pallet label the planner set
          //   BY_CUSTOMER → group by customer (BranchName / StopId)
          const groupKeyOf = (l) => {
            const first = l.allocations?.[0];
            if (wave.PalletMode === 'BY_PALLET')   return first?.PalletLabel || '(ללא משטח)';
            if (wave.PalletMode === 'BY_CUSTOMER') return first?.BranchName || first?.SapCardName || '(ללא לקוח)';
            return l.PrimaryCity || '';
          };
          const groupIconAndLabel = (l) => {
            const key = groupKeyOf(l);
            if (wave.PalletMode === 'BY_PALLET')   return { icon: <Package size={16} className="text-amber-700" />, label: 'משטח ' + key, color: 'amber' };
            if (wave.PalletMode === 'BY_CUSTOMER') return { icon: <MapPin size={16} className="text-purple-700" />, label: key, color: 'purple' };
            return { icon: <MapPin size={16} className="text-brand-700" />, label: key, color: 'brand' };
          };
          const currentGroup = groupKeyOf(line);
          const prevGroup = idx > 0 ? groupKeyOf(visibleLines[idx - 1]) : null;
          const showGroupHeader = currentGroup && currentGroup !== prevGroup;
          const groupItemCount = visibleLines.filter((l) => groupKeyOf(l) === currentGroup).length;
          const gInfo = groupIconAndLabel(line);
          const headerColors = {
            brand:  'bg-brand-100  border-brand-600  text-brand-700  text-brand-900',
            amber:  'bg-amber-100  border-amber-600  text-amber-700  text-amber-900',
            purple: 'bg-purple-100 border-purple-600 text-purple-700 text-purple-900',
          }[gInfo.color] || '';

          return (
            <div key={line.WaveLineId}>
              {showGroupHeader && (
                <div className={`sticky top-0 z-10 -mx-1 px-3 py-2 mb-2 mt-3 border-r-4 rounded-r-lg flex items-center gap-2 ${headerColors}`}>
                  {gInfo.icon}
                  <span className="font-bold">{gInfo.label}</span>
                  <span className="text-xs">· {groupItemCount} פריטים</span>
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
                    {/* Phase 3: ItemGroup pill (OITM.ItmsGrpCod). Lines are
                        sorted by this so groups stay together; the pill is
                        the visual cue that a "section" started. */}
                    {line.ItemGroup != null && (
                      <span
                        className="bg-purple-100 text-purple-700 px-1.5 rounded font-medium"
                        title="קבוצת פריט (ItmsGrpCod)"
                      >
                        קב׳ {line.ItemGroup}
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
                    onApproveOrder={(a) => approveOrderMutation.mutate(a)}
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

// ----------------------------------------------------------------------------
// אופן הכנת משלוח — three-state mode panel + (when BY_PALLET) per-stop
// pallet-label editor. Lives on the picking page because the decision
// belongs to the warehouse manager, not the route planner.
// Pulls the unique stops out of the existing wave allocations — no extra
// request to /api/runs/:id is needed.
// ----------------------------------------------------------------------------
function PalletModePanel({ wave, onChangeMode, onChangeLabel, modeChanging }) {
  const mode = wave.PalletMode || 'SINGLE';
  const options = [
    { key: 'SINGLE',      label: 'ריכוז אחד',  hint: 'ליקוט מאוחד לכל הקו (ברירת מחדל)' },
    { key: 'BY_PALLET',   label: 'לפי משטח',   hint: 'סימון ידני של מספר משטח לכל עצירה' },
    { key: 'BY_CUSTOMER', label: 'לפי לקוח',   hint: 'ריכוז נפרד לכל לקוח' },
  ];

  // Build the unique-stop list straight from the wave's allocations.
  // We keep insertion order based on StopOrder so the panel mirrors the
  // run's stop sequence.
  const uniqueStops = (() => {
    const seen = new Map();
    for (const line of wave.lines || []) {
      for (const a of line.allocations || []) {
        if (!a.StopId || seen.has(a.StopId)) continue;
        seen.set(a.StopId, {
          StopId: a.StopId,
          StopOrder: a.StopOrder ?? 99,
          BranchName: a.BranchName || a.SapCardName || '(ללא שם)',
          City: a.City || '',
          PalletLabel: a.PalletLabel || '',
        });
      }
    }
    return [...seen.values()].sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0));
  })();

  return (
    <div className="mb-4 bg-white border rounded-xl p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-gray-700">אופן הכנת משלוח:</span>
        <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
          {options.map((o) => {
            const active = mode === o.key;
            return (
              <button
                key={o.key}
                type="button"
                disabled={modeChanging || active}
                onClick={() => onChangeMode(o.key)}
                title={o.hint}
                className={`px-3 py-1.5 text-xs transition-colors ${
                  active
                    ? 'bg-brand-600 text-white font-medium cursor-default'
                    : 'bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50'
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <span className="text-xs text-gray-500">
          {mode === 'SINGLE' && 'הליקוט מוצג כרשימה אחת לפי סדר נסיעה'}
          {mode === 'BY_PALLET' && 'סמן לכל עצירה מספר משטח — הליקוט יתקבץ לפי משטח'}
          {mode === 'BY_CUSTOMER' && 'הליקוט יתקבץ לפי לקוח (לא נדרש מספר משטח)'}
        </span>
      </div>

      {/* Pallet-label editor — only when BY_PALLET. */}
      {mode === 'BY_PALLET' && uniqueStops.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="text-xs text-gray-500 mb-2">שיוך משטחים לעצירות:</div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {uniqueStops.map((s) => (
              <div key={s.StopId} className="flex items-center gap-2 text-sm">
                <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-xs font-semibold shrink-0">
                  {s.StopOrder}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium text-gray-900" title={s.BranchName}>{s.BranchName}</div>
                  {s.City && <div className="text-[10px] text-gray-500">{s.City}</div>}
                </div>
                <input
                  key={`${s.StopId}-${s.PalletLabel}`}
                  type="text"
                  defaultValue={s.PalletLabel}
                  maxLength={8}
                  placeholder="P1"
                  className="w-16 px-2 py-1 border border-amber-300 bg-amber-50 rounded text-xs font-mono text-center focus:outline-none focus:border-amber-500"
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== s.PalletLabel) onChangeLabel(s.StopId, v);
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
