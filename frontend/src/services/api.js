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
  // opts may include { minCustomerTotal, minLinesPerOrder, requireStock }.
  // Backend (computePlanExclusions) accepts the same params on both
  // preview-exclusions (GET) and auto-plan (POST body).
  autoPlan: (runDate, opts = {}) => api.post('/runs/auto-plan', { runDate, ...opts }).then((r) => r.data),
  updateStatus: (id, status) => api.patch(`/runs/${id}/status`, { status }).then((r) => r.data),
  optimizeOrder: (id) => api.post(`/runs/${id}/optimize-order`).then((r) => r.data),
  buildWave: (id) => api.post(`/runs/${id}/wave`).then((r) => r.data),
  getWave: (id) => api.get(`/runs/${id}/wave`).then((r) => r.data),
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

