-- The GitHub App, genclass[bot] (src/github/*; docs/github-app/README.md): where it is installed, which repository is
-- linked to which GenClass app, what it posted on each pull request, and the GitHub Marketplace plan of an account.
-- Additive only: six new tables; no existing row or column changes, and nothing here is read unless the worker has the
-- app's secrets (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET).
-- Never stored: source code, diffs, file contents, race files, evidence lines beyond the short titles below, GitHub
-- tokens of any kind (installation tokens live in memory for under an hour; user tokens are used once and dropped).
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

-- One row per installation. `account_*` is the GitHub user or organization it is installed on (public profile data).
-- `owner` is the GenClass account that proved, through GitHub, that it can reach this installation and asked to manage
-- it here (NULL until someone does; the app reviews pull requests either way).
CREATE TABLE IF NOT EXISTS github_installations (
  id            INTEGER PRIMARY KEY,           -- GitHub's installation id
  account_id    INTEGER NOT NULL,              -- GitHub's id of the user or organization
  account_login TEXT NOT NULL,
  account_type  TEXT NOT NULL,                 -- 'User' | 'Organization'
  selection     TEXT NOT NULL DEFAULT 'selected', -- 'all' | 'selected' repositories
  owner         TEXT,                          -- accounts.id
  suspended     TEXT,                          -- ISO time GitHub suspended it, else NULL
  created       TEXT NOT NULL,
  updated       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_installations_owner ON github_installations (owner);
CREATE INDEX IF NOT EXISTS github_installations_account ON github_installations (account_id);

-- A repository the app keeps something about: the GenClass app (project) its production findings come from, or a
-- pause. Not a list of an installation's repositories (GitHub is asked for that). `repo_id` survives renames.
-- A link is made only by a GenClass account that owns the project AND, at that moment, has push access to the
-- repository according to GitHub (src/github/http.ts), so nobody can make the bot post their numbers on a repository
-- they cannot write to, or read another account's app through a repository.
CREATE TABLE IF NOT EXISTS github_repos (
  repo_id         INTEGER PRIMARY KEY,         -- GitHub's repository id
  installation_id INTEGER NOT NULL,
  full_name       TEXT NOT NULL,               -- owner/name as last seen
  private         INTEGER NOT NULL DEFAULT 0,
  project_id      TEXT,                        -- projects.id of the linked app, else NULL
  linked_by       TEXT,                        -- accounts.id
  linked          TEXT,
  paused          INTEGER NOT NULL DEFAULT 0,  -- 1: no reviews until resumed (the account page, or @genclass pause)
  updated         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_repos_installation ON github_repos (installation_id);
CREATE INDEX IF NOT EXISTS github_repos_project ON github_repos (project_id);

-- What the app posted on a pull request, so the next push updates the same comment and check instead of adding more.
-- `state` is JSON (src/github/review.ts PrState): per finding a fingerprint (a hash), its group, a short title, the
-- commits it was first and last seen at and whether it was reproducible; the hash of the last comment body; whether
-- the pull request is paused. Kept 30 days after the pull request closes, 180 days at most.
-- `lease` and `pending` make one review at a time per pull request (src/github/store.ts takeLease): a review holds the
-- lease for at most a minute; an event that arrives meanwhile sets `pending`, and the holder runs once more when done.
CREATE TABLE IF NOT EXISTS github_prs (
  repo_id         INTEGER NOT NULL,
  number          INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  head_sha        TEXT NOT NULL DEFAULT '',    -- the head commit the stored review is about
  comment_id      INTEGER,                     -- the summary comment (an issue comment id)
  check_run_id    INTEGER,                     -- the check run on head_sha
  state           TEXT NOT NULL DEFAULT '{}',
  reviews         INTEGER NOT NULL DEFAULT 0,  -- reviews run for this pull request
  lease           TEXT,                        -- ISO time until which a review of it is running
  pending         INTEGER NOT NULL DEFAULT 0,  -- 1: something changed while a review was running
  closed          TEXT,                        -- when the pull request closed
  updated         TEXT NOT NULL,
  PRIMARY KEY (repo_id, number)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS github_prs_installation ON github_prs (installation_id);
CREATE INDEX IF NOT EXISTS github_prs_sha ON github_prs (repo_id, head_sha);
CREATE INDEX IF NOT EXISTS github_prs_closed ON github_prs (closed);
CREATE INDEX IF NOT EXISTS github_prs_updated ON github_prs (updated);

-- Webhook deliveries already handled (GitHub redelivers on request, and a delivery can arrive twice). Ids only; 7 days.
CREATE TABLE IF NOT EXISTS github_deliveries (
  id       TEXT PRIMARY KEY,                   -- X-GitHub-Delivery (a GUID)
  event    TEXT NOT NULL,
  received TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_deliveries_received ON github_deliveries (received);

-- Reviews run per installation per UTC hour: the cap that keeps one busy installation from using up GitHub's rate
-- limit for itself or the worker's time for everyone (src/github/store.ts claimReview). Kept 2 days.
CREATE TABLE IF NOT EXISTS github_usage (
  installation_id INTEGER NOT NULL,
  hour            TEXT NOT NULL,               -- YYYY-MM-DDTHH (UTC)
  reviews         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_id, hour)
) WITHOUT ROWID;

-- The GitHub Marketplace plan of a GitHub account (marketplace_purchase events): which plan, since when, and a
-- pending change. Never payment data: GitHub holds that and pays GenClass. No row means the free plan.
CREATE TABLE IF NOT EXISTS github_marketplace (
  account_id    INTEGER PRIMARY KEY,           -- GitHub's id of the user or organization
  login         TEXT NOT NULL,
  plan_id       INTEGER NOT NULL,              -- GitHub Marketplace's plan id
  plan_name     TEXT NOT NULL,
  monthly_cents INTEGER NOT NULL DEFAULT 0,    -- the plan's monthly price in US cents (0: a free plan)
  unit_count    INTEGER,
  free_trial_ends TEXT,
  pending       TEXT,                          -- JSON { plan_id, plan_name, effective } of a pending change
  updated       TEXT NOT NULL
);
