import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { runsApi, reportsApi } from '../services/api.js';
import { toast } from 'sonner';
import StatusPill from '../components/StatusPill.jsx';
import AddressEditDialog from '../components/AddressEditDialog.jsx';
import AddStopDialog from '../components/AddStopDialog.jsx';
import MoveStopDialog from '../components/MoveStopDialog.jsx';
import NotifyEtaButton from '../components/NotifyEtaButton.jsx';
import DepartureApprovalDialog from '../components/DepartureApprovalDialog.jsx';
import AssignDriverDialog from '../components/AssignDriverDialog.jsx';
import {
  ChevronRight, Zap, Route, Package, Printer, Clock, Phone,
  Edit, Plus, Trash2, ArrowUp, ArrowDown, X, User, Search, ArrowRightLeft,
  Map as MapIcon, Box, Sparkles, FileText, ShieldCheck, ShieldOff
} from 'lucide-react';

function formatTimeWindow(stop) {
  const parts = [];
  if (stop.DeliveryWindowStart && stop.DeliveryWindowEnd) {
    const start = String(stop.DeliveryWindowStart).slice(0, 5);
    const end = String(stop.DeliveryWindowEnd).slice(0, 5);
    parts.push(`${start}-${end}`);
  }
  if (stop.DeliveryDays) {
    const dayMap = { SUN: 'א', MON: 'ב', TUE: 'ג', WED: 'ד', THU: 'ה', FRI: 'ו', SAT: 'ש' };
    parts.push(stop.DeliveryDays.split(',').map((d) => dayMap[d.trim()]).join(','));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export default function RunDetailsPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const [editingAddressId, setEditingAddressId] = useState(null);
  const [showAddStop, setShowAddStop] = useState(false);
  const [movingStop, setMovingStop] = useState(null);
  const [search, setSearch] = useState('');
  const [showDepartureApproval, setShowDepartureApproval] = useState(false);
  const [showAssignDriver, setShowAssignDriver] = useState(false);

  const { data: run, isLoading } = useQuery({
    queryKey: ['run', id],
    queryFn: () => runsApi.get(id),
  });

  // Road-distance route optimization (self-hosted OSRM + 2-opt).
  // Backend requires OSRM_BASE_URL — returns 422 otherwise, and the
  // server-side error string is surfaced verbatim via the onError toast.
  const smartOptimizeMutation = useMutation({
    mutationFn: () => api.post(`/runs/${id}/optimize`, { apply: true }).then((r) => r.data),
    onSuccess: (result) => {
      toast.success(
        `אופטימיזציית כביש הושלמה - ${result.totalKm} ק"מ (OSRM)`,
        { duration: 4000 }
      );
      queryClient.invalidateQueries({ queryKey: ['run', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  // Departure approval mutation (cancel approval)
  const cancelDepartureMutation = useMutation({
    mutationFn: (reason) =>
      api.post(`/runs/${id}/cancel-departure`, { reason }).then((r) => r.data),
    onSuccess: () => {
      toast.info('אישור היציאה בוטל');
      queryClient.invalidateQueries({ queryKey: ['run', id] });
    },
  });

  // Loading plan (LIFO)
  const [loadingPlan, setLoadingPlan] = useState(null);
  const fetchLoadingPlan = useMutation({
    mutationFn: () => api.get(`/runs/${id}/loading-plan`).then((r) => r.data),
    onSuccess: (data) => {
      setLoadingPlan(data);
      toast.success(`תוכנית עמיסה - ${data.utilisation}% ניצול`);
    },
  });

  const optimizeMutation = useMutation({
    mutationFn: () => runsApi.optimizeOrder(id),
    onSuccess: () => {
      toast.success('סדר עצירות עודכן');
      queryClient.invalidateQueries({ queryKey: ['run', id] });
    },
  });

  const buildWaveMutation = useMutation({
    mutationFn: () => runsApi.buildWave(id),
    onSuccess: () => toast.success('נוצר גל ליקוט'),
  });

  // Phase 3 — aggregate flush. Walks every QcApproved+AggregatePending order
  // in this run, groups by AggregationKey, and emits one consolidated DN
  // (and optionally INV) per group. Refuses if any order is unapproved.
  const flushAggregateMutation = useMutation({
    mutationFn: () => api.post(`/runs/${id}/flush-aggregate-docs`).then((r) => r.data),
    onSuccess: (result) => {
      const dnCount = result.deliveryNotes?.length || 0;
      const invCount = result.invoices?.length || 0;
      const parts = [];
      if (dnCount) parts.push(`${dnCount} תעודות משלוח`);
      if (invCount) parts.push(`${invCount} חשבוניות`);
      const summary = parts.join(' + ') || 'אין מסמכים חדשים';
      toast.success(`הופקו ${summary} (${result.ordersTouched} הזמנות אוחדו)`, { duration: 6000 });
      queryClient.invalidateQueries({ queryKey: ['run', id] });
      queryClient.invalidateQueries({ queryKey: ['wave-for-run', id] });
    },
    onError: (err) => {
      const data = err.response?.data || {};
      if (data.code === 'UNAPPROVED_ORDERS') {
        const list = (data.unapproved || []).map((o) => `#${o.SapDocNum || o.RunOrderId}`).join(', ');
        toast.error(`${data.error}\nלא מאושרות: ${list}`, { duration: 8000 });
      } else {
        toast.error(data.error || 'שגיאה בהפקת מסמכים מאוחדים');
      }
    },
  });

  const splitMutation = useMutation({
    mutationFn: () => api.post(`/runs/${id}/split`).then((r) => r.data),
    onSuccess: (newRun) => {
      toast.success(`המסלול פוצלה - מסלול חדש: ${newRun.RunNumber}`);
      queryClient.invalidateQueries({ queryKey: ['run', id] });
      queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  const moveStopMutation = useMutation({
    mutationFn: ({ stopId, direction }) =>
      api.post(`/stops/${stopId}/move-${direction}`).then((r) => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['run', id] }),
  });

  const deleteStopMutation = useMutation({
    mutationFn: (stopId) => api.delete(`/stops/${stopId}`).then((r) => r.data),
    onSuccess: () => {
      toast.success('העצירה נמחקה');
      queryClient.invalidateQueries({ queryKey: ['run', id] });
    },
  });

  const deleteOrderMutation = useMutation({
    mutationFn: (runOrderId) => api.delete(`/run-orders/${runOrderId}`).then((r) => r.data),
    onSuccess: () => {
      toast.success('ההזמנה הוסרה מהעצירה');
      queryClient.invalidateQueries({ queryKey: ['run', id] });
    },
  });

  if (isLoading) return <div className="p-6">טוען...</div>;
  if (!run) return <div className="p-6">לא נמצא</div>;

  const allStops = run.stops || [];
  const stops = search.trim()
    ? allStops.filter((s) => {
        const q = search.toLowerCase();
        const fields = [s.Street, s.City, s.BranchName, s.ContactPhone,
          ...(s.orders || []).map((o) => o.SapCardName),
          ...(s.orders || []).map((o) => String(o.SapDocNum))];
        return fields.some((f) => f && String(f).toLowerCase().includes(q));
      })
    : allStops;
  const isActive = !['COMPLETED', 'CANCELLED'].includes(run.Status);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Link to="/runs" className="text-sm text-gray-500 hover:underline flex items-center gap-1 mb-3">
        <ChevronRight size={14} /> חזרה לרשימת המסלולים
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{run.RunNumber}</h1>
          <div className="flex items-center gap-3 mt-2 text-sm">
            <span className="inline-flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: run.ZoneColor || '#9ca3af' }} />
              {run.ZoneName}
            </span>
            <span className="text-gray-500">·</span>
            <button
              onClick={() => setShowAssignDriver(true)}
              className={`inline-flex items-center gap-1 text-sm hover:underline ${
                run.DriverName ? 'text-gray-700' : 'text-red-600 font-medium'
              }`}
            >
              <User size={13} />
              נהג: {run.DriverName || 'לא משויך - לחץ לשיוך'}
            </button>
            <StatusPill status={run.Status} />
            <span className="text-gray-500">·</span>
            <span className="text-gray-500">{stops.length} עצירות</span>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          {isActive && (
            <>
              <button
                onClick={() => setShowAddStop(true)}
                className="inline-flex items-center gap-2 px-3 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700"
              >
                <Plus size={16} /> הוסף עצירה
              </button>
              <button
                onClick={() => setShowAssignDriver(true)}
                className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
              >
                <User size={16} /> {run.DriverName ? 'שנה נהג' : 'שייך נהג'}
              </button>
            </>
          )}
          <a
            href={reportsApi.manifestPdfUrl(id)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
          >
            <Printer size={16} /> דף נהג PDF
          </a>
          <a
            href={`/api/reports/runs/${id}/loading-manifest.pdf`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 bg-amber-600 text-white rounded-lg text-sm hover:bg-amber-700"
            title="ריכוז העמסה - LIFO + פירוט פריטים"
          >
            <Box size={16} /> ריכוז העמסה
          </a>
          <a
            href={`/api/reports/runs/${id}/distribution-summary.pdf`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
            title="ריכוז קו חלוקה - שורה לכל מסמך"
          >
            <FileText size={16} /> ריכוז חלוקה
          </a>
          <button
            onClick={() => optimizeMutation.mutate()}
            className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
          >
            <Route size={16} /> מיון חכם
          </button>
          <button
            onClick={() => smartOptimizeMutation.mutate()}
            disabled={smartOptimizeMutation.isPending}
            className="inline-flex items-center gap-2 px-3 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 disabled:opacity-50"
            title="אופטימיזציה לפי מרחק כביש (OSRM מקומי). דורש OSRM_BASE_URL ב-backend/.env"
          >
            <Sparkles size={16} /> {smartOptimizeMutation.isPending ? 'מחשב...' : 'אופטימיזציית כביש'}
          </button>
          <button
            onClick={() => fetchLoadingPlan.mutate()}
            disabled={fetchLoadingPlan.isPending}
            className="inline-flex items-center gap-2 px-3 py-2 bg-amber-600 text-white rounded-lg text-sm hover:bg-amber-700 disabled:opacity-50"
            title="תוכנית עמיסה למשאית"
          >
            <Box size={16} /> תוכנית עמיסה
          </button>
          {isActive && allStops.length > 25 && (
            <button
              onClick={() => {
                if (confirm(`המסלול כוללת ${allStops.length} עצירות. לפצל אותה ל-2 מסלולים?`)) {
                  splitMutation.mutate();
                }
              }}
              className="inline-flex items-center gap-2 px-3 py-2 border border-amber-400 bg-amber-50 text-amber-700 rounded-lg text-sm hover:bg-amber-100"
              title="מסלול עם הרבה עצירות - מומלץ לפצל"
            >
              ✂️ פצל מסלול
            </button>
          )}
          <button
            onClick={() => buildWaveMutation.mutate()}
            className="inline-flex items-center gap-2 px-3 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700"
          >
            <Zap size={16} /> צור גל ליקוט
          </button>
          {(() => {
            // Phase 3 — flush button. Visible only when at least one order in
            // the run is QcApproved + AggregatePending + has no DN/INV yet.
            const pending = (run.stops || []).flatMap((s) => s.orders || [])
              .filter((o) => o.QcApproved && o.AggregatePending && !o.DeliveryNoteId && !o.InvoiceId);
            if (!pending.length) return null;
            return (
              <button
                onClick={() => flushAggregateMutation.mutate()}
                disabled={flushAggregateMutation.isPending}
                className="inline-flex items-center gap-2 px-3 py-2 bg-sky-600 text-white rounded-lg text-sm hover:bg-sky-700 disabled:opacity-50"
                title={`${pending.length} הזמנות ממתינות לאיחוד`}
              >
                <FileText size={16} />
                {flushAggregateMutation.isPending ? 'מפיק...' : `הפק מסמכים מאוחדים (${pending.length})`}
              </button>
            );
          })()}
        </div>
      </div>

      {/* Departure approval banner - shows when run is loaded but not approved */}
      {run.Status === 'LOADED' && (
        <div className="mb-4 bg-gradient-to-l from-green-50 to-blue-50 border-2 border-green-400 rounded-xl p-4 flex items-center gap-3">
          <ShieldCheck className="text-green-600 shrink-0" size={28} />
          <div className="flex-1">
            <div className="font-bold text-green-900">המסלול נטען - דרוש אישור יציאה</div>
            <div className="text-sm text-green-800">לחץ "אשר יציאה" כדי לפתוח את המסלול לנהג</div>
          </div>
          <button
            onClick={() => setShowDepartureApproval(true)}
            className="px-4 py-2 bg-green-600 text-white rounded-lg font-bold hover:bg-green-700 inline-flex items-center gap-2"
          >
            <ShieldCheck size={16} /> אשר יציאה
          </button>
        </div>
      )}

      {/* Already approved - show approval info + cancel button */}
      {run.Status === 'READY_TO_DEPART' && (
        <div className="mb-4 bg-blue-50 border-2 border-blue-400 rounded-xl p-4 flex items-center gap-3">
          <ShieldCheck className="text-blue-600 shrink-0" size={28} />
          <div className="flex-1">
            <div className="font-bold text-blue-900">מאושר ליציאה ✓</div>
            <div className="text-sm text-blue-800">
              אושר על ידי {run.DepartureApprovedBy || 'מנהל'}{' '}
              {run.DepartureApprovedAt && new Date(run.DepartureApprovedAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
              {run.DepartureNotes && <span className="block mt-1 italic">"{run.DepartureNotes}"</span>}
            </div>
          </div>
          <button
            onClick={() => {
              const reason = prompt('סיבת ביטול האישור:');
              if (reason !== null) cancelDepartureMutation.mutate(reason || null);
            }}
            className="px-3 py-1.5 border border-red-300 text-red-600 rounded-lg text-sm hover:bg-red-50 inline-flex items-center gap-1"
            title="בטל אישור יציאה"
          >
            <ShieldOff size={14} /> בטל
          </button>
        </div>
      )}

      {showDepartureApproval && (
        <DepartureApprovalDialog
          runId={id}
          runNumber={run.RunNumber}
          onClose={() => setShowDepartureApproval(false)}
        />
      )}

      {/* Loading plan card - shown after fetchLoadingPlan completes */}
      {loadingPlan && (
        <div className="mb-4 bg-amber-50 border-2 border-amber-300 rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-amber-100 flex items-center justify-between">
            <div className="flex items-center gap-2 font-bold text-amber-900">
              <Box size={18} /> תוכנית עמיסה למשאית - LIFO
            </div>
            <div className="text-sm">
              ניצול: <span className="font-bold text-2xl">{loadingPlan.utilisation}%</span>
              <span className="text-xs text-amber-700 mr-2">
                ({Math.round(loadingPlan.totalVolumeL)}L / {loadingPlan.capacityL}L)
              </span>
            </div>
            <button onClick={() => setLoadingPlan(null)} className="p-1 hover:bg-amber-200 rounded">
              <X size={16} />
            </button>
          </div>
          <div className="p-3">
            <div className="text-xs text-amber-800 mb-2">
              💡 טען לפי סדר זה - הראשון שטוען יהיה הכי עמוק במשאית, יורד אחרון אצל הלקוח האחרון.
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {loadingPlan.plan.map((p) => (
                <div key={p.stopId} className="bg-white border border-amber-200 rounded p-2 flex items-center gap-2 text-sm">
                  <span className="w-7 h-7 rounded-full bg-amber-600 text-white font-bold flex items-center justify-center shrink-0">
                    {p.loadOrder}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{p.branchName || `Stop ${p.stopId}`}</div>
                    <div className="text-xs text-gray-500">{p.city} · נמסר {p.deliveryOrder}</div>
                  </div>
                  <div className="text-xs text-amber-700 font-mono">
                    {Math.round(p.volumeL)}L
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Search within run */}
      {allStops.length > 3 && (
        <div className="mb-4 relative">
          <Search size={14} className="absolute top-1/2 -translate-y-1/2 right-3 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`חפש בתוך ${allStops.length} העצירות - שם לקוח, עיר, רחוב, טלפון, מספר הזמנה...`}
            className="w-full pr-9 pl-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute top-1/2 -translate-y-1/2 left-2 p-1 hover:bg-gray-100 rounded"
            >
              <X size={14} />
            </button>
          )}
          {search && (
            <div className="text-xs text-gray-500 mt-1 mr-1">
              נמצאו {stops.length} עצירות מתוך {allStops.length}
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        {stops.map((stop, idx) => {
          const timeWindow = formatTimeWindow(stop);
          const isFirst = idx === 0;
          const isLast = idx === stops.length - 1;
          const stopIsActive = !['DELIVERED', 'FAILED', 'SKIPPED'].includes(stop.Status);
          return (
          <div key={stop.StopId} className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-start gap-3 flex-1">
                <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-semibold shrink-0">
                  {stop.StopOrder || idx + 1}
                </div>
                <div className="flex-1">
                  <div className="font-medium">
                    {stop.Street || ''} {stop.BuildingNumber || ''}
                    {!stop.Street && stop.BranchName}
                  </div>
                  <div className="text-sm text-gray-500">{stop.City}</div>
                  {stop.BranchName && stop.Street && (
                    <div className="text-xs text-gray-400 mt-0.5">{stop.BranchName}</div>
                  )}
                  <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs">
                    {timeWindow && (
                      <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                        <Clock size={11} /> {timeWindow}
                      </span>
                    )}
                    {stop.ContactPhone && (
                      <a
                        href={`tel:${stop.ContactPhone}`}
                        className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                      >
                        <Phone size={11} /> {stop.ContactPhone}
                      </a>
                    )}
                    {stop.ContactPhone && (
                      <NotifyEtaButton
                        stopId={stop.StopId}
                        branchName={stop.BranchName}
                        compact
                      />
                    )}
                    {stop.DeliveryNotes && (
                      <span className="text-gray-500 italic truncate max-w-sm" title={stop.DeliveryNotes}>
                        📝 {stop.DeliveryNotes}
                      </span>
                    )}
                    {stop.AddressId && (
                      <button
                        onClick={() => setEditingAddressId(stop.AddressId)}
                        className="inline-flex items-center gap-1 text-gray-500 hover:text-brand-600 hover:underline"
                      >
                        <Edit size={11} /> ערוך כתובת
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <StatusPill status={stop.Status} size="sm" />
                {isActive && stopIsActive && (
                  <>
                    <button
                      onClick={() => moveStopMutation.mutate({ stopId: stop.StopId, direction: 'up' })}
                      disabled={isFirst || moveStopMutation.isPending}
                      className="p-1.5 hover:bg-gray-100 rounded disabled:opacity-30"
                      title="העבר למעלה"
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      onClick={() => moveStopMutation.mutate({ stopId: stop.StopId, direction: 'down' })}
                      disabled={isLast || moveStopMutation.isPending}
                      className="p-1.5 hover:bg-gray-100 rounded disabled:opacity-30"
                      title="העבר למטה"
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      onClick={() => setMovingStop(stop)}
                      className="p-1.5 hover:bg-blue-50 text-blue-600 rounded"
                      title="העבר למסלול אחרת"
                    >
                      <ArrowRightLeft size={14} />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`למחוק את העצירה (${stop.Street || stop.BranchName})?`)) {
                          deleteStopMutation.mutate(stop.StopId);
                        }
                      }}
                      className="p-1.5 hover:bg-red-50 text-red-600 rounded"
                      title="מחק עצירה"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="space-y-1 pr-11">
              {stop.orders?.map((o) => (
                <div key={o.RunOrderId} className="flex items-center justify-between py-1.5 text-sm border-b border-gray-50 last:border-0 group">
                  <div className="flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 text-xs rounded ${o.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                      חברה {o.CompanyCode}
                    </span>
                    <Package size={14} className="text-gray-400" />
                    <span>{o.SapCardName}</span>
                    <span className="text-gray-500">#{o.SapDocNum}</span>
                    {o.OrderTotal > 0 && (
                      <span className="text-xs text-gray-500">· ₪{Number(o.OrderTotal).toLocaleString()}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-600">{o.LinesCount} שורות</span>
                    {isActive && stopIsActive && o.Status !== 'DELIVERED' && (
                      <button
                        onClick={() => {
                          if (confirm(`להסיר את ההזמנה #${o.SapDocNum} מהעצירה?`)) {
                            deleteOrderMutation.mutate(o.RunOrderId);
                          }
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 text-red-500 hover:bg-red-50 rounded transition-opacity"
                        title="הסר הזמנה"
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {(!stop.orders || stop.orders.length === 0) && (
                <div className="text-xs text-gray-400 italic py-2">
                  אין הזמנות בעצירה זו - ניתן להוסיף דרך "הוסף עצירה" עם הזמנה
                </div>
              )}
              {stop.returns?.map((r) => (
                <div key={r.ReturnId} className="flex items-center justify-between py-1.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 text-xs rounded bg-amber-100 text-amber-700">חזרה</span>
                    <span>{r.SapCardName}</span>
                  </div>
                  <StatusPill status={r.Status} size="sm" />
                </div>
              ))}
            </div>
          </div>
          );
        })}

        {!stops.length && (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <Package className="mx-auto text-gray-400 mb-3" size={40} />
            <p className="text-gray-500 mb-4">אין עצירות במסלול זה</p>
            {isActive && (
              <button
                onClick={() => setShowAddStop(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg"
              >
                <Plus size={16} /> הוסף עצירה ראשונה
              </button>
            )}
          </div>
        )}
      </div>

      {editingAddressId && (
        <AddressEditDialog
          addressId={editingAddressId}
          onClose={() => setEditingAddressId(null)}
        />
      )}
      {showAddStop && (
        <AddStopDialog
          runId={Number(id)}
          onClose={() => setShowAddStop(false)}
        />
      )}
      {movingStop && (
        <MoveStopDialog
          stop={movingStop}
          currentRun={run}
          onClose={() => setMovingStop(null)}
        />
      )}
      {showAssignDriver && (
        <AssignDriverDialog
          run={run}
          onClose={() => setShowAssignDriver(false)}
        />
      )}
    </div>
  );
}

