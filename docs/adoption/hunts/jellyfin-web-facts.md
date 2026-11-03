# Jellyfin Web: facts for the sender's own issue and pull request

**Why this file has no draft text:** Jellyfin's LLM policy prohibits LLM output in "issues or comments" and "pull
request bodies or comments", and wants "**your** words and explanations, not an LLM's". Full quotes are in
[jellyfin-web.md](jellyfin-web.md) section 0. So this file holds facts only: steps, measurements, versions, test
output and the templates' section names, for the sender to write the issue and the PR in their own words. Do not
paste from it. Nothing here was sent anywhere.

The report is [jellyfin-web.md](jellyfin-web.md), the reference patch is
[jellyfin-web.patch](jellyfin-web.patch), and the harness and results are in [jellyfin-web/](jellyfin-web/).

## The bug, as facts

- **Where:** the legacy layouts (Settings › Display › Layout "Desktop (legacy)", "Mobile (legacy)", and TV, per
  `src/constants/layoutMode.ts` `LegacyLayoutModes`). Seen on the Movies library's Movies tab. The default modern
  layout is not affected (0 of 10 with the same delay, 0 of 18 explore loads).
- **What:** two item-list requests in flight, and the older one's response arrives last. The grid then shows the
  older request's items while the control shows the newer choice. It stays wrong until the next refresh.
- **Triggers measured:**
  - alphabet picker, letter B then letter C;
  - Sort dialog, Descending then Ascending.
- **Triggers expected from the code** (same path, not measured): the filter dialog, the layout menu, and the other
  legacy library tabs and `list.js` pages that use `emby-itemscontainer`.
- **Code:** `src/elements/emby-itemscontainer/emby-itemscontainer.js` lines 361-374 at `c710e5c`, `refreshItems`.
  Line 373, `return this.fetchData().then(onDataFetched.bind(this));`, renders every response; `onDataFetched`
  (418) sets `innerHTML` (443).
- **Callers:** `src/apps/legacy/controllers/movies/movies.js` 195-206 (alphabet), 260-264 (sort), 324 (filter);
  `isLoading` guards only paging (61-81).

## Reproduction steps (for the issue's "Reproduction Steps")

1. Server and web on master (versions below), a Movies library with titles under at least two letters (here 30
   movies, e.g. "Beacon (1998)", "Bramble (1972)", "Cinder (1973)", "Comet (1999)").
2. Set the layout to "Desktop (legacy)".
3. Open the Movies library, Movies tab.
4. Make the first response slow: in DevTools, throttle the network, or block or delay the request whose query has
   `NameStartsWith=B`.
5. Click B in the alphabet picker, then C right away.
6. Expected: C's movies under a selected C. Actual: B's movies under a selected C.

**The sender must do steps 4 and 5 by hand in a real browser before filing.** The session only ran them headless
through Playwright.

## Measured (2026-11-03)

| run | result |
|---|---|
| plain Playwright, legacy, B response delayed 800 ms, unfixed | 10 of 10 runs show B's movies under C |
| same, no delay (control) | 0 of 10 |
| plain Playwright, legacy, Sort Descending then Ascending, Descending response delayed 800 ms, unfixed | 10 of 10 runs show a descending grid under Ascending (first "Zephyr (1996)", last "Anvil (1997)") |
| same, no delay | 0 of 10 |
| modern layout, B response delayed 800 ms | 0 of 10 |
| fixed build, alpha and sort, 800 ms delay | 0 of 10 and 0 of 10 (two rounds) |
| GenClass explore, legacy alpha, 300 / 600 / 900 ms extra latency, 6 reordered loads each | 1 / 2 / 2 of 6 wrong. These are exactly the loads that delivered C before B. Fixed build: 0 / 0 / 0 |

Timeline of one failing run (from the page load; GenClass explore at 600 ms, seed 4):

| t | event |
|---|---|
| 4.670 s | click B → `GET /Users/{id}/Items?…NameStartsWith=B` sent |
| 4.727 s | click C → `GET /Users/{id}/Items?…NameStartsWith=C` sent |
| 5.213 s | C response delivered → grid "Cinder (1973), Comet (1999)" |
| 5.244 s | B response delivered → grid "Beacon (1998), Bramble (1972)"; letter stays C |

## Versions (for the issue template's version fields)

| field | value |
|---|---|
| Server version | 13.0.0, master `5b385862fb97201d954a6ac7c9c745d791a738fa` (2026-11-01), built from source with .NET SDK 10.0.114 |
| Web version | 13.0.0, master `c710e5c2773f4bdf007607efe2120139708ff3ed` (2026-11-03) |
| Build version | development build (`npm run build:development`) |
| Platform | Linux (Ubuntu 24.04) |
| Browser | Chromium 153.0.8010.12 headless (Playwright 1.63.0) |
| Plugins | none |

If the sender reproduces on their own setup (e.g. a 10.11 or 12.x release server), use those versions instead. The
template asks for what the reporter ran.

## The reference fix (`jellyfin-web.patch`, two commits on `c710e5c`)

1. `src/utils/requestSequence.ts` (new, 15 lines) and `src/utils/requestSequence.test.ts` (new, 4 tests).
2. `src/elements/emby-itemscontainer/emby-itemscontainer.js`: import, then in `refreshItems` take a "still latest?"
   check before `fetchData()` and call `onDataFetched` only if it holds (+12, -1).

Points the sender should be able to explain in review, in their own words:
- why the guard sits in `refreshItems` (all legacy items views go through it);
- why the promise still resolves for a superseded call (`list.js` chains `.then(() => scrollTo)`);
- why not abort the request (`fetchData` implementations take no signal);
- why the test covers the helper rather than the element (legacy view code is "deemed untestable", and the element
  needs the webcomponents polyfill in jsdom);
- the `list.js` paging caveat (report section 4.3): `updatePaging` in `list.js` `fetchData` still runs for a
  superseded response. It was not changed.

The commit subjects follow the imperative, non-Conventional-Commits style. The author line in the patch is a
placeholder (`Reference-fix`), and each commit carries a `Co-Authored-By: Claude` trailer. The sender commits under
their own name and decides what attribution to keep. No `.claude` or other metafiles are in the patch.

## Test output (Node 24.22.2, `~/targets/jellyfin-web`)

```
$ npx vitest --watch=false --config vite.config.ts src/utils/requestSequence.test.ts      # fixed, 3 runs
 ✓ src/utils/requestSequence.test.ts (4 tests)      Tests  4 passed (4)       (each of 3 runs)
# unfixed behaviour (the check always true), 3 runs:
   × createRequestSequence > reports an older request as superseded once a newer one starts
   × createRequestSequence > keeps the newer results when the older response arrives last
 Failed Tests 2                                                                 (each of 3 runs)
$ npm test                    Test Files  16 passed (16)   Tests  199 passed (199)
$ npx tsc --noEmit            (clean)
$ npx eslint <3 files>        (clean)
```

Not run: `npm run build:production`, `npm run escheck`, `npm run stylelint` (no style files changed). Run them before
opening the PR.

## Templates to fill (their section names; write the content yourself)

**Bug report** (`.github/ISSUE_TEMPLATE/1-bug-report.yml` at `c710e5c`):
- three required checkboxes: not already reported, code of conduct, single issue;
- Describe the bug; Reproduction Steps; Expected/Actual behaviour; Logs; Server version; Web version; Build version;
  Plugins; Platform; Browser; Additional information.

**Pull request** (`.github/pull_request_template.md` at `c710e5c`):
- **Changes** ("Describe your changes here in 1-5 sentences").
- **Issues** ("Fixes #").
- **Code assistance**: "List the exact tool, model, and version used and the specific actions that it performed …
  Do NOT editorialize". Facts for it: the tool was Claude Code (the session's configured model is in the session
  record; check it before writing). Actions: located the code path, wrote the Playwright harness and reproduction,
  drafted the helper, the test and the `refreshItems` change, and ran the tests. Then list what the sender changed
  or rewrote themselves.
- Checklist:
  - read and followed the contributing guidelines;
  - tested these changes;
  - not duplicating an existing PR;
  - **a substantive review of another open web PR**. Only the sender can do this, before opening.

## Before sending (only a person can do these)

1. Search the tracker again, since 2026-11-03, for "alphabet", "letter", "sort", "itemscontainer" and "stale"
   (issues and PRs). On 2026-11-03 none matched. #8489 (initial default-order flash) and #8481 are related, not
   duplicates.
2. Reproduce by hand in a real browser (steps above), on master and if possible on the current stable release.
3. Read the patch and rewrite it as you would write it. Be able to defend every line. Run `npm test`, `tsc` and
   eslint again.
4. Open the bug issue first, in your own words, using the facts above. Then the PR, targeting `master`, referencing
   the issue, with the template fully completed.
5. Do the substantive review of another open web PR (checklist item).
6. Handle review feedback yourself. Expect two team-member reviews, and rebase churn: the apiClient migration PRs are
   landing weekly.
7. If you mention GenClass at all, one factual sentence in your own words about how the race was found, at the end.
