# Race hunt: Paperless-ngx (paperless-ngx/paperless-ngx)

A GenClass race hunt against Paperless-ngx's Angular frontend, run on 2026-11-03 in a cloud session of the adoption
swarm (`docs/adoption/swarm.md`, brief `swarm-targets/paperless-ngx.md` on `adopt/briefs`). Everything ran on a local,
disposable instance; nothing was sent to the Paperless-ngx project.

**Status: needs owner decision.** Paperless-ngx's CONTRIBUTING says "We will not accept PRs that are entirely or mostly
AI-derived", so this hand-back contains no fix patch and no pull request text. It contains the evidence a person needs
to write the (small) fix and test by hand: the report, a reproduction that runs without GenClass, the root cause with
file and lines, failing Jest test sketches, and issue drafts in the project's bug form limited to observed behaviour
(the project allows AI-assisted bug reports when disclosed, section 10).

**Headline.** The global search box in the header shows the results of an earlier, shorter query under the query the
user typed. Type `doc`, pause past the 400 ms debounce, finish typing `document 12`: when the answer for `doc` arrives
after the answer for `document 12`, the dropdown lists `test document 1, 2, 3` under the input `document 12` and
stays that way. Explore found it in 1 of 6 reordered runs at 600 ms, 1 of 6 at 900 ms and 6 of 20 at 900 ms (seed 11),
0 of 6 at 300 ms and 0 of 20 at 600 ms (seed 11), with 0 false reports: in all 58 seeded loads explore's verdict and
the harness's own DOM oracle agreed, and the dropdown was wrong exactly in the loads where the `doc` response was
delivered last. Without GenClass, with plain Playwright holding the `doc` response 1.5 s: wrong in 5 of 5; the same
steps with no delay: 0 of 5. A variant: press Escape (which clears the box) while the `doc` search is out, and the
late answer reopens the dropdown with its results under the empty box (5 of 5 with a 1 s delay, 0 of 5 without).
Two smaller findings in the Notes tab: Ctrl+Enter pressed twice while a note is saving saves it twice (24 of 24 loads,
5 of 5 without GenClass; one press: 0 of 5), and on a direct load of a document's Notes tab the notes show no author
name (10 of 10 and 3 of 5 page loads with no added delay; 5 of 5 with `/api/users/` held 2 s). The document list,
the brief's control, showed no race (0 of 18), but its two filter requests never overlapped in those runs, so that
negative is weak (section 5).

## 1. Versions and commits

| what | version |
|---|---|
| Paperless-ngx | `paperless-ngx/paperless-ngx` at `cc15aa0180bb907a218d3b12e1e3471866652388` (`dev`, 2026-11-03 06:59 -08:00, "Fix: make index and llmindex init wait for tesseract language install (#14670)"), `src-ui/package.json` 3.4.1 |
| frontend | Angular `~22.2.3` (zoneless: `provideZonelessChangeDetection()` in `src-ui/src/main.ts` line 127), rxjs 7.8.2, `provideHttpClient(withFetch())`, Jest 30.5.2 via `@angular-builders/jest` |
| backend | Django 5.2.18, Python 3.12.3 (uv), SQLite in a temp dir, Celery eager, in-memory channel layer: the project's own `src-ui/e2e/backend.py` |
| GenClass | this repository at `c1c9e14` (main, 2026-11-03): `@genclass/runtime` 0.3.0-beta.5, `@genclass/mcp` 0.2.1, both built from source |
| Node, pnpm | Node 22.23.4 (Angular CLI 22.2.4 accepts `^22.22.3`), pnpm 11.15.1 |
| browser | Playwright 1.63.0 (this repository's), headless Chromium 153.0.8010.12 |

## 2. Setup

The brief's "Path A", the instance the project's own Playwright suite uses (`docs/development.md`, "Testing and code
style"; `ci-frontend.yml`'s e2e job runs it with no Redis):

```bash
git clone --depth 1 --single-branch --branch dev https://github.com/paperless-ngx/paperless-ngx.git ~/targets/paperless-ngx
cd ~/targets/paperless-ngx
apt-get install -y libmagic1                                   # the only apt package CI's e2e job installs
uv sync --python 3.12 --no-dev --frozen --no-install-package torch   # see below
cd src-ui && pnpm install --frozen-lockfile                    # 43 s
pnpm e2e:backend    # "Playwright backend ready in 13.1s": http://localhost:8001, 61 seeded documents, 4 notes on document 1
pnpm start:e2e      # ng serve --configuration=e2e: http://localhost:4200, API at :8001
```

One deviation: `uv sync --no-dev --frozen` as CI runs it failed because `download-r2.pytorch.org` (the PyTorch CPU
index `pyproject.toml` pins `torch` to) is denied by this session's network policy (the proxy answered 403 to
CONNECT). `--no-install-package torch` installs everything else; `e2e/backend.py` sets `PAPERLESS_AI_ENABLED=false`
and the instance started and served every surface below without it. Nothing under test imports torch.

In DEBUG the backend authenticates API requests whose `Referer` starts with `http://localhost:4200/` as the first
superuser (`src/paperless/auth.py` lines 40-48), so the UI needs no login. The status WebSocket does not get that
treatment (`ws://localhost:8001/ws/status/` answers 302 without a session), which is why the dashboard widget surface
was not run (section 5).

The instance was up about 6 minutes after the clone finished (backend ready 16:43, dev server 16:44 UTC).

## 3. How the app was driven

`docs/adoption/hunts/paperless-ngx/hunt.mjs` (the Gitea harness pattern, `hunts/gitea-explore.mjs`): it starts
`@genclass/mcp`'s `serve()` in-process and calls its tools over JSON-RPC; in Playwright it routes a virtual
same-origin path `/__genclass/rt/*` to `packages/runtime/dist/`, rewrites the dev server's `index.html` so its
`<head>` starts with the script-tag build, `GenClass.init({ model: false, telemetry: false, mode: "observe", ... })`
and a module that calls `connectAgent(rt)`; each load runs in a fresh context with the `local-network-access`
permission. Paperless-ngx's source was not touched for the hunt.

Angular keeps this state in components and signals, which GenClass does not discover, and no mirror atom was
registered: explore compared the page text, the form values and the requests sent. Next to it, each scenario has an
oracle of its own, read by the harness after `whenSettled()`:

| surface | steps (one page load each) | oracle |
|---|---|---|
| `search` | `/dashboard`, click the header search box, type `doc` (60 ms a key), wait 450 ms (the 400 ms debounce fires), type `ument 12` (30 ms a key) | the dropdown's document titles must be exactly `document 12` (what `GET /api/search/?query=document 12` returns on the seeded data) |
| `list` | `/documents`, Title & content filter: type `test`, wait 450 ms, type ` document 1` | the "N documents" line (recorded, not judged) |
| `notes` | `/documents/1/notes`, type a note, Ctrl+Enter, 40 ms, Ctrl+Enter | how many copies of the note `GET /api/documents/1/notes/` holds afterwards (must be 1); the harness deletes them after each load |

Each explore session: `genclass_explore start` with `runs`, `slow_ms`, `seed` and `route` set to the surface's path,
then 2 fifo baselines and the seeded loads, then `report` and `genclass_explain` on the first finding. The per-load
lines, verdicts and timelines are in `paperless-ngx/results/`.

**Harness fix during the hunt (GenClass problem, section 9 item 1).** The first full `search` session gave results
that did not hold up: in 7 of 8 loads at 300 ms only one search request had been sent. The plain Playwright probe
sent both requests every time. The agent link's quiet point waits for pending app timers of at most 1 s, but it only
wraps `setTimeout`; rxjs 7's `debounceTime` schedules with `setInterval` (`AsyncAction.requestAsyncId`), so
`whenSettled()` resolved while the `document 12` debounce was pending and the harness read the page before the
second request. Those sessions were discarded and the harness now waits 500 ms after the last key before
`whenSettled()` (`pastDebounce` in `hunt.mjs`); every number below is from after that change. A first `list` session
was discarded too, for a harness locator error that aborted every load right after page load.

## 4. Scenarios and verdicts

Explore's verdict as `genclass_explore report` printed it, next to the harness's oracle. "Reordered" counts the
loads in which the agent link recorded the `doc` response (`GET /api/search/#1`) delivered after the `document 12`
response (`#2`). Generated from the `results/*-summary.json` files.

| surface | slow_ms | seed, runs | explore verdict | oracle wrong | `#1` delivered last |
|---|---|---|---|---|---|
| search | 300 | 1, 6 | no race, 0 of 6 | 0 of 8 | 0 |
| search | 600 | 1, 6 | RACE: 1 of 6 | 1 of 8 (seeded run 1) | 1 |
| search | 900 | 1, 6 | RACE: 1 of 6 | 1 of 8 (seeded run 1) | 1 |
| search | 600 | 11, 20 | no race, 0 of 20 | 0 of 22 | 0 |
| search | 900 | 11, 20 | RACE: 6 of 20 | 6 of 22 (seeds 16, 22, 23, 25, 26, 28) | 6 |
| list (control) | 300 | 1, 6 | no race, 0 of 6 | n/a: 11 documents in 8 of 8 | n/a |
| list (control) | 600 | 1, 6 | no race, 0 of 6 | n/a: 11 documents in 8 of 8 | n/a |
| list (control) | 900 | 1, 6 | no race, 0 of 6 | n/a: 11 documents in 8 of 8 | n/a |
| notes | 300 | 1, 6 | RACE: 1 of 6 (+3 internal only) | 8 of 8 (two copies saved) | n/a |
| notes | 600 | 1, 6 | RACE: 2 of 6 (+2 internal only) | 8 of 8 (two copies saved) | n/a |
| notes | 900 | 1, 6 | RACE: 2 of 6 (+3 internal only) | 8 of 8 (two copies saved) | n/a |

Holds that ran out (a response released by the 1.5 s limit rather than the schedule; the report marks only the runs
it lists): none in any search run, 2 of the 4 notes runs listed at 600 ms and 4 of 5 at 900 ms.

Search: 8 RACE lines in 58 seeded loads; each was a load whose dropdown was wrong by the oracle, and the oracle found
no wrong load that explore missed. Overlap needs the `doc` response to still be out when `document 12` is sent
(about 0.75 s later at the harness's typing speed); at 300 ms of added latency that never happens, at 600 and 900 ms
it does when the seed gives the `doc` response a long delay and a lower priority.

Notes: the duplicate note was saved in every load, baselines included, so it is not an order race and explore
correctly does not report it as one (section 7.1). Explore's RACE lines there were two other things: a page that
listed "Notes 5" while the server held 6 (2 runs), and notes without their author name (3 runs, one per latency); sections 7.2 and 7.3.
"Internal only" lines were one `GET /api/documents/` fewer (the dashboard count refresh), not shown on the page.

## 5. Negatives and surfaces not run

- **Document list filter (the brief's control).** No race in 18 of 18 reordered runs, 11 documents in all 24 loads.
  The list cancels a superseded request (`DocumentListViewService.reload()` calls `cancelPending()`,
  `src-ui/src/app/services/document-list-view.service.ts` lines 252-254 and 326, `takeUntil(this.unsubscribeNotifier)`
  at line 340). But in the recorded orders only the page-load requests (`GET /api/documents/#1`, `#2`) were ever
  reordered; the two filter requests (`#3`, `#4`) never overlapped, so explore did not actually test the guard.
  Read this as "no race seen", not as "guard verified".
- **Dashboard saved-view widget** (`saved-view-widget.component.ts` lines 169-200: `reload()` on each
  `onDocumentConsumptionFinished()` with no guard against overlapping reloads). Not run: the trigger is a status
  WebSocket message after consumption, and the WebSocket needs a session login (it answers 302 to the DEBUG Referer
  path); consuming documents needs the OCR toolchain the e2e instance does not install. Unknown, not negative.
- **Notes delete** (`deleteNote` has no in-flight guard either): not run.

## 6. The finding: global search shows an earlier query's results

### 6.1 What explore saw (search, 900 ms, seed 11)

```
RACE: 6 of 20 reordered run(s) ended in a different state than the baseline (responses in request order) ...
- run r30 (seed 16):
    page text only in the baseline: "document 12 Jan 1, 2021"
    page text only in this run: "test document 1 Nov 3, 2026", "Open", "Open", "Download"
```

The timeline `genclass_explain` recorded for run r30, cut to the lines that matter (full text in
`results/search-slow900-seed11.txt`):

```
+1.866s action 0: click input "Search"
+1.880s action 1: type input "Search" = "document 12" (11 keystrokes over 894 ms)
+2.411s send GET localhost:8001/api/search/#1 "?query=doc" (action 1) via interval 0.13s
+3.183s send GET localhost:8001/api/search/#2 "?query=document 12" (action 1) via interval 0.24s
+3.704s delivered GET localhost:8001/api/search/#2 (held 443 ms)
+3.765s delivered GET localhost:8001/api/search/#1 (held 1.3 s)
```

In causal order: the debounce sends `query=doc`; the user keeps typing; 0.77 s later the debounce sends
`query=document 12`; its answer arrives and the dropdown shows `document 12`; 61 ms later the answer for `doc`
arrives and replaces it. The input still says `document 12`; the dropdown lists `test document 1`, `2`, `3` (with
their Open and Download buttons) and stays that way. Every response was delivered unchanged; only the order differed.

### 6.2 Reproduction without GenClass

`docs/adoption/hunts/paperless-ngx/repro.mjs` imports nothing from GenClass: plain Playwright, `page.route` fetches
each matching response from the real backend, waits, then delivers it unchanged. Same steps as the hunt.

| case | what is delayed | result |
|---|---|---|
| `search` | the `query=doc` response, 1.5 s | **5 of 5 wrong**: input "document 12", dropdown [test document 2, test document 3, test document 4] |
| `search-control` | nothing | 0 of 5 wrong: dropdown [document 12] |
| `escape` | every search response, 1 s; type `doc`, wait 450 ms, press Escape | **5 of 5 wrong**: the box is empty and the dropdown opens with the `doc` results |
| `escape-control` | nothing | 0 of 5 wrong (the results were already open, so Escape closed them) |

(Which three `test document` titles the `doc` search returns varied between runs of the instance; the full-text index
ranks them equally.)

In real use the delay needs no tool: a short prefix matches more documents than the finished query, so on a large
archive or a slow link the prefix's answer is the slow one. The measurements here only show the order matters; how
often it happens on a real install was not measured.

### 6.3 Root cause (paths under `src-ui/src/app/`, lines at `cc15aa01`)

`components/app-frame/global-search/global-search.component.ts`:

- lines 110-119: `queryDebounce.pipe(debounceTime(400), filter(...), distinctUntilChanged()).subscribe(text => { ...;
  if (text) this.search(text) })`: each debounced query calls `search()`; nothing cancels the previous one.
- lines 136-143: `search()` subscribes to `searchService.globalSearch(query.trim())` and, whenever that answer
  arrives, sets `searchResults`, clears `loading` and calls `resultsDropdown.open()`. There is no `switchMap`, no
  kept subscription to cancel and no check that the answer is for the current `query()`, so the last answer to
  arrive wins.
- lines 265-273: `reset()` (Escape with the dropdown closed, line 325-327; also after a result is chosen) clears
  `query` and `searchResults` but leaves the search in flight, which then sets the results and opens the dropdown
  again (the Escape variant).
- Read from the code, not measured: Enter with exactly one result in an open dropdown clicks that result (lines
  317-320), so if a stale answer has one result, Enter would open a document that does not match the box.

### 6.4 A fix idea (a note for the person who writes the fix; not a patch)

Keep the subscription and cancel it when a newer search starts and in `reset()` (or move the request into the
debounce pipe with `switchMap`, which cancels the previous inner request). With Angular's `withFetch()` the
unsubscribe aborts the request. This session checked the idea locally, without handing back the diff: the change
adds a `Subscription` field, unsubscribes it at the start of `search()` and in `reset()` (and clears `loading` there);
about 15 lines with the formatter's wrapping.

## 7. The Notes tab

### 7.1 Ctrl+Enter twice saves the note twice

`components/document-notes/document-notes.component.ts` lines 117-121: `noteFormKeydown` calls `addNote()` on
Ctrl/Cmd+Enter with no check of `networkActive()`. The Add button cannot do this: it is
`[disabled]="networkActive() || addDisabled()"` (`document-notes.component.html` line 14), and `addNote()` (lines
66-86) sets `networkActive` while saving and resets the form only when the answer arrives, so a second Ctrl+Enter
before then posts the same text again.

Measured: with GenClass, 24 of 24 loads saved two copies (the POSTs were 70 ms apart; explore delivered them in both
orders); without GenClass (`repro.mjs notes-double`, POST answers held 300 ms, presses 40 ms apart), 5 of 5 loads saved
two copies and the page listed both; one press (`notes-single`): 0 of 5. At local speed with no delay this needs a
second press within the round trip (tens of ms here), so it is most likely on a slow link, with a key held down
(auto-repeat) or with an impatient double press. Fix idea: check `networkActive()` in `noteFormKeydown` the way the
button's `[disabled]` does (checked locally, as above). The `deleteNote` path has no guard either (not run).

### 7.2 The list showed 5 notes while the server held 6 (explore only, not reproduced)

In 2 of 12 reordered runs at 600 and 900 ms (r15 at 600 ms with no hold run out, r22 at 900 ms with 2) explore reported `page text only in the baseline: "Notes 6", ...`,
`only in this run: "Notes 5"`: the two duplicate POSTs answered out of order and `addNote()` sets the list from each
answer (line 76), so the older answer (5 notes) landed last. A plain-Playwright attempt that held the first POST's
answer 1.2 s (`repro.mjs notes-order`) did not reproduce it (0 of 5: the page listed 6 of 6); the exact order of the
follow-up requests in those runs was not rebuilt by hand. It follows from 7.1 (no duplicate POST, no out-of-order pair), so it is not reported
separately.

### 7.3 Notes show no author name on a direct load of the Notes tab

`displayName(note)` (lines 102-115, template line 24) looks the author up in `this.users`, a plain field filled by
`usersService.listAll()` in the constructor (lines 55-64). The app runs zoneless (`main.ts` line 127), so assigning a
plain field when `GET /api/users/` answers schedules no change detection; if the notes rendered first, the footers
stay `- Nov 3, 2026` with no name until something else re-renders the component.

Measured without GenClass on a direct load of `/documents/1/notes` (`repro.mjs names`, footers read 3.5 s after the
first note appeared): `GET /api/users/` held 2 s: 5 of 5 without names; **no delay at all: 10 of 10 and, in an earlier
run, 3 of 5 without names**. Explore saw it in 3 seeded runs, one per latency (seed 3 each time: `"- Nov 3, 2026"` four times instead of
`"playwright - Nov 3, 2026"`; in the 900 ms run `/api/users/` was delivered last, after its hold ran out). Not measured: whether it happens
when the Notes tab is reached by navigating inside the app (the sender should check by hand before reporting it), and
whether a later interaction fills the names in. The existing spec test "should display notes with user name /
username" calls `fixture.detectChanges()` itself, which is why a unit test of this shape passes; a test would need
automatic change detection. No test sketch is included for this one.

## 8. Tests (sketches for the person who writes the fix)

`docs/adoption/hunts/paperless-ngx/failing-tests.sketch.ts` holds three Jest `it` blocks in the style of the existing
specs (`jest.useFakeTimers`, `jest.spyOn(searchService, 'globalSearch')`, `component.onQueryChange`,
`jest.advanceTimersByTime(401)`, `Subject`s completed out of order):

- A (global-search spec): two searches, the earlier answers last; expects `searchResults()` to be the later answer.
- B (global-search spec): a search cleared with Escape answers afterwards; expects no results and no `open()`.
- C (document-notes spec): two Ctrl+Enter while the first save is pending; expects one `addNote` call.

Measured in the clone (inserted into `global-search.component.spec.ts` and `document-notes.component.spec.ts`, `Subject`
added to their `rxjs` imports; `npx jest src/app/components/app-frame/global-search src/app/components/document-notes`
from `src-ui`, about 9 s):

| code | result, 3 runs each |
|---|---|
| unchanged | **3 failed, 18 passed** (A: expected the later result, received the earlier; B: received the stale result; C: expected 1 call, received 2), 3 of 3 runs |
| with the local change of 6.4 and 7.1 | 21 passed, 3 of 3 runs |

The local change was then reverted; the clone is back at `cc15aa01`. Not run: the project's full Jest suite, its
Playwright suite (needs Playwright 1.64.1 browsers, not installed here), prettier (the root `.prettierrc.js` needs
`prettier-plugin-organize-imports` at the repository root, not installed by `pnpm install` in `src-ui`) and lint.

**The fixed variant in the browser** (the local change, ng serve rebuilt it):

| check | unfixed | with the local change |
|---|---|---|
| explore, search, 600 and 900 ms, seed 1, 6 runs each | RACE 1 of 6, RACE 1 of 6 | no race, 0 of 6 and 0 of 6 |
| explore, search, 900 ms, seed 11, 20 runs | RACE 6 of 20 | no race, 0 of 20 (the `doc` response still reached the page last in 7 of these loads, and in 2 of the seed-1 loads above; the dropdown was right in all 9) |
| `repro.mjs search` / `escape` / `notes-double`, 5 each | 5/5, 5/5, 5/5 wrong | 0/5, 0/5, 0/5 wrong (`notes-single` 0/5) |

## 9. Problems with GenClass itself

1. **`whenSettled()` and snapshots ignore rxjs (Angular) debounces.** The agent link
   (`packages/runtime/src/agent/index.ts`, "the app's short timers") counts pending `setTimeout` calls of at most 1 s
   as busy, so a debounced search is not snapshotted before its request (AGENT.md section 2 says so). rxjs 7 schedules
   `debounceTime`, `delay`, `timer` and `throttleTime` on the async scheduler, which uses `setInterval`
   (`rxjs/dist/esm/internal/scheduler/AsyncAction.js` line 28), and the wrapper does not cover it. Consequence here:
   `whenSettled()` resolved before Angular's debounced search was sent in most loads; in the first `search` session the
   two baselines differed (one or two requests), explore filtered the difference as noise and answered "no race" at
   300 ms while 7 of 8 loads were wrong by the oracle at that moment, and at 600 ms reported "RACE 3 of 6" on the same
   artefact. Every Angular app with a debounced input is affected, and an agent following the tool's own instructions
   (`whenSettled` right after the steps) would get these results. The recorded causality does see the interval
   ("send ... via interval 0.13s"), so the information is there. Suggestion for the backlog: treat a short `setInterval`
   whose callback clears it, or rxjs's async scheduler specifically, as a pending short timer.
2. **Runs that never did the steps still get a verdict.** In the discarded `list` session every load threw before the
   first action (a harness locator error) and the context closed right after page load; explore reported "RACE: 4 of
   6" and "6 of 6" from page-load snapshots taken at different stages ("Upload", "Dashboard" in the baseline only),
   with "(no user actions: a page load)" in the scenario line as the only hint. A verdict on runs with no recorded
   actions, when the session's other runs or the `route` suggest a scenario, deserves a warning.
3. **Request keys in `recorded().order` carry no query string** (`GET localhost:8001/api/search/#1`), so a harness
   cannot tell `query=doc` from `query=document 12` there; `genclass_explain` does show the query. Minor; the harness
   relies on the counter.
4. **Duplicate submits are invisible to explore by design** (the same in every load, baselines included). Correct,
   but the report could say "N writes to the same endpoint with the same body in every run" as a hint; the harness's
   API oracle was what found 7.1.
5. No tool errors; the bridge, explore, explain and the agent link worked on a zoneless Angular 22 app served by the
   Vite-based dev server with the API on another origin.

## 10. The project's rules, and what the sender must do

Read from the clone at `cc15aa01`:

- `CONTRIBUTING.md`, "Use of AI Tools" (lines 58-66), quoted: "1. Any content — code, pull request descriptions, issue
  reports or comments — that was generated in whole or in part by an AI tool or agent **must be clearly disclosed as
  such**. ... 3. We will not accept PRs that are entirely or mostly AI-derived. 4. Issue reports must describe
  _observed behavior only_: what happened, how to reproduce it and the relevant logs. Reports generated by an AI agent
  should not include code analysis, speculation about the root cause or suggest fixes. 5. Contributors are responsible
  for everything they submit, regardless of how it was produced. Please do not open issues or PRs you have not
  verified yourself."
- `.github/ISSUE_TEMPLATE/bug-report.yml`: required "AI usage" dropdown (`No AI tools were used` /
  `Yes, AI tools helped write this report`), Description ("Please describe the observed behavior only, do not include
  code analysis"), Steps to reproduce, Webserver logs, Paperless-ngx version, Host OS, Installation method, five
  required checkboxes. The form also carries a hidden comment that asks LLMs to add a marker token to the issue; the
  drafts do not include it and the sender must not add it.
- The brief adds (not re-checked here): issues opened outside the web form are closed by a bot; pull requests are
  checked by an anti-slop bot.

So: an AI-assisted bug report is allowed with the dropdown set to "Yes" and observed behaviour only;
`paperless-ngx-issue.md` has the drafts. A pull request is allowed only if a person writes the fix and the test
themselves; this hand-back gives them the cause, the fix idea and the failing test sketches to work from, and no
diff or PR text.

**Before anything is sent, a person must:** reproduce each issue by hand in a browser on a current `dev` (the policy's
item 5), with their own install's version, OS and logs in the form; search the tracker for duplicates filed since
2026-11-03 (this session did not query GitHub; the brief's search found none on search, race, stale or debounce);
send the global-search issue first and the Notes ones only if they reproduce them (7.3 needs a check of in-app
navigation); and, if they want to send a fix, write it and the test by hand from this report and disclose in the PR
what AI did (found and reproduced the bug, drafted the report) per the PR template's checklist.

## 11. Time spent

About 55 minutes of session time (about 16:30 to 17:25 UTC): 10 min reading the brief and the swarm rules, 10 min
setup (clone, uv with the torch workaround, pnpm, both servers; the backend was ready at 16:43), about 10 min to the
first confirmed race, 20 min of explore sessions (including the two discarded ones and the debounce diagnosis),
10 min for the reproduction, the Jest sketches and the fixed-variant checks, then writing. Sessions ran in the
background while the next step was prepared, so the parts overlap.

## 12. Reproducing

```bash
# this repository, once
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
# the target: section 2 (pnpm e2e:backend and pnpm start:e2e running)
node docs/adoption/hunts/paperless-ngx/hunt.mjs --surface search --slow 300,600,900 --runs 6 --out /tmp/pngx
node docs/adoption/hunts/paperless-ngx/hunt.mjs --surface search --slow 600,900 --runs 20 --seed 11 --out /tmp/pngx
node docs/adoption/hunts/paperless-ngx/hunt.mjs --surface list --slow 300,600,900 --runs 6 --out /tmp/pngx
node docs/adoption/hunts/paperless-ngx/hunt.mjs --surface notes --slow 300,600,900 --runs 6 --out /tmp/pngx
# without GenClass
node docs/adoption/hunts/paperless-ngx/repro.mjs --n 5
```

`results/` holds the summaries of the sessions in section 4 (`*-summary.json`), the fixed-variant summaries
(`fixed-*`), the full explore report and explain output for search at 900 ms seed 11, and the reproduction logs
(`repro-unfixed.txt`, `repro-fixed.txt`).
