import { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/auth.js';
import {
  LayoutDashboard,
  CalendarClock,
  Truck,
  RotateCcw,
  MapPin,
  Map,
  Users,
  UserCog,
  Warehouse,
  AlertTriangle,
  AlertOctagon,
  Activity,
  BarChart3,
  Settings,
  Package,
  FileText,
  Building2,
  LogOut,
  Menu,
  X,
  Tv,
  Trophy,
  Banknote,
  DollarSign,
  Eye,
  PackageX,
  Sparkles,
  Target,
} from 'lucide-react';
import clsx from 'clsx';
import RefreshButton from './RefreshButton.jsx';

const navItems = [
  { to: '/',           label: 'דשבורד',         icon: LayoutDashboard },
  { to: '/orders',     label: 'הזמנות SAP',     icon: Package, highlight: true },
  { to: '/live',       label: 'מעקב חי',        icon: Activity },
  { to: '/map',        label: 'מפת נהגים',      icon: Map },
  { to: '/planner',    label: 'תכנון יומי',     icon: CalendarClock },
  { to: '/warehouse',  label: 'ליקוט מחסן',     icon: Warehouse },
  { to: '/runs',       label: 'מסלולי הפצה',     icon: Truck },
  { to: '/documents',  label: 'תעודות וחשבוניות', icon: FileText, highlight: true },
  { to: '/customer-policy', label: 'מדיניות לקוחות', icon: Building2 },
  { to: '/customer-doc-policy', label: 'מדיניות מסמכים', icon: FileText },
  { to: '/returns',    label: 'חזרות',          icon: RotateCcw },
  { to: '/failures',   label: 'ניהול כשלים',    icon: AlertOctagon, highlight: true },
  { to: '/analytics',  label: 'ניתוח ביצועים',  icon: BarChart3 },
  { to: '/weekly',     label: 'דוח שבועי',       icon: BarChart3 },
  { to: '/closure',    label: 'סגירת יום',       icon: BarChart3 },
  { to: '/zones',      label: 'אזורי הפצה',     icon: MapPin },
  { to: '/drivers',    label: 'נהגים',          icon: Users },
  { to: '/pickers',    label: 'מלקטים',         icon: Warehouse },
  { to: '/users',      label: 'משתמשים',        icon: UserCog },
  { to: '/leaderboard', label: 'ביצועי נהגים',   icon: Trophy },
  { to: '/cod',         label: 'תשלום במזומן',    icon: Banknote },
  { to: '/anomalies',  label: 'זיהוי חריגים',     icon: Eye, highlight: true },
  { to: '/exceptions', label: 'חריגים',         icon: AlertTriangle },
  { to: '/wallboard',  label: 'מסך גדול',        icon: Tv },
  { to: '/settings',   label: 'הגדרות + SAP',   icon: Settings },
];

export default function DashboardLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close sidebar when navigating on mobile
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex bg-gray-50">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - slides in from right (RTL) on mobile, fixed on desktop */}
      <aside
        className={clsx(
          'bg-white border-l border-gray-200 flex flex-col z-40',
          'fixed md:static inset-y-0 right-0 w-64 transition-transform duration-200',
          'md:translate-x-0',
          sidebarOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'
        )}
      >
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h1 className="text-lg md:text-xl font-bold text-brand-600">SAP Logistics Hub</h1>
            <p className="text-xs text-gray-500 mt-0.5">מערכת תכנון הפצה</p>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-1.5 hover:bg-gray-100 rounded-lg"
            aria-label="סגור תפריט"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : item.highlight
                      ? 'text-red-700 hover:bg-red-50'
                      : 'text-gray-700 hover:bg-gray-100'
                )
              }
            >
              <item.icon size={18} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-gray-200">
          <div className="px-3 py-2 text-sm">
            <div className="font-medium text-gray-900 truncate">{user?.name}</div>
            <div className="text-xs text-gray-500">{user?.role}</div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-600 hover:bg-red-50"
          >
            <LogOut size={16} />
            התנתקות
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto flex flex-col min-w-0">
        {/* Top header bar - sticky so the refresh + hamburger are always reachable */}
        <header className="sticky top-0 z-20 flex items-center justify-between gap-2 px-3 sm:px-6 py-2 bg-white/95 backdrop-blur border-b border-gray-200">
          {/* Hamburger - mobile only */}
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden p-2 hover:bg-gray-100 rounded-lg"
            aria-label="פתח תפריט"
          >
            <Menu size={20} />
          </button>

          {/* Date - hidden on small screens to save space */}
          <div className="hidden sm:block text-sm text-gray-500 truncate flex-1">
            {new Date().toLocaleDateString('he-IL', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            })}
          </div>
          <div className="sm:hidden text-xs font-medium text-gray-700 truncate">
            {new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })}
          </div>

          <RefreshButton />
        </header>

        <div className="flex-1 min-w-0">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
