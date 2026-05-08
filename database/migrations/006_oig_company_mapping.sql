-- ============================================================================
-- Migration 006: Update Companies table with actual OIG test DB names
-- ============================================================================
USE SAP_Logistics_Hub;
GO

-- Update company A to point to SAP_OIG_TEST_290724
UPDATE dbo.Companies
SET SapCompanyDb = 'SAP_OIG_TEST_290724',
    Name = N'OIG - חברה ראשית'
WHERE Code = 'A';

-- Update company B to point to Test_Unico
UPDATE dbo.Companies
SET SapCompanyDb = 'Test_Unico',
    Name = N'Unico'
WHERE Code = 'B';

PRINT 'Migration 006 applied: OIG company mapping';
GO
