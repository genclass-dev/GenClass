-- Partners (owner request, 2026-11-14): an account GenClass lets build GenClass into its own product. Its server makes
-- an app for each of its users through the partner API (src/partner.ts) and reads what those apps find. Set by hand
-- with the agreement, like comp_until (telemetry-worker/README.md "Partner API"). Additive only.

-- How many apps the account may hold when the partner API makes one; NULL: not a partner (every partner route is 403).
ALTER TABLE accounts ADD COLUMN partner_apps INTEGER;

-- The partner's own id for the user an app is for (unique in its account); NULL for every app not made by the API.
ALTER TABLE projects ADD COLUMN partner_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS projects_partner_ref ON projects (account_id, partner_ref) WHERE partner_ref IS NOT NULL;

-- Partner keys: `gcp_` + 32 random bytes, stored as a SHA-256 hex. They reach /api/partner/v1/* and nothing else.
CREATE TABLE IF NOT EXISTS partner_keys (
  id         TEXT PRIMARY KEY,
  hash       TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  label      TEXT,
  created    TEXT NOT NULL,
  last_used  TEXT
);
CREATE INDEX IF NOT EXISTS partner_keys_account ON partner_keys (account_id);
