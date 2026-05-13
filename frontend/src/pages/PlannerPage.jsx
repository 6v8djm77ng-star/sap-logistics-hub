import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ordersApi, runsApi } from '../services/api.js';
import api from '../services/api.js';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Zap, Package, AlertTriangle, ChevronDown, ChevronUp, Coins, PackageX, Plus, CalendarDays, MapPin, Search } from 'lucide-react';

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
  const groupedByZone = useMemo(() => {
    const groups = data?.groups || [];
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
  }, [data, zones]);

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

  const autoPlanMutation = useMutation({
    mutationFn: () => runsApi.autoPlan(runDate),
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
    mutationFn: () =>
      api.get('/runs/auto-plan/preview-exclusions', { params: { runDate } })
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

      {/* Filter rules info */}
      <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900">
        <strong>תנאים לכניסה למסלול אוטומטי:</strong>
        <span className="mx-2">·</span>
        <Coins size={14} className="inline -mt-0.5 ml-1" />
        סך הזמנות הלקוח (שתי החברות) ≥ 3,000 ש״ח
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

      {/* Day legend */}
      {data?.groups?.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <CalendarDays size={16} className="text-gray-500" />
          <span className="text-gray-600">הדגשה לפי טבלת הפצה:</span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-green-100 text-green-900 border border-green-300 font-semibold">
            <span className="w-2 h-2 rounded-full bg-green-500" /> היום ({todayLabel})
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-50 text-amber-900 border border-amber-300">
            <span className="w-2 h-2 rounded-full bg-amber-500" /> מחר ({upcoming[1]})
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-blue-50 text-blue-900 border border-blue-300">
            <span className="w-2 h-2 rounded-full bg-blue-500" /> מחרתיים ({upcoming[2]})
          </span>
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
            return (
              <ZoneSection
                key={zg.code}
                zoneMeta={zg.meta}
                groups={zg.list}
                upcoming={upcoming}
                todayCount={todayCount}
              />
            );
          })}

          {/* Grand total */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 text-sm text-gray-700 flex flex-wrap gap-6">
            <span><strong>{data.groups.length}</strong> יעדים</span>
            <span><strong>{data.groups.reduce((s, g) => s + g.orderCount, 0)}</strong> הזמנות</span>
            <span><strong>{data.groups.reduce((s, g) => s + g.totalLines, 0)}</strong> שורות</span>
            <span>
              <strong>{data.groups.filter((g) => (g.scheduledDays || []).includes(todayLabel)).length}</strong> מתוזמנים להיום ({todayLabel})
            </span>
          </div>
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

function ReasonsList({ reasons }) {
  return (
    <div className="space-y-1">
      {reasons.map((r, i) => {
        if (r.type === 'low_total') {
          return (
            <div key={i} className="flex items-center gap-1 text-amber-700">
              <Coins size={12} />
              <span>סך לקוח {formatNis(r.total)} &lt; {formatNis(r.threshold)}</span>
            </div>
          );
        }
        if (r.type === 'too_few_lines') {
          return (
            <div key={i} className="flex items-center gap-1 text-orange-700">
              <Package size={12} />
              <span>{r.linesCount} פריטים בהזמנה (מינימום {r.threshold})</span>
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
              <ul className="text-[10px] text-gray-700 mr-5 mt-0.5 list-disc">
                {r.items.slice(0, 5).map((it, idx) => (
                  <li key={idx}>
                    <span className="font-mono text-gray-500">{it.itemCode}</span>
                    {it.itemName ? <span className="mr-1">{it.itemName}</span> : null}
                    <span className="text-red-600 font-semibold mr-1">
                      (חסר {(it.needed - it.available).toFixed(0)})
                    </span>
                  </li>
                ))}
                {r.items.length > 5 && (
                  <li className="text-gray-400">ועוד {r.items.length - 5} פריטים…</li>
                )}
              </ul>
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
