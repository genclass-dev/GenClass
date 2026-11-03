# Race hunt: Audiobookshelf (2.37.2)

A GenClass race hunt on Audiobookshelf's web client (`advplyr/audiobookshelf`). It ran on 2026-11-03 in a cloud
session. The real `@genclass/runtime` (0.3.0-beta.5, from this repository at `c1c9e14`) was injected into the client
by Playwright, and the real `@genclass/mcp` (0.2.1) was driven the way a coding agent drives it. Audiobookshelf's
source was not modified for the hunt. The fix is a patch for its maintainers: [audiobookshelf.patch](audiobookshelf.patch).
The facts for the sender's own pull request text are in [audiobookshelf-facts.md](audiobookshelf-facts.md). The
project does not accept fully AI-generated pull requests, so that file holds facts and checks, not paste-ready text.
Nothing was sent to Audiobookshelf's repository, tracker or maintainers.

**Headline.** Two real client bugs, both reproduced without GenClass, and one server-side rollback confirmed at the
API level.

1. **[#2231](https://github.com/advplyr/audiobookshelf/issues/2231), open since 2023-10-21 as "unable to
   reproduce", now reproduced deterministically.** Any `item_updated` socket message for the item open in the "Edit
   item" modal wipes every unsaved edit in the Details form. The trigger does not have to be a Match:
   - another client's PATCH reverted a typed title in 3 of 3 runs (control without a server change: 0 of 3);
   - the folder watcher picking up a new file reverted it in 3 of 3 runs, 12.8 s after the file was written;
   - the modal's own Save followed by typing wiped the new text in every load (section 3).

   GenClass's explore cannot produce this: it is a socket push, and explore reorders only HTTP responses. The hunt
   found it by reading the code the brief pointed at, then reproduced it directly. The fix is about 25 lines in
   `BookDetailsEdit.vue`: keep unsaved edits to fields the update did not change. It comes with a Cypress component
   spec. Both are in the patch.
2. **The global search keeps the older query's results when two searches overlap (no issue filed).** If the "Har"
   search is still in flight when the "Harmony" search starts, and the responses arrive in request order, the menu
   lists "Hart Keep" and "Harbor Sea" under the box that says "Harmony". This happened in 3 of 3 runs with both
   responses held 1.5 s, and in 0 of 3 with the responses reversed or not held. The first response clears a shared
   `isFetching` flag, so the second is dropped as "canceled". Explore found it once responses were slow enough for
   the searches to overlap (the box debounces for 750 ms): no race at 300, 600 or 900 ms, 1 of 6 reordered runs at
   1500 ms, 3 of 6 at 2500 ms. On the fixed build it found 0 of 12.
   One-line fix (section 5). It is not in the patch: the project asks first-time contributors for small PRs.
3. **#5627's class, a stale session's close rolls progress back**, confirmed with three API calls (section 6). Not
   patched: open PR #5640 works in the same place.

Sections: 1 setup, 2 how the app was driven, 3 scenarios and verdicts, 4 the finding (#2231), 5 the search overlap,
6 progress rollback (#5627), 7 problems with GenClass itself, 8 time spent, 9 reproducing.

## 1. Setup

| what | version |
|---|---|
| Audiobookshelf | 2.37.2, `master` at `ce41ce489cebaf00e008919f6f2901b428acfd56` (2026-11-01, "Merge pull request #5691 from mikiher/dedupe-authors"), the commit the patch is against |
| server runtime | Node 24.22.2 (nvm; the readme's "Manual Environment Setup" requires Node 24), Express 4, Sequelize 6, sqlite3 5.1.7, socket.io 4 |
| client | Nuxt 2.18 / Vue 2.7, the static build (`npm run generate`) the server serves under `/audiobookshelf` |
| ffmpeg | 6.1.1 (Ubuntu 24.04 apt); Audiobookshelf pins 5.1 and its downloader was refused by the network policy, so `dev.js` sets `SkipBinariesCheck: true` (nothing in the hunt transcodes) |
| browser | Chromium 1243 (headless shell), Playwright 1.63.0, harness on Node 22.23.4 |
| GenClass | `@genclass/runtime` 0.3.0-beta.5 and `@genclass/mcp` 0.2.1 from this repository at `c1c9e14`, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |

Commands, in order:

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# Audiobookshelf, outside this checkout
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . ~/.nvm/nvm.sh && nvm install 24
git clone https://github.com/advplyr/audiobookshelf.git ~/targets/audiobookshelf && cd ~/targets/audiobookshelf
cp .devcontainer/dev.js dev.js      # Port 3333, config/ and metadata/ in the clone, /usr/bin/ffmpeg
sed -i 's/SkipBinariesCheck: false/SkipBinariesCheck: true/' dev.js   # ffmpeg 6.1 here, 5.1 pinned (see above)
npm ci && (cd client && npm ci && npm run generate)
npm run dev                          # nodemon: tsc to dist-server/, node dist-server/index.js --dev -> :3333

# seed: 220 books under ~/abs-data/books, a root user, one library, a scan
bash docs/adoption/hunts/audiobookshelf/seed.sh ~/abs-data/books
curl -X POST localhost:3333/init -H 'content-type: application/json' -d '{"newRoot":{"username":"root","password":"hunt-pw-1"}}'
TOKEN=$(curl -s -X POST localhost:3333/login -H 'content-type: application/json' \
  -d '{"username":"root","password":"hunt-pw-1"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["accessToken"])')
curl -X POST localhost:3333/api/libraries -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Books","mediaType":"book","folders":[{"fullPath":"'$HOME'/abs-data/books"}]}'
curl -X POST localhost:3333/api/libraries/<id>/scan -H "authorization: Bearer $TOKEN"
```

The seed is 220 books named "<Word> <Noun>" (20 words × 11 nouns: Harbor, Hardy, Harvest, Harmony, Hart, Silver, ...)
by 40 authors, each one 2 s sine mp3 made by ffmpeg, so the prefix "Har" matches five words' books. Setup took about
10 minutes, most of it the two `npm ci` runs and `npm run generate`.

## 2. How the app was driven

All the hunt's scripts are in [audiobookshelf/](audiobookshelf/); `lib.mjs` is shared (login through the client's own
form, saved as Playwright storage state; a bearer-token API client for setup and oracles).

- **With GenClass** ([explore.mjs](audiobookshelf/explore.mjs)): the Gitea harness pattern. A Playwright route
  rewrites the client's HTML document to load `genclass.global.js` from a virtual same-origin path (model off,
  telemetry off, `report: "silent"`) and to connect `agent.js` to an MCP bridge started in-process with `serve()`.
  Each browser context gets the `local-network-access` permission. Audiobookshelf's Vuex store is not discovered, so
  the injected script mirrors three regions with `rt.atom()` from a `MutationObserver`:
  - `search.text`: the global search menu's text;
  - `shelf.titles`: the first 24 bookshelf cards' titles, read from the cards' Vue instances;
  - `edit.title` and `edit.subtitle`: the Details form's two inputs.

  The explore verdict compares those atoms, the page text and the form values. One explore session per latency: 2
  baselines (responses in request order) plus 6 seeded loads, the same steps each load. Each load also has an oracle
  of the harness's own, read from the DOM after `whenSettled()`.
- **Without GenClass**:
  - [repro-2231.mjs](audiobookshelf/repro-2231.mjs): the #2231 reproduction, with three triggers (`patch`, `watcher`,
    `none`).
  - [repro-search.mjs](audiobookshelf/repro-search.mjs): the search overlap, with a Playwright route that only holds
    the two search responses.
  - [progress-5627.mjs](audiobookshelf/progress-5627.mjs): the progress rollback, through the API.
  - [standin-component-test.mjs](audiobookshelf/standin-component-test.mjs): the Cypress spec's two cases, mounted
    without Cypress (section 4.5).

## 3. Scenarios and verdicts

Unfixed build (`ce41ce48`). Each explore session ran 8 loads: 2 baselines (responses in request order) and 6 seeded
reorderings, with `slow_ms` adding up to that much latency per response (uniform, hashed from the seed). "Oracle"
is the harness's own reading of the DOM after `whenSettled()`, counted over all 8 loads. Each session's raw output is
summarised in [audiobookshelf/results-unfixed.json](audiobookshelf/results-unfixed.json).

| scenario | slow_ms | explore verdict | oracle: loads wrong of 8 | notes |
|---|---|---|---|---|
| search "Har", wait 800 ms, "mony" | 300 | no race (6 of 6 compared) | 0 | the two searches never overlap: the box debounces 750 ms |
| | 600 | no race (6 of 6) | 0 | |
| | 900 | no race (6 of 6) | 0 | |
| | 1500 | **RACE 1 of 6** | 1 (stale) | the stale load is the flagged run |
| | 2500 | **RACE 3 of 6** | 5 (stale) | both baselines stale; the 3 flagged runs are the *correct* ones (section 7, item 2) |
| bookshelf sort: Publish Year, then Author (Last, First) | 300 | no race (6 of 6) | 0 | the app sends the follow-up request only after the previous response (`pendingReset`), so nothing overlaps |
| | 600 | no race (6 of 6) | 0 | |
| | 900 | no race (6 of 6) | 0 | |
| edit: type title, Save, type subtitle at once | 300 | no race (6 of 6); 1 run "internal state only" (`GET /api/search/providers` sent or not) | **8 (subtitle wiped)** | #2231 by the user's own Save: deterministic, so no order dependence |
| | 600 | no race (6 of 6); 2 runs internal only (same request count) | **8** | |
| | 900 | no race (6 of 6) | **8** | |
| #2231 by another client's PATCH (no GenClass) | none | n/a | **3 of 3 wiped** | control without a server change: 0 of 3 |
| #2231 by the folder watcher (no GenClass) | none | n/a | **3 of 3 wiped** | rescan 12 766 to 12 792 ms after the file was written |
| search overlap, Playwright route only (no GenClass) | holds 1500/1500 ms | n/a | **3 of 3 stale** | holds 3000/0 ms (reversed): 0 of 3; no holds: 0 of 3 |
| progress close from a stale device (API, no browser) | none | n/a | **3 of 3 rolled back** | control (close without sync data): 0 of 3 |

Not exercised: the bookshelf's two concurrent page fetches (`LazyBookshelf.vue` line 416, a `Promise.all` of two
pages) happen only on scroll, and the sort scenario does not scroll. The progress sync over HTTP from the web player
(`PlayerHandler.js`) was not driven in a browser: the seed's 2 s files are too short for its 10 s sync interval.
These are left as negatives with that caveat. A run that broke on a harness selector was discarded and run again
after the fix: the first sort batch clicked a "Title" item that was already selected, and the first edit batch typed
different titles on alternate loads (section 7, item 4).

**False-report rate on the correct variant.** There was no fully correct variant of the app here: every edit load
wipes the subtitle. On the scenarios whose oracle was clean on every load (search 300, 600 and 900; sort 300, 600 and
900; 48 loads, 36 reordered runs compared), explore reported 0 races. On the fixed build: section 4.5.

## 4. The finding: unsaved edits wiped by any `item_updated` (#2231)

### 4.1 What happens, in causal order

From [repro-2231.mjs](audiobookshelf/repro-2231.mjs) (`--trigger patch`) and the code at `ce41ce48`:

1. The user opens a book, clicks Edit, then the Details tab, and changes the title. The form's `details.title`
   now differs from `libraryItem.media.metadata.title`, and nothing is saved.
2. Any server-side change to the same item (here, another client's `PATCH /api/items/:id/media` with a new
   publisher) ends in `SocketAuthority.libraryItemEmitter('item_updated', ...)`
   (`server/controllers/LibraryItemController.js` line 280). The server sends that message to every client.
3. The client's socket handler `libraryItemUpdated` (`client/layouts/default.vue` lines 209-222) emits
   `` `${libraryItem.id}_updated` `` on the event bus.
4. `EditModal.vue` lines 248-250 replace `this.libraryItem` with the update.
5. `BookDetailsEdit.vue` lines 103-110 watch `libraryItem` and call `init()`. `init()` (lines 274-289) copies every
   field from the new server copy, and the typed title is overwritten by the stored title. There is no check for
   unsaved changes.

The same happens when the folder watcher rescans the item (`--trigger watcher`: a new file in the book's folder, a
rescan 12.8 s later). That is the path the maintainer named in #2231 on 2023-10-23 and 2023-10-28: "the watcher
picking up the cover image and running a scan", which a Match causes when it writes the cover. It also happens with
the modal's own **Save**: the save emits `item_updated`, and anything typed before that message arrives is wiped (the
edit scenario: 24 of 24 loads).

### 4.2 Why explore did not find it

The clobbering message arrives on the socket. GenClass records WebSocket messages but never reorders them (AGENT.md
section 3), and the wipe happens in every load, whatever the order. So explore said "no race" in all three edit
sessions, which is correct by its definition. The harness's own oracle saw the wipe in every load. This hunt found
the bug by reading the code path the brief pointed at, then reproduced it directly.

### 4.3 Root cause (file paths and lines at `ce41ce489cebaf00e008919f6f2901b428acfd56`)

`client/components/widgets/BookDetailsEdit.vue`:

```js
  watch: {
    libraryItem: {
      immediate: true,
      handler(newVal) {
        if (newVal) this.init()   // every update of the same item resets every field
      }
    }
  },
```

`PodcastDetailsEdit.vue` lines 79-85 have the same watcher. They are left alone to keep the change small.

### 4.4 The fix

[audiobookshelf.patch](audiobookshelf.patch) (applies to `ce41ce48`; 23 lines added and 3 removed in
`BookDetailsEdit.vue`, plus a new spec):

- `init()` stores a snapshot of what it put in the form (`initialValues`, the details plus the tags).
- When the watcher sees a new `libraryItem` with the same `id`, it takes the current form values, runs `init()` from
  the new server copy, and then puts back each field the user had changed, as long as this update did not change
  that field. If the update did change it, the server's value wins. That covers the user's own Save (the update
  carries exactly what was saved) and an edit of the same field elsewhere.
- A different item (`id` changed: the modal's next and previous arrows) resets the form as before.

### 4.5 Test and fixed-variant check

- **Regression test**: `client/cypress/tests/components/widgets/BookDetailsEdit.cy.js`, in the style of
  `cypress/tests/components/cards/*.cy.js`. It mounts the component with the real `TextInputWithLabel` and
  `TextInput` and stubs the other inputs. Two cases: "keeps unsaved edits when the same item is updated" (type a
  title, `setProps` an item whose publisher changed, assert the typed title, the new publisher and the update payload
  `{ metadata: { title } }`), and "resets the form when a different item is loaded".
- **The Cypress spec was not run in this session**: the Cypress binary comes from download.cypress.io, which the
  cloud environment's network policy refuses (the package is an optional dependency, so `npm ci` went on without
  it). [standin-component-test.mjs](audiobookshelf/standin-component-test.mjs) mounts the same `.vue` file with Vue
  2.7's full build in Chromium, with the same children and stubs, and replays both cases:

  | code | "keeps unsaved edits" | "resets for a different item" |
  |---|---|---|
  | unfixed (`ce41ce48`) | **fail 3 of 3** (title back to "Original Title", payload `{}`) | pass 3 of 3 |
  | fixed | pass 3 of 3 | pass 3 of 3 |

- **End to end on the fixed build** (the client regenerated from the patched source and served by the same server):
  `repro-2231.mjs` kept the typed title in 3 of 3 runs with `patch` (server updated 24 to 30 ms after the call),
  3 of 3 with `watcher`, and 3 of 3 with `none`.
- **Explore on the fixed build**, edit scenario (type a title, Save, type a subtitle at once): the subtitle was kept in
  **24 of 24** loads (8 at each of 300, 600 and 900 ms; 0 of 24 before the fix), and explore said "No race found" in
  all three sessions (18 reordered runs compared; at 600 ms, 3 runs "internal state only": the
  `GET /api/search/providers` count again).
- Prettier (`npx prettier --check`, the repository's `.prettierrc`) passes on both files. The repository's
  `npm run lint` (`eslint .`) ignores `client/`. The server's `npm test` was not run: the change is client-only, and
  the dev server's nodemon watches `test/`.
- The fixed build also carried the one-line search fix of section 5, so both could be checked in one client build.
  The two changes touch different components.

## 5. The search overlap (not in the patch)

**What happens.** `client/components/controls/GlobalSearch.vue` `runSearch()` (lines 173-197) sets `isFetching =
true`, awaits `GET /api/libraries/:id/search?q=<value>&limit=3`, returns if `!this.isFetching` ("Search was
canceled"), and otherwise renders the results and sets `isFetching = false`. When a second search starts while the
first is in flight, the flag is shared. Whichever response arrives first renders and clears the flag, and the other is
dropped as canceled:

- in request order, the older query's results stay on screen (box "Harmony", menu "Harmony Letters | Hart Keep |
  Harbor Sea");
- reversed, the newer query's results win by accident.

The brief's note ("an earlier query's late response wins") has it backwards. The late response is the one dropped;
the first to arrive wins.

**When.** The box waits 750 ms after the last keystroke (`inputUpdate`, lines 199-215), so two searches overlap only
if the first takes longer than the pause before the next keystroke plus about 750 ms. In this hunt that meant a
response time of about a second: explore found no race at 300, 600 or 900 ms, 1 of 6 at 1500 ms and 3 of 6 at 2500 ms.
A slow server (a large library, a NAS) or a slow network reaches that.

**Reproduction without GenClass** ([repro-search.mjs](audiobookshelf/repro-search.mjs)), with a Playwright route
that only holds the two search responses:

| holds ("Har" / "Harmony") | stale of 3 |
|---|---|
| 1500 / 1500 ms (overlap, request order) | **3** |
| 3000 / 0 ms (overlap, reversed) | 0 |
| 0 / 0 ms (no overlap) | 0 |

On the fixed build (below): 0 of 3 in each row.

**Fix** (the brief's suggestion, checked here):

```diff
-      // Search was canceled
-      if (!this.isFetching) return
+      // Search was canceled or a newer search was started
+      if (!this.isFetching || value !== this.lastSearch) return
```

A superseded response now returns without touching `isFetching`, so the newer one still renders, and a clear (which
sets `lastSearch = null`) still cancels. On the fixed build: `repro-search.mjs` 0 of 3 stale in all three rows;
explore at 1500 and 2500 ms said "No race found" in both sessions (12 reordered runs compared, 2 of them delivering
"Harmony" first), and the menu was right in 16 of 16 loads. That is a false-report rate of 0 of 12 on this fixed
variant, next to 4 of 12 reordered runs flagged on the unfixed build at the same latencies.

It is not in the patch. The project asks first-time contributors for small pull requests, and #2231 has an open issue.
A regression test for it would be a Cypress component test of `GlobalSearch.vue` with a mocked `$axios.$get` that
resolves the two queries in request order. That test was not written. This is a candidate second PR once the first
has a response.

## 6. Progress rollback from a stale device (#5627's class), API only

[progress-5627.mjs](audiobookshelf/progress-5627.mjs), on one book, as one user from two devices:

1. Device A starts a session and syncs 30 s.
2. Device B starts its own session and syncs 90 s. `startSession` closes only the same device's sessions
   (`server/managers/PlaybackSessionManager.js` lines 313-320), so A's session stays open.
3. Device A closes its session with its last position (`POST /api/session/:id/close` with `currentTime: 30`, what
   `PlayerHandler.sendCloseSession` sends).

Result: progress went from 90 back to 30 in 3 of 3 runs. In the control (close without sync data) it stayed at 90 in
3 of 3. `syncSession` (lines 373-412) writes `currentTime` through `user.createUpdateMediaProgressFromPayload` with no
comparison against the stored progress's `updatedAt`. `syncLocalSession` (line 232) has such a comparison.

#5627 (2026-10-01) describes the same rollback through a different door: the stale session is closed by
`startSession` with no sync data, after the app was killed. Its server log shows the position reverting to the stale
session's position. This hunt did not reproduce that exact path; the open session's close with sync data is
the one shown here. Open PR [#5640](https://github.com/advplyr/audiobookshelf/pull/5640) ("Prevent duplicate media
progress from concurrent progress updates", for #3845) changes `User.createUpdateMediaProgressFromPayload` in the same
area but adds no timestamp comparison. A fix (compare the session's last update with the stored progress's
`updatedAt` before writing) would touch the server and overlap that PR, so nothing is patched. The facts file says what
could go in a comment on #5627.

## 7. Problems with GenClass itself

1. **Socket-driven bugs are out of reach, as documented.** #2231's wipe comes from a socket message. Explore never
   reorders WebSocket messages (AGENT.md section 3), and a wipe that happens in every load is not order-dependent, so
   the three edit sessions correctly said "no race" while every load lost the user's text. Not a false report, but
   the most important bug in this app was invisible to the tool. A schedule that could hold a socket message until a
   user action (or deliver it at a seeded point) would reach this class.
2. **A verdict that blames the order when latency caused the difference.** In the 2500 ms search session, both
   baselines had the two searches overlap (both stale, the real bug). Three seeded runs did not: their hashed delay
   on the first search was short (r20: "held 963 ms"), so it was delivered before the second search was sent. Those
   runs showed the correct results, and the finding reads "The page depends on response order: it shows 'Harmony
   Sea' under 'seed 2', not in request order". The delivery order was the same as the baseline's. The difference was
   overlap versus no overlap, and the run flagged as the race is the correct one. Suggestion: when a seeded run's
   delivery order equals the baseline's, say the difference came from latency. Also consider giving each baseline the
   seed's own delays, so order is the only variable.
3. **The generated regression test cannot reproduce the search race.** The recording took "Har", an 800 ms pause and
   "mony" as one burst: `type input "Search.." = "Harmony" (7 keystrokes over 1.1 s)`. The generated test types
   `pressSequentially("Harmony", { delay: 179 })`, and with no pause over 750 ms the app sends one search. The replay
   and the test lose the step that makes the bug possible. Suggestion: split a burst at a pause longer than some
   threshold, or keep the per-keystroke timing in the replay.
4. **A harness-made false RACE, and why the tool let it through.** The first edit batch typed "Silver Gate" or
   "Silver Gate Revised" on alternate loads (the harness's mistake). Grouping fell back to "action kinds and element
   roles: the recorded element names differed between loads", the typed values were treated as the same step, and
   explore reported "RACE: 3 of 6" on the page text "Silver Gate", which was the typed value itself. Suggestion: when
   the only differences are values that appear in the runs' own recorded `type` actions, report "the steps
   differed", not a race. Discarded and rerun with identical steps (section 3).
5. **An app's own follow-up request is keyed as a GenClass hedge.** In the sort scenario the app sends a third
   `GET /items` from the continuation of the second one's response (`pendingReset`). `schedule.ts` line 212 gives a
   request whose causal parent has the same name the suffix `~hedge`, so the recorded order reads `items#2 then
   items#2~hedge`. That looks like GenClass sent a duplicate in observe mode, which it did not (no decision runs with
   `model: false`). It was keyed `items#3` in 2 of the 8 loads at 300 ms, so the same steps do not always get the same
   keys, which `given` replays rely on. Suggestion: use `~hedge` and `~retry` only for requests the runtime itself
   sent.
6. **Visual check "image-distorted" on the item page** (edit sessions: 2, 2 and 6 runs): "an image is stretched on
   img.object-fill: shown at 208 x 208 px, its file is 400 x 640". That is the placeholder cover in
   `covers/BookCover.vue`. It uses `object-fill` until its load handler decides on `object-contain`, and the image
   has opacity 0 until then. Not verified whether the measurement caught that transitional state or a visible
   stretch. Reported as a measured check, never as a race. It needs a look before anyone quotes it.
7. **Internal-only differences were correctly kept out of the verdict**: `GET /api/search/providers` sent or not
   (edit 300 and 600) depended on timing, not on the order.
8. **Setup notes, not bugs.** As in the earlier hunts, each browser context needs the `local-network-access`
   permission for the injected page to reach the bridge. The app calls `api.github.com/repos/advplyr/audiobookshelf/releases`
   on load, which GenClass recorded and delivered like any request. No console errors came from the runtime.

## 8. Time spent

About 45 minutes of wall-clock session time (16:27 to 17:12 UTC, writing included), with several things running in
parallel:
- about 10 minutes for Node 24, the two `npm ci` runs, `npm run generate` and the seed. The pinned ffmpeg 5.1 download
  failed and cost a restart.
- about 5 minutes for the #2231 reproduction. The client's `/audiobookshelf` base path and the Edit button that opens
  the Cover tab cost a few attempts.
- about 5 minutes for the fix, the Cypress spec and the stand-in, after the Cypress binary turned out to be
  unreachable.
- the explore sessions (in the background most of the time):
  - unfixed build: 11 sessions of 8 loads (search at 5 latencies, sort at 3, edit at 3), plus 2 batches discarded for
    harness mistakes;
  - fixed build: 5 sessions, plus 1 batch discarded for a harness lookup.

## 9. Reproducing

With Audiobookshelf running and seeded as in section 1, from this repository's root (Node 22, Playwright from the
root `node_modules`, GenClass built):

```bash
node docs/adoption/hunts/audiobookshelf/repro-2231.mjs --trigger patch --runs 3      # WIPED 3 of 3 on ce41ce48
node docs/adoption/hunts/audiobookshelf/repro-2231.mjs --trigger watcher --runs 3    # WIPED 3 of 3, ~13 s each
node docs/adoption/hunts/audiobookshelf/repro-2231.mjs --trigger none --runs 3       # control: KEPT 3 of 3
node docs/adoption/hunts/audiobookshelf/repro-search.mjs --hold-har 1500 --hold-harmony 1500 --runs 3   # STALE 3 of 3
node docs/adoption/hunts/audiobookshelf/progress-5627.mjs --runs 3                   # ROLLED BACK 3 of 3
node docs/adoption/hunts/audiobookshelf/standin-component-test.mjs --client ~/targets/audiobookshelf/client --runs 3
node docs/adoption/hunts/audiobookshelf/explore.mjs --surface search --slow 1500,2500 --runs 6 --out /tmp/abs-search
```

The fixed build: `git apply docs/adoption/hunts/audiobookshelf.patch` in the Audiobookshelf clone, then
`(cd client && npm run generate)`. The server serves `client/dist` as it is, so no restart is needed.
