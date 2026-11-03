# Directus Studio: fact sheet

Raw facts for writing the issue by hand. Not issue text. Everything below was measured locally; details and the full
tables are in [directus.md](directus.md). Directus is source-available (its own licence, MSCL 1.0), not OSI open
source. Refreshed on 2026-11-03 against today's `main` (section "Refresh (2026-11-03)" of the report): the bug still
reproduces there, the code below is unchanged since v12.5.1, and the links point at that `main` commit. Directus's guide asks for: reproduction steps, version, hosting strategy,
database, and a schema snapshot (https://directus.com/docs/raw/community/reporting-and-support/bug-reporting.md).

## Area

- Scope: Studio (app). Core area: content module, item view.
- Component: `useItem()` (`app/src/composables/use-item/index.ts`), used by `app/src/modules/content/routes/item.vue`.

## Version and environment

| field | value |
|---|---|
| Directus | `main` at `88c5c470b14bdf3501a2a31e429273087f22e937` (2026-11-02, after v12.6.0; `directus` 12.6.0, `@directus/app` 19.0.0, `@directus/api` 41.0.0). First found on 12.5.1 (tag `v12.5.1`, commit `2cd112f1a1afe42829d2e4de899d07ce4394649c`); the files involved are identical in both |
| Hosting | self-hosted, local, from source: `cd api && pnpm dev` (API) + `cd app && pnpm dev` (Vite dev server); in the form: "Self-Hosted (Custom)" |
| Database | SQLite (`DB_CLIENT=sqlite3`, `sqlite3` 6.0.1) |
| Node / pnpm | 26.13.0 / 12.4.1 on `main` (the repository now requires Node 26); 22.22.0 / 10.27.0 on 12.5.1 |
| Browser | Chromium 153.0.8010.12 (headless, Playwright 1.63.0) |
| OS | Ubuntu 24.04.5 |
| Non-default env | `CACHE_ENABLED=false`, `TELEMETRY=false`; `RATE_LIMITER_ENABLED=false` and websockets off are the defaults |
| Production build | not tested |

## Schema snapshot

- File: [directus/schema-snapshot.yaml](directus/schema-snapshot.yaml) (`GET /schema/snapshot?export=yaml`, 633 lines).
- Needed for the reproduction: a collection with an M2O field to itself (or to any collection) whose interface option
  "Item link" ("Show a link to the item", `enableLink: true`) is on, so the field shows a "Navigate to Item" link.
- Used here: `articles` (`title`, `summary`, `status`, `topic`, `author` M2O -> `authors`, `related` M2O ->
  `articles` with `enableLink: true`); `related`: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 1.
- Rows used: article 1 "Alpha: launch checklist" / summary "Alpha body: the steps before a launch."; article 2
  "Bravo: incident review" / summary "Bravo body: what failed on Tuesday.".

## Reproduction steps (UI)

1. Open the Articles collection list (`/admin/content/articles`).
2. Click the row for article 1. Wait until it has loaded.
3. On the Related field, click "Navigate to Item" (launch icon). URL becomes `/admin/content/articles/2`.
4. Before article 2 has loaded, click the back arrow in the header. URL becomes `/admin/content/articles/1`.
5. Condition for the bug: the response for article 2 arrives after the response for article 1 (article 2 slower).
6. Optional: append text to the Summary field and click Save.

Notes:

- Step 1 matters: if article 1 is opened directly by URL, the back arrow goes to the list instead (separate
  observation, `item.vue` lines 812-815).
- On a fast local server the responses usually arrive in order (0 of 12 runs stale without a delay). The reproduction
  needs article 2's response to be slower; the automated script below holds it.

## Reproduction (automated, no GenClass)

- Script: [directus/confirm-plain.mjs](directus/confirm-plain.mjs) (plain Playwright; logs in, dismisses the license
  prompts with their own cookies, delays only GET requests matching `/items/articles/2` by `--delay` ms).
- Command: `node confirm-plain.mjs --delay 600 --gap 100 --repeat 3` (add `--save summary` for the Save check).
- Results:

| delay of article 2's response | stale form under `/articles/1`, 12.5.1 (2026-10-25) | stale form, `main` 88c5c47 (2026-11-03) |
|---|---|---|
| 0 ms | 0 of 12 | 0 of 12 |
| 300 ms | 7 of 14 | 9 of 12 (stale at gaps 50, 100, 200 ms; not at 300 ms) |
| 600 ms | 12 of 12 | 12 of 12 |
| 900 ms | 12 of 12 | 12 of 12 |

## Observed vs expected

| | observed | expected |
|---|---|---|
| URL | `/admin/content/articles/1` | `/admin/content/articles/1` |
| Header title | "Articles: Bravo: incident review" (in some runs; others "Alpha") | "Articles: Alpha: launch checklist" |
| Title field | "Bravo: incident review" | "Alpha: launch checklist" |
| Summary field | "Bravo body: what failed on Tuesday." | "Alpha body: the steps before a launch." |
| Status / Topic | Review / redis | Draft / rest |
| Form state | editable with article 2's values, no error shown (the Save checks edited it) | article 1's values |
| Save after appending " Reviewed." to Summary | `PATCH /items/articles/1` body `{"summary": "Bravo body: what failed on Tuesday. Reviewed."}`; article 1's summary in the database becomes that text (3 of 3 on 12.5.1, 3 of 3 on `main` 88c5c47) | article 1's own summary plus " Reviewed." |
| Save after replacing Title | `PATCH /items/articles/1` body `{"title": "Alpha: launch checklist v2"}`; only the title changes (3 of 3 on each) | same |
| Fields not edited | not written (3 of 3) | not written |

## Request and response timestamps (one stale run)

Delay 600 ms, gap 100 ms; ms after clicking "Navigate to Item":

| event | ms |
|---|---:|
| `GET /items/articles/2` sent | 86 |
| header back arrow clicked | 209 |
| `GET /items/articles/1` sent | 300 |
| `GET /items/articles/1` response | 341 |
| `GET /items/articles/2` response | 714 |

Same order found by GenClass without any delay on the server (its schedule held the received response for article 2):
article 2 sent +9.949 s, article 1 sent +10.160 s, article 1 delivered +10.216 s, article 2 delivered +10.960 s, form
title changed to "Bravo: incident review" at +10.985 s.

## Root cause (file and lines; the same at v12.5.1, v12.6.0 and `main` 88c5c47)

- `getItem()` assigns the response with no staleness check:
  https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/composables/use-item/index.ts#L151-L169
- Refired on key change: https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/composables/use-item/index.ts#L116
- `refresh()` / `refreshItem()` do not invalidate the in-flight request:
  https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/composables/use-item/index.ts#L543-L565
- Save PATCHes the current key with the edits:
  https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/composables/use-item/index.ts#L171-L225
- Component reused across keys (unkeyed RouterView, `props: true` route):
  https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/app.vue#L136,
  https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/utils/router-passthrough.ts,
  https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/modules/content/index.ts#L278-L281
- The navigation path (relation link, back arrow uses browser history):
  https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/interfaces/select-dropdown-m2o/select-dropdown-m2o.vue#L218-L231,
  https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/modules/content/routes/item.vue#L809-L815,
  https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/views/private/private-view/components/private-view-header-bar-icon.vue#L16-L18

## Same pattern nearby (lower severity)

| where | symptom seen | how often (GenClass, reordered runs) |
|---|---|---|
| `use-template-data.ts` `fetchTemplateValues()` [L64-L100](https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/composables/use-template-data.ts#L64-L100) | header title of article 2 on article 1 | 15 of 72 (header only) |
| `use-relation-single.ts` `getDisplayItem()` [L63-L124](https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/composables/use-relation-single.ts#L63-L124) | M2O display (Author, Related) of the other item | 12 of 72 (display only) |
| `input-autocomplete-api.vue` `fetchResultsRaw()` [L43-L74](https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/interfaces/input-autocomplete-api/input-autocomplete-api.vue#L43-L74) | suggestions for "re" while "rea" is typed | 12 of 36 |
| Related picker drawer, two choices in a row | none | 0 of 18 |

## Existing guards in Directus (house style)

- Generation counter: https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/packages/composables/src/use-items.ts#L334-L358
  (`getItemCount`; also `getTotalCount` L309-L332, comment "prevents race conditions when navigating between
  collections quickly").
- Key check: https://github.com/directus/directus/blob/88c5c470b14bdf3501a2a31e429273087f22e937/app/src/composables/use-relation-multiple.ts#L510-L517
  (comment "This can happen if the user navigates to a different item while the request is in progress").

## Fix (prepared, not submitted)

- Patch: [directus.patch](directus.patch) (against `main` at `88c5c47`, `git apply`; it also applies to `v12.5.1` and
  `v12.6.0`). It adds a changeset (`'@directus/app': patch`) for the sender to reword.
- `use-item/index.ts`: `let itemGeneration = 0`; `getItem()` takes `const currentGeneration = ++itemGeneration` and
  ignores the result, the error and the `loadingItem` reset when the generation moved; `refreshItem()` bumps it for a
  new item (`+`).
- Same guard in `use-template-data.ts` and `use-relation-single.ts`; in `input-autocomplete-api.vue` a variant that
  skips only responses older than the last applied one (discarding every superseded response left the menu closed in
  3 of 18 runs). All three are separable from the `use-item` fix.
- Tests: 6 new (3 in `use-item/index.test.ts`, 1 each in `use-template-data.test.ts`, `use-relation-single.test.ts`,
  new `input-autocomplete-api.test.ts`): fail before, pass after. Prettier and ESLint clean.
- Fixed build, same harness: stale form 0 of 24 reordered runs (was 29 of 72) with the `use-item` guard alone; with
  all guards 0 stale form, header or display in 24, 0 stale autocomplete menus in 18 (was 12 of 36).
- Fixed build, plain script: 0 stale in 47 runs at delays 0 to 900 ms; Save after appending wrote article 1's own
  summary plus the edit (3 of 3).
- On `main` 88c5c47 (2026-11-03): tests 6 failed before, 40 of 40 passed after, 3 runs each way; fixed build, plain
  script 0 stale in 48 runs (delays 0 to 900 ms), Save wrote article 1's own text (3 of 3 per edit); GenClass explore
  0 stale views in 24 reordered runs (unfixed: 11 stale forms in 23 compared runs at the same settings).

## Duplicate check (2026-11-03)

Searched with the GitHub search API (`gh api -X GET search/issues -f q='repo:directus/directus is:<issue|pull-request>
<terms>'`, 3 s apart), each term for issues and for pull requests: `stale item navigate`, `"wrong item" navigation`,
`back arrow previous item`, `useItem race`, `race condition item view`, `navigate to item shows`, `item page shows data
of previous item`, `getItem abort`; and every issue (16) and pull request (38) opened since 2026-10-24. None describes
this bug or touches `use-item`. Nearest, all different:

- Issue #28430 (open, 2026-10-28): Insights bar chart renders empty because multi-query panel results come back out of
  order (another out-of-order response bug, in `insights`; PR #28442 open).
- PR #26906 (closed, 2026-03-17): "fix(app): deduplicate aggregate count requests on content navigation" (counts in
  the collection view, by its title; not opened).
- PR #27410 (closed, 2026-05-10): "Fix Studio tab refresh race" (by its title a different race; not opened).

No open pull request among those checked (#28449, #28439, #28437, #28443, #28412, #28423, #28442, #28446, #28398,
fetched with `git fetch origin pull/<n>/head`) changes `use-item/index.ts`, `use-template-data.ts`,
`use-relation-single.ts`, `input-autocomplete-api.vue` or `item.vue`. Repeat the search on the day of filing.

## Directus's rules for the sender (read 2026-11-03 at `main` 88c5c47)

- `ai_policy.md`: AI-assisted code with a human in the loop is allowed; the contributor must fully understand it and is
  responsible for it. Fully autonomous agents may not create issues or pull requests; contributions suspected to be
  generated without meaningful human involvement are closed. Issue, PR and comment text must be the sender's own (no
  copy-paste of AI-generated text); AI-generated content included for context must be disclosed and put in a quote
  block (`>`) with the sender's own explanation of why it is relevant. This file is therefore a fact sheet, not issue
  text.
- `AGENTS.md` at the repository root tells automated agents to add 🤖🤖🤖 to an issue or PR title to be
  "fast-tracked". The sender is a person filing by hand under `ai_policy.md`: do not add it.
- Issue form (`.github/ISSUE_TEMPLATE/bug_report.yml`, blank issues disabled): Describe the Bug, To Reproduce (attach
  the schema snapshot: [directus/schema-snapshot.yaml](directus/schema-snapshot.yaml)), Directus Version (`12.6.0`, or
  the `main` commit), Hosting Strategy (`Self-Hosted (Custom)`), Database (`SQLite 3`, `sqlite3` 6.0.1). Its preamble
  asks the reporter to be on the latest version and to have done the troubleshooting steps
  (https://directus.com/docs/community/reporting-and-support/troubleshooting-steps).
- Pull request template (`.github/pull_request_template.md`): What's Changed, Tested Scenarios, Review Notes /
  Questions / Concerns, Checklist (tick "Tests added/updated"; the rest does not apply), footer `Fixes #<issue>`.
  Titles are plain imperative sentences (recent merges: "Use a set for v-table row selection checks").
- CLA (`cla.md`): add the sender's GitHub username to `contributors.yml` in the pull request; unsigned pull requests
  are closed by the CLA bot. Not in the patch (it is the sender's name).
- Changesets: `.changeset/*.md`, `'@directus/app': patch`, one past-tense sentence. The patch adds
  `.changeset/stale-item-navigation.md`; reword it in your own words.
- Contribution guide: https://directus.com/docs/community/contribution/pull-requests (the repository's
  `contributing.md` only links there).

## Before filing (checklist for the sender)

Done by the 2026-11-03 session (evidence in the report's "Refresh (2026-11-03)"):

- [x] Duplicate search since the hunt date (above): none found.
- [x] Reproduced on the latest code (`main` 88c5c47, after 12.6.0) without GenClass: stale form in 0 of 12 runs with no delay and 33 of 36 with article 2's
      response delayed 300 to 900 ms; Save wrote article 2's summary into article 1 in 3 of 3.
- [x] The patch applies to that `main` unchanged; the new tests fail on the unfixed code and pass on the fixed code,
      three runs each way: 6 failed and 34 passed in each of 3 runs before, 40 of 40 passed in each of 3 runs
      after (the four test files, vitest 4.1.12).
- [x] `pnpm lint` (0 errors; 78 warnings, none in the changed files), `pnpm lint:style` and `pnpm format` pass
      on the patched tree; the changeset file was written by hand in the format of the four already in `.changeset/`
      (`pnpm changeset` is interactive).

Left for the sender, by hand (each is a sentence of the issue or PR the sender must be able to make true):

- [ ] Reproduce by hand in a browser: follow "Reproduction steps (UI)" above with DevTools network throttling, or run
      `confirm-plain.mjs` and watch it (`--delay 600 --gap 100`), on your own checkout of `main`.
- [ ] Run the tests yourself: `cd app && pnpm vitest run src/composables/use-item/index.test.ts
      src/composables/use-template-data.test.ts src/composables/use-relation-single.test.ts
      src/interfaces/input-autocomplete-api/input-autocomplete-api.test.ts` without and with the patch.
- [ ] Read the whole diff until you can explain every line (`ai_policy.md`: "You must fully understand any
      AI-assisted code you submit"). Decide whether to send the three sibling guards in the same PR or split them.
- [ ] Write the issue and the PR description in your own words, with the facts above; anything you paste from this
      sheet or the report goes in a `>` quote block marked as AI-generated, with your own sentence on why it matters.
- [ ] Search the tracker again on the day of filing.
- [ ] Add your username to `contributors.yml` in the PR (CLA).
- [ ] Do not add 🤖🤖🤖 to any title.

## Disclosure material

- Found with GenClass (`@genclass/runtime` 0.3.0-beta.1 explore, local MCP bridge), then confirmed with a plain
  Playwright script with no GenClass code; re-confirmed on 2026-11-03 on `main` with the same plain script.
- The analysis and the patch were prepared with an AI coding agent; Directus's `ai_policy.md` requires a human in the
  loop, own wording, and disclosure of AI-generated content in quote blocks.
- The adoption swarm's standard disclosure paragraph, to say in your own words in the issue and the PR: "I used Claude
  (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed the change and
  ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which replays the same
  steps with the server's responses delivered in different orders." Under Directus's policy the description itself
  must be yours, so drop "and draft this description" unless you include drafted text in a quote block.
