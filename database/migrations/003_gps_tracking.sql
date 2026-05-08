-- ============================================================================
-- GPS Tracking for drivers
-- ============================================================================
USE SAP_Logistics_Hub;
GO

-- Current/last known position per driver (1 row per driver, updated in place)
IF OBJECT_ID('dbo.DriverLocations', 'U') IS NULL
CREATE TABLE dbo.DriverLocations (
    DriverId         INT PRIMARY KEY FOREIGN KEY REFERENCES dbo.Drivers(DriverId),
    RunId            INT NULL FOREIGN KEY REFERENCES dbo.DeliveryRuns(RunId),
    Latitude         DECIMAL(10, 7) NOT NULL,
    Longitude        DECIMAL(10, 7) NOT NULL,
    Accuracy         DECIMAL(8, 2) NULL,      -- meters
    Heading          DECIMAL(5, 2) NULL,      -- degrees
    SpeedKmh         DECIMAL(6, 2) NULL,
    BatteryLevel     DECIMAL(5, 2) NULL,      -- 0-100
    UpdatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- Historical breadcrumb trail (for audit / reviewing routes after the fact)
IF OBJECT_ID('dbo.DriverLocationHistory', 'U') IS NULL
CREATE TABLE dbo.DriverLocationHistory (
    HistoryId        BIGINT IDENTITY(1,1) PRIMARY KEY,
    DriverId         INT NOT NULL FOREIGN KEY REFERENCES dbo.Drivers(DriverId),
    RunId            INT NULL,
    Latitude         DECIMAL(10, 7) NOT NULL,
    Longitude        DECIMAL(10, 7) NOT NULL,
    Accuracy         DECIMAL(8, 2) NULL,
    SpeedKmh         DECIMAL(6, 2) NULL,
    RecordedAt       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_DriverLocationHistory_Driver_Time
  ON dbo.DriverLocationHistory(DriverId, RecordedAt DESC);
GO

-- Failed SAP operations queue (for background retry)
IF OBJECT_ID('dbo.SapRetryQueue', 'U') IS NULL
CREATE TABLE dbo.SapRetryQueue (
    QueueId          BIGINT IDENTITY(1,1) PRIMARY KEY,
    Operation        VARCHAR(50) NOT NULL,    -- CREATE_DELIVERY | CREATE_RETURN | ...
    EntityType       VARCHAR(50) NOT NULL,    -- RunOrder | ReturnRequest
    EntityId         INT NOT NULL,
    CompanyCode      VARCHAR(10) NOT NULL,
    Payload          NVARCHAR(MAX) NULL,      -- JSON for context
    AttemptCount     INT NOT NULL DEFAULT 0,
    LastAttemptAt    DATETIME2 NULL,
    LastError        NVARCHAR(1000) NULL,
    NextAttemptAt    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    Status           VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING | SUCCESS | FAILED_PERMANENT
    CreatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_SapRetryQueue_Status_NextAttempt
  ON dbo.SapRetryQueue(Status, NextAttemptAt);
GO

PRINT 'GPS + Retry queue tables created';
GO
