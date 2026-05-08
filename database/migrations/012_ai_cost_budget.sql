-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 012 — AiSpendBudget
-- ═══════════════════════════════════════════════════════════════════════════════
-- Status:    PREVIEW ONLY
-- Project:   sap-logistics-hub
-- Database:  SQL Server (LOGISTICS_SQL_DB)
-- Pair:      012_rollback.sql
--
-- Purpose:
--   Track agent token + USD usage for budget enforcement.
--   aiCostGuard.js reads/writes this table starting Phase 4.
--
-- Bucket grain:
--   - PeriodType + PeriodKey identify the bucket
--     daily:   '2026-05-08'
--     hourly:  '2026-05-08T14'
--   - Optional AgentName / Model further partitions for per-agent budgets
--
-- Limits enforced by aiCostGuard.selectModel():
--   - When TokensIn+TokensOut >= DailyTokenBudget for current daily bucket
--     → switch from PRIMARY to FALLBACK model
--   - When UsdCost >= HourlyUsdLimit for current hourly bucket
--     → set BackpressureActive=1, BackpressureUntil=end-of-hour
--
-- Strict additive.
-- ═══════════════════════════════════════════════════════════════════════════════

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AiSpendBudget')
BEGIN
  CREATE TABLE dbo.AiSpendBudget (
    BudgetId           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),

    -- ── Bucket key ──
    PeriodType         NVARCHAR(8)      NOT NULL,        -- 'daily' | 'hourly'
    PeriodKey          NVARCHAR(20)     NOT NULL,        -- '2026-05-08' | '2026-05-08T14'
    AgentName          NVARCHAR(64)     NULL,            -- NULL = aggregate across agents
    Model              NVARCHAR(64)     NULL,            -- NULL = aggregate across models

    -- ── Accumulators ──
    TokensIn           BIGINT           NOT NULL DEFAULT 0,
    TokensOut          BIGINT           NOT NULL DEFAULT 0,
    UsdCost            DECIMAL(10,4)    NOT NULL DEFAULT 0,
    CallCount          INT              NOT NULL DEFAULT 0,

    -- ── Limits snapshot (for audit; live values from env) ──
    DailyTokenBudget   BIGINT           NULL,
    HourlyUsdLimit     DECIMAL(10,4)    NULL,

    -- ── Backpressure state ──
    BackpressureActive BIT              NOT NULL DEFAULT 0,
    BackpressureUntil  DATETIME2(3)     NULL,
    BackpressureReason NVARCHAR(128)    NULL,

    -- ── Audit ──
    CreatedAt          DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt          DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT PK_AiSpendBudget PRIMARY KEY CLUSTERED (BudgetId),
    -- AgentName / Model NULL is allowed (aggregate row); use ISNULL trick if
    -- a unique constraint over nullable columns is needed in future.
    CONSTRAINT UQ_AiSpend_Bucket UNIQUE (PeriodType, PeriodKey, AgentName, Model)
  );

  -- Lookup current bucket fast
  CREATE NONCLUSTERED INDEX IX_AiSpend_PeriodKey
    ON dbo.AiSpendBudget (PeriodKey, PeriodType);

  -- Find paused agents
  CREATE NONCLUSTERED INDEX IX_AiSpend_Backpressure
    ON dbo.AiSpendBudget (BackpressureActive, BackpressureUntil)
    WHERE BackpressureActive = 1;

  PRINT '[012] AiSpendBudget table + indexes created';
END
ELSE
BEGIN
  PRINT '[012] AiSpendBudget table already exists — skipped';
END;
GO
