/**
 * Persistence for agent runs and tool calls.
 * Backed by the Logistics DB (dbo.AgentRuns + dbo.AgentToolCalls).
 */
import * as db from '../db/logisticsDb.js';

export async function createRun({ agentName, triggerType, model, createdBy }) {
  const result = await db.execute(
    `INSERT INTO dbo.AgentRuns (AgentName, TriggerType, Status, Model, CreatedBy)
     OUTPUT INSERTED.RunId
     VALUES (@agentName, @triggerType, 'running', @model, @createdBy)`,
    { agentName, triggerType, model, createdBy: createdBy || null }
  );
  return result.recordset[0].RunId;
}

export async function recordToolCall(runId, sequence, toolName, input, output, isError, durationMs) {
  await db.execute(
    `INSERT INTO dbo.AgentToolCalls (RunId, Sequence, ToolName, Input, Output, IsError, DurationMs)
     VALUES (@runId, @sequence, @toolName, @input, @output, @isError, @durationMs)`,
    {
      runId,
      sequence,
      toolName,
      input: input != null ? JSON.stringify(input) : null,
      output: output != null ? JSON.stringify(output) : null,
      isError: isError ? 1 : 0,
      durationMs: durationMs ?? null,
    }
  );
}

export async function completeRun(runId, { tokensIn, tokensOut, costUsd, toolCallCount, output, messages, durationMs }) {
  await db.execute(
    `UPDATE dbo.AgentRuns
     SET Status        = 'completed',
         FinishedAt    = SYSUTCDATETIME(),
         DurationMs    = @durationMs,
         TokensIn      = @tokensIn,
         TokensOut     = @tokensOut,
         CostUsd       = @costUsd,
         ToolCallCount = @toolCallCount,
         Output        = @output,
         Messages      = @messages
     WHERE RunId = @runId`,
    {
      runId,
      durationMs: durationMs ?? null,
      tokensIn: tokensIn ?? null,
      tokensOut: tokensOut ?? null,
      costUsd: costUsd ?? null,
      toolCallCount: toolCallCount ?? 0,
      output: output != null ? JSON.stringify(output) : null,
      messages: messages != null ? JSON.stringify(messages) : null,
    }
  );
}

export async function failRun(runId, errorMessage, { tokensIn, tokensOut, costUsd, toolCallCount, messages, durationMs } = {}) {
  await db.execute(
    `UPDATE dbo.AgentRuns
     SET Status        = 'failed',
         FinishedAt    = SYSUTCDATETIME(),
         DurationMs    = @durationMs,
         TokensIn      = @tokensIn,
         TokensOut     = @tokensOut,
         CostUsd       = @costUsd,
         ToolCallCount = @toolCallCount,
         ErrorMessage  = @errorMessage,
         Messages      = @messages
     WHERE RunId = @runId`,
    {
      runId,
      durationMs: durationMs ?? null,
      tokensIn: tokensIn ?? null,
      tokensOut: tokensOut ?? null,
      costUsd: costUsd ?? null,
      toolCallCount: toolCallCount ?? 0,
      errorMessage: String(errorMessage || '').slice(0, 4000),
      messages: messages != null ? JSON.stringify(messages) : null,
    }
  );
}

export async function listRuns({ agentName, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const filter = agentName ? 'WHERE AgentName = @agentName' : '';
  return db.query(
    `SELECT TOP ${safeLimit}
       RunId, AgentName, TriggerType, Status, Model,
       StartedAt, FinishedAt, DurationMs,
       TokensIn, TokensOut, CostUsd, ToolCallCount,
       CreatedBy
     FROM dbo.AgentRuns
     ${filter}
     ORDER BY StartedAt DESC`,
    agentName ? { agentName } : {}
  );
}

export async function getRun(runId) {
  const run = await db.queryOne(
    `SELECT * FROM dbo.AgentRuns WHERE RunId = @runId`,
    { runId }
  );
  if (!run) return null;
  const toolCalls = await db.query(
    `SELECT ToolCallId, Sequence, ToolName, Input, Output, IsError, DurationMs, CreatedAt
     FROM dbo.AgentToolCalls
     WHERE RunId = @runId
     ORDER BY Sequence`,
    { runId }
  );
  // Parse stored JSON columns for convenience
  if (run.Output) try { run.Output = JSON.parse(run.Output); } catch { /* keep as string */ }
  if (run.Messages) try { run.Messages = JSON.parse(run.Messages); } catch { /* keep as string */ }
  for (const tc of toolCalls) {
    if (tc.Input)  try { tc.Input  = JSON.parse(tc.Input);  } catch { /* keep */ }
    if (tc.Output) try { tc.Output = JSON.parse(tc.Output); } catch { /* keep */ }
  }
  return { ...run, ToolCalls: toolCalls };
}
