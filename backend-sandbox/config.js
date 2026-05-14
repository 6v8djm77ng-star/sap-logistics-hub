// =====================================================================
// config.js — sandbox env loader
// Reads .env.sandbox (NOT backend/.env) and validates required keys.
// Refuses to start if production-secret leakage is detected.
//
// Manual .env parser — intentionally no dotenv dependency. Keeps the
// sandbox dep tree minimal (4 packages: express, jwt, anthropic, zod).
// =====================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.sandbox specifically (NOT default .env)
const envPath = path.join(__dirname, '.env.sandbox');
if (!fs.existsSync(envPath)) {
  console.error('FATAL: .env.sandbox not found. Copy .env.sandbox.example → .env.sandbox and fill in values.');
  process.exit(1);
}
const text = fs.readFileSync(envPath, 'utf8');
for (const rawLine of text.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  const key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  // Don't overwrite explicit env (e.g. shell-set values take precedence).
  // Treat empty strings the same as undefined: some shells (incl. Claude Code's)
  // export ANTHROPIC_API_KEY="" which previously caused silent fall-back to mock
  // mode even though .env.sandbox provided a real key. Use truthiness guard.
  if (!process.env[key]) process.env[key] = val;
}

// =====================================================================
// Forbidden flags — refuse to start if these are set
// (these would imply someone copy-pasted a production env into sandbox)
// =====================================================================
const FORBIDDEN = ['SAP_WRITE_ENABLED', 'SAP_SERVICE_LAYER_URL'];
for (const k of FORBIDDEN) {
  if (process.env[k]) {
    console.error(`FATAL: env var ${k} is set in sandbox env. This is forbidden.`);
    console.error('       The sandbox MUST NOT have access to SAP write capability.');
    console.error('       Remove from .env.sandbox and try again.');
    process.exit(1);
  }
}

// Production env-key contamination check
const PROD_KEYS = ['LOGISTICS_SQL_HOST', 'LOGISTICS_SQL_USER', 'LOGISTICS_SQL_PASSWORD'];
for (const k of PROD_KEYS) {
  if (process.env[k]) {
    console.warn(`⚠  WARN: production-style env var ${k} found in sandbox env.`);
    console.warn('       Sandbox does not use Logistics DB. Remove from .env.sandbox if not intentional.');
  }
}

// =====================================================================
// Required keys
// =====================================================================
function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: required env var ${name} not set in .env.sandbox`);
    process.exit(1);
  }
  return v;
}

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`FATAL: ${name} must be numeric, got "${v}"`);
    process.exit(1);
  }
  return n;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

export const config = {
  PORT: num('SANDBOX_PORT', 4101),
  JWT_SECRET: req('SANDBOX_JWT_SECRET'),
  ACCESS_TOKEN: process.env.SANDBOX_ACCESS_TOKEN || '',  // empty = no gate

  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',

  USE_MOCK: bool('SANDBOX_USE_MOCK', true),

  DAILY_BUDGET_USD: num('SANDBOX_DAILY_BUDGET_USD', 5.0),
  PER_RUN_BUDGET_USD: num('SANDBOX_PER_RUN_BUDGET_USD', 0.5),

  MAX_TOOL_CALLS: num('SANDBOX_MAX_TOOL_CALLS', 8),
  MAX_TOKENS_OUT: num('SANDBOX_MAX_TOKENS_OUT', 2000),
};

// JWT secret length guard
if (config.JWT_SECRET.length < 32) {
  console.error('FATAL: SANDBOX_JWT_SECRET must be at least 32 characters.');
  console.error('       Generate one with:');
  console.error('         node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"');
  process.exit(1);
}

// Production-secret-collision guard
// (we can't read production .env from here, but we can warn if the
// sandbox secret looks suspicious — e.g., if it's "changeme" or short)
if (config.JWT_SECRET === 'replace-me-with-64-chars-of-random') {
  console.error('FATAL: SANDBOX_JWT_SECRET is still the placeholder. Generate a real one.');
  process.exit(1);
}

// Anthropic key sanity
if (!config.ANTHROPIC_API_KEY && config.USE_MOCK === false) {
  console.error('FATAL: ANTHROPIC_API_KEY required when SANDBOX_USE_MOCK=false');
  process.exit(1);
}
if (!config.ANTHROPIC_API_KEY) {
  console.warn('⚠  WARN: ANTHROPIC_API_KEY not set. Sandbox will return mock-only outputs.');
}

console.log(`[config] sandbox loaded: PORT=${config.PORT} mock=${config.USE_MOCK} model=${config.ANTHROPIC_MODEL} daily-budget=$${config.DAILY_BUDGET_USD}`);
