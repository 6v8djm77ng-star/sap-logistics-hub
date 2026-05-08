-- ============================================================================
-- SAP Logistics Hub - Initial Database Schema
-- Target: SQL Server 2019+
-- ============================================================================
-- This schema stores the logistics layer only.
-- SAP B1 remains the source of truth for orders, invoices, customers, items.
-- We reference SAP entities by DocEntry + CompanyDB (Company A / Company B).
-- ============================================================================

IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'SAP_Logistics_Hub')
    CREATE DATABASE SAP_Logistics_Hub;
GO

USE SAP_Logistics_Hub;
GO

-- ============================================================================
-- Companies (the 2 ח.פ entities)
-- ============================================================================
IF OBJECT_ID('dbo.Companies', 'U') IS NULL
CREATE TABLE dbo.Companies (
    CompanyId         INT IDENTITY(1,1) PRIMARY KEY,
    Code              VARCHAR(10)  NOT NULL UNIQUE, -- 'A' / 'B'
    Name              NVARCHAR(200) NOT NULL,
    SapCompanyDb      NVARCHAR(100) NOT NULL,       -- e.g. SBO_COMPANY_A
    TaxId             VARCHAR(20)   NULL,           -- ח.פ
    IsActive          BIT NOT NULL DEFAULT 1,
    CreatedAt         DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- ============================================================================
-- Distribution Zones (7 fixed zones)
-- ============================================================================
IF OBJECT_ID('dbo.Zones', 'U') IS NULL
CREATE TABLE dbo.Zones (
    ZoneId           INT IDENTITY(1,1) PRIMARY KEY,
    Code             VARCHAR(20) NOT NULL UNIQUE, -- e.g. 'NORTH', 'CENTER', 'SOUTH-1'
    Name             NVARCHAR(100) NOT NULL,      -- שם בעברית
    Description      NVARCHAR(500) NULL,
    ColorHex         VARCHAR(7) NULL,             -- לצבע על מפה
    SortOrder        INT NOT NULL DEFAULT 0,
    IsActive         BIT NOT NULL DEFAULT 1,
    CreatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- ============================================================================
-- Drivers
-- ============================================================================
IF OBJECT_ID('dbo.Drivers', 'U') IS NULL
CREATE TABLE dbo.Drivers (
    DriverId         INT IDENTITY(1,1) PRIMARY KEY,
    Code             VARCHAR(20) NOT NULL UNIQUE,
    FullName         NVARCHAR(100) NOT NULL,
    Phone            VARCHAR(20) NULL,
    Email            VARCHAR(100) NULL,
    VehiclePlate     VARCHAR(20) NULL,
    VehicleCapacity  INT NULL,                    -- כמות עצירות מקסימלית
    IsActive         BIT NOT NULL DEFAULT 1,
    -- For mobile app auth
    PasswordHash     VARCHAR(255) NULL,
    LastLoginAt      DATETIME2 NULL,
    CreatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- ============================================================================
-- Driver ↔ Zone default assignments (driver usually serves these zones)
-- ============================================================================
IF OBJECT_ID('dbo.DriverZones', 'U') IS NULL
CREATE TABLE dbo.DriverZones (
    DriverZoneId     INT IDENTITY(1,1) PRIMARY KEY,
    DriverId         INT NOT NULL FOREIGN KEY REFERENCES dbo.Drivers(DriverId),
    ZoneId           INT NOT NULL FOREIGN KEY REFERENCES dbo.Zones(ZoneId),
    Priority         INT NOT NULL DEFAULT 1,      -- 1 = primary zone
    CONSTRAINT UQ_DriverZones UNIQUE (DriverId, ZoneId)
);
GO

-- ============================================================================
-- Normalized Addresses (for unifying same-address customers across companies)
-- Key insight: same physical store may have different CardCode in each company.
-- We normalize by address and link back to SAP CardCodes.
-- ============================================================================
IF OBJECT_ID('dbo.NormalizedAddresses', 'U') IS NULL
CREATE TABLE dbo.NormalizedAddresses (
    AddressId        INT IDENTITY(1,1) PRIMARY KEY,
    NormalizedKey    VARCHAR(500) NOT NULL,       -- canonical form for matching
    Street           NVARCHAR(200) NULL,
    BuildingNumber   NVARCHAR(20) NULL,
    City             NVARCHAR(100) NULL,
    ZipCode          VARCHAR(20) NULL,
    Latitude         DECIMAL(10, 7) NULL,
    Longitude        DECIMAL(10, 7) NULL,
    ZoneId           INT NULL FOREIGN KEY REFERENCES dbo.Zones(ZoneId),
    BranchName       NVARCHAR(200) NULL,          -- שם סניף הלקוח
    Notes            NVARCHAR(1000) NULL,
    CreatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_NormalizedAddresses_Key ON dbo.NormalizedAddresses(NormalizedKey);
GO

-- ============================================================================
-- Link between SAP CardCode and our NormalizedAddress
-- Same physical location can have 2 CardCodes (one per company) pointing
-- to the same AddressId.
-- ============================================================================
IF OBJECT_ID('dbo.CustomerAddressLinks', 'U') IS NULL
CREATE TABLE dbo.CustomerAddressLinks (
    LinkId           INT IDENTITY(1,1) PRIMARY KEY,
    CompanyId        INT NOT NULL FOREIGN KEY REFERENCES dbo.Companies(CompanyId),
    SapCardCode      VARCHAR(50) NOT NULL,       -- SAP OCRD.CardCode
    SapAddressName   NVARCHAR(100) NULL,         -- SAP CRD1.Address (ship-to)
    AddressId        INT NOT NULL FOREIGN KEY REFERENCES dbo.NormalizedAddresses(AddressId),
    CreatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_CustomerAddressLinks UNIQUE (CompanyId, SapCardCode, SapAddressName)
);
GO

-- ============================================================================
-- Delivery Runs (the central entity - unified delivery plan per day)
-- ============================================================================
IF OBJECT_ID('dbo.DeliveryRuns', 'U') IS NULL
CREATE TABLE dbo.DeliveryRuns (
    RunId            INT IDENTITY(1,1) PRIMARY KEY,
    RunNumber        VARCHAR(50) NOT NULL UNIQUE, -- human-friendly: RUN-2026-04-23-01
    RunDate          DATE NOT NULL,
    ZoneId           INT NOT NULL FOREIGN KEY REFERENCES dbo.Zones(ZoneId),
    DriverId         INT NULL FOREIGN KEY REFERENCES dbo.Drivers(DriverId),
    Status           VARCHAR(20) NOT NULL DEFAULT 'OPEN', -- OPEN | PLANNED | PICKING | LOADED | IN_TRANSIT | COMPLETED | CANCELLED
    PlannedStartTime DATETIME2 NULL,
    ActualStartTime  DATETIME2 NULL,
    ActualEndTime    DATETIME2 NULL,
    Notes            NVARCHAR(1000) NULL,
    CreatedBy        INT NULL,                   -- user who created
    CreatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_DeliveryRuns_Date_Zone ON dbo.DeliveryRuns(RunDate, ZoneId);
CREATE INDEX IX_DeliveryRuns_Status ON dbo.DeliveryRuns(Status);
GO

-- ============================================================================
-- Stops - each stop in a run (one per destination address)
-- One stop can aggregate multiple orders from both companies
-- ============================================================================
IF OBJECT_ID('dbo.DeliveryStops', 'U') IS NULL
CREATE TABLE dbo.DeliveryStops (
    StopId           INT IDENTITY(1,1) PRIMARY KEY,
    RunId            INT NOT NULL FOREIGN KEY REFERENCES dbo.DeliveryRuns(RunId) ON DELETE CASCADE,
    AddressId        INT NOT NULL FOREIGN KEY REFERENCES dbo.NormalizedAddresses(AddressId),
    StopOrder        INT NOT NULL DEFAULT 0,     -- sequence in the run
    Status           VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING | ARRIVED | DELIVERED | PARTIAL | FAILED | SKIPPED
    ArrivedAt        DATETIME2 NULL,
    CompletedAt     DATETIME2 NULL,
    SignatureUrl     VARCHAR(500) NULL,          -- customer signature (mobile)
    PhotoUrl         VARCHAR(500) NULL,
    Notes            NVARCHAR(1000) NULL,
    CreatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_DeliveryStops_Run ON dbo.DeliveryStops(RunId, StopOrder);
GO

-- ============================================================================
-- RunOrders - links between a Stop and SAP Sales Orders
-- Each row = one SAP order (from Company A or B) assigned to a stop
-- ============================================================================
IF OBJECT_ID('dbo.RunOrders', 'U') IS NULL
CREATE TABLE dbo.RunOrders (
    RunOrderId       INT IDENTITY(1,1) PRIMARY KEY,
    StopId           INT NOT NULL FOREIGN KEY REFERENCES dbo.DeliveryStops(StopId) ON DELETE CASCADE,
    CompanyId        INT NOT NULL FOREIGN KEY REFERENCES dbo.Companies(CompanyId),
    SapDocEntry      INT NOT NULL,               -- ORDR.DocEntry (Sales Order)
    SapDocNum        INT NOT NULL,               -- ORDR.DocNum
    SapCardCode      VARCHAR(50) NOT NULL,
    SapCardName      NVARCHAR(200) NULL,
    OrderTotal       DECIMAL(18,2) NULL,
    LinesCount       INT NULL,
    Status           VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING | PICKED | DELIVERED | RETURNED | CANCELLED
    -- When delivered, we create SAP Delivery Note and store its DocEntry
    SapDeliveryDocEntry INT NULL,
    AddedAt          DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_RunOrders UNIQUE (CompanyId, SapDocEntry)
);
GO
CREATE INDEX IX_RunOrders_Stop ON dbo.RunOrders(StopId);
GO

-- ============================================================================
-- Return Requests (Reverse Logistics) - customer-initiated returns
-- These become SAP "Return Request" documents after pickup
-- ============================================================================
IF OBJECT_ID('dbo.ReturnRequests', 'U') IS NULL
CREATE TABLE dbo.ReturnRequests (
    ReturnId         INT IDENTITY(1,1) PRIMARY KEY,
    ReturnNumber     VARCHAR(50) NOT NULL UNIQUE, -- RET-2026-04-23-001
    CompanyId        INT NOT NULL FOREIGN KEY REFERENCES dbo.Companies(CompanyId),
    SapCardCode      VARCHAR(50) NOT NULL,
    SapCardName      NVARCHAR(200) NULL,
    AddressId        INT NOT NULL FOREIGN KEY REFERENCES dbo.NormalizedAddresses(AddressId),
    RequestedDate    DATE NOT NULL,
    StopId           INT NULL FOREIGN KEY REFERENCES dbo.DeliveryStops(StopId), -- null until assigned to a run
    Reason           NVARCHAR(500) NULL,
    Status           VARCHAR(20) NOT NULL DEFAULT 'OPEN', -- OPEN | ASSIGNED | PICKED_UP | COMPLETED | CANCELLED
    -- After pickup & processed in SAP
    SapReturnRequestDocEntry INT NULL,
    SapReturnDocEntry INT NULL,
    Notes            NVARCHAR(1000) NULL,
    CreatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_ReturnRequests_Status ON dbo.ReturnRequests(Status);
CREATE INDEX IX_ReturnRequests_Stop ON dbo.ReturnRequests(StopId);
GO

-- ============================================================================
-- Return Request Lines - items to pick up
-- ============================================================================
IF OBJECT_ID('dbo.ReturnRequestLines', 'U') IS NULL
CREATE TABLE dbo.ReturnRequestLines (
    ReturnLineId     INT IDENTITY(1,1) PRIMARY KEY,
    ReturnId         INT NOT NULL FOREIGN KEY REFERENCES dbo.ReturnRequests(ReturnId) ON DELETE CASCADE,
    SapItemCode      VARCHAR(50) NOT NULL,        -- OITM.ItemCode
    SapItemName      NVARCHAR(200) NULL,
    Quantity         DECIMAL(18,3) NOT NULL,
    ActualQuantity   DECIMAL(18,3) NULL,          -- what driver actually picked up
    ReasonCode       VARCHAR(50) NULL,            -- DAMAGED | WRONG_ITEM | EXPIRED | OTHER
    ReasonText       NVARCHAR(500) NULL
);
GO

-- ============================================================================
-- Wave Picking - picking lists per delivery run
-- Aggregates items needed across both companies for one run
-- ============================================================================
IF OBJECT_ID('dbo.PickingWaves', 'U') IS NULL
CREATE TABLE dbo.PickingWaves (
    WaveId           INT IDENTITY(1,1) PRIMARY KEY,
    WaveNumber       VARCHAR(50) NOT NULL UNIQUE,
    RunId            INT NOT NULL FOREIGN KEY REFERENCES dbo.DeliveryRuns(RunId),
    Status           VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING | IN_PROGRESS | COMPLETED
    PickedBy         INT NULL,                   -- user id (warehouse worker)
    StartedAt        DATETIME2 NULL,
    CompletedAt      DATETIME2 NULL,
    CreatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- ============================================================================
-- Wave Lines - actual items to pick (aggregated by item across stops)
-- ============================================================================
IF OBJECT_ID('dbo.PickingWaveLines', 'U') IS NULL
CREATE TABLE dbo.PickingWaveLines (
    WaveLineId       INT IDENTITY(1,1) PRIMARY KEY,
    WaveId           INT NOT NULL FOREIGN KEY REFERENCES dbo.PickingWaves(WaveId) ON DELETE CASCADE,
    SapItemCode      VARCHAR(50) NOT NULL,
    SapItemName      NVARCHAR(200) NULL,
    TotalQuantity    DECIMAL(18,3) NOT NULL,     -- total to pick across all stops in run
    PickedQuantity   DECIMAL(18,3) NOT NULL DEFAULT 0,
    BinLocation      NVARCHAR(50) NULL,          -- מיקום במחסן
    Status           VARCHAR(20) NOT NULL DEFAULT 'PENDING' -- PENDING | PARTIAL | COMPLETED | SHORTAGE
);
GO
CREATE INDEX IX_PickingWaveLines_Wave ON dbo.PickingWaveLines(WaveId);
GO

-- ============================================================================
-- Wave Allocations - which order/stop each picked item goes to
-- Critical for: picker aggregates, but we still know which unit belongs to
-- which company/order (accounting separation!)
-- ============================================================================
IF OBJECT_ID('dbo.PickingAllocations', 'U') IS NULL
CREATE TABLE dbo.PickingAllocations (
    AllocationId     INT IDENTITY(1,1) PRIMARY KEY,
    WaveLineId       INT NOT NULL FOREIGN KEY REFERENCES dbo.PickingWaveLines(WaveLineId) ON DELETE CASCADE,
    RunOrderId       INT NOT NULL FOREIGN KEY REFERENCES dbo.RunOrders(RunOrderId),
    SapOrderLineNum  INT NOT NULL,               -- RDR1.LineNum
    Quantity         DECIMAL(18,3) NOT NULL
);
GO

-- ============================================================================
-- Users (for the logistics hub UI - planner, warehouse, admin)
-- ============================================================================
IF OBJECT_ID('dbo.Users', 'U') IS NULL
CREATE TABLE dbo.Users (
    UserId           INT IDENTITY(1,1) PRIMARY KEY,
    Username         VARCHAR(50) NOT NULL UNIQUE,
    FullName         NVARCHAR(100) NOT NULL,
    Email            VARCHAR(100) NULL,
    PasswordHash     VARCHAR(255) NOT NULL,
    Role             VARCHAR(20) NOT NULL,       -- ADMIN | PLANNER | WAREHOUSE | DRIVER | VIEWER
    IsActive         BIT NOT NULL DEFAULT 1,
    LastLoginAt      DATETIME2 NULL,
    CreatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- ============================================================================
-- Audit Log - track all changes (since system is real-time and dynamic)
-- ============================================================================
IF OBJECT_ID('dbo.AuditLog', 'U') IS NULL
CREATE TABLE dbo.AuditLog (
    AuditId          BIGINT IDENTITY(1,1) PRIMARY KEY,
    EntityType       VARCHAR(50) NOT NULL,       -- DeliveryRun | Stop | Return | ...
    EntityId         INT NOT NULL,
    Action           VARCHAR(20) NOT NULL,       -- CREATE | UPDATE | DELETE | STATUS_CHANGE
    UserId           INT NULL,
    OldValue         NVARCHAR(MAX) NULL,         -- JSON
    NewValue         NVARCHAR(MAX) NULL,         -- JSON
    CreatedAt        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_AuditLog_Entity ON dbo.AuditLog(EntityType, EntityId);
CREATE INDEX IX_AuditLog_CreatedAt ON dbo.AuditLog(CreatedAt);
GO

PRINT 'SAP Logistics Hub schema created successfully';
GO
