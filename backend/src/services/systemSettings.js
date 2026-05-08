/**
 * System Settings - runtime-configurable settings (non-secret).
 *
 * Use for:
 *   - Warehouse codes
 *   - Notification preferences (SMS/email enabled flags)
 *   - Portal base URL
 *   - Operational state flags (sap.servicelayer.ready)
 *
 * Do NOT use for secrets (passwords, tokens) - those stay in .env.
 */
import * as db from '../db/logisticsDb.js';

/**
 * Get a single setting by key with type coercion.
 */
export async function get(key) {
  const row = await db.queryOne(
    `SELECT SettingValue, DataType, IsSecret FROM dbo.SystemSettings WHERE SettingKey = @key`,
    { key }
  );
  if (!row) return null;
  return coerceValue(row.SettingValue, row.DataType);
}

/**
 * Get all settings, optionally filtered by category.
 * Returns a flat object { key: value }.
 */
export async function getAll({ category = null, includeSecret = false } = {}) {
  const filters = ['1=1'];
  const params = {};
  if (category) { filters.push('Category = @cat'); params.cat = category; }
  if (!includeSecret) filters.push('IsSecret = 0');

  const rows = await db.query(
    `SELECT SettingKey, SettingValue, DataType, Category, Description, IsSecret, UpdatedAt
     FROM dbo.SystemSettings
     WHERE ${filters.join(' AND ')}
     ORDER BY Category, SettingKey`,
    params
  );

  return rows.map((r) => ({
    key: r.SettingKey,
    value: r.IsSecret ? '***' : coerceValue(r.SettingValue, r.DataType),
    category: r.Category,
    dataType: r.DataType,
    description: r.Description,
    isSecret: r.IsSecret,
    updatedAt: r.UpdatedAt,
  }));
}

export async function set(key, value, userId = null) {
  const meta = await db.queryOne(
    `SELECT DataType FROM dbo.SystemSettings WHERE SettingKey = @key`,
    { key }
  );
  if (!meta) throw new Error(`Unknown setting: ${key}`);

  const serialized = serializeValue(value, meta.DataType);

  await db.execute(
    `UPDATE dbo.SystemSettings
     SET SettingValue = @value, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @userId
     WHERE SettingKey = @key`,
    { key, value: serialized, userId }
  );

  return { key, value };
}

/**
 * Get setting with fallback to env var.
 * Useful for things like warehouse.defaultCode - check DB first, fall back to env.
 */
export async function getOrEnv(key, envVarName, defaultValue = null) {
  const fromDb = await get(key);
  if (fromDb != null) return fromDb;
  return process.env[envVarName] || defaultValue;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coerceValue(raw, dataType) {
  if (raw == null) return null;
  switch (dataType) {
    case 'INT': return Number(raw);
    case 'BOOLEAN': return raw === 'true' || raw === '1';
    case 'JSON':
      try { return JSON.parse(raw); } catch { return null; }
    default: return raw; // STRING
  }
}

function serializeValue(value, dataType) {
  if (value == null) return null;
  switch (dataType) {
    case 'INT': return String(Number(value));
    case 'BOOLEAN': return value ? 'true' : 'false';
    case 'JSON': return JSON.stringify(value);
    default: return String(value);
  }
}
