/**
 * Connection to our own Logistics Hub database.
 * This is where all our new entities live (DeliveryRuns, Zones, etc.)
 */
import sql from 'mssql';
import { env } from '../config/env.js';
import { dbLogger } from '../utils/logger.js';

const poolConfig = {
  user: env.LOGISTICS_SQL_USER,
  password: env.LOGISTICS_SQL_PASSWORD,
  server: env.LOGISTICS_SQL_HOST,
  port: env.LOGISTICS_SQL_PORT,
  database: env.LOGISTICS_SQL_DB,
  options: {
    encrypt: env.LOGISTICS_SQL_ENCRYPT,
    trustServerCertificate: env.LOGISTICS_SQL_TRUST_SERVER_CERT,
    enableArithAbort: true,
  },
  pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
};

let pool = null;

export async function getPool() {
  if (!pool) {
    pool = new sql.ConnectionPool(poolConfig);
    pool.on('error', (err) => dbLogger.error('Logistics DB pool error', { err }));
    await pool.connect();
    dbLogger.info(`Connected to Logistics DB (${env.LOGISTICS_SQL_DB})`);
  }
  return pool;
}

/**
 * Run a parameterized query.
 */
export async function query(sqlText, params = {}) {
  const p = await getPool();
  const req = p.request();
  for (const [key, value] of Object.entries(params)) {
    req.input(key, value);
  }
  const result = await req.query(sqlText);
  return result.recordset;
}

/**
 * Run a query and return the first row (or null).
 */
export async function queryOne(sqlText, params = {}) {
  const rows = await query(sqlText, params);
  return rows[0] || null;
}

/**
 * Execute INSERT/UPDATE/DELETE and return rows affected + inserted id.
 */
export async function execute(sqlText, params = {}) {
  const p = await getPool();
  const req = p.request();
  for (const [key, value] of Object.entries(params)) {
    req.input(key, value);
  }
  const result = await req.query(sqlText);
  return {
    rowsAffected: result.rowsAffected[0],
    recordset: result.recordset,
  };
}

/**
 * Run multiple statements in a single transaction.
 * Pass an async function that receives a transaction object.
 *
 * Usage:
 *   await transaction(async (tx) => {
 *     await tx.query('INSERT ...');
 *     await tx.query('UPDATE ...');
 *   });
 */
export async function transaction(fn) {
  const p = await getPool();
  const tx = new sql.Transaction(p);
  await tx.begin();
  try {
    const txHelper = {
      query: async (sqlText, params = {}) => {
        const req = new sql.Request(tx);
        for (const [k, v] of Object.entries(params)) req.input(k, v);
        const result = await req.query(sqlText);
        return result.recordset;
      },
      queryOne: async (sqlText, params = {}) => {
        const req = new sql.Request(tx);
        for (const [k, v] of Object.entries(params)) req.input(k, v);
        const result = await req.query(sqlText);
        return result.recordset[0] || null;
      },
    };
    const result = await fn(txHelper);
    await tx.commit();
    return result;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function close() {
  if (pool) {
    await pool.close();
    pool = null;
    dbLogger.info('Closed Logistics DB pool');
  }
}
