import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../services/api.js';
import { ordersApi, runsApi, returnsApi } from '../services/api.js';
import { format } from 'date-fns';
import {
  Truck, Package, RotateCcw, TrendingUp, Building2,
  AlertOctagon, CheckCircle, Clock, ArrowRight, UserX, CalendarClock,
} from 'lucide-react';
import StatusPill from '../components/StatusPill.jsx';

export default function DashboardPage() {
  const today = format(new Date(), 'yyyy-MM-dd');

  const { data: stats } = useQuery({
    queryKey: ['stats', today],
    queryFn: () => ordersApi.stats({ fromDate: today, toDate: today }),
    refetchInterval: 60_000,
  });

  const { data: runs } = useQuery({
    queryKey: ['runs', today],
    queryFn: () => runsApi.list({ runDate: today }),
    refetchInterval: 30_000,
  });

  const { data: returns } = useQuery({
    queryKey: ['returns'],
    queryFn: () => returnsApi.list({}),
  });

  const { data: failuresData } = useQuery({
    queryKey: ['failures'],
    queryFn: () => api.get('/failures').then((r) => r.data.failures),
    refetchInterval: 30_000,
  });
  const openFailures = (failuresData || []).filter((f) => f.ResolutionStatus === 'OPEN').length;

  const companyA = stats?.companyA || {};
  const companyB = stats?.companyB || {};
  const totalCustomers = (companyA.Customers || 0) + (companyB.Customers || 0);
  const totalOpenOrders = (companyA.OpenOrders || 0) + (companyB.OpenOrders || 0);

  const runsActive = (runs || []).filter((r) => !['OPEN', 'CANCELLED', 'COMPLETED'].includes(r.Status)).length;
  const runsCompleted = (runs || []).filter((r) => r.Status === 'COMPLETED').length;
  const runsWithoutDriver = (runs || []).filter((r) =>
    !r.DriverId && !['CANCELLED', 'COMPLETED'].includes(r.Status)
  ).length;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">דשבורד</h1>
          <p className="text-sm text-gray-500 mt-1">סקירה יומית · {format(new Date(), 'EEEE, dd/MM/yyyy', { locale: { localize: { day: (n) => ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'][n], month: () => '' }, formatLong: {} } })}</p>
        </div>
        {stats?.source === 'sap' && (
          <div className="inline-flex items-center gap-1.5 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            מחובר ל-SAP
          </div>
        )}
      </div>

      {/* Warning banner for unassigned runs */}
      {runsWithoutDriver > 0 && (
        <Link
          to="/runs"
          className="flex items-center justify-between bg-amber-50 border border-amber-300 rounded-xl p-3 mb-4 hover:bg-amber-100"
        >
          <div className="flex items-center gap-2 text-sm">
            <UserX className="text-amber-600" size={18} />
            <span className="font-medium text-amber-900">
              {runsWithoutDriver} מסלולים ללא נהג משויך
            </span>
            <span className="text-amber-700">- לחץ לשיוך נהגים</span>
          </div>
          <ArrowRight className="text-amber-600" size={14} />
        </Link>
      )}

      {/* SAP stats - real live data */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div className="bg-gradient-to-br from-blue-500 to-blue-700 text-white rounded-xl p-5">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <Building2 size={20} />
              <span className="text-sm font-medium">OIG</span>
            </div>
            <span className="text-xs opacity-75">חברה א</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-2xl font-bold">{companyA.Customers?.toLocaleString() || '—'}</div>
              <div className="text-xs opacity-90">לקוחות</div>
            </div>
            <div>
              <div className="text-2xl font-bold">{companyA.Items?.toLocaleString() || '—'}</div>
              <div className="text-xs opacity-90">פריטים</div>
            </div>
            <div>
              <div className="text-2xl font-bold">{companyA.OpenOrders || '—'}</div>
              <div className="text-xs opacity-90">פתוחות</div>
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-br from-green-500 to-green-700 text-white rounded-xl p-5">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <Building2 size={20} />
              <span className="text-sm font-medium">Unico</span>
            </div>
            <span className="text-xs opacity-75">חברה ב</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-2xl font-bold">{companyB.Customers?.toLocaleString() || '—'}</div>
              <div className="text-xs opacity-90">לקוחות</div>
            </div>
            <div>
              <div className="text-2xl font-bold">{companyB.Items?.toLocaleString() || '—'}</div>
              <div className="text-xs opacity-90">פריטים</div>
            </div>
            <div>
              <div className="text-2xl font-bold">{companyB.OpenOrders || '—'}</div>
              <div className="text-xs opacity-90">פתוחות</div>
            </div>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Link to="/orders" className="bg-white rounded-xl border hover:border-brand-500 p-4 group">
          <div className="flex items-start justify-between mb-1">
            <Package className="text-brand-500" size={18} />
            <ArrowRight className="text-gray-300 group-hover:text-brand-500" size={14} />
          </div>
          <div className="text-xs text-gray-500">הזמנות פתוחות</div>
          <div className="text-2xl font-bold mt-1">{totalOpenOrders}</div>
          <div className="text-xs text-gray-400 mt-0.5">סה"כ משתי החברות</div>
        </Link>

        <Link to="/runs" className="bg-white rounded-xl border hover:border-brand-500 p-4 group">
          <div className="flex items-start justify-between mb-1">
            <Truck className="text-amber-500" size={18} />
            <ArrowRight className="text-gray-300 group-hover:text-brand-500" size={14} />
          </div>
          <div className="text-xs text-gray-500">מסלולים פעילים</div>
          <div className="text-2xl font-bold mt-1">{runsActive}</div>
          <div className="text-xs text-gray-400 mt-0.5">{runs?.length || 0} סה"כ היום</div>
        </Link>

        <Link to="/failures" className={`bg-white rounded-xl border p-4 group ${openFailures > 0 ? 'border-red-300 hover:border-red-500' : 'hover:border-brand-500'}`}>
          <div className="flex items-start justify-between mb-1">
            <AlertOctagon className={openFailures > 0 ? 'text-red-500' : 'text-gray-400'} size={18} />
            <ArrowRight className="text-gray-300 group-hover:text-red-500" size={14} />
          </div>
          <div className="text-xs text-gray-500">כשלים פתוחים</div>
          <div className={`text-2xl font-bold mt-1 ${openFailures > 0 ? 'text-red-600' : ''}`}>{openFailures}</div>
          <div className="text-xs text-gray-400 mt-0.5">
            {openFailures > 0 ? 'דרוש טיפול!' : 'הכל תקין'}
          </div>
        </Link>

        <Link to="/returns" className="bg-white rounded-xl border hover:border-amber-500 p-4 group">
          <div className="flex items-start justify-between mb-1">
            <RotateCcw className="text-amber-500" size={18} />
            <ArrowRight className="text-gray-300 group-hover:text-amber-500" size={14} />
          </div>
          <div className="text-xs text-gray-500">חזרות ממתינות</div>
          <div className="text-2xl font-bold mt-1">{returns?.length || 0}</div>
          <div className="text-xs text-gray-400 mt-0.5">—</div>
        </Link>
      </div>

      {/* Today's runs */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">מסלולי היום</h2>
          <Link to="/runs" className="text-sm text-brand-600 hover:underline">
            כל המסלולים →
          </Link>
        </div>
        {!runs || runs.length === 0 ? (
          <div className="py-8 text-center">
            <Truck className="mx-auto text-gray-300 mb-2" size={32} />
            <p className="text-gray-500 text-sm mb-3">
              עדיין לא תוכננו מסלולי היום
            </p>
            <Link
              to="/runs"
              className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm"
            >
              <Truck size={14} /> צור מסלול חדש
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <Link
                key={run.RunId}
                to={`/runs/${run.RunId}`}
                className="flex items-center justify-between p-3 border border-gray-100 rounded-lg hover:bg-gray-50"
              >
                <div className="flex items-center gap-3">
                  <span
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: run.ZoneColor || '#9ca3af' }}
                  />
                  <span className="font-medium">{run.RunNumber}</span>
                  <span className="text-sm text-gray-500">{run.ZoneName}</span>
                  {run.DriverName && (
                    <span className="text-sm text-gray-500">· {run.DriverName}</span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-gray-500">
                    {run.StopCount} עצירות · {run.OrderCount} הזמנות
                  </span>
                  <StatusPill status={run.Status} size="sm" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
