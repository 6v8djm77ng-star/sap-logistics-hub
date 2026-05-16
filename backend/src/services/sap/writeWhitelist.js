/**
 * SAP live-write whitelist — shared logic, called from multiple SAP write paths.
 *
 * Bug 3 fix (2026-05-16): the original A2c-1 implementation put the whitelist
 * check inside backend/src/demo/sapWriter.js. That only protected callers of
 * writeDeliveryNote() / writeInvoice() in sapWriter. But the production driver
 * flow calls SAP through a different path:
 *
 *   server.js (driver routes)
 *     → backend/src/services/deliveryNotes.js  (createDeliveryNoteForOrder)
 *     → backend/src/services/sap/serviceLayer.js → sl.createDeliveryNote()
 *
 * That path bypassed the A2c-1 gate entirely. Same gap exists for
 * createReturnRequest() and createReturn() in serviceLayer.js. This module
 * lifts the whitelist logic out of sapWriter and into a place both layers
 * can import from without crossing the demo/services architectural boundary.
 *
 * Layering: `services/sap/` is the natural home — `serviceLayer.js` lives
 * here, and `sapWriter.js` (in demo/) was importing from services already.
 *
 * The functions in this module are PURE — they read no env, take no
 * filesystem actions. Callers supply the inputs explicitly:
 *
 *   {
 *     writeEnabled: boolean,   // process.env.SAP_WRITE_ENABLED === 'true'
 *     whitelist:    string,    // process.env.SAP_LIVE_WRITE_DB_WHITELIST (CSV)
 *     dbA:          string,    // configured CompanyDB for company A
 *     dbB:          string,    // configured CompanyDB for company B
 *   }
 *
 * Rules (matches the original A2c-1 contract — no behaviour change here,
 * just relocation + adding callers):
 *   - writeEnabled != true → ok (dry-run mode, gate skipped)
 *   - writeEnabled == true + empty whitelist → FAIL (must be explicit)
 *   - writeEnabled == true + DB not in whitelist → FAIL (with offenders)
 *
 * Used by:
 *   - backend/src/server.js (startup gate)
 *   - backend/src/demo/sapWriter.js (per-request gate for writeDN/writeInvoice)
 *   - backend/src/services/sap/serviceLayer.js (per-request gate for
 *     createDeliveryNote / createReturnRequest / createReturn — NEW IN BUG 3)
 */

export function parseWhitelist(raw) {
  return (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Pure gate check. Returns { ok, reason, message?, offenders?, whitelist? }.
 * Never throws. Used at startup (server.js) for clean exit, and indirectly
 * by assertLiveWriteAllowed (which throws on fail) for per-request gates.
 */
export function _checkLiveWriteWhitelist({ writeEnabled, whitelist, dbA, dbB } = {}) {
  if (writeEnabled !== true) {
    return { ok: true, reason: 'WRITE_DISABLED' };
  }
  const list = parseWhitelist(whitelist);
  if (list.length === 0) {
    return {
      ok: false,
      reason: 'WHITELIST_REQUIRED',
      message: 'SAP_WRITE_ENABLED=true requires SAP_LIVE_WRITE_DB_WHITELIST to be set (comma-separated list of allowed DB names). Refusing to allow live writes without an explicit whitelist.',
    };
  }
  const offenders = [];
  if (dbA && !list.includes(dbA)) offenders.push({ company: 'A', db: dbA });
  if (dbB && !list.includes(dbB)) offenders.push({ company: 'B', db: dbB });
  if (offenders.length) {
    return {
      ok: false,
      reason: 'DB_NOT_WHITELISTED',
      message: `SAP_WRITE_ENABLED=true but these company DBs are NOT in SAP_LIVE_WRITE_DB_WHITELIST: ${offenders.map((o) => `${o.company}=${o.db}`).join(', ')}. Whitelist: [${list.join(', ')}].`,
      offenders,
      whitelist: list,
    };
  }
  return { ok: true, reason: 'WHITELISTED', whitelist: list };
}

/**
 * Per-request gate — throws an Error with .status=503 if writes are enabled
 * but the configured DBs are not whitelisted. Callers pass the current env
 * state explicitly so the helper stays pure and unit-testable.
 *
 * No-op when writeEnabled !== true (dry-run never touches SAP).
 */
export function assertLiveWriteAllowed({ writeEnabled, whitelist, dbA, dbB } = {}) {
  if (writeEnabled !== true) return; // dry-run, gate skipped
  const gate = _checkLiveWriteWhitelist({ writeEnabled, whitelist, dbA, dbB });
  if (!gate.ok) {
    const err = new Error('[A2c-1/Bug3 per-request gate] ' + gate.message);
    err.status = 503;
    err.code = gate.reason;
    throw err;
  }
}
