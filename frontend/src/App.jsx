import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './stores/auth.js';
import LoginPage from './pages/LoginPage.jsx';
import DashboardLayout from './components/DashboardLayout.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import PlannerPage from './pages/PlannerPage.jsx';
import RunsPage from './pages/RunsPage.jsx';
import RunDetailsPage from './pages/RunDetailsPage.jsx';
import ReturnsPage from './pages/ReturnsPage.jsx';
import ZonesPage from './pages/ZonesPage.jsx';
import DriversPage from './pages/DriversPage.jsx';
import WarehousePage from './pages/WarehousePage.jsx';
import PickingPage from './pages/PickingPage.jsx';
import ExceptionsPage from './pages/ExceptionsPage.jsx';
import LiveTrackingPage from './pages/LiveTrackingPage.jsx';
import LiveMapPage from './pages/LiveMapPage.jsx';
import FailuresPage from './pages/FailuresPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import AnalyticsPage from './pages/AnalyticsPage.jsx';
import TrackingPage from './pages/TrackingPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import OpenOrdersPage from './pages/OpenOrdersPage.jsx';
import WeeklyReportPage from './pages/WeeklyReportPage.jsx';
import DailyClosurePage from './pages/DailyClosurePage.jsx';
import DocumentsPage from './pages/DocumentsPage.jsx';
import AuditLogPage from './pages/AuditLogPage.jsx';
import QcControlPage from './pages/QcControlPage.jsx';
import RolePermissionsPage from './pages/RolePermissionsPage.jsx';
import CustomerPolicyPage from './pages/CustomerPolicyPage.jsx';
import CustomerDocPolicyPage from './pages/CustomerDocPolicyPage.jsx';
import DriverLoginPage from './pages/driver/DriverLoginPage.jsx';
import AutoLoginPage from './pages/driver/AutoLoginPage.jsx';
import PickerAutoLoginPage from './pages/PickerAutoLoginPage.jsx';
import AdminAutoLoginPage from './pages/AdminAutoLoginPage.jsx';
import MobileShortLinkPage from './pages/MobileShortLinkPage.jsx';
import WallboardPage from './pages/WallboardPage.jsx';
import DriverLeaderboardPage from './pages/DriverLeaderboardPage.jsx';
import CashOnDeliveryPage from './pages/CashOnDeliveryPage.jsx';
import CustomerProfitabilityPage from './pages/CustomerProfitabilityPage.jsx';
import AnomaliesPage from './pages/AnomaliesPage.jsx';
import CeoBriefPage from './pages/CeoBriefPage.jsx';
import StockPredictionPage from './pages/StockPredictionPage.jsx';
import PickersPage from './pages/PickersPage.jsx';
import DavoMixPage from './pages/DavoMixPage.jsx';
import DriverRunsPage from './pages/driver/DriverRunsPage.jsx';
import DriverManifestPage from './pages/driver/DriverManifestPage.jsx';
import PickerTasksPage from './pages/PickerTasksPage.jsx';
import ForceChangePasswordPage from './pages/ForceChangePasswordPage.jsx';
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx';
import ResetPasswordPage from './pages/ResetPasswordPage.jsx';
import CompleteProfilePage from './pages/CompleteProfilePage.jsx';
import { useEffect } from 'react';
import { initAutoFlush } from './services/offlineQueue.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';

function RequireAuth({ children, roles }) {
  const { user, token } = useAuthStore();
  const location = useLocation();

  if (!token || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  // Phase 4a — hard gate: a user with mustChangePassword=true can only
  // visit the force-change-password screen until they rotate. Drivers go
  // through the mobile flow (no DRIVER role hits this for now).
  if (user.mustChangePassword && location.pathname !== '/force-change-password') {
    return <Navigate to="/force-change-password" replace />;
  }
  // Phase 4b — hard gate: profile must be complete (FullName + Email +
  // Phone) before reaching anything else. Drivers are exempt — their
  // profile is admin-managed via the drivers list.
  if (
    user.profileCompleted === false &&
    user.role !== 'DRIVER' &&
    location.pathname !== '/complete-profile' &&
    location.pathname !== '/force-change-password'
  ) {
    return <Navigate to="/complete-profile" replace />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }
  // (2026-05-28) Role-permissions gate. If the user has an explicit
  // allowedScreens list AND it doesn't include '*' AND doesn't include
  // the current pathname, send them home. This makes URL navigation
  // respect the same matrix as the sidebar. ADMIN bypasses because the
  // backend always seeds ADMIN with ['*']. Dashboard root '/' and the
  // mandatory onboarding routes are always reachable.
  const ALWAYS_ALLOWED = new Set(['/', '/force-change-password', '/complete-profile']);
  const allowedScreens = user.allowedScreens || [];
  if (
    !roles
    && Array.isArray(allowedScreens) && allowedScreens.length > 0
    && !allowedScreens.includes('*')
    && !ALWAYS_ALLOWED.has(location.pathname)
    && !allowedScreens.includes(location.pathname)
  ) {
    return <Navigate to="/" replace />;
  }
  return children;
}

export default function App() {
  useEffect(() => {
    initAutoFlush();
  }, []);

  return (
    <ErrorBoundary>
    <Routes>
      {/* Public */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="/force-change-password"
        element={
          <RequireAuth>
            <ForceChangePasswordPage />
          </RequireAuth>
        }
      />
      <Route
        path="/complete-profile"
        element={
          <RequireAuth>
            <CompleteProfilePage />
          </RequireAuth>
        }
      />
      <Route path="/driver/login" element={<DriverLoginPage />} />
      <Route path="/m/:code" element={<AutoLoginPage />} />
      <Route path="/pick/:code" element={<PickerAutoLoginPage />} />
      <Route path="/a/:token" element={<AdminAutoLoginPage />} />
      <Route path="/m/admin/:shortId" element={<MobileShortLinkPage />} />
      <Route path="/wallboard" element={<WallboardPage />} />
      <Route path="/t/:token" element={<TrackingPage />} />

      {/* Driver PWA - mobile-first */}
      <Route
        path="/driver"
        element={
          <RequireAuth roles={['DRIVER', 'ADMIN']}>
            <DriverRunsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/driver/runs/:id"
        element={
          <RequireAuth roles={['DRIVER', 'ADMIN']}>
            <DriverManifestPage />
          </RequireAuth>
        }
      />

      {/* Picker Task Inbox (2026-05-22) — mobile-first inbox where a
          warehouse picker (or a planner viewing on their behalf) sees
          only the waves currently assigned to them via AssignedPickerId.
          Standalone (no DashboardLayout) so it fits a handheld. */}
      <Route
        path="/picker/tasks"
        element={
          <RequireAuth roles={['WAREHOUSE', 'ADMIN', 'PLANNER']}>
            <PickerTasksPage />
          </RequireAuth>
        }
      />

      {/* Planner / Admin UI */}
      <Route
        path="/"
        element={
          <RequireAuth>
            <DashboardLayout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="planner" element={<PlannerPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:id" element={<RunDetailsPage />} />
        <Route path="returns" element={<ReturnsPage />} />
        <Route path="zones" element={<ZonesPage />} />
        <Route path="drivers" element={<DriversPage />} />
        <Route path="warehouse" element={<WarehousePage />} />
        <Route path="warehouse/runs/:runId" element={<PickingPage />} />
        {/* A2g-FIX-PICKING-ROUTE (2026-05-21): SendToPickingModal redirects to
            /picking/<waveId> after creating a Run+Wave (per commit ea9036e
            from 2026-05-18) but this route was never declared, producing a
            blank page on every submit. PickingPage accepts the param via
            its useParams fallback (waveId || runId). */}
        <Route path="picking/:waveId" element={<PickingPage />} />
        <Route path="exceptions" element={<ExceptionsPage />} />
        <Route path="live" element={<LiveTrackingPage />} />
        <Route path="map" element={<LiveMapPage />} />
        <Route path="failures" element={<FailuresPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="orders" element={<OpenOrdersPage />} />
        <Route path="weekly" element={<WeeklyReportPage />} />
        <Route path="closure" element={<DailyClosurePage />} />
        <Route path="documents" element={<DocumentsPage />} />
        {/* DEV.19: Audit log viewer — admin-only via the backend gate
            (/api/audit uses adminOnly middleware). No sidebar entry yet;
            access via direct URL /audit-log to keep noise out of the nav
            for non-admin operators. */}
        <Route path="audit-log" element={<AuditLogPage />} />
        {/* QC Control (P1, 2026-05-26) — placeholder page until P4 ships
            the real waves+orders list. Sidebar visibility is filtered to
            QC_CONTROLLER+ADMIN in DashboardLayout; backend gate is in the
            qcControllerOnly middleware (demoServer.js). */}
        <Route path="qc-control" element={<QcControlPage />} />
        <Route
          path="role-permissions"
          element={
            <RequireAuth roles={['ADMIN']}>
              <RolePermissionsPage />
            </RequireAuth>
          }
        />
        <Route path="customer-policy" element={<CustomerPolicyPage />} />
        <Route path="customer-doc-policy" element={<CustomerDocPolicyPage />} />
        <Route path="pickers" element={<PickersPage />} />
        <Route path="leaderboard" element={<DriverLeaderboardPage />} />
        <Route path="cod" element={<CashOnDeliveryPage />} />
        <Route path="profitability" element={<CustomerProfitabilityPage />} />
        <Route path="anomalies" element={<AnomaliesPage />} />
        {/* CEO Daily Brief (v2, verified-metrics) — backend gate is ADMIN-only
            on /api/agents/*, so the route guard mirrors it. */}
        <Route
          path="ceo-brief"
          element={
            <RequireAuth roles={['ADMIN']}>
              <CeoBriefPage />
            </RequireAuth>
          }
        />
        <Route path="stock-prediction" element={<StockPredictionPage />} />
        <Route path="davo-mix" element={<DavoMixPage />} />
      </Route>
    </Routes>
    </ErrorBoundary>
  );
}
