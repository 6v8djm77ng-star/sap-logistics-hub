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
    {
      name: 'cloudflare-tunnel',
      script: 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
      args: 'tunnel --url http://localhost:4000',
      autorestart: true,
      watch: false,
      max_restarts: 100,
      min_uptime: '30s',
      error_file: __dirname + '/backend/logs/cf-tunnel-error.log',
      out_file: __dirname + '/backend/logs/cf-tunnel-out.log',
      merge_logs: true,
    },
    {
      name: 'sap-logistics',
      // Phase 2 hardened production server — replaces ./src/demo/demoServer.js,
      // which defined its own /api/users etc. routes inline without requireAuth.
      // src/server.js wires every route file through the auth middleware and
      // applies Helmet CSP + scoped CORS. Switched 2026-05-05.
      script: './src/server.js',
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
