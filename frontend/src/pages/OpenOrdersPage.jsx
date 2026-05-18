/**
 * Real open orders from both SAP companies - flat list with filters.
 * Shows actual customer orders from SAP_OIG and SAP_Unico.
 *
 * Phase 1 Frontend (2026-05-17): adds an optional "החל סינון תנאי תכנון"
 * toggle that swaps the data source to /api/orders/open-with-plan-eval
 * and paints a per-order pass/fail badge so the logistics manager can
 * preview what the daily planner would include today, without creating
 * a Run. Toggle + filters persist to localStorage. The legacy
 * /api/orders/open path stays the default when the toggle is OFF.
 */
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import api from '../services/api.js';
import { format } from 'date-fns';
import { Package, Search, X, ChevronDown, ChevronUp, CheckCircle2, AlertTriangle, SlidersHorizontal, Send, Loader2, CalendarDays } from 'lucide-react';

// Hebrew weekday names indexed by Date.getDay() (0=Sunday). Matches the
// PlannerPage day filter so the two screens behave consistently.
const HEBREW_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// Orders carry CompanyCode 'A' | 'B'; customer profiles carry Company 'OIG' | 'UNICO'.
// Keep both indirections so the profile lookup matches across the two sources.
const COMPANY_CODE_TO_NAME = { A: 'OIG', B: 'UNICO' };

const ordersApi = {
  openOrders: (params) =>
    api.get('/orders/open', { params }).then((r) => r.data),
  openWithPlanEval: (params) =>
    api.get('/orders/open-with-plan-eval', { params }).then((r) => r.data),
  orderLines: (company, docEntry) =>
    api.get(`/orders/${company}/${docEntry}/lines`).then((r) => r.data),
  createRunsFromSelected: (body) =>
    api.post('/runs/from-selected-orders', body).then((r) => r.data),
};

const runsApi = {
  buildWave: (runId) => api.post(`/runs/${runId}/wave`).then((r) => r.data),
};

// orderKey is the dedup key used both in the selection Set and as the
// stable identity in the orders list. Must match what the backend uses.
const orderKey = (o) => `${o.CompanyCode}-${o.DocEntry}`;

// ---------------------------------------------------------------------------
// Plan-eval config — toggle + 4 sub-controls. Persisted in localStorage so
// the operator's settings survive page reload. Keep keys stable; if the
// shape changes in the future, do a one-shot migration in loadPlanEvalCfg.
// ---------------------------------------------------------------------------
const PLAN_EVAL_STORAGE_KEY = 'openOrders.planEval.v1';
const PLAN_EVAL_DEFAULTS = {
  enabled: false,
  minCustomerTotal: 3000,
  minLinesPerOrder: 2,
  requireStock: true,
  applyDeliveryDay: true,
};
function loadPlanEvalCfg() {
  try {
    const raw = localStorage.getItem(PLAN_EVAL_STORAGE_KEY);
    if (!raw) return PLAN_EVAL_DEFAULTS;
    const parsed = JSON.parse(raw);
    return { ...PLAN_EVAL_DEFAULTS, ...parsed };
  } catch {
    return PLAN_EVAL_DEFAULTS;
  }
}
function savePlanEvalCfg(cfg) {
  try { localStorage.setItem(PLAN_EVAL_STORAGE_KEY, JSON.stringify(cfg)); } catch {}
}

// Convert planEval flags into a one-line human-readable reason string.
// Used as the title attribute on the red "נכשל" badge so the operator can
// hover and see exactly WHICH criterion blocked the order.
function planEvalReasonsText(pe) {
  if (!pe) return '';
  const out = [];
  if (!pe.customerTotalOK && pe.customerTotalCurrent != null && pe.customerTotalThreshold != null) {
    out.push(`סך לקוח ₪${Number(pe.customerTotalCurrent).toLocaleString()} מתחת לסף ₪${Number(pe.customerTotalThreshold).toLocaleString()}`);
  }
  if (!pe.linesCountOK) {
    if (pe.noOpenLines) {
      out.push('אין שורות פתוחות בהזמנה');
    } else if (pe.linesCountCurrent != null && pe.linesCountThreshold != null) {
      out.push(`רק ${pe.linesCountCurrent} שורות (סף ${pe.linesCountThreshold})`);
    } else {
      out.push('מספר שורות חסר');
    }
  }
  if (!pe.stockOK && Array.isArray(pe.stockMissing) && pe.stockMissing.length > 0) {
    const sample = pe.stockMissing.slice(0, 2).map((s) => `${s.itemCode} (חסר ${s.needed - s.available})`).join(', ');
    const more = pe.stockMissing.length > 2 ? ` ועוד ${pe.stockMissing.length - 2}` : '';
    out.push(`חסר מלאי: ${sample}${more}`);
  }
  if (!pe.deliveryDayOK && pe.deliveryDayApplied) {
    if (pe.deliveryDayProfileMissing) {
      out.push('אין פרופיל לקוח — לא ניתן לקבוע יום חלוקה');
    } else if (Array.isArray(pe.deliveryDayExpected) && pe.deliveryDayExpected.length > 0) {
      out.push(`היום ${pe.deliveryDayToday} · יום חלוקה: ${pe.deliveryDayExpected.join(', ')}`);
    } else {
      out.push(`היום ${pe.deliveryDayToday} · אין ימי חלוקה מוגדרים`);
    }
  }
  return out.join(' · ');
}

function OrderDetailsRow({ order, planEval, deliveryDays, todayHebrew, showPlanEvalColumn, showSelectColumn, isSelected, onToggleSelect }) {
  const [expanded, setExpanded] = useState(false);

  const { data: linesData, isLoading: linesLoading } = useQuery({
    queryKey: ['order-lines', order.CompanyCode, order.DocEntry],
    queryFn: () => ordersApi.orderLines(order.CompanyCode, order.DocEntry),
    enabled: expanded,
  });

  // colSpan for the expanded row depends on which optional columns are shown.
  // Base is 9 (incl. ימי הפצה); +1 for the select checkbox, +1 for the planEval badge.
  const expandedColSpan = 9 + (showSelectColumn ? 1 : 0) + (showPlanEvalColumn ? 1 : 0);

  return (
    <>
      <tr className={`hover:bg-gray-50 cursor-pointer ${isSelected ? 'bg-blue-50' : ''}`} onClick={() => setExpanded(!expanded)}>
        {showSelectColumn && (
          <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={!!isSelected}
              onChange={() => onToggleSelect?.(order)}
              className="w-4 h-4 cursor-pointer"
              title="בחר להעברה לליקוט"
            />
          </td>
        )}
        <td className="px-3 py-2">
          <button className="p-1 hover:bg-gray-200 rounded">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </td>
        <td className="px-3 py-2">
          <span className={`px-1.5 py-0.5 text-xs rounded font-medium ${
            order.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
          }`}>
            {order.CompanyName || order.CompanyCode}
          </span>
        </td>
        <td className="px-3 py-2 font-mono text-sm">#{order.DocNum}</td>
        <td className="px-3 py-2 text-sm">
          <div className="font-medium">{order.CardName || '—'}</div>
          <div className="text-xs text-gray-500 font-mono">
            {order.CardCode}
            {planEval?.customerZone && (
              <span className="ml-2 px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded text-xs">
                {planEval.customerZone}
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-sm text-gray-700">
          {order.ShipToAddress || order.CustCity || '—'}
        </td>
        <td className="px-3 py-2 text-xs">
          {deliveryDays && deliveryDays.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {deliveryDays.map((d) => (
                <span
                  key={d}
                  className={`px-1.5 py-0.5 rounded ${
                    d === todayHebrew
                      ? 'bg-green-100 text-green-800 font-semibold border border-green-300'
                      : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {d}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-gray-400 text-xs" title="אין פרופיל לקוח / לא הוגדרו ימי הפצה">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-sm text-center">
          <span className="font-semibold">{order.LinesCount || 0}</span>
          {order.TotalQuantity != null && (
            <span className="text-xs text-gray-500"> ({Number(order.TotalQuantity).toFixed(0)} יח׳)</span>
          )}
        </td>
        <td className="px-3 py-2 text-sm text-left font-mono">
          ₪{order.DocTotal ? Number(order.DocTotal).toLocaleString() : '—'}
        </td>
        <td className="px-3 py-2 text-xs text-gray-500">
          {order.DocDueDate ? format(new Date(order.DocDueDate), 'dd/MM/yyyy') : '—'}
        </td>
        {showPlanEvalColumn && (
          <td className="px-3 py-2 text-center">
            {planEval ? (
              planEval.passes ? (
                <span
                  title="עומד בכל תנאי התכנון היומי"
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-emerald-100 text-emerald-700 font-medium"
                >
                  <CheckCircle2 size={12} /> עובר
                </span>
              ) : (
                <span
                  title={planEvalReasonsText(planEval) || 'לא עומד בתנאי תכנון'}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-red-100 text-red-700 font-medium cursor-help"
                >
                  <AlertTriangle size={12} /> נכשל
                </span>
              )
            ) : (
              <span className="text-xs text-gray-400">—</span>
            )}
          </td>
        )}
      </tr>
      {expanded && (
        <tr className="bg-gray-50">
          <td colSpan={expandedColSpan} className="px-6 py-4">
            {linesLoading ? (
              <div className="text-center text-gray-500 text-sm">טוען שורות...</div>
            ) : !linesData?.lines?.length ? (
              <div className="text-center text-gray-500 text-sm">אין שורות להצגה</div>
            ) : (
              <div>
                <div className="text-xs text-gray-500 mb-2">שורות ההזמנה:</div>
                <table className="w-full text-xs bg-white border rounded">
                  <thead className="text-gray-500">
                    <tr>
                      <th className="px-2 py-1 text-right">#</th>
                      <th className="px-2 py-1 text-right">קוד פריט</th>
                      <th className="px-2 py-1 text-right">שם פריט</th>
                      <th className="px-2 py-1 text-center">כמות</th>
                      <th className="px-2 py-1 text-center">נותר פתוח</th>
                      <th className="px-2 py-1 text-left">מחיר</th>
                      <th className="px-2 py-1 text-left">סה"כ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {linesData.lines.map((line) => (
                      <tr key={line.LineNum} className={line.LineStatus === 'C' ? 'text-gray-400 line-through' : ''}>
                        <td className="px-2 py-1">{line.LineNum + 1}</td>
                        <td className="px-2 py-1 font-mono">{line.ItemCode}</td>
                        <td className="px-2 py-1">{line.ItemName}</td>
                        <td className="px-2 py-1 text-center">{line.Quantity}</td>
                        <td className="px-2 py-1 text-center font-semibold text-amber-600">{line.OpenQty}</td>
                        <td className="px-2 py-1 text-left font-mono">₪{Number(line.Price || 0).toLocaleString()}</td>
                        <td className="px-2 py-1 text-left font-mono">₪{Number(line.LineTotal || 0).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function OpenOrdersPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [company, setCompany] = useState('');
  const [limit, setLimit] = useState(100);
  const [sortBy, setSortBy] = useState('docDate-desc'); // docDate / cardName / city / zone

  // Day filter — matches the PlannerPage idiom. Defaults to today's
  // Hebrew weekday (Sun-Thu). On Fri/Sat the default falls back to 'all'
  // because the warehouse does not deliver on those days, so there's no
  // sensible default day. Operator can flip via the day tabs.
  const todayDayIdx = new Date().getDay();
  const defaultDayKey = todayDayIdx >= 0 && todayDayIdx <= 4 ? HEBREW_WEEKDAYS[todayDayIdx] : 'all';
  const [selectedDay, setSelectedDay] = useState(defaultDayKey);
  const todayLabel = HEBREW_WEEKDAYS[todayDayIdx];

  // Customer delivery profiles (1,500+ rows, ~1 MB). Used to join orders
  // to their customer's DeliveryDays array. Cached for 5 min so flipping
  // day tabs does not refetch.
  const { data: customerProfiles = [] } = useQuery({
    queryKey: ['customer-profiles', 'all'],
    queryFn: () => api.get('/customer-profiles').then((r) => r.data.profiles || []),
    staleTime: 5 * 60 * 1000,
  });
  const profileByKey = useMemo(() => {
    const m = new Map();
    for (const p of customerProfiles) {
      if (p?.CardCode) m.set(`${p.Company || ''}:${p.CardCode}`, p);
    }
    return m;
  }, [customerProfiles]);

  // Phase 2: per-row selection for "send to picking". Set of orderKey
  // strings (`${CompanyCode}-${DocEntry}`). Lives in state (not localStorage)
  // because a selection from an earlier session is almost never relevant —
  // SAP open orders change too often.
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const toggleSelect = (order) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      const k = orderKey(order);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const clearSelection = () => setSelectedKeys(new Set());

  const [planEvalCfg, setPlanEvalCfgState] = useState(loadPlanEvalCfg);
  const updatePlanEvalCfg = (field, value) => {
    setPlanEvalCfgState((prev) => {
      const next = { ...prev, [field]: value };
      savePlanEvalCfg(next);
      return next;
    });
  };

  // Legacy data source — used when planEval toggle is OFF.
  const { data: legacyData, isLoading: legacyLoading } = useQuery({
    queryKey: ['open-orders', search, company, limit],
    queryFn: () => ordersApi.openOrders({
      search: search || undefined,
      company: company || undefined,
      limit,
    }),
    refetchInterval: 60_000,
    enabled: !planEvalCfg.enabled,
  });

  // Plan-eval data source — used when toggle is ON. Same orders but each
  // carries a per-criterion `planEval` object from the backend.
  const { data: planEvalData, isLoading: planEvalLoading } = useQuery({
    queryKey: ['orders-with-plan-eval', planEvalCfg.minCustomerTotal, planEvalCfg.minLinesPerOrder, planEvalCfg.requireStock, planEvalCfg.applyDeliveryDay],
    queryFn: () => ordersApi.openWithPlanEval({
      minCustomerTotal: planEvalCfg.minCustomerTotal,
      minLinesPerOrder: planEvalCfg.minLinesPerOrder,
      requireStock: planEvalCfg.requireStock,
      applyDeliveryDay: planEvalCfg.applyDeliveryDay,
    }),
    refetchInterval: 60_000,
    enabled: planEvalCfg.enabled,
  });

  // Phase 2: "שלח לליקוט" — POST to /api/runs/from-selected-orders.
  // On success: chain a buildWave per created run, then redirect to
  // /picking/<firstWaveId> so the manager lands on the picker screen with
  // the wave already built. Errors (e.g. ALREADY_ASSIGNED, ORDERS_MISSING)
  // are surfaced via toast so the operator can adjust the selection.
  const sendToPickingMutation = useMutation({
    mutationFn: async (orderRefs) => {
      const created = await ordersApi.createRunsFromSelected({ orders: orderRefs });
      // For each new run, kick off wave build. Failures are tolerated — the
      // manager can build the wave manually from RunDetailsPage.
      const waves = [];
      for (const r of created.runsCreated || []) {
        try {
          const wave = await runsApi.buildWave(r.runId);
          waves.push({ runId: r.runId, waveId: wave?.WaveId || null });
        } catch (waveErr) {
          waves.push({ runId: r.runId, waveId: null, error: waveErr.response?.data?.error || waveErr.message });
        }
      }
      return { ...created, waves };
    },
    onSuccess: (data) => {
      const firstWaveId = data.waves?.find((w) => w.waveId)?.waveId;
      const runsCreated = data.runsCreated?.length || 0;
      const wavesBuilt = data.waves?.filter((w) => w.waveId).length || 0;
      toast.success(`נוצרו ${runsCreated} מסלולים, ${wavesBuilt} עם גל ליקוט מוכן`);
      clearSelection();
      queryClient.invalidateQueries({ queryKey: ['open-orders'] });
      queryClient.invalidateQueries({ queryKey: ['orders-with-plan-eval'] });
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      if (firstWaveId) {
        navigate(`/picking/${firstWaveId}`);
      } else if (runsCreated > 0) {
        navigate(`/runs`);
      }
    },
    onError: (err) => {
      const body = err.response?.data;
      const msg = body?.error || err.message || 'שגיאה בשליחה לליקוט';
      toast.error(msg);
    },
  });

  const isLoading = planEvalCfg.enabled ? planEvalLoading : legacyLoading;
  const rawOrders = planEvalCfg.enabled
    ? (planEvalData?.ordersWithEval || [])
    : (legacyData?.orders || []);

  // Helper: read the customer's delivery days for a given order, either
  // from the planEval payload (when toggle ON) or from the profiles map.
  // Returns [] when no profile is found — caller decides what to do with it.
  const deliveryDaysForOrder = (o) => {
    if (Array.isArray(o.planEval?.deliveryDayExpected)) return o.planEval.deliveryDayExpected;
    const companyName = COMPANY_CODE_TO_NAME[o.CompanyCode] || o.CompanyCode;
    const p = profileByKey.get(`${companyName}:${o.CardCode}`);
    return Array.isArray(p?.DeliveryDays) ? p.DeliveryDays : [];
  };

  // Apply the day filter BEFORE search/company so the counts in the
  // summary banner reflect the day-scoped set. 'all' = no day filter.
  const dayFilteredRaw = selectedDay === 'all'
    ? rawOrders
    : rawOrders.filter((o) => deliveryDaysForOrder(o).includes(selectedDay));

  // The plan-eval source doesn't honor the search/company filters server-side,
  // so apply them client-side when the toggle is ON.
  const filteredRawOrders = planEvalCfg.enabled
    ? dayFilteredRaw.filter((o) => {
        if (company && o.CompanyCode !== company) return false;
        if (search) {
          const needle = search.toLowerCase();
          const hay = `${o.CardName || ''} ${o.CardCode || ''} ${o.DocNum || ''}`.toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      })
    : dayFilteredRaw;

  // Apply client-side sort.
  const orders = (() => {
    const arr = [...filteredRawOrders];
    const cityOf = (o) => {
      const addr = (o.ShipToAddress || '').split(/\r?\n|\r/).map((p) => p.trim()).filter(Boolean);
      return addr[addr.length - 1] || o.CustCity || '';
    };
    const cmp = {
      'docDate-desc':  (a, b) => new Date(b.DocDueDate || b.DocDate || 0) - new Date(a.DocDueDate || a.DocDate || 0),
      'docDate-asc':   (a, b) => new Date(a.DocDueDate || a.DocDate || 0) - new Date(b.DocDueDate || b.DocDate || 0),
      'cardName-asc':  (a, b) => String(a.CardName || '').localeCompare(String(b.CardName || ''), 'he'),
      'cardName-desc': (a, b) => String(b.CardName || '').localeCompare(String(a.CardName || ''), 'he'),
      'city-asc':      (a, b) => String(cityOf(a)).localeCompare(String(cityOf(b)), 'he'),
      'docTotal-desc': (a, b) => Number(b.DocTotal || 0) - Number(a.DocTotal || 0),
      'docTotal-asc':  (a, b) => Number(a.DocTotal || 0) - Number(b.DocTotal || 0),
    };
    const baseSort = cmp[sortBy] || cmp['docDate-desc'];
    // When plan-eval is active, always pin passing orders to the top so the
    // operator's attention goes there first. The user-selected sort then acts
    // as a secondary order within each group (passing / failing).
    const finalSort = planEvalCfg.enabled
      ? (a, b) => {
          const passDiff = Number(!!b.planEval?.passes) - Number(!!a.planEval?.passes);
          return passDiff !== 0 ? passDiff : baseSort(a, b);
        }
      : baseSort;
    arr.sort(finalSort);
    return arr;
  })();

  const isReal = planEvalCfg.enabled ? true : (legacyData?.source === 'sap');

  const totals = orders.reduce((acc, o) => ({
    count: acc.count + 1,
    lines: acc.lines + (o.LinesCount || 0),
    value: acc.value + (Number(o.DocTotal) || 0),
    companyA: acc.companyA + (o.CompanyCode === 'A' ? 1 : 0),
    companyB: acc.companyB + (o.CompanyCode === 'B' ? 1 : 0),
  }), { count: 0, lines: 0, value: 0, companyA: 0, companyB: 0 });

  // Selection helpers (Phase 2): operate on the currently-visible `orders`
  // list so "select all passing" honors the current filters.
  const selectionEnabled = planEvalCfg.enabled;
  const visibleSelectedCount = orders.reduce((n, o) => n + (selectedKeys.has(orderKey(o)) ? 1 : 0), 0);
  const passingVisible = orders.filter((o) => o.planEval?.passes);
  const selectAllPassing = () => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const o of passingVisible) next.add(orderKey(o));
      return next;
    });
  };
  const selectAllVisible = () => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const o of orders) next.add(orderKey(o));
      return next;
    });
  };
  const submitSelection = () => {
    if (selectedKeys.size === 0) return;
    const refs = [];
    for (const o of orders) {
      if (selectedKeys.has(orderKey(o))) {
        refs.push({ companyCode: o.CompanyCode, docEntry: o.DocEntry });
      }
    }
    if (refs.length === 0) {
      toast.error('הבחירה ריקה מהנראה. רענן והרא שוב.');
      return;
    }
    if (!window.confirm(`לשלוח ${refs.length} הזמנות לליקוט? המערכת תיצור מסלול/ים ותפיק גלי ליקוט.`)) return;
    sendToPickingMutation.mutate(refs);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Package /> הזמנות פתוחות
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {isReal ? (
              <span>✓ נתונים חיים מ-SAP</span>
            ) : (
              <span>נתוני דמה - SAP לא מחובר</span>
            )}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <div className="bg-white border rounded-xl p-3 text-center">
          <div className="text-xs text-gray-500">סה"כ הזמנות</div>
          <div className="text-2xl font-bold">{totals.count}</div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-center">
          <div className="text-xs text-blue-700">OIG (א)</div>
          <div className="text-2xl font-bold text-blue-900">{totals.companyA}</div>
        </div>
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-center">
          <div className="text-xs text-green-700">Unico (ב)</div>
          <div className="text-2xl font-bold text-green-900">{totals.companyB}</div>
        </div>
        <div className="bg-white border rounded-xl p-3 text-center">
          <div className="text-xs text-gray-500">שורות פריטים</div>
          <div className="text-2xl font-bold">{totals.lines}</div>
        </div>
        <div className="bg-white border rounded-xl p-3 text-center">
          <div className="text-xs text-gray-500">שווי כולל</div>
          <div className="text-lg font-bold font-mono">₪{totals.value.toLocaleString()}</div>
        </div>
      </div>

      {/* Day filter — Sunday → Thursday, plus 'all'. Default = today's
          weekday (or 'all' on Fri/Sat). Same idiom as PlannerPage so the
          two screens behave identically when the operator flips between
          them. Filters orders by their customer's DeliveryDays. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <CalendarDays size={16} className="text-gray-500" />
        <span className="text-gray-600">סינון לפי טבלת הפצה:</span>
        {HEBREW_WEEKDAYS.slice(0, 5).map((day) => {
          const active = selectedDay === day;
          const isToday = day === todayLabel;
          return (
            <button
              key={day}
              type="button"
              onClick={() => setSelectedDay(day)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md border transition-colors ${
                active
                  ? (isToday
                      ? 'bg-green-100 text-green-900 border-green-400 font-semibold'
                      : 'bg-blue-100 text-blue-900 border-blue-400 font-semibold')
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {isToday && <span className="w-2 h-2 rounded-full bg-green-500" />}
              {day}{isToday ? ' (היום)' : ''}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setSelectedDay('all')}
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md border transition-colors ${
            selectedDay === 'all'
              ? 'bg-gray-800 text-white border-gray-800 font-semibold'
              : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
          }`}
        >
          כל הימים
        </button>
      </div>

      {/* Plan-eval toggle + controls */}
      <div className="bg-white border rounded-xl p-3 mb-4">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={planEvalCfg.enabled}
            onChange={(e) => updatePlanEvalCfg('enabled', e.target.checked)}
            className="w-4 h-4"
          />
          <SlidersHorizontal size={16} className="text-gray-500" />
          <span className="font-medium">החל סינון תנאי תכנון יומי</span>
          {planEvalCfg.enabled && planEvalData?.todayHebrew && (
            <span className="text-xs text-gray-500 mr-2">· היום: {planEvalData.todayHebrew}</span>
          )}
        </label>
        {planEvalCfg.enabled && (
          <div className="mt-3 pt-3 border-t grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="text-xs text-gray-600 block mb-1">
                סך לקוח מינ׳: <span className="font-mono font-semibold">₪{Number(planEvalCfg.minCustomerTotal).toLocaleString()}</span>
              </label>
              <input
                type="range" min="1000" max="10000" step="500"
                value={planEvalCfg.minCustomerTotal}
                onChange={(e) => updatePlanEvalCfg('minCustomerTotal', Number(e.target.value))}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600 block mb-1">
                שורות מינ׳ להזמנה: <span className="font-semibold">{planEvalCfg.minLinesPerOrder}</span>
              </label>
              <input
                type="range" min="1" max="5" step="1"
                value={planEvalCfg.minLinesPerOrder}
                onChange={(e) => updatePlanEvalCfg('minLinesPerOrder', Number(e.target.value))}
                className="w-full"
              />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={planEvalCfg.requireStock}
                  onChange={(e) => updatePlanEvalCfg('requireStock', e.target.checked)}
                  className="w-4 h-4"
                />
                דרוש מלאי
              </label>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={planEvalCfg.applyDeliveryDay}
                  onChange={(e) => updatePlanEvalCfg('applyDeliveryDay', e.target.checked)}
                  className="w-4 h-4"
                />
                החל יום חלוקה
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Plan-eval summary banner — only when toggle ON */}
      {planEvalCfg.enabled && planEvalData?.summary && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4 text-sm flex flex-wrap items-center gap-3">
          <span>
            <span className="font-bold text-blue-900">{planEvalData.summary.passing}</span>
            <span className="text-gray-600"> מתוך {planEvalData.summary.total} עוברות תנאי</span>
          </span>
          <span className="text-gray-400">·</span>
          <span className="text-red-700">{planEvalData.summary.failing} נכשלות</span>
          {planEvalData.summary.failingDayOnly > 0 && (
            <>
              <span className="text-gray-400">·</span>
              <span className="text-amber-700">
                {planEvalData.summary.failingDayOnly} נכשלות רק על יום ({planEvalData.todayHebrew})
              </span>
            </>
          )}
        </div>
      )}

      {/* Phase 2: selection action bar — only when toggle ON */}
      {selectionEnabled && (
        <div className="bg-white border rounded-xl p-3 mb-4 flex flex-wrap items-center gap-3">
          <span className="text-sm">
            נבחרו <span className="font-bold">{selectedKeys.size}</span> הזמנות
            {visibleSelectedCount !== selectedKeys.size && (
              <span className="text-gray-500"> ({visibleSelectedCount} מוצגות)</span>
            )}
          </span>
          <button
            type="button"
            onClick={selectAllPassing}
            disabled={passingVisible.length === 0}
            className="px-3 py-1.5 text-sm border rounded-lg hover:bg-emerald-50 hover:border-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed"
            title="סמן את כל ההזמנות העוברות תנאי במסך"
          >
            סמן את כל העוברות ({passingVisible.length})
          </button>
          <button
            type="button"
            onClick={selectAllVisible}
            disabled={orders.length === 0}
            className="px-3 py-1.5 text-sm border rounded-lg hover:bg-blue-50 hover:border-blue-300 disabled:opacity-40 disabled:cursor-not-allowed"
            title="סמן את כל ההזמנות המוצגות (גם נכשלות)"
          >
            סמן הכל המוצג ({orders.length})
          </button>
          <button
            type="button"
            onClick={clearSelection}
            disabled={selectedKeys.size === 0}
            className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            נקה בחירה
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={submitSelection}
            disabled={selectedKeys.size === 0 || sendToPickingMutation.isPending}
            className="inline-flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sendToPickingMutation.isPending ? (
              <>
                <Loader2 size={14} className="animate-spin" /> שולח לליקוט...
              </>
            ) : (
              <>
                <Send size={14} /> שלח לליקוט ({selectedKeys.size})
              </>
            )}
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white border rounded-xl p-3 mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute top-1/2 -translate-y-1/2 right-3 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חפש שם לקוח או מספר הזמנה..."
            className="w-full pr-9 pl-3 py-2 border rounded-lg text-sm"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute top-1/2 -translate-y-1/2 left-2 p-1 hover:bg-gray-100 rounded"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <select
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="px-3 py-2 border rounded-lg text-sm"
        >
          <option value="">כל החברות</option>
          <option value="A">OIG בלבד</option>
          <option value="B">Unico בלבד</option>
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="px-3 py-2 border rounded-lg text-sm"
          title="מיון התוצאות"
        >
          <option value="docDate-desc">📅 תאריך - חדש→ישן</option>
          <option value="docDate-asc">📅 תאריך - ישן→חדש</option>
          <option value="cardName-asc">👤 לקוח - א→ת</option>
          <option value="cardName-desc">👤 לקוח - ת→א</option>
          <option value="city-asc">🏙️ עיר - א→ת</option>
          <option value="docTotal-desc">💰 סכום - גבוה→נמוך</option>
          <option value="docTotal-asc">💰 סכום - נמוך→גבוה</option>
        </select>
        {!planEvalCfg.enabled && (
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="px-3 py-2 border rounded-lg text-sm"
          >
            <option value={50}>50 שורות</option>
            <option value={100}>100 שורות</option>
            <option value={250}>250 שורות</option>
            <option value={500}>500 שורות</option>
          </select>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="text-center py-16 text-gray-500">טוען הזמנות מ-SAP...</div>
        ) : !orders.length ? (
          <div className="text-center py-16">
            <Package className="mx-auto text-gray-400 mb-3" size={40} />
            <p className="text-gray-500">לא נמצאו הזמנות פתוחות</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 text-xs">
                <tr>
                  {selectionEnabled && (
                    <th className="w-10 px-3 py-2 text-center font-medium" title="בחירה לליקוט">
                      <input
                        type="checkbox"
                        checked={orders.length > 0 && visibleSelectedCount === orders.length}
                        ref={(el) => {
                          if (el) el.indeterminate = visibleSelectedCount > 0 && visibleSelectedCount < orders.length;
                        }}
                        onChange={(e) => {
                          if (e.target.checked) selectAllVisible(); else clearSelection();
                        }}
                        className="w-4 h-4 cursor-pointer"
                      />
                    </th>
                  )}
                  <th className="w-8"></th>
                  <th className="px-3 py-2 text-right font-medium">חברה</th>
                  <th className="px-3 py-2 text-right font-medium">הזמנה</th>
                  <th className="px-3 py-2 text-right font-medium">לקוח</th>
                  <th className="px-3 py-2 text-right font-medium">כתובת</th>
                  <th className="px-3 py-2 text-right font-medium">ימי הפצה</th>
                  <th className="px-3 py-2 text-center font-medium">שורות</th>
                  <th className="px-3 py-2 text-left font-medium">סכום</th>
                  <th className="px-3 py-2 text-center font-medium">תאריך אספקה</th>
                  {planEvalCfg.enabled && (
                    <th className="px-3 py-2 text-center font-medium">תנאי</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {orders.map((order) => (
                  <OrderDetailsRow
                    key={`${order.CompanyCode}-${order.DocEntry}`}
                    order={order}
                    planEval={order.planEval || null}
                    deliveryDays={deliveryDaysForOrder(order)}
                    todayHebrew={todayLabel}
                    showPlanEvalColumn={planEvalCfg.enabled}
                    showSelectColumn={selectionEnabled}
                    isSelected={selectedKeys.has(orderKey(order))}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 text-center mt-3">
        לחץ על שורה כדי להציג את שורות ההזמנה
      </p>
    </div>
  );
}
