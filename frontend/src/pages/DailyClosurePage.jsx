/**
 * Daily Closure - end-of-day summary showing full journey:
 * Orders → Runs → Picking → Delivery → SAP sync status.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../services/api.js';
import { runsApi } from '../services/api.js';
import { format } from 'date-fns';
import {
  Calendar, CheckCircle, Clock, AlertTriangle, Package,
  Truck, Warehouse, MapPin, Printer, FileCheck,
} from 'lucide-react';

export default function DailyClosurePage() {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  const { data: runs } = useQuery({
    queryKey: ['runs', date],
    queryFn: () => runsApi.list({ runDate: date }),
  });

  const { data: waves } = useQuery({
    queryKey: ['waves', date],
    queryFn: () => api.get('/picking/waves', { params: { runDate: date } }).then((r) => r.data.waves),
  });

  const { data: failures } = useQuery({
    queryKey: ['failures'],
    queryFn: () => api.get('/failures').then((r) => r.data.failures),
  });

  const runsList = runs || [];
  const wavesList = waves || [];
  const failuresList = (failures || []).filter((f) => f.ResolutionStatus === 'OPEN');

  const totalStops = runsList.reduce((s, r) => s + (r.StopCount || 0), 0);
  const totalOrders = runsList.reduce((s, r) => s + (r.OrderCount || 0), 0);

  // Run stats
  const runsByStatus = {
    completed: runsList.filter((r) => r.Status === 'COMPLETED').length,
    inTransit: runsList.filter((r) => r.Status === 'IN_TRANSIT').length,
    loaded: runsList.filter((r) => r.Status === 'LOADED').length,
    picking: runsList.filter((r) => r.Status === 'PICKING').length,
    planned: runsList.filter((r) => ['PLANNED', 'OPEN'].includes(r.Status)).length,
    cancelled: runsList.filter((r) => r.Status === 'CANCELLED').length,
  };

  // Picking stats
  const picksCompleted = wavesList.filter((w) => w.Status === 'COMPLETED').length;
  const picksInProgress = wavesList.filter((w) => w.Status === 'IN_PROGRESS').length;
  const picksPending = wavesList.filter((w) => w.Status === 'PENDING').length;

  const completionPct = totalStops > 0
    ? Math.round((runsByStatus.completed / runsList.length) * 100)
    : 0;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileCheck className="text-brand-600" /> סגירת יום
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            סיכום פעילות של {format(new Date(date), 'dd/MM/yyyy')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="px-3 py-1.5 border rounded-lg text-sm"
          />
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50"
          >
            <Printer size={14} /> הדפס
          </button>
        </div>
      </div>

      {/* Top completion metric */}
      <div className={`rounded-2xl p-6 mb-6 text-white ${
        completionPct === 100 ? 'bg-gradient-to-br from-green-500 to-green-700' :
        completionPct >= 70 ? 'bg-gradient-to-br from-blue-500 to-blue-700' :
        'bg-gradient-to-br from-amber-500 to-amber-700'
      }`}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm opacity-90 mb-1">השלמת יום</div>
            <div className="text-5xl font-bold">{completionPct}%</div>
            <div className="text-sm opacity-90 mt-2">
              {runsByStatus.completed} מתוך {runsList.length} מסלולים הושלמו
            </div>
          </div>
          <div className="text-right">
            <div className="text-6xl">
              {completionPct === 100 ? '🎉' : completionPct >= 70 ? '🚚' : '⏳'}
            </div>
          </div>
        </div>
      </div>

      {/* 4-stage flow */}
      <div className="mb-6">
        <h2 className="font-semibold text-gray-900 mb-3">זרימת היום</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {/* Stage 1: Planning */}
          <div className="bg-white border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2 text-blue-600">
              <Calendar size={20} />
              <span className="font-medium">1. תכנון</span>
            </div>
            <div className="text-3xl font-bold">{runsList.length}</div>
            <div className="text-xs text-gray-500 mt-1">מסלולים</div>
            <div className="text-xs text-gray-500">{totalOrders} הזמנות · {totalStops} עצירות</div>
          </div>

          {/* Stage 2: Picking */}
          <div className="bg-white border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2 text-purple-600">
              <Warehouse size={20} />
              <span className="font-medium">2. ליקוט</span>
            </div>
            <div className="text-3xl font-bold">{picksCompleted}</div>
            <div className="text-xs text-gray-500 mt-1">גלים הושלמו</div>
            <div className="text-xs text-gray-500">
              {picksInProgress} בתהליך · {picksPending} ממתינים
            </div>
          </div>

          {/* Stage 3: Delivery */}
          <div className="bg-white border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2 text-amber-600">
              <Truck size={20} />
              <span className="font-medium">3. הפצה</span>
            </div>
            <div className="text-3xl font-bold">{runsByStatus.inTransit + runsByStatus.loaded}</div>
            <div className="text-xs text-gray-500 mt-1">בדרך / טוענים</div>
            <div className="text-xs text-gray-500">
              מתוכנן: {runsByStatus.planned}
            </div>
          </div>

          {/* Stage 4: Completed */}
          <div className="bg-white border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2 text-green-600">
              <CheckCircle size={20} />
              <span className="font-medium">4. הושלם</span>
            </div>
            <div className="text-3xl font-bold text-green-700">{runsByStatus.completed}</div>
            <div className="text-xs text-gray-500 mt-1">מסלולים סגורים</div>
            <div className="text-xs text-gray-500">
              {runsByStatus.cancelled > 0 && `בוטלו: ${runsByStatus.cancelled}`}
            </div>
          </div>
        </div>
      </div>

      {/* Issues */}
      {failuresList.length > 0 && (
        <div className="bg-red-50 border border-red-300 rounded-xl p-4 mb-6">
          <h2 className="font-semibold text-red-900 mb-3 flex items-center gap-2">
            <AlertTriangle size={18} /> כשלים פתוחים ({failuresList.length})
          </h2>
          <div className="space-y-2">
            {failuresList.slice(0, 5).map((f) => (
              <div key={f.FailureId} className="bg-white rounded-lg p-3 flex items-center justify-between">
                <div>
                  <div className="font-medium text-sm">{f.ReasonName}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{f.Notes}</div>
                </div>
                <Link to="/failures" className="text-xs text-red-700 hover:underline">
                  לטפל →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Runs detail */}
      <div className="bg-white border rounded-xl overflow-hidden mb-6">
        <div className="p-4 border-b">
          <h2 className="font-semibold">פירוט מסלולים</h2>
        </div>
        {runsList.length === 0 ? (
          <div className="p-12 text-center text-gray-500">אין מסלולים ביום זה</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="p-3 text-right">מסלול</th>
                <th className="p-3 text-right">אזור</th>
                <th className="p-3 text-right">נהג</th>
                <th className="p-3 text-center">עצירות</th>
                <th className="p-3 text-center">הזמנות</th>
                <th className="p-3 text-center">סטטוס</th>
                <th className="p-3 text-center">SAP</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {runsList.map((r) => {
                const wave = wavesList.find((w) => w.RunId === r.RunId);
                return (
                  <tr key={r.RunId} className="hover:bg-gray-50">
                    <td className="p-3">
                      <Link to={`/runs/${r.RunId}`} className="text-brand-600 hover:underline font-mono text-sm">
                        {r.RunNumber}
                      </Link>
                    </td>
                    <td className="p-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: r.ZoneColor }} />
                        {r.ZoneName}
                      </span>
                    </td>
                    <td className="p-3 text-gray-700">{r.DriverName || '—'}</td>
                    <td className="p-3 text-center">{r.StopCount}</td>
                    <td className="p-3 text-center">{r.OrderCount}</td>
                    <td className="p-3 text-center">
                      <span className={`px-2 py-0.5 text-xs rounded-full ${
                        r.Status === 'COMPLETED' ? 'bg-green-100 text-green-700' :
                        r.Status === 'IN_TRANSIT' ? 'bg-blue-100 text-blue-700' :
                        r.Status === 'LOADED' ? 'bg-purple-100 text-purple-700' :
                        r.Status === 'PICKING' ? 'bg-amber-100 text-amber-700' :
                        'bg-gray-100 text-gray-700'
                      }`}>
                        {r.Status}
                      </span>
                    </td>
                    <td className="p-3 text-center text-xs">
                      {r.Status === 'COMPLETED' ? (
                        <span className="text-green-700">✓ סונכרן</span>
                      ) : r.Status === 'IN_TRANSIT' ? (
                        <span className="text-gray-400">בתהליך</span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Summary box */}
      <div className="bg-gradient-to-r from-gray-50 to-white border rounded-xl p-5">
        <h2 className="font-semibold mb-3">סיכום היום</h2>
        <ul className="space-y-1 text-sm text-gray-700">
          <li className="flex items-center gap-2">
            <CheckCircle size={14} className="text-green-500" />
            {runsList.length} מסלולים נפתחו ביום זה
          </li>
          <li className="flex items-center gap-2">
            <Package size={14} className="text-blue-500" />
            {totalOrders} הזמנות ({totalStops} עצירות שונות)
          </li>
          <li className="flex items-center gap-2">
            <Warehouse size={14} className="text-purple-500" />
            {picksCompleted} גלי ליקוט הושלמו
          </li>
          <li className="flex items-center gap-2">
            <Truck size={14} className="text-amber-500" />
            {runsByStatus.completed} מסלולים נסגרו בהצלחה
          </li>
          {failuresList.length > 0 && (
            <li className="flex items-center gap-2 text-red-700">
              <AlertTriangle size={14} />
              {failuresList.length} כשלים פתוחים דורשים טיפול
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
