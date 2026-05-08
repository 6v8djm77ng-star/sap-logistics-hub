-- ============================================================================
-- Migration 004: Failure management, customer portal, alerts
-- ============================================================================
USE SAP_Logistics_Hub;
GO

-- ----------------------------------------------------------------------------
-- Structured failure reasons (catalog)
-- ----------------------------------------------------------------------------
IF OBJECT_ID('dbo.FailureReasons', 'U') IS NULL
CREATE TABLE dbo.FailureReasons (
    ReasonCode      VARCHAR(30) PRIMARY KEY,
    Name            NVARCHAR(100) NOT NULL,
    Category        VARCHAR(20) NOT NULL,         -- CUSTOMER | STORE | ADDRESS | GOODS | OTHER
    Severity        VARCHAR(10) NOT NULL,         -- LOW | MEDIUM | HIGH
    RequiresPhoto   BIT NOT NULL DEFAULT 0,
    RequiresNotes   BIT NOT NULL DEFAULT 0,
    -- Default follow-up action hint
    SuggestedAction VARCHAR(30) NULL,             -- RESCHEDULE | CONTACT_CUSTOMER | CANCEL | MANUAL_REVIEW
    SortOrder       INT NOT NULL DEFAULT 0,
    IsActive        BIT NOT NULL DEFAULT 1
);
GO

-- Seed standard reasons
MERGE dbo.FailureReasons AS target
USING (VALUES
    ('STORE_CLOSED',           N'החנות סגורה',                   'STORE',    'HIGH',   0, 1, 'RESCHEDULE', 10),
    ('STORE_REFUSED',          N'החנות סירבה לקבל סחורה',       'STORE',    'HIGH',   1, 1, 'CONTACT_CUSTOMER', 20),
    ('STORE_FULL_NO_STORAGE',  N'אין מקום אחסון בחנות',         'STORE',    'MEDIUM', 0, 1, 'RESCHEDULE', 30),
    ('STORE_WRONG_HOURS',      N'מחוץ לחלון קבלת סחורה',        'STORE',    'MEDIUM', 0, 0, 'RESCHEDULE', 40),
    ('CUSTOMER_NOT_AVAILABLE', N'הלקוח לא זמין / לא נמצא',      'CUSTOMER', 'MEDIUM', 0, 0, 'CONTACT_CUSTOMER', 50),
    ('CUSTOMER_REFUSED',       N'הלקוח סירב לקבל',               'CUSTOMER', 'HIGH',   1, 1, 'CONTACT_CUSTOMER', 60),
    ('CUSTOMER_NOT_READY',     N'הלקוח לא מוכן לקבל (טרם שילם/חתם)', 'CUSTOMER', 'MEDIUM', 0, 1, 'CONTACT_CUSTOMER', 70),
    ('ADDRESS_NOT_FOUND',      N'כתובת שגויה / לא נמצאה',       'ADDRESS',  'HIGH',   0, 1, 'MANUAL_REVIEW', 80),
    ('ADDRESS_ACCESS_BLOCKED', N'אין גישה לכתובת (סגירה/חסימה)', 'ADDRESS', 'MEDIUM', 1, 1, 'RESCHEDULE', 90),
    ('GOODS_DAMAGED',          N'סחורה פגומה בזמן העמסה / בדרך', 'GOODS',    'HIGH',   1, 1, 'MANUAL_REVIEW', 100),
    ('WRONG_ITEMS_PICKED',     N'פריטים שגויים נלקטו',          'GOODS',    'HIGH',   0, 1, 'MANUAL_REVIEW', 110),
    ('TRUCK_FAILURE',          N'תקלת רכב',                      'OTHER',   'HIGH',   0, 1, 'RESCHEDULE', 120),
    ('WEATHER',                N'מזג אוויר / כביש חסום',        'OTHER',   'MEDIUM', 0, 1, 'RESCHEDULE', 130),
    ('OTHER',                  N'אחר',                            'OTHER',   'LOW',    0, 1, 'MANUAL_REVIEW', 999)
) AS source(ReasonCode, Name, Category, Severity, RequiresPhoto, RequiresNotes, SuggestedAction, SortOrder)
ON target.ReasonCode = source.ReasonCode
WHEN NOT MATCHED THEN
    INSERT (ReasonCode, Name, Category, Severity, RequiresPhoto, RequiresNotes, SuggestedAction, SortOrder, IsActive)
    VALUES (source.ReasonCode, source.Name, source.Category, source.Severity, source.RequiresPhoto, source.RequiresNotes, source.SuggestedAction, source.SortOrder, 1);
GO

-- ----------------------------------------------------------------------------
-- Failure records - each failed stop gets a record
-- Separated from DeliveryStops so we can have rich failure data + history
-- ----------------------------------------------------------------------------
IF OBJECT_ID('dbo.StopFailures', 'U') IS NULL
CREATE TABLE dbo.StopFailures (
    FailureId       INT IDENTITY(1,1) PRIMARY KEY,
    StopId          INT NOT NULL FOREIGN KEY REFERENCES dbo.DeliveryStops(StopId),
    ReasonCode      VARCHAR(30) NOT NULL FOREIGN KEY REFERENCES dbo.FailureReasons(ReasonCode),
    Notes           NVARCHAR(1000) NULL,
    PhotoUrl        VARCHAR(500) NULL,
    ReportedByDriverId INT NULL FOREIGN KEY REFERENCES dbo.Drivers(DriverId),
    -- Resolution tracking
    ResolutionStatus VARCHAR(20) NOT NULL DEFAULT 'OPEN', -- OPEN | RESCHEDULED | RESOLVED | CANCELLED
    ResolvedAt      DATETIME2 NULL,
    ResolvedByUserId INT NULL,
    ResolutionNotes NVARCHAR(1000) NULL,
    RescheduledToRunId INT NULL FOREIGN KEY REFERENCES dbo.DeliveryRuns(RunId),
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_StopFailures_Status ON dbo.StopFailures(ResolutionStatus, CreatedAt DESC);
GO

-- ----------------------------------------------------------------------------
-- Customer tracking tokens - for public portal links
-- One token per Stop (not per Order, since the customer tracks the truck arrival)
-- ----------------------------------------------------------------------------
IF OBJECT_ID('dbo.TrackingTokens', 'U') IS NULL
CREATE TABLE dbo.TrackingTokens (
    Token           VARCHAR(40) PRIMARY KEY,       -- UUID-ish
    StopId          INT NOT NULL FOREIGN KEY REFERENCES dbo.DeliveryStops(StopId),
    ExpiresAt       DATETIME2 NOT NULL,            -- usually end-of-day + 24h
    LastViewedAt    DATETIME2 NULL,
    ViewCount       INT NOT NULL DEFAULT 0,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_TrackingTokens_Stop ON dbo.TrackingTokens(StopId);
CREATE INDEX IX_TrackingTokens_Expires ON dbo.TrackingTokens(ExpiresAt);
GO

-- ----------------------------------------------------------------------------
-- Alert subscriptions - who gets notified about what
-- ----------------------------------------------------------------------------
IF OBJECT_ID('dbo.AlertSubscriptions', 'U') IS NULL
CREATE TABLE dbo.AlertSubscriptions (
    SubscriptionId  INT IDENTITY(1,1) PRIMARY KEY,
    UserId          INT NOT NULL FOREIGN KEY REFERENCES dbo.Users(UserId),
    EventType       VARCHAR(50) NOT NULL,         -- STOP_FAILED | SEVERITY_HIGH_FAILURE | DAILY_DIGEST | ...
    Channel         VARCHAR(20) NOT NULL,         -- EMAIL | SMS | IN_APP
    Config          NVARCHAR(500) NULL,           -- JSON: filters, etc.
    IsActive        BIT NOT NULL DEFAULT 1,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_AlertSub UNIQUE (UserId, EventType, Channel)
);
GO

-- ----------------------------------------------------------------------------
-- Sent notifications log (audit + dedup)
-- ----------------------------------------------------------------------------
IF OBJECT_ID('dbo.NotificationLog', 'U') IS NULL
CREATE TABLE dbo.NotificationLog (
    LogId           BIGINT IDENTITY(1,1) PRIMARY KEY,
    EventType       VARCHAR(50) NOT NULL,
    Channel         VARCHAR(20) NOT NULL,
    Recipient       NVARCHAR(200) NOT NULL,       -- email or phone
    Subject         NVARCHAR(500) NULL,
    Body            NVARCHAR(MAX) NULL,
    RelatedEntityType VARCHAR(50) NULL,
    RelatedEntityId INT NULL,
    Status          VARCHAR(20) NOT NULL,         -- QUEUED | SENT | FAILED
    ErrorMessage    NVARCHAR(500) NULL,
    SentAt          DATETIME2 NULL,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_NotificationLog_Entity ON dbo.NotificationLog(RelatedEntityType, RelatedEntityId);
CREATE INDEX IX_NotificationLog_CreatedAt ON dbo.NotificationLog(CreatedAt DESC);
GO

-- ----------------------------------------------------------------------------
-- Extend Users table with email config (if columns don't exist)
-- ----------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Users') AND name = 'Phone')
    ALTER TABLE dbo.Users ADD Phone VARCHAR(20) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Users') AND name = 'PreferredLanguage')
    ALTER TABLE dbo.Users ADD PreferredLanguage VARCHAR(5) NOT NULL DEFAULT 'he';
GO

PRINT 'Migration 004 applied: failures, tracking, alerts';
GO
