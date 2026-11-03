# Race hunt: Tandoor Recipes' Vue 3 frontend (2.7.2, develop at `cbb96e1`)

A GenClass race hunt on [Tandoor Recipes](https://github.com/TandoorRecipes/recipes), run on 2026-11-03 in a cloud
session of the adoption swarm (`docs/adoption/swarm.md`, slug `tandoor-recipes`). The real `@genclass/runtime` (this
repository at `c1c9e14`, `0.3.0-beta.5`) was injected into Tandoor's pages by Playwright and the real `@genclass/mcp`
(`0.2.1`) was driven the way a coding agent drives it. Tandoor's source was not modified for the hunt; the fixes are
a patch for its maintainers (`tandoor-recipes.patch`, the issue and pull request drafts in
`tandoor-recipes-issue.md`). Nothing was sent to Tandoor's repository, tracker, chat or maintainers.

**Headline.** Two real bugs, each found by explore and reproduced without GenClass:

1. **The shopping list can drop an uncheck.** If a person checks two items and then unchecks the first one while
   the first two updates are still in flight, the uncheck is never sent. The server keeps the item checked while the
   page shows it unchecked, so a reload or another device of the household shows it checked again. The other item's
   update is sent a second time instead. Cause: `ShoppingStore._replaySyncQueue` removes each finished entry from the
   sync queue by the index it had when the run started (`splice(index, 1)` inside an async `.then`). Explore reported
   a RACE at every latency (6, 4 and 6 of 6 reordered loads at 300, 600 and 900 ms). By my oracle the uncheck was
   lost in 3 of 6 seeded loads at 300 ms, in 1 of 6 and both request-order baselines at 600 ms, and in 3 of 6 at
   900 ms. A plain Playwright script that delivers the two responses in request order right after the third tap
   reproduces it in 5 of 5 runs.
2. **Lists show the response that lands last, not the latest one.** On the recipe search, "page 2, then page 1" can
   end with page 2's recipes under "page 1". On every generic model list (`/list/<Model>`), "next page" twice can end
   with page 2's rows under the "21-30" footer. In every model select (the keyword, food, unit and recipe pickers in
   the editors), typing "b", pausing, then "read" can leave the menu listing the five matches for "b". Explore
   reported the two pagination cases at all three latencies (search: 2, 3 and 3 of 6; foods list: 4, 4 and 4 of 6),
   with my oracle agreeing load for load and each replay reproducing. A script that only slows one response by
   800 ms reproduces each of the three in 5 of 5 runs. The picker case is real (my oracle: 1 of 6 at 600 ms and at
   900 ms; the GenClass witness `overwrote-newer visible.pickerItems by GET /api/keyword/#1`), but explore put it in
   the internal-only tier because Vuetify's menu is an `aria-live` listbox (section 7, a false negative).

With the two-commit patch applied (`ShoppingStore.ts`, `SearchPage.vue`, `ModelListPage.vue`, `VModelSelect.vue`; 52
lines added, 13 removed), all four plain reproductions are wrong in 0 of 5 runs. Explore on the fixed build reports
no race in the sessions listed in section 3. Tandoor's vue3 has no test framework (`vue3/package.json` has only
`dev`, `build` and `preview`; its contribution guidelines ask for someone to set one up). So the regression check
that goes with the patch is the plain Playwright script `tandoor-recipes/repro.mjs`, run against the unfixed and
the fixed build, plus exact manual steps in the drafts. I did not add a test harness to Tandoor: its guidelines'
"Discuss First!" rule covers that.

Sections: 1 setup, 2 how Tandoor was driven, 3 scenarios and verdicts, 4 finding 1 (shopping list), 5 finding 2
(stale list responses), 6 fixed-variant check, 7 problems with GenClass itself, 8 what was not run, 9 time spent,
10 reproducing.

## 1. Setup

| what | version |
|---|---|
| Tandoor Recipes | `develop` at `cbb96e151fe0c57c16a4456fe1bd04230b1c1e5c` (2026-10-27, "Merge branch 'master' into develop"; `git describe`: 2.7.2 plus one merge commit), the commit the patch is against |
| frontend | Vue 3.5.44, Vuetify 3.13.7, Pinia 4.1.0, Vite 8.3.5 (`yarn build`, production bundle served by Django) |
| backend | Django 5.2.18 on Python 3.12.3, SQLite (`db.sqlite3`, no database env vars), `DEBUG=1 python manage.py runserver 127.0.0.1:8000` |
| Node, Yarn | 22.23.4, 1.22.22 |
| browser | Chromium 1243 (headless shell), Playwright 1.63.0 |
| GenClass | `@genclass/runtime` 0.3.0-beta.5 and `@genclass/mcp` 0.2.1 from this repository at `c1c9e14`, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |

Commands, in order (the brief's commands, with the corrections the run needed):

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# Tandoor, in its own directory
git clone https://github.com/TandoorRecipes/recipes ~/targets/tandoor && cd ~/targets/tandoor   # develop
apt-get update && apt-get install -y python3.12-venv python3.12-dev build-essential pkg-config libsasl2-dev \
  libldap2-dev libssl-dev libxml2-dev libxslt1-dev libxmlsec1-dev libxmlsec1-openssl   # needs apt-get update first
/usr/bin/python3.12 -m venv venv && . venv/bin/activate && pip install -r requirements.txt   # CI's Python 3.12
python manage.py migrate
(cd vue3 && yarn install && yarn build)     # production bundle into cookbook/static/vue3/
DEBUG=1 python manage.py runserver 127.0.0.1:8000 --noreload
# first user: POST the /setup/ form (name hunt), which also creates the space

# the hunt (this repository)
node docs/adoption/hunts/tandoor-recipes/seed.mjs
```

Notes from the run: the container's default `python3` is 3.13, so the venv was made with `/usr/bin/python3.12` to
match CI. With no Vite dev server on :5173, django-vite stays in production mode even with `DEBUG=1`
(`recipes/settings.py` ~627-636), so the hunt ran on the shipped bundle. Login is allauth's headless API
(`POST /_allauth/browser/v1/auth/login`, the Vue login page does the same). It is rate-limited (HTTP 429 after a few
logins a minute), so the harness reuses one saved session. The first-run wizard (`WelcomePage.vue`) takes over every
page until the space has a household and `space_setup_completed`; `seed.mjs` sets both the way the wizard does.

Seed (`seed.mjs`, through the REST API): 38 foods and 20 keywords whose names share prefixes, 72 recipes (so the
search has two pages at its default 50 per page), and 6 shopping list entries. Names hold no digits, because the
explore verdict blanks digit tokens in page lines.

## 2. How Tandoor was driven

`tandoor-recipes/hunt.mjs`, adapted from the Vikunja harness. A Playwright route rewrites each HTML page Django
serves to load the script-tag build (`packages/runtime/dist/genclass.global.js`) in observe mode, with the model,
telemetry, visual checks and devtools off, and connects the agent link (`dist/agent.js`) to an MCP server started in
the same process (`serve()` from `packages/mcp/dist/index.js`, bridge on a free port). Requests to anything but
localhost are aborted; service workers are blocked. Tandoor keeps its state in Pinia stores and component refs,
which GenClass does not discover, so the injected script registers one atom, `visible`, that a `MutationObserver`
fills with what the regions under test show:
- `pickerItems`: the open menu's item titles;
- `results` and `page`: the search page's card names and active page;
- `rows` and `footer`: the model list's name column and its footer;
- `entries`: the shopping list's entries.

The explore verdict compares that atom besides the page text, form values, writes and errors.

For each scenario and latency: `genclass_clear`, `genclass_explore start {runs: 6, slow_ms}`, eight page loads (two
request-order baselines, six seeded orders), the same steps each load, `whenSettled()` after the steps, then
`genclass_explore report`. On a RACE verdict the harness also calls `genclass_explain` and `genclass_replay arm` with
one more load and then `genclass_replay result`. Next to GenClass, each load reads an oracle of its own after the
page settled: what the page shows against what the person's last step asked for (for the lists and the picker), and
the server's entries plus the bulk requests on the wire (for the shopping list). Shopping scenarios reset the
entries through the API before each load, outside the browser.

The scenarios:

| scenario | page | steps | oracle |
|---|---|---|---|
| picker | `/edit/Recipe/<id>`, the Keyword select (`VModelSelect`) | click it, type `b`, wait 450 ms, type `read` | every menu item contains the typed text |
| search-pages | `/advanced-search` | "Go to page 2", then "Go to page 1" | the first card is page 1's first recipe |
| list-pages | `/list/Food` | "Next page" twice | the first row is page 3's first food |
| shopping-check | `/shopping` | tap carrot's check, tap garlic's | both checked on the server, 2 bulk requests |
| shopping-uncheck | `/shopping`, checked entries shown | tap carrot, tap garlic, wait 300 ms, tap carrot again | server: carrot unchecked, garlic checked |

## 3. Scenarios and verdicts

Every verdict is the explore report's own wording, reduced to counts (`results.json` has the same rows;
`summarise.mjs` regenerates both from the session files). "Internal only" and "along the way" are the report's other
two tiers. "Own oracle wrong" counts the loads my oracle found wrong. Every session compared 6 of 6 reordered runs
against two baselines, and no session had a forced delivery.

| scenario | slow_ms | variant | explore verdict | internal only | along the way | own oracle wrong (seeded) | own oracle wrong (baselines) | replay | forced |
|---|---|---|---|---|---|---|---|---|---|
| picker | 300 | unfixed | No race found (compared 6 of 6) | 0 | 0 | 0 of 6 | 0 of 2 | none | 0 |
| picker | 600 | unfixed | No race found (compared 6 of 6) | 1 | 0 | 1 of 6 | 0 of 2 | none | 0 |
| picker | 900 | unfixed | No race found (compared 6 of 6) | 1 | 0 | 1 of 6 | 0 of 2 | none | 0 |
| search-pages | 300 | unfixed | RACE: 2 of 6 (compared 6 of 6) | 0 | 0 | 2 of 6 | 0 of 2 | reproduced (oracle wrong) | 0 |
| search-pages | 600 | unfixed | RACE: 3 of 6 (compared 6 of 6) | 0 | 0 | 3 of 6 | 0 of 2 | reproduced (oracle wrong) | 0 |
| search-pages | 900 | unfixed | RACE: 3 of 6 (compared 6 of 6) | 0 | 0 | 3 of 6 | 0 of 2 | reproduced (oracle wrong) | 0 |
| list-pages | 300 | unfixed | RACE: 4 of 6 (compared 6 of 6) | 0 | 0 | 4 of 6 | 0 of 2 | reproduced (oracle wrong) | 0 |
| list-pages | 600 | unfixed | RACE: 4 of 6 (compared 6 of 6) | 0 | 0 | 4 of 6 | 0 of 2 | reproduced (oracle wrong) | 0 |
| list-pages | 900 | unfixed | RACE: 4 of 6 (compared 6 of 6) | 0 | 0 | 4 of 6 | 0 of 2 | reproduced (oracle wrong) | 0 |
| shopping-check | 300 | unfixed | RACE: 3 of 6 (compared 6 of 6) | 1 | 1 | 3 of 6 | 2 of 2 | reproduced (oracle correct) | 0 |
| shopping-check | 600 | unfixed | RACE: 3 of 6 (compared 6 of 6) | 1 | 1 | 3 of 6 | 2 of 2 | reproduced (oracle correct) | 0 |
| shopping-check | 900 | unfixed | RACE: 3 of 6 (compared 6 of 6) | 1 | 1 | 3 of 6 | 2 of 2 | reproduced (oracle correct) | 0 |
| shopping-uncheck | 300 | unfixed | RACE: 6 of 6 (compared 6 of 6) | 0 | 0 | 3 of 6 | 0 of 2 | not reproduced (oracle correct) | 0 |
| shopping-uncheck | 600 | unfixed | RACE: 4 of 6 (compared 6 of 6) | 2 | 0 | 1 of 6 | 2 of 2 | reproduced (oracle correct) | 0 |
| shopping-uncheck | 900 | unfixed | RACE: 6 of 6 (compared 6 of 6) | 0 | 0 | 3 of 6 | 0 of 2 | reproduced (oracle correct) | 0 |
| picker | 300 | fixed | No race found (compared 6 of 6) | 0 | 0 | 0 of 6 | 0 of 2 | none | 0 |
| picker | 600 | fixed | No race found (compared 6 of 6) | 0 | 0 | 0 of 6 | 0 of 2 | none | 0 |
| picker | 900 | fixed | No race found (compared 6 of 6) | 0 | 0 | 0 of 6 | 0 of 2 | none | 0 |
| search-pages | 300 | fixed | No race found (compared 6 of 6) | 0 | 0 | 0 of 6 | 0 of 2 | none | 0 |
| search-pages | 600 | fixed | No race found (compared 6 of 6) | 0 | 0 | 0 of 6 | 0 of 2 | none | 0 |
| search-pages | 900 | fixed | No race found (compared 6 of 6) | 0 | 0 | 0 of 6 | 0 of 2 | none | 0 |
| list-pages | 300 | fixed | No race found (compared 6 of 6) | 0 | 0 | 0 of 6 | 0 of 2 | none | 0 |
| list-pages | 600 | fixed | No race found (compared 6 of 6) | 0 | 0 | 0 of 6 | 0 of 2 | none | 0 |
| list-pages | 900 | fixed | No race found (compared 6 of 6) | 0 | 0 | 0 of 6 | 0 of 2 | none | 0 |
| shopping-check | 300 | fixed | No race found (compared 6 of 6) | 3 | 1 | 0 of 6 | 0 of 2 | none | 0 |
| shopping-check | 600 | fixed | No race found (compared 6 of 6) | 3 | 1 | 0 of 6 | 0 of 2 | none | 0 |
| shopping-check | 900 | fixed | No race found (compared 6 of 6) | 3 | 1 | 0 of 6 | 0 of 2 | none | 0 |
| shopping-uncheck | 300 | fixed | No race found (compared 6 of 6) | 3 | 1 | 0 of 6 | 0 of 2 | none | 0 |
| shopping-uncheck | 600 | fixed | No race found (compared 6 of 6) | 3 | 1 | 0 of 6 | 0 of 2 | none | 0 |
| shopping-uncheck | 900 | fixed | No race found (compared 6 of 6) | 3 | 1 | 0 of 6 | 0 of 2 | none | 0 |

Reading the table:
- **search-pages, list-pages**: GenClass and the oracle agree load for load. Every RACE run is a run the oracle
  found wrong and vice versa, and every replay reproduced the wrong page.
- **picker**: the oracle found the stale menu in 1 of 6 seeded loads at 600 ms and at 900 ms, and none at 300 ms.
  Explore said "No race found" each time and listed the same run under "Internal state only", with the menu's
  items as "announcements". That is a GenClass false negative (section 7.1). The low rate is how often a seeded
  order lets the `b` response arrive last: both searches are sent about 450 ms apart.
- **shopping-check**: the request-order baselines send 3 bulk requests for 2 taps (garlic's is re-sent, the
  stale-index bug of section 4). Seeded orders that deliver garlic's response first send 2. Explore calls the
  2-request runs the "failing" ones; the oracle shows the baselines are wrong. The re-send is harmless on its own
  (the same `checked: true` again).
- **shopping-uncheck**: the harmful form of the same bug. In a lost run the server ends with carrot checked,
  garlic's request is sent twice and `{"ids":[carrot],"checked":false}` is never sent. That happened in seeds 2, 4
  and 6 at 300 ms; in both baselines and seed 2 at 600 ms; and in 3 of 6 at 900 ms. Which runs explore calls
  "failing" depends on the baselines. At 300 ms the baselines sent the uncheck twice (5 requests), so all 6
  reordered loads differ, the correct and the broken ones alike. At 600 ms the baselines were the broken ones. At
  900 ms they were correct. The replay at 300 ms said "not reproduced" (the replayed load ended correct). Either way
  every session reported a RACE on the bulk-request count, and the oracle names the loads that lost the uncheck.

## 4. Finding 1: the shopping list's sync queue drops a change made while it runs

### 4.1 What the user sees

Shopping list, three taps within about a second: check carrot, check garlic, uncheck carrot (a mis-tap corrected).
The page shows carrot unchecked. The server has carrot checked. A reload, the auto-sync of another device in the
household or the next visit shows carrot checked again. The person's last action is lost without any message.

### 4.2 What explore saw (shopping-uncheck, 600 ms, `explain` of finding f2, abridged)

```
+2.392s action 0: click button
+2.456s action 1: click button
+2.557s send POST /api/shopping-list-entry/bulk/#1 "{ids: [1], checked: true}" (action 1) via timer 100ms
+2.558s send POST /api/shopping-list-entry/bulk/#2 "{ids: [1], checked: true}" (action 1) via timer 100ms
+2.807s action 2: click button
```

The two taps leave as two bulk requests 100 ms after the second tap (`runSyncQueue(100)`). The third tap queues a
third entry while both are in flight. (GenClass printed `ids: [1]` for both bodies; Playwright saw `[1]` and `[3]`,
section 7.3.) What the wire carried in each load (`sent` in the session file):

| load | schedule | bulk requests sent, in order | server after |
|---|---|---|---|
| 0, 1 | request order (baselines) | carrot true, garlic true, garlic true | carrot **checked**, garlic checked |
| 3 | seed 2 | carrot true, garlic true, garlic true | carrot **checked**, garlic checked |
| 2, 4, 5 | seeds 1, 3, 4 | carrot true, garlic true, carrot true, garlic true, carrot false | carrot unchecked, garlic checked |
| 6 | seed 5 | carrot true, garlic true, carrot false | carrot unchecked, garlic checked |
| 7 | seed 6 | carrot true, garlic true, garlic true, carrot false | carrot unchecked, garlic checked |

### 4.3 Reproduction without GenClass

`tandoor-recipes/repro.mjs shopping` is plain Playwright with nothing of GenClass. It resets the six entries to
unchecked through the API and turns on the list's own "show checked entries" device setting so carrot can be tapped
again. It taps carrot and then garlic. The route holds the responses of those two bulk requests until it has tapped
carrot a third time, then delivers them in request order, 30 ms apart. It then reads the server's entries.

```
shopping run 1: WRONG: server carrot=checked garlic=checked; page shows carrot unchecked; bulk requests sent: {"ids":[1],"checked":true} {"ids":[3],"checked":true} {"ids":[3],"checked":true}
...
shopping: wrong in 5 of 5
```

With both held responses released at the same moment instead (an earlier version of the script), it was wrong in 3
of 5: the server then decides which answer lands first, which is the order dependence explore found.

### 4.4 Root cause (`vue3/src/stores/ShoppingStore.ts` at `cbb96e1`)

`setEntriesCheckedState` (~line 450) applies the change locally, pushes `{ids, checked, status: 'waiting'}` onto
`itemCheckSyncQueue` and calls `runSyncQueue(100)`. `_replaySyncQueue` (~line 480) sends one bulk request per queue
entry:

```ts
itemCheckSyncQueue.value.forEach((entry, index) => {
    ...
    let p = api.apiShoppingListEntryBulkCreate({shoppingListEntryBulk: entry}, {}).then((r) => {
        ...
        itemCheckSyncQueue.value.splice(index, 1)
```

`index` is the entry's position when the run started, and it is used after the request finished. Queue `[carrot,
garlic]` plus the uncheck makes `[carrot, garlic, uncheck]`. Carrot's response removes index 0, leaving
`[garlic, uncheck]`. Garlic's response removes index 1, which is now the **uncheck**, so it is never sent. Garlic
stays and is re-sent 500 ms later by the `finally`'s `runSyncQueue(500)`. When the uncheck's own 100 ms timer fires
before the first responses arrive, a second run starts while the first is in flight and re-sends every entry still
queued, carrot's `checked: true` included, concurrently with the uncheck (the 5-request loads). The comment above
the function says "always call using runSyncQueue method to prevent simultaneous runs", but `runSyncQueue` only
debounces the timer; nothing stops a run while another is in flight.

### 4.5 The fix (`tandoor-recipes.patch`, commit 1, 20 lines added, 3 removed)

- `removeFromSyncQueue(entry)` looks the finished entry up again (`indexOf`) and removes that entry, in both the
  success and the non-network-error path.
- `_replaySyncQueue` returns at once while `syncQueueRunning` is true. The running batch already calls
  `runSyncQueue(500)` in its `finally` when entries remain, so changes made meanwhile are sent after it, in the order
  they were made.

Offline handling is unchanged: a `FetchError` keeps the entry with status `waiting_failed_before`, and the existing
retry path sends it again. One behaviour change to name in the PR: a change made while a batch is in flight now
waits for that batch, at most until its requests settle.

## 5. Finding 2: lists show the response that lands last

### 5.1 What explore saw

Recipe search, 600 ms, finding f1 (abridged):

```
+2.129s action 0: click button "Go to page 2"
+2.136s send GET /api/recipe/#2 "?page=2&page_size=50&query=" (action 0)
+2.227s action 1: click button "Go to page 1"
+2.231s write visible.page by action 1: "visible.page: \"2\" → \"1\""
+2.231s send GET /api/recipe/#3 "?page=1&page_size=50&query=" (action 1)
+2.570s delivered GET /api/recipe/#3 (held 295 ms)
+2.626s delivered GET /api/recipe/#2 (held 431 ms)
+2.724s write visible.results by GET /api/recipe/#2: "Alpine bake | Alpine curry | A…" → "Island pie | Island salad | Is…"
```

Evidence: the page shows "Island pie", "Island salad", "Island soup" (page 2) instead of "Alpine bake" (page 1);
replay r9: REPRODUCED. The foods list (finding f2 of its session) is the same shape: footer "21-30 of 38" set by the
second click, rows "cheese | cherry | chervil" (page 2) instead of "chipotle | chives | chocolate" (page 3), witness
`overwrote-newer visible.rows by GET /api/food/`, replay reproduced. The picker: witness
`overwrote-newer visible.pickerItems by GET /api/keyword/#1`, menu "baking | barbecue | bread | breakfast | brunch"
for the input "bread".

### 5.2 Reproduction without GenClass

`repro.mjs search|list|picker`: plain Playwright. Each case slows one response by 800 ms (page 2 of the search,
page 2 of the foods list, the keyword search for `b`) and takes the steps of section 2:

```
search: wrong in 5 of 5   pagination shows page 1; first result "Island pie" (page 1 starts with "Alpine bake")
list: wrong in 5 of 5     footer "21-30 of 38"; first row "cheese" (page 3 starts with "chipotle")
picker: wrong in 5 of 5   typed "bread"; menu lists ["baking","barbecue","bread","breakfast","brunch"]
```

### 5.3 Root cause (at `cbb96e1`)

- `vue3/src/pages/SearchPage.vue` `searchRecipes` (~279-311) and `vue3/src/pages/ModelListPage.vue` `loadItems`
  (~246-266) pass `signal.value` from `useDebouncedSearch` and assign `recipes.value` / `items.value` from whichever
  response resolves. The composable (`vue3/src/composables/useDebouncedSearch.ts`) aborts and replaces the signal only
  when the debounced search text changes (`applyDebouncedValue`, `reset`, route changes). Page changes, the per-page
  select, filters and the Search button all reuse one signal, so two quick changes leave two requests in flight and
  the older one can win. `loading` is cleared by whichever finishes first.
- `vue3/src/components/inputs/VModelSelect.vue` `searchItems` (~279-316): a 300 ms `useDebounceFn` (commented
  "debounce search to prevent race conditions") is the only guard. There is no abort and no sequence check, and
  `items.value = r.results` takes whichever response lands last. A pause of more than 300 ms while typing sends two
  searches.

### 5.4 The fix (`tandoor-recipes.patch`, commit 2, 32 lines added, 10 removed)

- `SearchPage.vue` and `ModelListPage.vue`: call the composable's existing `abort()` at the start of each search or
  page load, so the request still in flight is aborted and this one gets a fresh signal. Keep the request's own
  signal and clear `loading` (and, on the search page, scroll to the top) only if it was not aborted.
  `ModelListPage`'s `catch` now also ignores an abort wrapped in the generated client's `FetchError` (`err.cause`),
  as `SearchPage`'s already did. Otherwise every aborted page load would show a fetch error.
  `toast-check.mjs` (fixed build, page 2 slowed by 800 ms, two quick page changes) found no snackbar and no console
  error on either page.
- `VModelSelect.vue`: a counter (`searchRequestCount`). A response that is not the latest search's is ignored, and
  the latest one clears `loading`.

## 6. Fixed-variant check

The patch was applied to the clone (`git am`-able, `tandoor-recipes.patch`), the bundle rebuilt with `yarn build`
and Django restarted.

- Plain reproductions on the fixed build: `repro.mjs all 5` gave `{"shopping":"wrong in 0 of 5","search":"wrong in
  0 of 5","list":"wrong in 0 of 5","picker":"wrong in 0 of 5"}`. In the shopping runs the third request is
  `{"ids":[1],"checked":false}` and the server keeps carrot unchecked.
- Explore on the fixed build: the "fixed" rows of section 3. All 15 fixed sessions (5 scenarios at 300, 600 and 900
  ms, 90 seeded loads and 30 baselines) say "No race found", with 0 loads my oracle found wrong and no forced
  delivery. That is 0 RACE reports on the fixed build in 15 sessions, which is the false-report rate of this run next
  to the 12 RACE sessions on the unfixed build (of 15). The fixed shopping sessions list 3 runs each under "Internal
  state only": the number of `GET /api/shopping-list-entry/` auto-sync polls differs with timing, which is the
  internal tier working as documented.
- `yarn build` succeeds on the fixed tree. Tandoor has no frontend type-check or lint script: the Vite build
  type-strips without checking, and `vue-tsc` is not a dependency. The backend is untouched, so its pytest suite
  was not run.
- Formatting: the project's `.prettierrc` (`tabWidth: 2`) does not match the files as they are (4 spaces). Prettier
  3.3.3 with that config would rewrite 529 to 1,606 lines of each of the four files at `cbb96e1`. The patch therefore
  follows the files' existing style (4 spaces, no semicolons) and does not run prettier over them.

## 7. Problems with GenClass itself

### 7.1 A Vuetify select's stale results are classified as announcements (false negative)

On the picker, the stale menu was the only difference, and GenClass recorded the right witness
(`overwrote-newer visible.pickerItems by GET /api/keyword/#1`). Yet the verdict was "No race found", with the run
listed under "Internal state only" as "announcements (status, alert regions) only in one of them: "breakfast",
"baking", "barbecue"". `aria-probe.mjs` shows why: Vuetify 3.13 renders the autocomplete menu as
`div.v-list role=listbox aria-live=polite`. The verdict treats every line inside an `aria-live` region as an
announcement (AGENT.md section 5.1, so a toast that expires is not a race). A listbox with `aria-live` is a control
the person reads and picks from, not a toast. Every Vuetify autocomplete, combobox and select menu (and any
component library that marks its listbox live) has the same blind spot. A narrower rule, such as treating `role=status`, `alert`,
`log` and `aria-live` on elements whose role is not `listbox`, `grid` or `menu` as announcements, would have
reported this run. That is a product decision with its own false-report cost to measure, so this report only
records it.

### 7.2 When the request-order baseline is the bug, the generated test pins the bug

In the 600 ms shopping-uncheck session (and in every shopping-check session) the request-order baselines are the
broken runs: the uncheck is lost and garlic is sent twice. Explore's RACE line names the correct runs as "failing"
("baseline "3", failing run "5"").
`genclass_replay` "reproduced" a run whose final state was correct. The regression test `genclass_explain` generated
asserts the baseline's count:

```ts
expect(snap.requests["POST /api/shopping-list-entry/bulk/"] ?? 0, "requests sent, as with responses in request order").toBe(3);
```

On the fixed build every shopping-uncheck load sends exactly 3 bulk requests (carrot true, garlic true, carrot
false), so the test passes there. It also passes on the unfixed build in request order at 600 ms, where the 3
requests are carrot true, garlic true, garlic true and the uncheck is lost. The count is the same for the bug and the
fix; only the bodies differ. It fails on the unfixed build only under the seeded order that sent 5 requests, which
is a run where the server ended correct. Explore cannot know which run is correct. But the explain text and the
generated test say "failing" and "as with responses in request order" as if the baseline were correct, and the
assertion pins a count that cannot tell the lost write from the fixed one. The real bug was found here because an
oracle read the request bodies and the server. Two things would match what explore actually knows: a wording such as
"the runs differ; check which is correct" for write-count differences, and, for unsafe requests, comparing the
bodies sent (or at least their shapes) next to the count.

### 7.3 A request body summary named the wrong id

In the explain timeline of the shopping-uncheck finding, both bulk requests are summarised as
`"{ids: [1], checked: true}"`. Playwright's `request.postData()` for the second was `{"ids":[3],"checked":true}`
(garlic). I did not trace whether the runtime reads the body late, summarises numbers, or attributes the second send
to the first entry. It matters because the body is the only thing that tells the two requests apart in the
timeline.

### 7.4 Smaller notes

- At 600 ms the uncheck was lost in both baselines, because explore's emulated latency widened the window in which
  the third tap lands while the first two requests are in flight. At 300 and 900 ms the baselines were correct and
  seeded orders lost it. The report has no way to say "the baseline itself misbehaves"; only an oracle saw that.
- Everything else worked as documented: injection from outside (the Gitea and Vikunja pattern), the agent link over
  the loopback bridge (with Chromium's Local Network Access checks disabled for a route-fulfilled document), every
  session reaching a quiet point, no forced deliveries. Replays reproduced 11 of the 12 RACE findings; the exception
  is the 300 ms shopping-uncheck replay, whose replayed load ended correct.

## 8. What was not run

- The brief's surface 4 (MealPlanStore `refreshFromAPI` on fast week navigation) and surface 5
  (`useModelEditorFunctions.saveObject` overwriting inputs typed during a save, the #4830 class). Both were left for
  time after the two findings above. Surface 5 also does not fit explore's verdict: the save response is delayed
  equally in the baselines, so typing during it differs from nothing. It needs an oracle on the typed value.
- Search-page filter changes and the per-page select (the same shared-signal cause as the page buttons, fixed by the
  same `abort()`, not exercised separately).
- The shopping list's `autoSync` and `recLoadShoppingListEntries` overwriting a local check (the brief's other
  shopping suspicion). With a 1 s auto-sync, explore's loads did record `overwrote-newer visible.entries` witnesses
  in the along-the-way and internal tiers (shopping-check, seeds 2, 5 and 6), but no load ended with a wrong entry.
  This was not chased further.
- Tandoor's backend tests (`pytest`): the patch touches no Python.

## 9. Time spent

About 45 minutes of wall time in one session, measured from file timestamps on the container's clock (UTC):

| when | what |
|---|---|
| 16:34 | briefs fetched, Tandoor cloned |
| 16:34 to 16:39 | apt and pip (Python 3.12), `yarn install`, `yarn build`, migrate, first user, seed (allauth headless login, welcome-wizard flags) |
| 16:39 to 16:43 | harness, probes, the first explore sessions (run in the background from here on) |
| 16:43 to 16:54 | the other unfixed sessions, the plain reproductions, the two fixes |
| 16:54 to 17:12 | the fixed build: reproductions and 15 explore sessions; the remaining unfixed shopping sessions; this report and the drafts |

Background sessions overlapped with writing. Each explore session (8 loads plus a replay) took 40 to 60 seconds.

## 10. Reproducing

```bash
# Tandoor running as in section 1, the unfixed bundle built
node docs/adoption/hunts/tandoor-recipes/seed.mjs
node docs/adoption/hunts/tandoor-recipes/repro.mjs all 5                       # no GenClass: wrong in 5 of 5 each
for s in 300 600 900; do node docs/adoption/hunts/tandoor-recipes/hunt.mjs explore search-pages $s 6; done
node docs/adoption/hunts/tandoor-recipes/hunt.mjs explore shopping-uncheck 600 6
# fixed: in ~/targets/tandoor, git am docs/adoption/hunts/tandoor-recipes.patch, (cd vue3 && yarn build), restart Django
node docs/adoption/hunts/tandoor-recipes/repro.mjs all 5                       # wrong in 0 of 5 each
HUNT_TAG=fixed node docs/adoption/hunts/tandoor-recipes/hunt.mjs explore shopping-uncheck 600 6
node docs/adoption/hunts/tandoor-recipes/summarise.mjs                         # results.json and the section 3 table
```

The session files (one JSON per scenario, latency and variant, with every load's oracle, recorded order and the
report) are written to `$HUNT_OUT` (default `~/targets/tandoor-hunt`), outside this repository; `results.json` is
their summary.
