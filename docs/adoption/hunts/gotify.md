# Race hunt: Gotify server WebUI (master `dd06dc7`)

A GenClass race hunt on the Gotify server's WebUI (gotify/server, `ui/`: React 19, MobX 6, axios), run on 2026-11-03
in a cloud session. The real `@genclass/runtime` (0.3.0-beta.5, this repository at `c1c9e14`) was injected into the
WebUI by Playwright, and the real `@genclass/mcp` (0.2.1) was driven the way a coding agent drives it. Gotify's source
was not modified for the hunt. The fix is a patch for the maintainers: [gotify.patch](gotify.patch), with the draft
issue, pull request and commit text in [gotify-issue.md](gotify-issue.md). Nothing was sent to Gotify's repository,
chat or maintainers.

**Status: ready to send** (after the by-hand items in `gotify-issue.md`: reproduce in a browser, check v3.1.1, run
the test).

**Headline.** One real race, found by `genclass_explore` and reproduced without GenClass. `MessagesStore.loadMore`
has one `loading` flag shared by every message list. If you open an application while the "All Messages" list is still
loading, or click Refresh twice, the new list's load is skipped, nothing retries it, and the view stays on the spinner
until you navigate away and back.

- **Explore:** RACE in all three sessions of the navigation scenario (2, 6 and 4 of 6 reordered loads at 300, 600 and
  900 ms). The harness's own DOM oracle saw the stuck spinner in 2, 2 and 4 of 8 loads.
- **Without GenClass:** a Playwright script that only delays `GET /message?since=0` by 600 ms got the stuck spinner in
  10 of 10 runs for navigation and 10 of 10 for double Refresh. Without the delay it was 0 of 10 for both.
- **The fix:** four changed lines (track the in-flight load per list) plus one e2e test in the project's
  puppeteer suite. The test failed 3 of 3 before the fix and passed 3 of 3 after. The delayed script went to 0 of 10
  and 0 of 10. On the fixed build, no load stuck in 48 explore loads (section 5).

Three more confirmed WebUI problems (a message lost during the first page load, double submit on the create dialogs,
a second DELETE when leaving the page) are in section 6. They are not in the patch. The duplicate entries of open
issue #680 did not appear in direct connections (0 of 20). They appeared in 2 of 20 when the socket passed through one
extra relay hop with no added delay, and 10 of 10 with a 600 ms socket delay (section 6.1). That is a lead for #680,
not a confirmed cause.

Sections: 1 setup, 2 how the WebUI was driven, 3 scenarios and verdicts, 4 the finding, 5 fix, test and fixed
variant, 6 the other findings and #680, 7 problems with GenClass itself, 8 time spent, 9 reproducing.

## 1. Setup

| what | version |
|---|---|
| Gotify server | gotify/server master `dd06dc77190696e93d3297b9a733711516fb17d9` (2026-10-25, "ci: update golangci-lint"); latest release v3.1.1, whose `ui/src/message/` is byte-identical |
| Go | 1.26.0 (downloaded through `GOTOOLCHAIN=auto` from go.mod; the system has 1.24.7), gcc 13.3 for `mattn/go-sqlite3` |
| UI toolchain | Node 22.23.4, yarn 1.22.22, React 19.2.7, MobX 6.16.1, vitest 5.0.0, puppeteer 25.2.1 |
| database | SQLite (Gotify's default) |
| browser | Chromium 1243 (Playwright 1.63.0's build), used by Playwright and, through `PUPPETEER_EXECUTABLE_PATH`, by Gotify's puppeteer tests |
| GenClass | `@genclass/runtime` 0.3.0-beta.5 and `@genclass/mcp` 0.2.1 from this repository at `c1c9e14`, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |

Commands, in order (Gotify's own docs, gotify.net/docs/dev-server-and-tests):

```bash
git clone https://github.com/gotify/server.git ~/targets/gotify && cd ~/targets/gotify   # at dd06dc7
(cd ui && PUPPETEER_SKIP_DOWNLOAD=1 yarn install --frozen-lockfile && yarn build)       # ui/serve.go embeds ui/build
GOTOOLCHAIN=auto go build -o ~/targets/gotify-bin .                                      # dev mode, for the hunt
mkdir -p ~/targets/run && cd ~/targets/run && echo GOTIFY_SERVER_PORT=8080 > gotify-server.env && ~/targets/gotify-bin
# production builds, as the e2e tests use them (Makefile test-js):
go build -ldflags="-X main.Mode=prod" -o ~/targets/gotify-prod-unfixed .                # and -fixed after the patch
GOTIFY_SERVER_PORT=8082 ~/targets/gotify-prod-unfixed   # in its own directory (own sqlite): plain reproductions
GOTIFY_SERVER_PORT=8081 ~/targets/gotify-prod-fixed     # in its own directory: the fixed variant
```

Login `admin` / `admin` (config defaults). The harnesses seed two applications, "Backup" and "Hunt", and 20 messages
(10 each) through the REST API with basic auth. Each later scenario adds its own uniquely named messages, apps or
clients.

## 2. How the WebUI was driven

[gotify/hunt.mjs](gotify/hunt.mjs) follows the Gitea harness. A Playwright route rewrites `index.html` so that it loads
`packages/runtime/dist/genclass.global.js` from a virtual same-origin path, with `init({ model: false, telemetry: false,
report: "silent" })`. It then connects `dist/agent.js` to an MCP bridge started in-process with `serve()`. Each load
gets a fresh browser context (with the `local-network-access` permission) that reuses one login cookie from
`POST /auth/local/login`. GenClass does not discover MobX stores, so the injected script mirrors what the page shows
with `rt.atom()` from a `MutationObserver`:

- `heading.text`: the `main h4` texts
- `messages.spinner` and `messages.titles`: whether the list area is a `CircularProgress`, and the message titles
- `navigation.apps`: the application links
- `appTable.names` and `clientTable.names`: the two tables

Those mirrors, the page text, the form values, the writes and the errors are what explore's verdict compares. For
each latency (`slow_ms` 300, 600, 900), one explore session runs: `genclass_explore start` with `runs: 6`, then 2
request-order baselines plus 6 seeded loads, the same steps each load, then `report`, `findings` and `explain`. After
`whenSettled()`, every load also prints an oracle of the harness's own, read from the DOM and the REST API, and the
delivery order the agent link recorded.

[gotify/repro.mjs](gotify/repro.mjs) is the reproduction without GenClass: plain Playwright, no injected script.
Latency comes from `page.route` waiting before it forwards one named request (or, for the socket, from
`page.routeWebSocket` holding a frame). It runs 10 runs per case and reports "bug in N of 10".

## 3. Scenarios and verdicts

Explore verdict as reported. The oracle column counts loads in which the harness's own check saw the bug: baselines
(2) / seeded loads (6). Result files: [gotify/results.json](gotify/results.json) (summarised with
[gotify/summarise.mjs](gotify/summarise.mjs)) and `gotify/results/unfixed/*.txt` and `gotify/results/fixed/*.txt`
(each load's line, the report, the findings and the explanation).

| scenario | slow_ms | explore verdict | "along the way only" | oracle: bug in baselines / seeded | what the RACE lines were |
|---|---|---|---|---|---|
| nav-during-load | 300 | RACE 2 of 6 | - | 0 of 2 / 2 of 6 | **real**: the stuck spinner (section 4) |
| nav-during-load | 600 | RACE 6 of 6 | - | 2 of 2 / 0 of 6 | **real**, broken side is the baseline (section 7 item 1) |
| nav-during-load | 900 | RACE 4 of 6 | - | 2 of 2 / 2 of 6 | **real**, broken side is the baseline |
| refresh-twice | 300 | RACE 1 of 6 | - | 2 of 2 / 5 of 6 | **real**: the one seeded load that recovered |
| refresh-twice | 600 | no race | - | 2 of 2 / 6 of 6 | broken in every order: invisible to explore |
| refresh-twice | 900 | no race | - | 2 of 2 / 6 of 6 | broken in every order |
| refresh-once (control) | 300 | no race | - | 0 of 2 / 0 of 6 | |
| refresh-once (control) | 600 | RACE 4 of 6 | - | 0 of 2 / 0 of 6 | false: "8m ago" against "9m ago" |
| refresh-once (control) | 900 | RACE 4 of 6 | - | 0 of 2 / 0 of 6 | false: "8m ago" against "9m ago" |
| push-during-load | 300 | RACE 6 of 6 | - | 2 of 2 / 6 of 6 (message lost) | false: each load's pushed message changes the first row's app name |
| push-during-load | 600 | no race | - | 2 of 2 / 6 of 6 (lost) | (the same text was ignored as noise: the baselines differed) |
| push-during-load | 900 | no race | - | 2 of 2 / 6 of 6 (lost) | |
| create-app-double | 300 | no race | 3 of 6 | 2 of 2 / 6 of 6 (two apps) | `overwrote-newer` witnesses on `navigation.apps`, `appTable.names` (section 6.5) |
| create-app-double | 600 | RACE 1 of 6 | 1 of 6 | 2 of 2 / 6 of 6 | false: "16 minutes ago" against "17 minutes ago" |
| create-app-double | 900 | no race | 3 of 6 | 2 of 2 / 6 of 6 | |
| create-client-double | 300 | RACE 6 of 6 | - | 2 of 2 / 6 of 6 (two clients) | false: the clients table's countdowns ("44m" against "43m") |
| create-client-double | 600 | RACE 2 of 6 | 2 of 6 | 2 of 2 / 6 of 6 | false: countdowns |
| create-client-double | 900 | RACE 5 of 6 | - | 2 of 2 / 6 of 6 | false: countdowns |
| delete-then-leave | 300 | RACE 6 of 6 | - | 2 of 2 / 6 of 6 (two DELETEs) | false: "3m ago" against "4m ago" |
| delete-then-leave | 600 | no race | - | 2 of 2 / 6 of 6 | |
| delete-then-leave | 900 | no race | - | 2 of 2 / 6 of 6 | |

In total: 21 sessions and 168 loads on the unfixed build, with 12 RACE verdicts. 4 were real (the section 4 bug) and
8 were false reports: 7 on time text, 1 on data the scenario itself changed. Explore found the section 4 bug in all 3
navigation sessions and in 1 of the 3 double-Refresh sessions. The other three confirmed problems (sections 6.2 to
6.4) happen in every order, so explore's comparison cannot see them; the harness's oracle did.

What the lines were:

- **nav-during-load**: a real race (section 4). Request order delivers `GET /application` (requested first) before
  `GET /message?since=0`, so the "Backup" link is there while the first page is still in flight, and the click lands
  in the window. Seeded orders that deliver the messages first close the window. At 300 ms the baselines were fine
  and two seeded loads stuck. At 600 and 900 ms the baselines stuck and the seeded loads differed from them.
- **refresh-twice**: the same bug, but explore cannot see it as a race. Both clicks come at Playwright's pace, well
  inside any latency, so the spinner sticks in every order: 8 of 8 loads at 600 and at 900 ms gave "No race found".
  At 300 ms one seeded load delivered the first refresh before the second click and recovered, which is the "1 of 6".
  The plain reproduction (section 4.2) is what shows it.
- **refresh-once**: the control. One click never sticks (0 of 24). The RACE lines at 600 and 900 ms are relative
  times only ("8m ago" against "9m ago": the loads straddled a minute boundary), so they are false reports (section 7).
- **push-during-load**: the pushed message never appeared in any load (section 6.2). The RACE lines ("Backup" only in
  the baseline, "Hunt" only in this run) come from the data: every load pushes a new message to "Hunt", so the first
  row's application name changes between loads. They are a harness artefact, not an order dependence (section 7).
- **create-app-double / create-client-double**: two entities in every load, whatever the order. That is a double
  submit, not an order dependence (section 6.3).
- **delete-then-leave**: two DELETEs in every load (section 6.4).

## 4. The finding

### 4.1 What explore saw

Session `nav-during-load`, 600 ms. Both baselines ended with the heading "Backup", the spinner, and no rows. All 6
seeded loads ended with Backup's rows. The report, reduced (run r11, seed 1; the other five are the same):

```
RACE: 6 of 6 reordered run(s) ended in a different state than the baseline (responses in request order)
- run r11 (seed 1):
    page text only in this run: "Backup", "Backup", "Backup", "Backup"        (the rows' application name)
    state "heading.text": baseline "\"Backup | \"", this run "\"Backup\""     (" | " is the empty spinner page's h4)
    state "messages.spinner": baseline "true", this run "false"
    state "messages.titles": baseline "\"\"", this run "\"seed 19 | seed 17 | seed 15 | seed 13 | seed 11…\""
    state "iL.state0": baseline "(absent)", this run "1793724363424"         (a discovered timer, section 7)
```

`genclass_explain` of the finding (f2) also lists `requests sent to "GET /application/:id/message": baseline
"(absent)", failing run "1"`: in the baseline the application's messages were never requested. Its recorded steps
of the seeded run, in causal order (times from `connectAgent`, the schedule's holds in brackets):

```
+0.330s delivered GET /current/user#1 (held 219 ms)
+0.332s send GET /application#1 via GET /current/user
+0.347s send GET /message#1 "?since=0" via GET /current/user
+0.728s delivered GET /application#1 (held 371 ms)
+0.738s write navigation.apps by GET /application#1: "" → "Backup | Hunt | …"
+0.758s delivered GET /message#1 (held 401 ms)
+0.766s write messages.spinner by GET /message#1: true → false
+0.973s action 0: click button "Backup"
+0.985s write heading.text by action 0: "All Messages" → "Backup | "; messages.spinner: false → true
+0.987s send GET /application/:id/message#1 "?since=0"
+1.184s delivered GET /application/:id/message#1 (held 192 ms)
+1.188s write messages.spinner by GET /application/:id/message#1: true → false
Delivery order: GET /current/user#1 → GET /application#1 → GET /message#1 → GET /application/:id/message#1
```

In this seeded run `GET /message#1` reached the app before the click, so the click found no load in flight and sent
`GET /application/:id/message`. In the baselines (load lines in `gotify/results/unfixed/nav-during-load-600.txt`), the order was
`GET /current/user#1 then GET /application#1 then GET /message#1`, with no fourth request. The click came while
`GET /message#1` was still held, and the application's request was never sent.

Note on direction: at 600 and 900 ms the *baseline* is the broken page and the seeded runs are correct. Explore's
finding still calls the seeded run "the failing run", its replay arms that (correct) order, and its generated
regression test asserts that the page does *not* show "Backup". So that test would fail on the fixed app (section 7,
item 1). The verdict "the page depends on response order" was right; the explanation of which side is wrong was not.
At 300 ms the direction was right: the baselines were fine and two seeded loads stuck.

### 4.2 Reproduction without GenClass

`node docs/adoption/hunts/gotify/repro.mjs --gotify http://localhost:8082 --case <case> --n 10 --delay <ms>` on the
unfixed production build:

| case | delay on `GET /message?since=0` | unfixed (`:8082`) | fixed (`:8081`) |
|---|---|---|---|
| nav-during-load (click "Backup" as soon as it is listed) | 0 ms | 0 of 10 | 0 of 10 |
| nav-during-load | 600 ms | **10 of 10** stuck (`spinner=1 rows=0 of 10`) | 0 of 10 |
| refresh-twice (list loaded, then two clicks on Refresh) | 0 ms | 0 of 10 | 0 of 10 |
| refresh-twice | 600 ms | **10 of 10** stuck (`spinner=1 rows=0`) | 0 of 10 |

By hand: Chrome DevTools throttling with 600 ms latency, then the same two actions. The sender is asked to do this
before filing (`gotify-issue.md`).

### 4.3 Root cause (lines at `dd06dc7`)

1. `ui/src/message/MessagesStore.ts` line 28: `private loading = false;`, one flag for the whole store, which holds
   one `MessagesState` per application plus `-1` for All Messages.
2. Lines 49 to 71, `loadMore(appId)`: `if (!state.hasMore || this.loading) return`. Then `this.loading = true`, the
   request, the page appended to `state` (the object captured before the `await`), and `this.loading = false` in
   `finally`. While any list is loading, a `loadMore` for any other list returns without doing anything.
3. `ui/src/message/Messages.tsx` lines 54 to 58: `useEffect(() => { if (!messagesStore.loaded(appId))
   messagesStore.loadMore(appId) }, [appId])`. The load is attempted once per `appId` change, and the view renders
   `LoadingSpinner` while `!loaded(appId)` (line 150). The skipped load is never retried, so the spinner stays until
   `appId` changes again.
4. `refreshByApp` (lines 161 to 165): `clearAll()` (a new, empty state object per list) and then `loadMore`. A second
   click while the first refresh's request is in flight clears again, and its `loadMore` is skipped. The first
   request then completes into the state object the second `clearAll` discarded, so the visible state never gets
   `loaded = true`.

The shared flag dates from 2018 (`b8c6fb6`, "Move message stuff into own folder"). Before #660 (2024, the spinner of
issue #658) the same state rendered "No messages". Open maintainer PR #917 ("chore: refactor out axios") rewrites this
store but keeps the shared flag (checked at its head `a4640eb`).

### 4.4 The fix

`gotify.patch`, `ui/src/message/MessagesStore.ts`:

```diff
-    private loading = false;
+    private loading = new Set<MessagesState>();
 ...
-        if (!state.hasMore || this.loading) {
+        if (!state.hasMore || this.loading.has(state)) {
             return Promise.resolve();
         }
-        this.loading = true;
+        this.loading.add(state);
 ...
         } finally {
-            this.loading = false;
+            this.loading.delete(state);
         }
```

Two loads of the same list still cannot overlap: the scroll's `endReached` and the effect are still de-duplicated. A
load for another list, or for the fresh state `clearAll` made, is no longer blocked. The `Set` stays non-observable,
like the flag it replaces. The patch applies to `dd06dc7` with `git apply`, and to PR #917's head with
`git apply -3` (plain `git apply` fails there on shifted context).

## 5. Test and fixed variant

The test is in the project's suite: `ui/src/tests/message.test.ts`, a new `it` before "does logout", named
"loads an app opened while all messages are still loading". With `page.setRequestInterception(true)`, it holds every
request ending in `/message?since=0` until released, reloads, navigates to "Backup" with the file's own `navigate`
helper, releases, and expects `extractMessages(1)` to equal `[backup3]` (the state the previous tests leave). It then
removes the handler and turns interception off. Run as the suite runs (production build, Go binary copied through
`GOTIFY_EXE`, headless):

```bash
cd ~/targets/gotify/ui && CI=true GOTIFY_EXE=$HOME/targets/gotify-prod-unfixed \
  PUPPETEER_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome \
  npx vitest run src/tests/message.test.ts --disable-console-intercept --no-file-parallelism
```

| variant | `message.test.ts`, 3 runs each |
|---|---|
| unfixed (`dd06dc7` + the test) | 3 of 3: **1 failed** (the new test: `TimeoutError: Waiting failed: 30000ms exceeded`), 31 passed |
| fixed (`gotify.patch`) | 3 of 3: **32 passed** |

On the fixed build, also: the whole UI suite (`yarn test --run`, what `make test-js` runs) gave 6 of 7 files passed,
119 tests passed, 6 skipped. The one failing file is `oidc.test.ts`, whose three describes start Dex in Docker
(`ghcr.io/dexidp/dex`); this container has a Docker client but no daemon, so they fail in `beforeAll`
("dex … exited unexpectedly (code=1)"). Unrelated to the patch, and the sender should run them. `yarn lint`,
`yarn testformat` and `npx tsc` were all clean. `go test ./...` was not run: the patch touches no Go file.

Explore on the fixed build (`:8081`, the same harness and steps):

| scenario | slow_ms | explore verdict | oracle: stuck in baselines / seeded | what the RACE lines were |
|---|---|---|---|---|
| nav-during-load | 300 | RACE 4 of 6 | 0 of 2 / 0 of 6 | false: "9m ago" against "10m ago" |
| nav-during-load | 600 | no race | 0 of 2 / 0 of 6 | |
| nav-during-load | 900 | no race | 0 of 2 / 0 of 6 | |
| refresh-twice | 300 | no race | 0 of 2 / 0 of 6 | |
| refresh-twice | 600 | no race | 0 of 2 / 0 of 6 | |
| refresh-twice | 900 | RACE 3 of 6 | 0 of 2 / 0 of 6 | false: "11m ago" against "12m ago" |

So no load of the fixed build stuck (0 of 48, against 31 of 48 on the same two scenarios before the fix: 8 of 24 navigating, 23 of 24 double Refresh). Explore still
gave a race-like verdict in 2 of 6 sessions, both on relative times only: that is GenClass's false-report rate on
this page once it no longer depends on order. The finding's replay was not used as the check after the fix: it arms
the seeded order, which was the *correct* one at 600 ms (section 7 item 1), so "not reproduced" would prove nothing.

## 6. The other findings, and #680

### 6.1 #680 "Sporadic Duplicate entries": a code path, and a lead

#680 (open since 2024-08-24) reports a message shown twice, "mostly the first time the app was used", with deleting
one removing both. The maintainer asked six questions about the reporter's environment (tab kept open, recovered
or pinned tab, the "No network connection" banner, browser and OS, when it appears). They are unanswered. A session
cannot answer them: they are about the reporter's setup.

In the WebUI code, the path that shows one database row twice is `MessagesStore.publishSingleMessage` (lines 73 to
81). It `unshift`s every `/stream` frame into each loaded list with no check by id, and `loadMore` appends pages with
no check either. So a message is shown twice if it is in the first page and its socket frame arrives *after* that
page is applied. The server creates a message and then notifies (`api/message.go` lines 404 to 408), so this needs the
page's query to run between the insert and the notify, and the frame to reach the browser after the page's response.
That window is the server's own few microseconds plus any difference between the socket's and the HTTP response's
paths (a proxy, for example). `repro.mjs` pushes a message 300 ms after the socket opens and just before
`GET /message?since=0` is forwarded, so the page contains the message, and then counts how often it is shown:

| case (unfixed build, `:8082`) | socket path | shown twice |
|---|---|---|
| `socket-direct` | direct, no route on the socket | 0 of 20 |
| `socket-late --delay 0` | through Playwright's `routeWebSocket` relay, frames passed on at once | 1 of 10, then 2 of 20 (runs 11 and 18) |
| `socket-late --delay 600` | the relay holds each frame 600 ms | 10 of 10 |

So the duplicate needs the socket frame to arrive after the first page's response. One extra hop on the socket's path
was enough for it to happen sometimes on localhost. The frame was produced before the page in every run. #680's
reporter runs nginx in front of Gotify, and "mostly the first time the app was used" fits a first page load. That is
consistent with this path but does not show it is what they hit: the relay here is Playwright's, not nginx.
GenClass could not explore it: it records WebSocket messages but never reorders them (AGENT.md section 3). No comment
on #680 is drafted for the first round. The measured material does not answer the six questions, which are for the
reporter, and the section 4 issue should go first and stand on its own. Once that one is settled, the table above is a
fair, short comment for #680: "a frame that reaches the WebUI after the first page shows the message twice; here is a
script; behind a relay it happened in 2 of 20 page loads". De-duplicating by `id` in `publishSingleMessage` and in
`loadMore`'s merge would close the path. That should be offered as a separate fix, with section 6.2.

### 6.2 A message pushed while the first page loads is lost (confirmed, not patched)

`publishSingleMessage` only adds a frame to lists that are already `loaded` (`exists`, line 167). A frame that arrives
while a list's first page is in flight is dropped. If the page was produced before the message was inserted, the
message is in neither: it is missing from the list until the next reload. The hunt's `push-during-load` scenario
pushes once the browser has the page's response but before the app does (GenClass holds it for `slow_ms`). The pushed
message was shown 0 times in 24 of 24 loads (300, 600 and 900 ms; section 3).

Without GenClass, `repro.mjs --case push-during-load` takes the response from the server (`route.fetch()`), pushes the
message, waits `--delay` ms and hands the response to the page. The message was missing in 10 of 10 runs with
`--delay 600` and in 10 of 10 with `--delay 0`. With 0 the push still falls between the server's answer and the page
receiving it, because the case builds that order, so 0 is not a control here. `socket-direct` above is the natural-order
control: the push comes before the request, and the message was shown once in 20 of 20.

The window in real use is the first page's transit time after the server's query, so it is narrow but real on slow
links. Fixing it means buffering or applying frames to not-yet-loaded lists and de-duplicating by id (the same change
as 6.1). That is larger than the four-line fix and touches what PR #917 rewrites, so it is left for a separate
conversation with the maintainers.

### 6.3 Double submit on Create (applications and clients; confirmed, not patched)

`AddApplicationDialog.tsx` (line 22, `submitAndNext`) and `AddClientDialog.tsx` keep the Create button enabled while
`appStore.create` / `clientStore.create` runs (POST, then a refresh `GET`). A second click in that time creates a
second entity with its own token. In the hunt (two Playwright clicks), 24 of 24 loads created two applications and 24
of 24 created two clients. The plain reproduction (`--case create-app-double`, two `click()` calls): two
applications in 10 of 10 runs with `POST /application` delayed 300 ms, and 0 of 10 at localhost speed, where the
dialog closed before the second click could land. Issue #572 (closed) asked the server to reject
duplicate names, and the maintainer answered that same-named applications can be valid. A client-side fix (disable the
button while the request is pending) is the usual one. It is not in the patch, to keep one change per pull request.
GenClass reported no `identical-in-flight` witness or `duplicate-request` finding for these two identical POSTs from
two clicks, in any of the 48 loads (section 7 item 6).

### 6.4 A second DELETE when leaving the page during an undo-delete (confirmed, low impact)

After the 5 s undo snackbar, `onExited` calls `removeSingle`. That method checks `pendingDeletes.has(id)` before its
`await axios.delete` and clears the entry only after it. If the page is left while that DELETE is in flight,
`pagehide` → `executePendingDeletes` sends a second DELETE for the same id, which the server answers 404. This is the
residual window of #1068: PR #1075 as merged only removed the `beforeunload` listener. Counted from the server's
request log (`method=DELETE path=/message/<id>`): two DELETEs (200, then 404) in 24 of 24 hunt loads. In the plain
reproduction (`--case delete-then-leave`, leave as soon as the DELETE is sent) it was 10 of 10 with the DELETE
delayed 600 ms and 10 of 10 with no delay. Playwright navigates within milliseconds of the request, so even
localhost's round trip is enough; a person closing a tab would hit it only on a slow link. The browser context's
request events saw only the first DELETE: the keepalive request sent during unload is visible in the server log only.

The user sees nothing: the message is deleted and the page is gone. Not worth its own issue. If #1068's thread is
reopened, the timing is here. Separately, Gotify's own `message.test.ts` (unmodified) ends with
`DELETE /message/1 → 404`. The single delete in "pushes a message via ui" stays pending, because the snackbar never
closes during the test, and runs at page close after "Delete all" already removed the message. That is harmless and
expected from the code.

### 6.5 Lists written in response order (observation)

`BaseStore.refresh` writes whichever `GET` list resolves last. In `create-client-double` at 600 ms, explore reported
one seeded run as "Along the way only": an `overwrote-newer` witness on `clientTable.names` by `GET /client`, which a
later response repaired. The table can flicker after quick successive changes. No load ended with a stale table.

## 7. Problems with GenClass itself

1. **Inverted direction when the request-order baseline is the broken run** (nav-during-load at 600 and 900 ms). The
   finding says "it shows "Backup" under "seed 1", not in request order", treating the correct seeded run as the
   failing one. `genclass_replay` arms the correct order. The generated Playwright test asserts
   `expect(snap.text).not.toContain("Backup")` three times, which passes on the broken page and fails on the fixed
   one. For a reader without a DOM oracle of their own, everything after the verdict points the wrong way. Explore
   assumes the baseline is correct. It could instead say "the baseline and the seeded runs disagree" and let the
   replay offer both orders, or generate a test only after asking which state is right.
2. **A bug present in every order is invisible to explore.** Double Refresh sticks in 8 of 8 loads at 600 and 900 ms,
   and explore says "No race found" both times. That is by design (explore compares orders), but the report's "No
   race found" sentence reads as a clean bill. A note when every compared load, the baselines included, ends with a
   spinner or a request that was never answered by a render would have pointed at it.
3. **Time text as RACE lines: the largest source of false reports.** 9 of the 14 RACE verdicts across the 27
   sessions (21 unfixed, 6 fixed) were time text only:
   - "8m ago" against "9m ago" (refresh-once 600 and 900, delete-then-leave 300, create-app-double 600, both fixed
     sessions with a verdict)
   - the clients table's expiry countdowns, "44m 6d 23h 44m" against "43m 6d 23h 43m" (create-client-double, all
     three sessions)

   The loads straddled a minute boundary. "N ago" is ignored only when the two baselines differ, so when both
   baselines fall on the same side of the minute it is reported. Countdowns in the "6d 23h 44m" shape are not
   normalised at all. Counting item 4's one, 10 of 14 RACE verdicts were false, and 4 were the real bug.
4. **Server data changed by the scenario itself.** In push-during-load every load pushes a message, so the first
   row's application name differs between loads, and explore reported RACE 6 of 6 ("Backup" only in the baseline,
   "Hunt" only in this run). Explore cannot know that a load wrote to the server. Here the harness made each load's
   data different. A `focus` or an "ignore text" option per session would let a harness exclude it.
5. **Discovered component timers in the evidence.** `iL.state0`, `iL_2.state0`, `iL_3.state0` (millisecond
   timestamps, a time-ago component's state) appear in every RACE line set as "baseline (absent), this run
   1793724363424". They were ignored as noise only when the two baselines differed. They are noise either way: a
   value that looks like the current time in milliseconds could be redacted like the "N ago" text.
6. **WebSocket frames are not reordered** (documented in AGENT.md section 3). #680's order (a socket frame after the
   first page) needed `page.routeWebSocket` in a plain script. For apps that merge a REST page with a stream, which is
   common, delaying stream frames per message would make explore cover that class.
7. **No `identical-in-flight` witness for a double Create.** In 48 loads, two identical `POST /application` (or
   `POST /client`) requests, started by two recorded clicks (`click button "CREATE"` twice in the scenario) and in
   flight together, produced no witness and no `duplicate-request` finding. AGENT.md section 2 says that case is
   counted. Not investigated further; one guess is that the emulated delay holds the first response in the page
   after the network finished, so the runtime may not count it as in flight.
8. **MobX stores are not discovered.** The verdicts compared the harness's `rt.atom()` mirrors of the DOM. That worked,
   but an app adopting GenClass would need to register its stores. `genclass_setup` could mention MobX.
9. **Harness ergonomics.** `whenSettled()` returned with the spinner still shown (correctly: nothing was in flight),
   so the oracle needed its own 300 ms wait. Not a bug, but worth a sentence in AGENT.md: settled means "no requests
   or timers pending", not "the page finished".

No tool errors or crashes. Every session recorded 8 of 8 planned loads, all of which reached a quiet point.

## 8. Time spent

About 45 minutes of wall-clock time in one session on 2026-11-03, from the clone at 16:34 UTC to the hand-back at
about 17:15 UTC. The parts overlapped, because the long runs went in the background (start times from file and log
timestamps):

- setup: clone at 16:34, UI and Go builds done at 16:36, server up at 16:36
- reading the code and the first harness runs: to 16:40
- fix and test: 3 failing runs at 16:41 to 16:43, 3 passing runs and the full suite by about 16:46
- the full hunt (27 explore sessions, 216 loads) and the plain reproductions (about 230 runs): 16:44 to 17:00, in
  the background
- tracker search, the drafts and this report: alongside, to the hand-back

## 9. Reproducing

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
# Gotify: section 1's commands; a dev or prod binary on :8080 (unfixed)
node docs/adoption/hunts/gotify/hunt.mjs --gotify http://localhost:8080 --surface nav-during-load \
  --slow 300,600,900 --runs 6 --log ~/targets/run/server.log --out docs/adoption/hunts/gotify/results/unfixed
#   surfaces: nav-during-load refresh-twice refresh-once push-during-load create-app-double create-client-double delete-then-leave
node docs/adoption/hunts/gotify/repro.mjs --gotify http://localhost:8082 --case nav-during-load --n 10 --delay 600
#   cases: nav-during-load refresh-twice push-during-load socket-late create-app-double delete-then-leave (--delay 0 is the control)
node docs/adoption/hunts/gotify/summarise.mjs <unfixed results dir> <fixed results dir> > docs/adoption/hunts/gotify/results.json
# the patch and its test: section 5
```
