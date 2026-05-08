-- ============================================================================
-- Migration 005: System Settings - runtime-configurable settings
-- Non-secret settings that can be changed without restart
-- ============================================================================
USE SAP_Logistics_Hub;
GO

IF OBJECT_ID('dbo.SystemSettings', 'U') IS NULL
CREATE TABLE dbo.SystemSettings (
    SettingKey      VARCHAR(100) PRIMARY KEY,
    SettingValue    NVARCHAR(MAX) NULL,           -- JSON-able string
    Category        VARCHAR(50) NOT NULL,         -- SAP | WAREHOUSE | NOTIFICATIONS | GENERAL
    DataType        VARCHAR(20) NOT NULL,         -- STRING | INT | BOOLEAN | JSON
    Description     NVARCHAR(500) NULL,
    IsSecret        BIT NOT NULL DEFAULT 0,       -- If true, return masked via API
    UpdatedAt       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedBy       INT NULL
);
GO

-- Seed default settings
MERGE dbo.SystemSettings AS target
USING (VALUES
    ('sap.lastTestedAt',            NULL,                        'SAP',           'STRING',  N'מתי נבדק חיבור ה-SAP לאחרונה', 0),
    ('sap.lastTestResult',          NULL,                        'SAP',           'JSON',    N'תוצאת בדיקת חיבור אחרונה', 0),
    ('warehouse.defaultCode',       '01',                        'WAREHOUSE',     'STRING',  N'קוד מחסן ברירת מחדל', 0),
    ('warehouse.returnCode',        '99',                        'WAREHOUSE',     'STRING',  N'קוד מחסן לחזרות', 0),
    ('warehouse.coords.lat',        '32.0853',                   'WAREHOUSE',     'STRING',  N'קואורדינטת המחסן - Latitude', 0),
    ('warehouse.coords.lng',        '34.7818',                   'WAREHOUSE',     'STRING',  N'קואורדינטת המחסן - Longitude', 0),
    ('portal.baseUrl',              'http://localhost:5173',     'GENERAL',       'STRING',  N'כתובת פורטל לקוחות', 0),
    ('notifications.smsEnabled',    'false',                     'NOTIFICATIONS', 'BOOLEAN', N'האם לאפשר שליחת SMS', 0),
    ('notifications.emailEnabled',  'true',                      'NOTIFICATIONS', 'BOOLEAN', N'האם לאפשר שליחת אימייל', 0),
    ('notifications.digestTime',    '07:00',                     'NOTIFICATIONS', 'STRING',  N'שעת שליחת סיכום יומי', 0),
    ('sap.servicelayer.ready',      'false',                     'SAP',           'BOOLEAN', N'האם SAP Service Layer מוכן', 0),
    ('sap.sql.ready',               'false',                     'SAP',           'BOOLEAN', N'האם SAP SQL מוכן', 0)
) AS source(SettingKey, SettingValue, Category, DataType, Description, IsSecret)
ON target.SettingKey = source.SettingKey
WHEN NOT MATCHED THEN
    INSERT (SettingKey, SettingValue, Category, DataType, Description, IsSecret)
    VALUES (source.SettingKey, source.SettingValue, source.Category, source.DataType, source.Description, source.IsSecret);
GO

PRINT 'Migration 005 applied: SystemSettings';
GO
