/**
 * EventStore — write IntelligenceEvent rows to dbo.IntelligenceEvents.
 *
 * Phase 1 status: PREPARED, NOT YET PERSISTING.
 * The DB write is gated on migration 009 having been applied. Until then,
 * `storeEvent` logs (when INTEL_DEBUG_LOG_EVENTS=true) and returns
 * `{ stored: false, reason: 'phase1_table_not_present' }`.
 *
 * Once migration 009 is applied:
 *   1. Wire `getLogisticsPool()` from your existing db module
 *   2. Set INTEL_EVENT_STORE_READY=true (added to flags later)
 *   3. The same call path now writes for real — no caller change.
 *
 * Future-readiness baked in:
 *   - RetainUntil computed from INTEL_EVENT_RETENTION_DAYS
 *   - RetryCount / MaxRetries / NextRetryAt — DLQ-ready
 *   - ArchivedAt / ArchiveLocation — cold storage migration ready
 */
import { intelligenceFlags } from '../featureFlags.js';

/**
 * Persist a validated IntelligenceEvent.
 *
 * @param {object} event — already validated by safeValidateEvent
 * @returns {Promise<{stored: boolean, reason?: string, retainUntil?: string}>}
 */
export async function storeEvent(event) {
  const retentionDays = intelligenceFlags.INTEL_EVENT_RETENTION_DAYS;
  const retainUntil = new Date(Date.now() + retentionDays * 86_400_000).toISOString();

  if (intelligenceFlags.INTEL_DEBUG_LOG_EVENTS) {
    // eslint-disable-next-line no-console
    console.log('[eventStore] event received:', {
      eventId: event.eventId,
      eventType: event.eventType,
      source: event.source,
      severity: event.severity,
      retainUntil,
    });
  }

  // Phase 1: do NOT actually insert. Migration 009 is not applied yet.
  // Return a stable shape so the receiver route can respond honestly.
  return {
    stored: false,
    reason: 'phase1_table_not_present',
    retainUntil,
  };

  // ─── Future implementation (uncomment after migration 009 applied) ───
  //
  // const sql = (await import('mssql')).default;
  // const { getLogisticsPool } = await import('../../db/logistics.js');
  // const pool = await getLogisticsPool();
  // await pool.request()
  //   .input('EventId',     sql.UniqueIdentifier, event.eventId)
  //   .input('Timestamp',   sql.DateTime2,        new Date(event.timestamp))
  //   .input('EventType',   sql.NVarChar(64),     event.eventType)
  //   .input('Source',      sql.NVarChar(32),     event.source)
  //   .input('SchemaVersion', sql.Int,            event.schemaVersion)
  //   .input('EntityType',  sql.NVarChar(64),     event.entityType)
  //   .input('EntityId',    sql.NVarChar(128),    event.entityId)
  //   .input('EntityName',  sql.NVarChar(512),    event.entityName ?? null)
  //   .input('Brand',       sql.NVarChar(32),     event.brand ?? null)
  //   .input('Competitor',  sql.NVarChar(64),     event.competitor ?? null)
  //   .input('Severity',    sql.NVarChar(16),     event.severity)
  //   .input('Sentiment',   sql.NVarChar(16),     event.sentiment ?? null)
  //   .input('Intent',      sql.NVarChar(48),     event.intent ?? null)
  //   .input('Confidence',  sql.Decimal(3,2),     event.confidence ?? null)
  //   .input('Payload',     sql.NVarChar(sql.MAX), JSON.stringify(event.payload))
  //   .input('RetainUntil', sql.DateTime2,        new Date(retainUntil))
  //   .query(`
  //     INSERT INTO dbo.IntelligenceEvents
  //       (EventId, Timestamp, EventType, Source, SchemaVersion,
  //        EntityType, EntityId, EntityName,
  //        Brand, Competitor, Severity, Sentiment, Intent, Confidence,
  //        Payload, RetainUntil)
  //     VALUES
  //       (@EventId, @Timestamp, @EventType, @Source, @SchemaVersion,
  //        @EntityType, @EntityId, @EntityName,
  //        @Brand, @Competitor, @Severity, @Sentiment, @Intent, @Confidence,
  //        @Payload, @RetainUntil);
  //   `);
  // return { stored: true, retainUntil };
}
