# Pending Migrations — DO NOT RUN UNTIL BACKUP CONFIRMED

These 4 migration pairs (`009`, `010`, `011`, `012`) are prepared but **not yet applied** to any database.

| # | Forward                          | Rollback                | Purpose |
|---|----------------------------------|-------------------------|---------|
| 009 | `009_intelligence_events.sql`  | `009_rollback.sql`      | Cross-source event store with retention / DLQ / partition-ready indexing |
| 010 | `010_insights.sql`             | `010_rollback.sql`      | Synthesized intelligence outputs from agents |
| 011 | `011_alerts.sql`               | `011_rollback.sql`      | Alert dedup / throttle / aggregation / cooldown state |
| 012 | `012_ai_cost_budget.sql`       | `012_rollback.sql`      | Daily / hourly token + USD budget tracking |

## Pre-flight checklist (mandatory before any execution)

- [ ] `BACKUP DATABASE [SAP_Logistics_Hub] TO DISK='...'` taken with `WITH COMPRESSION, INIT`
- [ ] Backup file location documented and verified
- [ ] `RESTORE VERIFYONLY` passed against the .bak file
- [ ] Tested restore on a sandbox SQL Server (recommended for production DBs)
- [ ] PM2 reload plan ready (`pm2 reload sap-logistics`)
- [ ] `.env` updated with new flags (defaults — all `false`)
- [ ] `server.js` mount line ready to append (kept in `.disabled` form for now)

## Run order

Apply forward in numeric order:

1. `009_intelligence_events.sql` — foundational table; other migrations are independent of it but conventionally come first
2. `010_insights.sql`
3. `011_alerts.sql`
4. `012_ai_cost_budget.sql`

Each migration is wrapped in `IF NOT EXISTS` — re-running is a safe no-op.

## Rollback order

Reverse: `012_rollback → 011_rollback → 010_rollback → 009_rollback`.

Each rollback is wrapped in `IF EXISTS` — safe to run multiple times.

**Best path is RESTORE from .bak** if business-grade recovery is needed.

## Affected indexes

| Migration | New tables | New indexes |
|---|---|---|
| 009 | `dbo.IntelligenceEvents` | 8 |
| 010 | `dbo.Insights` | 7 |
| 011 | `dbo.Alerts` | 4 |
| 012 | `dbo.AiSpendBudget` | 2 (+1 unique constraint) |

## What these migrations do NOT do

- Do not modify any existing table (no `ALTER TABLE`)
- Do not add foreign keys to existing tables (loose coupling preferred)
- Do not change permissions or roles
- Do not seed data
- Do not create stored procedures, views, or triggers

## See also

- Repo root: `RUN_MIGRATIONS.md` (full execution guide)
- Code: `backend/src/lib/intelligence/eventStore.js` — gates DB writes on these tables existing
