/**
 * Direct SQL read access to SAP Business One databases.
 *
 * Why SQL instead of Service Layer for reads:
 *   - 10x-50x faster for complex queries (joins, aggregations)
 *   - Can join across both company DBs in one query (via Linked Server or same instance)
 *   - Service Layer has rate limits and pagination overhead
 *
 * WRITE operations always go through Service Layer - never direct SQL.
 */
import sql from 'mssql';
import { env, companies } from '../../config/env.js';
import { dbLogger } from '../../utils/logger.js';

const poolConfig = (database) => ({
  user: env.SAP_SQL_USER,
  password: env.SAP_SQL_PASSWORD,
  server: env.SAP_SQL_HOST,
  port: env.SAP_SQL_PORT,
  database,
  options: {
    encrypt: env.SAP_SQL_ENCRYPT,
    trustServerCertificate: env.SAP_SQL_TRUST_SERVER_CERT,
    enableArithAbort: true,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
});

const pools = new Map();

async function getPool(companyCode) {
  const db = companies[companyCode]?.sqlDb;
  if (!db) throw new Error(`Unknown company: ${companyCode}`);
  if (!pools.has(companyCode)) {
    const pool = new sql.ConnectionPool(poolConfig(db));
    pool.on('error', (err) => dbLogger.error('SAP SQL pool error', { company: companyCode, err }));
    await pool.connect();
    pools.set(companyCode, pool);
    dbLogger.info(`Connected to SAP ${companyCode} (${db})`);
  }
  return pools.get(companyCode);
}

/**
 * Run a query in a specific company's SAP DB.
 */
export async function query(companyCode, sqlText, params = {}) {
  const pool = await getPool(companyCode);
  const request = pool.request();
  for (const [key, value] of Object.entries(params)) {
    request.input(key, value);
  }
  const result = await request.query(sqlText);
  return result.recordset;
}

// ============================================================================
// SAP B1 standard queries
// ============================================================================

/**
 * Get open Sales Orders (ORDR) for a company, filtered by date.
 * Returns flattened rows with header + first ship-to address.
 *
 * SAP tables:
 *   - ORDR: order header
 *   - RDR1: order lines
 *   - OCRD: business partner (customer)
 *   - CRD1: ship-to addresses
 */
export async function getOpenOrders(companyCode, { fromDate, toDate, cardCode } = {}) {
  const filters = ['H.DocStatus = \'O\'', 'H.CANCELED = \'N\''];
  const params = {};
  if (fromDate) {
    filters.push('H.DocDueDate >= @fromDate');
    params.fromDate = fromDate;
  }
  if (toDate) {
    filters.push('H.DocDueDate <= @toDate');
    params.toDate = toDate;
  }
  if (cardCode) {
    filters.push('H.CardCode = @cardCode');
    params.cardCode = cardCode;
  }

  const sqlText = `
    SELECT
      H.DocEntry,
      H.DocNum,
      H.DocDate,
      H.DocDueDate,
      H.CardCode,
      H.CardName,
      H.DocTotal,
      H.DocCurrency,
      H.Comments,
      H.U_ShipToCode AS ShipToCode,
      H.Address2     AS ShipToAddress,  -- SAP stores full formatted ship-to in Address2
      C.Street       AS CustStreet,
      C.City         AS CustCity,
      C.ZipCode      AS CustZipCode,
      C.StreetNo     AS CustBuildingNumber,
      (SELECT COUNT(*) FROM RDR1 WHERE DocEntry = H.DocEntry) AS LinesCount
    FROM ORDR H
    LEFT JOIN OCRD C ON C.CardCode = H.CardCode
    WHERE ${filters.join(' AND ')}
    ORDER BY H.DocDueDate, H.DocNum
  `;

  return query(companyCode, sqlText, params);
}

/**
 * Get all lines for a specific Sales Order.
 */
export async function getOrderLines(companyCode, docEntry) {
  const sqlText = `
    SELECT
      L.LineNum,
      L.ItemCode,
      L.Dscription  AS ItemName,
      L.Quantity,
      L.OpenQty,
      L.WhsCode     AS WarehouseCode,
      L.UomCode,
      L.Price,
      L.LineTotal,
      L.LineStatus,
      I.ItmsGrpCod  AS ItemGroupCode,
      I.U_BinLoc    AS BinLocation
    FROM RDR1 L
    LEFT JOIN OITM I ON I.ItemCode = L.ItemCode
    WHERE L.DocEntry = @docEntry
      AND L.LineStatus = 'O'
    ORDER BY L.LineNum
  `;
  return query(companyCode, sqlText, { docEntry });
}

/**
 * Find customers with similar names across both companies (for unification).
 */
export async function findCustomerByName(companyCode, searchTerm, limit = 25) {
  const sqlText = `
    SELECT TOP ${Math.min(Number(limit) || 25, 100)}
      CardCode,
      CardName,
      Phone1,
      Address,
      City,
      ZipCode,
      Street,
      StreetNo
    FROM OCRD
    WHERE CardType = 'C'
      AND (CardName LIKE @search OR CardCode LIKE @search)
    ORDER BY CardName
  `;
  return query(companyCode, sqlText, { search: `%${searchTerm}%` });
}

/**
 * Search customers across BOTH companies.
 * Returns unified results tagged by company.
 */
export async function searchCustomersAllCompanies(searchTerm, limit = 25) {
  const [a, b] = await Promise.all([
    findCustomerByName('A', searchTerm, limit).then((rows) =>
      rows.map((r) => ({ ...r, CompanyCode: 'A' }))
    ).catch(() => []),
    findCustomerByName('B', searchTerm, limit).then((rows) =>
      rows.map((r) => ({ ...r, CompanyCode: 'B' }))
    ).catch(() => []),
  ]);
  return [...a, ...b];
}

/**
 * Get customer details + items recently bought.
 * For return request flow - show what was bought so you can pick items to return.
 */
export async function getCustomerRecentItems(companyCode, cardCode, daysBack = 90) {
  const sqlText = `
    SELECT TOP 50
      L.ItemCode,
      L.Dscription AS ItemName,
      MAX(H.DocDate) AS LastPurchaseDate,
      SUM(L.Quantity) AS TotalQuantity
    FROM ORDR H
    INNER JOIN RDR1 L ON L.DocEntry = H.DocEntry
    WHERE H.CardCode = @cardCode
      AND H.DocDate >= DATEADD(DAY, -@days, GETDATE())
    GROUP BY L.ItemCode, L.Dscription
    ORDER BY MAX(H.DocDate) DESC
  `;
  return query(companyCode, sqlText, { cardCode, days: daysBack });
}

/**
 * Get customer info by CardCode from a specific company.
 */
export async function getCustomer(companyCode, cardCode) {
  const sqlText = `
    SELECT
      CardCode, CardName, Phone1, Phone2, E_Mail,
      Address, Street, StreetNo, City, ZipCode,
      CntctPrsn AS ContactPerson
    FROM OCRD
    WHERE CardCode = @cardCode
  `;
  const rows = await query(companyCode, sqlText, { cardCode });
  return rows[0] || null;
}

/**
 * Get ship-to addresses for a customer (CRD1 = addresses).
 */
export async function getCustomerAddresses(companyCode, cardCode) {
  const sqlText = `
    SELECT
      Address,
      Street,
      StreetNo,
      Block,
      City,
      ZipCode,
      Country,
      AdresType  -- 'S' = ship-to, 'B' = bill-to
    FROM CRD1
    WHERE CardCode = @cardCode
      AND AdresType = 'S'
    ORDER BY Address
  `;
  return query(companyCode, sqlText, { cardCode });
}

/**
 * Get inventory on hand for specific items across warehouses.
 */
export async function getItemsStock(companyCode, itemCodes = []) {
  if (itemCodes.length === 0) return [];
  const sqlText = `
    SELECT
      W.ItemCode,
      W.WhsCode     AS WarehouseCode,
      W.OnHand,
      W.IsCommited  AS Committed,
      W.OnOrder,
      (W.OnHand - W.IsCommited) AS Available
    FROM OITW W
    WHERE W.ItemCode IN (${itemCodes.map((_, i) => `@item${i}`).join(',')})
      AND W.OnHand > 0
    ORDER BY W.ItemCode, W.WhsCode
  `;
  const params = {};
  itemCodes.forEach((code, i) => {
    params[`item${i}`] = code;
  });
  return query(companyCode, sqlText, params);
}

export async function closeAll() {
  for (const [code, pool] of pools) {
    try {
      await pool.close();
      dbLogger.info(`Closed SAP SQL pool for ${code}`);
    } catch (err) {
      dbLogger.error('Error closing pool', { company: code, err });
    }
  }
  pools.clear();
}
