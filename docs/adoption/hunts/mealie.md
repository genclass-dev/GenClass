# Race hunt: Mealie recipe search

Refreshed 2026-11-03 at Mealie d4d6f7135 (v3.30.0): the patch applies unchanged and the bug still reproduces. See [Refresh (2026-11-03)](#refresh-2026-11-03) at the end.

Result: **reproduced.** Mealie's recipe search can show the results of an earlier search term. When the response to
a partial term ("chi") arrives after the response to the full term ("chicken"), it replaces the newer results and
stays on screen. GenClass explore found it in 5 of 30 reordered runs on the search dialog. It reported none of the 10
baselines, and with the results registered as an atom it agreed run by run with a DOM oracle. Plain Playwright
reproduces it without GenClass in 3 of 3 runs. A small request counter fixes it (7 added lines). On the fixed build: no race in 17
reordered runs, 0 stale results in 24 GenClass loads and 6 plain-Playwright runs. Two new unit tests fail before the
fix and pass after it.

Limits, stated up front:
- The bug needs one search response to arrive about 2 s or more after the next search's response. The composable
  debounces input by 500 ms, so continuous typing sends a single request and cannot race; the user has to pause
  mid-word. Plausible on a slow server or network, rare on a fast one.
- Explore needed help on this app. Without a registered store it missed the race (GenClass problem 1), and on the
  ingredient editor it gave 3 false reports in 6 runs (problem 3).

Nothing was sent to mealie-recipes/mealie. Drafts for the owner are in [mealie-pr.md](mealie-pr.md). The change is
[mealie.patch](mealie.patch). The harness is in [mealie-harness/](mealie-harness/).

## 1. Versions and setup

| what | version |
|---|---|
| Mealie | `mealie-next` at 4391aa8a5 (2026-10-24, v3.29.0; newer than the reviewed 6d857aa) |
| backend | Python 3.14.6 (uv 0.11.32), `task py` (go-task 3.54.0), default SQLite, port 9000 |
| frontend | Node 22.22.0, pnpm 11.23.0 (the `packageManager` pin; pnpm 10.28 switched to it), `task ui` (Nuxt dev server, port 3000) |
| GenClass | this repo at d77ffd8 (`@genclass/runtime` 0.3.0-beta.1, `@genclass/mcp` 0.1.0), both built locally |
| browser | Playwright 1.63.0, the preinstalled Chromium 153.0.8010.12 headless shell |
| data | 300 recipes seeded through the API: 20 names × 15 dishes ("Chicken Soup", "Chickpea Curry", "Beef Stew", ...) |

`task setup` first failed: `python-ldap` needs the LDAP headers (`apt-get install libldap2-dev libsasl2-dev`). The
admin's first-login redirect to `/admin/setup` was skipped by opening `/g/home` directly. Seeding: `seed.mjs`
(POST `/api/recipes` with a name). With this data, "chi" returns 60 recipes, and its first page (20) holds the 15
"Chicken ..." recipes plus 5 "Chickpea ...". "chicken" returns exactly the 15 "Chicken ...". "beef" returns 15,
"salmon" 15. The backend answers a search in 20 to 50 ms.

`npx playwright install --with-deps chromium` was not run: this environment ships a matching Chromium and forbids
installing another.

## 2. The code

`frontend/app/composables/recipes/use-recipe-search.ts` (at 4391aa8a5):

- lines 26-49, `searchRecipes(term)`: sets `loading`, awaits `api.recipes.search(...)`, then writes
  `recipes.value = data.items` and clears `loading`. Nothing ties a response to the term that is current when it
  arrives, so the last response to arrive wins, whichever term it was for.
- lines 51-57: `watchDebounced` on `query`, 500 ms. Each pause of 500 ms or more sends a search.
- lines 59-61: `trigger()` sends a search for the current query immediately (no debounce).

Callers:
- `components/Domain/Recipe/RecipeDialogSearch.vue` (the header search, opened with `/`): lists `search.data` as
  `RecipeCardMobile` cards (lines 54-66).
- `components/Domain/Recipe/RecipeIngredientEditor.vue` (an ingredient switched to "Toggle Recipe"): the "Choose
  Recipe" autocomplete (lines 151-168) uses `search.data` as its items and calls `search.trigger()` on both `@click`
  and `@focus`, so one click sends two identical searches for the current text before any typing.

Two claims from the review, checked:
- "`loading` is cleared by the first response": true of the composable, but neither caller reads `search.loading`.
  The dialog binds its own `loading` ref (line 12, declared on line 89), which is never set. No visible effect today. The fix
  still keeps `loading` on until the latest search returns, and a test covers it.
- Issue #2808 is not related: it is a backend race (concurrent PATCH requests to one recipe duplicate its
  ingredients and steps), with a maintainer comment and an open PR (#8754). See mealie-pr.md, section 1. No existing
  issue covers the search race.

## 3. Method

`mealie-harness/hunt.mjs` follows `packages/mcp/test/e2e/race.e2e.mjs`:
- The MCP server runs in-process (`serve()`, bridge on a free loopback port). The harness calls the same tools an
  agent would: `genclass_explore` start, 8 page loads, `report`, then `genclass_explain` on the finding.
- Each load is a fresh browser context (`bypassCSP: true`, a saved login). `page.route` serves
  `packages/runtime/dist/*` on the virtual same-origin path `/__genclass/`. It also rewrites the page's HTML to add,
  first in `<head>`: `window.GENCLASS_CONFIG = { telemetry: false, model: false, report: "silent" }`, the script-tag
  build (`/__genclass/genclass.global.js`), and a module that runs
  `connectAgent(window.GenClass.runtime, { url: <bridge> })` from `/__genclass/agent.js` (the script-tag build has no
  agent entry). No Mealie file is changed.
- State: Mealie is Vue, and GenClass discovers only React and Redux state. With `--atom`, the injected module
  registers `rt.atom("searchResults")` and sets it from the rendered result list on DOM changes (a MutationObserver)
  as "count: first ... last". The selector counts each dialog card twice, so 15 results read "30: ...". It is
  consistent across runs, so the comparison is unaffected. Runs without `--atom` rely on the page text and form
  values in the snapshots, and on the delivery order.
- DOM oracle, separate from explore: after `whenSettled`, the harness reads the visible results. Dialog: the card
  names must equal the backend's first page for the final term, in order. Ingredient editor: the autocomplete's
  options must be non-empty and all match the typed term.
- Explore session: 2 `fifo` baselines and 6 `seeded` loads, `slow_ms` adding 0 to N ms per response. Typing with
  `pressSequentially` at 60 or 90 ms per key.

Scenarios (a pause of 1.1 s, longer than the 500 ms debounce and the runtime's 1 s typing-burst window; see
problem 2):

| scenario | steps | requests |
|---|---|---|
| dialog-type | `/`, type `chicken` | one, "chicken" |
| dialog-pause | `/`, type `chi`, pause, type `cken` | "chi", then "chicken" |
| dialog-clear-retype | `/`, type `salmon`, pause, Ctrl+A, Backspace, type `beef` | "salmon", then "beef" |
| ingredient-link | recipe edit page, ingredient row menu "Toggle Recipe", click "Choose Recipe", type `chicken` | "" twice (click and focus), then "chicken" |

Commands (paths as on the hunt machine):

```bash
# GenClass
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
# Mealie
git clone --branch mealie-next https://github.com/mealie-recipes/mealie.git && cd mealie
task setup && task py   # second shell: task ui
# harness (node_modules linked to this repo's, for playwright and @genclass/mcp)
node seed.mjs && node login.mjs && node login2.mjs
HUNT_PAUSE=1100 node hunt.mjs --atom --scenario dialog-pause --slow 900 --tag buggy
node repro-plain.mjs 3      # buggy build; 6 after `git apply mealie.patch`
python3 summarize.py out/*.json
```

## 4. Every verdict

Unpatched build (`buggy`) first, then the patched build (`fixed`). "Reordered" means the 6 seeded runs; the oracle
column reads seeded wrong / baseline wrong.

| build | scenario | slow_ms | key ms | atom | explore verdict | DOM oracle wrong | agreement |
|---|---|---|---|---|---|---|---|
| buggy | dialog-pause (0.6 s pause) | 900 | 90 | no | no race (one group had no baseline) | 1 of 2 / 0 of 2 | missed (problem 2) |
| buggy | dialog-pause | 900 | 90 | no | **no race** | **2 of 6** / 0 of 2 | missed (problem 1) |
| buggy | dialog-pause | 900 | 90 | yes | **race, 2 of 6** | 2 of 6 / 0 of 2 | same runs (seeds 1, 5) |
| buggy | dialog-pause | 600 | 90 | yes | **race, 1 of 6** | 1 of 6 / 0 of 2 | same run (seed 5) |
| buggy | dialog-pause | 300 | 90 | yes | no race | 0 of 6 / 0 of 2 | agree |
| buggy | dialog-type | 900 | 60 | yes | no race | 0 of 6 / 0 of 2 | agree |
| buggy | dialog-clear-retype | 900 | 90 | yes | **race, 2 of 6** | 2 of 6 / 0 of 2 | same runs (seeds 1, 5) |
| buggy | ingredient-link | 900 | 60 | yes | race, 3 of 6: **false** | 0 of 6 / 0 of 2 | false report (problem 3) |
| fixed | dialog-pause | 900 | 90 | yes | no race | 0 of 6 / 0 of 2 | agree |
| fixed | dialog-pause, seed 7 | 900 | 90 | yes | no race in 5; 1 run no verdict | 0 of 6 / 0 of 2 | agree (problem 2) |
| fixed | dialog-clear-retype | 900 | 90 | yes | no race | 0 of 6 / 0 of 2 | agree |

The first row was a 4-load smoke run (2 seeded) with a 0.6 s pause.

Totals for the search dialog with the atom (the setup that works):
- Unpatched: explore flagged 5 of 30 reordered runs. The DOM oracle found the same 5 runs wrong, and no baseline was
  wrong (0 of 10).
- Patched: explore flagged 0 of 17 reordered runs with a verdict, and the DOM oracle found 0 of 24 loads wrong. That
  is no false report on the correct variant.
- Ingredient editor, unpatched: 3 false race reports in 6 reordered runs. None of them reordered the search
  responses: the "" responses were delivered before "chicken" was sent in all 8 loads, and the oracle found nothing
  wrong.

By `slow_ms` (dialog-pause): 300 gave 0 of 6, 600 gave 1 of 6, 900 gave 2 of 6. Continuous typing gave 0 of 6: the
debounce sends one request. Not run, to keep the hunt short at the owner's request: dialog-type and
dialog-clear-retype at 300 and 600, ingredient-link at 300 and 600, typing at 120 ms per key, and
`genclass_replay` of the finding.

## 5. Evidence, in causal order

Finding f2 (`genclass_explain`), run r4, `/g/home`, schedule seeded 1 with 0 to 900 ms latency. Times are from
`connectAgent`; page-load requests that do not bear on it are left out:

```
+5.560s action 0: type input "Search" = "chi" (3 keystrokes over 198 ms)
+6.260s send GET /api/recipes#2 "?search=chi&page=1&orderBy=name&orderDirection=asc&perPage=…" (action 0) via timer 500ms
+7.436s action 1: type input "Search" = "chicken" (4 keystrokes over 306 ms)
+8.244s send GET /api/recipes#4 "?search=chicken&page=1&orderBy=name&orderDirection=asc&perP…" (action 1) via timer 500ms
+8.452s delivered GET /api/recipes#4 (held 164 ms)
+8.636s write searchResults by GET /api/recipes#4: "" → "30: Chicken Bowl ... Chicken Wrap"
+9.272s delivered GET /api/recipes#2 (held 2.9 s)
+9.336s write searchResults by GET /api/recipes#2: "30: Chicken Bowl ... Chicken Wrap" → "40: Chicken Bowl ... Chickpea Pasta"
```

- Explore: `state "searchResults": baseline "30: Chicken Bowl ... Chicken Wrap", this run "40: Chicken Bowl ...
  Chickpea Pasta"`.
- Witness only in the failing runs: `overwrote-newer searchResults by GET /api/recipes`.
- DOM oracle, same run: 20 cards shown, 15 expected; not in the results for "chicken": "Chickpea Bowl", "Chickpea
  Burger", "Chickpea Casserole", "Chickpea Curry".

The "chi" response reached the app 3.0 s after its request was sent and 0.8 s after the "chicken" response. Its
emulated latency (at most 900 ms) was stretched by the seeded schedule's holds while other requests were in flight.
That is the honest size of the window: the earlier response has to arrive about 2 s or more late.

Without GenClass (`repro-plain.mjs`, plain `page.route` holding only the "chi" response for 2 s; type `chi`, wait
1.1 s, type `cken`):

```
run 1: STALE: 20 shown (15 expected), not for "chicken": ["Chickpea Bowl","Chickpea Burger","Chickpea Casserole"]; chi sent @7890, chicken answered @9461, chi answered @9950
run 2: STALE: ... chi sent @7063, chicken answered @8619, chi answered @9134
run 3: STALE: ... chi sent @7136, chicken answered @8680, chi answered @9181
{"runs":3,"stale":3}
```

## 6. Root cause and fix

Root cause: `searchRecipes` (use-recipe-search.ts, lines 26-49) applies every response it receives, whether or not a
newer search has started since. Two searches in flight resolve in network order, not request order, and the last one
to resolve sets `recipes` and clears `loading`.

Fix ([mealie.patch](mealie.patch), Mealie's style): a counter in the composable. Each search takes the next number;
after the `await`, a response whose number is not the latest returns without touching `recipes` or `loading`.

```ts
  let latestRequest = 0;

  async function searchRecipes(term: string) {
    const request = ++latestRequest;
    loading.value = true;
    const { data, error } = await api.recipes.search({ ... });

    // a newer search started while this one was in flight; let it set the results
    if (request !== latestRequest) {
      return;
    }
```

An AbortController would also cancel the request. It was not used because the API client's `search` takes no
signal, and the counter keeps the change to the one file both callers share.

Regression test: `frontend/app/composables/recipes/__tests__/use-recipe-search.test.ts`, in the style of the
existing composable tests (vitest, `vi.fn`, no GenClass). A fake `api.recipes.search` returns a promise per term that
the test resolves by hand:
- "an older response that arrives last does not overwrite newer results": search "chi", then "chicken"; resolve
  "chicken", then "chi"; the data stays "chicken".
- "loading stays on until the latest search returns": resolve "chi" first; `loading` stays true and the data stays
  empty until "chicken" resolves.

## 7. Test results

| check | unpatched | patched |
|---|---|---|
| new tests (`npx vitest run app/composables/recipes/__tests__/use-recipe-search.test.ts`) | **2 failed** (data "chi recipe" where "chicken recipe" was expected; `loading` false where true was expected) | 2 passed |
| Mealie frontend suite (`npx vitest run`) | not run | 58 files, 625 tests passed |
| eslint on the two changed files, `--max-warnings=0` | | clean |
| plain Playwright, "chi" held 2 s | 3 of 3 stale | **0 of 6 stale** ("chi" still answered last in all 6) |
| GenClass explore (atom), dialog-pause and clear-retype, slow 900 | race in 4 of 12 reordered runs | **no race in 17 reordered runs** (1 more without a verdict) |
| DOM oracle in those sessions | 4 of 12 seeded wrong | **0 of 24 loads wrong** |

Checks not run: `task py:check` (ruff, mypy, semgrep, pytest), because the change touches no backend file. Of
`task ui:check`, the whole-project `pnpm lint` was not run; eslint ran on the changed files and vitest on the whole
suite. In this repository: no code changed (docs only), so its typecheck, build and tests were not rerun.

## 8. GenClass problems found

1. **Snapshots keep only the first 300 lines of page text** (`packages/runtime/src/agent/index.ts`, `snapshot()`,
   `.slice(0, 300)`). Mealie's home page renders 689 lines with the dialog open, and the results start at line 599
   (the dialog is teleported to the end of `<body>`). Without a registered store, explore said "No race found" while
   the DOM oracle saw 2 of 6 seeded runs wrong. A silent false negative on any long page with an overlay. Ideas:
   keep the lines of open dialogs, overlays, focused and `aria-live` regions first; or compare a hash of the full
   text with a capped excerpt.
2. **The scenario key depends on keystroke timing.** A typing burst is one action only while each keystroke comes
   within `TYPING_BURST_MS` (1000 ms, `runtime.ts`) of the last. On Mealie's dev build a render blocked the main
   thread for over 1 s, so the same `pressSequentially` was recorded as "chicke" + "chicken" in one run, putting
   that run in a group with no baseline and no verdict. This happened once on the unpatched build (the failing run,
   so the race went unreported) and once on the patched build. Ideas: group runs by the final value per field and
   the request sequence, or merge bursts whose split lies in a gap the page itself caused.
3. **Generated element ids as field names give false race reports.** Form fields are keyed by their label, and
   unlabelled Vuetify inputs fall back to auto ids (`input-v-0-78`) that depend on mount order. A different delivery
   order mounts components in a different order. The two `fifo` baselines matched each other, so the noise filter
   kept the fields, and 3 of 6 reordered runs on the ingredient editor were reported as races with only "field
   input-v-0-NN: baseline "", this run (absent)". Ideas: treat fields named only by a generated-looking id as noise,
   or compare such fields by position and value.
4. **Chromium 153 Local Network Access.** When the document is served through `route.fulfill`, Chromium blocks the
   page's requests to loopback (the bridge, and Vite's HMR socket) with `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`.
   The harness launches Chromium with `--disable-features=LocalNetworkAccessChecks`. Anyone injecting GenClass this
   way will hit it; AGENT.md could say so.
5. Explore without a registered store is weak on Vue apps. GenClass discovers only React and Redux state, so on Vue
   the verdict rests on page text (problem 1) and form fields (problem 3). Registering one atom from the DOM was
   enough here, and the `overwrote-newer` witness was recorded through it.

Harness-side mistakes, for the record: parallel sessions hung while Vite re-optimized dependencies, so sessions run
one at a time. Waiting for `networkidle` never settles on the Nuxt dev server (the HMR socket keeps retrying), so the
warm-up waits for `load`.

## 9. Time spent

About 1 hour of wall-clock time (23:26 to 00:25 UTC): 15 minutes for setup (Python 3.14, go-task, LDAP headers,
seeding), 20 for the harness (injection, LNA, Vuetify menus), 20 for the explore sessions (about 1.6 minutes each),
and 5 for the fix and its tests.

## Refresh (2026-11-03)

Status: **ready to send.** The bug is still in Mealie's current `mealie-next`. The patch applies unchanged, and the
tests and both reproductions without GenClass give the same results as on 2026-10-24. Nothing has been filed upstream
since the hunt. What is left for the sender is in [mealie-pr.md](mealie-pr.md), "Before sending": read the diff,
reproduce by hand (a console snippet, 2 minutes), run `task ui:check`, search the tracker once more, then send.

### What was re-run

| what | 2026-10-24 | 2026-11-03 |
|---|---|---|
| Mealie | `mealie-next` 4391aa8a5 (v3.29.0) | `mealie-next` **d4d6f7135** (2026-11-03 12:24 UTC, v3.30.0 + 27 commits; 79 commits after 4391aa8a5) |
| toolchain | Python 3.14.6 (uv 0.11.32), go-task 3.54.0, Node 22.22.0, pnpm 11.23.0 | Python 3.14.6 (uv 0.11.32), go-task 3.54.0, Node 22.23.4, pnpm 11.23.0 |
| GenClass | d77ffd8, runtime 0.3.0-beta.1, mcp 0.1.0 | c1c9e14, runtime 0.3.0-beta.5, mcp 0.2.1, both built locally |
| browser | Playwright 1.63.0, Chromium 153 headless shell | the same |

Setup, as in section 1 (`apt-get install libldap2-dev libsasl2-dev`, `go install github.com/go-task/task/v3/cmd/task@latest`,
`uv python install 3.14`, `task setup`, `task py`, `pnpm run dev --no-fork` in `frontend/`, then `seed.mjs`,
`login.mjs`, `login2.mjs`). One new step: on a fresh clone the frontend unit tests fail with
`Failed to load tsconfig '.nuxt/tsconfig.json'` until `pnpm exec nuxi prepare` (or `task ui`) has generated `.nuxt/`.
The backend tests need NLTK's tagger data. The dev setup does not install it, and Docker's
`docker/setup_nltk_data.sh` does. Without it, 18 tests in `test_nlp_parser.py` fail. With the same 300 seeded recipes, "chi" returns 60 recipes (first page: 15 Chicken, 5 Chickpea) and "chicken"
returns 15, as before.

Code: none of the 79 new commits touches `use-recipe-search.ts`, `RecipeDialogSearch.vue` or
`RecipeIngredientEditor.vue`, so every file and line number in sections 2 and 6 still holds at d4d6f7135.
The patch applies with `git apply`. Regenerated with `git diff mealie-next`, it is byte-identical to
[mealie.patch](mealie.patch), so the file is unchanged.

### The numbers

| check (commands in section 3; `cd frontend` for vitest) | unpatched | patched |
|---|---|---|
| new tests, `pnpm exec vitest run app/composables/recipes/__tests__/use-recipe-search.test.ts`, 3 runs each | **2 failed** in 3 of 3 runs (`expected [ { name: 'chi recipe' } ] to deeply equal [ { name: 'chicken recipe' } ]`; `expected false to be true`) | **2 passed** in 3 of 3 runs |
| `task ui:check`: `pnpm lint --max-warnings=0` | | clean (exit 0) |
| `task ui:check`: `pnpm exec vitest run` (whole frontend suite) | | 58 files, 629 tests passed |
| `task py:check` (ruff format, ruff check, semgrep, mypy, pytest) | | ruff format (751 files unchanged), ruff check, semgrep (0 findings) and mypy (479 files) clean. pytest: 18 failed, 3701 passed, 17 skipped. All 18 failures were in `test_nlp_parser.py` (`LookupError`: NLTK's `averaged_perceptron_tagger_eng` was not installed). After `NLTK_DATA=~/targets/nltk_data bash docker/setup_nltk_data.sh` (the Dockerfile's step): **3719 passed, 17 skipped**, exit 0 |
| plain Playwright, `repro-plain.mjs` ("chi" response held 2 s with `page.route`) | **3 of 3 stale** (20 shown, 15 expected) | **0 of 6 stale** ("chi" still answered last in 6 of 6) |
| console snippet, `repro-console.mjs` (new: sending of the "chi" request delayed 2 s by a snippet pasted into the page; no interception) | **3 of 3 stale** | **0 of 6 stale** ("chi" sent and answered after "chicken" in 6 of 6) |
| GenClass explore, dialog-pause, `--atom`, slow 900, pause 1100, 90 ms keys, 2 fifo + 6 seeded | DOM oracle: 1 of 6 seeded wrong (seed 1), 0 of 2 baselines; explore: **"No race found"**, the run filed as "Internal state only" with the `overwrote-newer searchResults` witness (problem 6) | DOM oracle: 0 of 8 loads wrong; explore: no race in 6 of 6 (2 of 6 seeded runs delivered "chicken" before "chi" to the app) |
| GenClass explore, the same without `--atom` | DOM oracle: 1 of 6 seeded wrong (seed 1); explore: "No race found" (problem 1, unchanged) | not run |

On 2026-10-24, the same dialog-pause session with the atom flagged seeds 1 and 5 (2 of 6). Today only seed 1 went
wrong, by the oracle too. Whether a seeded schedule holds "chi" long enough depends on timing, so 1 and 2 of 6 are
both within what one session of M = 6 can show. Explore ran only these three sessions (24 loads); the other
scenarios in section 4 were not re-run.

Commands (on top of section 3's):

```bash
cd ~/targets/mealie && git apply /path/to/mealie.patch          # fixed; `git stash push <composable>` for unfixed
cd frontend && pnpm exec nuxi prepare && pnpm exec vitest run app/composables/recipes/__tests__/use-recipe-search.test.ts
pnpm lint --max-warnings=0 && pnpm exec vitest run
cd .. && NLTK_DATA=~/targets/nltk_data bash docker/setup_nltk_data.sh && NLTK_DATA=~/targets/nltk_data task py:check
node repro-plain.mjs 3 && node repro-console.mjs 3            # unfixed; 6 each when fixed
HUNT_PAUSE=1100 node hunt.mjs --atom --scenario dialog-pause --slow 900 --tag buggy
```

### Upstream tracker and policy (2026-11-03)

- Searches (`gh api -X GET search/issues`, repo `mealie-recipes/mealie`, 3 s apart, each with `is:issue` and
  `is:pr`): `search stale results`, `search results out of order`, `use-recipe-search`, `search race condition`,
  `search wrong results typing`, `search debounce`, `"search dialog"`, and everything with `search` created on or
  after 2026-10-24. No issue or PR covers this bug. The search-related items opened since the hunt are about
  something else: #8917 (the filter menu's search field on iPhone), #8953 (the filter search open while
  scrolling), #8927 (filter by owner) and #8952 (On Hand workflow). The diffs of the three open PRs
  (`git fetch origin pull/N/head`) do not touch `use-recipe-search.ts`; #8953 and #8927 change `SearchFilter.vue`
  and the explorer's search.
- #2808 is still open (`bug`, `bug: confirmed`, 11 comments, last updated 2026-09-30), and #8754 is still open (last
  updated 2026-10-20). Both are unchanged since the hunt, so the decision not to comment there stands
  (mealie-pr.md, section 1).
- Policy at d4d6f7135. `.github/pull_request_template.md` (last changed 2026-10-17): Conventional Commits title;
  "What this PR does", "Which issue(s) this PR fixes" and "AI / LLM Assistance" are required; "Failure to accurately
  disclose LLM usage may result in review delays or closure of your PR." `AGENTS.md` (= `CLAUDE.md`, 2026-09-23):
  run `task py:check` and `task ui:check` before a PR; drafts are optional. CONTRIBUTING
  (`docs/docs/contributors/developers-guide/code-contributions.md`, unchanged since 2024-06-04): branch from
  `mealie-next`, draft PR first, AGPL, no CLA. No file in the repository bans AI-assisted contributions.
  `git grep` over `docs/` found no AI policy beyond the template.

### What changed in the drafts

- [mealie-pr.md](mealie-pr.md): commit and version (d4d6f7135, v3.30.0); the AI-policy line now quotes the
  template. The 2026-10-24 version said Mealie "close[s] AI-generated PRs without review", which nothing in the
  repository says. The checks line: `task ui:check` and `task py:check` were run. Draft PRs: CONTRIBUTING says
  draft first, AGENTS.md says optional. The `nuxi prepare` step is new. #2808 and #8754 were re-checked, with
  links. There is a by-hand reproduction (the console snippet, also in the issue's steps). The draft issue now fills
  every field the bug-report form requires (First Check, logs, Deployment) and carries the disclosure paragraph. The
  PR's Testing section has today's suite count (629 tests) and the snippet method, and its AI / LLM Assistance
  paragraph is unchanged.
- [mealie-harness/repro-console.mjs](mealie-harness/repro-console.mjs): new. It runs the console snippet from the
  drafts in Playwright, so the by-hand step is measured as written.
- [mealie.patch](mealie.patch): unchanged (see above).

### Problems with GenClass itself (new or re-checked)

6. **New since the hunt: a store difference is not a race unless the page text differs, and the page text is capped
   at 300 lines.** Commit e603695 (2026-10-25, "explore reports a race only when the page differs") files a run
   whose only differences are store values as "Internal state only (not a race by this check)"
   (`packages/mcp/src/tools.ts`, line 367). On Mealie the results are on the page, at line 599 of 689. The snapshot
   keeps lines 1 to 300 (`packages/runtime/src/agent/index.ts`, line 354, problem 1). So the run that showed
   Chickpea recipes under "chicken" (run r4, seed 1: `state "searchResults": baseline "30: Chicken Bowl ... Chicken
   Wrap", this run "40: Chicken Bowl ... Chickpea Pasta"`, with `witness only here: overwrote-newer searchResults by
   GET /api/recipes`) is now reported as "No race found". The atom workaround that found the race on 2026-10-24 no
   longer gives a verdict. The text adds that "a field that matters belongs on the page or in a test", but here it
   is on the page. Ideas: fix problem 1 first. Or count an `overwrote-newer` witness that appears only in the
   differing runs as a race, or at least name it in the verdict line, not only under "Internal state only".
7. Problems 1 and 2 are unchanged in the code: `.slice(0, 300)` in `snapshot()` and `TYPING_BURST_MS = 1000` in
   `runtime.ts`, line 152. Problem 4 (Local Network Access) was not re-tested: the harness still launches Chromium
   with `--disable-features=LocalNetworkAccessChecks`. Problem 3 (the ingredient editor) was not re-run.

### Time spent

About 40 minutes of wall-clock time (16:35 to 17:15 UTC), with `task py:check` running alongside the rest: 10 minutes for the clone and setup (LDAP headers, go-task, Python 3.14,
`task setup`, `nuxi prepare`), 10 for the tests and `task ui:check`, 10 for the two reproductions and the three
explore sessions (1.5 minutes each), 5 for the tracker searches and the policy files, 5 for `task py:check` and the
NLTK re-run, and 5 for the drafts and this section.
