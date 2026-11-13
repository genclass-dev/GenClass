-- billing/plans.json version 5 (2026-11-13): Pro for the account, per developer, covering up to 3 apps; Free one app;
-- every new app opens "Choose a plan" first. What was bought before keeps what it covered (the Terms: plans bought
-- before 13 November 2026 keep covering the apps they covered):
-- - accounts.apps_kept: for an account paying when this is applied (a Team subscription of the whole account, from
--   version 3, or one bought per app), how many apps it has then. Its plan covers at least that many while that same
--   subscription lasts (src/plans.ts coverage); the webhook clears it when the subscription ends or another one
--   replaces it. A subscription bought per project (version 4) needs nothing here: its app is always covered and is
--   not counted in the 3.
-- - projects.plan_chosen: an app that a paid plan or a grant covers when this is applied (its own, its account's, or
--   an account with an app that pays for itself) counts as chosen, so it opens its dashboard as before.
-- Apply before deploying the worker that reads it:
--   npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

ALTER TABLE accounts ADD COLUMN apps_kept INTEGER;

UPDATE accounts SET apps_kept = (SELECT COUNT(*) FROM projects WHERE projects.account_id = accounts.id)
  WHERE plan IS NOT NULL AND plan != 'free' AND subscription_id IS NOT NULL;

UPDATE projects SET plan_chosen = created
  WHERE plan_chosen IS NULL AND account_id IS NOT NULL AND (
    (plan IS NOT NULL AND plan != 'free')
    OR comp_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    OR account_id IN (SELECT id FROM accounts WHERE (plan IS NOT NULL AND plan != 'free') OR comp_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    OR account_id IN (SELECT account_id FROM projects WHERE plan IS NOT NULL AND plan != 'free' AND account_id IS NOT NULL)
  );
