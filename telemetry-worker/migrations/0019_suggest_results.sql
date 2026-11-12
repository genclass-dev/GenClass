-- genclass suggest's last answer per app (the owner's call, 2026-11-12): the measured checks in the model's order with
-- its reasons, steps and prompts, the model's own ideas (not measured) and its website design ideas (each inspired by
-- a real site, with a full prompt to paste into a coding agent). Free sees the first item and the counts, and is
-- shown this same answer again on every run until the account pays; Pro sees all of it. One row per account and
-- app, replaced by the next answer; deleted with the account. The digest it came from is not kept.
-- Apply before deploying the worker that reads it:
--   npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

CREATE TABLE suggest_results (
  account_id TEXT NOT NULL,
  app_key TEXT NOT NULL,      -- sha256 of the app's site address (else its name), so one app has one answer
  created TEXT NOT NULL,
  body TEXT NOT NULL,         -- JSON: { source, items, ideas, designs }
  PRIMARY KEY (account_id, app_key)
);
