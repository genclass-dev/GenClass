# Keycloak admin console hunt: harness

The report is [../keycloak-admin-console.md](../keycloak-admin-console.md). Each script's header says how to run it;
all of them expect a Keycloak dev server on `KEYCLOAK_URL` (default `http://localhost:8080`, admin/admin) and, for
`hunt.mjs`, GenClass built in this repository (`npm run build -w @genclass/runtime && npm run build -w @genclass/mcp`).

| file | what |
|---|---|
| `kc.mjs` | the admin REST API through `admin-cli` (token, realm create/get/delete), the console's login form |
| `repro-lost-update.mjs` | the reproduction without GenClass: a slower realm reload (route) or Chromium's latency emulation (`THROTTLE_MS`, `PAUSE_MS`) |
| `hunt.mjs` | the explore loop: GenClass injected with `addInitScript`, `@genclass/mcp` in-process, scenarios `realm-tabs`, `login-switches`, `user-search`, `user-create-double` |
| `summarise.mjs` | one row per explore session: explore's verdict next to the harness's server-side oracle |
| `results.json` | `summarise.mjs`'s output for this hunt (unfixed nightly and fixed Vite console) |
| `repro-results.txt` | the reproduction's and the regression test's counts, unfixed and fixed |

In `results.json`, the first three `user-search` sessions' oracle read no rows (a selector bug, fixed before the
second sessions), so their "wrong" counts mean nothing; the `replay` value "No finding ." of the first realm-tabs
sessions is the harness calling `genclass_replay result` without the finding id (fixed later). The report's section 3
gives the counts that hold.
