/**
 * Standalone SAP connection test - read-only.
 * Tests connection to both company DBs and shows real data.
 *
 * Run: node test-sap-connection.js
 */
import 'dotenv/config';
import sql from 'mssql';

const HOST = process.env.SAP_SQL_HOST;
const PORT = Number(process.env.SAP_SQL_PORT) || 1433;
const USER = process.env.SAP_SQL_USER;
const PASSWORD = process.env.SAP_SQL_PASSWORD;

const companies = [
  { code: 'A', name: 'OIG', db: process.env.SAP_SQL_DB_A },
  { code: 'B', name: 'Unico', db: process.env.SAP_SQL_DB_B },
];

function log(...args) { console.log(...args); }
function section(title) {
  log('\n' + '='.repeat(64));
  log('  ' + title);
  log('='.repeat(64));
}

async function testCompany(company) {
  section(`Testing ${company.name} (${company.db})`);

  const config = {
    user: USER,
    password: PASSWORD,
    server: HOST,
    port: PORT,
    database: company.db,
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
    connectionTimeout: 5000,
    requestTimeout: 10000,
  };

  const start = Date.now();
  let pool;

  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();
    log(`  [OK] Connected in ${Date.now() - start}ms`);

    // Check if SAP tables exist
    log(`\n  Checking SAP schema...`);
    const tables = await pool.request().query(`
      SELECT
        SUM(CASE WHEN name = 'OCRD' THEN 1 ELSE 0 END) AS HasOCRD,
        SUM(CASE WHEN name = 'OITM' THEN 1 ELSE 0 END) AS HasOITM,
        SUM(CASE WHEN name = 'ORDR' THEN 1 ELSE 0 END) AS HasORDR,
        SUM(CASE WHEN name = 'RDR1' THEN 1 ELSE 0 END) AS HasRDR1,
        SUM(CASE WHEN name = 'ODLN' THEN 1 ELSE 0 END) AS HasODLN
      FROM sys.tables
    `);
    const t = tables.recordset[0];
    log(`  OCRD (customers): ${t.HasOCRD ? '[OK]' : '[MISSING]'}`);
    log(`  OITM (items):     ${t.HasOITM ? '[OK]' : '[MISSING]'}`);
    log(`  ORDR (orders):    ${t.HasORDR ? '[OK]' : '[MISSING]'}`);
    log(`  RDR1 (lines):     ${t.HasRDR1 ? '[OK]' : '[MISSING]'}`);
    log(`  ODLN (delivery):  ${t.HasODLN ? '[OK]' : '[MISSING]'}`);

    if (!t.HasOCRD || !t.HasORDR) {
      log(`\n  [WARN] This doesn't look like a SAP B1 company DB!`);
      await pool.close();
      return;
    }

    // Counts
    log(`\n  Fetching data counts...`);
    const counts = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM OCRD WHERE CardType = 'C') AS Customers,
        (SELECT COUNT(*) FROM OITM) AS Items,
        (SELECT COUNT(*) FROM ORDR WHERE DocStatus = 'O' AND CANCELED = 'N') AS OpenOrders,
        (SELECT COUNT(*) FROM ORDR) AS TotalOrders
    `);
    const c = counts.recordset[0];
    log(`  Active customers: ${c.Customers}`);
    log(`  Items in catalog: ${c.Items}`);
    log(`  Open orders:      ${c.OpenOrders}`);
    log(`  Total orders:     ${c.TotalOrders}`);

    // Sample customers
    log(`\n  Sample customers (first 5):`);
    const customers = await pool.request().query(`
      SELECT TOP 5 CardCode, CardName, City, Phone1
      FROM OCRD WHERE CardType = 'C' AND validFor = 'Y'
      ORDER BY CardName
    `);
    customers.recordset.forEach((r) => {
      log(`    ${r.CardCode}  |  ${r.CardName}  |  ${r.City || '-'}  |  ${r.Phone1 || '-'}`);
    });

    // Sample open orders
    log(`\n  Recent open orders (first 5):`);
    const orders = await pool.request().query(`
      SELECT TOP 5 DocEntry, DocNum, DocDate, DocDueDate, CardName, DocTotal
      FROM ORDR WHERE DocStatus = 'O' AND CANCELED = 'N'
      ORDER BY DocDueDate DESC, DocNum DESC
    `);
    if (orders.recordset.length === 0) {
      log(`    (no open orders)`);
    } else {
      orders.recordset.forEach((r) => {
        const date = r.DocDueDate ? new Date(r.DocDueDate).toISOString().slice(0, 10) : '-';
        log(`    #${r.DocNum}  |  ${date}  |  ${r.CardName}  |  ${r.DocTotal}`);
      });
    }

    // Sample items
    log(`\n  Sample items (first 5):`);
    const items = await pool.request().query(`
      SELECT TOP 5 ItemCode, ItemName, OnHand
      FROM OITM WHERE SellItem = 'Y'
      ORDER BY ItemName
    `);
    items.recordset.forEach((r) => {
      log(`    ${r.ItemCode}  |  ${r.ItemName}  |  Stock: ${r.OnHand}`);
    });

    await pool.close();
    log(`\n  [OK] ${company.name} fully accessible!`);
  } catch (err) {
    log(`  [ERROR] ${err.message}`);
    if (err.code) log(`  Error code: ${err.code}`);
    if (pool) try { await pool.close(); } catch {}
  }
}

async function main() {
  log(`
╔════════════════════════════════════════════════════════════════╗
║           SAP Connection Test - Read-Only                      ║
╚════════════════════════════════════════════════════════════════╝

Server:   ${HOST}:${PORT}
User:     ${USER}
Databases: ${companies.map((c) => c.db).join(', ')}
`);

  for (const company of companies) {
    await testCompany(company);
  }

  log('\n' + '='.repeat(64));
  log('  Test complete!');
  log('='.repeat(64));
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
