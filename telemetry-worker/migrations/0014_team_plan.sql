-- The Team plan (billing/plans.json version 3, 2026-11-11): seats, the plan a grant gives, members and invite links.
-- Additive only: two nullable columns on `accounts` and two new tables. No row is changed, so every account keeps the
-- plan it had; what an account on Free sees changes with the worker's plans file, not with this migration.
-- Apply before deploying the worker that reads them (src/plans.ts ACCESS_COLUMNS names both columns):
--   npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

-- The paid seats of a per-seat plan: the quantity of the account's Stripe subscription, written by the webhook
-- (src/stripe.ts applySubscription). NULL: no per-seat subscription.
ALTER TABLE accounts ADD COLUMN seats INTEGER;

-- The plan GenClass's own grant gives while comp_until is in the future ('team', 'enterprise'). NULL or unknown:
-- plans.json grant_plan (Enterprise), as before this column.
ALTER TABLE accounts ADD COLUMN comp_plan TEXT;

-- Members of an account's team: `member_id` (another account) may read the dashboards of `account_id`'s apps while
-- that account's plan holds enough people (src/team.ts activeOwners: the owner is the first seat, then members in the
-- order they joined). An account is never a member of itself. Rows go when either account is deleted.
CREATE TABLE team_members (
  account_id  TEXT NOT NULL,                  -- the team's owner (accounts.id)
  member_id   TEXT NOT NULL,                  -- the member (accounts.id)
  created     TEXT NOT NULL,
  PRIMARY KEY (account_id, member_id)
);
CREATE INDEX team_members_member ON team_members (member_id);

-- Invite links, single use: the row goes when someone joins with it, when the owner revokes it, or when it expires
-- (7 days). `hash` is the SHA-256 hex of the code in the link; the code itself is never stored. GenClass sends no
-- email: the owner copies the link to the person.
CREATE TABLE team_invites (
  id          TEXT PRIMARY KEY,               -- public id, for listing and revoking
  hash        TEXT NOT NULL UNIQUE,
  account_id  TEXT NOT NULL,                  -- the team's owner
  created     TEXT NOT NULL,
  expires     TEXT NOT NULL
);
CREATE INDEX team_invites_account ON team_invites (account_id);
CREATE INDEX team_invites_expires ON team_invites (expires);
