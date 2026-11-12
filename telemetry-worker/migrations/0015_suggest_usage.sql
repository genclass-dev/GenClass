-- `genclass suggest` (src/suggest.ts; the `genclass` command, packages/cli): how many times an account asked the model
-- for a plan on a UTC day, so that a plan's daily number holds (billing/plans.json `suggestions.per_day`) and one
-- account cannot run up the model's bill. Additive only: one new table.
-- Counts only. Nothing of what was sent (the checks that failed, the app's profile) or answered is stored anywhere.
-- A row goes 3 days after its day (the daily sweep) and with its account.
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote
-- Until it is applied the route still answers: with no count there is no model run, and the plan is ordered by the
-- checks' own weights.

CREATE TABLE IF NOT EXISTS suggest_usage (
  account_id TEXT NOT NULL,                    -- accounts.id
  day        TEXT NOT NULL,                    -- YYYY-MM-DD (UTC)
  runs       INTEGER NOT NULL DEFAULT 0,       -- model runs taken on that day
  PRIMARY KEY (account_id, day)
) WITHOUT ROWID;
