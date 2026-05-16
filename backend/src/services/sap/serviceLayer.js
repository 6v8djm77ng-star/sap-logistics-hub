/**
 * SAP Business One Service Layer client.
 *
 * Service Layer is a RESTful API exposed by SAP B1 HANA/SQL installations.
 * We use it for WRITE operations (creating Delivery Notes, Return Requests).
 *
 * Key challenges:
 *   - Per-company DB sessions (we have 2 companies)
 *   - Session cookies must be maintained (B1SESSION + ROUTEID)
 *   - Sessions expire - we auto-relogin on 401
 *   - SSL self-signed certs are common in SAP setups
 */
import axios from 'axios';
import https from 'https';
import { env } from '../../config/env.js';
import { sapLogger } from '../../utils/logger.js';
import { assertLiveWriteAllowed } from './writeWhitelist.js';

const httpsAgent = new https.Agent({
  rejectUnauthorized: env.SAP_SL_SSL_REJECT_UNAUTHORIZED,
});

class ServiceLayerSession {
  /**
   * One session per SAP CompanyDB.
   * @param {string} companyDb - SAP company DB name (e.g. "SBO_COMPANY_A")
   */
  constructor(companyDb) {
    this.companyDb = companyDb;
    this.cookies = null;
    this.sessionId = null;
    this.expiresAt = null;

    this.axios = axios.create({
      baseURL: env.SAP_SL_URL,
      httpsAgent,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Attach cookies on every request, auto-relogin on 401
    this.axios.interceptors.request.use(async (config) => {
      if (!this.isSessionValid()) await this.login();
      if (this.cookies) config.headers.Cookie = this.cookies;
      return config;
    });

    this.axios.interceptors.response.use(
      (res) => res,
      async (error) => {
        const original = error.config;
        if (error.response?.status === 401 && !original._retry) {
          original._retry = true;
          sapLogger.info(`Session expired for ${this.companyDb}, re-logging in`);
          await this.login();
          if (this.cookies) original.headers.Cookie = this.cookies;
          return this.axios(original);
        }
        return Promise.reject(error);
      }
    );
  }

  isSessionValid() {
    return this.cookies && this.expiresAt && this.expiresAt > Date.now();
  }

  async login() {
    sapLogger.info(`Logging into Service Layer for ${this.companyDb}`);
    try {
      const response = await axios.post(
        `${env.SAP_SL_URL}/Login`,
        {
          UserName: env.SAP_SL_USERNAME,
          Password: env.SAP_SL_PASSWORD,
          CompanyDB: this.companyDb,
        },
        { httpsAgent, timeout: 15000 }
      );

      const setCookieHeader = response.headers['set-cookie'];
      if (!setCookieHeader) throw new Error('No cookies returned from SAP Login');

      this.cookies = setCookieHeader.map((c) => c.split(';')[0]).join('; ');
      this.sessionId = response.data.SessionId;
      // SAP default session timeout is 30 min; refresh 5 min early
      this.expiresAt = Date.now() + (response.data.SessionTimeout - 5) * 60 * 1000;

      sapLogger.info(`Logged in to ${this.companyDb}, session ${this.sessionId}`);
      return this.sessionId;
    } catch (err) {
      sapLogger.error(`Login failed for ${this.companyDb}`, {
        error: err.message,
        response: err.response?.data,
      });
      throw new Error(`SAP login failed for ${this.companyDb}: ${err.message}`);
    }
  }

  async logout() {
    if (!this.cookies) return;
    try {
      await this.axios.post('/Logout');
    } catch {
      // ignore logout errors
    }
    this.cookies = null;
    this.sessionId = null;
    this.expiresAt = null;
  }

  // ---------- Generic CRUD ----------

  async get(path, params = {}) {
    const res = await this.axios.get(path, { params });
    return res.data;
  }

  async post(path, body) {
    const res = await this.axios.post(path, body);
    return res.data;
  }

  async patch(path, body) {
    const res = await this.axios.patch(path, body);
    return res.data;
  }

  async delete(path) {
    const res = await this.axios.delete(path);
    return res.data;
  }

  /**
   * Bug 3 fix (2026-05-16) — per-request whitelist gate for any
   * SAP-mutating call. Mirrors the per-request gate in sapWriter.js so
   * callers going through the deliveryNotes/returnRequests services
   * (driver-flow path) get the same protection as callers going through
   * sapWriter (flush-aggregate path).
   *
   * Reads env at call time so a runtime SAP_LIVE_WRITE_DB_WHITELIST or
   * SAP_SL_COMPANY_DB_* change takes effect immediately. No-op when
   * SAP_WRITE_ENABLED!=true. Throws .status=503 on whitelist failure.
   */
  _assertLiveWriteAllowed() {
    assertLiveWriteAllowed({
      writeEnabled: process.env.SAP_WRITE_ENABLED === 'true',
      whitelist: process.env.SAP_LIVE_WRITE_DB_WHITELIST,
      dbA: env.SAP_SL_COMPANY_DB_A,
      dbB: env.SAP_SL_COMPANY_DB_B,
    });
  }

  // ---------- Business operations ----------

  /**
   * Create a Delivery Note (תעודת משלוח) from a Sales Order.
   * This is what "closes" an order and delivers the goods.
   * SAP Entity: DeliveryNotes (ODLN)
   */
  async createDeliveryNote({ cardCode, docDate, baseOrderEntry, lines, comments }) {
    this._assertLiveWriteAllowed();
    const body = {
      CardCode: cardCode,
      DocDate: docDate,
      Comments: comments || `Created by Logistics Hub - Based on Order ${baseOrderEntry}`,
      DocumentLines: lines.map((line) => ({
        ItemCode: line.itemCode,
        Quantity: line.quantity,
        WarehouseCode: line.warehouseCode,
        BaseType: 17, // 17 = Sales Order
        BaseEntry: baseOrderEntry,
        BaseLine: line.baseLine,
      })),
    };
    sapLogger.info(`Creating Delivery Note for ${cardCode} based on Order ${baseOrderEntry}`);
    return this.post('/DeliveryNotes', body);
  }

  /**
   * Create a Return Request (בקשת החזרה מלקוח).
   * SAP Entity: ReturnRequest (ORRR)
   * This is the "pick-up request" - created BEFORE pickup.
   */
  async createReturnRequest({ cardCode, docDate, lines, comments }) {
    this._assertLiveWriteAllowed();
    const body = {
      CardCode: cardCode,
      DocDate: docDate,
      Comments: comments,
      DocumentLines: lines.map((line) => ({
        ItemCode: line.itemCode,
        Quantity: line.quantity,
        WarehouseCode: line.warehouseCode,
      })),
    };
    sapLogger.info(`Creating Return Request for ${cardCode}`);
    return this.post('/ReturnRequest', body);
  }

  /**
   * Create a Return (תעודת החזרה) - the actual return document after pickup.
   * SAP Entity: Returns (ORDN)
   */
  async createReturn({ cardCode, docDate, baseReturnRequestEntry, lines, comments }) {
    this._assertLiveWriteAllowed();
    const body = {
      CardCode: cardCode,
      DocDate: docDate,
      Comments: comments,
      DocumentLines: lines.map((line) => ({
        ItemCode: line.itemCode,
        Quantity: line.quantity,
        WarehouseCode: line.warehouseCode,
        BaseType: 234000031, // ReturnRequest
        BaseEntry: baseReturnRequestEntry,
        BaseLine: line.baseLine,
      })),
    };
    sapLogger.info(`Creating Return for ${cardCode}`);
    return this.post('/Returns', body);
  }

  async getOrder(docEntry) {
    return this.get(`/Orders(${docEntry})`);
  }

  async getBusinessPartner(cardCode) {
    return this.get(`/BusinessPartners('${cardCode}')`);
  }
}

// ----------------------------------------------------------------------------
// Client factory - one pooled session per company
// ----------------------------------------------------------------------------
const sessions = new Map();

export function getServiceLayer(companyCode) {
  const dbName = companyCode === 'A' ? env.SAP_SL_COMPANY_DB_A : env.SAP_SL_COMPANY_DB_B;
  if (!dbName) throw new Error(`Unknown company code: ${companyCode}`);

  if (!sessions.has(companyCode)) {
    sessions.set(companyCode, new ServiceLayerSession(dbName));
  }
  return sessions.get(companyCode);
}

export async function logoutAll() {
  await Promise.all([...sessions.values()].map((s) => s.logout()));
  sessions.clear();
}

export { ServiceLayerSession };
