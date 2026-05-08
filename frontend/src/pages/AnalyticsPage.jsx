/**
 * Analytics dashboard - KPIs, trends, per-driver/zone performance.
 * Simple SVG charts (no extra dependency).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../services/api.js';
import { format, subDays } from 'date-fns';
import {
  TrendingUp, TrendingDown, Package, Truck, CheckCircle, XCircle,
  Clock, Zap, Database, AlertCircle,
} from 'lucide-react';

const analyticsApi = {
  summary: (params) => api.get('/analytics/summary', { params }).then((r) => r.data),
};

function KpiCard({ icon: Icon, label, value, sub, color = 'blue', trend = null }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-start justify-between mb-2">
        <div className={`p-2 rounded-lg bg-${color}-50 text-${color}-600`}>
          <Icon size={18} />
        </div>
        {trend != null && (
          <div className={`text-xs inline-flex items-center gap-0.5 ${trend >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {trend >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {Math.abs(Math.round(trend * 100))}%
          </div>
        )}
      </div>
      <div className="text-sm text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function BarChart({ data, valueKey, labelKey, color = '#2563eb', maxHeight = 200 }) {
  if (!data?.length) return <div className="text-sm text-gray-400 text-center py-8">אין נתונים</div>;
  const max = Math.max(...data.map((d) => Number(d[valueKey]) || 0), 1);

  return (
    <div className="flex items-end gap-1 h-52 px-1" style={{ direction: 'ltr' }}>
      {data.map((d, idx) => {
        const val = Number(d[valueKey]) || 0;
        const h = (val / max) * maxHeight;
        return (
          <div key={idx} className="flex-1 flex flex-col items-center gap-1 group">
            <div className="text-[10px] text-gray-500 group-hover:font-semibold">{val}</div>
            <div
              className="w-full rounded-t hover:opacity-80 transition-opacity"
              style={{ height: `${h}px`, background: color, minHeight: val > 0 ? 2 : 0 }}
            />
            <div className="text-[10px] text-gray-400 whitespace-nowrap" dir="rtl">
              {d[labelKey]}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StackedBarChart({ data, labelKey, series }) {
  if (!data?.length) return null;
  const totals = data.map((d) => series.reduce((sum, s) => sum + (Number(d[s.key]) || 0), 0));
  const max = Math.max(...totals, 1);

  return (
    <div className="flex items-end gap-2 h-52 px-1" style={{ direction: 'ltr' }}>
      {data.map((d, idx) => {
        const total = totals[idx];
        const h = (total / max) * 180;
        return (
          <div key={idx} className="flex-1 flex flex-col items-center gap-1">
            <div className="text-[10px] text-gray-500">{total}</div>
            <div className="w-full flex flex-col-reverse" style={{ height: `${h}px` }}>
              {series.map((s) => {
                const v = Number(d[s.key]) || 0;
                const segH = total > 0 ? (v / total) * h : 0;
                return (
                  <div
                    key={s.key}
                    style={{ height: `${segH}px`, background: s.color }}
                    title={`${s.label}: ${v}`}
                  />
                );
              })}
            </div>
            <div className="text-[10px] text-gray-400 whitespace-nowrap" dir="rtl">
              {d[labelKey]}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function AnalyticsPage() {
  const [range, setRange] = useState(() => ({
    fromDate: format(subDays(new Date(), 29), 'yyyy-MM-dd'),
    toDate: format(new Date(), 'yyyy-MM-dd'),
  }));

  const { data, isLoading } = useQuery({
    queryKey: ['analytics', range],
    queryFn: () => analyticsApi.summary(range),
  });

  if (isLoading) return <div className="p-6">טוען...</div>;
  if (!data) return null;

  const { overall, daily, drivers, zones, failures, syncHealth } = data;
  const dailyChartData = daily.map((d) => ({
    ...d,
    ShortDate: format(new Date(d.RunDate), 'dd/MM'),
  }));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">ניתוח ביצועים</h1>
          <p className="text-sm text-gray-500 mt-1">KPIs, מגמות וביצועי נהגים</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={range.fromDate}
            onChange={(e) => setRange({ ...range, fromDate: e.target.value })}
            className="px-3 py-1.5 border rounded-lg text-sm"
          />
          <span className="text-gray-400">—</span>
          <input
            type="date"
            value={range.toDate}
            onChange={(e) => setRange({ ...range, toDate: e.target.value })}
            className="px-3 py-1.5 border rounded-lg text-sm"
          />
        </div>
      </div>

      {/* Top KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KpiCard icon={Truck} label="מסלולים" value={overall.totalRuns}
          sub={`${overall.completedRuns} הושלמו`} color="blue" />
        <KpiCard icon={Package} label="הזמנות נמסרו" value={overall.deliveredOrders}
          sub={`${overall.ordersCompanyA} חברה א · ${overall.ordersCompanyB} חברה ב`} color="green" />
        <KpiCard icon={CheckCircle} label="הצלחה" color="green"
          value={overall.successRate != null ? `${Math.round(overall.successRate * 100)}%` : '—'}
          sub={`${overall.deliveredStops}/${overall.totalStops} עצירות`} />
        <KpiCard icon={XCircle} label="כשלים" color="red"
          value={overall.failedStops}
          sub={overall.failureRate != null ? `${Math.round(overall.failureRate * 100)}% מהעצירות` : ''} />
      </div>

      {/* Secondary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <KpiCard icon={Zap} label="איחוד" color="purple"
          value={overall.mergerRatio != null ? `${Math.round(overall.mergerRatio * 100)}%` : '—'}
          sub={`${overall.mergedStops}/${overall.unifiedStops} עצירות מאוחדות`} />
        <KpiCard icon={Clock} label="זמן ממוצע לעצירה" color="amber"
          value={overall.avgStopMinutes != null ? `${overall.avgStopMinutes} דק'` : '—'} />
        <KpiCard icon={Clock} label="זמן ממוצע למסלול" color="amber"
          value={overall.avgRunMinutes != null ? `${Math.round(overall.avgRunMinutes / 60)}h ${overall.avgRunMinutes % 60}m` : '—'} />
        <KpiCard icon={Database} label="SAP sync"
          color={syncHealth.PendingDeliveryNotes > 0 ? 'amber' : 'green'}
          value={syncHealth.PendingDeliveryNotes === 0 ? '✓' : `${syncHealth.PendingDeliveryNotes} ממתינים`}
          sub={`${syncHealth.SyncedDeliveryNotes} סונכרנו · ${syncHealth.QueueBacklog} בתור`} />
      </div>

      {/* Daily trend */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
        <h2 className="text-lg font-semibold mb-1">מגמה יומית</h2>
        <p className="text-xs text-gray-500 mb-4">מסירות מול כשלים לפי יום</p>
        <StackedBarChart
          data={dailyChartData}
          labelKey="ShortDate"
          series={[
            { key: 'Delivered', label: 'נמסרו', color: '#10b981' },
            { key: 'Failed',    label: 'כשלו',   color: '#ef4444' },
          ]}
        />
        <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
          <span><span className="inline-block w-3 h-3 bg-green-500 rounded ml-1"></span>נמסרו</span>
          <span><span className="inline-block w-3 h-3 bg-red-500 rounded ml-1"></span>כשלו</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Drivers */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <h2 className="text-lg font-semibold mb-4">ביצועי נהגים</h2>
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="text-right font-medium pb-2">נהג</th>
                <th className="text-center font-medium pb-2">עצירות</th>
                <th className="text-center font-medium pb-2">הצלחה</th>
                <th className="text-center font-medium pb-2">⌀ עצירה</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {drivers.map((d) => {
                const successRate = d.TotalStops > 0
                  ? Math.round((d.DeliveredStops / d.TotalStops) * 100)
                  : null;
                return (
                  <tr key={d.DriverId}>
                    <td className="py-2">
                      <div className="font-medium">{d.FullName}</div>
                      <div className="text-xs text-gray-500 font-mono">{d.Code}</div>
                    </td>
                    <td className="py-2 text-center">{d.DeliveredStops}/{d.TotalStops}</td>
                    <td className="py-2 text-center">
                      {successRate != null ? (
                        <span className={`px-2 py-0.5 rounded text-xs ${successRate >= 90 ? 'bg-green-100 text-green-700' : successRate >= 70 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                          {successRate}%
                        </span>
                      ) : '—'}
                    </td>
                    <td className="py-2 text-center text-gray-600">
                      {d.AvgStopMinutes ? `${Math.round(d.AvgStopMinutes)} דק'` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Zones */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <h2 className="text-lg font-semibold mb-4">ביצועי אזורים</h2>
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="text-right font-medium pb-2">אזור</th>
                <th className="text-center font-medium pb-2">מסלולים</th>
                <th className="text-center font-medium pb-2">הזמנות</th>
                <th className="text-center font-medium pb-2">כשלים</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {zones.map((z) => (
                <tr key={z.ZoneId}>
                  <td className="py-2">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: z.ColorHex || '#9ca3af' }} />
                      {z.Name}
                    </span>
                  </td>
                  <td className="py-2 text-center">{z.Runs}</td>
                  <td className="py-2 text-center font-medium">{z.TotalOrders}</td>
                  <td className="py-2 text-center">
                    {z.FailedStops > 0 ? (
                      <span className="text-red-600">{z.FailedStops}</span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Failure breakdown */}
      {failures.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <h2 className="text-lg font-semibold mb-4">פירוט סיבות כשל</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {failures.map((f) => (
              <div key={f.ReasonCode} className="border border-gray-200 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-sm">{f.Name}</span>
                  <span className="text-lg font-bold">{f.Count}</span>
                </div>
                <div className="text-xs text-gray-500 flex items-center gap-3">
                  {f.Rescheduled > 0 && <span>↪ {f.Rescheduled} תוזמנו מחדש</span>}
                  {f.StillOpen > 0 && <span className="text-red-600">⚠ {f.StillOpen} פתוחים</span>}
                  {f.Cancelled > 0 && <span>✗ {f.Cancelled} בוטלו</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
