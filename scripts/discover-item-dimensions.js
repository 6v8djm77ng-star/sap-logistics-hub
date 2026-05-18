#!/usr/bin/env node
/**
 * scripts/discover-item-dimensions.js
 *
 * READ-ONLY discovery: does the SAP OITM table on this customer's
 * SAP B1 have populated Weight + Volume columns? Phase 3 of the
 * orders-with-condition feature wants to sort picking by item
 * weight + volume; this script reports whether the data exists
 * before we design around it.
 *
 * Runs SELECT-only queries against company A. No writes. No PM2
 * involvement. Safe to run anytime.
 *
 * Output:
 *   - List of OITM columns matching %Weight% / %Volume%
 *   - Sample of 10 actual items showing the values
 *   - Coverage: how many of all active items have non-NULL/non-zero
 *     weight and volume
 *
 * Usage:
 *   cd backend
 *   node ../scripts/discover-item-dimensions.js
 *
 * Exit codes:
 *   0 — discovery succeeded
 *   1 — SAP connection failed
 *   2 — query failed
 */
'use strict';

const path = require('path');
const backendDir = path.resolve(__dirname, '..', 'backend');
const dotenv = require(path.join(backendDir, 'node_modules', 'dotenv'));
dotenv.config({ path: path.join(backendDir, '.env') });

(async () => {
  let sql;
  try {
    sql = require(path.join(backendDir, 'node_modules', 'mssql'));
  } catch (e) {
    console.error('FATAL: mssql module not found. Run from backend/ dir or after npm install.');
    process.exit(1);
  }

  const cfg = {
    server: process.env.SAP_SQL_HOST,
    port: Number(process.env.SAP_SQL_PORT || 1433),
    user: process.env.SAP_SQL_USER,
    password: process.env.SAP_SQL_PASSWORD,
    database: process.env.SAP_SQL_DB_A,
    options: {
      encrypt: process.env.SAP_SQL_ENCRYPT === 'true',
      trustServerCertificate: process.env.SAP_SQL_TRUST_SERVER_CERT === 'true',
    },
    requestTimeout: 30000,
  };

  let pool;
  try {
    pool = await sql.connect(cfg);
    console.log(`[discover] connected to ${cfg.server}:${cfg.port}/${cfg.database}`);
  } catch (err) {
    console.error('FATAL: SAP SQL connect failed:', err.message);
    process.exit(1);
  }

  try {
    // 1. OITM columns related to weight/volume
    console.log('\n=== 1. OITM columns matching Weight/Volume ===');
    const colsRs = await pool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE,
             COL_LENGTH('OITM', COLUMN_NAME) AS col_len
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'OITM'
        AND (COLUMN_NAME LIKE '%Weight%'
          OR COLUMN_NAME LIKE '%Volume%'
          OR COLUMN_NAME LIKE '%Wght%'
          OR COLUMN_NAME LIKE '%Vol%')
      ORDER BY COLUMN_NAME
    `);
    if (colsRs.recordset.length === 0) {
      console.log('  (none — unexpected for SAP B1)');
    } else {
      for (const r of colsRs.recordset) {
        console.log(`  ${r.COLUMN_NAME.padEnd(20)} ${r.DATA_TYPE}`);
      }
    }

    // 2. Sample 10 items with their dimensions
    console.log('\n=== 2. Sample of 10 sellable items (SellItem=Y) ===');
    const sampleRs = await pool.request().query(`
      SELECT TOP 10
        ItemCode, ItemName,
        SWeight1, SWght1Unit,
        SVolume, SVolUnit,
        BWeight1, BVolume,
        SalUnitMsr
      FROM OITM
      WHERE SellItem = 'Y' AND validFor = 'Y'
      ORDER BY ItemCode
    `);
    for (const r of sampleRs.recordset) {
      console.log(`  ${r.ItemCode.padEnd(12)} | name="${(r.ItemName || '').slice(0, 30).padEnd(30)}" | ` +
        `SWeight=${(r.SWeight1 ?? '∅').toString().padEnd(8)} unit=${(r.SWght1Unit ?? '∅').toString().padEnd(4)} | ` +
        `SVolume=${(r.SVolume ?? '∅').toString().padEnd(8)} unit=${(r.SVolUnit ?? '∅').toString().padEnd(4)} | ` +
        `SalUoM=${r.SalUnitMsr ?? '∅'}`);
    }

    // 3. Coverage — among active sellable items, how many have populated dims?
    console.log('\n=== 3. Coverage across all active sellable items ===');
    const covRs = await pool.request().query(`
      SELECT
        COUNT(*) AS TotalActiveSellable,
        SUM(CASE WHEN SWeight1 IS NOT NULL AND SWeight1 > 0 THEN 1 ELSE 0 END) AS HasSWeight,
        SUM(CASE WHEN SVolume  IS NOT NULL AND SVolume  > 0 THEN 1 ELSE 0 END) AS HasSVolume,
        SUM(CASE WHEN BWeight1 IS NOT NULL AND BWeight1 > 0 THEN 1 ELSE 0 END) AS HasBWeight,
        SUM(CASE WHEN BVolume  IS NOT NULL AND BVolume  > 0 THEN 1 ELSE 0 END) AS HasBVolume,
        SUM(CASE WHEN (SWeight1 > 0 OR BWeight1 > 0) AND (SVolume > 0 OR BVolume > 0) THEN 1 ELSE 0 END) AS HasBoth
      FROM OITM
      WHERE SellItem = 'Y' AND validFor = 'Y'
    `);
    const r = covRs.recordset[0];
    const pct = (n) => (r.TotalActiveSellable > 0 ? Math.round(100 * n / r.TotalActiveSellable) : 0);
    console.log(`  Total active sellable items: ${r.TotalActiveSellable}`);
    console.log(`  has SWeight1 > 0: ${r.HasSWeight} (${pct(r.HasSWeight)}%)`);
    console.log(`  has SVolume  > 0: ${r.HasSVolume} (${pct(r.HasSVolume)}%)`);
    console.log(`  has BWeight1 > 0: ${r.HasBWeight} (${pct(r.HasBWeight)}%)`);
    console.log(`  has BVolume  > 0: ${r.HasBVolume} (${pct(r.HasBVolume)}%)`);
    console.log(`  has BOTH (any-weight AND any-volume): ${r.HasBoth} (${pct(r.HasBoth)}%)`);

    // 4. Among the items actually on OPEN orders right now, what's the coverage?
    console.log('\n=== 4. Coverage among items on currently OPEN orders ===');
    const openCovRs = await pool.request().query(`
      WITH ItemsOnOpenOrders AS (
        SELECT DISTINCT L.ItemCode
        FROM RDR1 L
        INNER JOIN ORDR H ON H.DocEntry = L.DocEntry
        WHERE H.DocStatus = 'O' AND H.CANCELED = 'N' AND L.OpenQty > 0
      )
      SELECT
        COUNT(*) AS TotalItemsOnOpenOrders,
        SUM(CASE WHEN I.SWeight1 IS NOT NULL AND I.SWeight1 > 0 THEN 1 ELSE 0 END) AS HasSWeight,
        SUM(CASE WHEN I.SVolume  IS NOT NULL AND I.SVolume  > 0 THEN 1 ELSE 0 END) AS HasSVolume,
        SUM(CASE WHEN (I.SWeight1 > 0 OR I.BWeight1 > 0) AND (I.SVolume > 0 OR I.BVolume > 0) THEN 1 ELSE 0 END) AS HasBoth
      FROM ItemsOnOpenOrders ioo
      LEFT JOIN OITM I ON I.ItemCode = ioo.ItemCode
    `);
    const o = openCovRs.recordset[0];
    const opct = (n) => (o.TotalItemsOnOpenOrders > 0 ? Math.round(100 * n / o.TotalItemsOnOpenOrders) : 0);
    console.log(`  Distinct items on open orders: ${o.TotalItemsOnOpenOrders}`);
    console.log(`  with SWeight1: ${o.HasSWeight} (${opct(o.HasSWeight)}%)`);
    console.log(`  with SVolume:  ${o.HasSVolume} (${opct(o.HasSVolume)}%)`);
    console.log(`  with BOTH:     ${o.HasBoth} (${opct(o.HasBoth)}%)`);

  } catch (err) {
    console.error('FATAL: query failed:', err.message);
    process.exit(2);
  } finally {
    try { await pool.close(); } catch {}
  }

  console.log('\n=== discovery complete (read-only, no SAP writes) ===');
})();
