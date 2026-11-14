-- An app's extra keys (owner request, 2026-11-13): when two apps of one account are merged into one (an onboarding that
-- made two), the key of the app that goes away keeps reporting, counted as the remaining app's own key. A batch that
-- carries an extra key is aggregated, indexed for export and forwarded under the app's own key (src/collector.ts,
-- src/dashboard.ts canonicalToken); the raw batch in R2 keeps the key the page sent. Deleting the app deletes its
-- extra keys. Added by hand for now (telemetry-worker/README.md "Extra keys"): no route writes this table.
CREATE TABLE IF NOT EXISTS app_keys (
  token         TEXT PRIMARY KEY,  -- the extra key a page may send (gc_ + 22 base62)
  project_token TEXT NOT NULL,     -- the app's own key (projects.token)
  created       TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS app_keys_project ON app_keys (project_token);
