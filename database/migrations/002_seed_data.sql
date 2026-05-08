-- ============================================================================
-- Seed data - initial zones, companies, sample drivers
-- ============================================================================

USE SAP_Logistics_Hub;
GO

-- ----------------------------------------------------------------------------
-- Companies
-- ----------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.Companies WHERE Code = 'A')
    INSERT INTO dbo.Companies (Code, Name, SapCompanyDb, IsActive)
    VALUES ('A', N'חברה א', 'SBO_COMPANY_A', 1);

IF NOT EXISTS (SELECT 1 FROM dbo.Companies WHERE Code = 'B')
    INSERT INTO dbo.Companies (Code, Name, SapCompanyDb, IsActive)
    VALUES ('B', N'חברה ב', 'SBO_COMPANY_B', 1);
GO

-- ----------------------------------------------------------------------------
-- Distribution Zones (7 fixed zones)
-- ----------------------------------------------------------------------------
MERGE dbo.Zones AS target
USING (VALUES
    ('NORTH',    N'צפון',         N'חיפה, קריות, גליל',        '#2563eb', 1),
    ('SHARON',   N'שרון',         N'נתניה, הרצליה, רעננה',      '#0891b2', 2),
    ('CENTER',   N'מרכז',         N'תל אביב, רמת גן, גבעתיים', '#059669', 3),
    ('JERUSALEM',N'ירושלים',      N'ירושלים והסביבה',          '#ca8a04', 4),
    ('SHFELA',   N'שפלה',         N'רחובות, ראשון, רמלה, לוד', '#dc2626', 5),
    ('SOUTH-1',  N'דרום - אשדוד', N'אשדוד, אשקלון, קרית גת',   '#9333ea', 6),
    ('SOUTH-2',  N'דרום - ב"ש',   N'באר שבע והדרום',            '#db2777', 7)
) AS source(Code, Name, Description, ColorHex, SortOrder)
ON target.Code = source.Code
WHEN NOT MATCHED THEN
    INSERT (Code, Name, Description, ColorHex, SortOrder, IsActive)
    VALUES (source.Code, source.Name, source.Description, source.ColorHex, source.SortOrder, 1);
GO

-- ----------------------------------------------------------------------------
-- Sample Drivers (2 default drivers)
-- ----------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.Drivers WHERE Code = 'DRV-01')
    INSERT INTO dbo.Drivers (Code, FullName, Phone, IsActive, VehicleCapacity)
    VALUES ('DRV-01', N'נהג 1', '050-0000001', 1, 30);

IF NOT EXISTS (SELECT 1 FROM dbo.Drivers WHERE Code = 'DRV-02')
    INSERT INTO dbo.Drivers (Code, FullName, Phone, IsActive, VehicleCapacity)
    VALUES ('DRV-02', N'נהג 2', '050-0000002', 1, 30);
GO

-- ----------------------------------------------------------------------------
-- Driver default zone assignments
-- Driver 1: North + Sharon + Center + Jerusalem
-- Driver 2: Shfela + South-1 + South-2
-- ----------------------------------------------------------------------------
DECLARE @Drv1 INT = (SELECT DriverId FROM dbo.Drivers WHERE Code = 'DRV-01');
DECLARE @Drv2 INT = (SELECT DriverId FROM dbo.Drivers WHERE Code = 'DRV-02');

INSERT INTO dbo.DriverZones (DriverId, ZoneId, Priority)
SELECT @Drv1, z.ZoneId, 1
FROM dbo.Zones z
WHERE z.Code IN ('NORTH', 'SHARON', 'CENTER', 'JERUSALEM')
  AND NOT EXISTS (SELECT 1 FROM dbo.DriverZones dz WHERE dz.DriverId = @Drv1 AND dz.ZoneId = z.ZoneId);

INSERT INTO dbo.DriverZones (DriverId, ZoneId, Priority)
SELECT @Drv2, z.ZoneId, 1
FROM dbo.Zones z
WHERE z.Code IN ('SHFELA', 'SOUTH-1', 'SOUTH-2')
  AND NOT EXISTS (SELECT 1 FROM dbo.DriverZones dz WHERE dz.DriverId = @Drv2 AND dz.ZoneId = z.ZoneId);
GO

-- ----------------------------------------------------------------------------
-- Default Admin User (password: admin123 - CHANGE IN PRODUCTION)
-- bcrypt hash of 'admin123'
-- ----------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.Users WHERE Username = 'admin')
    INSERT INTO dbo.Users (Username, FullName, Email, PasswordHash, Role, IsActive)
    VALUES ('admin', N'מנהל מערכת', 'admin@oig.local',
            '$2a$10$YourHashHere.ReplaceThis',  -- will be replaced by bcrypt in seed.js
            'ADMIN', 1);
GO

PRINT 'Seed data inserted successfully';
GO
