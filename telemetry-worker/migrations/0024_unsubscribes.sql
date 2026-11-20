-- The unsubscribe page (owner request, 2026-11-19; src/unsubscribe.ts): genclass.dev/unsubscribe, linked from the
-- signature of email a person at GenClass writes by hand. One row per address that asked for no more of that email.
-- Nothing else reads it: GenClass reports and alerts keep their own switch (accounts.report_every, migration 0020).
-- The sender checks this list before writing to anyone. Rows are kept for as long as GenClass sends such email: a
-- deleted row is an address that could be written to again.
-- (0023 is the partner API's number, pull request #242.)
CREATE TABLE IF NOT EXISTS unsubscribes (
  email   TEXT PRIMARY KEY,  -- as typed, trimmed and lower case
  created TEXT NOT NULL      -- ISO time of the first request
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS unsubscribes_created ON unsubscribes (created);
