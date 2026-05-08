-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 011 — Alerts (dedup, throttle, aggregation, cooldown)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Status:    PREVIEW ONLY
-- Project:   sap-logistics-hub
-- Database:  SQL Server (LOGISTICS_SQL_DB)
-- Pair:      011_rollback.sql
--
-- Purpose:
--   State for alert deduplication, throttling, aggregation windows, and
--   cooldown enforcement. Phase 7 alert engine reads/writes this table.
--
-- Design notes:
--   - AlertKey is the canonical dedup primary key:
--     "{eventType}:{brand}:{competitor}:{severity}"
--   - OccurrenceCount lets the engine surface "5 negative mentions in 1h"
--   - SuppressedUntil enforces cooldown after firing
--   - EventIds is JSON array of source event IDs (for traceability)
--
-- Strict additive.
-- ═══════════════════════════════════════════════════════════════════════════════

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Alerts')
BEGIN
  CREATE TABLE dbo.Alerts (
    AlertId            UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),

    -- ── Dedup key ──
    AlertKey           NVARCHAR(256)    NOT NULL,
    EventType          NVARCHAR(64)     NOT NULL,

    -- ── Domain attributes ──
    Brand              NVARCHAR(32)     NULL,
    Competitor         NVARCHAR(64)     NULL,
    Severity           NVARCHAR(16)     NOT NULL,

    -- ── Aggregation ──
    FirstSeenAt        DATETIME2(3)     NOT NULL,
    LastSeenAt         DATETIME2(3)     NOT NULL,
    OccurrenceCount    INT              NOT NULL DEFAULT 1,
    AggregationWindow  NVARCHAR(16)     NULL,    -- '5m' | '1h' | '1d' | NULL=none

    -- ── Lifecycle ──
    Status             NVARCHAR(16)     NOT NULL DEFAULT 'pending', -- pending|sent|suppressed|throttled
    SentAt             DATETIME2(3)     NULL,
    SentChannel        NVARCHAR(32)     NULL,    -- email | whatsapp | dashboard
    SentTo             NVARCHAR(512)    NULL,
    SuppressedUntil    DATETIME2(3)     NULL,    -- cooldown end

    -- ── Traceability ──
    EventIds           NVARCHAR(MAX)    NULL,    -- JSON array of source EventIds

    -- ── Audit ──
    CreatedAt          DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt          DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT PK_Alerts PRIMARY KEY CLUSTERED (AlertId)
  );

  -- Dedup lookup: alert engine queries by key + window
  CREATE NONCLUSTERED INDEX IX_Alerts_AlertKey_LastSeen
    ON dbo.Alerts (AlertKey, LastSeenAt DESC);

  -- Dashboard listing
  CREATE NONCLUSTERED INDEX IX_Alerts_Status_Created
    ON dbo.Alerts (Status, CreatedAt DESC);

  CREATE NONCLUSTERED INDEX IX_Alerts_Severity_Created
    ON dbo.Alerts (Severity, CreatedAt DESC);

  -- Cooldown sweeper
  CREATE NONCLUSTERED INDEX IX_Alerts_SuppressedUntil
    ON dbo.Alerts (SuppressedUntil) WHERE SuppressedUntil IS NOT NULL;

  PRINT '[011] Alerts table + indexes created';
END
ELSE
BEGIN
  PRINT '[011] Alerts table already exists — skipped';
END;
GO
