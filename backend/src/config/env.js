/**
 * Environment configuration - parse and validate .env once on startup.
 *
 * Strategy:
 *   - LOGISTICS_SQL_* is REQUIRED - system can't run without its own DB
 *   - SAP_* is OPTIONAL - system can start, user configures via Settings UI
 *   - JWT_SECRET is REQUIRED - auth won't work without it
 */
import 'dotenv/config';
import { z } from 'zod';

// Coerce "" to undefined so Zod's .optional() treats empty env vars as missing
function cleanEnv(env) {
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (cleaned[key] === '') cleaned[key] = undefined;
  }
  return cleaned;
}

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  // Auth - REQUIRED
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  JWT_DRIVER_EXPIRES_IN: z.string().default('7d'),
  JWT_AUDIENCE: z.string().default('sap-logistics-hub'),
  JWT_ISSUER: z.string().default('sap-logistics-hub-api'),
  // When true, jwt.verify rejects tokens missing aud/iss. Set to true after all
  // active tokens have been re-issued (default: false for backwards compat).
  JWT_STRICT_VERIFY: z.coerce.boolean().default(false),
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(6).max(64).default(8),

  // CORS - comma-separated origins. Default = local dev frontend ports.
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174,http://localhost:4000'),

  // SAP Service Layer - OPTIONAL (configure via Settings UI if missing)
  SAP_SL_URL: z.string().url().optional(),
  SAP_SL_USERNAME: z.string().optional(),
  SAP_SL_PASSWORD: z.string().optional(),
  SAP_SL_COMPANY_DB_A: z.string().optional(),
  SAP_SL_COMPANY_DB_B: z.string().optional(),
  SAP_SL_SSL_REJECT_UNAUTHORIZED: z.coerce.boolean().default(false),

  // SAP SQL Server - OPTIONAL
  SAP_SQL_HOST: z.string().optional(),
  SAP_SQL_PORT: z.coerce.number().default(1433),
  SAP_SQL_USER: z.string().optional(),
  SAP_SQL_PASSWORD: z.string().optional(),
  SAP_SQL_DB_A: z.string().optional(),
  SAP_SQL_DB_B: z.string().optional(),
  // Default flipped to true: encrypt SAP SQL connection. Existing deployments
  // without a CA-signed cert keep working because trustServerCertificate=true.
  SAP_SQL_ENCRYPT: z.coerce.boolean().default(true),
  SAP_SQL_TRUST_SERVER_CERT: z.coerce.boolean().default(true),

  // Logistics DB - REQUIRED (own database)
  LOGISTICS_SQL_HOST: z.string(),
  LOGISTICS_SQL_PORT: z.coerce.number().default(1433),
  LOGISTICS_SQL_USER: z.string(),
  LOGISTICS_SQL_PASSWORD: z.string(),
  LOGISTICS_SQL_DB: z.string().default('SAP_Logistics_Hub'),
  // Encrypt connection. Default true; set LOGISTICS_SQL_ENCRYPT=false to roll back.
  LOGISTICS_SQL_ENCRYPT: z.coerce.boolean().default(true),
  // trustServerCertificate=true is a temporary compromise: enables encrypted
  // transport without a properly signed CA cert. Should be flipped to false
  // once the SQL Server has a CA-signed cert.
  LOGISTICS_SQL_TRUST_SERVER_CERT: z.coerce.boolean().default(true),

  // Business rules
  DISTRIBUTION_ZONES_COUNT: z.coerce.number().default(7),
  DEFAULT_DRIVERS_COUNT: z.coerce.number().default(2),

  // SMTP
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_SECURE: z.coerce.boolean().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  // SMS
  SMS_PROVIDER: z.enum(['none', 'twilio', 'inforu', '019']).default('none'),
  SMS_FROM: z.string().optional(),

  // Customer portal base URL
  PORTAL_BASE_URL: z.string().default('http://localhost:5173'),

  // Agents (LLM) - OPTIONAL. If missing, /api/agents endpoints return 503.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().default(8),
  AGENT_MAX_TOKENS_OUT: z.coerce.number().default(4096),
  CEO_BRIEF_CRON: z.string().default('0 7 * * *'),
  CEO_BRIEF_SCHEDULE_ENABLED: z.coerce.boolean().default(false),

  // DAVO Mix weekly report
  DAVO_MIX_REPORT_CRON: z.string().default('0 8 * * 0'),  // Sunday 08:00 Asia/Jerusalem
  DAVO_MIX_REPORT_ENABLED: z.coerce.boolean().default(false),
  DAVO_MIX_REPORT_RECIPIENTS: z.string().optional(),  // comma-separated emails
});

const parsed = envSchema.safeParse(cleanEnv(process.env));

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  console.error('\n💡 Check backend/.env - LOGISTICS_SQL_* and JWT_SECRET are required.');
  console.error('   SAP credentials are optional at startup - configure via Settings UI.');
  process.exit(1);
}

export const env = parsed.data;

export const agentsConfigured = !!env.ANTHROPIC_API_KEY;

// Flag whether SAP is configured (if any required SAP field missing, it's not configured)
export const sapConfigured = !!(
  env.SAP_SL_URL && env.SAP_SL_USERNAME && env.SAP_SL_PASSWORD &&
  env.SAP_SL_COMPANY_DB_A && env.SAP_SL_COMPANY_DB_B &&
  env.SAP_SQL_HOST && env.SAP_SQL_USER && env.SAP_SQL_PASSWORD &&
  env.SAP_SQL_DB_A && env.SAP_SQL_DB_B
);

export const companies = {
  A: { code: 'A', sqlDb: env.SAP_SQL_DB_A, slDb: env.SAP_SL_COMPANY_DB_A },
  B: { code: 'B', sqlDb: env.SAP_SQL_DB_B, slDb: env.SAP_SL_COMPANY_DB_B },
};

// Warn on startup if SAP not configured
if (!sapConfigured) {
  console.warn('⚠  SAP is not fully configured. The system will start but SAP-dependent features');
  console.warn('   will fail until credentials are added to .env. See Settings UI for diagnostic tool.');
}

// Security posture warnings - surface compromises so they can't silently rot.
if (env.LOGISTICS_SQL_ENCRYPT && env.LOGISTICS_SQL_TRUST_SERVER_CERT) {
  console.warn('⚠  Logistics SQL: encrypt=true but trustServerCertificate=true');
  console.warn('   This is a TEMPORARY compromise — connection is encrypted but cert is not validated (MITM-able).');
  console.warn('   Install a CA-signed cert on the SQL Server and set LOGISTICS_SQL_TRUST_SERVER_CERT=false.');
}
if (env.SAP_SQL_ENCRYPT && env.SAP_SQL_TRUST_SERVER_CERT) {
  console.warn('⚠  SAP SQL: encrypt=true but trustServerCertificate=true (same compromise as above).');
}
if (env.SAP_SL_SSL_REJECT_UNAUTHORIZED === false && env.NODE_ENV === 'production') {
  console.warn('⚠  SAP_SL_SSL_REJECT_UNAUTHORIZED=false in production — Service Layer accepts any cert.');
}
if (!env.JWT_STRICT_VERIFY) {
  console.warn('ℹ  JWT_STRICT_VERIFY=false — tokens without aud/iss claims still accepted (migration mode).');
  console.warn('   Set JWT_STRICT_VERIFY=true after all active sessions have re-logged in.');
}
