# Race hunt: Navidrome web UI (master at 7c1e68a)

A GenClass race hunt on Navidrome's web UI (React 17, react-admin 3.19.12, Redux), run on 2026-11-03 in a cloud
session, with the real `@genclass/runtime` (0.3.0-beta.5, this repository at `c1c9e14`) injected into the UI by
Playwright and the real `@genclass/mcp` (0.2.1, same commit) driven the way a coding agent drives it. Navidrome's
source was not modified for the hunt; the fix is a patch for its maintainers ([navidrome.patch](navidrome.patch),
issue and pull request drafts in [navidrome-issue.md](navidrome-issue.md)). Nothing was sent to Navidrome's
repository, tracker, forum or maintainers.

**Headline.** One real race, reproduced without GenClass. Rate a song 3 stars, then 5 stars before the stars
have changed. If the refresh the UI sends after the first rating (`GET /api/song/:id`, answered by the server
with rating 3) reaches the page after the second refresh (rating 5), the row ends on **3 stars while the server has
5**. It stays wrong until the list is refetched or the page reloads. A Playwright script that only delays that one
response reproduces it in 5 of 5 runs (0 of 5 with the same clicks and no delay). Explore produced it in 2 of 6
reordered loads (seeds 2 and 5) at each of 300, 600 and 900 ms, and 0 of 2 baselines each time, by this harness's
DOM oracle. **Explore's own verdict missed it** ("No race found", 3 of 3 sessions) because the stars are icons:
the difference was in the store (`rating: 5` vs `rating: 3`) but not in the page text, so it went to the "internal
state only" tier (section 6, item 1). With a small text mirror of the painted stars added by the harness,
explore said "RACE: 2 of 6" in each of the 3 sessions (the same seeds), and its replay reproduced it. The fix is
19 added and 13 removed lines in `ui/src/common/useRating.jsx` (mostly re-indentation): ratings from one field are
applied one after the other. The regression test in `useRating.test.js` failed 3 of 3 times before the fix and
passed 3 of 3 after; Navidrome's 855 UI tests, eslint and prettier pass. On the fixed build, explore found no race in
4 of 4 sessions (24 seeded loads, 0 differing by the oracle), the replay of the unfixed build's finding said "not
reproduced · the page shows the baseline's text", and the plain reproduction was 0 of 5 in each of its three modes.
The other scenarios (back-to-back ratings, playlist drag-reorder, search-as-you-type, love from two views) gave no
race; explore's RACE lines on reorder were a request count the plain reproduction never showed (section 3).

Sections: 1 setup, 2 how the UI was driven, 3 scenarios and verdicts, 4 the finding, 5 other observations, 6
problems with GenClass itself, 7 time spent, 8 upstream checks, 9 reproducing.

## 1. Setup

| what | version |
|---|---|
| Navidrome | `master` at `7c1e68a1e4e68e7257affba4f25cd9cb545c7016` (2026-11-03, "fix(subsonic): reject setRating values outside the 0-5 range - #6411"), shallow clone, the commit the patch is against |
| UI stack | React 17.0.2, react-admin / ra-core 3.19.12, @material-ui/lab 4.0.0-alpha.61 (`Rating`), Vite 7.3.2, vitest 4.1.2 |
| Go | go1.27.0 (fetched by `GOTOOLCHAIN=auto` from the system's go1.24.7), cgo with gcc 13.3 |
| Node | 24.22.2 for Navidrome (`.nvmrc` v24; the Makefile refuses Node 22), 22.23.4 for GenClass and the harness |
| database | SQLite under `./data` (created on first start) |
| browser | Chromium 1243 (headless), Playwright 1.63.0 |
| GenClass | `@genclass/runtime` 0.3.0-beta.5 and `@genclass/mcp` 0.2.1, this repository at `c1c9e14`, built from `dist/` |

Commands, in order:

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# Node 24 (the Makefile's check_node_env compares node --version with .nvmrc)
curl -sSfLO https://nodejs.org/dist/latest-v24.x/node-v24.22.2-linux-x64.tar.xz   # sha256 checked against SHASUMS256.txt
tar xf node-v24.22.2-linux-x64.tar.xz -C ~/opt && export PATH=~/opt/node-v24.22.2-linux-x64/bin:$PATH

# Navidrome, outside this checkout
git clone --depth 50 https://github.com/navidrome/navidrome.git ~/targets/navidrome && cd ~/targets/navidrome
GOTOOLCHAIN=auto make setup      # Go modules downloaded; then failed at install-golangci-lint (below)
(cd ui && npm ci)                # the rest of `make setup`; git hooks and golangci-lint skipped
```

`make setup` stopped at `install-golangci-lint`: the install script got HTTP 403 from GitHub's API for tag
`v2.14.0` from this machine. Nothing in the hunt needs the Go linter, so the step was skipped (and with it
`setup-git`'s hooks). **`make get-music` was not used:** it downloads four albums from the public instance
`demo.navidrome.org` with its demo credentials, and the swarm's rules forbid driving a hosted instance. Instead, 72
three-second sine-tone MP3s with full tags (6 artists, 6 albums, 12 tracks each) were generated with ffmpeg:

```bash
mkdir -p music && cd music
for a in 1 2 3 4 5 6; do d="Hunt Artist $a/Hunt Album $a"; mkdir -p "$d"; for t in $(seq 1 12); do
  ffmpeg -loglevel error -f lavfi -i "sine=frequency=$((200+a*40+t*7)):duration=3" -ac 1 -b:a 32k \
    -metadata title="Track $t of album $a" -metadata artist="Hunt Artist $a" -metadata album="Hunt Album $a" \
    -metadata album_artist="Hunt Artist $a" -metadata track="$t" -metadata date="202$a" "$d/$(printf %02d $t) Track $t.mp3"
done; done
cd .. && cat > navidrome.toml <<'EOF'
MusicFolder = "./music"
DataFolder = "./data"
LogLevel = "debug"
DevAutoCreateAdminPassword = "password"
EOF
GOTOOLCHAIN=auto make dev        # Vite on :4533 (proxies /auth /api /rest to :4633), `go run -race` on :4633
node docs/adoption/hunts/navidrome/hunt.mjs seed    # from this checkout: the 8-track "GenClass hunt playlist"
```

The first `make dev` compiled the race-enabled server in about 90 seconds; the scan of 72 files took a few
seconds. The login is `admin` / `password`, recreated on every start by `DevAutoCreateAdminPassword`.

## 2. How the UI was driven

[navidrome/hunt.mjs](navidrome/hunt.mjs) is the whole loop, on the pattern of the Strapi harness
([strapi/hunt.mjs](strapi/hunt.mjs)):

- **MCP server in-process.** `serve()` from `packages/mcp/dist/index.js` with its bridge on a free port, the tools
  called through JSON-RPC `tools/call`: `genclass_clear`, `genclass_explore` (start, report), `genclass_explain`,
  `genclass_replay` (arm, result), `genclass_status`.
- **Injection without touching Navidrome.** A Playwright route serves `packages/runtime/dist/` under
  `/__genclass/` and rewrites the UI's HTML document (`/`, served by Vite) to add, at the top of `<head>`:
  `window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, visual: false, devtools: false }`,
  the script tag `genclass.global.js`, and a module that calls `connectAgent(window.GenClass.runtime, { url })`
  from `/__genclass/agent.js`. Automatic discovery found react-admin's Redux store (155 `redux.*` fields:
  `redux.admin.resources.song.data`, `...song.list`, ...) and about 300 component hook states (451 fields in a
  snapshot). Requests to any host but `localhost` are aborted; each context gets `bypassCSP` and the
  `local-network-access` permission; the session is the UI's own localStorage entries (`authProvider.js`) from
  `POST /auth/login`, set by an init script.
- **One page load per run.** Each run first resets what it touches through the server's own APIs (the song's
  rating to 1 star with `/rest/setRating`, its star with `/rest/unstar`, the playlist's tracks), loads the page,
  waits for the agent link and for GenClass's quiet point (so the page's own start-up responses are done), does
  its steps, awaits `whenSettled()`, then reads its DOM oracle and closes the context after 600 ms.
- **Explore.** `runs: 6`, `slow_ms` 300, 600 and 900: 8 loads per session (2 fifo baselines, 6 seeded orders),
  then `report`; on a race, `genclass_explain` for the first finding, then `genclass_replay arm`, one more load,
  `genclass_replay result`.
- **DOM oracle (secondary).** Read after `whenSettled()`: for rating, the stars the row *paints* (filled icons of the
  MUI `Rating`, blurred and with the mouse away) next to the rating the server has (`GET /api/song/:id`); for
  reorder, the titles shown next to the server's track order; for search, the rows shown, compared with the first
  baseline's. [navidrome/summarise.mjs](navidrome/summarise.mjs) reduces each session to
  [navidrome/results.json](navidrome/results.json).
- **Text mirror (`HUNT_MIRROR=1`, a harness aid).** A small fixed line at the bottom of the page, kept up to date by
  a `MutationObserver`, saying what the first two rows paint in words: `row stars five not loved / row stars zero
  not loved`. It exists only because explore compares page *text* and the stars are SVG icons (section 6, item 1).
  Words, not digits, because the comparison blanks tokens holding a digit when the baselines differ in them. It is
  not in Navidrome's code and is not in the drafts sent upstream.

Two MUI `Rating` behaviours had to be handled before any oracle meant anything (section 5): a *focused* `Rating`
paints its focused star, not its value, so the harness blurs after the clicks (as clicking elsewhere would); and the
API omits `rating` for an unrated song, so the `Rating` of an unrated song mounts uncontrolled and paints its own
click state whatever the store holds, so every rating run starts from a song rated 1 star.

`genclass_status` after a natural load: "1 active page(s) · schedule natural · 4 actions, 10 requests ... model
off, mode observe · settled". The recorded actions for a rating were `click label "3 Stars"`, `click radio "3
Stars"` (one click on a MUI star is recorded as two actions: the label and the radio it activates).

## 3. Scenarios and verdicts

One explore session = 8 loads (2 fifo baselines and seeds 1 to 6). *explore verdict*: the report's verdict line,
reduced to counts. *internal only* / *along the way*: the report's two lower tiers (store-only differences;
`overwrote-newer` witnesses repaired later). *DOM oracle*: this harness's secondary check (which seeded loads
showed a page that disagrees with the server, or for search with the first baseline). *replay*: `genclass_replay`
of the session's first finding, one load. No session had a forced delivery; every load reached a quiet point
except the love sessions' (below).

| scenario | variant | slow_ms | mirror | explore verdict | compared | internal only | along the way | DOM oracle: seeded differing (seeds) | baselines differing | replay | forced | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rate | unfixed | 300 | yes | race in 2 of 6 | 6 of 6 | 4 of 6 | 0 | 2 of 6 (2, 5) | 0 | reproduced | 0 | 0 |
| rate | unfixed | 600 | yes | race in 2 of 6 | 6 of 6 | 2 of 6 | 2 of 6 | 2 of 6 (2, 5) | 0 | reproduced | 0 | 0 |
| rate | unfixed | 900 | yes | race in 2 of 6 | 6 of 6 | 3 of 6 | 1 of 6 | 2 of 6 (2, 5) | 0 | reproduced | 0 | 0 |
| rate | unfixed | 300 | no | no race | 6 of 6 | 2 of 6 | 4 of 6 | 2 of 6 (2, 5) | 0 | none | 0 | 0 |
| rate | unfixed | 600 | no | no race | 6 of 6 | 4 of 6 | 2 of 6 | 2 of 6 (2, 5) | 0 | none | 0 | 0 |
| rate | unfixed | 900 | no | no race | 6 of 6 | 6 of 6 | 0 | 2 of 6 (2, 5) | 0 | none | 0 | 0 |
| rate-fast | unfixed | 300 | yes | no race | 6 of 6 | 0 | 5 of 6 | 0 of 6 | 0 | none | 0 | 0 |
| rate-fast | unfixed | 600 | yes | no race | 6 of 6 | 5 of 6 | 1 of 6 | 0 of 6 | 0 | none | 0 | 0 |
| rate-fast | unfixed | 900 | yes | no race | 6 of 6 | 5 of 6 | 0 | 0 of 6 | 0 | none | 0 | 0 |
| reorder | unfixed | 300 | no | no race | 6 of 6 | 2 of 6 | 4 of 6 | 0 of 6 | 0 | none | 0 | 0 |
| reorder | unfixed | 600 | no | race in 5 of 6 | 6 of 6 | 1 of 6 | 0 | 0 of 6 | 0 | reproduced | 0 | 0 |
| reorder | unfixed | 900 | no | race in 6 of 6 | 6 of 6 | 0 | 0 | 0 of 6 | 0 | reproduced | 0 | 0 |
| search | unfixed | 300 | no | no race | 6 of 6 | 0 | 6 of 6 | 0 of 6 | 0 | none | 0 | 0 |
| search | unfixed | 600 | no | no race | 6 of 6 | 6 of 6 | 0 | 0 of 6 | 0 | none | 0 | 0 |
| search | unfixed | 900 | no | no race | 6 of 6 | 4 of 6 | 1 of 6 | 0 of 6 | 0 | none | 0 | 0 |
| love | unfixed | 600 | yes | no race | 6 of 6 | 5 of 6 | 1 of 6 | n/a (steps failed) | 0 | none | 0 | 8 |
| rate | fixed | 300 | yes | no race | 6 of 6 | 3 of 6 | 3 of 6 | 0 of 6 | 0 | none | 0 | 0 |
| rate | fixed | 600 | yes | no race | 6 of 6 | 4 of 6 | 2 of 6 | 0 of 6 | 0 | none | 0 | 0 |
| rate | fixed | 900 | yes | no race | 6 of 6 | 5 of 6 | 1 of 6 | 0 of 6 | 0 | none | 0 | 0 |
| rate-fast | fixed | 600 | yes | no race | 6 of 6 | 6 of 6 | 0 | 0 of 6 | 0 | none | 0 | 0 |

The *errors* column counts loads whose harness steps failed (the love session's 8 click timeouts). The 3 rate
sessions without the mirror and the 3 with it are separate sessions of the same steps (48 loads); the unfixed
600 ms mirror row is the second such session (batch 2), whose first finding was replayed on the fixed build.

Scenario by scenario:

- **rate** (Songs list, first row: click 3 stars; once the server has answered the refresh that follows, click 5
  stars; blur): **the race of section 4.** Seeds 2 and 5 left 3 stars on screen at every latency, the baselines
  never did. Without the mirror explore said "No race found" in 3 of 3 sessions and listed the rating under
  "Internal state only" (`List.state7.data.allRecords.<id>: baseline {... rating: 5, +46}, this run {... rating: 3,
  +46}`), only for the first runs it lists (section 6, item 2). With the mirror: "RACE: 2 of 6" in 3 of 3 sessions,
  the page text `row stars three ...` against the baseline's `row stars five ...`, and the replay of the first
  finding (seed 2) "REPRODUCED · the page shows the failing run's text again" at each latency (the first 600 ms
  session's replay was lost to a harness bug, section 6 item 7; the session was run again, and that is the row in
  the table).
- **rate-fast** (the same two ratings back to back): **no race**, 0 of 18 by the oracle and by explore. Both
  `setRating` calls reach the server before either refresh is answered, so both refreshes read 5 whatever order
  they land in. The plain script with the first refresh delayed got 2 of 5 stale runs, because outside a held
  schedule it is down to whether the server answers the first refresh before the second rating arrives.
- **reorder** (the hunt playlist: drag row 1 onto row 4, twice): the page agreed with the server in all 24 loads.
  Explore said "RACE: 5 of 6" (600 ms) and "6 of 6" (900 ms). In each, the difference was the number of
  `PUT /api/playlist/:id/tracks/:id` requests: the baselines at 600 and 900 ms sent 1 (the second drag sent
  nothing) and most seeded loads sent 2, so the final order differed (`a2,a3,a4,a1` vs `a3,a4,a1,a2`). Without
  GenClass ([navidrome/reorder-repro.mjs](navidrome/reorder-repro.mjs): no delay, or 600 ms on the `PUT`, on the
  refetch, or on both), the second drag sent its `PUT` in 12 of 12 runs and the page matched the server in 12 of
  12. **Classified as not a bug:** a timing-dependent request count that only happened under GenClass's held
  schedule. Whether the app or the hold swallowed the second HTML5 drag cannot be told from the recording, which
  has no actions for drags (section 6, item 4). The plain runs did show a real but minor ordering effect,
  section 5.3.
- **search** (control: Songs list search, type "Track 1", wait 700 ms past react-admin's 500 ms filter debounce, type
  " of album 2"): **no race** at 300, 600 and 900 ms, by explore and by the oracle (every load, the baselines
  included, showed the same 5 rows). ra-core 3.19 keys list results by filter in `list.cachedRequests`, so the
  older query's late response lands under its own key; as the brief predicted, this is the clean control. The
  internal tier still listed 0 to 6 runs per session (store bookkeeping) and the "along the way" tier up to 6, all
  with the page identical: those are this hunt's false-report rate, 0 RACE lines in 18 seeded loads on search.
- **love** (play the song, love it from the list row, then at once from the player bar): **not measured.** Under
  explore all 8 loads failed at the player bar's heart: Playwright's click waited 30 s on `<button disabled ...
  Mui-disabled>` ("element is not enabled"), far longer than any hold (at most the delay plus `maxHoldMs`, 2.1 s
  here); in the plain runs the same button was enabled. Why it stayed disabled under the agent link was not
  investigated (section 6, item 8). The "No race found" verdict of that session compares loads whose steps did not
  complete. Without GenClass the scenario ran, but its control does not hold either: a
  *single* love from the list row leaves the player bar's heart empty while the server says loved (2 of 2 runs, no
  delays), so the player bar does not follow the list in this build at all (section 5.2) and a two-view race cannot
  be told apart from that.

False reports: where the page did not depend on the order by the oracle (search, 3 sessions; rate-fast, 3
sessions; the 4 non-failing seeds of each of the 6 unfixed rate sessions; the 4 fixed-variant sessions), explore gave
**0 RACE lines in 18 + 18 + 24 + 24 = 84 seeded loads**. Its RACE lines on reorder (11 of the 18 seeded reorder
loads: 5 of 6 at 600 ms, 6 of 6 at 900 ms, replays "reproduced") are counted as false reports of this run: a
request count that the reproduction without GenClass never showed. Its "No race found" on the unfixed
rate sessions without the mirror is a false negative (6 of 18 seeded loads showed the wrong stars).

## 4. The finding

### 4.1 What explore saw

The first session `rate`, 600 ms, with the mirror (finding f135; the 300 and 900 ms sessions and the second 600 ms
session, finding f1006, are the same story with the same seeds). Report, reduced:

```
Compared: 6 of 6 reordered run(s) against two baselines.
## / · 8 run(s) · scenario:
  click label "3 Stars" / click radio "3 Stars" / click label "5 Stars" / click radio "5 Stars"
RACE: 2 of 6 reordered run(s) ended in a different state than the baseline (responses in request order) ...
- run r16 (seed 2):
    page text only in the baseline: "row stars five not loved / row stars zero not loved"
    page text only in this run: "row stars three not loved / row stars zero not loved"
    state "List.state7.data.allRecords.1GWyYJ4ErXLTLelCAzxRky": baseline "{... rating: 5, +46}", this run "{... rating: 3, +46}"
- run r19 (seed 5): the same
```

`genclass_explain` on the finding, the recorded timeline of run r16 reduced to the requests under test (times from
the page load; `t` and `s` query parameters, the Subsonic token and salt, removed here, see section 6 item 3):

```
+4.431s action 0: click label "3 Stars"            +4.434s action 1: click radio "3 Stars"
+4.435s send GET /rest/setRating#1                 (action 1)
+4.865s delivered GET /rest/setRating#1 (held 397 ms)
+5.081s send GET /api/song/:id#1 (action 1) via GET /rest/setRating      <- answered by the server: rating 3
+5.160s action 2: click label "5 Stars"            +5.162s action 3: click radio "5 Stars"
+5.163s send GET /rest/setRating#2                 (action 3)
+5.409s delivered GET /rest/setRating#2 (held 218 ms)
+5.595s send GET /api/song/:id#2 (action 3) via GET /rest/setRating      <- answered: rating 5
+6.220s delivered GET /api/song/:id#2 (held 594 ms)
+6.392s write List.state7.data.allRecords.<id> by GET /api/song/:id#2: "changed rating: 1 → 5"
+6.403s delivered GET /api/song/:id#1 (held 1.3 s)
+6.461s write redux.admin.resources.song.data by GET /api/song/:id#1
+6.534s write List.state7.data.allRecords.<id> by GET /api/song/:id#1: "changed rating: 5 → 3"
```

The run's witnesses include `overwrote-newer redux.admin.resources.song.data by GET /api/song/:id#1` and
`overwrote-newer List.state7.data.allRecords.<id> by GET /api/song/:id#1` (seeds 2 and 5 only), but the finding's
evidence lists only the first four witnesses of the run, which are re-render counters (section 6, item 2).

### 4.2 Without GenClass

[navidrome/repro.mjs](navidrome/repro.mjs): plain Playwright, no injection. The song is reset to 1 star, the first
`GET /api/song/:id` after the click is fetched from the server at once and fulfilled 800 ms later, the 5th star is
clicked once the server has answered that first refresh, then the page is blurred and read after the delay plus
1.5 s:

```
node docs/adoption/hunts/navidrome/repro.mjs --runs 5 --mode stale   # 5 of 5: shown 3, server 5
node docs/adoption/hunts/navidrome/repro.mjs --runs 5 --mode none    # 0 of 5: the same clicks, no delay
node docs/adoption/hunts/navidrome/repro.mjs --runs 5 --mode fast    # 2 of 5: both clicks back to back
```

Its timeline in one stale run (`REPRO_DEBUG=1`, times from the first click): `setRating?rating=3` done at +304 ms,
`GET /api/song/:id` sent at +538 ms (answered with 3, delivered at +1379 ms), `setRating?rating=5` at +637 ms, the second `GET /api/song/:id` at +823 ms delivered at
+851 ms; the row ends on 3 stars, the server on 5.

How likely is it for a user? It needs the second click after the server has answered the first refresh but before
that answer has reached the page: a window of one response's transit time, which on a slow mobile link or a
remote server is hundreds of milliseconds. Someone correcting a misclick (3, then 5) on such a link is the case.
The stars then show a rating the server does not have, and nothing corrects them: the server's `refreshResource`
event for the rating (`api.broker.SendMessage` in `server/subsonic/media_annotation.go`) goes to the user's
*other* clients only (`shouldSend` in `server/events/sse.go` skips the client the request came from), so the tab that
rated gets no further refresh.

### 4.3 Root cause

`ui/src/common/useRating.jsx` lines 53 to 66 at `7c1e68a`:

```js
  const rate = (val, id) => {
    setLoading(true)
    subsonic
      .setRating(id, val)
      .then(refreshRating)        // dataProvider.getOne(resource, { id }) -> GET /api/song/:id
      .catch(...)
  }
```

Each call starts its own `setRating` then `getOne` chain. ra-core 3.19's `performPessimisticQuery` dispatches
`CUSTOM_FETCH_SUCCESS` with `fetchResponse: GET_ONE` for every `getOne` that resolves, and the resource data reducer
replaces the record (`addOneRecord`), so whichever response lands last decides what the row shows. `RatingField.jsx`
ignores the hook's `loading` (it destructures `[rate, rating]` and disables the `Rating` only for `record.missing`),
so nothing stops the second click while the first chain is in flight. `LoveButton` does not have the problem
within one view: it is disabled while its `loading` is true.

### 4.4 The fix

[navidrome.patch](navidrome.patch) (against `7c1e68a`, `git apply`), two files:

- `useRating.jsx`: a `pendingRef` holds the previous rating's chain, and `rate()` chains the new rating after it,
  so a second rating's `setRating` is sent only once the first rating's refresh has landed, and the last rating's
  refresh is always the last write to the store. `refreshRating` now returns its promise (both branches), `rate()`
  returns the chain. 19 lines added and 13 removed, most of them the old chain re-indented; no behaviour change
  for a single rating, and the playlist-track branch (reload the list, #6009) unchanged.
- `useRating.test.js`: "keeps the last rating when a quick second rating overtakes the first refresh". A fake
  server stores each rating and answers each `getOne` with what it holds when the request arrives; the test
  delivers the pending answers newest first and asserts that `setRating` was called with 3 then 5, that the server
  holds 5, and that the last refresh to land carries 5. In the project's style (`renderHook`/`act` from
  `@testing-library/react-hooks`, `vi.mock('../subsonic')`, `useDataProvider.mockReturnValue({ getOne })`).

Considered and not chosen: disabling the `Rating` while `loading`, as `LoveButton` does (it greys the stars out on
every click, and the hook already returns `loading` that `RatingField` ignores, so the maintainers may prefer it:
the PR draft mentions it); a sequence counter that ignores an older response (not possible here: the store write
happens inside react-admin's data provider before the hook sees the response).

### 4.5 Test results

In a separate worktree of the same commit (`git worktree add ~/targets/nd-fix`, `ui/node_modules` linked), Node 24:

| check | unfixed | fixed |
|---|---|---|
| `npx vitest run src/common/useRating.test.js`, 3 times | 3 of 3 failed: `expected 3 to be 5` (9 other tests pass) | 3 of 3 passed (10 of 10) |
| `npm run test` (all 93 files) | not run | 855 passed |
| `npm run lint` (eslint, `--max-warnings 0`) | not run | clean |
| `npm run check-formatting` (prettier) | not run | "All matched files use Prettier code style!" |

Not run: `make test` and `make lintall` (Go; the patch touches no Go file, and golangci-lint could not be installed
here, section 1).

### 4.6 The fixed variant

The patch was applied to the served tree (Vite reloads it), and then (batch 2, `HUNT_VARIANT=fixed`):

| check | unfixed | fixed |
|---|---|---|
| `genclass_replay` of the unfixed finding f1006 (seed 2, 600 ms) | "r146: REPRODUCED · the page shows the failing run's text again" | "r147: not reproduced · the page shows the baseline's text" |
| explore `rate` with the mirror, 300 / 600 / 900 ms | race in 2 of 6, each | no race, each (0 of 18 seeded loads differing by the oracle) |
| explore `rate-fast` with the mirror, 600 ms | no race | no race (0 of 6) |
| `repro.mjs --runs 5`, modes stale / fast / none | 5 / 2 / 0 of 5 stale | 0 / 0 / 0 of 5 stale |

The fixed sessions still listed 3 to 6 runs under "Internal state only" and up to 3 under "along the way", with
the page identical in every load: the same store bookkeeping and re-render-counter witnesses as on the control
scenario (section 6, item 5). Their RACE line count, 0 of 24, is the false-report rate on the correct variant.
After the checks the served tree was restored to the unfixed commit (`git checkout`).

## 5. Other observations

### 5.1 Two MUI `Rating` behaviours that make the stars lie

Both are in `@material-ui/lab` 4.0.0-alpha.61's `Rating`, as Navidrome uses it in `RatingField.jsx`, and both had to
be worked around before the oracle meant anything. Neither is a race; the drafts mention them only as
reproduction notes.

- A focused `Rating` paints its focused value (`focus` state) instead of `value`, so right after a click the stars
  show the clicked value whatever the store holds, until the focus moves away. During the hunt this hid the race:
  the first plain runs (on an unrated, focused song: both behaviours at once) read "5" before any refresh had
  landed.
- The API omits `rating` when it is 0 (`model/annotation.go`, `json:"rating,omitempty"`), so an unrated song's
  `Rating` mounts with `value={undefined}`, i.e. uncontrolled, and keeps painting its own click state while the
  store changes underneath it. On an unrated song the race of section 4 is invisible, and so would be any server
  rejection of a rating. Passing `value={rating ?? 0}` in `RatingField` would make it controlled; not measured
  further here.

### 5.2 The player bar's heart does not follow the list's

Loving the playing song from its list row leaves the player bar's heart empty while the server has the song loved
(2 of 2 runs without GenClass, no delays, `hunt.mjs plain love-one 2`, and a screenshot read by hand). The player bar
reads the song through `useGetOne('song', id)` in `PlayerToolbar.jsx`. Why it does not see the store update was not
investigated (out of the hunt's scope); it is what made the two-view love scenario unmeasurable.

### 5.3 A second drag in the refetch window acts on positions

`PlaylistSongs.jsx` does not reorder rows optimistically: after a drag the list shows the old order until the
refetch lands. Playlist track ids are positions, so a second drag in that window sends the positions of the order on
screen, which the server applies to its new order. Without GenClass, two identical drags ended `a2,a4,a1,a3` with
no delay and `a3,a4,a1,a2` with 600 ms on the `PUT`, on the refetch or on both (3 of 3 runs each); the page matched
the server every time. What the user meant is ambiguous (they dragged the row they saw), so this is recorded as an
observation, not a finding; it is the same positional-id property behind #6008.

## 6. Problems with GenClass itself

Recorded as they were hit. Items 1 to 6 and 8 are about GenClass, 7 about this harness.

1. **False negative on icon-only state (explore verdict).** The stars are SVG icons with a constant hidden label
   ("3 Stars"), so the stale rating never reached the page text, and explore's tiering put the decisive store
   difference (`List.state7.data.allRecords.<id>: rating 5 vs 3`) under "Internal state only", with the verdict "No
   race found: none of the 6 compared reordered run(s) ended with a different page", in 3 of 3 sessions where the
   DOM showed the wrong stars in 2 of 6 loads. AGENT.md section 5.1 documents the limit for control state; this is
   the case where it hides a real bug in a common widget (MUI `Rating`, any icon toggle such as a heart or a star).
   Even the radios' `checked` state did not help: React leaves a radio group's native `checked` as the click left
   it when the controlled value does not change. Suggestions: promote a store difference to the visible tier
   when the same run also has an `overwrote-newer` witness on that field that the baselines lack (both were true
   here, and the combination is the definition of the stale write); or read icon state into the page lines (the
   number of `[class*=Filled]`/`aria-pressed`/`aria-checked` elements per row); or at least say in the "No race
   found" line that internal differences with a matching witness exist.
2. **Truncated evidence.** The "Internal state only" list showed 3 of the 4 runs it counted (seed 5's rating
   difference was not shown), and the finding's evidence in `genclass_explain` listed the run's first four
   witnesses: `SongList.state5` and `redux.admin.loading` (re-render counters and the loading count). It left out
   `overwrote-newer redux.admin.resources.song.data by GET /api/song/:id#1`, the one that names the bug.
   Suggestion: order witnesses by whether their field also differs from the baseline, and say "(+N more)" when a
   list is cut.
3. **A credential in the recordings.** Navidrome's Subsonic calls carry `u`, `t` (md5 of the password and the salt,
   which authenticates any request) and `s` (the salt) as query parameters. They were recorded unredacted:
   `send GET /rest/setRating#1 "?u=admin&t=<32 hex digits>&s=<salt>&f=json…"` in `genclass_explain`'s steps, and in the
   bridge's `state.json`. The values here are a local dev admin's, and nothing left the machine. But the explain
   output is something an agent pastes into an issue, and a Subsonic token is a working credential. Suggestion: redact
   query parameters by name, as headers are (`t`, `token`, `s`, `p`, `jwt`, `apiKey`, `key`, `sig`, `signature`,
   ...), and redact `jwt=` in the `EventSource` URL (`/api/events?jwt=...`, which Navidrome also uses).
4. **No actions for HTML5 drag and drop.** The reorder loads recorded `acts: []`: Playwright's `dragTo` (mouse down,
   move, up, with the browser's native drag events) produced no recorded user action, so the scenario grouping saw
   no steps, the generated test would have no steps, and "did the second drag happen?" could not be answered from
   the recording. Suggestion: record `dragstart`/`drop` as a `drag` action with source and target names.
5. **Noise witnesses by the dozen.** Every load, the baselines included, recorded 20 to 40 `overwrote-newer`
   witnesses on component hook states that look like re-render counters (`SongList.state4: 8 → 9`,
   `Menu.state2`, `PlaylistsSubMenu.state4`, `LibrarySelector.state5`, ...), by whichever start-up response landed.
   They fill the "along the way" tier (up to 6 of 6 runs on the control scenario) and the evidence lists of item 2.
   Suggestion: treat a numeric hook state that only increments as a counter, never as data.
6. **The generated regression test.** For the rating finding it clicks `getByText("3 Stars").first()` and then
   `getByRole("radio", { name: "3 Stars" }).first()`: the hidden label of whichever row is first, then the radio
   again (one physical click is recorded as two actions, label and radio, and replayed as two clicks; a click on
   the radio runs MUI's `handleClear`, which calls `onChange(null)` when that star is already the value,
   `@material-ui/lab` `Rating.js`, so the replayed steps are not the user's). Its assertions are on the harness's mirror text, so
   without the mirror it would assert nothing about the stars. It is a starting point, not a test to commit.
7. **Harness: `genclass_replay {action: "result"}` without `id`** answers "No finding ." instead of the armed
   replay's result; the first 600 ms session lost its replay that way (fixed in the harness, session re-run).
8. **A control that stayed disabled under the agent link, and a verdict over the failed loads.** In the love
   session the player bar's heart was disabled for the whole 30 s wait in 8 of 8 loads, but enabled in the plain
   runs of the same steps; the button is disabled while the player's `useGetOne('song', id)` is loading or its own
   toggle is in flight, so something it waits for apparently never completed under the held schedule. Not
   investigated further. Explore still compared those 8 loads and said "No race found ... 6 of 6": the agent link
   cannot know that a harness step failed, but every load recorded fewer actions than the scenario has, which the
   report could flag.

Also seen, not GenClass's: the dev UI throws `Unexpected token '{'` twice on every load (the Go template placeholders
in `ui/index.html` that the production build fills in), with or without GenClass; GenClass counted them as errors
in every run, the baselines included, so they never affected a verdict.

## 7. Time spent

About 1 hour 15 minutes of wall-clock time, from the clone (about 16:30 UTC) to the pull request (timestamps of the
files under `~/targets`), roughly:
10 minutes to install Node 24, run `make setup` (and work around its golangci-lint step), generate the music and get
`make dev` up (the race-enabled Go build took about 90 s); 6 minutes for the plain reproduction, most of it spent
discovering that a focused or uncontrolled MUI `Rating` paints something other than the store (section 5.1); 10
minutes to write the GenClass harness and run the first explore sessions (the first one said "No race found" while
the oracle showed the race, which led to the mirror); 20 minutes for 15 explore sessions in one background batch,
during which the fix, the regression test, Navidrome's suite and lint, the upstream searches and the drafts were
done in a separate worktree; 8 minutes for the 6 sessions and the plain runs of the fixed-variant batch; the rest
writing. The race was on the first surface the brief named; the fix took one change to one hook.

## 8. Upstream checks (2026-11-03)

- Contribution rules read in the clone: `CONTRIBUTING.md` (issue first; branch `<Issue Title>/<Issue Number>`;
  commits `<type>(scope): <description> - #<issue>`; DCO via `git commit --signoff`; no CLA),
  `.github/ISSUE_TEMPLATE/bug_report.yml` (title `[Bug]: `; blank issues disabled), `.github/pull_request_template.md`.
  No AI or LLM policy in any of them.
- Duplicate search (`gh api search/issues`, `repo:navidrome/navidrome is:issue|is:pull-request` with "rating
  in:title", "rating stale", "rating race", "useRating", "rating reverts", "rating wrong", "rating not saved",
  "rating ui"): no issue or pull request about a rating reverting or ordering in the UI. Related: #6008 / #6009
  (merged 2026-08-21: rating or loving a smart-playlist track refetched the row by positional id; the fix this patch
  keeps), #6066 (closed duplicate of #6009), #6411 / #6413 (merged 2026-11-02, server range check, the commit the
  patch is against), #2028 (closed 2022, "UI inconsistencies with 5 stars ratings", not this). Open and touching the
  same area: **#5570** ("feat(ui): rate the current track from the player toolbar", which matched "useRating") and
  #5561 (user ratings with average display). Their diffs could not be read from this environment (HTTP 403 from
  GitHub for both the API and the `.diff` URLs), so the sender checks them (navidrome-issue.md).

## 9. Reproducing

```bash
# Navidrome running as in section 1 (make dev), then from this checkout:
node docs/adoption/hunts/navidrome/repro.mjs --runs 5 --mode stale          # without GenClass: 5 of 5 before the fix
node docs/adoption/hunts/navidrome/hunt.mjs seed
HUNT_MIRROR=1 node docs/adoption/hunts/navidrome/hunt.mjs explore rate 600 6  # RACE: 2 of 6 (seeds 2, 5) before the fix
node docs/adoption/hunts/navidrome/hunt.mjs explore rate 600 6               # the same without the mirror: "No race found"
node docs/adoption/hunts/navidrome/hunt.mjs explore search 600 6             # the control
node docs/adoption/hunts/navidrome/reorder-repro.mjs --runs 3 --target all
node docs/adoption/hunts/navidrome/summarise.mjs                             # results.json and the table of section 3
# the fix
(cd ~/targets/navidrome && git apply /path/to/GenClass-lib/docs/adoption/hunts/navidrome.patch)
(cd ~/targets/navidrome/ui && npx vitest run src/common/useRating.test.js && npm run test && npm run lint && npm run check-formatting)
```

Raw output (`<scenario>-<slow>[-mirror][-fixed].txt|json`, with the full explore reports and timelines) stays in
`~/targets/nd-hunt/out`, outside this checkout: it holds the Subsonic tokens of item 3.
