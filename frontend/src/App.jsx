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
import CustomerPolicyPage from './pages/CustomerPolicyPage.jsx';
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
import StockPredictionPage from './pages/StockPredictionPage.jsx';
import PickersPage from './pages/PickersPage.jsx';
import ContentCopyPage from './pages/ContentCopyPage.jsx';
import DavoMixPage from './pages/DavoMixPage.jsx';
import DriverRunsPage from './pages/driver/DriverRunsPage.jsx';
import DriverManifestPage from './pages/driver/DriverManifestPage.jsx';
import { useEffect } from 'react';
import { initAutoFlush } from './services/offlineQueue.js';

function RequireAuth({ children, roles }) {
  const { user, token } = useAuthStore();
  const location = useLocation();

  if (!token || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }
  return children;
}

export default function App() {
  useEffect(() => {
    initAutoFlush();
  }, []);

  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<LoginPage />} />
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
        <Route path="customer-policy" element={<CustomerPolicyPage />} />
        <Route path="pickers" element={<PickersPage />} />
        <Route path="leaderboard" element={<DriverLeaderboardPage />} />
        <Route path="cod" element={<CashOnDeliveryPage />} />
        <Route path="profitability" element={<CustomerProfitabilityPage />} />
        <Route path="anomalies" element={<AnomaliesPage />} />
        <Route path="stock-prediction" element={<StockPredictionPage />} />
        <Route path="content-copy" element={<ContentCopyPage />} />
        <Route path="davo-mix" element={<DavoMixPage />} />
      </Route>
    </Routes>
  );
}
