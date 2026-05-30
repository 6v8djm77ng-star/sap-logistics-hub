/**
 * PM2 ecosystem - production process management.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 status
 *   pm2 logs
 *   pm2 restart all
 */
// Load backend/.env values up front so PM2 passes them to the child.
// PM2 does NOT read .env files automatically. We parse the file manually
// (no dependency on the dotenv package, which lives only in backend/node_modules).
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, 'backend', '.env');
const envFromFile = {};
if (fs.existsSync(envPath)) {
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    envFromFile[key] = val;
  }
}

module.exports = {
  apps: [
    // (2026-05-30) cloudflare-tunnel removed — public access now via
    // Tailscale Funnel (https://izik-win10.tailbe99fc.ts.net). Funnel
    // starts automatically with the Tailscale client (no PM2 entry
    // required). The cloudflare quick-tunnel here was unstable (URL
    // rotated on every respawn → mobile links broke). Keeping the
    // ecosystem block invited `pm2 resurrect` to bring it back into
    // a stale config. To restore for a brief test, copy the original
    // block from commit history before this commit on wave-a-mitigation.
    // See cowork/INCIDENTS.md "2026-05-30 — sap-logistics: cloudflare
    // quick-tunnels הוחלפו ב-Tailscale Funnel".
    {
      name: 'sap-logistics',
      // A2g-HOTFIX (2026-05-20): reverted to demoServer.js because the
      // hardened src/server.js cannot serve traffic — its auth route + every
      // SQL-backed endpoint require database SAP_Logistics_Hub on
      // 192.168.0.220:1433 which DOES NOT EXIST. 2026-05-20 enumeration of
      // sys.databases (via the excel SQL user) found 24 DBs, none named
      // *Logistic*. Migration 001 was never run on this server; the
      // 2026-05-05 PM2 switch to src/server.js was never followed by the
      // DB+seed work, but it didn't surface because sap-logistics wasn't
      // actually being kept up in PM2 between then and now.
      //
      // Until the DB is provisioned (CREATE DATABASE + migrations 001-012
      // + seed users + grant rights to a SQL login that the env points
      // to), demoServer.js — which stores everything in backend/data/
      // store.json and was the actual runtime that all the Phase A work
      // was developed against — is the only working option.
      //
      // To restore the hardened server:
      //   1. Have a DBA create SAP_Logistics_Hub on 192.168.0.220
      //   2. Grant the configured LOGISTICS_SQL_USER db_owner on it
      //   3. cd backend && npm run migrate (or run database/migrations/*.sql)
      //   4. Seed at least an admin Users row with bcrypt(admin123)
      //   5. Land Phase A2g-1..4 route parity (A2g-1 is already on
      //      feature/sap-write-a2g-1-documents-routes branch)
      //   6. Flip this script path back to './src/server.js'
      //   7. pm2 restart sap-logistics
      // See cowork/INCIDENTS.md "2026-05-20 ~10:50 — hardened server
      // unreachable without SAP_Logistics_Hub DB" for the full timeline.
      script: './src/demo/demoServer.js',
      // Run from the backend directory so `dotenv/config` finds backend/.env
      cwd: __dirname + '/backend',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // Restart if memory exceeds 1GB (prevents memory leak crashes)
      max_memory_restart: '1G',
      // Pass every key from backend/.env into the child env, plus our overrides.
      env: {
        ...envFromFile,
        NODE_ENV: 'production',
        PORT: '4000',
      },
      error_file: __dirname + '/backend/logs/pm2-error.log',
      out_file: __dirname + '/backend/logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Restart on crash with exponential backoff (100ms, 200ms, 400ms...)
      exp_backoff_restart_delay: 100,
      // Restart up to 100 times before giving up (after that requires manual fix)
      max_restarts: 100,
      // Must run for 30s before counting as "stable" (prevents tight crash loops)
      min_uptime: '30s',
      // Kill the process if it doesn't exit gracefully within 5s
      kill_timeout: 5000,
      // Wait this long after a SIGINT before sending SIGKILL
      listen_timeout: 10000,
    },
  ],
};
