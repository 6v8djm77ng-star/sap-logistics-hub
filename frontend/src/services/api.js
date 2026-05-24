/**
 * Axios client - attaches JWT and handles 401 globally.
 */
import axios from 'axios';
import { toast } from 'sonner';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      // Only redirect if not already on login
      if (!window.location.pathname.includes('/login')) {
        window.location.href = '/login';
      }
    } else if (err.response?.data?.error) {
      toast.error(err.response.data.error);
    }
    return Promise.reject(err);
  }
);

export default api;

// ---------- Authenticated file download helper ----------
//
// Download buttons used to be `<a target="_blank" href="/api/reports/...">`
// or window.open(...). The browser ignores localStorage on those, so the
// Authorization: Bearer header never went out → 401 → empty new tab.
//
// downloadFile() routes through the same axios instance so the request
// interceptor attaches the token, then materialises the response body as
// a Blob and triggers a synthetic <a download> click. The filename comes
// from the server's Content-Disposition when present; otherwise falls
// back to the caller-supplied hint.
//
// `url` is the path AFTER /api (matches api.baseURL). Example:
//   downloadFile('/reports/delivery-notes.xlsx?runDate=...', 'dn.csv')
// hits the same endpoint as the old <a href="/api/reports/...">, but
// with the Bearer header attached.
export async function downloadFile(url, filenameHint) {
  // responseType: 'blob' tells axios not to JSON-parse — keeps binary
  // PDFs and CSV bytes intact.
  const r = await api.get(url, { responseType: 'blob' });
  const cd = r.headers?.['content-disposition'] || r.headers?.['Content-Disposition'] || '';
  // RFC 5987 / common forms: filename="x.csv" or filename=x.csv
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/.exec(cd);
  const filename = (m?.[1] ? decodeURIComponent(m[1]) : null) || filenameHint || 'download';
  const blobUrl = URL.createObjectURL(r.data);
  try {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }
}

// ---------- Endpoint wrappers ----------

export const authApi = {
  login: (username, password) => api.post('/auth/login', { username, password }).then((r) => r.data),
  driverLogin: (code, password) => api.post('/auth/driver-login', { code, password }).then((r) => r.data),
  me: () => api.get('/auth/me').then((r) => r.data),
};

export const ordersApi = {
  openOrders: (params) => api.get('/orders/open', { params }).then((r) => r.data),
  unified: (params) => api.get('/orders/unified', { params }).then((r) => r.data),
  stats: (params) => api.get('/orders/stats', { params }).then((r) => r.data),
  orderLines: (company, docEntry) => api.get(`/orders/${company}/${docEntry}/lines`).then((r) => r.data),
};

export const runsApi = {
  list: (params) => api.get('/runs', { params }).then((r) => r.data.runs),
  get: (id) => api.get(`/runs/${id}`).then((r) => r.data),
  create: (data) => api.post('/runs', data).then((r) => r.data),
  // opts may include { minCustomerTotal, requireStock }.
  // Backend (computePlanExclusions) accepts the same params on both
  // preview-exclusions (GET) and auto-plan (POST body).
  autoPlan: (runDate, opts = {}) => api.post('/runs/auto-plan', { runDate, ...opts }).then((r) => r.data),
  updateStatus: (id, status) => api.patch(`/runs/${id}/status`, { status }).then((r) => r.data),
  optimizeOrder: (id) => api.post(`/runs/${id}/optimize-order`).then((r) => r.data),
  // body is optional. Per-zone-picker-assignment (2026-05-21): when the
  // planner picked someone in the SendToPicking modal, pass
  // { assignedPickerId } so the backend records it on the new wave.
  // Omitting body keeps the legacy unassigned-wave behaviour.
  buildWave: (id, body) => api.post(`/runs/${id}/wave`, body || undefined).then((r) => r.data),
  getWave: (id) => api.get(`/runs/${id}/wave`).then((r) => r.data),
  // Phase 2 v2 — dry-run preview for "send selected orders to picking".
  // Returns a runsPreview/summary without mutating any store.
  previewFromSelectedOrders: (body) =>
    api.post('/runs/from-selected-orders/preview', body).then((r) => r.data),
  // Phase 2 v2, Commit 3b — the real submit. Accepts an optional
  // Idempotency-Key (a UUID generated client-side per modal opening) so
  // a double-click or network retry replays the server's prior response
  // instead of creating duplicate runs.
  fromSelectedOrders: (body, idempotencyKey) => {
    const config = idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {};
    return api.post('/runs/from-selected-orders', body, config).then((r) => r.data);
  },
};

export const returnsApi = {
  list: (params) => api.get('/returns', { params }).then((r) => r.data.returns),
  get: (id) => api.get(`/returns/${id}`).then((r) => r.data),
  create: (data) => api.post('/returns', data).then((r) => r.data),
  assignToRun: (id, runId) => api.post(`/returns/${id}/assign-to-run/${runId}`).then((r) => r.data),
  pickup: (id, data) => api.post(`/returns/${id}/pickup`, data).then((r) => r.data),
};

export const pickingApi = {
  getWave: (id) => api.get(`/picking/${id}`).then((r) => r.data),
  pickLine: (lineId, qty) => api.post(`/picking/lines/${lineId}/pick`, { pickedQuantity: qty }).then((r) => r.data),
};

// Per-zone-picker-assignment (2026-05-21): list of user accounts the
// SendToPicking modal can offer as the picker for a zone/run. Distinct from
// /api/pickers (warehouse-handheld entity used by PickersPage). Gated on
// the backend to ADMIN+PLANNER — planners are the only ones opening the
// SendToPicking modal.
export const pickableUsersApi = {
  list: () => api.get('/pickable-users').then((r) => r.data.pickers),
};

// Picker Task Inbox (2026-05-22): per-picker queue of waves to pick.
// Backs /picker/tasks page. Validates pickerId server-side — 400
// INVALID_PICKER for non-integer, 404 PICKER_NOT_FOUND for missing/
// inactive picker. Each row carries denormalised run + line aggregates,
// see GET /api/pickers/:pickerId/assigned-waves in demoServer.
export const pickerTasksApi = {
  listAssignedWaves: (pickerId) =>
    api.get(`/pickers/${pickerId}/assigned-waves`).then((r) => r.data.waves),
};

export const driverApi = {
  myRuns: () => api.get('/driver/my-runs').then((r) => r.data.runs),
  manifest: (runId) => api.get(`/driver/runs/${runId}/manifest`).then((r) => r.data),
  updateStop: (stopId, data) => api.patch(`/driver/stops/${stopId}/status`, data).then((r) => r.data),
  completeStop: (stopId, data) => api.post(`/driver/stops/${stopId}/complete`, data).then((r) => r.data),
  deliverOrder: (runOrderId, actualQuantities) =>
    api.post(`/driver/orders/${runOrderId}/deliver`, { actualQuantities }).then((r) => r.data),
};

export const reportsApi = {
  manifestPdfUrl: (runId) => `/api/reports/runs/${runId}/manifest.pdf`,
  pickingXlsxUrl: (waveId) => `/api/reports/waves/${waveId}/picking.xlsx`,
  exceptions: (params) => api.get('/reports/exceptions', { params }).then((r) => r.data),
};

export const auditApi = {
  trail: (entityType, entityId) =>
    api.get(`/audit/${entityType}/${entityId}`).then((r) => r.data.trail),
};

export const customersApi = {
  search: (q, company = 'ALL') =>
    api.get('/customers/search', { params: { q, company } }).then((r) => r.data.customers),
  get: (company, cardCode) =>
    api.get(`/customers/${company}/${cardCode}`).then((r) => r.data),
  recentItems: (company, cardCode) =>
    api.get(`/customers/${company}/${cardCode}/recent-items`).then((r) => r.data.items),
  ensureAddress: (company, cardCode, sapAddressName) =>
    api.post(`/customers/${company}/${cardCode}/ensure-address`, { sapAddressName }).then((r) => r.data),
};

export const trackingApi = {
  reportPosition: (data) => api.post('/tracking/position', data).then((r) => r.data),
  driverLocations: () => api.get('/tracking/drivers').then((r) => r.data.locations),
  driverTrail: (id, params) => api.get(`/tracking/drivers/${id}/trail`, { params }).then((r) => r.data.trail),
};

export const sapApi = {
  diagnose: () => api.get('/sap/diagnose').then((r) => r.data),
  testSql: (company) => api.get(`/sap/test/sql/${company}`).then((r) => r.data),
  testSL: (company) => api.get(`/sap/test/sl/${company}`).then((r) => r.data),
  sample: (company) => api.get(`/sap/sample/${company}`).then((r) => r.data),
  // A2f (2026-05-20): writer mode + whitelist + log file path. Used by
  // SapWriteAuditBanner to render DRY-RUN vs LIVE plus the A2e audit summary.
  writerStatus: () => api.get('/sap/writer/status').then((r) => r.data),
};

export const settingsApi = {
  list: (category) => api.get('/settings', { params: { category } }).then((r) => r.data.settings),
  update: (key, value) => api.put(`/settings/${key}`, { value }).then((r) => r.data),
};

export const addressesApi = {
  get: (id) => api.get(`/addresses/${id}`).then((r) => r.data),
  update: (id, data) => api.patch(`/addresses/${id}`, data).then((r) => r.data),
};

export const zonesApi = {
  list: () => api.get('/zones').then((r) => r.data.zones),
  create: (data) => api.post('/zones', data).then((r) => r.data),
  assignAddress: (zoneId, addressId) => api.post(`/zones/${zoneId}/assign-address/${addressId}`).then((r) => r.data),
};

export const driversApi = {
  list: () => api.get('/drivers').then((r) => r.data.drivers),
  create: (data) => api.post('/drivers', data).then((r) => r.data),
  updateZones: (id, zoneIds) => api.patch(`/drivers/${id}/zones`, { zoneIds }).then((r) => r.data),
};

