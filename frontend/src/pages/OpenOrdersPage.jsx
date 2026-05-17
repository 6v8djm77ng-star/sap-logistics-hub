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
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../services/api.js';
import { format } from 'date-fns';
import { Package, Search, X, ChevronDown, ChevronUp, CheckCircle2, AlertTriangle, SlidersHorizontal } from 'lucide-react';

const ordersApi = {
  openOrders: (params) =>
    api.get('/orders/open', { params }).then((r) => r.data),
  openWithPlanEval: (params) =>
    api.get('/orders/open-with-plan-eval', { params }).then((r) => r.data),
  orderLines: (company, docEntry) =>
    api.get(`/orders/${company}/${docEntry}/lines`).then((r) => r.data),
};

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

function OrderDetailsRow({ order, planEval, showPlanEvalColumn }) {
  const [expanded, setExpanded] = useState(false);

  const { data: linesData, isLoading: linesLoading } = useQuery({
    queryKey: ['order-lines', order.CompanyCode, order.DocEntry],
    queryFn: () => ordersApi.orderLines(order.CompanyCode, order.DocEntry),
    enabled: expanded,
  });

  // colSpan for the expanded row depends on whether the planEval column
  // is shown. Base is 8; +1 when the toggle is on.
  const expandedColSpan = showPlanEvalColumn ? 9 : 8;

  return (
    <>
      <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => setExpanded(!expanded)}>
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
  const [search, setSearch] = useState('');
  const [company, setCompany] = useState('');
  const [limit, setLimit] = useState(100);
  const [sortBy, setSortBy] = useState('docDate-desc'); // docDate / cardName / city / zone

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

  const isLoading = planEvalCfg.enabled ? planEvalLoading : legacyLoading;
  const rawOrders = planEvalCfg.enabled
    ? (planEvalData?.ordersWithEval || [])
    : (legacyData?.orders || []);
  // The plan-eval source doesn't honor the search/company filters server-side,
  // so apply them client-side when the toggle is ON.
  const filteredRawOrders = planEvalCfg.enabled
    ? rawOrders.filter((o) => {
        if (company && o.CompanyCode !== company) return false;
        if (search) {
          const needle = search.toLowerCase();
          const hay = `${o.CardName || ''} ${o.CardCode || ''} ${o.DocNum || ''}`.toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      })
    : rawOrders;

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
      // When plan-eval is active, sort passing orders first so the operator
      // sees them at the top of the list.
      'planPass-first': (a, b) => Number(!!b.planEval?.passes) - Number(!!a.planEval?.passes),
    };
    if (cmp[sortBy]) arr.sort(cmp[sortBy]);
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
          {planEvalCfg.enabled && (
            <option value="planPass-first">✅ עוברות תנאי קודם</option>
          )}
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
                  <th className="w-8"></th>
                  <th className="px-3 py-2 text-right font-medium">חברה</th>
                  <th className="px-3 py-2 text-right font-medium">הזמנה</th>
                  <th className="px-3 py-2 text-right font-medium">לקוח</th>
                  <th className="px-3 py-2 text-right font-medium">כתובת</th>
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
                    showPlanEvalColumn={planEvalCfg.enabled}
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
