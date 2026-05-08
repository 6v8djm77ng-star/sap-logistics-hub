-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 009 — IntelligenceEvents
-- ═══════════════════════════════════════════════════════════════════════════════
-- Status:    PREVIEW ONLY — DO NOT EXECUTE WITHOUT BACKUP
-- Project:   sap-logistics-hub
-- Database:  SQL Server (LOGISTICS_SQL_DB, e.g. SAP_Logistics_Hub)
-- Pair:      009_rollback.sql
--
-- Purpose:
--   Persistent store for unified Intelligence Events flowing across:
--     - facebook-service-agent  (mention.* events)
--     - sap-logistics-hub       (intel.*, sap.* events)
--     - davo-price-monitor      (price.* events)
--
-- Event-bus migration plan:
--   Today:   POST /api/intelligence/events writes to this table directly
--   Future:  Redis Streams / Kafka publishes; a consumer worker writes here
--   Either way, this table remains the durable store of record.
--
-- Future-readiness baked in:
--   - Retention:   RetainUntil + index for archival worker
--   - Cold storage: ArchivedAt + ArchiveLocation reserved
--   - Partitioning: clustered index on (Timestamp DESC, EventId) — supports
--     monthly partition switch (SWITCH PARTITION) without table rewrite
--   - DLQ:         RetryCount, MaxRetries, NextRetryAt, DeadLetteredAt,
--                  DeadLetterReason — RetryingPublisher decorator (Phase 4+)
--                  populates these fields
--
-- Strict additive — no existing tables touched.
-- ═══════════════════════════════════════════════════════════════════════════════

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'IntelligenceEvents')
BEGIN
  CREATE TABLE dbo.IntelligenceEvents (
    -- ── Primary identity ──
    EventId            UNIQUEIDENTIFIER NOT NULL,
    Timestamp          DATETIME2(3)     NOT NULL,

    -- ── Envelope ──
    EventType          NVARCHAR(64)     NOT NULL,
    Source             NVARCHAR(32)     NOT NULL,
    SchemaVersion      INT              NOT NULL DEFAULT 1,

    -- ── Entity reference ──
    EntityType         NVARCHAR(64)     NOT NULL,
    EntityId           NVARCHAR(128)    NOT NULL,
    EntityName         NVARCHAR(512)    NULL,

    -- ── Domain attributes ──
    Brand              NVARCHAR(32)     NULL,
    Competitor         NVARCHAR(64)     NULL,
    Severity           NVARCHAR(16)     NOT NULL,
    Sentiment          NVARCHAR(16)     NULL,
    Intent             NVARCHAR(48)     NULL,
    Confidence         DECIMAL(3,2)     NULL,

    -- ── Payload (JSON, source-specific data) ──
    Payload            NVARCHAR(MAX)    NOT NULL,

    -- ── Receiver tracking ──
    ReceivedAt         DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    ProcessedAt        DATETIME2(3)     NULL,
    ProcessingError    NVARCHAR(2000)   NULL,

    -- ── Retry / DLQ (future-ready, Phase 4+) ──
    RetryCount         INT              NOT NULL DEFAULT 0,
    MaxRetries         INT              NOT NULL DEFAULT 3,
    NextRetryAt        DATETIME2(3)     NULL,
    DeadLetteredAt     DATETIME2(3)     NULL,
    DeadLetterReason   NVARCHAR(512)    NULL,

    -- ── Retention / cold storage (future-ready) ──
    RetainUntil        DATETIME2(3)     NULL,
    ArchivedAt         DATETIME2(3)     NULL,
    ArchiveLocation    NVARCHAR(512)    NULL,

    -- ── Primary key: composite, partition-ready ──
    -- Clustered on Timestamp DESC keeps recent events on adjacent pages
    -- and is the natural partitioning column for monthly buckets.
    CONSTRAINT PK_IntelligenceEvents PRIMARY KEY CLUSTERED (Timestamp DESC, EventId)
  );

  -- ── Lookup by EventId (idempotent inserts, dedup) ──
  CREATE NONCLUSTERED INDEX IX_IntelEvents_EventId
    ON dbo.IntelligenceEvents (EventId);

  -- ── Common access patterns ──
  CREATE NONCLUSTERED INDEX IX_IntelEvents_EventType_Time
    ON dbo.IntelligenceEvents (EventType, Timestamp DESC);

  CREATE NONCLUSTERED INDEX IX_IntelEvents_Source_Time
    ON dbo.IntelligenceEvents (Source, Timestamp DESC);

  CREATE NONCLUSTERED INDEX IX_IntelEvents_Brand_Time
    ON dbo.IntelligenceEvents (Brand, Timestamp DESC) WHERE Brand IS NOT NULL;

  CREATE NONCLUSTERED INDEX IX_IntelEvents_Severity_Time
    ON dbo.IntelligenceEvents (Severity, Timestamp DESC);

  -- ── Worker queues ──
  -- Unprocessed events: agents poll for work
  CREATE NONCLUSTERED INDEX IX_IntelEvents_Unprocessed
    ON dbo.IntelligenceEvents (ReceivedAt)
    WHERE ProcessedAt IS NULL AND DeadLetteredAt IS NULL;

  -- Retention worker: events past RetainUntil ready for archive
  CREATE NONCLUSTERED INDEX IX_IntelEvents_RetainUntil
    ON dbo.IntelligenceEvents (RetainUntil)
    WHERE RetainUntil IS NOT NULL AND ArchivedAt IS NULL;

  -- DLQ worker: events scheduled for retry
  CREATE NONCLUSTERED INDEX IX_IntelEvents_NextRetry
    ON dbo.IntelligenceEvents (NextRetryAt)
    WHERE NextRetryAt IS NOT NULL AND DeadLetteredAt IS NULL;

  PRINT '[009] IntelligenceEvents table + indexes created';
END
ELSE
BEGIN
  PRINT '[009] IntelligenceEvents table already exists — skipped (idempotent)';
END;
GO
