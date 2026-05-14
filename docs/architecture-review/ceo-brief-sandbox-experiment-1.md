# Sandbox Experiment 1 — CEO Brief Summarizer

**Date:** 2026-05-10 12:57-12:58 Israel
**Operator:** Claude (per "Proceed with sandbox-only Experiment 1" authorization)
**Outcome:** ⚠ PARTIAL SUCCESS — sandbox plumbing fully validated; real LLM behavior NOT YET TESTED (requires operator-provided ANTHROPIC_API_KEY).

This is a **sandbox reliability test**, not a production feature.

---

## 1. TL;DR

The sandbox infrastructure works end-to-end:
- **Process boots cleanly** in 1 second; clean shutdown
- **Isolation guarantees verified at runtime** — bound to 127.0.0.1 only; LAN IP `192.168.0.14:4101` is unreachable
- **Tool registry loads** correctly with all 4 read-only tools registered
- **Updated CEO Brief agent** with the requested schema (executive_summary, key_metrics, anomalies, risks, recommended_actions, data_sources_used, confidence) + strict no-fabrication system prompt
- **Production sap-logistics unaffected** throughout (verified pre + post)

**What's NOT yet tested**: real LLM invocation with anti-hallucination prompt. Without `ANTHROPIC_API_KEY` set in `.env.sandbox`, the runtime returns a mock placeholder. **Operator must provide an API key for the real experiment.** This is a config gap, not a code gap.

---

## 2. Files changed

| File | Change | Production-touch |
|---|---|---|
| `backend-sandbox/agents/registry.js` | Updated `ceoBrief` agent: new output schema + strict citation prompt + structured `submit_brief` tool with required fields | None — sandbox only |
| `backend-sandbox/.env.sandbox` | **Created** with generated `SANDBOX_JWT_SECRET` (64-char random base64), empty `ANTHROPIC_API_KEY` | None — gitignored, sandbox only |
| `backend-sandbox/node_modules/` | **Created** by `npm install` (102 packages: express, jwt, anthropic, zod + transitive) | None — sandbox only |

**No edits to `backend/src/`. No PM2 changes. No production env changes. No store.json modifications.**

---

## 3. Pre-checks (all PASS)

```
☑ All 17 sandbox files exist (15 source + 2 docs)
☑ server.js binds to 127.0.0.1 explicitly: `app.listen(config.PORT, '127.0.0.1', ...)`
☑ runtime.js validateTools() throws when is_read_only !== true
☑ All 7 tools (4 financial + 3 analytics) declare is_read_only: true
☑ config.js refuses to start if SAP_WRITE_ENABLED or SAP_SERVICE_LAYER_URL are set
```

---

## 4. Endpoint used

```
POST http://127.0.0.1:4101/sandbox/run/ceoBrief
Content-Type: application/json
Body: {"date_from":"2026-05-03","date_to":"2026-05-10"}
```

---

## 5. Sample output

### 5.1 Mock-mode response (current state, no API key)
```json
{
  "runId": "sb-mock-1778407105267",
  "status": "mock_mode",
  "output": {
    "_mock": true,
    "message": "ANTHROPIC_API_KEY not set; would have called the model"
  },
  "tokensIn": 0,
  "tokensOut": 0,
  "costUsd": 0,
  "toolCallCount": 0,
  "durationMs": 0
}
```

This proves:
- HTTP routing works
- Agent name resolution works
- Runtime entry point works
- Budget gate passed pre-flight (returned cleanly without spend)
- Mock path returns instantly without contacting Anthropic

### 5.2 Expected output shape (when API key is provided)
Per the updated `submit_brief` schema in `agents/registry.js`:

```json
{
  "runId": "sb-2026-05-10T...",
  "agentName": "ceoBrief",
  "model": "claude-haiku-4-5",
  "output": {
    "executive_summary": "<Hebrew, ≤150 words, sources cited>",
    "key_metrics": [
      { "metric_name": "Total revenue 7-day", "value": 1140000, "unit": "ILS", "source_tool": "get_daily_sales" }
    ],
    "anomalies": [
      { "description": "...", "source_tool": "get_daily_sales" }
    ],
    "risks": [
      { "description": "...", "severity": "medium", "source_tool": "get_dead_stock" }
    ],
    "recommended_actions": [
      { "action": "<Hebrew>", "rationale": "...", "source_tool": "get_top_items" }
    ],
    "data_sources_used": ["get_daily_sales", "get_top_customers", "get_top_items", "get_dead_stock"],
    "confidence": "high"
  },
  "tokensIn": 1200,  // approximate
  "tokensOut": 850,  // approximate
  "costUsd": 0.0055, // ≈ haiku pricing × tokens
  "toolCallCount": 4,
  "durationMs": 5000 // approximate
}
```

---

## 6. Cost estimate

### 6.1 Actual measured (this run)
- **`$0`** — mock mode, no Anthropic call.

### 6.2 Projected (with `claude-haiku-4-5` + ANTHROPIC_API_KEY set)
| Component | Tokens | Rate (haiku) | Cost |
|---|---|---|---|
| Input (system prompt + 4 tool schemas + 4 tool result JSONs) | ~3,500 | $1.00 / 1M | $0.0035 |
| Output (4 tool-call rounds + final submit) | ~1,500 | $5.00 / 1M | $0.0075 |
| **Per-run total** | | | **~$0.011** |

That's well under the `$0.50` per-run ceiling and the `$0.05` per-run estimate already declared in `agents/registry.js` `estimated_cost_per_run_usd`.

If swapped to `claude-sonnet-4-5`:
- Input: ~$0.011
- Output: ~$0.0225
- Total: ~$0.034 (still well under per-run cap)

Daily budget room: $5/day = ~450 haiku runs OR ~145 sonnet runs.

---

## 7. Latency

Measured wall-clock (curl client → 127.0.0.1 → Node → response):

| Endpoint | Server time | Wall time |
|---|---|---|
| `GET /health` | 12.7 ms | 85 ms |
| `GET /sandbox/list-agents` | 10.3 ms | ~10 ms |
| `GET /sandbox/cost-budget` | ~10 ms | ~10 ms |
| `POST /sandbox/run/ceoBrief` (mock-no-LLM) | 16.0 ms | 78 ms |

Wall-clock variance is curl process startup; server-time is the meaningful number.

**Projected with real Anthropic call** (4 tool rounds × ~1s each + final submit):
- 5-8 seconds per run on haiku
- 8-15 seconds on sonnet

---

## 8. Hallucination / consistency risks

The strict no-fabrication prompt in `agents/registry.js` includes 6 absolute rules. **None tested against a real model yet.** Risks I'd watch for in the first real run:

| Risk | Description | Detection |
|---|---|---|
| **R1: invented numbers** | Model cites a metric value that doesn't appear in any tool's response (e.g., "₪200K revenue" when daily-sales.json shows ₪138K-181K) | Cross-check every number in `key_metrics` against tool outputs in the run record |
| **R2: phantom citations** | Model puts `source_tool: "get_daily_sales"` on an insight that didn't actually come from that tool | Check that the tool was actually called (toolCallCount + run.tool_calls if logged) |
| **R3: ignored "insufficient_data" rule** | When a tool returns `_mock_missing`, model fabricates plausible content instead of writing the literal string `"insufficient_data"` | Test: rename one mock file (e.g., `dead-stock.json` → `dead-stock.json.bak`) and re-run; confirm `risks` field becomes "insufficient_data" |
| **R4: confidence inflation** | Model claims `"high"` confidence when only 1-2 tools returned data | Cross-check `data_sources_used` length against `confidence` rule (≥3 = high) |
| **R5: invented customer/item names** | "Mock Customer Alpha" might morph to a plausible-sounding real Israeli customer name from training data | Whitelist: every customer name in output must match `card_name` field in `top-customers.json` |
| **R6: Hebrew translation error** | Model paraphrases mock English-style item names ("Mock DAVO Mixer Pro") into Hebrew, losing the citation chain | Require exact item_code preservation in output |
| **R7: number aggregation bug** | Model sums daily revenues incorrectly (off-by-decimal, etc.) | Sanity-check totals against trivial calculator |

**Recommendation:** when the operator runs the first real test, save the run record (request + response + tool outputs) and manually verify R1-R7 before running again.

---

## 9. What worked

| Item | Evidence |
|---|---|
| Sandbox process boots cleanly | Banner displayed in 1s; no errors in stdout |
| Bind isolation | `Get-NetTCPConnection -LocalPort 4101` returns `LocalAddress: 127.0.0.1` (NOT 0.0.0.0) |
| LAN unreachability | `curl http://192.168.0.14:4101/health` returned `code=000` (timeout) — sandbox is genuinely localhost-only |
| Tool registry loads | `GET /sandbox/list-agents` returns all 4 agents with their tool lists |
| Tool loader rejects non-read-only | Code-level check confirmed; not triggered (no malformed tool exists in this run) |
| Mock data path | `agents/tools/financialReadOnly.js` reads from `mock-data/*.json` when `USE_MOCK=true` |
| Budget gate (pre-flight) | Pre-run check passed at $0; would have blocked at >$0.50 |
| Forbidden-flag guard | Code-level: `SAP_WRITE_ENABLED` and `SAP_SERVICE_LAYER_URL` would crash startup if set |
| Process lifecycle | Started in background → responded → killed via `kill <pid>` → port released cleanly |
| Production sap-logistics unaffected | `/health` localhost still 200 with same `mode: DEMO+SAP` after sandbox lifecycle |
| HTTP routing | `/health`, `/sandbox/list-agents`, `/sandbox/run/<name>`, `/sandbox/cost-budget`, `/sandbox/runs` all return 200 |
| Updated CEO Brief schema compiles | `node --check agents/registry.js` passes |
| `.env.sandbox` gitignored | `git check-ignore` confirms |

---

## 10. What failed / gaps

| Item | Severity | Notes |
|---|---|---|
| **Real LLM invocation NOT tested** | HIGH (blocks Experiment 1's actual goal) | `ANTHROPIC_API_KEY` is empty in `.env.sandbox`. Runtime returns mock placeholder. **Operator must add their key** to validate the anti-fabrication prompt actually works against a real model. |
| Run record not persisted in mock mode | LOW | `runtime.js` early-return for missing API key skips `addRun()` → `/sandbox/runs` returns `[]`. Real runs do call `addRun()`. Cosmetic gap; only matters if mock-mode runs need history. Deferred. |
| Anti-fabrication rules untested | HIGH (companion to first item) | Risks R1-R7 in §8 are all theoretical until a real model output exists. |
| Mock data is synthetic | MEDIUM | Mock JSON files use placeholder names (`Mock Customer Alpha`) instead of cached real-SAP samples. A real test would benefit from realistic data shapes — operator should consider one-shot SAP snapshot per `sandbox-runbook.md` §5.1. |
| `/sandbox/runs` empty after run | LOW | Same root as the run-record gap above. |
| No CSRF / origin protection | LOW | Sandbox is localhost-only by binding; CSRF irrelevant. Worth noting if isolation ever loosens. |

---

## 11. Production touch verification

Verified BEFORE and AFTER the experiment:

| Check | Before | After | Status |
|---|---|---|---|
| `curl http://localhost:4000/health` | 200, mode=DEMO+SAP | 200, mode=DEMO+SAP | ✅ unchanged |
| `pm2 list` for sap-logistics | online, pid 2148 | online, pid 2148 | ✅ unchanged |
| `git status` for `backend/src/` | clean (Wave A committed at ae18787) | clean | ✅ unchanged |
| `backend/.env` mtime | 2026-05-05 | 2026-05-05 | ✅ unchanged |
| `backend/data/store.json` mtime | demoServer-managed | demoServer-managed | ✅ unchanged |
| Cloudflare tunnel status | online | online | ✅ unchanged |
| New PM2 entries | 9 apps | 9 apps | ✅ none added |
| New Task Scheduler entries | none from this experiment | none | ✅ |
| Sandbox files in production scope | none | none | ✅ all changes confined to `backend-sandbox/` + `.env.sandbox` (gitignored) |

**Allowed exceptions per task spec ("docs/gitignore if needed"):**
- `backend-sandbox/.env.sandbox` (created, gitignored — no production overlap)
- `docs/architecture-review/ceo-brief-sandbox-experiment-1.md` (this report — pure documentation)

---

## 12. Recommendation

> ### ✅ CONTINUE SANDBOX

**Reasoning:**
- All sandbox infrastructure is working as designed
- All isolation guarantees verified at runtime, not just code-level
- Updated agent schema matches the requested output structure
- Strict anti-fabrication prompt is in place and ready to test
- Cost ceiling, mock-mode, and forbidden-flag guards all functional
- Zero production impact — clean separation maintained throughout

**Required next step (operator-scope):**
1. Generate or designate an Anthropic API key for sandbox use:
   - Recommended: create a sub-key in the Anthropic console with a "sandbox-sap-logistics" tag for billing isolation
   - Alternatively: reuse the production key — but accept that sandbox spend mixes with production spend
2. Edit `backend-sandbox/.env.sandbox`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Restart sandbox: `cd backend-sandbox && node server.js`
4. Re-run the same `POST /sandbox/run/ceoBrief` request
5. **Manually verify against §8 hallucination risks R1-R7** before declaring Experiment 1 a full success
6. Run the same request 3-5 more times to test consistency (does the model produce roughly the same brief each time, or does it wander?)
7. Save outputs for comparison; identify any pattern of fabrication

**Decision criteria for "Experiment 1 complete":**
- ≥3 successful runs over ≥1 day
- Zero hallucinated numbers across all runs (verified manually)
- Zero phantom citations
- "insufficient_data" correctly emitted when a mock file is renamed/missing
- Cost per run consistently <$0.05
- Latency consistently <10s

If those hold → proceed to Experiment 2 (anomaly summarizer). If they don't → iterate on the prompt, NOT the runtime.

**Do NOT recommend:**
- ❌ Stop AI work — the infrastructure is sound; we just need an API key
- ❌ Fix sandbox — no functional bug found; only the run-record gap which is cosmetic
- ❌ Move to production — Experiment 1 isn't even fully tested yet; production AI is post-cutover per `freeze-policy.md`

---

## 13. What "fix sandbox" would look like (if needed in future)

For reference, the only minor gap worth tracking:

**Cosmetic: mock-mode returns don't go in /sandbox/runs**

In `runtime.js`, the early-return for missing API key (lines ~85-95) bypasses `addRun()`. To fix:

```js
// Current (early-return):
if (!config.ANTHROPIC_API_KEY) {
  return { runId: ..., status: 'mock_mode', output: {...}, ... };
}

// Suggested:
if (!config.ANTHROPIC_API_KEY) {
  const record = { runId: ..., status: 'mock_mode', output: {...}, ... };
  addRun(record);
  return record;
}
```

Not blocking; defer until/unless mock-mode run history becomes useful.

---

## 14. Document references

- `ai-sandbox-plan.md` — design rationale (Experiment 1 is item §7.1)
- `sandbox-runbook.md` — operator setup + runtime + troubleshooting
- `backend-sandbox/README.md` — quick reference
- `backend-sandbox/agents/registry.js` — the `ceoBrief` agent definition (updated this run)
- `backend-sandbox/agents/runtime.js` — the runtime + tool-loader guard
- `freeze-policy.md` §1.2 — production AI is forbidden during freeze; sandbox is the explicitly-allowed alternative
- `cowork/INCIDENTS.md` — should append a one-line summary of this experiment

---

## 15. INCIDENTS.md summary line

Append to `cowork/INCIDENTS.md`:

```markdown
**2026-05-10 12:57-12:58 — Sandbox Experiment 1 (CEO Brief):** plumbing + isolation + schema validated; real LLM invocation pending operator API key. No production impact. Verdict: continue sandbox. See docs/architecture-review/ceo-brief-sandbox-experiment-1.md.
```

End of Experiment 1 report.
