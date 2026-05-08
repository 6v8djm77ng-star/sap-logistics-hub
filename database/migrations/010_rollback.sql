-- Rollback for migration 010 — Insights.
-- Primary rollback path: restore from BACKUP DATABASE.

IF EXISTS (SELECT * FROM sys.tables WHERE name = 'Insights')
BEGIN
  DROP TABLE dbo.Insights;
  PRINT '[010 rollback] Insights table dropped';
END
ELSE
BEGIN
  PRINT '[010 rollback] Insights table did not exist — no-op';
END;
GO
