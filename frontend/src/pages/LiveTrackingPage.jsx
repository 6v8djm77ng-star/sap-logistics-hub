/**
 * Live run tracking - real-time view of all active runs today.
 * Updates via Socket.IO when drivers report progress.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { runsApi } from '../services/api.js';
import { getSocket } from '../services/socket.js';
import StatusPill from '../components/StatusPill.jsx';
import { format } from 'date-fns';
import { Truck, Activity, CheckCircle, AlertCircle } from 'lucide-react';

export default function LiveTrackingPage() {
  const queryClient = useQueryClient();
  const today = format(new Date(), 'yyyy-MM-dd');
  const [recentEvents, setRecentEvents] = useState([]);

  const { data: runs } = useQuery({
    queryKey: ['live-runs', today],
    queryFn: () => runsApi.list({ runDate: today }),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    const socket = getSocket();

    const events = [
      ['run:status-changed',   '🚚', 'מסלול שינתה סטטוס'],
      ['stop:status-changed',  '📍', 'עצירה עודכנה'],
      ['stop:completed',       '✅', 'עצירה הושלמה'],
      ['order:delivered',      '📦', 'הזמנה נמסרה'],
      ['picking:line-updated', '🔨', 'פריט נלקט'],
      ['return:picked-up',     '🔄', 'חזרה נאספה'],
    ];

    const handlers = events.map(([evt, icon, desc]) => {
      const h = (payload) => {
        setRecentEvents((prev) => [
          { id: Date.now() + Math.random(), icon, desc, payload, at: new Date() },
          ...prev.slice(0, 29),
        ]);
        queryClient.invalidateQueries({ queryKey: ['live-runs'] });
      };
      socket.on(evt, h);
      return [evt, h];
    });

    return () => {
      handlers.forEach(([evt, h]) => socket.off(evt, h));
    };
  }, [queryClient]);

  const activeRuns = (runs || []).filter((r) =>
    !['OPEN', 'CANCELLED'].includes(r.Status)
  );

  const stats = {
    total: activeRuns.length,
    inTransit: activeRuns.filter((r) => r.Status === 'IN_TRANSIT').length,
    completed: activeRuns.filter((r) => r.Status === 'COMPLETED').length,
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Activity className="text-green-500" />
            מעקב חי
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            תצוגה בזמן אמת של מסלולים פעילים היום
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          <span className="text-xs text-gray-500">חי</span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <Truck size={16} /> מסלולים פעילים
          </div>
          <div className="text-2xl font-bold">{stats.total}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center gap-2 text-purple-600 text-sm mb-1">
            <Activity size={16} /> בדרך
          </div>
          <div className="text-2xl font-bold">{stats.inTransit}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center gap-2 text-green-600 text-sm mb-1">
            <CheckCircle size={16} /> הושלמו
          </div>
          <div className="text-2xl font-bold">{stats.completed}</div>
        </div>
      </div>

      {/* Runs grid + activity feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-3">
          {activeRuns.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
              <AlertCircle className="mx-auto text-gray-400 mb-3" size={40} />
              <p className="text-gray-500">אין מסלולים פעילים היום</p>
            </div>
          ) : activeRuns.map((r) => (
            <div key={r.RunId} className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: r.ZoneColor || '#9ca3af' }} />
                  <span className="font-semibold">{r.RunNumber}</span>
                  <span className="text-sm text-gray-500">{r.ZoneName}</span>
                </div>
                <StatusPill status={r.Status} size="sm" />
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">נהג: {r.DriverName || '—'}</span>
                <span className="text-gray-500">{r.StopCount} עצירות · {r.OrderCount} הזמנות</span>
              </div>
            </div>
          ))}
        </div>

        {/* Activity feed */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b">
            <h3 className="font-semibold text-sm">פעילות אחרונה</h3>
          </div>
          <div className="max-h-[600px] overflow-y-auto">
            {recentEvents.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-sm">ממתין לאירועים...</div>
            ) : recentEvents.map((e) => (
              <div key={e.id} className="px-4 py-2 border-b border-gray-50 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{e.icon}</span>
                  <span>{e.desc}</span>
                </div>
                <div className="text-xs text-gray-400 mr-7">
                  {format(e.at, 'HH:mm:ss')}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
