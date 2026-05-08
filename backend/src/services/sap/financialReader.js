/**
 * Financial / commercial read access to SAP Business One.
 *
 * Read-only. All queries are parameterized.
 * Returns aggregates suitable for executive dashboards / agent reasoning.
 *
 * Covers: sales, inventory, margin, customers — across both companies (A + B).
 *
 * NOTE: SAP B1 schemas vary by localization. These queries assume Israeli localization
 * (DocTotal in NIS) and standard SBO tables: ORDR, RDR1, OINV, INV1, OITM, OITW, OCRD.
 */
import { query } from './sqlReader.js';

const COMPANIES = ['A', 'B'];

/**
 * Run the same query against every configured SAP company in parallel,
 * tag each row with CompanyCode, and return a flat array.
 */
async function queryAll(sqlText, params = {}) {
  const results = await Promise.all(
    COMPANIES.map((code) =>
      query(code, sqlText, params)
        .then((rows) => rows.map((r) => ({ ...r, CompanyCode: code })))
        .catch((err) => {
          // Don't fail the whole brief if one company is down — return [] and let
          // the LLM see partial data. Log so we know.
          // eslint-disable-next-line no-console
          console.warn(`[financialReader] company ${code} query failed:`, err.message);
          return [];
        })
    )
  );
  return results.flat();
}

// ============================================================================
// SALES
// ============================================================================

/**
 * Daily sales totals (invoices = OINV) for a date range.
 * Use this for trend analysis: today vs yesterday, week vs prior week, MTD vs prior MTD.
 *
 * Returns: [{ DocDate, CompanyCode, OrderCount, Revenue, AvgOrderValue }]
 */
export async function getDailySales({ fromDate, toDate }) {
  const sqlText = `
    SELECT
      CAST(H.DocDate AS DATE) AS DocDate,
      COUNT(*)               AS OrderCount,
      SUM(H.DocTotal)        AS Revenue,
      AVG(H.DocTotal)        AS AvgOrderValue
    FROM OINV H
    WHERE H.CANCELED = 'N'
      AND H.DocDate BETWEEN @fromDate AND @toDate
    GROUP BY CAST(H.DocDate AS DATE)
    ORDER BY CAST(H.DocDate AS DATE)
  `;
  return queryAll(sqlText, { fromDate, toDate });
}

/**
 * Top selling items in a date range, by revenue.
 * Returns: [{ ItemCode, ItemName, CompanyCode, QtySold, Revenue, OrderCount }]
 */
export async function getTopItems({ fromDate, toDate, limit = 20 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const sqlText = `
    SELECT TOP ${safeLimit}
      L.ItemCode,
      MAX(L.Dscription)    AS ItemName,
      SUM(L.Quantity)      AS QtySold,
      SUM(L.LineTotal)     AS Revenue,
      COUNT(DISTINCT H.DocEntry) AS OrderCount
    FROM OINV H
    INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
    WHERE H.CANCELED = 'N'
      AND H.DocDate BETWEEN @fromDate AND @toDate
    GROUP BY L.ItemCode
    ORDER BY SUM(L.LineTotal) DESC
  `;
  return queryAll(sqlText, { fromDate, toDate });
}

// ============================================================================
// INVENTORY
// ============================================================================

/**
 * Items below reorder point or with very low stock — across all warehouses.
 * Returns: [{ ItemCode, ItemName, CompanyCode, OnHand, Committed, Available, MinLevel }]
 */
export async function getLowStockItems({ thresholdMultiplier = 1.0, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const sqlText = `
    SELECT TOP ${safeLimit}
      I.ItemCode,
      I.ItemName,
      SUM(W.OnHand)                 AS OnHand,
      SUM(W.IsCommited)             AS Committed,
      SUM(W.OnHand - W.IsCommited)  AS Available,
      I.MinLevel                    AS MinLevel
    FROM OITM I
    INNER JOIN OITW W ON W.ItemCode = I.ItemCode
    WHERE I.frozenFor = 'N'
      AND I.SellItem = 'Y'
      AND I.MinLevel > 0
    GROUP BY I.ItemCode, I.ItemName, I.MinLevel
    HAVING SUM(W.OnHand - W.IsCommited) < I.MinLevel * @mult
    ORDER BY (SUM(W.OnHand - W.IsCommited) - I.MinLevel) ASC
  `;
  return queryAll(sqlText, { mult: thresholdMultiplier });
}

/**
 * Slow-moving / dead stock: items with high OnHand but no sales in the last N days.
 * Returns: [{ ItemCode, ItemName, CompanyCode, OnHand, LastSaleDate, DaysSinceSale }]
 */
export async function getDeadStock({ daysWithoutSale = 90, minOnHand = 10, limit = 30 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const sqlText = `
    SELECT TOP ${safeLimit}
      I.ItemCode,
      I.ItemName,
      SUM(W.OnHand) AS OnHand,
      (SELECT MAX(H.DocDate)
         FROM OINV H
         INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
         WHERE L.ItemCode = I.ItemCode AND H.CANCELED = 'N') AS LastSaleDate,
      DATEDIFF(DAY,
        ISNULL((SELECT MAX(H.DocDate)
                FROM OINV H
                INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
                WHERE L.ItemCode = I.ItemCode AND H.CANCELED = 'N'),
               '2000-01-01'),
        GETDATE()) AS DaysSinceSale
    FROM OITM I
    INNER JOIN OITW W ON W.ItemCode = I.ItemCode
    WHERE I.frozenFor = 'N'
      AND I.SellItem = 'Y'
    GROUP BY I.ItemCode, I.ItemName
    HAVING SUM(W.OnHand) >= @minOnHand
       AND DATEDIFF(DAY,
             ISNULL((SELECT MAX(H.DocDate)
                     FROM OINV H
                     INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
                     WHERE L.ItemCode = I.ItemCode AND H.CANCELED = 'N'),
                    '2000-01-01'),
             GETDATE()) >= @days
    ORDER BY SUM(W.OnHand) DESC
  `;
  return queryAll(sqlText, { days: daysWithoutSale, minOnHand });
}

// ============================================================================
// MARGIN
// ============================================================================

/**
 * Gross margin per item for a date range.
 * Margin = (LineTotal - Quantity * AvgPrice from OITM) / LineTotal
 *
 * Note: AvgPrice in OITM is the moving-average cost in SAP.
 * Negative or zero margins = either pricing error or cost not maintained → worth flagging.
 *
 * Returns: [{ ItemCode, ItemName, CompanyCode, Revenue, Cost, GrossMargin, MarginPct }]
 */
export async function getMarginByItem({ fromDate, toDate, limit = 30 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const sqlText = `
    SELECT TOP ${safeLimit}
      L.ItemCode,
      MAX(L.Dscription)        AS ItemName,
      SUM(L.LineTotal)         AS Revenue,
      SUM(L.Quantity * ISNULL(I.AvgPrice, 0)) AS Cost,
      SUM(L.LineTotal) - SUM(L.Quantity * ISNULL(I.AvgPrice, 0)) AS GrossMargin,
      CASE WHEN SUM(L.LineTotal) > 0
           THEN (SUM(L.LineTotal) - SUM(L.Quantity * ISNULL(I.AvgPrice, 0))) * 100.0 / SUM(L.LineTotal)
           ELSE NULL END AS MarginPct
    FROM OINV H
    INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
    LEFT JOIN OITM I ON I.ItemCode = L.ItemCode
    WHERE H.CANCELED = 'N'
      AND H.DocDate BETWEEN @fromDate AND @toDate
      AND L.LineTotal > 0
    GROUP BY L.ItemCode
    ORDER BY SUM(L.LineTotal) DESC
  `;
  return queryAll(sqlText, { fromDate, toDate });
}

// ============================================================================
// CUSTOMERS
// ============================================================================

/**
 * Top customers by revenue in a date range.
 * Returns: [{ CardCode, CardName, CompanyCode, Revenue, OrderCount, LastOrderDate }]
 */
export async function getTopCustomers({ fromDate, toDate, limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const sqlText = `
    SELECT TOP ${safeLimit}
      H.CardCode,
      MAX(H.CardName)      AS CardName,
      SUM(H.DocTotal)      AS Revenue,
      COUNT(*)             AS OrderCount,
      MAX(H.DocDate)       AS LastOrderDate
    FROM OINV H
    WHERE H.CANCELED = 'N'
      AND H.DocDate BETWEEN @fromDate AND @toDate
    GROUP BY H.CardCode
    ORDER BY SUM(H.DocTotal) DESC
  `;
  return queryAll(sqlText, { fromDate, toDate });
}

/**
 * Customers who normally buy regularly but haven't ordered recently — possible churn signal.
 * Definition: bought >= 3 times in prior 90d window, but 0 orders in last `silentDays`.
 *
 * Returns: [{ CardCode, CardName, CompanyCode, PriorOrders, PriorRevenue, LastOrderDate, DaysSilent }]
 */
export async function getChurnRiskCustomers({ silentDays = 30, lookbackDays = 90, limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const sqlText = `
    SELECT TOP ${safeLimit}
      H.CardCode,
      MAX(H.CardName)             AS CardName,
      COUNT(*)                    AS PriorOrders,
      SUM(H.DocTotal)             AS PriorRevenue,
      MAX(H.DocDate)              AS LastOrderDate,
      DATEDIFF(DAY, MAX(H.DocDate), GETDATE()) AS DaysSilent
    FROM OINV H
    WHERE H.CANCELED = 'N'
      AND H.DocDate >= DATEADD(DAY, -@lookback, GETDATE())
      AND H.DocDate <  DATEADD(DAY, -@silent, GETDATE())
      AND NOT EXISTS (
        SELECT 1 FROM OINV H2
        WHERE H2.CardCode = H.CardCode
          AND H2.CANCELED = 'N'
          AND H2.DocDate >= DATEADD(DAY, -@silent, GETDATE())
      )
    GROUP BY H.CardCode
    HAVING COUNT(*) >= 3
    ORDER BY SUM(H.DocTotal) DESC
  `;
  return queryAll(sqlText, { silent: silentDays, lookback: lookbackDays });
}
