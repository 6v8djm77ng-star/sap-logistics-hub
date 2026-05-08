-- ============================================================================
-- Migration 007: Time windows for addresses + phone numbers for SMS
-- ----------------------------------------------------------------------------
-- Critical for retail chains: shop only receives goods 9:00-11:00, etc.
-- Auto-planner should respect these windows; driver UI should warn.
-- ============================================================================
USE SAP_Logistics_Hub;
GO

-- Time windows on normalized addresses (can have multiple, e.g. morning + evening)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.NormalizedAddresses') AND name = 'DeliveryWindowStart')
BEGIN
    ALTER TABLE dbo.NormalizedAddresses ADD
        DeliveryWindowStart TIME NULL,           -- e.g. 09:00
        DeliveryWindowEnd   TIME NULL,           -- e.g. 11:00
        DeliveryDays        VARCHAR(20) NULL,    -- e.g. 'MON,TUE,WED,THU,FRI' (or NULL = all days)
        ContactPhone        VARCHAR(20) NULL,    -- for SMS notifications
        ContactName         NVARCHAR(100) NULL,
        DeliveryNotes       NVARCHAR(500) NULL;  -- free-form: "enter from back", "ring bell"
END
GO

-- Track SMS opt-in per address (GDPR-friendly)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.NormalizedAddresses') AND name = 'SmsOptIn')
    ALTER TABLE dbo.NormalizedAddresses ADD SmsOptIn BIT NOT NULL DEFAULT 1;
GO

-- Track Email opt-in (for PoD emails)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.NormalizedAddresses') AND name = 'ContactEmail')
    ALTER TABLE dbo.NormalizedAddresses ADD
        ContactEmail VARCHAR(100) NULL,
        EmailOptIn   BIT NOT NULL DEFAULT 1;
GO

PRINT 'Migration 007 applied: time windows, phone, email';
GO
