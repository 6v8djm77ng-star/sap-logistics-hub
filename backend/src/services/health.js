/**
 * Health check service - probes all external dependencies.
 * Used by /health endpoint and startup validation.
 */
import * as db from '../db/logisticsDb.js';
import * as sapSql from './sap/sqlReader.js';
import { getServiceLayer } from './sap/serviceLayer.js';

async function checkLogisticsDb() {
  const start = Date.now();
  try {
    await db.query('SELECT 1 AS ok');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - start };
  }
}

async function checkSapSql(companyCode) {
  const start = Date.now();
  try {
    const rows = await sapSql.query(companyCode, 'SELECT TOP 1 DocEntry FROM ORDR');
    return { ok: true, latencyMs: Date.now() - start, canRead: rows !== null };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - start };
  }
}

async function checkSapServiceLayer(companyCode) {
  const start = Date.now();
  try {
    const sl = getServiceLayer(companyCode);
    await sl.login();
    return { ok: true, latencyMs: Date.now() - start, sessionId: sl.sessionId };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - start };
  }
}

export async function checkHealth() {
  const [logisticsDb, sapSqlA, sapSqlB, sapSlA, sapSlB] = await Promise.all([
    checkLogisticsDb(),
    checkSapSql('A'),
    checkSapSql('B'),
    checkSapServiceLayer('A'),
    checkSapServiceLayer('B'),
  ]);

  const checks = {
    logisticsDb,
    sapSqlA,
    sapSqlB,
    sapSlA,
    sapSlB,
  };

  const ok = Object.values(checks).every((c) => c.ok);

  return {
    ok,
    time: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
  };
}
