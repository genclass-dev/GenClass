# Race hunt: Keystone Admin UI (keystonejs/keystone)

Status: **ready to send** (the sender's by-hand items are in [keystone-admin-ui-issue.md](keystone-admin-ui-issue.md),
"Before sending"). Nothing was posted to keystonejs/keystone. Run on 2026-11-03 in one cloud session.

**Headline.** Pressing Enter twice in a field of any Admin UI create page creates the item twice. The form submits
through a hidden submit button that is not pending while the create mutation runs, and neither the form's `onSubmit` nor
`useCreateItem().create()` checks for a create in flight. It reproduces without GenClass under Chromium's network
throttling (two tags in 10 of 10 tries at 400 ms and 150 ms of latency, 9 of 10 with none). On a list with a unique
field the second create fails, and the user sees "Unable to create author" for an author that was created (10 of 10).
The fix is a ref guard in `useCreateItem` (6 lines). The regression test is in Keystone's own `tests/admin-ui-tests`
style: it fails 3 of 3 on `main` and passes 3 of 3 with the fix, each run covering the dev and production passes. After
the fix: one tag in 30 of 30 throttled tries and in 32 of 32 loads (24 under explore, 8 natural).

A second, smaller observation is reproduced without GenClass but not patched: a click on a list column header while the
next page is loading is ignored (section 6). The other four surfaces the brief named showed no race: list search per
keystroke, relationship search, load more during search, and item save while typing. GenClass's explore did not report
the duplicate create as such. Its RACE lines on this one-endpoint GraphQL app were mostly timing-dependent query counts,
and its `identical-in-flight` witness never fired under the emulated latency (section 8).

## 1. Versions and commits

| what | version |
|---|---|
| Keystone | `keystonejs/keystone` `main` at `88da2cc283395509fbbf4f1b192294fdb8fee783` (2026-11-03, "Version Packages (#10071)"), `@keystone-6/core` 8.3.0 |
| Admin UI stack | Next.js 16.2.10 (pages router, production build), React 19.2.5, `@apollo/client` 4.1.9, Keystar UI |
| app | `examples/usecase-blog` (Author, Post with a document field, Tag; no auth), SQLite through `@prisma/adapter-better-sqlite3` |
| GenClass | this repository at `c1c9e14` (main): `@genclass/runtime` 0.3.0-beta.5, `@genclass/mcp` 0.2.1, both built from source |
| Node, pnpm | Node 22.23.4 (Keystone's CI uses 26), pnpm 11.21.0 through corepack 0.31.0 |
| browser | hunt: Playwright 1.63.0, headless Chromium 153.0.8010.12; Keystone's tests: their Playwright 1.64.1 driving the same Chromium (section 2) |

## 2. Running Keystone

```bash
git clone --depth 50 https://github.com/keystonejs/keystone ~/targets/keystone-admin-ui    # 88da2cc
cd ~/targets/keystone-admin-ui
npm i -g corepack@0.31.0 && corepack enable
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install            # 2 min 19 s, postinstall included
cd examples/usecase-blog
export KEYSTONE_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
pnpm build                                                 # 21 s
npx prisma db push                                         # creates keystone-example.db (keystone start does not)
pnpm start                                                 # Admin UI and GraphQL on http://localhost:3000
node /path/to/GenClass-lib/docs/adoption/hunts/keystone-admin-ui/seed.mjs
```

The production build (`keystone build && keystone start`) was used throughout, as the brief suggested, for stable
timings. Keystone was up about 10 minutes after the session started.

**One deviation: Posts are seeded straight into SQLite.** At `88da2cc`, in this monorepo setup, every Post write
through Keystone fails: `createPost(data: { title: "probe" })` answers `An error occurred while resolving input fields.
- Post.content: (0 , import_weak_memoize.default) is not a function`, in `keystone dev` and `keystone start` alike. The
stack points to `withComponentBlocks` in the bundled `.keystone/config.js`, where esbuild imports
`@emotion/weak-memoize`'s CJS build with `__toESM(require(...), 1)` (node mode). Node mode takes `module.exports` as the
default, and `module.exports` is `{ default: fn }`, so `.default` is an object. This is a Keystone build or interop
problem, not an Admin UI race. It was not investigated further, and was not checked on Node 26 or with the published
packages. An upstream search for "weak_memoize" and "weak-memoize" found nothing related. Because of it, `seed.mjs`
writes the 240 Posts with `node:sqlite` and creates the 60 Authors and 120 Tags through GraphQL. The hunt reads Posts
(list page, relationship search) and writes only Authors and Tags, which have no document field.

**Keystone's tests here.** Their Playwright 1.64.1 wants Chromium revision 1248; the container has 1243 and
`playwright install` is not allowed. A scratch `PLAYWRIGHT_BROWSERS_PATH` with `chromium-1248` and
`chromium_headless_shell-1248` symlinked to the installed 1243 builds ran every test file used here. Nothing in the
repository or the system was changed for it.

## 3. Attaching GenClass without touching Keystone

`keystone-admin-ui/hunt.mjs` is the Ghost harness pattern ([ghost.md](ghost.md) section 3) for a Next.js app. It starts
`@genclass/mcp`'s `serve()` in-process and drives `genclass_explore`, `genclass_findings` and `genclass_explain` over
JSON-RPC. In Playwright it:

- routes `/__genclass/*` to `packages/runtime/dist/` and rewrites every HTML document of the Admin UI so its `<head>`
  starts with the script-tag build, a mirror atom and `connectAgent(...)`;
- sets `GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, autoState: false, ... }` from an init
  script. There is no model, no telemetry, and React state discovery is off (see Ghost's section 9, item 2);
- launches Chromium with `--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks` (Ghost, section 9,
  item 1).

**The mirror atom** `keystone` holds what the screens under test show, read from the DOM on mutations, once per animation
frame: the first cell of each visible list row, the pagination text, and the open listbox's options. Apollo's client is
not reachable from outside in the production build.

**Oracles, per load, in every result file:** (1) explore's verdict as printed, nothing removed. (2) The GraphQL API
after the run: the rows or options the screen should show for the final search, page or sort, the saved name, or the
number of tags with the typed name. (3) The DOM after `whenSettled`. (4) The GraphQL requests seen on the wire,
counted by operation (Playwright's `request` event). Every request is `POST /api/graphql`, so GenClass sees one
signature, and this count is what tells the operations apart. Each explore session is `genclass_explore start` with
`runs: 6`, `slow_ms` 300, 600 or 900 and `seed: 1`, then 8 loads (2 fifo baselines, 6 seeded), then `report`.
`GENCLASS=0` runs the same scenario with nothing injected.

## 4. Scenarios

| id | scenario | what overlaps on the wire |
|---|---|---|
| list-search | `/posts`: type `gam` into Search, pause 150 ms, type `ma 1` (one query per keystroke, no debounce: `ListPage/index.tsx` 600 to 604) | 7 unnamed `posts` queries with different `where`; the URL sync effect (`TODO: stop this race condition properly`, line 340) |
| list-pages | `/posts`: Next page, 120 ms, Next page, 120 ms, click the Title column header | 3 or 4 `posts` queries (skip 50, skip 100, then sorted) |
| rel-search | `/posts/create`: Author combobox (filter `verified`, sort by name), type `a`, pause 260 ms (past the 200 ms debounce), type `lpha author` | `RelationshipSelect` for `a` and for `alpha author`, `RelationshipSelectMore` for the first term's next page |
| rel-more | `/posts/create`: open Tags, scroll the listbox to its end (`fetchMore`, skip 10), type `zeta` 60 ms later | `RelationshipSelectMore` for the empty term in flight with `RelationshipSelect` for `z` to `zeta` |
| item-save | `/authors/<id>`: append ` one` to Name, Save, append ` two` while the update is out, wait for the toast, Save | `updateAuthor`, `KsFetchItem` refetches, the second `updateAuthor` |
| create-enter | `/tags/create`: type a name, Enter, 60 ms, Enter | `createTag` (twice), `KsFetchItem` of the new tag |
| create-click | the control for create-enter: a double click on Create | `createTag` |

## 5. Results

Twenty-one explore sessions on `main` (7 scenarios at 300, 600 and 900 ms), 8 loads each: 168 loads, 126 with a seeded
order. There were also 3 control sessions without GenClass (8 natural local loads each). The table is generated by
`keystone-admin-ui/summarise.mjs` from `keystone-admin-ui/results/*.json`. "Harness oracle" counts the loads whose DOM,
API or wire count matched what the app should do (section 3). The wire column of the generated table is left out here;
it is in `results/summary.json`.

| scenario | slow_ms | GenClass | explore verdict (as reported) | what differed | harness oracle as expected | holds ran out | witnesses |
|---|---|---|---|---|---|---|---|
| create-click | 300 | on | no race, 0 of 6 | nothing | 8/8 | 0 | 0 |
| create-click | 600 | on | no race, 0 of 6 | nothing | 8/8 | 0 | 0 |
| create-click | 900 | on | no race, 0 of 6 | nothing | 8/8 | 0 | 0 |
| create-click | none (natural, local) | off | n/a | n/a | 8/8 | n/a | n/a |
| **create-enter** | 300 | on | RACE: 1 of 6 | count of `POST /api/graphql` (a `KsFetchItem` query more or less) | **0/8** (two tags every load) | 0 | 0 |
| **create-enter** | 600 | on | RACE: 2 of 6 (+1 internal only) | the same; an announcement | **0/8** | 0 | 0 |
| **create-enter** | 900 | on | RACE: 3 of 6 (+1 internal only) | the same; an announcement | **0/8** | 0 | 0 |
| **create-enter** | none (natural, local) | off | n/a | n/a | **0/8** | n/a | n/a |
| item-save | 300 | on | no race, 0 of 6 | nothing | 8/8 | 0 | 0 |
| item-save | 600 | on | no race, 0 of 6 | nothing | 8/8 | 0 | 0 |
| item-save | 900 | on | no race, 0 of 6 | nothing | 8/8 | 0 | 0 |
| **list-pages** | 300 | on | RACE: 2 of 6 | page rows unsorted, `posts` count 4 vs 5, mirror rows | **6/8** (sort click lost in 2) | 0 | 0 |
| **list-pages** | 600 | on | RACE: 5 of 6 | the same | **3/8** (lost in 5) | 0 | 0 |
| **list-pages** | 900 | on | no race, 0 of 6 | nothing (the baselines disagreed, so the difference was noise) | **3/8** (lost in 5, one baseline included) | 0 | 0 |
| list-pages | none (natural, local) | off | n/a | n/a | 8/8 | n/a | n/a |
| list-search | 300 | on | no race, 0 of 6 | nothing | 8/8 | 0 | 0 |
| list-search | 600 | on | no race, 0 of 6 | nothing | 8/8 | 0 | 0 |
| list-search | 900 | on | no race, 0 of 6 | nothing | 8/8 | 0 | 0 |
| rel-more | 300 | on | RACE: 1 of 6 | count of `POST /api/graphql` (`RelationshipSelectMore` 1 or 2) | 8/8 | 0 | 2 |
| rel-more | 600 | on | RACE: 2 of 6 | the same (1 to 3) | 8/8 | 0 | 4 |
| rel-more | 900 | on | no race, 0 of 6 | nothing | 8/8 | 0 | 3 |
| rel-search | 300 | on | no race, 0 of 6 (+5 internal only) | announcements ("48 options available."); one `overwrote-newer` witness on the mirror | 8/8 | 0 | 1 |
| rel-search | 600 | on | RACE: 5 of 6 (+1 internal only) | count of `POST /api/graphql` (`RelationshipSelectMore` 1 or 2); announcements | 8/8 | 0 | 0 |
| rel-search | 900 | on | RACE: 3 of 6 (+2 internal only) | the same | 8/8 | 0 | 1 |

Read by the oracles:

- **create-enter: two tags in 24 of 24 explore loads and 8 of 8 loads without GenClass**, baselines included. This is
  the finding (section 7). Explore's RACE line in those sessions was not the duplicate. It was one `KsFetchItem` query
  more or less after the create, counted as a write because it is a POST (section 8, item 1). The duplicate was the
  same in every run, so a comparison of orders cannot show it, and the witness meant for it did not fire (section 8,
  item 2).
- **list-pages: the Title click was lost in 12 of 24 explore loads and 0 of 8 natural local loads**. This is the second
  observation (section 6). Explore reported it at 300 and 600 ms as a visible difference (page rows). At 900 ms one
  baseline lost the click too, so the difference became baseline noise and the verdict read "no race" (section 8,
  item 3).
- **The other surfaces: as expected in every load.** list-search showed the 3 `gamma 1` posts in 24 of 24 loads. The
  Author combobox showed exactly the 4 verified `alpha author` authors in 24 of 24. The Tags combobox showed the 10
  `zeta` tags in 24 of 24 after a load more overlapping the search. item-save saved `beta author 01 one two` and left
  that value in the field in 24 of 24. Their RACE lines were request counts of queries over POST, and their "internal
  only" entries were react-aria's live-region announcements.

No response's hold ran out in any session (`forced` 0 in all 168 loads).

## 6. The second observation: a sort click during loading is lost

In list-pages, the seeded runs that lost the click ended on page 3 without `sortBy` in the URL and with unsorted rows.
Explore r3 (seed 1, 600 ms):

```
page text only in the baseline: "gamma 0 post 014", "Draft", "Draft", "Draft"
page text only in this run: "epsilon 2 post 100", "zeta 3 post 101", "Published", "Published"
requests sent to "POST /api/graphql": baseline "5", this run "4"
```

The cause is `packages/core/src/admin-ui/pages/ListPage/index.tsx` line 504, `allowsSorting: !isConstrained &&
!data?.items?.length ? false : field.isOrderable`. While a page's query is in flight, Apollo Client 4's `data` is
undefined, so every column is unsortable (the header has no `aria-sort`) and a press on it does nothing. The condition
reads as meant for an empty, unfiltered list. **Without GenClass** (`keystone-admin-ui/sort-probe.mjs`, plain Playwright, page 2's query
held 800 ms by `page.route`, the header clicked 100 ms after Next page), the click was lost in 5 of 5 tries. With no hold
and the click 1.5 s later, it was lost in 0 of 3. The drafts mention this in one paragraph and do not patch it: whether
sorting should work during loading is the maintainers' design call, and it is a lost click, not wrong data.

## 7. The finding: Enter twice on a create page creates the item twice

### 7.1 What explore recorded

`genclass_explain f1` for create-enter, 600 ms, run r5 (seed 3), excerpt (`results/create-enter-slow600-seed1.json`):

```
+1.712s action 2: key input "Name"
+1.714s action 3: click button
+1.714s action 4: submit form
+1.716s send POST /api/graphql#2 "{variables: {data: {1 keys}}, +1}" (action 4)
+1.796s action 5: key input "Name"
+1.797s action 6: click button
+1.797s action 7: submit form
+1.798s send POST /api/graphql#3 "{variables: {data: {1 keys}}, +1}" (action 7)
+1.999s delivered POST /api/graphql#2 (held 265 ms)
+2.105s send POST /api/graphql#4 "{operationName: \"KsFetchItem\", +2}"
+2.131s delivered POST /api/graphql#3 (held 318 ms)
```

Each Enter is recorded as a key, a synthetic click on a (hidden) button, and a form submit, and each submit sends a
`createTag` with the same body. The steps show the bug to a reader. The verdict and the findings did not name it
(section 8).

### 7.2 Reproduction without GenClass

`keystone-admin-ui/throttle.mjs` is plain Playwright with nothing injected or intercepted. Chromium's network throttling
(CDP `Network.emulateNetworkConditions`, latency only) adds latency to every request. The user types a name and presses
Enter twice, 60 ms apart. Then every create response is awaited and the rows are counted through GraphQL. There were 10
trials each; the summary is in `results/throttle.json`.

| page | input | latency | two create requests | duplicate rows | "Unable to create" toast |
|---|---|---|---|---|---|
| `/tags/create` | Enter, Enter | 400 ms | 10/10 | 10/10 | 0/10 |
| `/tags/create` | Enter, Enter | 150 ms | 10/10 | 10/10 | 0/10 |
| `/tags/create` | Enter, Enter | 0 | 9/10 | 9/10 | 0/10 |
| `/tags/create` | double click on Create | 400 ms | 0/10 | 0/10 | 0/10 |
| `/authors/create` (email unique) | Enter, Enter | 400 ms | 10/10 | 0/10 | 10/10 |

The first probe (plain Playwright, `createTag` held 300 ms with `page.route`) gave 3 of 3 duplicates. The
`GENCLASS=0` loads of `hunt.mjs` gave 8 of 8 with no added latency.

### 7.3 Root cause (at `88da2cc`)

- `packages/core/src/admin-ui/pages/CreateItemPage/index.tsx`: the form's `onSubmit` (lines 35 to 43) awaits
  `createItem.create()` and then navigates. It has no check for a create in flight. Line 51 is the hidden
  `<button type="submit" style={{ display: 'none' }} />`, the react-aria workaround that makes Enter submit the form.
  The visible Create button (line 58) gets `isPending={createItem.state === 'loading'}`, and Keystar's Button swallows
  presses while pending. That is why a double click creates once. Implicit submission by Enter clicks the first submit
  button in the form, which is the hidden one, and that one is never pending.
- `packages/core/src/admin-ui/utils/useCreateItem.ts`: `create()` (line 80) validates and calls `tryCreateItem` with no
  guard either.
- For comparison, `ItemPage/index.tsx` line 232 has `if (isSaving) return` in its submit handler, so the item page's
  save is guarded (item-save: 24 of 24 as expected).

A second create can also come after the first has succeeded but before navigation to the new item has finished. With no
added latency the create returns in a few milliseconds and the second Enter lands in that window. This was measured
with the first version of the fix (section 7.4).

### 7.4 The fix

[keystone-admin-ui.patch](keystone-admin-ui.patch) (`git format-patch` against `88da2cc`; `git am` applies it cleanly):

- `useCreateItem.ts`: `const isCreatingRef = useRef(false)`. `create()` returns at once while it is set. It is set just
  before the mutation and cleared only when the create fails, so a failed create can be retried. It stays set after a
  success because the page is about to navigate away. A ref, not state, so that a second submit in the same frame is
  also caught (the Vendure hunt's lesson, [vendure.md](vendure.md)).
- The first version cleared the guard in `finally`. It fixed every latency above 0 but left 9 of 10 duplicates with no
  latency (`results/throttle.json`, "first version"), because of the post-success window above. The patch is the second
  version.
- `tests/admin-ui-tests/create-item.test.ts` (new, in `adminUITests('./tests/test-projects/basic', ...)` style):
  holds `createTask` 500 ms with `page.route`, presses Enter twice in Label, waits for navigation and every create
  response, and expects one create request and one task.
- `.github/workflows/tests_ci.yml`: the new file in the `admin_ui_integration_tests` matrix.
- `.changeset/fix-create-item-double-submit.md`: a `@keystone-6/core` patch entry worded like recent ones ("Fixes ...
  in the Admin UI").

### 7.5 Tests and the fixed variant

```bash
cd ~/targets/keystone-admin-ui
export PLAYWRIGHT_BROWSERS_PATH=<scratch dir, section 2> DATABASE_URL=file:./test.db
pnpm vitest run --maxWorkers=1 tests/admin-ui-tests/create-item.test.ts
```

| tree | create-item.test.ts (each run = dev + production pass) | other checks |
|---|---|---|
| `main` (88da2cc) | **failed 3 of 3**, both passes: `expected [ Promise{…}, Promise{…} ] to have a length of 1 but got 2` | |
| patched | **passed 3 of 3** (4 of 4 tests each run) | `relations.test.ts` 10/10, `list-view-crud.test.ts` 8/8 (and `init.test.ts` 14/14 with the first version); `tsc` clean; `oxlint` 0 warnings; `prettier --check` clean |

With the patch built into `examples/usecase-blog` (`keystone-admin-ui/results-fixed/`):

| check | result |
|---|---|
| explore, create-enter, 300 / 600 / 900 ms | no race, 0 of 6 each; one tag in 24 of 24 loads; one `createTag` per load |
| `GENCLASS=0`, create-enter, natural | one tag in 8 of 8 (in one load the second Enter landed on the new item's page and sent an empty `updateTag`, see section 9) |
| throttle, tags Enter, 400 / 150 / 0 ms | 0 of 10 each |
| throttle, authors Enter, 400 ms | 0 of 10 two requests, 0 of 10 error toasts |
| throttle, tags double click, 400 ms | 0 of 10 |

### 7.6 Upstream duplicates and related

Searched on 2026-11-03 (`gh api search/issues`, `repo:keystonejs/keystone`, issues and pull requests): "created twice",
"duplicate create", "double submit", "enter twice", "enter key create", "duplicate items", "double click create",
"submit twice". Nothing matched this bug. The closest results are #6822 (relationship select showing duplicate results,
closed 2021) and #1398 (create form submitting blank fields, Keystone 5). The brief's related items (#9993, #6351, PR
#10052) are about the relationship field and the item page's save, not create.

## 8. Problems with GenClass itself

In the order they mattered to the verdict:

1. **Every GraphQL query counts as a write.** All of the Admin UI's requests are `POST /api/graphql`, so explore's
   "number of unsafe requests to a signature" is the visible tier for queries too. A `KsFetchItem` or
   `RelationshipSelectMore` that one order sends once more became a RACE line in 7 sessions (create-enter 3,
   rel-more 2, rel-search 2) with nothing else behind it. The page, form values and API oracles agreed with the
   baseline every time. It is Ghost's class B ("request count that depends on timing") made worse by POST: there it was
   a GET and would now be internal-only. GenClass has no GraphQL awareness (no `graphql` or `operationName` anywhere
   in `packages/runtime/src` or `packages/mcp/src`). Splitting a POST body's `operationName` (or the first field of an
   unnamed operation) into the signature, and counting `query` operations as safe, would remove this class.
2. **`identical-in-flight` does not fire under explore's emulated latency.** The two `createTag` requests had the same
   method, URL and body, came from two separate user actions (4 and 7), and were both outstanding from the app's point
   of view (#2 delivered at +1.999 s, #3 sent at +1.798 s). Yet 0 witnesses were recorded in all 24 create-enter
   explore loads. Natural mode with a real 400 ms server delay does record the witness (`keystone-admin-ui/witness-probe.mjs`: `identical-in-flight
   ... by #3 over #2, gapMs 83`). `record.ts` `identical()` decides "in flight together" from the ops' `start`/`end`,
   and with a fast local server `end` is the network's end, before the schedule's hold and delay. The latency explore
   emulates does not extend "in flight" for this witness, so the duplicate-request finding that would name this bug
   never appeared.
3. **A bug in the baselines hides from the comparison.** At 900 ms one baseline also lost the sort click. Its
   difference from the other baseline was filed as noise, and the session said "no race, 0 of 6" while 5 of 8 loads lost
   the click. The duplicate create is the same in kind: present in every run, invisible to an order comparison by
   design. The report says nothing about what both baselines share. A line such as "both baselines sent 2 identical
   writes" would have named the duplicate, and "baselines disagree on visible page text" deserves a warning rather than
   silence.
4. **`~hedge` keys on a one-endpoint app.** `agent/schedule.ts` line 212 keys a request whose cause is a response of
   the same signature as `<parent key>~hedge`. Here, ordinary app queries started from a response's handlers (the
   comboboxes' first `RelationshipSelect` after `KsFetchAdminMeta`, `KsFetchItem` after a create) are labelled hedges.
   Two different requests got the same key `POST /api/graphql#1~hedge` (rel-search 900, run r3: Author's and Tags'
   first queries). A `given` replay of that run cannot tell them apart, and `identical()` skips pairs where one is the
   other's cause. Keying hedges only for GenClass's own hedges (`op.genclass` or an attempt counter) would fix it.
5. **Live-region announcements as "internal only" noise.** react-aria's combobox announces "48 options available." The
   announcement depends on timing, and it filled the "internal state only" lists (rel-search 300: 5 of 6). It is
   correctly not a RACE, but it crowds the report.
6. **Mirror-atom witnesses** (`overwrote-newer keystone.options by POST /api/graphql#2`) appeared in baselines and
   seeded runs alike in rel-more and rel-search: the attribution class Ghost's report describes (section 9, item 4).
7. **Setup.** The Local Network Access flag is still needed (Ghost, item 1). `whenSettled` is the right gate before
   opening a combobox: without it, a click on the Tags chevron while the first query was held was lost (react-aria does
   not open an empty combobox). That cost 5 failed loads in the first rel-more 300 session, which was rerun.

## 9. Notes for the scenario and the test

- Playwright's `locator.press` re-resolves the locator. After a fast create the second Enter can land in the new item
  page's Name field and submit that form (`updateTag` with no changed fields, a "Saved changes" toast). That happened
  in 1 of 8 natural loads on the fixed build. It is harmless, and it is the same thing a user's second Enter would do
  there. The regression test holds the create 500 ms, so the second Enter always lands on the create page.
- The test cannot hold the post-success window open deterministically (it would need to delay Next's route change), so
  it covers the in-flight case. The post-success case is covered by the throttle measurement at latency 0 (9 of 10
  before, 0 of 10 after).

## 10. Time spent

Session from 16:34 to about 17:35 UTC (the clock of the container), about 1 h; the phases overlap:

| phase | time |
|---|---|
| reading the brief, `swarm.md`, the Ghost and Vendure reports; GenClass build and Keystone install in parallel | 10 min |
| reading the Admin UI surfaces (list page, comboboxes, item page, create page) | 10 min, overlapping the install |
| getting the example to run: production build, `db push`, the document-field error and the SQLite seed | 8 min |
| harness and scenarios, the first duplicate probe, the GenClass debugging (witness, hedge keys) | 15 min |
| 21 explore sessions plus the rel-more rerun (about 14 min of runs), the controls and the throttle runs | 20 min |
| the fix, its revision, the Keystone test unfixed and fixed (3 runs each, about 40 s per run), the related suites | 15 min, overlapping |
| the write-up | 15 min |

## 11. Reproducing

```bash
# Keystone running as in section 2 (main, or with the patch applied for the fixed variant); from this repository:
node docs/adoption/hunts/keystone-admin-ui/seed.mjs
node docs/adoption/hunts/keystone-admin-ui/hunt.mjs smoke
bash docs/adoption/hunts/keystone-admin-ui/run-all.sh                         # every scenario at 300, 600, 900 ms
node docs/adoption/hunts/keystone-admin-ui/hunt.mjs create-enter --slow 600   # one explore session
GENCLASS=0 node docs/adoption/hunts/keystone-admin-ui/hunt.mjs create-enter   # 8 loads without GenClass
node docs/adoption/hunts/keystone-admin-ui/throttle.mjs --list tags --mode enter --latency 400 --trials 10
node docs/adoption/hunts/keystone-admin-ui/summarise.mjs                      # the table in section 5
```

Results land in `keystone-admin-ui/results/<scenario>-slow<ms>-seed1[-nogenclass].json`, with the explore report, the
findings, every `genclass_explain`, and per load the DOM, API and wire oracles.
