-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 010 — Insights
-- ═══════════════════════════════════════════════════════════════════════════════
-- Status:    PREVIEW ONLY
-- Project:   sap-logistics-hub
-- Database:  SQL Server (LOGISTICS_SQL_DB)
-- Pair:      010_rollback.sql
--
-- Purpose:
--   Output of intelligence agents. Synthesized cross-source insights:
--     - competitor_threat   (Roborock price drop + spike in mentions)
--     - buying_lead         (mention with high intent + linked SAP customer)
--     - crisis              (cluster of negative mentions)
--     - opportunity         (low competition + positive sentiment trend)
--     - parallel_import     (parallel-import signal flagged by classifier)
--
-- Linked to AgentRuns (migration 008) via nullable AgentRunId — loose coupling
-- so dropping/recreating either table is independent.
--
-- Strict additive — no existing tables touched.
-- ═══════════════════════════════════════════════════════════════════════════════

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Insights')
BEGIN
  CREATE TABLE dbo.Insights (
    InsightId          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),

    -- ── Classification ──
    InsightType        NVARCHAR(48)     NOT NULL,
    AgentName          NVARCHAR(64)     NOT NULL,
    AgentRunId         UNIQUEIDENTIFIER NULL,        -- soft link to AgentRuns
    Severity           NVARCHAR(16)     NOT NULL,

    -- ── Content ──
    Title              NVARCHAR(256)    NOT NULL,
    Body               NVARCHAR(MAX)    NOT NULL,
    SuggestedAction    NVARCHAR(1024)   NULL,

    -- ── Domain attributes ──
    Brand              NVARCHAR(32)     NULL,
    Competitor         NVARCHAR(64)     NULL,

    -- ── Source events that produced this insight (JSON array of EventIds) ──
    SourceEvents       NVARCHAR(MAX)    NOT NULL,

    -- ── Workflow ──
    Status             NVARCHAR(16)     NOT NULL DEFAULT 'open', -- open|reviewed|handled|dismissed
    AssignedTo         NVARCHAR(64)     NULL,
    DueAt              DATETIME2(3)     NULL,
    HandledAt          DATETIME2(3)     NULL,
    HandledBy          NVARCHAR(64)     NULL,
    HandlerNotes       NVARCHAR(MAX)    NULL,

    -- ── Retention / archive (future) ──
    RetainUntil        DATETIME2(3)     NULL,
    ArchivedAt         DATETIME2(3)     NULL,

    -- ── Audit ──
    CreatedAt          DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt          DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT PK_Insights PRIMARY KEY CLUSTERED (InsightId)
  );

  -- ── Common dashboard queries ──
  CREATE NONCLUSTERED INDEX IX_Insights_Status_Severity
    ON dbo.Insights (Status, Severity, CreatedAt DESC);

  CREATE NONCLUSTERED INDEX IX_Insights_Open
    ON dbo.Insights (CreatedAt DESC) WHERE Status = 'open';

  CREATE NONCLUSTERED INDEX IX_Insights_Brand
    ON dbo.Insights (Brand, CreatedAt DESC) WHERE Brand IS NOT NULL;

  CREATE NONCLUSTERED INDEX IX_Insights_Competitor
    ON dbo.Insights (Competitor, CreatedAt DESC) WHERE Competitor IS NOT NULL;

  CREATE NONCLUSTERED INDEX IX_Insights_AgentName
    ON dbo.Insights (AgentName, CreatedAt DESC);

  CREATE NONCLUSTERED INDEX IX_Insights_AgentRunId
    ON dbo.Insights (AgentRunId) WHERE AgentRunId IS NOT NULL;

  CREATE NONCLUSTERED INDEX IX_Insights_AssignedTo
    ON dbo.Insights (AssignedTo, Status) WHERE AssignedTo IS NOT NULL;

  PRINT '[010] Insights table + indexes created';
END
ELSE
BEGIN
  PRINT '[010] Insights table already exists — skipped';
END;
GO
