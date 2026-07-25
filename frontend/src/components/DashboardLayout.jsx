import { useState, useEffect } from 'react';
import { NavLink, Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
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
  Eye,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import clsx from 'clsx';
import RefreshButton from './RefreshButton.jsx';
import NextPageButton from './NextPageButton.jsx';

// ─────────────────────────────────────────────────────────────────────
// Sidebar sections
//
// The sidebar is split into three groups + one standalone item:
//   1. workflowSection — the daily flow (1..13). NextPageButton walks
//      this order. KEEP IN SYNC with WORKFLOW_ORDER in NextPageButton.jsx.
//   2. reportsSection  — collapsible. Read-only analytics & failures.
//   3. settingsSection — collapsible. Master data + admin.
//   4. wallboardItem   — standalone at the bottom; used for the in-office
//      big-screen display, not part of the daily flow.
// ─────────────────────────────────────────────────────────────────────

const workflowSection = [
  { to: '/',           label: 'דשבורד',          icon: LayoutDashboard },
  { to: '/orders',     label: 'הזמנות SAP',      icon: Package, highlight: true },
  // Hidden 2026-05-24 by user request — pages still routable directly via URL.
  // { to: '/planner',    label: 'תכנון יומי',       icon: CalendarClock },
  { to: '/runs',       label: 'מסלולי הפצה',     icon: Truck },
  { to: '/warehouse',  label: 'ליקוט מחסן',      icon: Warehouse },
  // QC Control (P1, 2026-05-26) — only QC_CONTROLLER + ADMIN see this item.
  // Visibility is filtered below in the render via the `roles` field.
  { to: '/qc-control', label: 'בקרה אחרי ליקוט', icon: ShieldCheck,
    roles: ['QC_CONTROLLER', 'ADMIN'] },
  { to: '/documents',  label: 'תעודות וחשבוניות', icon: FileText, highlight: true },
  { to: '/live',       label: 'מעקב חי',         icon: Activity },
  { to: '/returns',    label: 'חזרות',           icon: RotateCcw },
  { to: '/exceptions', label: 'חריגים',          icon: AlertTriangle },
  // Hidden 2026-05-24 by user request — page still routable directly via URL.
  // { to: '/anomalies',  label: 'זיהוי חריגים',    icon: Eye, highlight: true },
  { to: '/closure',    label: 'סגירת יום',       icon: BarChart3 },
];

// Reports section now includes /map (driver live map) and /cod (cash-on-
// delivery summary) — both moved out of the daily workflow because they're
// view-only "look at what's happening" screens, not steps the planner walks
// through in order. Reordered so that the day-to-day analytics come first.
const reportsSection = [
  // CEO Daily Brief — ADMIN only (backend /api/agents/* is admin-gated).
  { to: '/ceo-brief',   label: 'תקציר מנכ"ל',    icon: Sparkles, roles: ['ADMIN'] },
  { to: '/analytics',   label: 'ניתוח ביצועים',  icon: BarChart3 },
  { to: '/weekly',      label: 'דוח שבועי',      icon: BarChart3 },
  { to: '/leaderboard', label: 'ביצועי נהגים',   icon: Trophy },
  { to: '/failures',    label: 'ניהול כשלים',    icon: AlertOctagon, highlight: true },
  { to: '/map',         label: 'מפת נהגים',      icon: Map },
  { to: '/cod',         label: 'תשלום במזומן',   icon: Banknote },
];

const settingsSection = [
  { to: '/customer-policy',     label: 'מדיניות לקוחות',  icon: Building2 },
  { to: '/customer-doc-policy', label: 'מדיניות מסמכים',  icon: FileText },
  { to: '/zones',               label: 'אזורי הפצה',      icon: MapPin },
  { to: '/drivers',             label: 'נהגים',           icon: Users },
  { to: '/pickers',             label: 'מלקטים',          icon: Warehouse },
  { to: '/users',               label: 'משתמשים',         icon: UserCog },
  // Role Permissions (2026-05-28) — ADMIN only. The matrix UI lives at
  // /role-permissions and lets an admin define what each role can see.
  { to: '/role-permissions',    label: 'הרשאות תפקידים',  icon: ShieldCheck,
    roles: ['ADMIN'] },
  { to: '/settings',            label: 'הגדרות + SAP',    icon: Settings },
];

const wallboardItem = { to: '/wallboard', label: 'מסך גדול', icon: Tv };

// Helper for NavLink className. Extracted because we render it identically
// in three places now (workflow + reports + settings).
const navLinkClass = ({ isActive }, item) =>
  clsx(
    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
    isActive
      ? 'bg-brand-50 text-brand-700'
      : item.highlight
        ? 'text-red-700 hover:bg-red-50'
        : 'text-gray-700 hover:bg-gray-100'
  );

function NavItem({ item }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={(state) => navLinkClass(state, item)}
    >
      <item.icon size={18} />
      {item.label}
    </NavLink>
  );
}

function CategoryHeader({ label, icon: Icon, open, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-2 px-3 py-2 mt-3 rounded-lg text-xs font-bold uppercase tracking-wider text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
      aria-expanded={open}
    >
      <span className="flex items-center gap-2">
        <Icon size={14} />
        {label}
      </span>
      {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
    </button>
  );
}

export default function DashboardLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [openCategories, setOpenCategories] = useState({
    reports: false,
    settings: false,
  });

  // Close sidebar when navigating on mobile
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Auto-expand a collapsible group when the user lands on one of its
  // routes (e.g. shared link, browser back). Keeps the highlight visible
  // without forcing the user to manually open the group first.
  useEffect(() => {
    const inReports = reportsSection.some((i) => i.to === location.pathname);
    const inSettings = settingsSection.some((i) => i.to === location.pathname);
    if (inReports || inSettings) {
      setOpenCategories((prev) => ({
        reports: inReports || prev.reports,
        settings: inSettings || prev.settings,
      }));
    }
  }, [location.pathname]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const toggleCategory = (key) =>
    setOpenCategories((prev) => ({ ...prev, [key]: !prev[key] }));

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
          {/* (2026-05-28) Role-permissions filter — applies to ALL three
              sections + standalone now. A sidebar item is visible when:
                1. user.allowedScreens includes '*' (admin wildcard) OR
                2. user.allowedScreens explicitly includes item.to OR
                3. the user has no permissions list yet (legacy users,
                   e.g. a freshly-issued JWT before the matrix was set
                   up). In that case we fall back to the legacy
                   item.roles[] hint and otherwise show the item.
              The item.roles[] field is still honored as an additional
              safety net so anything pre-tagged ADMIN-only doesn't leak. */}
          {(() => {
            const allowed = user?.allowedScreens || [];
            const wildcard = allowed.includes('*');
            const isVisible = (item) => {
              if (item.roles && !item.roles.includes(user?.role)) return false;
              if (wildcard) return true;
              if (allowed.length === 0) return true; // legacy fallback
              return allowed.includes(item.to);
            };
            const visibleWorkflow  = workflowSection.filter(isVisible);
            const visibleReports   = reportsSection.filter(isVisible);
            const visibleSettings  = settingsSection.filter(isVisible);
            const wallboardVisible = isVisible(wallboardItem);
            return (
              <>
                {visibleWorkflow.map((item) => (
                  <NavItem key={item.to} item={item} />
                ))}

                {visibleReports.length > 0 && (
                  <>
                    <CategoryHeader
                      label="דוחות"
                      icon={BarChart3}
                      open={openCategories.reports}
                      onToggle={() => toggleCategory('reports')}
                    />
                    {openCategories.reports &&
                      visibleReports.map((item) => <NavItem key={item.to} item={item} />)}
                  </>
                )}

                {visibleSettings.length > 0 && (
                  <>
                    <CategoryHeader
                      label="הגדרות"
                      icon={Settings}
                      open={openCategories.settings}
                      onToggle={() => toggleCategory('settings')}
                    />
                    {openCategories.settings &&
                      visibleSettings.map((item) => <NavItem key={item.to} item={item} />)}
                  </>
                )}

                {wallboardVisible && (
                  <div className="pt-3 mt-3 border-t border-gray-100">
                    <NavItem item={wallboardItem} />
                  </div>
                )}
              </>
            );
          })()}
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

        {/* Phase 4b — incomplete-profile users are hard-blocked at the
            AuthGuard level (redirected to /complete-profile), so no banner
            is needed here. The soft banner from 4a was removed. */}

        <div className="flex-1 min-w-0">
          <Outlet />
          {/* NextPageButton hides itself on non-workflow routes and on the
              last workflow page (/closure). See NextPageButton.jsx. */}
          <NextPageButton />
        </div>
      </main>
    </div>
  );
}
