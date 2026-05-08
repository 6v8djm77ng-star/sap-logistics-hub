/**
 * SAP Connection Diagnostic - helps administrators set up and troubleshoot.
 *
 * Returns structured results for each check:
 *   - Network reachability (can we reach the server?)
 *   - SQL Server auth (can we log in?)
 *   - SAP DB exists and has expected tables
 *   - Service Layer auth per company
 *   - Sample data sanity (can we actually read orders?)
 *
 * Designed to give actionable error messages to the user.
 */
import net from 'net';
import https from 'https';
import axios from 'axios';
import sql from 'mssql';
import { env } from '../config/env.js';
import * as systemSettings from './systemSettings.js';
import { sapLogger } from '../utils/logger.js';

const httpsAgent = new https.Agent({
  rejectUnauthorized: env.SAP_SL_SSL_REJECT_UNAUTHORIZED ?? false,
});

/**
 * TCP ping - can we reach the host on the port?
 * Fast check before trying heavier SQL/HTTPS login.
 */
export async function checkTcpReachable(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const start = Date.now();
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish({ ok: true, latencyMs: Date.now() - start }));
    socket.once('error', (err) => finish({ ok: false, error: err.code || err.message }));
    socket.once('timeout', () => finish({ ok: false, error: `Timeout after ${timeout}ms` }));

    try {
      socket.connect(port, host);
    } catch (err) {
      finish({ ok: false, error: err.message });
    }
  });
}

/**
 * Check SAP SQL Server for a specific company DB.
 */
export async function checkSapSql(companyCode) {
  const host = env.SAP_SQL_HOST;
  const port = env.SAP_SQL_PORT;
  const dbName = companyCode === 'A' ? env.SAP_SQL_DB_A : env.SAP_SQL_DB_B;

  if (!host || !dbName) {
    return {
      ok: false,
      step: 'config',
      error: `SAP_SQL_HOST or SAP_SQL_DB_${companyCode} not configured in .env`,
    };
  }

  // Step 1: TCP reach
  const tcp = await checkTcpReachable(host, port, 3000);
  if (!tcp.ok) {
    return {
      ok: false,
      step: 'tcp',
      error: `Cannot reach ${host}:${port} - ${tcp.error}`,
      hint: 'בדוק שהשרת פעיל, ש-TCP/IP מאופשר ב-SQL Configuration Manager, ושה-firewall פתוח',
    };
  }

  // Step 2: SQL login + DB access
  let pool;
  const start = Date.now();
  try {
    pool = new sql.ConnectionPool({
      user: env.SAP_SQL_USER,
      password: env.SAP_SQL_PASSWORD,
      server: host,
      port,
      database: dbName,
      options: {
        encrypt: env.SAP_SQL_ENCRYPT,
        trustServerCertificate: env.SAP_SQL_TRUST_SERVER_CERT,
      },
      connectionTimeout: 5000,
      requestTimeout: 5000,
    });
    await pool.connect();

    // Step 3: verify standard SAP tables exist
    const tableCheck = await pool.request().query(`
      SELECT
        SUM(CASE WHEN name = 'OCRD' THEN 1 ELSE 0 END) AS HasOCRD,
        SUM(CASE WHEN name = 'OITM' THEN 1 ELSE 0 END) AS HasOITM,
        SUM(CASE WHEN name = 'ORDR' THEN 1 ELSE 0 END) AS HasORDR,
        SUM(CASE WHEN name = 'RDR1' THEN 1 ELSE 0 END) AS HasRDR1
      FROM sys.tables
    `);

    const t = tableCheck.recordset[0];
    const missing = [];
    if (!t.HasOCRD) missing.push('OCRD (Business Partners)');
    if (!t.HasOITM) missing.push('OITM (Items)');
    if (!t.HasORDR) missing.push('ORDR (Sales Orders)');
    if (!t.HasRDR1) missing.push('RDR1 (Order Lines)');

    if (missing.length > 0) {
      await pool.close();
      return {
        ok: false,
        step: 'schema',
        error: `DB מוחבר אבל חסרות טבלאות SAP: ${missing.join(', ')}`,
        hint: 'ודא שה-DB שהזנת הוא אכן SAP B1 CompanyDB ולא DB אחר',
        dbName,
      };
    }

    // Step 4: quick data sanity
    const counts = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM OCRD WHERE CardType = 'C') AS Customers,
        (SELECT COUNT(*) FROM OITM) AS Items,
        (SELECT COUNT(*) FROM ORDR) AS TotalOrders,
        (SELECT COUNT(*) FROM ORDR WHERE DocStatus = 'O') AS OpenOrders
    `);

    await pool.close();

    return {
      ok: true,
      step: 'ok',
      latencyMs: Date.now() - start,
      dbName,
      stats: counts.recordset[0],
    };
  } catch (err) {
    if (pool) {
      try { await pool.close(); } catch {}
    }
    // Categorize error
    let hint = 'בדוק user/password ב-.env';
    if (/login/i.test(err.message)) {
      hint = 'שם משתמש או סיסמה שגויים (SAP_SQL_USER / SAP_SQL_PASSWORD)';
    } else if (/cannot open database/i.test(err.message)) {
      hint = `שם ה-DB "${dbName}" לא קיים בשרת - בדוק את SAP_SQL_DB_${companyCode}`;
    } else if (/certificate/i.test(err.message)) {
      hint = 'בעיית SSL - הגדר SAP_SQL_TRUST_SERVER_CERT=true';
    }
    return {
      ok: false,
      step: 'auth',
      error: err.message,
      hint,
    };
  }
}

/**
 * Check SAP Service Layer login for a specific company.
 */
export async function checkServiceLayer(companyCode) {
  const url = env.SAP_SL_URL;
  const dbName = companyCode === 'A' ? env.SAP_SL_COMPANY_DB_A : env.SAP_SL_COMPANY_DB_B;

  if (!url || !dbName) {
    return {
      ok: false,
      step: 'config',
      error: `SAP_SL_URL or SAP_SL_COMPANY_DB_${companyCode} not configured in .env`,
    };
  }

  // Parse URL to get host/port for TCP check
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, step: 'config', error: `Invalid URL: ${url}` };
  }

  const port = Number(parsedUrl.port) || (parsedUrl.protocol === 'https:' ? 443 : 80);
  const tcp = await checkTcpReachable(parsedUrl.hostname, port, 3000);
  if (!tcp.ok) {
    return {
      ok: false,
      step: 'tcp',
      error: `Cannot reach Service Layer at ${parsedUrl.hostname}:${port} - ${tcp.error}`,
      hint: 'בדוק שה-Service Layer מותקן ופעיל, ושפורט 50000 פתוח ב-firewall',
    };
  }

  // Actual login
  const start = Date.now();
  try {
    const response = await axios.post(
      `${url}/Login`,
      {
        UserName: env.SAP_SL_USERNAME,
        Password: env.SAP_SL_PASSWORD,
        CompanyDB: dbName,
      },
      { httpsAgent, timeout: 10000 }
    );

    const sessionId = response.data.SessionId;
    const sessionTimeout = response.data.SessionTimeout;

    // Logout to free the session (diagnostic shouldn't hog sessions)
    const cookies = response.headers['set-cookie']?.map((c) => c.split(';')[0]).join('; ');
    if (cookies) {
      try {
        await axios.post(`${url}/Logout`, null, {
          httpsAgent,
          timeout: 3000,
          headers: { Cookie: cookies },
        });
      } catch {}
    }

    return {
      ok: true,
      step: 'ok',
      latencyMs: Date.now() - start,
      sessionId,
      sessionTimeoutMinutes: sessionTimeout,
      dbName,
    };
  } catch (err) {
    let hint = 'בדוק את פרטי ההתחברות ב-.env';
    const status = err.response?.status;
    const errorCode = err.response?.data?.error?.code;
    const errorMsg = err.response?.data?.error?.message?.value || err.message;

    if (status === 401 || errorCode === -304) {
      hint = 'שם משתמש או סיסמה שגויים ל-SAP (SAP_SL_USERNAME / SAP_SL_PASSWORD)';
    } else if (errorCode === -100 || /company/i.test(errorMsg)) {
      hint = `CompanyDB "${dbName}" לא נמצא - בדוק את SAP_SL_COMPANY_DB_${companyCode}`;
    } else if (/certificate/i.test(err.message)) {
      hint = 'בעיית SSL - הגדר SAP_SL_SSL_REJECT_UNAUTHORIZED=false ב-.env';
    } else if (err.code === 'ECONNREFUSED') {
      hint = 'השרת דחה את החיבור - ודא ש-Service Layer פועל';
    }

    return {
      ok: false,
      step: 'auth',
      error: errorMsg,
      errorCode,
      hint,
    };
  }
}

/**
 * Full SAP diagnostic - checks all 4 connections.
 */
export async function runFullDiagnostic() {
  const start = Date.now();

  const checks = {
    sqlCompanyA: await checkSapSql('A'),
    sqlCompanyB: await checkSapSql('B'),
    serviceLayerCompanyA: await checkServiceLayer('A'),
    serviceLayerCompanyB: await checkServiceLayer('B'),
  };

  const allOk = Object.values(checks).every((c) => c.ok);
  const partiallyOk = Object.values(checks).some((c) => c.ok);

  const result = {
    status: allOk ? 'fully-connected' : partiallyOk ? 'partial' : 'disconnected',
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    checks,
    summary: {
      total: 4,
      ok: Object.values(checks).filter((c) => c.ok).length,
      failed: Object.values(checks).filter((c) => !c.ok).length,
    },
  };

  // Persist the result
  try {
    await systemSettings.set('sap.lastTestedAt', new Date().toISOString());
    await systemSettings.set('sap.lastTestResult', result);
    await systemSettings.set('sap.sql.ready', checks.sqlCompanyA.ok && checks.sqlCompanyB.ok);
    await systemSettings.set('sap.servicelayer.ready', checks.serviceLayerCompanyA.ok && checks.serviceLayerCompanyB.ok);
  } catch (err) {
    sapLogger.warn('Failed to persist diagnostic result', { error: err.message });
  }

  return result;
}
