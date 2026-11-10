-- The GitHub App, genclass-dev[bot] (src/github/*; docs/github-app/README.md): where it is installed, which repository is
-- linked to which GenClass app, what it posted on each pull request, and the GitHub Marketplace plan of an account.
-- Additive only: seven new tables; no existing row or column changes, and nothing here is read unless the worker has the
-- app's secrets (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET).
-- Never stored: source code, diffs, file contents, race files, evidence lines beyond the short titles below, GitHub
-- tokens of any kind (installation tokens live in memory for under an hour; user tokens are used once and dropped).
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

-- One row per installation. `account_*` is the GitHub user or organization it is installed on (public profile data).
-- `owner` is the GenClass account that manages the installation: its plan decides whether the installation's private
-- repositories are read (src/github/entitlement.ts). It is the account of the person whose own GitHub account the
-- installation is on, set when they connect (GitHub says who they are), or, for an organization, the account the
-- server's operator set by hand (docs/github-app/SETUP.md). Being able to reach or push to a repository of the
-- installation never sets it. NULL until then; public repositories are reviewed either way.
-- `selection` decides what a repository hears before race files were ever read for it (github_repo_facts): nothing on
-- an installation for all repositories, one check on an installation for selected ones. 'unknown': the installation
-- was first seen through another event than its own `created`; it counts as 'all' until GitHub was asked.
CREATE TABLE IF NOT EXISTS github_installations (
  id            INTEGER PRIMARY KEY,           -- GitHub's installation id
  account_id    INTEGER NOT NULL,              -- GitHub's id of the user or organization
  account_login TEXT NOT NULL,
  account_type  TEXT NOT NULL,                 -- 'User' | 'Organization'
  selection     TEXT NOT NULL DEFAULT 'unknown', -- 'all' | 'selected' repositories | 'unknown'
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
-- they cannot write to, or read another account's app through a repository. The account that owns the linked app can
-- take the link away at any time, also after it lost its access to the repository.
CREATE TABLE IF NOT EXISTS github_repos (
  repo_id         INTEGER PRIMARY KEY,         -- GitHub's repository id
  installation_id INTEGER NOT NULL,
  full_name       TEXT NOT NULL,               -- owner/name as last seen
  private         INTEGER NOT NULL DEFAULT 0,
  project_id      TEXT,                        -- projects.id of the linked app, else NULL
  linked_by       TEXT,                        -- accounts.id
  linked          TEXT,
  paused          INTEGER NOT NULL DEFAULT 0,  -- 1: no reviews until resumed (the account page, or @genclass-dev pause)
  updated         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_repos_installation ON github_repos (installation_id);
CREATE INDEX IF NOT EXISTS github_repos_project ON github_repos (project_id);

-- What the app has done once for a repository, so that it is never done twice: three times, nothing else. A row is
-- made the first time one of them happens and stays as long as the repository is in the installation (the daily sweep
-- leaves this table alone; an uninstall, or taking the repository out, deletes the row).
-- `evidence`: race files were read for it. Until then a pull request without race files gets no check at all, and
-- from then on every pull request gets one. `intro`: the one check that says what the app reads was written (only on
-- an installation for selected repositories). `plan_notice`: the one check that says a private repository needs a
-- plan was written.
-- `issue_turn` is not one of the three: it is the time until which one pull request has the repository's turn to open
-- an issue (`issues: merge`; src/github/store.ts takeIssueTurn), so that two pull requests that merge together with
-- the same finding cannot both open one. It is a minute at most, and NULL otherwise.
CREATE TABLE IF NOT EXISTS github_repo_facts (
  repo_id         INTEGER PRIMARY KEY,         -- GitHub's repository id
  installation_id INTEGER NOT NULL,
  evidence        TEXT,                        -- ISO time race files were first read for it, else NULL
  intro           TEXT,                        -- ISO time the one "what this check reads" check was written, else NULL
  plan_notice     TEXT,                        -- ISO time the one "private repositories need a plan" check was written
  issue_turn      TEXT,                        -- ISO time until which a pull request has the turn to open an issue here
  updated         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_repo_facts_installation ON github_repo_facts (installation_id);

-- What the app posted on a pull request, so the next push updates the same comment and check instead of adding more.
-- `state` is JSON (src/github/review.ts PrState): per finding a fingerprint (a hash), its group, a short title, the
-- commits it was first and last seen at and whether it was reproducible; the hash of the last comment body. Only a
-- review that holds the lease writes it. Kept 30 days after the pull request closes, 180 days at most.
-- `paused` (the pause command) and `issue` (the issue `issues: merge` opened) are columns of their own, each written
-- by one statement: a command and a review that runs at the same moment cannot overwrite each other.
-- `lease` and `pending` make one review at a time per pull request (src/github/store.ts takeLease): a review holds the
-- lease for at most 35 seconds (longer than a job can live); an event that arrives meanwhile sets `pending` on the
-- live lease, and the holder runs once more when done.
-- `due` marks a review that is owed: set when a review starts and cleared when it ends, except when it ended waiting
-- for the commit's test run or could not run (a limit, no time left). A job that died leaves it set. The daily sweep
-- reviews pull requests that have been due for more than an hour, so a check left in progress is always finished.
-- `hour` and `hour_reviews` count this pull request's reviews in the current UTC hour (one pull request cannot use up
-- its installation's hour).
CREATE TABLE IF NOT EXISTS github_prs (
  repo_id         INTEGER NOT NULL,
  number          INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  head_sha        TEXT NOT NULL DEFAULT '',    -- the head commit the stored review is about
  comment_id      INTEGER,                     -- the summary comment (an issue comment id)
  check_run_id    INTEGER,                     -- the check run on head_sha
  state           TEXT NOT NULL DEFAULT '{}',
  paused          INTEGER NOT NULL DEFAULT 0,  -- 1: not updated until someone with write access replies resume
  issue           INTEGER,                     -- number of the issue opened when it merged (issues: merge), else NULL
  reviews         INTEGER NOT NULL DEFAULT 0,  -- reviews and replies that wrote something on this pull request
  lease           TEXT,                        -- ISO time until which a review of it is running
  pending         INTEGER NOT NULL DEFAULT 0,  -- while a review runs: 1 an event arrived, 2 a person with write access asked for a review, 3 the pull request's author (without write access) did
  due             TEXT,                        -- ISO time since which a review of it is owed, else NULL
  hour            TEXT,                        -- YYYY-MM-DDTHH (UTC) that hour_reviews counts
  hour_reviews    INTEGER NOT NULL DEFAULT 0,  -- reviews of it started in `hour`
  closed          TEXT,                        -- when the pull request closed
  updated         TEXT NOT NULL,
  PRIMARY KEY (repo_id, number)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS github_prs_installation ON github_prs (installation_id);
CREATE INDEX IF NOT EXISTS github_prs_sha ON github_prs (repo_id, head_sha);
CREATE INDEX IF NOT EXISTS github_prs_closed ON github_prs (closed);
CREATE INDEX IF NOT EXISTS github_prs_updated ON github_prs (updated);
CREATE INDEX IF NOT EXISTS github_prs_due ON github_prs (due) WHERE due IS NOT NULL;

-- Webhook deliveries already taken (GitHub redelivers on request, and a delivery can arrive twice). Ids only; 7 days.
-- `done` is set when the delivery's job ended. A delivery taken more than a minute ago whose job never ended (the
-- platform stopped it) may be taken again, so "Redeliver" on GitHub's side runs it; one that ended is never run twice.
CREATE TABLE IF NOT EXISTS github_deliveries (
  id       TEXT PRIMARY KEY,                   -- X-GitHub-Delivery (a GUID)
  event    TEXT NOT NULL,
  received TEXT NOT NULL,                      -- ISO time it was taken (the last time, when taken again)
  done     TEXT                                -- ISO time its job ended, else NULL
);
CREATE INDEX IF NOT EXISTS github_deliveries_received ON github_deliveries (received);

-- Reviews run per installation per UTC hour: the cap that keeps one busy installation from using up GitHub's rate
-- limit for itself or the worker's time for everyone (src/github/store.ts claimReview). Kept 2 days.
-- `outside` counts the ones for pull requests whose author is not an owner, member or collaborator of the repository:
-- they may use half of the hour, so that outsiders' pull requests cannot stop the reviews of everyone else's.
CREATE TABLE IF NOT EXISTS github_usage (
  installation_id INTEGER NOT NULL,
  hour            TEXT NOT NULL,               -- YYYY-MM-DDTHH (UTC)
  reviews         INTEGER NOT NULL DEFAULT 0,  -- reviews that read a commit's evidence in this hour
  outside         INTEGER NOT NULL DEFAULT 0,  -- of those, for pull requests by authors from outside the repository
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
