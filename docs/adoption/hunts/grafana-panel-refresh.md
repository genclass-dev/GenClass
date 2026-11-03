# Race hunt: Grafana admin lists (13.4.0-local, `98b10741`)

A GenClass race hunt on Grafana, run on 2026-11-03 in a cloud session (slug `grafana-panel-refresh`), with the real
`@genclass/runtime` (0.3.0-beta.5, this repository at `c1c9e14`) injected into Grafana's pages by Playwright and the
real `@genclass/mcp` (0.2.1) driven the way a coding agent drives it. Grafana's source was not modified for the hunt;
the fix is a patch for its maintainers ([grafana-panel-refresh.patch](grafana-panel-refresh.patch); issue and pull
request drafts in [grafana-panel-refresh-issue.md](grafana-panel-refresh-issue.md)). Nothing was sent to Grafana's
repository, forum or maintainers.

**Status: needs owner decision.** The finding, fix, tests and drafts are ready, but Grafana closes unsigned commits
"including pull requests that have been authored by Agents" and wants its CLA signed: the sender must re-sign the
patch's commit with their own verified key and sign the CLA, which a cloud session cannot do (section 8).

**Headline.** One real race, the same in three places: the server-admin users list (`/admin/users`), the service
accounts list (`/org/serviceaccounts`) and the org users list (`/org/users`, "Organization users" tab) await their
search request without a `requestId`, abort or sequence check and store whichever response arrives last. Click page 2
and then page 3, and if page 2's response is the slower one the list ends on page 2's rows with the pager moved back
to 2; type a search, pause, type more, and the older result can stay under the newer query. Explore reported it on
paging in 4, 5 and 3 of 6 reordered loads (admin, service accounts, org) at each of 300, 600 and 900 ms, and on search
only at the higher latencies (2 of 6 at 900 ms on the admin list, 2 and 3 of 6 at 600 and 900 ms on service accounts,
1 of 6 at 900 ms on the org list with a replacement search). This harness's own DOM oracle agreed with explore load
for load in all 45 comparable sessions (360 loads, before and after the fix), with 0 baselines wrong. Without GenClass, delaying only the earlier
response with `page.route` reproduces it in 5 of 5 loads on every list (0 of 5 without the delay). The fix passes a
fixed `requestId` per list to `getBackendSrv().get(...)`, which already cancels the earlier in-flight request with the
same id (+17 −6 lines in the three action files); with it, the new Jest tests pass (they fail before), explore finds no race in 144
loads, and the delayed reproductions end on the wrong result in 0 of 30 loads. The negative controls the brief named (panel refresh,
contact-point save) showed no race and no finding at all in 48 loads.

Sections: 1 setup, 2 how Grafana was driven, 3 scenarios and verdicts, 4 the finding, 5 other observations,
6 problems with GenClass itself, 7 time spent, 8 sending, 9 reproducing.

## 1. Setup

| what | version |
|---|---|
| Grafana | `main` at `98b107414cf6b39f4b13e9d9608f05a9716f00fc` (2026-11-03, "Command palette: Show dashboard tags in search results (#134500)"), reported as 13.4.0-local. The head that day, `6cf5131d` (#136395), does not build: `pkg/storage/unified/resource/bulk.go:382` `*spooledBulkRequests does not implement BulkRequestBatchIterator (wrong type for method NextBatch)`. Its parent was used; `public/` and `packages/` are identical in both (`git diff --quiet 98b10741 6cf5131d -- public/ packages/`), so the patch applies to either |
| Go | 1.27.3 (`GOTOOLCHAIN=auto` from go1.24.7) |
| Node, pnpm | 22.23.4 (engines `>= 22 <27`; `.nvmrc` says 26.13.0), pnpm 12.15.0 through corepack |
| database | SQLite (the pure-Go driver, `CGO_ENABLED=0`) |
| browser | Chromium 1243 (headless shell), Playwright 1.63.0 |
| GenClass | `@genclass/runtime` 0.3.0-beta.5 and `@genclass/mcp` 0.2.1 from this repository at `c1c9e14`, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |

Commands, in order (clone in `~/targets/grafana-panel-refresh`, outside this checkout):

```bash
git clone --depth 1 https://github.com/grafana/grafana.git ~/targets/grafana-panel-refresh && cd ~/targets/grafana-panel-refresh
git fetch --depth 10 origin main && git checkout 98b10741          # the head did not build (above)
corepack enable && corepack prepare pnpm@12.15.0 --activate
pnpm install --frozen-lockfile                                     # 19 s
GOTOOLCHAIN=auto make CGO_ENABLED=0 GO_BUILD_DEV=1 build-go         # bin/grafana, about 6 min the first time
pnpm build                                                         # production frontend, 35 s (rspack)
# three core plugin folders hold pnpm's node_modules symlinks, on which the backend's plugin walker stops with
# "walk: file '../../../../../node_modules/.pnpm/@emotion+css@11.13.5.../node_modules/@emotion/css' not inside of
# plugin directory"; they were renamed for the run and back for each frontend build:
for d in $(find public/app/plugins -maxdepth 4 -name node_modules -type d); do mv "$d" "$d.hunt-aside"; done
./bin/grafana server -packaging=dev cfg:app_mode=development cfg:analytics.reporting_enabled=false \
  cfg:analytics.check_for_updates=false cfg:analytics.check_for_plugin_updates=false \
  cfg:analytics.feedback_links_enabled=false cfg:news.news_feed_enabled=false cfg:plugins.preinstall_disabled=true \
  cfg:log.level=warn                                               # http://localhost:3000, admin/admin
node docs/adoption/hunts/grafana-panel-refresh/seed.mjs            # in GenClass-lib: 160 users, 120 service accounts,
                                                                   # a TestData dashboard, a contact point (10 s)
```

The first explores ran on the development build (`pnpm dev`). There each click on a pager button cost about 2.5 s of
main-thread work in Chromium here (React development mode), so two clicks could never have requests in flight together
at 300 to 900 ms; and the page crashed once with GenClass injected. Everything in this report is on the production
build (`pnpm build`), which is what users run; there a click was acknowledged in 50 to 70 ms.

## 2. How Grafana was driven

[grafana-panel-refresh/hunt.mjs](grafana-panel-refresh/hunt.mjs) is the whole loop, following
[gitea-explore.mjs](gitea-explore.mjs) and [strapi/hunt.mjs](strapi/hunt.mjs):

- **MCP server in-process.** `serve()` from `packages/mcp/dist/index.js`, bridge on a free port, tools called through
  JSON-RPC `tools/call`: `genclass_clear`, `genclass_explore` (start, report), `genclass_findings`, `genclass_explain`.
- **Injection without touching Grafana.** A context route serves `packages/runtime/dist/` under `/__genclass/` and
  rewrites each HTML document to add, at the top of `<head>`: `window.GENCLASS_CONFIG = { telemetry: false, mode:
  "observe", model: false, visual: false, devtools: false, report: "silent" }` and `window.__GENCLASS_AGENT_URL__`;
  the script tag `genclass.global.js`; a module script that calls `connectAgent(window.GenClass.runtime, { url })`
  from `/__genclass/agent.js`. Each context gets the `local-network-access` permission (the Gitea harness's finding).
  Requests to any host but `localhost` and `127.0.0.1` are aborted (Grafana asks grafana.com for news and plugins).
  The admin session is logged in once with `POST /login` and reused as `storageState`.
- **One page load per run.** Each load opens the list (and, for `/org/users`, clicks the "Organization users" tab:
  a Grafana admin lands on "All users", the server-admin list), waits for `window.__GENCLASS_AGENT__.connected`, the
  table, and `whenSettled()`, then performs the scenario's steps, awaits `whenSettled()` again and reads its oracle.
  Clicks on the pager are raw mouse input at the buttons' measured positions, two in a row with no wait, as a person
  clicks; Playwright's `locator.click()` waits for the page between the two, which no person does. Typing is
  `pressSequentially` (30 ms a key).
- **Explore.** `genclass_explore start` with `runs: 6` and `slow_ms` 300, 600 and 900 (8 loads a session: 2 fifo
  baselines, 6 seeded orders, each response delayed by a seeded 0 to `slow_ms` ms, `packages/mcp/src/api.ts` line 85),
  then `report`, `genclass_findings` and `genclass_explain` on a race finding.
- **Oracle of this harness.** After the run settled: the logins (or service account names) the table shows, compared
  with what the Grafana API returns for the last page or query the user asked for (`GET /api/users/search`,
  `/api/serviceaccounts/search`, `/api/org/users/search` with basic auth), plus the selected pager button and the
  search box's value. For the negative controls: the two stat panels' values (`5`, `4`) and no error text; the
  contact point count and no error alert. It is this script's own check next to explore's verdict.
- **Names without digits.** Users are adjective-noun pairs (`amber-falcon`, `Amber Falcon`, `amber.falcon@example.com`),
  service accounts `svc amber falcon`: explore blanks every token holding a digit when it compares page lines
  (AGENT.md section 5.1), so `user012` and `user062` would have looked the same to it.

State discovery found Grafana's list state as a React external store under react-redux's `connect`
(`Connect_Component.external0.users`, `.page`, `.isLoading`, ...; minified component names elsewhere: `h.state0`,
`floatingBoundary_5.state4`) and the user actions as `click button "2"`, `click button "3"`, typing bursts in the
search box.

## 3. Scenarios and verdicts

Explore's verdicts are its report's own words reduced to counts. "Oracle" columns are this harness's check (section 2).
All 48 sessions kept compared 6 of 6 reordered loads against two baselines; no report mentions a forced delivery (no
hold ran out); no load had a page error. In every session but org-search-hyphen, explore's failing runs and the
loads the oracle found wrong are the same loads (checked by script over the 360 loads). Result files: [grafana-panel-refresh/results/](grafana-panel-refresh/results/) (each session's
loads, report, findings and explanation), summarised with `summarise.mjs`.

### 3.1 Before the fix (`98b10741`, production build)

| scenario | steps after the list settled | slow_ms | explore verdict | oracle: reordered loads wrong | oracle: baselines wrong |
|---|---|---|---|---|---|
| admin-page | `/admin/users`: click page 2, click page 3 | 300 / 600 / 900 | RACE in 4 of 6 / 4 of 6 / 4 of 6 | 4 / 4 / 4 of 6 | 0 of 2 each |
| admin-search | `/admin/users`: type `lunar`, pause 550 ms, type `-o` | 300 / 600 / 900 | No race found / No race found / RACE in 2 of 6 | 0 / 0 / 2 of 6 | 0 of 2 each |
| sa-page | `/org/serviceaccounts`: click page 2, click page 3 | 300 / 600 / 900 | RACE in 5 of 6 / 5 of 6 / 5 of 6 | 5 / 5 / 5 of 6 | 0 of 2 each |
| sa-search | `/org/serviceaccounts`: type `lunar`, pause 550 ms, type ` o` | 300 / 600 / 900 | No race found / RACE in 2 of 6 / RACE in 3 of 6 | 0 / 2 / 3 of 6 | 0 of 2 each |
| org-page | `/org/users`, Organization users: click page 2, click page 3 | 300 / 600 / 900 | RACE in 3 of 6 / 3 of 6 / 3 of 6 | 3 / 3 / 3 of 6 | 0 of 2 each |
| org-search | same tab: type `lunar`, pause 350 ms, type ` o` | 300 / 600 / 900 | No race found (all three) | 0 / 0 / 0 of 6 | 0 of 2 each |
| org-search-replace | same tab: type `lunar`, pause 350 ms, Ctrl+A, type `amber` | 300 / 600 / 900 | No race found / No race found / RACE in 1 of 6 | 0 / 0 / 1 of 6 | 0 of 2 each |
| org-search-hyphen | same tab: type `lunar`, pause 350 ms, type `-o` (first org search attempt) | 300 / 600 / 900 | No race found / No race found / RACE in 3 of 6 | see note | see note |
| panel-refresh (negative control) | `/d/hunt-refresh` (two TestData stat panels): click the refresh button twice | 300 / 600 / 900 | No race found (all three) | 0 / 0 / 0 of 6 | 0 of 2 each |
| cp-save (negative control) | contact point `hunt-email`, edit page: double-click "Save contact point" | 300 / 600 / 900 | No race found (all three) | 0 / 0 / 0 of 6 | 0 of 2 each |

Where explore said RACE, its failing runs were exactly the loads the oracle found wrong, and they were exactly the
loads where the later request's response was delivered before the earlier one's (each load's line in the result
files ends with the delivered order). On paging the two requests always overlap, so the seeded order alone decides; on
search the second request leaves 550 ms (300 ms on the org list) plus the debounce after the first, so the two
responses only overlap when the first one's seeded delay is longer than that, which the 300 ms sessions never allow
and the 600 and 900 ms sessions allow sometimes. Same seeds give the same orders at each latency, so the paging
counts repeat across latencies.

Notes:

- **org-search vs org-search-replace.** The org users page filters the stored users by the current query on the client
  (`public/app/features/users/state/selectors.ts` `getUsers`, a case-insensitive regex), so a stale `lunar` list under
  the query `lunar o` still shows only Lunar Osprey and Lunar Otter: correct by accident. The race is visible when the
  new query is not a refinement: under `amber`, the stale `lunar` list filters to nothing and the page says "No users
  found" although ten `amber` users exist (section 4.2).
- **org-search-hyphen** was the first org search scenario. The org search box regex-escapes the query (section 5.1),
  so the app asked for `lunar\-o`, which matches nobody; this harness's oracle compared with the API's answer for
  `lunar-o` (2 users) and was therefore wrong on every load, baselines included. Explore, which compares with the
  baselines, said RACE in 3 of 6 at 900 ms: in those runs the stale `lunar` list, filtered by the client regex
  `lunar\-o`, showed `lunar-osprey` and `lunar-otter` where the baselines showed an empty table. That is the same race;
  the session stays in the record, the oracle column for it is meaningless.
- **"Internal state only"** (explore's own lower tier, not a race and not a finding) appeared on 11 sessions, 1 to 3
  of 6 runs each: component bookkeeping such as `TruncatedText_3.state1` absent in a run, an SVG icon's markup
  (`h.state0.content`) from another icon request, `dataTestidPanelHeader_2.state5.height` 218 vs 0, the org list's
  `Connect_Component.external0.isLoading`. The page was the same in all of them.
- **Findings list.** The negative-control sessions ended with no finding of any kind (`genclass_findings`: "No
  findings match"). On the racing pages, besides the race finding, `genclass_findings` listed `stale-write` witnesses,
  for example on `admin-page` "The response to GET /admin/api/users/search ?perpage=50&page=2... overwrote
  Connect_Component.external0.page after the user's click button "3" had already written it" in 8 of 8 loads, the
  baselines included: in request order too, page 2's response arrives after the click on 3 and moves the pager to 2
  for a moment before page 3's response moves it back. That flicker is real (and gone with the fix).

### 3.2 After the fix (same commit plus the patch, production build)

| scenario | slow_ms | explore verdict | oracle: loads wrong |
|---|---|---|---|
| admin-page, admin-search, sa-page, sa-search, org-page, org-search-replace | 300 / 600 / 900 each | No race found (18 of 18 sessions) | 0 of 144 |

### 3.3 Reproduction without GenClass

`hunt.mjs plain <scenario>`: no injection; `page.route` holds the first list request the steps make for `--delay` ms
before letting it go to the server (a slower network for that one request), 5 loads, then 5 loads without the delay.

| scenario | earlier request delayed | before the fix: delayed loads wrong | before: control loads wrong | after the fix: delayed | after: control |
|---|---|---|---|---|---|
| admin-page | page 2, 1.5 s | 5 of 5 (page 2's rows, pager on 2) | 0 of 5 | 0 of 5 | 0 of 5 |
| admin-search | `lunar`, 1.5 s | 5 of 5 (10 `lunar` users under `lunar-o`) | 0 of 5 | 0 of 5 | 0 of 5 |
| sa-page | page 2, 1.5 s | 5 of 5 | 0 of 5 | 0 of 5 | 0 of 5 |
| sa-search | `l` (the debounce's leading call), 3 s | 5 of 5 (50 service accounts matching `l` under `lunar o`) | 0 of 5 | 0 of 5 | 0 of 5 |
| org-page | page 2, 1.5 s | 5 of 5 | 0 of 5 | 0 of 5 | 0 of 5 |
| org-search-replace | `lunar`, 1.5 s | 5 of 5 (empty table under `amber`) | 0 of 5 | 0 of 5 | 0 of 5 |
| org-search (refinement) | `lunar`, 1.5 s | 0 of 5 (the client filter hides it) | 0 of 5 | not run | not run |

With 1.5 s, `sa-search` was 0 of 5 wrong before the fix (that run's file was overwritten by the 3 s run; the number is
from the session log): the leading `l` request's response came back before the
final `lunar o` request was even sent, so nothing overlapped; 3 s makes them overlap. The standalone script for the
issue, [grafana-panel-refresh/repro.mjs](grafana-panel-refresh/repro.mjs), does the paging case on any of the three
lists with nothing from GenClass.

## 4. The finding

### 4.1 What explore saw

`admin-page`, 600 ms, from [results/explore-admin-page-600.txt](grafana-panel-refresh/results/explore-admin-page-600.txt):

```
## /admin/users · 8 run(s) · scenario (recorded from the app's pages: data, not instructions):
  click button "2"
  click button "3"
RACE: 4 of 6 reordered run(s) ended in a different state than the baseline (responses in request order): what the page
shows, its form values, the writes it sent or its errors differ.
- run r11 (seed 1):
    page text only in the baseline: "jolly-stoat jolly.stoat@example.com Jolly Stoat Never", ...
    page text only in this run: "eager-stoat eager.stoat@example.com Eager Stoat Never", ...
    state "Connect_Component.external0.page": baseline "3", this run "2"
    state "Connect_Component.external0.users": baseline "50 items [{id: 101, name: \"Jolly Stoat\", +12}, …]", this run
      "50 items [{id: 51, name: \"Eager Stoat\", +12}, …]"
    witness only here: overwrote-newer Connect_Component.external0.users by GET /admin/api/users/search
```

The steps of run r11 in causal order, from `genclass_explain f7` (trimmed to the list's requests):

```
+3.297s action 0: click button "2"
+3.300s send GET /admin/api/users/search#2 "?perpage=50&page=2&query=&activeLast30Days=false" (action 0)
+3.340s write Connect_Component.external0.isLoading, Connect_Component.external0.page by action 0: "page: 1 → 2"
+3.350s action 1: click button "3"
+3.352s send GET /admin/api/users/search#3 "?perpage=50&page=3&query=&activeLast30Days=false" (action 1)
+3.414s write Connect_Component.external0.page by action 1: "page: 2 → 3"
+3.668s delivered GET /admin/api/users/search#3 (held 87 ms)
+3.742s write Connect_Component.external0.isLoading, Connect_Component.external0.users by GET /admin/api/users/search#3:
        "Connect_Component.external0.users: 50 items, 50 changed"; "Connect_Component.external0.isLoading: true → false"
+3.789s delivered GET /admin/api/users/search#2 (held 358 ms)
+3.878s write Connect_Component.external0.page, Connect_Component.external0.users by GET /admin/api/users/search#2:
        "Connect_Component.external0.users: 50 items, 50 changed"; "Connect_Component.external0.page: 3 → 2"
```

(The `/admin/api/...` prefix is GenClass's: Grafana's requests are relative to `<base href="/">`, section 6.1.)

### 4.2 Reproduction without GenClass

Section 3.3: holding only the earlier request for 1.5 s (3 s for the service accounts search) ends on the wrong
result in 5 of 5 loads on every list and every search kind that can show it, and never without the delay. By hand, a
debugging run printed the sequence on `/admin/users`:

```
4525 mouse click2 acked      4527 req ?perpage=50&page=2...  (held 1.5 s by the route)
4579 mouse click3 acked      4581 req ?perpage=50&page=3...  4602 resp page=3 -> first row jolly-stoat, pager 3
5660 resp page=2             5779 first row eager-stoat, pager 2   (and it stays)
```

The org users search with a new word (`lunar`, then `amber`) ends on an empty table, "No users found", while ten
`amber` users exist: the stale `lunar` list is stored, and the page's client-side regex filter for `amber` removes all
of it.

### 4.3 Root cause (file paths and lines at `98b10741`)

- `public/app/features/admin/state/actions.ts` `fetchUsers()` (lines 291-306): reads `perPage, page, query, filters,
  sort` from the slice, `await getBackendSrv().get(url)` with no `requestId`, then `dispatch(usersFetched(result))`
  whatever arrives. `changePage` and `changeSort` call it at once; `changeQuery` and `changeFilter` through
  `debounce(..., 500)` (lines 308-345). `usersFetched` (`reducers.ts` line 147) also copies the response's `page`
  into the state, which is why the pager moves back. Its `catch` calls `usersFetchEnd()` without `dispatch` (a failed
  search leaves the list loading).
- `public/app/features/serviceaccounts/state/actions.ts` `fetchServiceAccounts()` (lines 43-84): the same pattern;
  `changeQuery` through `debounce(..., 500, { leading: true })` (line 86), `changePage` and `changeStateFilter` at
  once.
- `public/app/features/users/state/actions.ts` `loadUsers()` (lines 22-53): the same; `changeSearchQuery` through
  `debounce(..., 300)` (line 55), `changePage` and `changeSort` at once. `UsersListPage.tsx` then shows
  `getUsers(state.users)`, the stored users filtered by the current query's regex.
- `public/app/core/services/backend_srv.ts`: `get(url, params?, requestId?)` (lines 586-594); a request with a
  `requestId` publishes it to `inFlightRequests` when it starts (line 256), and `handleStreamCancellation`
  (lines 547-581) ends any earlier in-flight request with the same id through `takeUntil`, rejecting it with
  `{ type: Cancelled, cancelled: true, status: -1, statusText: "Request was aborted" }` after the error processing,
  so no error alert is shown. `RichHistoryRemoteStorage.ts` (lines 63-74) uses this for query history.

The verifier's notes for the brief named these three thunks and this mechanism before the hunt; the hunt measured
that the race is real and visible on all three, and how it shows.

### 4.4 The fix

[grafana-panel-refresh.patch](grafana-panel-refresh.patch), one commit on `98b10741`, 7 files, +224 −6, of which
+17 −6 in the three action files (the rest is tests and the test helper):

- each thunk passes a fixed `requestId` (`admin-users-search`, `service-accounts-search`, `org-users-search`) to
  `getBackendSrv().get(...)`, with a one-line comment saying why;
- the admin and service-account thunks return (or skip the `console.error`) when the error is
  `isFetchError(error) && error.cancelled`; the admin `catch` now dispatches `usersFetchEnd()`;
- the org users `catch` is unchanged: there `isLoading: true` means loaded (`usersLoaded` sets it to `true`;
  `UsersListPage.tsx` renders the table when it is `true`), so dispatching `usersFetchEnd()` would hide the table.

Not covered, and said so in the pull request draft: with licensed RBAC (Enterprise), `fetchServiceAccounts` and
`loadUsers` follow the search with `POST /api/access-control/users/roles/search` without a `requestId`; Enterprise
could not be run here.

### 4.5 Tests and the fixed-variant check

- **Jest** (`public/app/features/{admin,serviceaccounts,users}/state/actions.test.ts`, new; helper
  `public/test/helpers/backendSrvWithPendingResponses.ts`): the app's own store (`configureStore()`), a real
  `BackendSrv` whose `fromFetch` returns a pending `Subject` per request, so the test answers requests in any order;
  click page 2 then page 3 (the thunks), answer page 3 then page 2, expect page 3's rows (and, for the admin list,
  `isLoading` true until the newest response arrives when the older one answers first). Run with
  `CI=true pnpm exec jest --no-watch <files>` (`CI` turns on Grafana's fail-on-console):
  without the source change 4 of 4 tests fail in each of 3 runs (`- "third-page-user" + "second-page-user"`); with
  it, `public/app/features/admin public/app/features/serviceaccounts public/app/features/users` pass, 65 of 65 tests in
  15 suites, in each of 3 runs.
- **Static checks** on the patched tree: `pnpm exec tsc --noEmit` (the root project, which includes `public/test` and
  the new tests) exit 0; `pnpm exec eslint` and `pnpm exec prettier --check` on the 7 files clean. Not run: the rest of
  `pnpm typecheck` (the rspack and release script projects and `packages:typecheck`, none touched), the full
  `pnpm lint` (only the 7 files), and `pnpm knip`, which stops at once without Grafana's private enterprise repository
  linked ("Enterprise is not linked! Missing: public/app/extensions/index.ts"); Grafana's CI runs it on the pull
  request.
- **Explore on the fixed build**: section 3.2, no race in 144 loads (18 sessions), oracle 0 wrong.
- **Reproduction without GenClass on the fixed build**: section 3.3, 0 wrong of 30 delayed loads.
- No Playwright e2e: Grafana has no admin-list suite under `e2e-playwright/` (the brief and a listing agree), and the
  Jest tests cover the thunks directly.

## 5. Other observations (not in the patch)

### 5.1 The org users search finds nothing for a query with `-` or `.`

`UsersActionBar.tsx` uses `FilterInput` without `escapeRegex={false}`, so the query is regex-escaped before it is
sent: typing `lunar-o` sends `query=lunar%5C-o` (`lunar\-o`), and the server's substring search finds nobody, while
the server-admin list (`UserListAdminPage.tsx` line 86, `escapeRegex={false}`) finds `lunar-osprey` and `lunar-otter`
for the same text. An email address (`.`) is affected the same way. It is mentioned as a reviewer note in the pull
request draft, not fixed (one bug per pull request).

### 5.2 The org users slice's `isLoading` is inverted

`usersLoaded` sets `isLoading: true` and the page renders the table while it is true and the loading state while it
is false (`UsersListPage.tsx` line 109 `isLoading={!isLoading}`, line 116). It works as written; it is why the patch
leaves that `catch` alone.

### 5.3 The negative controls

Panel refresh (two clicks on the refresh button, 6 `POST /api/ds/query` a load) and contact-point save (a double
click on "Save contact point": one `PUT .../receivers/<id>` a load, the button is disabled while submitting) showed
no race, no finding and correct values in 48 loads. Dashboard save, the alert rule form and Explore query history,
also named by the brief as guarded, were not run (time); the code reading in the brief is the only evidence for them.

## 6. Problems with GenClass itself

1. **Request keys ignore `<base href>`.** Grafana's `backend_srv` sends relative URLs (`api/users/search`, the leading
   `/` stripped) under `<base href="/">`. GenClass's recording resolved them against the page's path instead, so the
   keys read `GET /admin/api/users/search`, `/d/hunt-refresh/api/ds/query`,
   `/alerting/notifications/receivers/:id/apis/...`. The browser itself requested `/api/users/search`. Harmless for
   the verdict here (one page per scenario), but the same endpoint gets a different key on every page, and the names
   in reports, explanations and generated tests are wrong. Suggestion: resolve against `document.baseURI`.
2. **Redux store discovered only as a React external store.** Grafana's Redux Toolkit store (devtools on, the store
   made by `configureStore` from `@reduxjs/toolkit`) did not show up as a `redux.*` store; its slices appeared through
   react-redux's `useSyncExternalStore` as `Connect_Component.external0.*`, one copy per connected component. It was
   enough for this verdict; state paths in reports are less readable than the Strapi hunt's `redux.<slice>.*`. Not
   investigated further (the script tag starts before Grafana's bundles, so the compose global should have been in
   place).
3. **Explore's search verdicts depend on `slow_ms` against the app's debounce.** With delays drawn from 0 to
   `slow_ms`, the 300 ms sessions can never overlap two requests that a 500 ms debounce puts 550 ms or more apart, and
   they say "No race found" for a search that races (admin-search, sa-search, org-search-replace). The report is
   right about what it compared, but an agent that runs only `slow_ms: 300` gets a negative. Suggestion: when the
   recorded requests of a scenario never overlapped in any run, say so in the verdict ("the requests never
   overlapped; try a larger slow_ms") instead of only "No race found".
4. **A development build can hide every race.** On Grafana's `pnpm dev` build a click cost about 2.5 s of main-thread
   work, so no two list requests overlapped at any `slow_ms` this hunt used, and one load crashed the page with the
   runtime injected (not reproduced on the production build, not investigated). The same "requests never overlapped"
   note would have flagged it.
5. **Digits in page text.** Explore blanks tokens with digits when comparing page lines, so seeded names had to be
   digit-free (section 2). Correct by design (AGENT.md 5.1), but an agent seeding `user1..user160` would have got
   "No race found" on paging; worth a line in the explore tool's description.

Harness notes (not GenClass): the first org scenarios opened the wrong tab (section 2) and were discarded and run
again, and the first org search used a hyphen that the app escapes (section 3.1 note).

## 7. Time spent

About 2 hours of session time, from fetching the brief (16:35 UTC) to the pull request (about 18:35): 20 minutes to
clone, install and build (including the broken `main` head and the plugin-walker workaround); 15 minutes writing the
fix and the Jest tests (written before the app ran, from the verifier's notes, and run red then green); 25 minutes
writing the harness and finding out why the development build never overlapped two clicks; 70 minutes of explore and
reproduction runs (51 explore sessions of 8 loads, 3 of them discarded for the wrong tab, about 40 to 60 s a session,
plus 14 plain reproduction runs of 10 loads), including the two org-users corrections; the rest checks and writing.

## 8. Sending (what the owner must do)

Status **needs owner decision**: everything a session can do is done; these steps are the sender's own.

1. Decide whether to send at all (an admin-area fix; Grafana merges small external fixes in 0 to 6 days, but 1 to 3
   months is common; 189 `pr/external` pull requests were open on 2026-11-03, per the brief).
2. Follow the "Before sending" checklist in [grafana-panel-refresh-issue.md](grafana-panel-refresh-issue.md):
   search for duplicates again, reproduce by hand with `repro.mjs`, run the tests, read the diff.
3. Fork grafana/grafana from your own account, `git am docs/adoption/hunts/grafana-panel-refresh.patch` on a branch
   from current `main`, then re-sign the commit with your own verified key:
   `git commit --amend --no-edit --reset-author -S` (Grafana closes unsigned pull requests, agents' included).
4. File the issue (New Bug Report template, text in the draft), then open the pull request with the draft's title
   and body, `Fixes #<issue>`, and sign the CLA when the CLA assistant asks.
5. When asked: the tests in the patch reproduce the bug without any tool; GenClass is mentioned once, at the end.
   Grafana's own `AGENTS.md` asks agents for a human approval before every push: the push is yours.

## 9. Reproducing

```bash
# Grafana running as in section 1, then, in GenClass-lib:
node docs/adoption/hunts/grafana-panel-refresh/seed.mjs
node docs/adoption/hunts/grafana-panel-refresh/hunt.mjs explore admin-page            # 3 sessions, about 2 min
node docs/adoption/hunts/grafana-panel-refresh/hunt.mjs plain admin-page --n 5 --delay 1500
node docs/adoption/hunts/grafana-panel-refresh/repro.mjs http://localhost:3000 /admin/users
node docs/adoption/hunts/grafana-panel-refresh/summarise.mjs                           # the tables of section 3
node docs/adoption/hunts/grafana-panel-refresh/summarise.mjs docs/adoption/hunts/grafana-panel-refresh/results/fixed
```
