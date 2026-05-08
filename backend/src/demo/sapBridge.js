/**
 * SAP Bridge - connects demo server to real SAP SQL database.
 *
 * Used by demo server to show REAL customer data, REAL open orders,
 * while the logistics layer (runs, drivers) stays as demo data.
 *
 * Read-only. Never writes to SAP.
 */
import sql from 'mssql';

const companies = {
  A: { name: 'OIG', db: process.env.SAP_SQL_DB_A },
  B: { name: 'Unico', db: process.env.SAP_SQL_DB_B },
};

const pools = new Map();

async function getPool(companyCode) {
  if (pools.has(companyCode)) return pools.get(companyCode);

  const db = companies[companyCode]?.db;
  if (!db) throw new Error(`Unknown company: ${companyCode}`);

  const pool = new sql.ConnectionPool({
    user: process.env.SAP_SQL_USER,
    password: process.env.SAP_SQL_PASSWORD,
    server: process.env.SAP_SQL_HOST,
    port: Number(process.env.SAP_SQL_PORT) || 1433,
    database: db,
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 5000,
    requestTimeout: 15000,
    pool: { max: 5 },
  });
  await pool.connect();
  pools.set(companyCode, pool);
  console.log(`[sap-bridge] Connected to ${companyCode} (${db})`);
  return pool;
}

export async function isAvailable() {
  try {
    const host = process.env.SAP_SQL_HOST;
    const user = process.env.SAP_SQL_USER;
    if (!host || host === 'localhost' || !user) return false;
    const pool = await getPool('A');
    const result = await pool.request().query('SELECT 1 AS ok');
    return result.recordset[0].ok === 1;
  } catch {
    return false;
  }
}

/**
 * Search customers across both companies by name.
 */
export async function searchCustomers(query, limit = 20) {
  const results = [];
  for (const [code, info] of Object.entries(companies)) {
    try {
      const pool = await getPool(code);
      const rs = await pool.request()
        .input('q', `%${query}%`)
        .query(`
          SELECT TOP ${Math.min(limit, 50)}
            CardCode, CardName, Phone1, City, ZipCode
          FROM OCRD
          WHERE CardType = 'C'
            AND validFor = 'Y'
            AND (CardName LIKE @q OR CardCode LIKE @q)
          ORDER BY CardName
        `);
      for (const r of rs.recordset) {
        results.push({ ...r, CompanyCode: code });
      }
    } catch (err) {
      console.warn(`[sap-bridge] Search failed for ${code}:`, err.message);
    }
  }
  return results;
}

/**
 * Get sample data for a company (customers, items, orders).
 */
export async function getSamplePreview(companyCode) {
  const pool = await getPool(companyCode);

  const [customers, items, recentOrders, counts] = await Promise.all([
    pool.request().query(`
      SELECT TOP 10 CardCode, CardName, Phone1, City, ZipCode,
        (SELECT COUNT(*) FROM CRD1 WHERE CardCode = OCRD.CardCode AND AdresType = 'S') AS ShipToCount
      FROM OCRD
      WHERE CardType = 'C' AND validFor = 'Y' AND CardName IS NOT NULL
      ORDER BY CardName
    `),
    pool.request().query(`
      SELECT TOP 10 ItemCode, ItemName, ItmsGrpCod, SellItem, InvntItem
      FROM OITM WHERE SellItem = 'Y' AND ItemName IS NOT NULL
      ORDER BY ItemName
    `),
    pool.request().query(`
      SELECT TOP 10 DocEntry, DocNum, DocDate, DocDueDate,
        CardCode, CardName, DocTotal, DocStatus,
        (SELECT COUNT(*) FROM RDR1 WHERE DocEntry = ORDR.DocEntry) AS LineCount
      FROM ORDR
      WHERE DocStatus = 'O' AND CANCELED = 'N'
      ORDER BY DocDueDate DESC, DocNum DESC
    `),
    pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM OCRD WHERE CardType = 'C' AND validFor = 'Y') AS Customers,
        (SELECT COUNT(*) FROM OITM) AS Items,
        (SELECT COUNT(*) FROM ORDR) AS TotalOrders,
        (SELECT COUNT(*) FROM ORDR WHERE DocStatus = 'O' AND CANCELED = 'N') AS OpenOrders
    `),
  ]);

  return {
    companyCode,
    companyName: companies[companyCode].name,
    database: companies[companyCode].db,
    counts: counts.recordset[0],
    customers: customers.recordset,
    items: items.recordset,
    recentOrders: recentOrders.recordset,
  };
}

/**
 * Get open orders from both companies - for the Planner view.
 * Returns unified format matching demo data structure.
 */
export async function getOpenOrdersUnified({ limit = 30 } = {}) {
  const allOrders = [];

  for (const [code, info] of Object.entries(companies)) {
    try {
      const pool = await getPool(code);
      const rs = await pool.request().query(`
        SELECT TOP ${limit}
          H.DocEntry, H.DocNum, H.DocDate, H.DocDueDate,
          H.CardCode, H.CardName, H.DocTotal,
          H.Address AS ShipToAddress,
          C.City AS CustCity, C.ZipCode AS CustZipCode,
          (SELECT COUNT(*) FROM RDR1 WHERE DocEntry = H.DocEntry) AS LinesCount
        FROM ORDR H
        LEFT JOIN OCRD C ON C.CardCode = H.CardCode
        WHERE H.DocStatus = 'O' AND H.CANCELED = 'N'
        ORDER BY H.DocDueDate DESC, H.DocNum DESC
      `);
      for (const r of rs.recordset) {
        allOrders.push({ ...r, CompanyCode: code });
      }
    } catch (err) {
      console.warn(`[sap-bridge] Orders query failed for ${code}:`, err.message);
    }
  }

  // Group by CardCode (simple grouping by customer)
  const byCustomer = new Map();
  for (const order of allOrders) {
    const key = `${order.CardCode}_${order.CustCity || 'unknown'}`;
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        addressId: Math.abs(key.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 10000,
        address: {
          AddressId: 0,
          Street: order.CustStreet || order.CardName,
          BuildingNumber: '',
          City: order.CustCity || 'לא מוגדר',
          BranchName: order.CardName,
          ZipCode: order.CustZipCode,
        },
        zoneId: null,
        orderCount: 0,
        hasCompanyA: false,
        hasCompanyB: false,
        totalLines: 0,
        orders: [],
      });
    }
    const group = byCustomer.get(key);
    group.orderCount++;
    group.totalLines += order.LinesCount || 0;
    if (order.CompanyCode === 'A') group.hasCompanyA = true;
    if (order.CompanyCode === 'B') group.hasCompanyB = true;
    group.orders.push({
      companyCode: order.CompanyCode,
      docEntry: order.DocEntry,
      docNum: order.DocNum,
      cardCode: order.CardCode,
      cardName: order.CardName,
      total: order.DocTotal,
      linesCount: order.LinesCount,
    });
  }

  return Array.from(byCustomer.values());
}

/**
 * Get open orders as FLAT list (both companies, no grouping).
 */
export async function getOpenOrdersFlat({ limit = 100, company = null, search = null } = {}) {
  const allOrders = [];
  const companiesToQuery = company ? [[company, companies[company]]] : Object.entries(companies);

  for (const [code, info] of companiesToQuery) {
    try {
      const pool = await getPool(code);
      const searchFilter = search ? ` AND (H.CardName LIKE @search OR CAST(H.DocNum AS VARCHAR) LIKE @search)` : '';
      const request = pool.request();
      if (search) request.input('search', `%${search}%`);

      const rs = await request.query(`
        SELECT TOP ${Math.min(limit, 500)}
          H.DocEntry, H.DocNum, H.DocDate, H.DocDueDate,
          H.CardCode, H.CardName, H.DocTotal, H.Comments,
          H.Address AS ShipToAddress, H.Address2 AS ShipToFull,
          C.City AS CustCity, C.Phone1 AS CustPhone,
          (SELECT COUNT(*) FROM RDR1 WHERE DocEntry = H.DocEntry) AS LinesCount,
          (SELECT SUM(Quantity) FROM RDR1 WHERE DocEntry = H.DocEntry) AS TotalQuantity
        FROM ORDR H
        LEFT JOIN OCRD C ON C.CardCode = H.CardCode
        WHERE H.DocStatus = 'O' AND H.CANCELED = 'N' ${searchFilter}
        ORDER BY H.DocDueDate DESC, H.DocNum DESC
      `);
      for (const r of rs.recordset) {
        allOrders.push({ ...r, CompanyCode: code, CompanyName: info.name });
      }
    } catch (err) {
      console.warn(`[sap-bridge] Flat orders failed for ${code}:`, err.message);
    }
  }

  allOrders.sort((a, b) => {
    if (!a.DocDueDate) return 1;
    if (!b.DocDueDate) return -1;
    return new Date(b.DocDueDate) - new Date(a.DocDueDate);
  });

  return allOrders.slice(0, limit);
}

/**
 * Get detailed lines for a specific order.
 */
export async function getOrderLines(companyCode, docEntry) {
  const pool = await getPool(companyCode);
  const rs = await pool.request()
    .input('docEntry', Number(docEntry))
    .query(`
      SELECT L.LineNum, L.ItemCode, L.Dscription AS ItemName,
        L.Quantity, L.OpenQty, L.UomCode, L.Price, L.LineTotal,
        L.WhsCode AS WarehouseCode, L.LineStatus,
        I.ItmsGrpCod AS ItemGroup,
        I.CodeBars AS Barcode
      FROM RDR1 L
      LEFT JOIN OITM I ON I.ItemCode = L.ItemCode
      WHERE L.DocEntry = @docEntry
      ORDER BY L.LineNum
    `);
  return rs.recordset;
}

/**
 * Get lines for multiple orders at once - used for building picking wave.
 * Returns flat list of all lines across all orders.
 */
export async function getBulkOrderLines(orderRefs) {
  // orderRefs: [{ companyCode, docEntry }, ...]
  const byCompany = { A: [], B: [] };
  for (const { companyCode, docEntry } of orderRefs) {
    byCompany[companyCode]?.push(Number(docEntry));
  }

  const allLines = [];
  for (const [code, docEntries] of Object.entries(byCompany)) {
    if (docEntries.length === 0) continue;
    try {
      const pool = await getPool(code);
      const list = docEntries.join(',');
      const rs = await pool.request().query(`
        SELECT L.DocEntry, L.LineNum, L.ItemCode, L.Dscription AS ItemName,
          L.Quantity, L.OpenQty, L.UomCode, L.Price, L.LineTotal,
          L.WhsCode AS WarehouseCode, L.LineStatus,
          I.ItmsGrpCod AS ItemGroup,
          I.CodeBars AS Barcode,
          I.SalPackUn AS UnitsPerPack,
          H.CardName, H.DocNum
        FROM RDR1 L
        LEFT JOIN OITM I ON I.ItemCode = L.ItemCode
        INNER JOIN ORDR H ON H.DocEntry = L.DocEntry
        WHERE L.DocEntry IN (${list})
          AND L.OpenQty > 0
        ORDER BY L.DocEntry, L.LineNum
      `);
      for (const r of rs.recordset) {
        allLines.push({ ...r, CompanyCode: code });
      }
    } catch (err) {
      console.warn(`[sap-bridge] Bulk lines failed for ${code}:`, err.message);
    }
  }
  return allLines;
}

/**
 * Get inventory (stock on hand) for specific items - to check availability.
 */
export async function getItemsStock(companyCode, itemCodes) {
  if (!itemCodes || itemCodes.length === 0) return [];
  const pool = await getPool(companyCode);
  const escaped = itemCodes.map((c) => `'${c.replace(/'/g, "''")}'`).join(',');
  const rs = await pool.request().query(`
    SELECT
      W.ItemCode,
      W.WhsCode AS WarehouseCode,
      W.OnHand,
      W.IsCommited AS Committed,
      W.OnOrder,
      (W.OnHand - ISNULL(W.IsCommited, 0)) AS Available
    FROM OITW W
    WHERE W.ItemCode IN (${escaped})
  `);
  return rs.recordset;
}

/**
 * Get total stats for overall overview.
 */
export async function getOverallStats() {
  const results = { companyA: null, companyB: null };
  for (const [code, info] of Object.entries(companies)) {
    try {
      const pool = await getPool(code);
      const rs = await pool.request().query(`
        SELECT
          (SELECT COUNT(*) FROM OCRD WHERE CardType = 'C' AND validFor = 'Y') AS Customers,
          (SELECT COUNT(*) FROM OITM) AS Items,
          (SELECT COUNT(*) FROM ORDR WHERE DocStatus = 'O' AND CANCELED = 'N') AS OpenOrders
      `);
      results[`company${code}`] = { ...rs.recordset[0], name: info.name };
    } catch (err) {
      console.warn(`[sap-bridge] Stats failed for ${code}:`, err.message);
    }
  }
  return results;
}

/**
 * Get every active customer (both companies) for the document-policy table.
 * Returns a flat list — the caller groups them into chains.
 */
export async function getAllCustomers() {
  const all = [];
  for (const [code, info] of Object.entries(companies)) {
    try {
      const pool = await getPool(code);
      const rs = await pool.request().query(`
        SELECT
          C.CardCode,
          C.CardName,
          C.Phone1,
          C.City,
          C.GroupCode,
          ISNULL(C.FatherCard, '') AS FatherCard,
          (SELECT COUNT(*) FROM ORDR O WHERE O.CardCode = C.CardCode AND O.DocStatus = 'O' AND O.CANCELED = 'N') AS OpenOrders
        FROM OCRD C
        WHERE C.CardType = 'C'
          AND C.validFor = 'Y'
          AND C.CardName IS NOT NULL
          AND C.CardName <> ''
        ORDER BY C.CardName
      `);
      for (const r of rs.recordset) {
        all.push({ ...r, CompanyCode: code, CompanyName: info.name });
      }
    } catch (err) {
      console.warn(`[sap-bridge] getAllCustomers ${code}:`, err.message);
    }
  }
  return all;
}

export async function close() {
  for (const [code, pool] of pools) {
    try { await pool.close(); } catch {}
  }
  pools.clear();
}
