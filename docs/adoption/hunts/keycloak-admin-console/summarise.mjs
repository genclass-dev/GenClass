// Reduces the hunt's explore sessions (hunt.mjs writes <scenario>-p<pause>-summary.json into HUNT_OUT) to one table
// row per session: explore's verdict next to this harness's own oracle (the server state and the page, read after the
// quiet point). Loads 1 and 2 of a session are the fifo baselines, loads 3 to 8 the seeded orders.
//
//   node docs/adoption/hunts/keycloak-admin-console/summarise.mjs [HUNT_OUT] > results.json
//
// "wrong" is per scenario: realm-tabs, the display name saved on the General tab is not what the server keeps;
// login-switches, a switch that was turned on is off on the server; user-search, the rows are not the "beta" users;
// user-create-double, more than one user or an error alert.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? process.env.HUNT_OUT ?? "/root/targets/kc-hunt-out";
const WRONG = {
  "realm-tabs": (o) => o.displayName !== "Display name from the General tab",
  "login-switches": (o) => !(o.registrationAllowed && o.resetPasswordAllowed),
  "user-search": (o) => !o.rows.length || o.rows.some((r) => !r.startsWith("beta")),
  "user-create-double": (o) => o.users !== 1 || o.alerts.some((a) => /could not|error/i.test(a)),
};

const rows = [];
for (const f of readdirSync(OUT).filter((n) => n.endsWith("-summary.json")).sort()) {
  for (const s of JSON.parse(readFileSync(join(OUT, f), "utf8"))) {
    const wrong = WRONG[s.scenario] ?? (() => false);
    const flags = s.oracles.map((o) => (o ? (wrong(o) ? 1 : 0) : null));
    const race = /^RACE: (\d+) of (\d+)/.exec(s.verdict);
    rows.push({
      scenario: s.scenario,
      variant: s.variant ?? "unfixed",
      pause_ms: s.pause_ms,
      slow_ms: s.slow_ms,
      verdict: race ? `race ${race[1]} of ${race[2]}` : s.verdict.startsWith("No race") ? "no race" : s.verdict.slice(0, 40),
      replay: s.replay,
      oracle_wrong_baselines: `${flags.slice(0, 2).filter((x) => x === 1).length} of 2`,
      oracle_wrong_seeded: `${flags.slice(2).filter((x) => x === 1).length} of ${flags.slice(2).length}`,
      errors: s.errors.length,
      example: s.oracles.find((o, i) => i >= 2 && o && wrong(o)) ?? null,
      ...(s.source ? { source: s.source } : {}),
    });
  }
}
console.log(JSON.stringify(rows, null, 1));
