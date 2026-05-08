/**
 * Weekly Report - aggregate runs/orders/delivers over a 7-day range.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../services/api.js';
import { runsApi } from '../services/api.js';
import { format, subDays, addDays, startOfWeek, endOfWeek } from 'date-fns';
import {
  Calendar, Download, TrendingUp, Truck, Package, CheckCircle,
  XCircle, Users, MapPin, Printer, ArrowLeft, ArrowRight,
} from 'lucide-react';

export default function WeeklyReportPage() {
  const [endDate, setEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const startDate = format(subDays(new Date(endDate), 6), 'yyyy-MM-dd');

  // Fetch all runs in date range - day by day
  const dates = Array.from({ length: 7 }, (_, i) => format(subDays(new Date(endDate), 6 - i), 'yyyy-MM-dd'));
  const queries = dates.map((d) => useQuery({
    queryKey: ['runs', d],
    queryFn: () => runsApi.list({ runDate: d }),
  }));

  const allRuns = queries.flatMap((q) => q.data || []);
  const isLoading = queries.some((q) => q.isLoading);

  // Get drivers for driver stats
  const { data: drivers } = useQuery({
    queryKey: ['drivers'],
    queryFn: () => api.get('/drivers').then((r) => r.data.drivers),
  });

  // Aggregate stats
  const totalRuns = allRuns.length;
  const totalStops = allRuns.reduce((s, r) => s + (r.StopCount || 0), 0);
  const totalOrders = allRuns.reduce((s, r) => s + (r.OrderCount || 0), 0);
  const completedRuns = allRuns.filter((r) => r.Status === 'COMPLETED').length;
  const inProgressRuns = allRuns.filter((r) => ['IN_TRANSIT', 'LOADED', 'PICKING'].includes(r.Status)).length;

  // Per-day breakdown
  const dailyStats = dates.map((d) => {
    const dayRuns = allRuns.filter((r) => r.RunDate === d);
    return {
      date: d,
      dayName: ['א','ב','ג','ד','ה','ו','ש'][new Date(d).getDay()],
      runs: dayRuns.length,
      stops: dayRuns.reduce((s, r) => s + (r.StopCount || 0), 0),
      orders: dayRuns.reduce((s, r) => s + (r.OrderCount || 0), 0),
      completed: dayRuns.filter((r) => r.Status === 'COMPLETED').length,
    };
  });

  // Per-driver breakdown
  const driverStats = (drivers || []).map((d) => {
    const driverRuns = allRuns.filter((r) => r.DriverId === d.DriverId);
    return {
      ...d,
      runs: driverRuns.length,
      stops: driverRuns.reduce((s, r) => s + (r.StopCount || 0), 0),
      orders: driverRuns.reduce((s, r) => s + (r.OrderCount || 0), 0),
      completed: driverRuns.filter((r) => r.Status === 'COMPLETED').length,
    };
  }).filter((d) => d.runs > 0);

  // Per-zone breakdown
  const zoneStats = {};
  for (const r of allRuns) {
    const key = r.ZoneName || '—';
    if (!zoneStats[key]) {
      zoneStats[key] = { name: key, color: r.ZoneColor, runs: 0, stops: 0, orders: 0 };
    }
    zoneStats[key].runs++;
    zoneStats[key].stops += r.StopCount || 0;
    zoneStats[key].orders += r.OrderCount || 0;
  }

  const maxDayValue = Math.max(...dailyStats.map((d) => d.stops), 1);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Calendar className="text-brand-600" /> דוח שבועי
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {format(new Date(startDate), 'dd/MM')} - {format(new Date(endDate), 'dd/MM/yyyy')} (7 ימים)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEndDate(format(subDays(new Date(endDate), 7), 'yyyy-MM-dd'))}
            className="p-2 border rounded-lg hover:bg-gray-50"
            title="שבוע קודם"
          >
            <ArrowRight size={14} />
          </button>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="px-3 py-1.5 border rounded-lg text-sm"
          />
          <button
            onClick={() => setEndDate(format(addDays(new Date(endDate), 7), 'yyyy-MM-dd'))}
            className="p-2 border rounded-lg hover:bg-gray-50"
            title="שבוע הבא"
          >
            <ArrowLeft size={14} />
          </button>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50"
          >
            <Printer size={14} /> הדפס
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <div className="bg-white border rounded-xl p-4">
          <Truck className="text-brand-500 mb-2" size={20} />
          <div className="text-xs text-gray-500">מסלולים</div>
          <div className="text-2xl font-bold">{totalRuns}</div>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <MapPin className="text-amber-500 mb-2" size={20} />
          <div className="text-xs text-gray-500">עצירות</div>
          <div className="text-2xl font-bold">{totalStops}</div>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <Package className="text-blue-500 mb-2" size={20} />
          <div className="text-xs text-gray-500">הזמנות</div>
          <div className="text-2xl font-bold">{totalOrders}</div>
        </div>
        <div className="bg-green-50 border border-green-200 rounded-xl p-4">
          <CheckCircle className="text-green-600 mb-2" size={20} />
          <div className="text-xs text-green-700">הושלמו</div>
          <div className="text-2xl font-bold text-green-900">{completedRuns}</div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <TrendingUp className="text-amber-600 mb-2" size={20} />
          <div className="text-xs text-amber-700">בתהליך</div>
          <div className="text-2xl font-bold text-amber-900">{inProgressRuns}</div>
        </div>
      </div>

      {/* Daily bar chart */}
      <div className="bg-white border rounded-xl p-5 mb-6">
        <h2 className="font-semibold mb-4">פעילות יומית - {format(new Date(startDate), 'dd/MM')} - {format(new Date(endDate), 'dd/MM')}</h2>
        <div className="flex items-end gap-3 h-48">
          {dailyStats.map((d) => {
            const height = maxDayValue > 0 ? (d.stops / maxDayValue) * 100 : 0;
            return (
              <div key={d.date} className="flex-1 flex flex-col items-center">
                <div className="text-xs text-gray-500 mb-1">{d.stops}</div>
                <div className="w-full flex-1 bg-gray-100 rounded-t-lg relative overflow-hidden">
                  <div
                    className="absolute bottom-0 w-full bg-gradient-to-t from-brand-600 to-brand-400 transition-all"
                    style={{ height: `${height}%` }}
                  />
                </div>
                <div className="text-xs font-medium mt-2">{d.dayName}</div>
                <div className="text-xs text-gray-400">{format(new Date(d.date), 'dd/MM')}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-driver table */}
      <div className="bg-white border rounded-xl p-5 mb-6">
        <h2 className="font-semibold mb-4 flex items-center gap-2">
          <Users size={16} /> ביצועי נהגים
        </h2>
        {driverStats.length === 0 ? (
          <p className="text-center text-gray-500 py-6 text-sm">אין נתונים לנהגים בשבוע זה</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 border-b">
              <tr>
                <th className="py-2 text-right">נהג</th>
                <th className="py-2 text-center">מסלולים</th>
                <th className="py-2 text-center">עצירות</th>
                <th className="py-2 text-center">הזמנות</th>
                <th className="py-2 text-center">הושלמו</th>
                <th className="py-2 text-center">שיעור השלמה</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {driverStats.sort((a, b) => b.stops - a.stops).map((d) => (
                <tr key={d.DriverId} className="hover:bg-gray-50">
                  <td className="py-2">
                    <div className="font-medium">{d.FullName}</div>
                    <div className="text-xs text-gray-500 font-mono">{d.Code}</div>
                  </td>
                  <td className="py-2 text-center">{d.runs}</td>
                  <td className="py-2 text-center font-medium">{d.stops}</td>
                  <td className="py-2 text-center">{d.orders}</td>
                  <td className="py-2 text-center text-green-700">{d.completed}</td>
                  <td className="py-2 text-center">
                    {d.runs > 0 ? (
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        d.completed / d.runs >= 0.8 ? 'bg-green-100 text-green-700' :
                        d.completed / d.runs >= 0.5 ? 'bg-amber-100 text-amber-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {Math.round((d.completed / d.runs) * 100)}%
                      </span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Per-zone */}
      <div className="bg-white border rounded-xl p-5">
        <h2 className="font-semibold mb-4 flex items-center gap-2">
          <MapPin size={16} /> ביצועי אזורים
        </h2>
        {Object.keys(zoneStats).length === 0 ? (
          <p className="text-center text-gray-500 py-6 text-sm">אין נתונים לאזורים</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {Object.values(zoneStats).sort((a, b) => b.orders - a.orders).map((z) => (
              <div key={z.name} className="border rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: z.color }} />
                  <span className="font-medium">{z.name}</span>
                </div>
                <div className="text-xs text-gray-500 flex items-center gap-3">
                  <span>{z.runs} מסלולים</span>
                  <span>·</span>
                  <span>{z.stops} עצירות</span>
                  <span>·</span>
                  <span>{z.orders} הזמנות</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
