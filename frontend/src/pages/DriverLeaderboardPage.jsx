/**
 * Driver leaderboard - shows performance per driver per zone.
 * Used for: hiring decisions, bonus calculation, route assignment.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../services/api.js';
import { Trophy, Clock, CheckCircle, XCircle, MapPin, Award } from 'lucide-react';

export default function DriverLeaderboardPage() {
  const [zoneFilter, setZoneFilter] = useState('all');

  const { data, isLoading } = useQuery({
    queryKey: ['driver-perf'],
    queryFn: () => api.get('/analytics/driver-performance').then((r) => r.data),
    refetchInterval: 30_000,
  });

  const stats = data?.stats || [];
  const zones = useMemo(() => {
    const set = new Set(stats.map((s) => s.ZoneCode).filter(Boolean));
    return Array.from(set).sort();
  }, [stats]);

  // Aggregate per driver across all zones (or filter to one zone)
  const aggregated = useMemo(() => {
    const filtered = zoneFilter === 'all' ? stats : stats.filter((s) => s.ZoneCode === zoneFilter);
    const byDriver = new Map();
    for (const s of filtered) {
      if (!byDriver.has(s.DriverId)) {
        byDriver.set(s.DriverId, {
          DriverId: s.DriverId,
          DriverName: s.DriverName,
          TotalStops: 0, Delivered: 0, Failed: 0,
          AvgMinutesPerStop: 0,
          zoneCount: 0,
          minSum: 0,
        });
      }
      const e = byDriver.get(s.DriverId);
      e.TotalStops += s.TotalStops;
      e.Delivered += s.Delivered;
      e.Failed += s.Failed;
      if (s.AvgMinutesPerStop > 0) {
        e.minSum += s.AvgMinutesPerStop;
        e.zoneCount += 1;
      }
    }
    const arr = Array.from(byDriver.values()).map((e) => ({
      ...e,
      AvgMinutesPerStop: e.zoneCount > 0 ? Math.round(e.minSum / e.zoneCount) : 0,
      SuccessRate: e.TotalStops > 0 ? e.Delivered / e.TotalStops : 0,
      Score: scoreOf(e),
    }));
    arr.sort((a, b) => b.Score - a.Score);
    return arr;
  }, [stats, zoneFilter]);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Trophy className="text-amber-500" /> טבלת ביצועי נהגים
          </h1>
          <p className="text-sm text-gray-500 mt-1">מדדי הצלחה ומהירות לכל נהג ולכל אזור</p>
        </div>
        <select
          value={zoneFilter}
          onChange={(e) => setZoneFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="all">כל האזורים</option>
          {zones.map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-500">טוען...</div>
      ) : aggregated.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <Trophy className="mx-auto text-gray-400 mb-3" size={40} />
          <p className="text-gray-500 mb-2">עוד אין נתונים</p>
          <p className="text-xs text-gray-400">הסטטיסטיקה מצטברת אוטומטית עם כל מסירה שנהגים מסיימים.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {aggregated.map((e, idx) => (
            <DriverCard key={e.DriverId} driver={e} rank={idx + 1} />
          ))}
        </div>
      )}

      {/* Per-zone breakdown */}
      {stats.length > 0 && zoneFilter === 'all' && (
        <div className="mt-8">
          <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
            <MapPin /> פירוט לפי אזור
          </h2>
          <div className="bg-white border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-right">נהג</th>
                  <th className="px-3 py-2 text-right">אזור</th>
                  <th className="px-3 py-2 text-center">עצירות</th>
                  <th className="px-3 py-2 text-center">הצלחה</th>
                  <th className="px-3 py-2 text-center">דק׳ ממוצע</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {stats
                  .slice()
                  .sort((a, b) => b.TotalStops - a.TotalStops)
                  .map((s) => (
                    <tr key={`${s.DriverId}-${s.ZoneCode}`} className="hover:bg-gray-50">
                      <td className="px-3 py-2">{s.DriverName}</td>
                      <td className="px-3 py-2 text-gray-600">{s.ZoneCode}</td>
                      <td className="px-3 py-2 text-center font-medium">{s.TotalStops}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`font-medium ${s.SuccessRate >= 0.9 ? 'text-green-600' : s.SuccessRate >= 0.75 ? 'text-amber-600' : 'text-red-600'}`}>
                          {Math.round(s.SuccessRate * 100)}%
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center text-gray-600">{s.AvgMinutesPerStop || '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function DriverCard({ driver, rank }) {
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
  return (
    <div className={`bg-white border-2 rounded-xl p-4 flex items-center gap-4 ${rank <= 3 ? 'border-amber-300' : 'border-gray-200'}`}>
      <div className="text-3xl w-12 text-center">{medal}</div>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-lg">{driver.DriverName}</div>
        <div className="flex flex-wrap gap-3 text-xs text-gray-600 mt-1">
          <span><CheckCircle size={11} className="inline -mt-0.5 ml-1 text-green-500" />{driver.Delivered} נמסרו</span>
          {driver.Failed > 0 && (
            <span><XCircle size={11} className="inline -mt-0.5 ml-1 text-red-500" />{driver.Failed} כשלים</span>
          )}
          {driver.AvgMinutesPerStop > 0 && (
            <span><Clock size={11} className="inline -mt-0.5 ml-1 text-gray-400" />{driver.AvgMinutesPerStop} דק׳ ממוצע לעצירה</span>
          )}
        </div>
      </div>
      <div className="text-center">
        <div className="text-3xl font-black text-amber-600">{driver.Score}</div>
        <div className="text-[10px] text-gray-500">ציון</div>
      </div>
      <div className="text-center">
        <div className={`text-xl font-bold ${driver.SuccessRate >= 0.9 ? 'text-green-600' : 'text-amber-600'}`}>
          {Math.round(driver.SuccessRate * 100)}%
        </div>
        <div className="text-[10px] text-gray-500">הצלחה</div>
      </div>
    </div>
  );
}

function scoreOf(d) {
  const succ = d.TotalStops > 0 ? d.Delivered / d.TotalStops : 0;
  const speed = d.AvgMinutesPerStop > 0
    ? Math.max(0, Math.min(1, (30 - d.AvgMinutesPerStop) / 20))
    : 0.5;
  const exp = Math.min(1, d.TotalStops / 100);
  return Math.round((succ * 0.5 + speed * 0.3 + exp * 0.2) * 100);
}
