import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ordersApi, runsApi } from '../services/api.js';
import api from '../services/api.js';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Zap, Package, AlertTriangle, ChevronDown, ChevronUp, Coins, PackageX, Plus } from 'lucide-react';

export default function PlannerPage() {
  const [runDate, setRunDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [planResult, setPlanResult] = useState(null); // last auto-plan response
  const [showExcluded, setShowExcluded] = useState(true);
  const queryClient = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['unified', runDate],
    queryFn: () => ordersApi.unified({ fromDate: runDate, toDate: runDate }),
  });

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
            onClick={() => autoPlanMutation.mutate()}
            disabled={autoPlanMutation.isPending}
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

      {isLoading ? (
        <div className="text-center py-12 text-gray-500">טוען...</div>
      ) : !data?.groups?.length ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <Package className="mx-auto text-gray-400 mb-3" size={40} />
          <p className="text-gray-500">אין הזמנות פתוחות לתאריך זה</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-4 py-3 text-right font-medium">כתובת יעד</th>
                <th className="px-4 py-3 text-right font-medium">סניף / לקוח</th>
                <th className="px-4 py-3 text-center font-medium">חברות</th>
                <th className="px-4 py-3 text-center font-medium">הזמנות</th>
                <th className="px-4 py-3 text-center font-medium">שורות</th>
                <th className="px-4 py-3 text-right font-medium">אזור</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.groups.map((g) => (
                <tr key={g.addressId} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium">
                      {g.address.Street} {g.address.BuildingNumber}
                    </div>
                    <div className="text-xs text-gray-500">{g.address.City}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {g.address.BranchName || g.orders[0]?.cardName}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex justify-center gap-1">
                      {g.hasCompanyA && <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded">א</span>}
                      {g.hasCompanyB && <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded">ב</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center font-medium">{g.orderCount}</td>
                  <td className="px-4 py-3 text-center">{g.totalLines}</td>
                  <td className="px-4 py-3 text-gray-700">
                    {g.address.ZoneId ? `אזור ${g.address.ZoneId}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 font-medium">
              <tr>
                <td colSpan={3} className="px-4 py-3">סה"כ {data.groups.length} יעדים</td>
                <td className="px-4 py-3 text-center">
                  {data.groups.reduce((s, g) => s + g.orderCount, 0)}
                </td>
                <td className="px-4 py-3 text-center">
                  {data.groups.reduce((s, g) => s + g.totalLines, 0)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Excluded orders panel
// ----------------------------------------------------------------------------
function ExcludedOrdersPanel({ orders, summary, open, onToggle, onForceInclude, forcing }) {
  const lowTotal = summary?.excludedLowTotal || 0;
  const missingStock = summary?.excludedMissingStock || 0;

  return (
    <div className="mb-6 bg-amber-50 border-2 border-amber-300 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-amber-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="text-amber-600" size={20} />
          <span className="font-bold text-amber-900">
            {orders.length} הזמנות לא נכללו במסלולים
          </span>
          <span className="text-xs text-amber-700">
            ({lowTotal > 0 && `${lowTotal} מתחת ל-3,000 ש״ח`}
            {lowTotal > 0 && missingStock > 0 && ' · '}
            {missingStock > 0 && `${missingStock} חוסר במלאי`})
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
