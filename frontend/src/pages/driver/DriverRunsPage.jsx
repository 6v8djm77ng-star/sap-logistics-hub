import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { driverApi } from '../../services/api.js';
import { useAuthStore } from '../../stores/auth.js';
import StatusPill from '../../components/StatusPill.jsx';
import { Truck, LogOut, MapPin, Package } from 'lucide-react';

export default function DriverRunsPage() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const { data: runs, isLoading } = useQuery({
    queryKey: ['driver-runs'],
    queryFn: driverApi.myRuns,
    refetchInterval: 30_000,
  });

  const handleLogout = () => {
    logout();
    navigate('/driver/login');
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-brand-600 text-white sticky top-0 z-10">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <Truck size={24} />
            <div>
              <div className="font-semibold">{user?.name}</div>
              <div className="text-xs opacity-80">נהג הפצה</div>
            </div>
          </div>
          <button onClick={handleLogout} className="p-2 rounded-lg hover:bg-brand-700">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <div className="p-4">
        <h1 className="text-xl font-bold mb-4">המסלולים שלי היום</h1>

        {isLoading ? (
          <div className="text-center py-12 text-gray-500">טוען...</div>
        ) : !runs?.length ? (
          <div className="bg-white rounded-2xl p-8 text-center">
            <Truck className="mx-auto text-gray-400 mb-3" size={40} />
            <p className="text-gray-600">אין מסלולים משויכות היום</p>
          </div>
        ) : (
          <div className="space-y-3">
            {runs.map((r) => (
              <Link
                key={r.RunId}
                to={`/driver/runs/${r.RunId}`}
                className="block bg-white rounded-2xl p-4 active:bg-gray-50 shadow-sm"
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="font-semibold text-lg">{r.RunNumber}</div>
                    <div className="flex items-center gap-1.5 text-sm text-gray-600 mt-0.5">
                      <MapPin size={14} />
                      {r.ZoneName}
                    </div>
                  </div>
                  <StatusPill status={r.Status} />
                </div>

                <div className="flex items-center gap-4 text-sm text-gray-600">
                  <div className="flex items-center gap-1">
                    <Truck size={14} /> {r.StopCount} עצירות
                  </div>
                  <div className="flex items-center gap-1">
                    <Package size={14} /> {r.OrderCount} הזמנות
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
