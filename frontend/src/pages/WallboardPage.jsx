/**
 * Big-screen wallboard dashboard - designed for a TV in the office.
 * Auto-refreshes, large fonts, color-coded status, no controls.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../services/api.js';
import { runsApi } from '../services/api.js';
import { Truck, Package, Users, AlertTriangle, CheckCircle, Clock, Activity } from 'lucide-react';

export default function WallboardPage() {
  const [now, setNow] = useState(new Date());

  // Tick every second for the clock
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const today = now.toISOString().slice(0, 10);

  const { data: runs } = useQuery({
    queryKey: ['wallboard-runs', today],
    queryFn: () => runsApi.list({ runDate: today }),
    refetchInterval: 5_000,
  });
  const { data: stats } = useQuery({
    queryKey: ['wallboard-stats'],
    queryFn: () => api.get('/orders/stats').then((r) => r.data),
    refetchInterval: 30_000,
  });
  const { data: failures } = useQuery({
    queryKey: ['wallboard-failures'],
    queryFn: () => api.get('/failures').then((r) => r.data).catch(() => ({ failures: [] })),
    refetchInterval: 10_000,
  });

  const runsArr = Array.isArray(runs) ? runs : (runs?.runs || []);
  const totalRuns = runsArr.length;
  const inTransit = runsArr.filter((r) => ['IN_TRANSIT', 'PICKING'].includes(r.Status)).length;
  const completed = runsArr.filter((r) => r.Status === 'COMPLETED').length;
  const totalStops = runsArr.reduce((s, r) => s + Number(r.StopCount || 0), 0);
  const totalOrders = runsArr.reduce((s, r) => s + Number(r.OrderCount || 0), 0);
  const openFailures = (failures?.failures || []).filter((f) => f.Status === 'OPEN').length;

  const STATUS_HE = {
    OPEN: 'פתוח',
    PLANNED: 'מתוכנן',
    PICKING: 'בליקוט',
    LOADED: 'הועמס',
    IN_TRANSIT: 'בדרך',
    COMPLETED: 'הושלם',
    CANCELLED: 'בוטל',
  };
  const STATUS_COLOR = {
    OPEN: 'bg-gray-700',
    PLANNED: 'bg-gray-600',
    PICKING: 'bg-amber-600',
    LOADED: 'bg-blue-600',
    IN_TRANSIT: 'bg-cyan-500',
    COMPLETED: 'bg-green-600',
    CANCELLED: 'bg-red-600',
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 border-b border-white/10 pb-4">
        <div>
          <h1 className="text-4xl font-black tracking-wide">SAP Logistics Hub</h1>
          <p className="text-slate-400 text-lg">
            {now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div className="text-right">
          <div className="text-7xl font-mono font-black tabular-nums">
            {now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false })}
          </div>
          <div className="text-slate-400 text-sm">{now.toLocaleTimeString('he-IL', { second: '2-digit' })}</div>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <KPI label="מסלולים פעילים" value={totalRuns} icon={Truck} color="from-blue-600 to-blue-700" />
        <KPI label="בדרך" value={inTransit} icon={Activity} color="from-cyan-500 to-cyan-600" pulse />
        <KPI label="הושלמו" value={completed} icon={CheckCircle} color="from-green-600 to-green-700" />
        <KPI label="עצירות" value={totalStops} icon={Package} color="from-purple-600 to-purple-700" sub={`${totalOrders} הזמנות`} />
        <KPI label="כשלים פתוחים" value={openFailures} icon={AlertTriangle} color={openFailures > 0 ? 'from-red-600 to-red-700' : 'from-slate-700 to-slate-800'} pulse={openFailures > 0} />
      </div>

      {/* SAP order counts */}
      {stats && stats.companyA && (
        <div className="grid grid-cols-2 gap-4 mb-6">
          <CompanyCard
            name="OIG"
            color="bg-blue-600"
            customers={stats.companyA.Customers}
            items={stats.companyA.Items}
            openOrders={stats.companyA.OpenOrders}
          />
          <CompanyCard
            name="Unico"
            color="bg-green-600"
            customers={stats.companyB?.Customers}
            items={stats.companyB?.Items}
            openOrders={stats.companyB?.OpenOrders}
          />
        </div>
      )}

      {/* Routes table */}
      <div className="bg-slate-800/60 backdrop-blur rounded-2xl p-4 border border-white/5">
        <h2 className="text-2xl font-bold mb-3 flex items-center gap-2">
          <Truck size={24} /> מסלולי היום
        </h2>
        {runsArr.length === 0 ? (
          <p className="text-slate-400 text-center py-12">אין מסלולים מתוכננים להיום</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {runsArr.slice(0, 12).map((r) => (
              <RouteCard key={r.RunId} run={r} statusHe={STATUS_HE} statusColor={STATUS_COLOR} />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-6 text-center text-slate-500 text-sm">
        מתעדכן אוטומטית · OIG + Unico · {now.toLocaleString('he-IL')}
      </div>
    </div>
  );
}

function KPI({ label, value, icon: Icon, color, sub, pulse }) {
  return (
    <div className={`bg-gradient-to-br ${color} rounded-2xl p-5 shadow-2xl ${pulse && value > 0 ? 'animate-pulse' : ''}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm opacity-80">{label}</div>
          <div className="text-5xl font-black tabular-nums mt-1">{Number(value || 0).toLocaleString('he-IL')}</div>
          {sub && <div className="text-xs opacity-70 mt-1">{sub}</div>}
        </div>
        <Icon size={36} className="opacity-30" />
      </div>
    </div>
  );
}

function CompanyCard({ name, color, customers, items, openOrders }) {
  return (
    <div className="bg-slate-800/60 rounded-2xl p-5 border border-white/5">
      <div className="flex items-center gap-3 mb-3">
        <span className={`${color} w-10 h-10 rounded-full flex items-center justify-center font-black text-lg`}>{name.charAt(0)}</span>
        <h3 className="text-2xl font-bold">{name}</h3>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-3xl font-black tabular-nums">{Number(customers || 0).toLocaleString('he-IL')}</div>
          <div className="text-xs text-slate-400">לקוחות</div>
        </div>
        <div>
          <div className="text-3xl font-black tabular-nums">{Number(items || 0).toLocaleString('he-IL')}</div>
          <div className="text-xs text-slate-400">פריטים</div>
        </div>
        <div>
          <div className="text-3xl font-black tabular-nums text-amber-400">{Number(openOrders || 0).toLocaleString('he-IL')}</div>
          <div className="text-xs text-slate-400">הזמנות פתוחות</div>
        </div>
      </div>
    </div>
  );
}

function RouteCard({ run, statusHe, statusColor }) {
  const completed = Number(run.CompletedStops || 0);
  const total = Number(run.StopCount || 0);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="bg-slate-900/60 rounded-xl p-3 border border-white/5">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="font-bold text-base">{run.RunNumber}</div>
          <div className="text-xs text-slate-400 flex items-center gap-2">
            <span style={{ backgroundColor: run.ZoneColor }} className="inline-block w-2 h-2 rounded-full" />
            {run.ZoneName}
          </div>
        </div>
        <span className={`${statusColor[run.Status] || 'bg-slate-600'} px-2 py-0.5 rounded-full text-xs font-bold`}>
          {statusHe[run.Status] || run.Status}
        </span>
      </div>
      <div className="text-sm text-slate-400 mb-1">
        {run.DriverName || '-- ללא נהג --'} · {run.StopCount} עצירות
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[10px] text-slate-500 mt-1">{completed}/{total} ({pct}%)</div>
    </div>
  );
}
