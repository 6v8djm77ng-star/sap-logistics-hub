import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ordersApi, runsApi } from '../services/api.js';
import api from '../services/api.js';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Zap, Package, AlertTriangle, ChevronDown, ChevronUp, Coins, PackageX, Plus, CalendarDays, MapPin, Search } from 'lucide-react';

// Customer-total threshold slider config.
// The default planner rule excludes orders whose customer-total (both
// companies combined) is below 3,000 ₪. This slider lets the logistics
// manager loosen that floor down to 2,000 ₪ on a per-session basis,
// pulling more borderline customers into the route. Persisted in
// localStorage so it survives refresh.
const MIN_CT_LO = 2000;
const MIN_CT_HI = 3000;          // also the historical default
const MIN_CT_DEFAULT = 2000;     // session default per planner request
const MIN_CT_BASELINE = 3000;    // fixed reference for delta calculation
const MIN_CT_STORAGE_KEY = 'planner.minCustomerTotal';

// Hebrew weekday names indexed by Date.getDay() (0=Sunday).
const HEBREW_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** Date string 'YYYY-MM-DD' → array of [day0, day+1, day+2] Hebrew weekday labels. */
function upcomingWeekdays(dateStr) {
  const base = new Date(dateStr + 'T00:00:00');
  return [0, 1, 2].map((offset) => {
    const d = new Date(base);
    d.setDate(d.getDate() + offset);
    return HEBREW_WEEKDAYS[d.getDay()];
  });
}

export default function PlannerPage() {
  const [runDate, setRunDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [planResult, setPlanResult] = useState(null); // last auto-plan response
  const [showExcluded, setShowExcluded] = useState(true);

  // Customer-total threshold slider. Initialized from localStorage (lazy
  // initializer so SSR / first render is safe). Default MIN_CT_DEFAULT
  // when storage is empty, NaN, or out of range.
  const [minCustomerTotal, setMinCustomerTotal] = useState(() => {
    if (typeof window === 'undefined') return MIN_CT_DEFAULT;
    const raw = window.localStorage?.getItem(MIN_CT_STORAGE_KEY);
    const n = Number(raw);
    if (!Number.isFinite(n)) return MIN_CT_DEFAULT;
    return Math.max(MIN_CT_LO, Math.min(MIN_CT_HI, n));
  });
  // Persist on every change so refresh restores the last value.
  useEffect(() => {
    try { window.localStorage?.setItem(MIN_CT_STORAGE_KEY, String(minCustomerTotal)); } catch {}
  }, [minCustomerTotal]);
  // Day filter: defaults to today's Hebrew weekday. The planner can flip to
  // a different weekday or to 'all' (which shows every stop regardless of
  // scheduledDays). Friday/Saturday are excluded — the warehouse doesn't
  // deliver then.
  const today = new Date(runDate + 'T00:00:00').getDay();
  const defaultDayKey = today >= 0 && today <= 4 ? HEBREW_WEEKDAYS[today] : 'all';
  const [selectedDay, setSelectedDay] = useState(defaultDayKey);
  const queryClient = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['unified', runDate],
    queryFn: () => ordersApi.unified({ fromDate: runDate, toDate: runDate }),
  });

  // Zone master (Code → Name + ColorHex) so the section headers stay
  // visually consistent with the rest of the system.
  const { data: zones = [] } = useQuery({
    queryKey: ['zones'],
    queryFn: () => api.get('/zones').then((r) => r.data.zones || []),
  });

  // Group the flat list by suggestedZone for the section layout. Unknown
  // zone falls into a synthetic '(ללא אזור)' bucket at the bottom.
  // Day-filter is applied first — anything outside the selected weekday
  // is hidden entirely (no row, no zone-section header).
  const groupedByZone = useMemo(() => {
    const all = data?.groups || [];
    const groups = selectedDay === 'all'
      ? all
      : all.filter((g) => (g.scheduledDays || []).includes(selectedDay));
    const buckets = new Map();
    for (const g of groups) {
      const z = g.suggestedZone || '__NONE__';
      if (!buckets.has(z)) buckets.set(z, []);
      buckets.get(z).push(g);
    }
    // Stable order: by SortOrder of known zones, '__NONE__' last.
    const zoneOrder = new Map(zones.map((z, i) => [z.Code, z.SortOrder ?? i]));
    return [...buckets.entries()]
      .map(([code, list]) => ({
        code,
        meta: code === '__NONE__'
          ? { Code: '__NONE__', Name: 'ללא שיוך אזור', ColorHex: '#94a3b8' }
          : (zones.find((z) => z.Code === code) || { Code: code, Name: code, ColorHex: '#64748b' }),
        list,
      }))
      .sort((a, b) => {
        if (a.code === '__NONE__') return 1;
        if (b.code === '__NONE__') return -1;
        return (zoneOrder.get(a.code) ?? 99) - (zoneOrder.get(b.code) ?? 99);
      });
  }, [data, zones, selectedDay]);

  const upcoming = upcomingWeekdays(runDate);
  const todayLabel = upcoming[0];

  const forceIncludeMutation = useMutation({
    mutationFn: ({ companyCode, docEntry }) =>
      api.post('/runs/force-include', { companyCode, docEntry, runDate }).then((r) => r.data),
    onSuccess: (result) => {
      toast.success(`✓ נוסף ידנית למסלול ${result.run.RunNumber}`);
      // Remove this order from the excluded list locally
      setPlanResult((prev) => prev ? {
        ...prev,
        excludedOrders: prev.excludedOrders.filter(
          (o) => !(o.companyCode === result.runOrder.CompanyCode && o.docEntry === result.runOrder.SapDocEntry)
        ),
      } : prev);
      queryClient.invalidateQueries();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה בשיוך הידני'),
  });

  // Live counts of plannable orders at the CURRENT slider threshold and at
  // the BASELINE 3000 ₪ — used to show "X extra orders enter vs 3000".
  // Both queries hit the read-only /preview-exclusions endpoint. The
  // baseline query has a fixed threshold so React Query caches it across
  // slider changes (refetches only when runDate changes). When the slider
  // is at 3000, both queryKeys coincide and React Query serves a single
  // request.
  const baselineQuery = useQuery({
    queryKey: ['preview-exclusions', runDate, MIN_CT_BASELINE],
    queryFn: () => api.get('/runs/auto-plan/preview-exclusions', {
      params: { runDate, minCustomerTotal: MIN_CT_BASELINE },
    }).then((r) => r.data),
  });
  const currentQuery = useQuery({
    queryKey: ['preview-exclusions', runDate, minCustomerTotal],
    queryFn: () => api.get('/runs/auto-plan/preview-exclusions', {
      params: { runDate, minCustomerTotal },
    }).then((r) => r.data),
  });
  const baselinePlannable = baselineQuery.data?.summary?.ordersPlannable ?? null;
  const currentPlannable  = currentQuery.data?.summary?.ordersPlannable ?? null;
  // delta = how many ADDITIONAL orders enter the plan vs the 3000 baseline.
  // Always >= 0 because lower threshold = more orders plannable.
  const deltaVsBaseline = (currentPlannable != null && baselinePlannable != null)
    ? Math.max(0, currentPlannable - baselinePlannable)
    : null;

  const autoPlanMutation = useMutation({
    // Pass the slider value so /api/runs/auto-plan applies the SAME
    // threshold the planner just previewed. Backend defaults to 3000
    // if not sent (current behaviour for older callers).
    mutationFn: () => runsApi.autoPlan(runDate, { minCustomerTotal }),
    onSuccess: (result) => {
      setPlanResult(result);
      const created = result.runsCreated?.length || 0;
      const excluded = result.summary?.ordersExcluded || 0;
      toast.success(
        excluded > 0
          ? `${created} מסלולים נוצרו. ${excluded} הזמנות לא נכללו (ראה למטה).`
          : `${created} מסלולים נוצרו`
      );
      queryClient.invalidateQueries();
      refetch();
    },
    onError: () => toast.error('שגיאה ביצירת מסלולים'),
  });

  // Preview-only: run the SAME 3 exclusion filters auto-plan uses, but
  // do not create any runs. Lets the planner see who falls outside the
  // rules before committing. Result reuses the ExcludedOrdersPanel.
  const previewExclusionsMutation = useMutation({
    // Pass the slider value so the on-demand preview matches what auto-plan
    // would do RIGHT NOW (same threshold). The two background useQuery
    // hooks above keep counts live as the slider moves; this mutation
    // remains for the manual "בדיקת חריגים" button + ExcludedOrdersPanel.
    mutationFn: () =>
      api.get('/runs/auto-plan/preview-exclusions', { params: { runDate, minCustomerTotal } })
        .then((r) => r.data),
    onSuccess: (result) => {
      // Adapt preview-summary keys to the shape ExcludedOrdersPanel expects.
      setPlanResult({
        runsCreated: [],
        unassignedAddresses: null,
        excludedOrders: result.excludedOrders,
        summary: {
          ...result.summary,
          previewOnly: true,
        },
        filters: result.filters,
        preview: true,
      });
      const n = result.summary?.ordersExcluded || 0;
      const ok = result.summary?.ordersPlannable || 0;
      toast.success(`${n} הזמנות מחוץ לתכנון · ${ok} הזמנות יעמדו בתנאים. לא נוצרו מסלולים.`);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה בבדיקת חריגים'),
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">תכנון יומי</h1>
          <p className="text-sm text-gray-500 mt-1">
            איחוד הזמנות משתי החברות לפי כתובת יעד
          </p>
        </div>
        <div className="flex gap-3">
          <input
            type="date"
            value={runDate}
            onChange={(e) => setRunDate(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <button
            onClick={() => previewExclusionsMutation.mutate()}
            disabled={previewExclusionsMutation.isPending || autoPlanMutation.isPending}
            className="inline-flex items-center gap-2 px-4 py-2 border border-amber-300 bg-amber-50 text-amber-900 rounded-lg text-sm font-medium hover:bg-amber-100 disabled:opacity-50"
            title="מציג מי לא ייכנס לתכנון אוטומטי — לא יוצר מסלולים"
          >
            <Search size={16} />
            {previewExclusionsMutation.isPending ? 'בודק...' : 'בדיקת חריגים לפני תכנון'}
          </button>
          <button
            onClick={() => autoPlanMutation.mutate()}
            disabled={autoPlanMutation.isPending || previewExclusionsMutation.isPending}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
          >
            <Zap size={16} />
            תכנון אוטומטי
          </button>
        </div>
      </div>

      {/* Customer-total threshold slider (per planner request).
          Range 2000-3000 ₪. Default 2000 on first load, then persisted
          per-browser in localStorage. Affects BOTH preview-exclusions
          AND auto-plan (POST body). The two background useQuery hooks
          show live counts: current threshold + delta vs baseline 3000. */}
      <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 font-medium">
            <Coins size={14} />
            סף מינימום לקוח: <span className="font-bold tabular-nums">{minCustomerTotal.toLocaleString('he-IL')} ₪</span>
          </div>
          <input
            type="range"
            min={MIN_CT_LO}
            max={MIN_CT_HI}
            step={100}
            value={minCustomerTotal}
            onChange={(e) => setMinCustomerTotal(Number(e.target.value))}
            className="flex-1 min-w-[200px] max-w-md accent-amber-600"
            aria-label="סף מינימום לקוח"
          />
          <div className="text-xs text-amber-800 tabular-nums whitespace-nowrap">
            {MIN_CT_LO.toLocaleString('he-IL')} – {MIN_CT_HI.toLocaleString('he-IL')} ₪
          </div>
        </div>
        <div className="mt-2 text-xs text-amber-800 flex items-center gap-4 flex-wrap">
          {currentQuery.isLoading || baselineQuery.isLoading ? (
            <span>טוען נתונים…</span>
          ) : currentPlannable == null ? (
            <span>אין נתוני תכנון לתאריך זה</span>
          ) : (
            <>
              <span>
                הזמנות לתכנון בסף הנוכחי: <strong className="tabular-nums">{currentPlannable.toLocaleString('he-IL')}</strong>
              </span>
              <span className="text-amber-300">·</span>
              {deltaVsBaseline === 0 || minCustomerTotal === MIN_CT_BASELINE ? (
                <span>אין שינוי לעומת {MIN_CT_BASELINE.toLocaleString('he-IL')} ₪</span>
              ) : (
                <span>
                  +<strong className="tabular-nums">{deltaVsBaseline?.toLocaleString('he-IL') ?? '…'}</strong> הזמנות נוספות נכנסות לעומת סף {MIN_CT_BASELINE.toLocaleString('he-IL')} ₪
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Filter rules info */}
      <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900">
        <strong>תנאים לכניסה למסלול אוטומטי:</strong>
        <span className="mx-2">·</span>
        <Coins size={14} className="inline -mt-0.5 ml-1" />
        סך הזמנות הלקוח (שתי החברות) ≥ <span className="tabular-nums">{minCustomerTotal.toLocaleString('he-IL')}</span> ש״ח
        {minCustomerTotal !== MIN_CT_BASELINE && (
          <span className="text-blue-600"> (ברירת מחדל: {MIN_CT_BASELINE.toLocaleString('he-IL')})</span>
        )}
        <span className="mx-2">·</span>
        <PackageX size={14} className="inline -mt-0.5 ml-1" />
        כל הפריטים זמינים במלאי
        <span className="mx-2">·</span>
        <Package size={14} className="inline -mt-0.5 ml-1" />
        מינימום 2 פריטים בהזמנה
      </div>

      {/* Excluded orders panel */}
      {planResult?.excludedOrders?.length > 0 && (
        <ExcludedOrdersPanel
          orders={planResult.excludedOrders}
          summary={planResult.summary}
          open={showExcluded}
          onToggle={() => setShowExcluded((v) => !v)}
          onForceInclude={(o) => forceIncludeMutation.mutate({ companyCode: o.companyCode, docEntry: o.docEntry })}
          forcing={forceIncludeMutation.isPending}
        />
      )}

      {/* Day filter — Sunday → Thursday, plus 'all'. Default = today's
          weekday. Friday/Saturday are intentionally absent (no deliveries). */}
      {data?.groups?.length > 0 && (
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
                        : 'bg-brand-100 text-brand-900 border-brand-400 font-semibold')
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
      )}

      {isLoading ? (
        <div className="text-center py-12 text-gray-500">טוען...</div>
      ) : !data?.groups?.length ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <Package className="mx-auto text-gray-400 mb-3" size={40} />
          <p className="text-gray-500">אין הזמנות פתוחות לתאריך זה</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groupedByZone.map((zg) => {
            const todayCount = zg.list.filter((g) => (g.scheduledDays || []).includes(todayLabel)).length;
            // When filtering by a single day, row highlights are noise (all
            // rows are by definition that day). Only colour rows in 'all'.
            const effectiveUpcoming = selectedDay === 'all' ? upcoming : ['', '', ''];
            return (
              <ZoneSection
                key={zg.code}
                zoneMeta={zg.meta}
                groups={zg.list}
                upcoming={effectiveUpcoming}
                todayCount={selectedDay === 'all' ? todayCount : 0}
              />
            );
          })}

          {/* Grand total — counts respect the active day filter */}
          {(() => {
            const shownStops = groupedByZone.reduce((s, zg) => s + zg.list.length, 0);
            const shownOrders = groupedByZone.reduce((s, zg) =>
              s + zg.list.reduce((a, g) => a + g.orderCount, 0), 0);
            const shownLines = groupedByZone.reduce((s, zg) =>
              s + zg.list.reduce((a, g) => a + g.totalLines, 0), 0);
            return (
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 text-sm text-gray-700 flex flex-wrap gap-6">
                <span><strong>{shownStops}</strong> יעדים</span>
                <span><strong>{shownOrders}</strong> הזמנות</span>
                <span><strong>{shownLines}</strong> שורות</span>
                <span className="text-gray-500">
                  {selectedDay === 'all'
                    ? `(כל הימים, ${data.groups.length} יעדים סה"כ)`
                    : `(${selectedDay}${selectedDay === todayLabel ? ' · היום' : ''})`}
                </span>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// One zone section: colored header + table of destinations in that zone.
// ----------------------------------------------------------------------------
function ZoneSection({ zoneMeta, groups, upcoming, todayCount }) {
  const [collapsed, setCollapsed] = useState(false);
  const [today, tomorrow, dayAfter] = upcoming;
  const totalOrders = groups.reduce((s, g) => s + g.orderCount, 0);
  const totalLines  = groups.reduce((s, g) => s + g.totalLines, 0);

  return (
    <div className="bg-white border rounded-xl overflow-hidden" style={{ borderColor: zoneMeta.ColorHex + '55' }}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
        style={{ background: zoneMeta.ColorHex + '10' }}
      >
        <div className="flex items-center gap-3">
          <MapPin size={18} style={{ color: zoneMeta.ColorHex }} />
          <span className="font-bold text-base" style={{ color: zoneMeta.ColorHex }}>
            {zoneMeta.Name}
          </span>
          <span className="text-xs text-gray-500">
            {groups.length} יעדים · {totalOrders} הזמנות · {totalLines} שורות
          </span>
          {todayCount > 0 && (
            <span className="px-2 py-0.5 text-xs bg-green-100 text-green-900 rounded-full border border-green-300 font-semibold">
              {todayCount} להיום
            </span>
          )}
        </div>
        {collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
      </button>

      {!collapsed && (
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 border-t">
            <tr>
              <th className="px-4 py-2 text-right font-medium">סניף / לקוח</th>
              <th className="px-4 py-2 text-right font-medium">כתובת</th>
              <th className="px-4 py-2 text-right font-medium">ימי הפצה</th>
              <th className="px-4 py-2 text-center font-medium">חברות</th>
              <th className="px-4 py-2 text-center font-medium">הזמנות</th>
              <th className="px-4 py-2 text-center font-medium">שורות</th>
              <th className="px-4 py-2 text-right font-medium">מדיניות</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {groups.map((g) => {
              const days = g.scheduledDays || [];
              const onToday = days.includes(today);
              const onTomorrow = days.includes(tomorrow);
              const onDayAfter = days.includes(dayAfter);
              const rowBg = onToday ? 'bg-green-50/70' : onTomorrow ? 'bg-amber-50/60' : onDayAfter ? 'bg-blue-50/50' : '';
              return (
                <tr key={g.addressId} className={`hover:bg-gray-50 ${rowBg}`}>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-gray-900">{g.address.BranchName || g.orders[0]?.cardName}</div>
                    {g.suggestedSubZone && (
                      <div className="text-[10px] text-gray-500 mt-0.5">תת-אזור: {g.suggestedSubZone}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-gray-700">
                    <div>{g.address.Street} {g.address.BuildingNumber}</div>
                    <div className="text-xs text-gray-500">{g.address.City}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {days.length === 0 ? <span className="text-xs text-gray-400">—</span> : days.map((d) => {
                        const cls = d === today ? 'bg-green-500 text-white border-green-600 font-bold'
                          : d === tomorrow ? 'bg-amber-200 text-amber-900 border-amber-400'
                          : d === dayAfter ? 'bg-blue-100 text-blue-900 border-blue-300'
                          : 'bg-gray-100 text-gray-600 border-gray-200';
                        return (
                          <span key={d} className={`px-1.5 py-0.5 text-[10px] rounded border ${cls}`}>{d}</span>
                        );
                      })}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <div className="flex justify-center gap-1">
                      {g.hasCompanyA && <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded">א</span>}
                      {g.hasCompanyB && <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded">ב</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-center font-medium">{g.orderCount}</td>
                  <td className="px-4 py-2.5 text-center">{g.totalLines}</td>
                  <td className="px-4 py-2.5">
                    <DocPolicyBadge policy={g.docPolicy} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DocPolicyBadge({ policy }) {
  if (!policy) return <span className="text-xs text-gray-400">—</span>;
  const items = [];
  if (policy.perOrderInvoice === 'yes')      items.push({ label: 'חשבונית', cls: 'bg-purple-100 text-purple-800 border-purple-300' });
  if (policy.perOrderDeliveryNote === 'yes') items.push({ label: 'תעודה',   cls: 'bg-indigo-100 text-indigo-800 border-indigo-300' });
  if (policy.aggregateInvoice === 'yes')     items.push({ label: 'חש׳ מרכזת', cls: 'bg-purple-50 text-purple-700 border-purple-200' });
  if (policy.aggregateDeliveryNote === 'yes')items.push({ label: 'תע׳ מרכזת', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' });
  if (items.length === 0) return <span className="text-xs text-gray-400">לא הוגדר</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((i) => (
        <span key={i.label} className={`px-1.5 py-0.5 text-[10px] rounded border ${i.cls}`}>{i.label}</span>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Excluded orders panel
// ----------------------------------------------------------------------------
function ExcludedOrdersPanel({ orders, summary, open, onToggle, onForceInclude, forcing }) {
  const lowTotal = summary?.excludedLowTotal || 0;
  const missingStock = summary?.excludedMissingStock || 0;
  const tooFewLines = summary?.excludedTooFewLines || 0;
  const isPreview = !!summary?.previewOnly;

  return (
    <div className={`mb-6 border-2 rounded-xl overflow-hidden ${isPreview ? 'bg-blue-50 border-blue-300' : 'bg-amber-50 border-amber-300'}`}>
      {isPreview && (
        <div className="px-4 py-1.5 bg-blue-600 text-white text-xs font-bold flex items-center gap-2">
          <Search size={12} />
          תצוגה מקדימה — לא נוצרו מסלולים. לחץ "תכנון אוטומטי" כדי לבצע בפועל.
        </div>
      )}
      <button
        onClick={onToggle}
        className={`w-full flex items-center justify-between gap-3 px-4 py-3 transition-colors ${isPreview ? 'hover:bg-blue-100' : 'hover:bg-amber-100'}`}
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className={isPreview ? 'text-blue-600' : 'text-amber-600'} size={20} />
          <span className={`font-bold ${isPreview ? 'text-blue-900' : 'text-amber-900'}`}>
            {orders.length} הזמנות {isPreview ? 'לא ייכנסו לתכנון' : 'לא נכללו במסלולים'}
          </span>
          <span className={`text-xs ${isPreview ? 'text-blue-700' : 'text-amber-700'}`}>
            {[
              lowTotal > 0 && `${lowTotal} מתחת ל-3,000 ש״ח`,
              tooFewLines > 0 && `${tooFewLines} פחות מ-2 פריטים`,
              missingStock > 0 && `${missingStock} חוסר במלאי`,
            ].filter(Boolean).join(' · ') && `(${[
              lowTotal > 0 && `${lowTotal} מתחת ל-3,000 ש״ח`,
              tooFewLines > 0 && `${tooFewLines} פחות מ-2 פריטים`,
              missingStock > 0 && `${missingStock} חוסר במלאי`,
            ].filter(Boolean).join(' · ')})`}
          </span>
        </div>
        {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>

      {open && (
        <div className="bg-white border-t border-amber-300">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-right font-medium">חברה</th>
                  <th className="px-3 py-2 text-right font-medium">לקוח</th>
                  <th className="px-3 py-2 text-right font-medium">הזמנה #</th>
                  <th className="px-3 py-2 text-right font-medium">סכום</th>
                  <th className="px-3 py-2 text-right font-medium">סך לקוח</th>
                  <th className="px-3 py-2 text-right font-medium">סיבה</th>
                  <th className="px-3 py-2 text-center font-medium">פעולה</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {orders.map((o) => (
                  <tr key={`${o.companyCode}-${o.docEntry}`} className="hover:bg-amber-50">
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 text-xs rounded ${
                        o.companyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                      }`}>
                        {o.companyCode === 'A' ? 'OIG' : 'Unico'}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-medium">{o.cardName}</td>
                    <td className="px-3 py-2 font-mono text-xs">{o.docNum}</td>
                    <td className="px-3 py-2">{formatNis(o.docTotal)}</td>
                    <td className="px-3 py-2">{formatNis(o.customerTotal)}</td>
                    <td className="px-3 py-2">
                      <ReasonsList reasons={o.reasons} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => {
                          if (confirm(`להוסיף ידנית את ${o.cardName} (#${o.docNum}) למסלול היומי, למרות החריגות?`)) {
                            onForceInclude(o);
                          }
                        }}
                        disabled={forcing}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-amber-600 text-white rounded text-xs hover:bg-amber-700 disabled:opacity-50"
                        title="אספקה חריגה - דריסת התנאים והוספה ידנית"
                      >
                        <Plus size={11} />
                        אספקה חריגה
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 bg-gray-50 border-t border-gray-200 text-xs text-gray-600">
            הזמנות אלה לא נכנסו לאף מסלול. ניתן להוסיף אותן ידנית מדף "מסלולי הפצה" → ערוך מסלול → הוסף עצירה.
          </div>
        </div>
      )}
    </div>
  );
}

// Compact list of SKU rows shown under EVERY reason (low_total, too_few_lines,
// missing_stock). Lets the planner see "what's in this order" without
// opening it. Capped at 5 lines + "ועוד N פריטים…" link.
function ItemsPreview({ items, qtyLabel, hilite }) {
  if (!items || items.length === 0) return null;
  return (
    <ul className="text-[10px] text-gray-700 mr-5 mt-0.5 list-disc">
      {items.slice(0, 5).map((it, idx) => (
        <li key={idx}>
          <span className="font-mono text-gray-500">{it.itemCode}</span>
          {it.itemName ? <span className="mr-1">{it.itemName}</span> : null}
          {qtyLabel && qtyLabel(it) ? (
            <span className={(hilite ? 'text-red-600 font-semibold' : 'text-gray-500') + ' mr-1'}>
              {qtyLabel(it)}
            </span>
          ) : null}
        </li>
      ))}
      {items.length > 5 && (
        <li className="text-gray-400">ועוד {items.length - 5} פריטים…</li>
      )}
    </ul>
  );
}

function ReasonsList({ reasons }) {
  return (
    <div className="space-y-1">
      {reasons.map((r, i) => {
        if (r.type === 'low_total') {
          return (
            <div key={i} className="text-amber-700">
              <div className="flex items-center gap-1">
                <Coins size={12} />
                <span>סך לקוח {formatNis(r.total)} &lt; {formatNis(r.threshold)}</span>
              </div>
              <ItemsPreview items={r.items} qtyLabel={(it) => it.quantity ? `×${it.quantity}` : null} />
            </div>
          );
        }
        if (r.type === 'too_few_lines') {
          return (
            <div key={i} className="text-orange-700">
              <div className="flex items-center gap-1">
                <Package size={12} />
                <span>{r.linesCount} פריטים בהזמנה (מינימום {r.threshold})</span>
              </div>
              <ItemsPreview items={r.items} qtyLabel={(it) => it.quantity ? `×${it.quantity}` : null} />
            </div>
          );
        }
        if (r.type === 'missing_stock') {
          return (
            <div key={i} className="text-red-700">
              <div className="flex items-center gap-1">
                <PackageX size={12} />
                <span>חוסר ב-{r.items.length} פריט{r.items.length > 1 ? 'ים' : ''}</span>
              </div>
              <ItemsPreview
                items={r.items}
                qtyLabel={(it) => `(חסר ${(it.needed - it.available).toFixed(0)})`}
                hilite
              />
            </div>
          );
        }
        if (r.type === 'no_open_lines') {
          // Order has no rows with OpenQty>0 in SAP — already shipped or
          // closed. The planner should usually skip; manual override via
          // force-include is still possible.
          return (
            <div key={i} className="flex items-center gap-1 text-gray-600">
              <PackageX size={12} />
              <span>אין שורות פתוחות (כל הפריטים נסגרו ב-SAP)</span>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function formatNis(n) {
  return Number(n || 0).toLocaleString('he-IL', {
    style: 'currency',
    currency: 'ILS',
    maximumFractionDigits: 0,
  });
}
