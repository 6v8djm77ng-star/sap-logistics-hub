/**
 * Warehouse page - shows all picking waves across runs.
 * Warehouse worker picks a wave to start picking.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../services/api.js';
import { runsApi } from '../services/api.js';
import { format } from 'date-fns';
import { useState } from 'react';
import {
  Package, Zap, ChevronLeft, Clock, CheckCircle,
  AlertTriangle, Warehouse, Plus, BarChart3, Layers, Users,
} from 'lucide-react';

// Picking-mode badge: a one-line visual cue for the warehouse worker so they
// know HOW to organize the run before opening the picking page itself.
// SINGLE      = one consolidated picking list (no badge — default)
// BY_PALLET   = manager set pallet labels per stop, pick groups by pallet
// BY_CUSTOMER = pick groups per customer
function PalletModeBadge({ mode }) {
  if (!mode || mode === 'SINGLE') return null;
  const cfg = mode === 'BY_PALLET'
    ? { icon: Layers, label: 'לפי משטח', cls: 'bg-amber-100 text-amber-800 border-amber-300' }
    : mode === 'BY_CUSTOMER'
      ? { icon: Users,  label: 'לפי לקוח', cls: 'bg-purple-100 text-purple-800 border-purple-300' }
      : null;
  if (!cfg) return null;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border ${cfg.cls}`}>
      <Icon size={10} /> {cfg.label}
    </span>
  );
}

export default function WarehousePage() {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  const { data: runs, isLoading } = useQuery({
    queryKey: ['runs-warehouse', date],
    queryFn: () => runsApi.list({ runDate: date }),
    refetchInterval: 20_000,
  });

  const { data: wavesData } = useQuery({
    queryKey: ['all-waves', date],
    queryFn: () => api.get('/picking/waves', { params: { runDate: date } }).then((r) => r.data.waves),
    refetchInterval: 15_000,
  });

  const waves = wavesData || [];
  const runsList = runs || [];

  // Runs that need picking (no wave, or wave not completed)
  const runsNeedingPicking = runsList.filter((r) =>
    ['OPEN', 'PLANNED'].includes(r.Status) && r.OrderCount > 0
  );

  const activeWaves = waves.filter((w) => ['PENDING', 'IN_PROGRESS'].includes(w.Status));
  const completedWaves = waves.filter((w) => w.Status === 'COMPLETED');

  const totalItemsToPick = activeWaves.reduce((s, w) => s + (w.TotalLines || 0), 0);
  const totalItemsPicked = completedWaves.reduce((s, w) => s + (w.TotalLines || 0), 0);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Warehouse className="text-brand-600" /> ליקוט מחסן
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            גלי ליקוט פעילים · {format(new Date(date), 'dd/MM/yyyy')}
          </p>
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="px-3 py-1.5 border rounded-lg text-sm"
        />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="bg-white border rounded-xl p-4">
          <div className="flex items-center gap-2 text-gray-600 text-sm mb-1">
            <Package size={16} /> פריטים לליקוט
          </div>
          <div className="text-2xl font-bold">{totalItemsToPick}</div>
          <div className="text-xs text-gray-500 mt-0.5">בגלים פעילים</div>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <div className="flex items-center gap-2 text-green-600 text-sm mb-1">
            <CheckCircle size={16} /> הושלמו היום
          </div>
          <div className="text-2xl font-bold text-green-700">{totalItemsPicked}</div>
          <div className="text-xs text-gray-500 mt-0.5">{completedWaves.length} גלים</div>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <div className="flex items-center gap-2 text-amber-600 text-sm mb-1">
            <Clock size={16} /> בתהליך
          </div>
          <div className="text-2xl font-bold text-amber-700">{activeWaves.filter((w) => w.Status === 'IN_PROGRESS').length}</div>
          <div className="text-xs text-gray-500 mt-0.5">גלים שנמצאים בעבודה</div>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <div className="flex items-center gap-2 text-gray-600 text-sm mb-1">
            <AlertTriangle size={16} /> ממתין ליצירה
          </div>
          <div className="text-2xl font-bold">{runsNeedingPicking.length}</div>
          <div className="text-xs text-gray-500 mt-0.5">מסלולים ללא גל ליקוט</div>
        </div>
      </div>

      {/* Runs needing picking */}
      {runsNeedingPicking.length > 0 && (
        <div className="mb-6">
          <h2 className="font-semibold text-gray-900 mb-3">מסלולים ממתינות ליצירת גל ליקוט</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {runsNeedingPicking.map((r) => (
              <Link
                key={r.RunId}
                to={`/warehouse/runs/${r.RunId}`}
                className="bg-white border-2 border-dashed border-gray-300 hover:border-brand-500 rounded-xl p-4 transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: r.ZoneColor }} />
                    <span className="font-medium">{r.RunNumber}</span>
                  </div>
                  <Zap size={14} className="text-brand-600" />
                </div>
                <div className="text-sm text-gray-600 flex items-center gap-2">
                  <span>{r.ZoneName}</span>
                  <PalletModeBadge mode={r.PalletMode} />
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {r.StopCount} עצירות · {r.OrderCount} הזמנות
                </div>
                <div className="mt-3 text-xs text-brand-600 font-medium">
                  לחץ ליצירת גל ליקוט →
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Active waves */}
      {activeWaves.length > 0 && (
        <div className="mb-6">
          <h2 className="font-semibold text-gray-900 mb-3">גלים פעילים</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {activeWaves.map((w) => {
              const run = runsList.find((r) => r.RunId === w.RunId);
              return (
                <Link
                  key={w.WaveId}
                  to={`/warehouse/runs/${w.RunId}`}
                  className="bg-white border border-gray-200 hover:border-brand-500 rounded-xl p-4 transition-colors"
                >
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="font-semibold">{w.WaveNumber}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      w.Status === 'IN_PROGRESS' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-700'
                    }`}>
                      {w.Status === 'IN_PROGRESS' ? 'בתהליך' : 'ממתין'}
                    </span>
                  </div>
                  <div className="text-sm text-gray-600 mb-2 flex items-center gap-2 flex-wrap">
                    {run && (
                      <span className="inline-flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: run.ZoneColor }} />
                        {run.ZoneName}
                      </span>
                    )}
                    <span>· {w.RunNumber}</span>
                    <PalletModeBadge mode={run?.PalletMode} />
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>{w.TotalLines} פריטים</span>
                    {w.PickedByName && <span>לקט: {w.PickedByName}</span>}
                    <ChevronLeft size={14} />
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Completed waves */}
      {completedWaves.length > 0 && (
        <div>
          <h2 className="font-semibold text-gray-900 mb-3">גלים שהושלמו היום</h2>
          <div className="bg-white border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="p-3 text-right">גל</th>
                  <th className="p-3 text-right">מסלול</th>
                  <th className="p-3 text-center">פריטים</th>
                  <th className="p-3 text-right">לקט</th>
                  <th className="p-3 text-right">התחיל</th>
                  <th className="p-3 text-right">הושלם</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {completedWaves.map((w) => (
                  <tr key={w.WaveId} className="hover:bg-gray-50">
                    <td className="p-3">
                      <Link to={`/warehouse/runs/${w.RunId}`} className="font-mono text-sm text-brand-600 hover:underline">
                        {w.WaveNumber}
                      </Link>
                    </td>
                    <td className="p-3">{w.RunNumber}</td>
                    <td className="p-3 text-center">{w.TotalLines}</td>
                    <td className="p-3">{w.PickedByName || '—'}</td>
                    <td className="p-3 text-xs text-gray-500">
                      {w.StartedAt ? format(new Date(w.StartedAt), 'HH:mm') : '—'}
                    </td>
                    <td className="p-3 text-xs text-gray-500">
                      {w.CompletedAt ? format(new Date(w.CompletedAt), 'HH:mm') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {runsNeedingPicking.length === 0 && activeWaves.length === 0 && completedWaves.length === 0 && (
        <div className="bg-white border rounded-xl p-12 text-center">
          <Warehouse className="mx-auto text-gray-400 mb-3" size={40} />
          <p className="text-gray-500 mb-4">
            אין מסלולים לתאריך זה. צור מסלולים בדף "תכנון יומי".
          </p>
          <Link
            to="/planner"
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm"
          >
            <Plus size={14} /> עבור לתכנון
          </Link>
        </div>
      )}
    </div>
  );
}
