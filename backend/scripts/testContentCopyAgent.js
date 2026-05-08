/**
 * Local-only smoke test for the Content & Copy Agent.
 *
 * Imports `runContentCopyAgent` directly and bypasses HTTP auth. Designed for
 * developer / operator validation when an ADMIN Bearer token is not available.
 *
 * Hard rules:
 *   - NEVER prints ANTHROPIC_API_KEY, JWT_SECRET, or any env value
 *   - NEVER calls public endpoints
 *   - Runs exactly one LLM call
 *
 * Run from backend/:
 *   node scripts/testContentCopyAgent.js
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load backend/.env regardless of cwd. Use override: true because PM2's
// cached env may already contain an empty ANTHROPIC_API_KEY from a prior
// state, which dotenv would otherwise refuse to replace.
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), override: true });

// Verify the API key exists WITHOUT echoing it.
if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.length === 0) {
  console.log('=== RESULT ===');
  console.log('success: false');
  console.log('error_code: anthropic_api_key_missing');
  console.log('hint: add ANTHROPIC_API_KEY to backend/.env');
  process.exit(1);
}

// Dynamic import AFTER dotenv has populated process.env, so config/env.js
// validates correctly when first loaded.
const { runContentCopyAgent } = await import('../src/agents/contentCopy/contentCopyAgent.js');

const payload = {
  brand: 'DAVO',
  product: 'מכונת אספרסו DAVO Specialità',
  content_type: 'facebook_post',
  language: 'hebrew',
  target_audience: 'חובבי קפה ביתיים בגילאי 30-55',
  goal: 'awareness',
  tone: 'premium',
  key_points: ['שירות מקומי בישראל', 'סדנאות הדרכה לבעלי מכונה', 'יבואן רשמי'],
  constraints: ['בלי מחירים', 'בלי הבטחות אחריות', 'בלי השוואה ישירה למתחרים בשם'],
};

const REQUIRED_FIELDS = [
  'main_copy',
  'alternative_versions',
  'headline_options',
  'cta_options',
  'cialdini_principles_used',
  'risk_notes',
  'missing_information',
];

const t0 = Date.now();
try {
  const output = await runContentCopyAgent(payload);
  const durationMs = Date.now() - t0;

  let isJson = false;
  let serialized = '';
  try {
    serialized = JSON.stringify(output, null, 2);
    isJson = true;
  } catch {
    isJson = false;
  }

  const present = REQUIRED_FIELDS.filter((k) =>
    Object.prototype.hasOwnProperty.call(output, k)
  );
  const allPresent = present.length === REQUIRED_FIELDS.length;

  console.log('=== RESULT ===');
  console.log('success: true');
  console.log('is_valid_json: ' + isJson);
  console.log('all_required_fields_present: ' + allPresent + ' (' + present.length + '/' + REQUIRED_FIELDS.length + ')');
  console.log('duration_ms: ' + durationMs);
  console.log('--- BODY ---');
  console.log(serialized);
  process.exit(0);
} catch (err) {
  const durationMs = Date.now() - t0;
  console.log('=== RESULT ===');
  console.log('success: false');
  console.log('error_code: ' + (err.code || err.message || 'unknown'));
  console.log('status_hint: ' + (err.statusHint || 'n/a'));
  console.log('duration_ms: ' + durationMs);
  if (err.code === 'invalid_input' && err.details) {
    console.log('details: ' + JSON.stringify(err.details));
  }
  if (err.cause) {
    console.log('underlying: ' + JSON.stringify(err.cause));
  }
  process.exit(2);
}
