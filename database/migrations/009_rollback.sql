-- ═══════════════════════════════════════════════════════════════════════════════
-- Rollback for migration 009 — IntelligenceEvents
-- ═══════════════════════════════════════════════════════════════════════════════
-- PRIMARY rollback path: restore from `BACKUP DATABASE` taken before migration.
-- This SQL is the secondary path.
-- ═══════════════════════════════════════════════════════════════════════════════

IF EXISTS (SELECT * FROM sys.tables WHERE name = 'IntelligenceEvents')
BEGIN
  DROP TABLE dbo.IntelligenceEvents;
  PRINT '[009 rollback] IntelligenceEvents table dropped';
END
ELSE
BEGIN
  PRINT '[009 rollback] IntelligenceEvents table did not exist — no-op';
END;
GO
