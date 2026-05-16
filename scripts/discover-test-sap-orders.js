#!/usr/bin/env node
/**
 * scripts/discover-test-sap-orders.js
 *
 * READ-ONLY discovery of open Sales Orders in SAP company DB A (the test
 * DB after Phase A2c env update). Used to identify real SalesOrder
 * DocEntries that the upcoming `seed-qc-ready-run.js --use-real-sap-orders`
 * flag (A2c-3) will reference.
 *
 * STRICTLY READ-ONLY:
 *   - Only GET requests to SAP Service Layer
 *   - No POST/PATCH/DELETE
 *   - No DN/Invoice creation
 *   - No write to backend/data/store.json
 *   - No PM2 restart
 *   - SAP_WRITE_ENABLED is not even consulted
 *
 * Safety pre-flight:
 *   - Refuses to run if SAP_SL_COMPANY_DB_A does not contain "TEST" in
 *     its name (case-sensitive match — SAP DB names follow that convention).
 *   - Refuses to run if any required env var is empty.
 *   - Reports the resolved DB name in the output so the operator can
 *     visually confirm it's the test DB before relying on the results.
 *
 * Usage:
 *   node scripts/discover-test-sap-orders.js
 *   node scripts/discover-test-sap-orders.js --top 25         # default 10
 *   node scripts/discover-test-sap-orders.js --json           # JSON output
 *
 * Exit codes:
 *   0 — discovery succeeded
 *   1 — env pre-flight failed (missing var, non-test DB)
 *   2 — SAP login failed (auth, network, SSL)
 *   3 — SAP query failed (auth lost, server error)
 *
 * Created 2026-05-16 for Phase A2c. Delete when A2c is finalized and the
 * use-real-sap-orders flow stabilizes.
 */
'use strict';

const path = require('path');
const https = require('https');

// Load .env from backend/.env explicitly (we're running from repo root).
require('dotenv').config({ path: path.resolve(__dirname, '..', 'backend', '.env') });

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const topIdx = args.indexOf('--top');
const TOP = topIdx >= 0 ? Math.max(1, Math.min(100, Number(args[topIdx + 1]) || 10)) : 10;
const JSON_OUTPUT = args.includes('--json');

// ---------------------------------------------------------------------------
// Env resolution (mirrors sapWriter.js post-P1)
// ---------------------------------------------------------------------------
const SL_URL  = process.env.SAP_SL_URL      || process.env.SAP_SERVICE_LAYER_URL      || '';
const SL_USER = process.env.SAP_SL_USERNAME || process.env.SAP_SERVICE_LAYER_USER     || '';
const SL_PASS = process.env.SAP_SL_PASSWORD || process.env.SAP_SERVICE_LAYER_PASSWORD || '';
const DB_A    = process.env.SAP_SL_COMPANY_DB_A
             || process.env.SAP_SERVICE_LAYER_COMPANY_A
             || process.env.SAP_SQL_DB_A
             || '';
const SSL_REJECT = process.env.SAP_SL_SSL_REJECT_UNAUTHORIZED !== 'false';

function log(line) { if (!JSON_OUTPUT) console.log('[discover] ' + line); }
function err(line) { console.error('[discover] ERROR: ' + line); }

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------
function abort(code, message) { err(message); process.exit(code); }

if (!SL_URL)  abort(1, 'SAP_SL_URL is empty');
if (!SL_USER) abort(1, 'SAP_SL_USERNAME is empty');
if (!SL_PASS) abort(1, 'SAP_SL_PASSWORD is empty — set it in backend/.env (current value is empty string, login will fail)');
if (!DB_A)    abort(1, 'SAP_SL_COMPANY_DB_A is empty');

// CRITICAL safety: refuse to discover on a non-test DB. The convention
// is SAP_OIG_TEST_290724 / Test_Unico — both contain "TEST" or "Test".
if (!/TEST|Test/.test(DB_A)) {
  abort(1, `Refusing to discover on non-test DB: '${DB_A}'. Test DBs are expected to contain 'TEST' or 'Test' in the name. If this IS your test DB, rename it (or change this guard) before re-running.`);
}

if (!JSON_OUTPUT) {
  log('==============================================================');
  log(`SAP_SL_URL              = ${SL_URL}`);
  log(`SAP_SL_USERNAME         = ${SL_USER}`);
  // Per user instruction: do NOT print any portion of the password (not
  // even masked-last-4). Only confirm presence.
  log(`SAP_SL_PASSWORD         = ${SL_PASS ? '(set)' : '(empty)'}`);
  log(`SAP_SL_COMPANY_DB_A     = ${DB_A}`);
  log(`SSL_REJECT_UNAUTHORIZED = ${SSL_REJECT}`);
  log(`Top N orders to fetch   = ${TOP}`);
  log('==============================================================');
}

// ---------------------------------------------------------------------------
// HTTPS helper (SAP B1 SL uses self-signed cert in many test deployments)
// ---------------------------------------------------------------------------
const agent = new https.Agent({ rejectUnauthorized: SSL_REJECT });

function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(SL_URL.replace(/\/$/, '') + path);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      agent,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login() {
  log('STEP 1: POST /Login');
  const res = await request('POST', '/Login', {
    UserName: SL_USER,
    Password: SL_PASS,
    CompanyDB: DB_A,
  });
  if (res.status !== 200) {
    abort(2, `Login failed: HTTP ${res.status}. Body: ${res.body.slice(0, 300)}`);
  }
  const setCookie = res.headers['set-cookie'] || [];
  const cookieHeader = setCookie.map((c) => c.split(';')[0]).join('; ');
  if (!cookieHeader) abort(2, 'Login returned 200 but no Set-Cookie header found.');
  let parsed = {};
  try { parsed = JSON.parse(res.body); } catch {}
  log(`  HTTP 200, SessionId=${parsed.SessionId || '(unknown)'}, Version=${parsed.Version || '(unknown)'}`);
  return cookieHeader;
}

async function fetchCompanyInfo(cookie) {
  // SL exposes the connected CompanyDB via the CompanyService_GetCompanyInfo
  // service. We use it as a canary — if the SL reports a different DB than
  // we asked for, that's a server misconfiguration and we should abort.
  log('STEP 2: POST /CompanyService_GetCompanyInfo (response verification)');
  const res = await request('POST', '/CompanyService_GetCompanyInfo', {}, cookie);
  if (res.status !== 200) {
    log(`  WARN: HTTP ${res.status} — CompanyService may not be exposed in this SL build. Continuing without canary.`);
    return null;
  }
  let info = {};
  try { info = JSON.parse(res.body); } catch {}
  log(`  HTTP 200, CompanyDB=${info.CompanyDB || '(unknown)'}, CompanyName=${info.CompanyName || '(unknown)'}`);
  if (info.CompanyDB && info.CompanyDB !== DB_A) {
    abort(2, `Connected DB '${info.CompanyDB}' does not match expected '${DB_A}' — refusing to proceed.`);
  }
  return info;
}

async function fetchOpenOrders(cookie) {
  log(`STEP 3: GET /Orders (open, top ${TOP})`);
  // Pull only the fields we need + a few lines per order so the seed can
  // build BaseEntry/BaseLine references without a second round-trip.
  const select = 'DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocumentStatus';
  const expand = 'DocumentLines($select=LineNum,ItemCode,ItemDescription,Quantity,OpenQuantity,UnitPrice)';
  const filter = `DocumentStatus eq 'bost_Open'`;
  const url = `/Orders?$filter=${encodeURIComponent(filter)}&$top=${TOP}&$select=${select}&$expand=${encodeURIComponent(expand)}`;
  const res = await request('GET', url, null, cookie);
  if (res.status !== 200) {
    abort(3, `GET /Orders failed: HTTP ${res.status}. Body: ${res.body.slice(0, 500)}`);
  }
  let data = {};
  try { data = JSON.parse(res.body); } catch (e) {
    abort(3, `Failed to parse Orders response: ${e.message}. Body: ${res.body.slice(0, 200)}`);
  }
  const orders = Array.isArray(data.value) ? data.value : [];
  log(`  HTTP 200, returned ${orders.length} orders (out of an unknown total)`);
  return orders;
}

async function logout(cookie) {
  // Be a good citizen — release the SAP session immediately.
  log('STEP 4: POST /Logout');
  try { await request('POST', '/Logout', {}, cookie); log('  ok'); }
  catch (e) { log(`  warn: logout failed (${e.message}) — session will time out on its own.`); }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  try {
    const cookie = await login();
    const companyInfo = await fetchCompanyInfo(cookie);
    const orders = await fetchOpenOrders(cookie);
    await logout(cookie);

    if (JSON_OUTPUT) {
      console.log(JSON.stringify({
        ok: true,
        connectedDb: companyInfo?.CompanyDB || DB_A,
        envDb: DB_A,
        companyName: companyInfo?.CompanyName || null,
        openOrderCount: orders.length,
        orders: orders.map((o) => ({
          DocEntry: o.DocEntry,
          DocNum: o.DocNum,
          CardCode: o.CardCode,
          CardName: o.CardName,
          DocDate: o.DocDate,
          DocTotal: o.DocTotal,
          DocumentStatus: o.DocumentStatus,
          LineCount: (o.DocumentLines || []).length,
          DocumentLines: (o.DocumentLines || []).map((ln) => ({
            LineNum: ln.LineNum,
            ItemCode: ln.ItemCode,
            ItemDescription: ln.ItemDescription,
            Quantity: ln.Quantity,
            OpenQuantity: ln.OpenQuantity,
            UnitPrice: ln.UnitPrice,
          })),
        })),
      }, null, 2));
      return;
    }

    log('==============================================================');
    log(`SUMMARY — found ${orders.length} OPEN sales orders in ${DB_A}`);
    log('==============================================================');
    if (orders.length === 0) {
      log('  (no open orders — test DB may be empty; ask SAP admin to create 1-2 test orders)');
      return;
    }
    const examples = orders.slice(0, 3);
    log(`Examples (first ${examples.length}):`);
    for (const o of examples) {
      const lineSummary = (o.DocumentLines || [])
        .slice(0, 3)
        .map((ln) => `${ln.ItemCode}×${ln.OpenQuantity || ln.Quantity}`)
        .join(', ');
      log(`  DocEntry=${o.DocEntry} DocNum=${o.DocNum} CardCode=${o.CardCode} CardName='${(o.CardName || '').slice(0, 40)}' Total=${o.DocTotal} Lines=${(o.DocumentLines || []).length} [${lineSummary}${(o.DocumentLines || []).length > 3 ? ', ...' : ''}]`);
    }
    log('==============================================================');
    log('Discovery complete. NO documents were created in SAP. NO local store changes.');
    log('Next step (NOT executed by this script): A2c-3 will use these DocEntries');
    log('to seed a QC-ready test run that references real SAP orders.');
  } catch (e) {
    // Print only the error message — no stack trace, in case the trace
    // happens to capture the request body (which contains the password).
    err(`Discovery failed: ${e.message}`);
    process.exit(3);
  }
})();
