# Race hunt: Jellyfin Web (13.0.0, master)

A GenClass race hunt on Jellyfin Web, run on 2026-11-03 in a cloud session. The real `@genclass/runtime` and
`@genclass/mcp` (this repository at `c1c9e14`) were injected from outside by Playwright, and the MCP server was
driven the way a coding agent drives it. Jellyfin Web's source was not modified for the hunt. The fix is a
**reference** patch for a person to rewrite and own (`jellyfin-web.patch`). The facts that person needs to write
their own issue and pull request are in `jellyfin-web-facts.md`. Nothing was sent to Jellyfin's repositories,
forum, chat or maintainers.

**Status: needs owner decision.** The race is real and reproduced without GenClass. The fix and its test pass.
Jellyfin's policy bans LLM-written prose in issues, PR bodies and comments (quoted in section 0), so this hand-back
has no paste-ready text, and someone has to write and defend the issue and PR in their own words. The owner
decides who does that and whether to send it.

**Headline.** The legacy library views render whichever item-list response arrives last. On the Movies tab in the
legacy desktop layout, a click on letter B and then letter C in the alphabet picker sends two `GET
/Users/{userId}/Items` requests. When B's response arrives after C's, the grid shows B's movies (Beacon, Bramble)
under a selected C, and it stays that way. The same happens with Sort: picking Descending and then Ascending can
leave the grid in descending order under a checked "Ascending".

- **Explore (GenClass):** the alphabet-picker scenario was reported in 1, 2 and 2 of 6 reordered loads at 300, 600
  and 900 ms. That is every load whose seed delivered C before B (5 of 5), and none of the other 13 or of the 6
  baselines.
- **Without GenClass:** plain Playwright that only delays the B response by 800 ms reproduces the race in 10 of 10
  runs (sort: 10 of 10). The no-delay control gives 0 of 10 for both.
- **The fix:** an 8-line guard in `emby-itemscontainer.js` `refreshItems` plus a 15-line TypeScript helper with a
  Vitest test. With it, the delayed-response script gives 0 of 10 (alpha) and 0 of 10 (sort), and explore gives
  0 of 18 on the alphabet scenario. The test fails on the unfixed behaviour (2 of 4 cases, 3 of 3 runs) and passes
  fixed (3 of 3 runs). The full suite (199 tests), `tsc --noEmit` and eslint pass.
- **The modern React layout** (the default on desktop) is not affected: 0 of 18 explore loads, and 0 of 10 with the
  delay.
- **Two smaller observations:**
  - A double click on the legacy favourite (heart) button sends two `POST …/FavoriteItems/{id}`, mark and mark, in
    24 of 24 loads. It is deterministic, not an ordering race (section 5).
  - #8277 (a duplicate item request on the details page) did not reproduce on a fresh details load today: one item
    request in both layouts (section 5).

Sections: 0 policy, 1 setup, 2 how the app was driven, 3 scenarios and verdicts, 4 the finding, 5 other
observations, 6 problems with GenClass itself, 7 time spent, 8 reproducing.

## 0. The target's policy (read first)

From `docs/general/contributing/llm-policies.md` in jellyfin/jellyfin.org at `56b8cf9` (2026-11-02). This is the
source of https://jellyfin.org/docs/general/contributing/llm-policies, which this session's network policy blocks:

> LLM output is **expressly prohibited** for any direct communication, including the following: issues or comments
> […] pull request bodies or comments […] In short, if you are posting **any** of those things, the output must be
> your own words, explanation, description, etc., not a verbatim dump of an LLM's output. We expect you to understand
> what you're posting. Violating this rule will result in closure/deletion of the offending item(s).

> You must **review the output** and be able to **explain** in the PR body - **without** LLM output as noted above -
> **what is being changed and why**. […] If **you can't explain** what the LLM did, we are **not interested** in the
> change.

> […] do not commit LLM metafiles (e.g. `.claude` configs) […] you are free to use LLMs to **assist** you, but not as
> the sole source of code changes.

From jellyfin-web `CONTRIBUTING.md` at `c710e5c`:
- New files **MUST** be TypeScript.
- Changes **SHOULD** be covered by unit tests when possible ("legacy component/view code is deemed untestable").
- PRs **SHOULD NOT** use Conventional Commits, **MUST** be tested and **MUST** fully complete the PR template:
  "Failing to do so will result in the PR being closed as invalid without review".

The development guide (same jellyfin.org commit) says to create an issue first. PRs need two team-member reviews
and an imperative title.

What this means for the hand-back:
- `jellyfin-web-facts.md` holds facts (steps, timeline, versions, test output, the template's section names), not
  sentences to paste.
- The patch is a reference: the sender reads it, rewrites what they would write differently, must be able to
  explain every line, and fills the template's "Code assistance" section with the exact tool, model and actions,
  without editorialising.

## 1. Setup

| what | version |
|---|---|
| Jellyfin Web | master `c710e5c2773f4bdf007607efe2120139708ff3ed` (2026-11-03T07:00:42Z), `package.json` 13.0.0, built with `npm run build:development` |
| Jellyfin Server | master `5b385862fb97201d954a6ac7c9c745d791a738fa` (2026-11-01), reports 13.0.0, built with `dotnet build Jellyfin.Server -c Release` on Ubuntu's `dotnet-sdk-10.0` 10.0.114 |
| ffmpeg | Ubuntu's 6.1.1-3ubuntu5 (not jellyfin-ffmpeg: see below); only ffprobe for the library scan was needed |
| Node, npm | 24.22.2 and 11.19.1 for Jellyfin Web (its `engines` and `engine-strict` refuse Node 22); 22.23.4 for GenClass |
| browser | Chromium 153.0.8010.12 (headless), Playwright 1.63.0 |
| GenClass | this repository at `c1c9e14`, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |
| media | 30 movies, one folder each (`Aurora (1971)` … `Dune (2000)`), 2–6 s VP9/Opus webm at 160x90 made with ffmpeg's `testsrc`/`sine`; no internet metadata |

The brief's server route was the official apt repository's `unstable` component, but `repo.jellyfin.org` is refused
by this session's egress policy (HTTP 403 on CONNECT), and so is `jellyfin.org`. The server's README route
(`dotnet run --project Jellyfin.Server --webdir …`) works with Ubuntu's own .NET 10 SDK package. `npm install` of
jellyfin-web fails here on one dependency, which is a GitHub archive tarball
(`classlist.js: https://github.com/eligrey/classList.js/archive/1.2.20180112.tar.gz`, HTTP 403 from the proxy). I
cloned that tag with git, pointed the dependency at the clone for the install only, and restored `package.json` and
`package-lock.json` before building. The patch does not touch either file.

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# Node 24 for jellyfin-web (a local copy; the image's Node 22 stays the default)
curl -fsSLO https://nodejs.org/dist/latest-v24.x/node-v24.22.2-linux-x64.tar.xz && tar xf node-v24.22.2-linux-x64.tar.xz
export PATH=$PWD/node-v24.22.2-linux-x64/bin:$PATH

# Jellyfin Web
git clone https://github.com/jellyfin/jellyfin-web.git ~/targets/jellyfin-web && cd ~/targets/jellyfin-web
npm install && npm run build:development        # dist/
npm test                                         # vitest, jsdom

# Jellyfin Server
apt-get install -y dotnet-sdk-10.0
git clone https://github.com/jellyfin/jellyfin.git ~/targets/jellyfin && cd ~/targets/jellyfin
dotnet build Jellyfin.Server -c Release -o ~/targets/jfbin          # 1 min 48 s here
mkdir -p /srv/jf/{data,config,cache,log,media/movies}
# media: for each name, ffmpeg -f lavfi -i testsrc=size=160x90:rate=10:duration=N -f lavfi -i sine=... -c:v libvpx-vp9 -c:a libopus "Name (Year)/Name (Year).webm"
~/targets/jfbin/jellyfin --datadir /srv/jf/data --configdir /srv/jf/config --cachedir /srv/jf/cache \
  --logdir /srv/jf/log --webdir ~/targets/jellyfin-web/dist --ffmpeg /usr/bin/ffmpeg &
bash docs/adoption/hunts/jellyfin-web/seed.sh   # startup wizard via the API: admin "hunt", Movies library, waits for 30 movies
```

## 2. How the app was driven

The harness is [`jellyfin-web/explore.mjs`](jellyfin-web/explore.mjs), following the Gitea pattern:
- A Playwright route rewrites the served `/web/index.html` to load `genclass.global.js` from a virtual same-origin
  path (`/web/__genclass/rt/`), started with `model: false`, `telemetry: false`, `report: "silent"`. It then
  connects `dist/agent.js` to an MCP bridge started in-process with `serve()`.
- The browser context has the `local-network-access` permission.
- One login through the real login form; its `localStorage` is reused by every load, and each load gets a fresh
  context.
- The layout is chosen through the app's own `layout` localStorage key: `desktop-legacy`, or none for the default
  modern layout.
- The legacy views are plain DOM, so the injected script mirrors three page regions with `rt.atom()` from a
  `MutationObserver`:
  - `grid.titles`: the card titles of the visible items grid;
  - `letter.value`: the selected alphabet letter;
  - `details.title` and `details.favorite`: the details page's title and heart state.

  The verdict compares those, the page text, form values, request counts and errors. GenClass also found the
  React providers' state on its own (`ApiProvider`, `CustomCss`, `UserSettingsProvider`).

For each scenario and each `slow_ms` in 300, 600 and 900: one explore session of 2 fifo baselines and 6 seeded loads,
the same steps each load, then `genclass_explore report`, `genclass_explain` on a race finding, and
`genclass_findings`. My own oracle sits beside GenClass's verdict, read from the DOM after `whenSettled()`: the
selected letter against the grid, the first and last titles against the sort order, the details title, and the
heart against the server's `UserData.IsFavorite`.

## 3. Scenarios and verdicts

"Oracle" is my own check of what the page shows. The verdict counts are GenClass's RACE lines out of 6 reordered
loads per latency.

| scenario | steps | oracle (bad / loads) | explore 300 / 600 / 900 ms | classification |
|---|---|---|---|---|
| legacy-alpha | Movies tab, legacy layout: click B, then C | **5 / 24**: the grid shows B's movies under C, in exactly the 5 seeded loads that delivered C before B | **1 / 2 / 2** RACE (`f4` at 600 ms) | **real race** (section 4) |
| legacy-sort | Movies tab, legacy layout: Sort, Descending, then Ascending | **6 / 24**: descending grid under "Ascending", in the loads that delivered Ascending's response first | 0 / 1 / 2 RACE | **real race, same root cause**; the verdict missed it (section 6.1) |
| modern-alpha | Movies, default (modern React) layout: click B, then C | 0 / 24 | 0 / 0 / 0 | no race: React Query keys each letter's query separately |
| details | open Aurora's details, then Bramble's 50 ms later | 0 / 24 (title always Bramble) | 0 / 5 / 4 RACE | **not a bug**: a wall-clock line and loads not finished at the quiet point (section 6.2, 6.3) |
| favorite | Bramble's details, legacy layout: double-click the heart | 0 / 24 order-dependent; **24 / 24 send two "mark favourite" POSTs** | 0 / 6 / 6 RACE; `duplicate-request` finding in all 3 sessions | RACE lines: **not a bug** (wall clock). Duplicate request: **real, deterministic** (section 5.1) |
| search | Search, legacy layout: type "Bra", pause 400 ms, type "mble" | 0 / 24 | 0 / 0 / 0 | no race (the search is debounced, and each section is its own React Query) |

Summary JSON per scenario: [`jellyfin-web/results/unfixed/`](jellyfin-web/results/unfixed/). It also holds the full
explore report, findings and explanation for `legacy-alpha` at 600 ms, `legacy-sort` at 900 ms, `details` at 600 ms
and `favorite` at 600 ms.

## 4. The finding

### 4.1 What explore saw (legacy-alpha, 600 ms, run r14, seed 4; from `genclass_explain f4`)

Causal order, times from the page load, quoted from the recorded timeline:

```
+4.110s send GET /Users/:id/Items#1 "?SortBy=SortName,ProductionYear&SortOrder=Ascending&Include…"   (the tab's first load)
+4.355s write grid.titles by GET /Users/:id/Items#1: "" → "Anvil (1997),Aurora (1971),Bea…"
+4.670s action 0: click button "B"
+4.671s send GET /Users/:id/Items#2 (action 0)                       NameStartsWith=B
+4.674s write letter.value by action 0: "" → "B"
+4.727s action 1: click button "C"
+4.727s send GET /Users/:id/Items#3 (action 1)                       NameStartsWith=C
+4.728s write letter.value by action 1: "B" → "C"
+5.213s delivered GET /Users/:id/Items#3 (held 455 ms)
+5.217s write grid.titles by GET /Users/:id/Items#3: "Anvil (1997),…" → "Cinder (1973),Comet (1999)"
+5.244s delivered GET /Users/:id/Items#2 (held 544 ms)
+5.246s write grid.titles by GET /Users/:id/Items#2: "Cinder (1973),Comet (1999)" → "Beacon (1998),Bramble (1972)"
```

The verdict, verbatim:
- "page text only in the baseline: "Cinder (1973)", "1973", "Comet (1999)", "1999"; page text only in this run:
  "Beacon (1998)", "1998", "Bramble (1972)", "1972"".
- "witness only here: overwrote-newer grid.titles by GET /Users/:id/Items".

The letter stays C: the picker's selection is set by the click, not by the response.

### 4.2 Reproduction without GenClass

[`jellyfin-web/repro.mjs`](jellyfin-web/repro.mjs) is plain Playwright with nothing injected into the page. On the
legacy Movies tab it clicks B then C, and a `page.route` holds only the request with `NameStartsWith=B` for
`--delay` ms before letting it continue. With `--surface sort` it holds the `SortOrder=Descending` request instead.

| build | surface | delay | grid disagrees with the selected control |
|---|---|---|---|
| unfixed | alpha | 800 ms | **10 of 10** (grid "Beacon (1998),Bramble (1972)", letter C) |
| unfixed | alpha | 0 (control) | 0 of 10 |
| unfixed | sort | 800 ms | **10 of 10** (first "Zephyr (1996)", last "Anvil (1997)" under Ascending) |
| unfixed | sort | 0 (control) | 0 of 10 |
| unfixed | alpha, modern layout | 800 ms | 0 of 10 |
| fixed | alpha | 800 ms | 0 of 10 (twice: before and after the comment-only amend) |
| fixed | sort | 800 ms | 0 of 10 (twice) |

By hand: open Movies in the legacy layout (Settings › Display › Layout: "Desktop (legacy)"). In DevTools, throttle
the network ("Slow 4G" or a custom profile) and click two letters of the alphabet picker in quick succession. The
grid can end on the first letter. I did not run the throttled-by-hand check: there is no interactive browser here.
The sender must do it.

### 4.3 Root cause (paths and lines at `c710e5c`)

- `src/elements/emby-itemscontainer/emby-itemscontainer.js:361-374`: `refreshItems` calls `this.fetchData()` and
  renders its result unconditionally (`return this.fetchData().then(onDataFetched.bind(this));`, line 373).
  `onDataFetched` (line 418) replaces the container's HTML with the result (`this.innerHTML =
  this.getItemsHtml(items);`, line 443) and calls `afterRefresh` (line 454). No check ties the response to the latest
  refresh. Two refreshes in flight render in arrival order, so the older one can win.
- `src/apps/legacy/controllers/movies/movies.js`: the alphabet picker handler (195-206) mutates the shared `query`
  (`NameStartsWith`) and calls `itemsContainer.refreshItems()` on every letter. The sort menu callback (260-264) and
  the filter dialog (324) do the same. `isLoading` (29, 45) is checked only by the paging buttons (61-81).
- The same container serves `src/apps/legacy/controllers/list.js` (refreshes at 373, 392, 410, 463, 473, 653) and the
  other legacy library tabs, so the fix covers them. One caveat: `list.js`'s own `fetchData` (505-520) calls
  `updatePaging(result.StartIndex, result.TotalRecordCount, …)` inside its promise, before the container's check, so
  on that page a superseded response can still rewrite the paging text. I did not change that: it is a separate
  line of code, and it was not measured here.

### 4.4 The fix (reference; `jellyfin-web.patch`, two commits against `c710e5c`)

1. **"Add helper to track the latest of a sequence of requests"**: a new `src/utils/requestSequence.ts` (15 lines,
   TypeScript as CONTRIBUTING requires) and `src/utils/requestSequence.test.ts`. `createRequestSequence()` returns
   a `start()` function. Each call returns an `isLatest()` check that is true until the next `start()`.
2. **"Ignore superseded responses in items container refresh"**: `refreshItems` takes an `isLatestRefresh` check
   before calling `fetchData()` and runs `onDataFetched` only if it is still the latest:

```js
    // A response that arrives after a newer refresh started must not replace the newer results
    this.startRefresh ??= createRequestSequence();
    const isLatestRefresh = this.startRefresh();

    return this.fetchData().then(result => {
        if (isLatestRefresh()) {
            onDataFetched.call(this, result);
        }
    });
```

Why this shape:
- It is the smallest change at the one place every legacy items view goes through.
- `??=` is already used in `src/lib/jellyfin-apiclient/connectionManager.js`.
- The promise `refreshItems` returns still resolves for a superseded call (with `undefined`, as before), so the
  `.then(() => window.scrollTo(…))` callers in `list.js` keep working.
- An alternative that aborts the superseded request would need `fetchData` implementations to accept a signal.
  That touches every legacy controller.

The test exercises the helper, not the custom element. Loading `emby-itemscontainer.js` in jsdom needs the
`webcomponents.js` polyfill and mocks for about a dozen app modules. CONTRIBUTING deems legacy view code untestable,
and every existing test in the repository tests a pure module.

### 4.5 Test and fixed-variant results

Run in `~/targets/jellyfin-web` with Node 24:

| check | result |
|---|---|
| `npx vitest --watch=false --config vite.config.ts src/utils/requestSequence.test.ts`, fixed, 3 runs | 4 of 4 pass, 3 of 3 runs |
| same with the unfixed behaviour (the helper's check made always true, i.e. every response renders as today), 3 runs | 2 of 4 fail in 3 of 3 runs: "reports an older request as superseded once a newer one starts", "keeps the newer results when the older response arrives last" |
| `npm test` (whole suite), fixed | 16 files, 199 tests pass |
| `npx tsc --noEmit` | clean |
| `npx eslint` on the three changed files | clean |
| `git am jellyfin-web.patch` on a fresh branch at `c710e5c`, then `npm test` and eslint | applies cleanly; 199 pass; clean |
| explore on the fixed build, legacy-alpha, 300 / 600 / 900 ms | 0 / 0 / 0 of 6. The same seeds still delivered C before B (1, 2 and 2 loads), and all 24 loads show C's movies |
| explore on the fixed build, legacy-sort | grid ascending in 24 of 24 loads. Verdict 0 / 0 / 3 of 6: all 3 are the debounced-save count of section 6.4, not the grid |
| `repro.mjs` on the fixed build | 0 of 10 alpha, 0 of 10 sort (table in 4.2) |

Results: [`jellyfin-web/results/fixed/`](jellyfin-web/results/fixed/).

Not run: `npm run build:production` and `npm run escheck`. The production build was not needed for the check, and
the development build was used throughout. The sender should run both before opening the PR.

## 5. Other observations

### 5.1 A double click on the legacy heart sends "mark favourite" twice

`src/elements/emby-ratingbutton/emby-ratingbutton.js` `onClick` reads `data-isfavorite` and sends
`updateFavoriteStatus(userId, id, !isFavorite)`. The attribute changes only when the response arrives, so a second
click before then reads the same value and sends the same request. In 24 of 24 loads, a double click on Bramble's
heart sent two `POST /Users/{userId}/FavoriteItems/{id}`, 5 ms apart, and ended favourite on the page and on the
server. GenClass's `duplicate-request` finding said: ""POST /Users/:id/FavoriteItems/:id" was sent twice, 5 ms apart,
by two separate user actions while the first was in flight".

It is not order-dependent: both orders end the same, so explore's verdict correctly has no race for it. Whether two
quick clicks on a toggle should mean "on, off" is a UX call for the maintainers, so I did not draft a fix.
`FavoriteButton.tsx` (modern) has the same shape, with `isFavorite` from props until the refetch. I did not drive
that one.

### 5.2 #8277 ("Details/items using two requests for the same payload")

[`jellyfin-web/count-item-requests.mjs`](jellyfin-web/count-item-requests.mjs) opens one movie's details page in
plain Playwright and lists the requests ending in `/Items/{itemId}`. On `c710e5c` it found one request,
`GET /Users/{userId}/Items/{itemId}`, in both the default and the legacy layout. Only a fresh load of the details URL
was measured, not navigation from a card or the home screen. The item-fetch migration PRs merged since the issue
(#8719, #8722, #8730, per the brief) may have changed this. I am leaving #8277 alone: no comment is drafted.

### 5.3 Related upstream items (search API, 2026-11-03)

Searches of jellyfin/jellyfin-web issues and pull requests for "alphabet", "letter", "sort order", "refreshItems",
"itemscontainer", "race condition", "wrong items" and "favorite double" found no report of this bug. Related, not
duplicates:
- **#8489** "Library items initially render in alphabetical (Name) order" (open, bug): a brief flash of the default
  order when entering a library, not a stale response replacing newer results.
- **#8481** "Cannot get back to infinite scrolling once I select a letter on the right" (closed).
- **Open PR #8343** "Episode lists not refreshing after deleting a episode": touches only
  `src/apps/legacy/controllers/itemDetails/index.js`, so no overlap with the patch. It already conflicts with master
  by itself.

## 6. Problems with GenClass itself

1. **A reordered list is not a visible difference.** In legacy-sort, the grid ended in the opposite order in 6 of 18
   seeded loads, a real bug. The page lines were the same set in both orders, though, so the verdict did not count
   the page as different.
   - The reversal reached the report only through my mirror atom (`grid.titles`), which is the internal tier: at
     300 ms, "No race found" while 2 of 6 loads showed a descending grid under "Ascending".
   - The RACE lines it did print at 600 and 900 ms (1 and 2 of 6) rested on the debounced-save count in item 4. At
     600 ms one reversed load (r16) was not flagged at all.
   - Without the mirror atom and my own oracle, this surface would have read as "no race" or as a false report. The
     verdict could compare page line order where the lines are the same multiset (a list's order is what the user
     sees).
2. **Wall-clock text is a race.** The details page shows "Ends at 4:51 PM" (now plus the runtime). The two baselines
   ran in the same minute, so the line was not noise. A seeded load a minute later "differed" and became a RACE line:
   - favorite: 6 of 6 at 600 ms and 6 of 6 at 900 ms;
   - details: 2 of 6 at 600 ms;
   - in total 14 false RACE runs, plus race findings `f3` and `f5` ("it shows "Ends at 4:52 PM" under "seed 1"").

   The shape rule (digits blanked only when the baselines differ) cannot catch a clock that does not tick between
   the two baselines. Blanking clock-shaped tokens, or running the baselines at both ends of the session, would.
3. **Loads that had not finished starting at the quiet point.** In the details scenario, 3 of 6 seeded loads at
   600 ms, and the baseline at 900 ms (so 4 of 6 "differed"), reached `whenSettled()` without the app's navigation
   drawer ("Home", "Media", "Movies", "Administration"), the media-info selects and
   `POST /Sessions/Capabilities/Full`. The title was right in all of them.
   - My scenario changes `location.hash` 50 ms after the agent connects, and the quiet point evidently came before
     the app's startup chain.
   - In total 7 false RACE runs, plus finding `f1` at 600 ms.
   - The report gives no hint that a run is incomplete. A difference consisting only of absent lines, absent fields
     and absent requests could say so.
4. **A debounced write's count is a race.** `POST /DisplayPreferences/usersettings` is sent from a 50 ms timer
   ("via timer 50ms" in the timeline), so a slower run coalesces two saves into one. "Unsafe request count differs"
   then made a RACE line:
   - legacy-sort on the unfixed build: 1 run at 600 ms and 2 at 900 ms, each next to a real reversed grid;
   - legacy-sort on the **fixed** build: 3 of 6 at 900 ms, with the grid correct in all of them, so a false report
     on the fixed variant;
   - at 300 ms the same count was listed as noise, because the baselines differed there.

   The timeline already knows the write came from a timer, so a write whose count changes only through timer
   coalescing could be reported apart from user-action writes.
5. **Witness attribution on mirror atoms.** On modern-alpha, `overwrote-newer letter.value` was attributed to
   `POST /Sessions/Capabilities/Full` (300 ms, r4) and `GET /Items/:id` (900 ms, r19), and a `stale-write` finding to
   `GET /QuickConnect/Enabled`. None of those responses touches the letter. The MutationObserver mirror is written
   from whatever task runs next, so the attribution follows the task, not the cause. It stayed "along the way only"
   and produced no RACE line, but `genclass_findings` lists those `stale-write` findings. swarm.md already says a
   witness on your own mirror atom is not a bug. AGENT.md section 2 could say how mirror writes get attributed.
6. **`GET /web/config.json` counts** (2 vs 3 per load) appear in nearly every report as "internal state only". They
   are harmless but crowd the report.
7. **The generated regression test cannot run as written for an app that does not call `connectAgent`.** For f4 it
   asserts `expect(window.__GENCLASS_AGENT__)` (the dev build has no agent here, because the runtime was injected by
   the harness). Some of its year assertions are fragile: `not.toContain("1998")` would fail on any page that shows
   that year anywhere. The upstream test is the Vitest one, so this did not block anything.
8. **`~hedge` keys** appeared in two delivered orders: `/Items#2~hedge` on modern-alpha at 300 ms, and
   `/Items#4~hedge` twice on search at 600 ms. I did not find why the app's request got a hedge suffix. It changed
   no verdict.
9. **Environment (not GenClass):**
   - The brief's apt route (`repo.jellyfin.org`), `jellyfin.org` and GitHub archive tarballs are refused by this
     session's egress policy.
   - swarm.md section 3 lists `dotnet` as installable: Ubuntu's `dotnet-sdk-10.0` works and is the faster route
     here.

False reports and misses on this run (18 explore sessions on the unfixed build, 6 seeded loads each, so 108 seeded
loads):

| | count |
|---|---|
| RACE runs | 29 |
| true races | 8: 5 legacy-alpha, plus 3 legacy-sort runs that do have a reversed grid but were flagged on the write count of item 4 |
| false RACE runs | 21: 14 wall clock (item 2), 7 incomplete load (item 3) |
| missed real differences | 3 legacy-sort loads with a reversed grid and no RACE line (item 1) |
| fixed build (legacy-alpha and legacy-sort, 6 sessions, 36 seeded loads) | 3 false RACE runs, all from the debounced write; 0 real |

## 7. Time spent

About 50 min wall clock (16:33 to about 17:20 UTC):

| step | time |
|---|---|
| setup: the blocked apt repository, the .NET build (1 min 48 s), the npm workaround, the web build (1.5 min), media and seeding | about 13 min |
| the six explore scenarios (18 sessions, 144 loads), run two at a time | about 15 min |
| the reproduction, fix, tests and fixed-variant checks | about 10 min |
| writing | about 12 min |

## 8. Reproducing

With the server seeded as in section 1:

```bash
node docs/adoption/hunts/jellyfin-web/explore.mjs --surface legacy-alpha --slow 300,600,900 --out /tmp/jf-hunt
node docs/adoption/hunts/jellyfin-web/repro.mjs --runs 10 --delay 800                 # without GenClass
node docs/adoption/hunts/jellyfin-web/repro.mjs --runs 10 --delay 800 --surface sort
node docs/adoption/hunts/jellyfin-web/count-item-requests.mjs [--legacy]              # #8277 check
# the fix
cd ~/targets/jellyfin-web && git am /path/to/docs/adoption/hunts/jellyfin-web.patch && npm test && npm run build:development
```

Surfaces of `explore.mjs`: `legacy-alpha`, `legacy-sort`, `modern-alpha`, `details`, `favorite`, `search`.
