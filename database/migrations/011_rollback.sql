-- Rollback for migration 011 — Alerts.
-- Primary rollback path: restore from BACKUP DATABASE.

IF EXISTS (SELECT * FROM sys.tables WHERE name = 'Alerts')
BEGIN
  DROP TABLE dbo.Alerts;
  PRINT '[011 rollback] Alerts table dropped';
END
ELSE
BEGIN
  PRINT '[011 rollback] Alerts table did not exist — no-op';
END;
GO
