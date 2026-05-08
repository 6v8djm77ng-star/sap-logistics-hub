/**
 * Fetch a small preview of SAP data to help administrators verify
 * the connection works and see real data flowing in.
 */
import sql from 'mssql';
import { env, companies } from '../config/env.js';

async function getPool(companyCode) {
  const dbName = companies[companyCode]?.sqlDb;
  const pool = new sql.ConnectionPool({
    user: env.SAP_SQL_USER,
    password: env.SAP_SQL_PASSWORD,
    server: env.SAP_SQL_HOST,
    port: env.SAP_SQL_PORT,
    database: dbName,
    options: {
      encrypt: env.SAP_SQL_ENCRYPT,
      trustServerCertificate: env.SAP_SQL_TRUST_SERVER_CERT,
    },
    connectionTimeout: 5000,
    requestTimeout: 10000,
  });
  await pool.connect();
  return pool;
}

export async function getSamplePreview(companyCode, { sampleSize = 10 } = {}) {
  const pool = await getPool(companyCode);

  try {
    const [customers, items, recentOrders] = await Promise.all([
      pool.request().query(`
        SELECT TOP ${Number(sampleSize)}
          CardCode, CardName, Phone1, City, ZipCode,
          (SELECT COUNT(*) FROM CRD1 WHERE CardCode = OCRD.CardCode AND AdresType = 'S') AS ShipToCount
        FROM OCRD
        WHERE CardType = 'C'
          AND validFor = 'Y'
        ORDER BY CardName
      `),
      pool.request().query(`
        SELECT TOP ${Number(sampleSize)}
          ItemCode, ItemName, ItmsGrpCod, SellItem, InvntItem
        FROM OITM
        WHERE SellItem = 'Y'
        ORDER BY ItemName
      `),
      pool.request().query(`
        SELECT TOP ${Number(sampleSize)}
          DocEntry, DocNum, DocDate, DocDueDate,
          CardCode, CardName, DocTotal, DocStatus,
          (SELECT COUNT(*) FROM RDR1 WHERE DocEntry = ORDR.DocEntry) AS LineCount
        FROM ORDR
        WHERE DocStatus = 'O'
        ORDER BY DocDueDate DESC
      `),
    ]);

    return {
      companyCode,
      customers: customers.recordset,
      items: items.recordset,
      recentOrders: recentOrders.recordset,
    };
  } finally {
    try { await pool.close(); } catch {}
  }
}
