-- Plans per project (billing/plans.json version 4, 2026-11-12): each app has its own plan. Team is $15 a month per
-- project, everyone on it included; Free covers an account's first 3 projects and 100 problems fixed live a month
-- per project. Additive, and one copy of rows that exist:
-- - the paid plan of a project: written by the webhook from a subscription whose metadata names the project
--   (src/stripe.ts applyProjectSubscription); an account-level subscription from before keeps covering every app of
--   its account (src/plans.ts projectAccess), so nobody who pays loses anything;
-- - GenClass's grant per project: every app of an account that had a grant gets the same grant (the owner's choice,
--   2026-11-12: "every project they have"); apps added later choose a plan like everyone else's;
-- Live fixes per project and month need no table: they are read from the daily counters (src/usage.ts).
-- Apply before deploying the worker that reads them:
--   npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

ALTER TABLE projects ADD COLUMN plan TEXT;                    -- the paid plan's id; NULL: none
ALTER TABLE projects ADD COLUMN subscription_id TEXT;
ALTER TABLE projects ADD COLUMN subscription_status TEXT;
ALTER TABLE projects ADD COLUMN current_period_end TEXT;
ALTER TABLE projects ADD COLUMN cancel_at_period_end INTEGER;
ALTER TABLE projects ADD COLUMN stripe_mode TEXT;              -- the Stripe mode the subscription belongs to
ALTER TABLE projects ADD COLUMN comp_until TEXT;               -- GenClass's own grant for this app, until then
ALTER TABLE projects ADD COLUMN comp_plan TEXT;                -- the plan that grant gives
CREATE INDEX projects_subscription ON projects (subscription_id);

UPDATE projects
SET comp_until = (SELECT a.comp_until FROM accounts a WHERE a.id = projects.account_id),
    comp_plan = (SELECT a.comp_plan FROM accounts a WHERE a.id = projects.account_id)
WHERE account_id IN (SELECT id FROM accounts WHERE comp_until IS NOT NULL);

