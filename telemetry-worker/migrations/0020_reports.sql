-- GenClass reports by email (src/report.ts; the owner's request, 2026-11-13): a report about an account's apps, sent
-- to the account's email on a schedule it chooses, and alerts for critical (P0) problems as soon as the hourly run
-- sees them.
--
-- accounts.report_every: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'off'; NULL is the default, daily.
-- accounts.report_next:  ISO time the next scheduled report is due; NULL until the first hourly run gives it one.
-- accounts.report_sent:  ISO time the last report or alert went out.
-- accounts.report_alerts: 1 sends P0 alerts between reports; 0 does not. 'off' stops both.
-- accounts.report_model: ISO time the model last wrote a report's summary (an hourly report asks it every 6 hours).
ALTER TABLE accounts ADD COLUMN report_every TEXT;
ALTER TABLE accounts ADD COLUMN report_next TEXT;
ALTER TABLE accounts ADD COLUMN report_sent TEXT;
ALTER TABLE accounts ADD COLUMN report_alerts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN report_model TEXT;
CREATE INDEX IF NOT EXISTS accounts_report_next ON accounts (report_next);

-- One row per app and P0 rule: when its alert last went out, so the same alert is sent at most once a day.
CREATE TABLE IF NOT EXISTS report_alerts (
  project_id TEXT NOT NULL,
  rule       TEXT NOT NULL,
  sent       TEXT NOT NULL,
  PRIMARY KEY (project_id, rule)
) WITHOUT ROWID;

-- Emails sent per account and UTC day (reports, alerts and tests together): at most REPORT_DAILY_CAP. Kept 3 days.
CREATE TABLE IF NOT EXISTS report_sends (
  account_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
) WITHOUT ROWID;
