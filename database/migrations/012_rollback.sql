-- Rollback for migration 012 — AiSpendBudget.
-- Primary rollback path: restore from BACKUP DATABASE.

IF EXISTS (SELECT * FROM sys.tables WHERE name = 'AiSpendBudget')
BEGIN
  DROP TABLE dbo.AiSpendBudget;
  PRINT '[012 rollback] AiSpendBudget table dropped';
END
ELSE
BEGIN
  PRINT '[012 rollback] AiSpendBudget table did not exist — no-op';
END;
GO
