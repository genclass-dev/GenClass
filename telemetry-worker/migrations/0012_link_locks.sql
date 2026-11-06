-- A private dashboard link protected by a password or a passkey (src/link-lock.ts). /start asks for one when it makes
-- the link; a link made before this (or by the CLI's init) stays open until someone with the link adds one.
-- Additive only: two nullable columns on `projects` and two new tables.
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

-- lock_kind: NULL (open), 'password' or 'passkey'. lock_hash: the password's PBKDF2 string (src/password.ts), NULL for
-- a passkey. lock_failures / lock_failed_at: wrong passwords in a row and the last one, for the delay after them.
ALTER TABLE projects ADD COLUMN lock_kind TEXT;
ALTER TABLE projects ADD COLUMN lock_hash TEXT;
ALTER TABLE projects ADD COLUMN lock_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN lock_failed_at TEXT;

-- A link's passkeys: only public keys are stored. `token` is the project's.
CREATE TABLE link_credentials (
  id          TEXT PRIMARY KEY,               -- credential id, base64url
  token       TEXT NOT NULL,
  public_key  TEXT NOT NULL,                  -- COSE_Key bytes, base64url
  alg         INTEGER NOT NULL,               -- -7 ES256 | -257 RS256
  sign_count  INTEGER NOT NULL DEFAULT 0,
  created     TEXT NOT NULL,
  last_used   TEXT
);
CREATE INDEX link_credentials_token ON link_credentials (token);

-- A browser that unlocked a link: the SHA-256 hex of its cookie value, never the value itself.
CREATE TABLE link_sessions (
  hash     TEXT PRIMARY KEY,
  token    TEXT NOT NULL,
  created  TEXT NOT NULL,
  expires  TEXT NOT NULL
);
CREATE INDEX link_sessions_token ON link_sessions (token);
CREATE INDEX link_sessions_expires ON link_sessions (expires);
