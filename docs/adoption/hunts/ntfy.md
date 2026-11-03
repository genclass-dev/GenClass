# Race hunt: ntfy web app (binwiederhier/ntfy, v2.37.1-14)

A GenClass race hunt on the ntfy web app, run on 2026-11-03 in a cloud session, with the real `@genclass/runtime`
(0.3.0-beta.5, this repository at `c1c9e14`) injected into the app by Playwright and the real `@genclass/mcp` (0.2.1)
driven the way a coding agent drives it. ntfy's source was not modified for the hunt; the fix is a patch for its
maintainer (`ntfy.patch`, draft issue and pull request text in `ntfy-issue.md`). Nothing was sent to ntfy's
repository, Discord, Matrix or maintainer.

**Headline.** Two related bugs in the web app's account sync (`web/src/app/AccountApi.js` `sync()`), both
reproduced without GenClass:

1. **A sync can undo a change made while it was fetching the account.** Every account change (subscribe, unsubscribe,
   display name, reservation, a setting) makes the server publish a `sync` event, and every sync event makes the app
   `GET /v1/account` and apply the result over its local IndexedDB state with no ordering check. An account fetched
   before a change and applied after it undoes the change locally. Most visible case, **in natural order on localhost,
   no GenClass, no delay**: subscribing to a topic with "Reserve topic" on, for an account that already has another
   subscription, removes the new topic again for a moment and deletes the messages the app had just loaded for it; the
   topic then shows no messages although the server has them (6 of 6 loads, and 4 of 4 in an earlier run; 0 of 4 when
   the account has no other subscription). Under explore's reordering, a second subscribe lost its topic entirely (RACE
   in 1 of 6 at 300 ms; 1 of 24 seeded loads over two sessions), and so did the reserve subscribe (1 of 6 at 600 ms and
   at 900 ms). With one response held until the next one is answered (plain Playwright, no GenClass), all six surfaces
   ended with the browser disagreeing with the server, 3 of 3 loads each: a setting flips back, a subscribed topic is
   missing, an unsubscribed topic is back, an old display name returns, a reserved topic's messages are gone.
2. **Unsubscribing from the last topic never removes it in other browsers.** The server omits an empty
   `subscriptions` list (`omitempty`), and `sync()` only applies the list when it is there. Two browsers of one
   account, one topic, unsubscribe in browser 1: browser 2 still lists it after the sync event and after a reload, 3 of
   3 runs (0 of 3 when a second topic stays subscribed). It also makes bug 1's stale re-add of an unsubscribed topic
   permanent when that topic was the last one: in explore's `unsubscribe` sessions the topic the user had just
   unsubscribed from came back and stayed in 6, 6 and 7 of 8 loads at 300, 600 and 900 ms (the fifo baselines
   included).

A fix in one file, `AccountApi.js` (17 lines added, 3 removed, comments included: skip a sync whose fetch overlapped a
local account change; apply an absent list as empty), plus two unit tests and three Playwright checks (two new specs,
one line added to an existing one): the unit tests and the specs fail on the unfixed code 3 of 3 times and pass on the
fixed code 3 of 3 times; ntfy's whole Vitest suite (127 tests, two of them new) and Playwright suite (73 passed: the 71
existing specs and the 2 new ones, 3.1 min) pass on the fixed build. On the fixed build explore found no race on
`subscribe` and `reserve` (0 of 18 each), and the plain reproduction no longer ends in a difference (0 of 3 on each of
the six surfaces, with the held response delivered last in all 18 loads). Explore still reports a race on `unsubscribe`
on the fixed build: the stores end equal in all 24 loads, but the page can end on the removed topic's empty "Loading
notifications …" page, because a sync that lands during the few milliseconds between the local IndexedDB write and the
account request still applies (section 4.6: what remains, and the fuller fix).

The settings flip-back (the brief's surface 1) is real in code and in the plain reproduction, but explore never
produced it at Playwright's pace: 0 of 36 reordered loads had the first sync's response still in flight when the second
change was made (section 3). Every RACE explore reported on the settings page was a false report caused by ntfy's
Language select, which renders three random flags per load (section 6).

Sections: 1 setup, 2 how the app was driven, 3 scenarios and verdicts, 4 the findings, 5 time spent and what the sender
must do, 6 problems with GenClass itself, 7 reproducing.

## 1. Setup

| what | version |
|---|---|
| ntfy | `main` at `8ed8684febe4806e7cad91b40610dfa378336415` (2026-11-02, `git describe`: v2.37.1-14-g8ed8684f), the commit the patch is against; `web/src/app/SubscriptionManager.js` and `web/src/components/hooks.js` last changed 2026-10-30 (notification replays), `web/src/app/AccountApi.js` 2026-07-16 ("Allow logging in via email"); nothing since guards `sync()` |
| Go | 1.24.7 in the image; ntfy's `go.mod` (`go 1.26.0`) made the toolchain download go1.26.0 |
| Node, npm | 22.23.4 |
| Browser | Playwright 1.63.0 (GenClass's) with the preinstalled Chromium 153 (`/opt/pw-browsers`, revision 1243). ntfy's own suite pins `@playwright/test` 1.64.0 (revision 1248): it ran on the same Chromium through a private `PLAYWRIGHT_BROWSERS_PATH` whose `chromium-1248` entries are symlinks to the 1243 ones (`npx playwright install` is not allowed here) |
| GenClass | this repository at `c1c9e14`, `@genclass/runtime` 0.3.0-beta.5 and `@genclass/mcp` 0.2.1 built from it (`dist/`) |

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# ntfy, outside this checkout (docs/develop.md, Makefile "web-e2e" without its "npx playwright install")
git clone https://github.com/binwiederhier/ntfy.git ~/targets/ntfy && cd ~/targets/ntfy
make web cli-deps-static-sites
CGO_ENABLED=1 go build -tags sqlite_omit_load_extension,osusergo,netgo -o build/ntfy-e2e .
(cd web && PLAYWRIGHT_BROWSERS_PATH=~/pw-ntfy npx playwright test)    # 71 passed (3.1 min) on the unfixed code
# the hunt server: ntfy's own e2e server script (throwaway database, signup, reservations, tier "e2e", admin token)
node web/e2e/server.mjs build/ntfy-e2e build/e2e/server.yml 12586 e2e
```

The brief counted 56 specs; the suite has 71 today. The fixed variant was built the same way into
`build/ntfy-e2e-fixed` and served by the same script on port 12587 (its own `build/e2e-fixed/` directory), so both
variants ran side by side; the bundle each port served was checked for the fix's log line (12586: absent, 12587:
present).

## 2. How the app was driven

`hunts/ntfy/explore.mjs` (header: how to run it). The Gitea pattern: a Playwright route rewrites each app HTML page to
load `packages/runtime/dist/genclass.global.js` from a virtual same-origin path with `model: false, telemetry: false`,
then `connectAgent()` from `dist/agent.js`; the MCP server runs in the harness's process (`serve()`), and the harness
calls `genclass_clear`, `genclass_explore` (start, report), `genclass_explain` and `genclass_findings` over JSON-RPC.
Service workers are blocked (ntfy's precache would otherwise serve the page past the route), and each context gets the
`local-network-access` permission. ntfy keeps its data in IndexedDB (Dexie) and React state; GenClass discovered the
React state (minified names such as `showMenu_3.state0`) and compared page text and form values; no `rt.atom()` mirror
was needed.

One user per harness run, created with the admin token on the `e2e` tier (reservations), logged in by putting an API
token in `localStorage` (ntfy's `Session` reads it). Before every page load the account is reset through the API to the
surface's starting state (settings `sound: ding, min_priority: 1, delete_after: 30 days`; the surface's
subscriptions; no reservations), so every load starts from the same server state; topic names are per harness run and
letters only (a deleted user's reservations outlive it for ntfy's grace period, which broke one early session, section
3). Every load waits for the account's `st_…` sync WebSocket to be open (sync events only arrive after that) and for
`whenSettled()` before the steps, and again after them (plus 1.5 s for a sync event on its way).

The harness's own oracle after the page settled: the browser's IndexedDB (`ntfy-<user>`: the subscriptions with display
names, reservations and notification counts, and the `sound`/`minPriority` prefs) next to the server's
`GET /v1/account` and a poll of each subscribed topic, plus the sidebar's topic rows over time (a `MutationObserver`
on `nav`, so a topic that vanishes and comes back shows as `[a,b] > [b] > [a,b]`). "DIFFERS" means the browser and the
server disagree at the end. Explore reordered the HTTP responses (`GET /v1/account`, the `PATCH`/`POST`/`DELETE` to
`/v1/account/...`, polls, `auth` checks); the sync events themselves arrive over the WebSocket, which GenClass records but
never reorders, so every reorder here is of the fetches the events cause.

Two runs without GenClass (`GENCLASS=0`): the **control** (the same steps, the network as it is, 6 loads), and the
**plain reproduction** (`--hold 1`): a Playwright route holds the first `GET /v1/account` sent after the page settled,
fetched from the server at once, until the next `GET /v1/account` was answered or 3 s passed, 3 loads.

## 3. Scenarios and verdicts

Explore: 2 fifo baselines and 6 seeded loads per session, at 300, 600 and 900 ms of added latency (uniform 0 to
`slow_ms` per response); "oracle" counts the loads of a session that ended with the browser disagreeing with the server
(all 8, baselines included).

| surface (steps) | unfixed: explore verdict, 300 / 600 / 900 ms | unfixed: oracle DIFFERS | control (no GenClass) | plain reproduction (no GenClass) | fixed: explore / oracle | fixed: control, plain |
|---|---|---|---|---|---|---|
| `prefs`: Notification sound "No sound", then Minimum priority "Only max priority" | "RACE" 6/6, 6/6, 6/6, all false (the Language row, section 6) | 0/8, 0/8, 0/8 | 0/6 | 3/3: min priority back to 1 locally, 5 on the server | not run | 0/6, 0/3 |
| `prefs-twice`: sound "No sound", then "Juntos" | "RACE" 6/6, 6/6, 6/6, all false (same) | 0/8, 0/8, 0/8 | 0/6 | 3/3: "No sound" locally, "Juntos" on the server | not run | 0/6, 0/3 |
| `subscribe`: subscribe to A, then to B | first valid session, 300 ms: RACE 1/6 (B gone locally, finding f2); a full rerun: no race 0/6, 0/6, 0/6 | first session 1/8; rerun 0/8, 0/8, 0/8 | 0/6 | 3/3: B missing locally | no race 0/6, 0/6, 0/6; oracle 0/24 | 0/6, 0/3 |
| `unsubscribe` (A, B subscribed): unsubscribe A, then B | RACE 4/6, 2/6, 3/6 (the *correct* runs differ from buggy baselines) | 6/8, 6/8, 7/8: B back locally and kept | 0/6 | 3/3: B back locally | RACE 1/6, 0/6, 6/6 on the final page only (section 4.6); oracle 0/24 | 0/6, 0/3 |
| `rename` (A subscribed): display name "First name", then "Second name" | no race 0/6, 0/6, 0/6 | 0/8, 0/8, 0/8 | 0/6 | 3/3: "First name" locally, "Second name" on the server | not run | 0/6, 0/3 |
| `reserve` (B subscribed, A has 2 messages): subscribe to A with "Reserve topic" | no race 0/6; RACE 1/6; RACE 1/6 (A gone locally) | 0/8, 1/8, 1/8 | **6/6: A's 2 messages gone locally** (sidebar flicker 6/6) | 3/3: A gone locally | no race 0/6, 0/6, 0/6; oracle 0/24; no flicker | 0/6 (both messages kept 6/6), 0/3 |

Why the settings and rename surfaces gave explore nothing: each change's sync fetch is sent the moment its sync event
arrives and answered within the added latency, while Playwright's second MUI select (or the second rename dialog) comes
about a second after the first. In all 36 reordered `prefs`/`prefs-twice` loads and all 24 `rename` loads the first
sync's response was delivered before the second change's request was even sent (the recorded delivery orders, in the
summaries). The flip-back needs a sync response slower than the user, which the plain reproduction provides. A person on
a slow mobile connection, or a sync started by another device or by the page load, gives the same overlap.

Negative and invalid sessions, for the record: the first `subscribe` sessions at 600 and 900 ms errored in all 16 loads
(the topic name was reserved by an earlier `reserve` experiment's user, whose reservation outlived the user's deletion;
the subscribe dialog then reports "not authorized"); they were discarded and topic names were made per run. The first
rerun completed its 300 ms session (the RACE above, f2) before the session's 30-minute limit on a background command
stopped the hunt server; a second, complete rerun found no race at 300, 600 or 900 ms (0 of 18), so explore's
`subscribe` race stands at 1 of 24 seeded loads. The same shared topic name was also used by the first `unsubscribe` and
`rename` sessions, so both were rerun with per-run topics; the table has the rerun (the first sessions gave `unsubscribe` RACE 4/6, 4/6,
2/6 with oracle 6/8 each, and `rename` no race, 0 of 24: the same picture). The server stop also made two
regression-spec runs fail in milliseconds against no server; they were rerun.

Not hunted: the poll/WebSocket merge (rewritten and covered by e2e specs on 2026-10-29/30, per the brief), the Connection
backoff (#1930, an enhancement), and a server-side lost update the code suggests (`handleAccountSettingsChange` and the
subscription handlers read-modify-write the whole `Prefs` of `v.User()`; two concurrent account requests could each
write back the other's old copy). Explore reorders deliveries in the browser, not the server's processing, so it cannot
test that; it is noted for the sender, not claimed.

## 4. The findings

### 4.1 What explore saw (`subscribe`, seed 5 at 300 ms, finding f2)

Quoted from `genclass_explain` (the recorded steps of the failing run, times from `connectAgent`; React state names
are minified):

```
+3.391s action 2: click button "SUBSCRIBE"                      (topic A)
+3.530s send POST /v1/account/subscription#1
+3.633s send GET /v1/account#2                                  (A's sync event)
+3.687s delivered POST /v1/account/subscription#1 (held 69 ms)
+4.015s action 5: click button "SUBSCRIBE"                      (topic B: upsert B locally, then POST)
+4.340s send POST /v1/account/subscription#2
+4.406s send GET /v1/account#3                                  (B's sync event)
+4.609s delivered GET /v1/account#2 (held 959 ms)               account without B
+4.640s write showMenu_2.state1.subscriptions by GET /v1/account#2: undefined → 1 item
+4.649s delivered GET /v1/account#3 (held 222 ms)               account with A and B
+4.689s write showMenu_2.state1.subscriptions by GET /v1/account#3: 1 → 2 items
+4.809s write pj.state2: "bravo…" → ""                          (the topic page loses its topic)
```

Evidence: page text in the baseline only "You haven't received any notifications for this topic yet.", the curl example
for B; in the failing run only "Loading notifications …"; the field "Type a message here" absent. The oracle: B is on
the server and not in IndexedDB. Note the order: the stale `GET#2` was delivered *before* `GET#3`, and B was still lost.
`GET#2` landed after B was upserted locally, so its `syncFromRemote` set out to remove B, and the two syncs' writes
interleaved: `GET#3`'s upsert of B found B still there (no write), then `GET#2`'s removal ran. Two syncs in flight at once
are enough; the order of their responses only decides which variant of the damage shows.

### 4.2 Reproduction without GenClass

- `reserve`, natural order, localhost: 6 of 6 loads end with A's 2 messages missing in the browser (the sidebar shows
  `[b] > [a,b] > [b] > [a,b]`); with no other subscription (`HUNT_NO_OTHERS=1`) 0 of 4. The console order
  (`HUNT_DEBUG=1`): reservation → sync event → `GET /v1/account` (no A yet) → A upserted locally → POST subscription →
  poll of A starts → the first sync's `syncFromRemote` runs (removes A and its notifications) → the second sync re-adds
  A → the poll's 2 notifications are stored, or, when the removal comes after them, deleted. The page then shows A with
  "You haven't received any notifications for this topic yet." until the next poll (every 5 minutes; the re-added
  subscription keeps no `last`, so that poll restores them). Checked separately (`ntfy/reserve-reload.mjs`, 3 runs): 0 of 2 messages
  shown right after subscribing, still 0 ten seconds later, 2 after a reload.
- `--hold 1` (one sync response held until the next one was answered): 3 of 3 on every surface (table).
- `last-subscription.mjs` (bug 2): 3 of 3 runs browser 2 keeps the topic after the sync event and after a reload;
  `--keep 1` (a second topic stays) 0 of 3.

### 4.3 Root cause (paths and lines at `8ed8684`)

- `web/src/app/AccountApi.js:445-478` `sync()`: `const account = await this.get();` (451) then applies language, date
  and time formats, notification prefs and `subscriptionManager.syncFromRemote(...)` (472-474), with nothing that ties
  the fetched account to the local state it is applied over.
- Its callers: `web/src/components/hooks.js:45` (`handleInternalMessage`: every `{"event":"sync"}` on the account's
  `st_` topic), `hooks.js:367` (mount), `Navigation.jsx:120` (account button). Nothing serialises them. (The brief also named a sync "at 45 s and every 15
  min": that timer, `AccountApi.js:32-33` and `runWorker()`, only extends the token.)
- The server publishes the event after each successful account change: `server/server_middleware.go:170-178`
  `withAccountSync` → `publishSyncEventAsync`, wrapped around settings, subscription add/change/delete and reservation
  add/delete (`server/server.go:836-846`).
- The UI writes locally first, then calls the API: `SubscribeDialog.jsx:36-48` `subscribeTopic` (`upsert`, then
  `addSubscription`), `SubscribeDialog.jsx:129` (the reservation is posted before `subscribeTopic`, so its sync event
  carries an account without the topic), `SubscriptionPopup.jsx:159-162` (`remove`, then `deleteSubscription`),
  `SubscriptionPopup.jsx:300-304` (`setDisplayName`, then `updateSubscription`), `Preferences.jsx` (`prefs.setX`, then
  `updateSettings`).
- `web/src/app/SubscriptionManager.js:109-139` `syncFromRemote` upserts the remote rows and removes every local
  non-internal row missing remotely; `remove` (163-166) deletes the subscription's notifications too.
- Bug 2: `server/types.go:406` `Subscriptions ... json:"subscriptions,omitempty"` and `AccountApi.js:472`
  `if (account.subscriptions)`.
- `hooks.js:80-81` already says "Race condition: sometimes the subscription is already unsubscribed from account sync
  before the message is handled".

### 4.4 The fix (`ntfy.patch`)

In `AccountApi.js`: a counter `this.changes`, incremented at the start of the six methods whose changes `sync()`
applies back (`updateSettings`, `addSubscription`, `updateSubscription`, `deleteSubscription`, `upsertReservation`,
`deleteReservation`); `sync()` reads it before the fetch and skips applying the account when it moved, with a log line.
Skipping loses nothing: the change makes the server publish its own sync event, and that sync's fetch starts after the
change. And `syncFromRemote(account.subscriptions ?? [], ...)` instead of the `if`. Diff: `AccountApi.js` +17 −3. An
earlier draft serialised the syncs (one at a time); it would not have fixed the `reserve` case, where the stale fetch is
older than a local write rather than than another fetch, so it was dropped.

### 4.5 Tests

| test | unfixed | fixed |
|---|---|---|
| `AccountApi.test.js` "removes the last local subscription when the account has none" | fails 3/3 | passes 3/3 |
| `AccountApi.test.js` "skips an account that was fetched while the account was changed locally" | fails 3/3 | passes 3/3 |
| `e2e/reservations.spec.js` "reserving a topic while subscribing keeps its messages" (holds the account fetches until the app stored the topic's messages, at most 3 s) | fails 3/3 (0 notifications of 2) | passes 3/3 |
| `e2e/settings.spec.js` "a slow account sync doesn't undo a newer settings change" (holds the first sync's response until the second was answered, at most 2 s) | fails 3/3 | passes 3/3 |
| `e2e/subscribe.spec.js` "subscriptions and display names sync to the account" + one assertion: the second browser drops the topic | fails 3/3 | passes 3/3 |
| whole Vitest suite (`npm test`) | 125 + 2 failing | 127 passed |
| whole Playwright suite | 71 passed before the change | 73 passed: the 71 existing specs and the 2 new ones, 3.1 min |
| `npm run lint`, `npm run format:check` | 8 warnings, 0 errors (all eight existed before) | the same; prettier clean |

The reservation spec was first written without any hold; on the unfixed code it failed 3 of 3 on an idle machine but
only 2 of 3 and then 1 of 3 while the machine was busy (the stale fetch then lands before the poll stored the
messages, and nothing is lost), so it holds the account fetches until the messages are stored. The specs ran against the
hunt servers through ntfy's `NTFY_E2E_BASE_URL` mode (both variants side by side); the full suite ran in ntfy's
default mode (its own `server.mjs` on 12586) on the fixed binary.

### 4.6 The fixed variant, and what remains

Explore on the fixed build: `subscribe` and `reserve` no race (0 of 18 each), oracle 0 of 24 each, no sidebar flicker
on `reserve`. `unsubscribe`: the browser and the server agree in all 24 loads, but explore reports RACE in 1 of 6 at
300 ms and 6 of 6 at 900 ms (there the two fifo baselines are the odd ones): one order ends on "It looks like you don't
have any subscriptions yet.", the other on "Loading notifications …" for topic B, which no longer exists. The sidebar
history of those loads (`[b] > [] > [b] > []`) shows B coming back for a moment: a sync that lands while
`subscriptionManager.remove(B)` is writing IndexedDB, before `deleteSubscription()` increments the counter, still
applies; it re-adds B, `handleUnsubscribe`'s `first()` then returns B and navigates to it, and the next sync removes B
again (with the empty-list fix it does; without it B would stay). Without GenClass, with every account response delayed
by 800 ms in order (`ntfy/unsubscribe-delay.mjs`), the fixed build ended on the right page 3 of 3 times, its log
showing the stale sync skipped. So the fix narrows the window from the whole
fetch to the local write, and the data always converge, but a sync landing inside that window can still flicker a topic
or settings value and misplace the page. Closing it fully means counting the change before the local write: incrementing
the counter at the five UI call sites (`subscribeTopic`, `handleUnsubscribe`, `handleSave`, `maybeUpdateAccountSettings`
and the language select), or moving the local write into the `AccountApi` methods. That is a larger diff in the
maintainer's components, so the draft offers it as a follow-up question rather than putting it in the patch.

## 5. Time spent and what the sender must do

Time: about 1 h 20 min by the clock (16:33 to about 17:55 UTC). Setup (clone, both builds, ntfy's suite) took about
15 minutes; the rest overlapped, since the explore sessions, controls and reproductions ran as background batches
while the fix, the tests and this report were written. Nothing was blocked.

Before sending (also in `ntfy-issue.md`): ntfy's `docs/ai-policy.md` asks that the maintainer not be "the first human to
read your code" and that issue and PR text be written or at least edited by the sender. So the sender must reproduce the
`reserve` case by hand in a browser (two topics, one with messages, "Reserve topic" on; section 7 has the steps), read
the diff line by line, run `npm test` and the three specs, rewrite the issue and PR text in their own words, and search
the tracker again for duplicates since 2026-11-03.

## 6. Problems with GenClass itself

1. **False RACE on every settings session (36 of 36 reordered loads).** ntfy's Language select shows three random flags
   per page load ("Language 🇭🇺 🇬🇧 🇹🇷"). The noise rule ignores page lines that differ between the two baselines, but
   each seeded load brings a new random line, so every seeded run had "page text only in this run" and was reported as
   RACE. Digit blanking does not help (no digits). The app cannot opt the row out either: `data-genclass-ignore`
   removes form values from the snapshot (`src/agent/index.ts:181`), but the page text is `body.innerText`
   (`src/agent/index.ts:354`) with nothing excluded. Suggestions: apply `[data-genclass-ignore]` to the page text, and
   treat a line whose position matches a baseline line that differs between the baselines as noise.
2. **`~hedge` keys GenClass never sent.** One `reserve` load recorded `GET /v1/account#2~hedge` with no hedge in observe
   mode: `src/agent/schedule.ts:212` names any request whose causal parent has the same signature `<parent>~hedge`. Here
   the app's own second account fetch (caused by a sync event that arrived during the first fetch's response chain) got
   it, so that load had no `GET /v1/account#3`, and its keys no longer matched the other loads'. Suggestion: suffix
   `~hedge` only for an op the runtime itself started as a hedge (the `(hedge)` detail in `observe/fetch.ts:634`).
3. **A buggy baseline makes the correct runs the "race".** In unfixed `unsubscribe` the fifo baselines (with the added
   latency) ended with the bug, and the report listed the correct seeded runs as RACE with "page text only in this run:
   You haven't received any notifications." The verdict is right (the page depends on the order), but a reader takes
   "this run" as the broken one. Saying in the report that a race shows which state each side ended in, and that either
   may be the wrong one, would help.
4. **Explore could not produce the settings flip-back.** The bug needs a sync response still in flight when the next
   change is made, about a second at Playwright's pace; uniform delays up to 900 ms gave 0 of 36 such overlaps. Neither
   `focus` (a signature last) nor a larger `slow_ms` (all responses slower) expresses "hold this response until the next
   request of the same signature is answered", which is what the plain reproduction does and what makes this class of
   bug (a fetch triggered by a server push) testable. A schedule rule for it, or a `slow_ms` that applies to one
   signature only, would.
5. **A bug present in every order is invisible to explore by design.** The `reserve` message loss happens in natural
   order (6 of 6) but explore's runs, slowed down, kept the messages (the slower poll response landed after the
   removal), and it reported "no race" at 300 ms. Correct by its definition; worth one sentence in AGENT.md section 8.
6. **Minified React state in the internal tier.** Every session listed `state "showMenu_3.state0": baseline "4", this
   run "3"` (a counter in a production bundle's component) as internal state; harmless, but it is in most reports and
   names nothing a developer can find.

No tool errors; the bridge, explore, explain and findings worked as documented. The environment's 30-minute limit on a
background command stopped the hunt server once (not GenClass).

## 7. Reproducing

```bash
# this repository, both packages built; ntfy built as in section 1 and its e2e server running on 12586
T=tk_...   # the admin token server.mjs printed
node docs/adoption/hunts/ntfy/explore.mjs --token $T --surface subscribe --slow 300,600,900 --runs 6 --out /tmp/ntfy-explore
GENCLASS=0 node docs/adoption/hunts/ntfy/explore.mjs --token $T --surface reserve --runs 6            # control: messages lost
GENCLASS=0 HUNT_NO_OTHERS=1 node docs/adoption/hunts/ntfy/explore.mjs --token $T --surface reserve --runs 4   # kept
GENCLASS=0 node docs/adoption/hunts/ntfy/explore.mjs --token $T --surface prefs-twice --runs 3 --hold 1      # flip-back
node docs/adoption/hunts/ntfy/last-subscription.mjs --token $T --runs 3                                    # bug 2
# the patch and its tests
cd ~/targets/ntfy && git checkout 8ed8684 && git am /path/to/docs/adoption/hunts/ntfy.patch
(cd web && npm test && npx playwright test reservations.spec.js settings.spec.js subscribe.spec.js)
```

By hand, in a browser, for the sender (no tools): log in to a local ntfy with reservations enabled and a tier that
allows them; subscribe to one topic; publish two messages to a second topic (`curl -d hi localhost/<topic>`); open
"Subscribe to topic", enter the second topic, turn on "Reserve topic", Subscribe. The topic opens with "You haven't
received any notifications for this topic yet." although the server has both messages (`curl localhost/<topic>/json?poll=1`
with the user's credentials); they come back with the next poll, up to five minutes later, or on reload.

Results are summarised in [ntfy/results/](ntfy/results/) (the explore summaries per surface and variant, with each
load's oracle line and delivery order).
