-- AppSumo lifetime deal codes redeemed on genclass.dev (src/appsumo.ts). A code is valid when its signature checks out
-- (the Worker secret APPSUMO_CODE_SECRET), so the codes themselves are never stored before they are used; this table
-- says which were used, and by which account, so each one works once. An account stacks 2 at most: one code gives the
-- Pro plan for life, two give Business (written to accounts.comp_plan and accounts.comp_until). `refunded`: a code
-- AppSumo refunded, which no longer counts.
CREATE TABLE IF NOT EXISTS appsumo_codes (
  code       TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  redeemed   TEXT NOT NULL,
  refunded   TEXT
);
CREATE INDEX IF NOT EXISTS appsumo_codes_account ON appsumo_codes (account_id);
