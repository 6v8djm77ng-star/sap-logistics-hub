-- Migration 008: AgentRuns + AgentToolCalls
-- Stores every LLM agent execution: messages, tool calls, output, tokens, cost.
-- Used for observability, debugging, and cost tracking.

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AgentRuns')
CREATE TABLE dbo.AgentRuns (
  RunId           INT IDENTITY(1,1) PRIMARY KEY,
  AgentName       VARCHAR(64)  NOT NULL,            -- 'ceo_brief', etc.
  TriggerType     VARCHAR(16)  NOT NULL,            -- 'manual' | 'scheduled'
  Status          VARCHAR(16)  NOT NULL,            -- 'running' | 'completed' | 'failed'
  Model           VARCHAR(64)  NOT NULL,
  StartedAt       DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME(),
  FinishedAt      DATETIME2    NULL,
  DurationMs      INT          NULL,
  TokensIn        INT          NULL,
  TokensOut       INT          NULL,
  CostUsd         DECIMAL(10,6) NULL,
  ToolCallCount   INT          NOT NULL DEFAULT 0,
  Output          NVARCHAR(MAX) NULL,               -- final structured JSON
  ErrorMessage    NVARCHAR(MAX) NULL,
  Messages        NVARCHAR(MAX) NULL,               -- full message history JSON
  CreatedBy       VARCHAR(64)  NULL                 -- userId or 'cron'
);

GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_AgentRuns_Agent_Started')
CREATE INDEX IX_AgentRuns_Agent_Started
  ON dbo.AgentRuns (AgentName, StartedAt DESC);

GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AgentToolCalls')
CREATE TABLE dbo.AgentToolCalls (
  ToolCallId      INT IDENTITY(1,1) PRIMARY KEY,
  RunId           INT          NOT NULL,
  Sequence        INT          NOT NULL,
  ToolName        VARCHAR(64)  NOT NULL,
  Input           NVARCHAR(MAX) NULL,
  Output          NVARCHAR(MAX) NULL,
  IsError         BIT          NOT NULL DEFAULT 0,
  DurationMs      INT          NULL,
  CreatedAt       DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_AgentToolCalls_Run FOREIGN KEY (RunId) REFERENCES dbo.AgentRuns(RunId) ON DELETE CASCADE
);

GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_AgentToolCalls_Run')
CREATE INDEX IX_AgentToolCalls_Run
  ON dbo.AgentToolCalls (RunId, Sequence);

GO
