-- Why Free was chosen for an app (the owner's call, 2026-11-12): the plan page asks "What's stopping you from
-- paying?" before an app goes on with Free, with a few reasons to pick and an optional note (at most 500 characters).
-- One row per choice; the owner reads them to price and build Team. Nothing else about the person is stored here.
-- Apply before deploying the worker that writes it:
--   npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

CREATE TABLE plan_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  reason TEXT NOT NULL,       -- one of FREE_REASONS (src/billing.ts)
  note TEXT,                  -- what they wrote, if anything
  created TEXT NOT NULL
);
CREATE INDEX plan_feedback_created ON plan_feedback (created);
