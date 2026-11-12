-- The GitHub App (src/github/store.ts): how many installations were added and removed on each UTC day. An uninstall
-- deletes everything kept for an installation (0013), so without this nothing could say that anyone ever left.
-- Additive only: one new table; no existing row or column changes.
-- Counts only: no installation id, no account id or name, no repository. A row cannot say who installed or
-- uninstalled, and nothing in it is kept "for" an installation, so an uninstall still leaves nothing about the
-- account that left.
-- `own` splits the count in two: installations on the operator's own GitHub accounts (GITHUB_APP_OWN_ACCOUNTS, the
-- names of the people who run this server; empty by default) are counted in a row of their own, so that their test
-- installs are never read as someone else's.
-- `installs`: installations recorded for the first time on that day (their `created` event, or the first other event
-- of one whose `created` never arrived). `uninstalls`: installations that were recorded and removed on that day. Both
-- are written in the same transaction as the installation's row, so a delivery that is handled twice counts once.
-- Counting starts when this is applied: installations already there are not counted as installs (their rows say when
-- they were first seen), and an uninstall of one of them counts as an uninstall.
-- Rows are not swept: two rows a day at most.
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote
-- Until it is applied installs and uninstalls are handled as before, without a count.

CREATE TABLE IF NOT EXISTS github_install_days (
  day        TEXT NOT NULL,                    -- YYYY-MM-DD (UTC)
  own        INTEGER NOT NULL DEFAULT 0,       -- 1: on one of the operator's own accounts; 0: anyone else's
  installs   INTEGER NOT NULL DEFAULT 0,       -- installations first recorded on that day
  uninstalls INTEGER NOT NULL DEFAULT 0,       -- installations removed on that day
  PRIMARY KEY (day, own)
) WITHOUT ROWID;
