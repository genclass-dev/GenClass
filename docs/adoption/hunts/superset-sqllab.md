# Race hunt: Apache Superset SQL Lab (tab-state autosave, Format SQL, Save query)

A GenClass race hunt on Apache Superset's SQL Lab, run on 2026-11-03 in a cloud session (slug `superset-sqllab`, type
hunt, `docs/adoption/swarm.md` section 4.1), with the real `@genclass/runtime` and `@genclass/mcp` built from this
repository and injected from outside: Superset's source was not modified for the hunt. The fixes are patches for
Superset's maintainers; nothing was sent to the Superset project, its tracker, Slack or anyone else.

**Status: ready to send** (after the by-hand items in [superset-sqllab-issue.md](superset-sqllab-issue.md), "Before
sending").

**Headline.** SQL Lab's tab-state autosave loses an edit typed while the previous save is in flight. `EditorAutoSync`
records "last saved" as the time the `PUT /tabstateview/<id>` response arrives; a change typed between the request
and its response is older than that, so it counts as saved, is never sent, and a reload brings back the previous SQL.
`genclass_explore` reported it as a RACE at 600 ms (2 of 6 reordered loads) and 900 ms (3 of 6), each time on exactly
the loads whose server copy had lost the edit, and its replay reproduced it. A plain Playwright script that only holds
the PUT's response reproduces it in 3 of 3 trials at 600, 900 and 1,500 ms (0 of 3 at 0 and 300 ms, where the response
lands before the last keystroke). A 6-line fix (take the timestamp before sending) with a Jest test that fails 3 of 3
without it and passes 3 of 3 with it is in [superset-sqllab.patch](superset-sqllab.patch). Two smaller bugs of the same
family, which the brief predicted, were confirmed and fixed too, each as its own patch: Format SQL overwrites text
typed while the format request is pending ([superset-sqllab-format.patch](superset-sqllab-format.patch)), and the Save
query modal saves twice on a double click while the first save is in flight
([superset-sqllab-savequery.patch](superset-sqllab-savequery.patch)). The recommended order of sending is the autosave
issue and pull request first, the other two only after a maintainer has responded (section 8).

The false-report side, next to those numbers: on the build with the three fixes, 0 of 72 explore loads had any of the
bugs by the harness's own oracle, but 4 of the 9 fixed sessions still carried a RACE line (a page that is correctly
formatted in some loads and not in others, the harness's own growing tab bar, an un-normalised client id: section 6).
On the unfixed build, explore's verdict was right in 6 of 9 sessions and gave no verdict on the Save query double
submit at 600 and 900 ms (section 3.1); the problems are in section 7.

Sections: 1 setup, 2 how SQL Lab was driven, 3 scenarios and verdicts, 4 the finding, 5 the two other bugs, 6 the
fixed variant, 7 problems with GenClass itself, 8 sending, 9 time spent, 10 reproducing.

## 1. Setup

| what | version |
|---|---|
| Superset | `apache/superset` master at `730016b8614d549205f0c56591ced269e1cd8d0e` (2026-11-03 15:55 UTC). The brief recorded `f44d3992`; master had moved by six commits, none under `superset-frontend/src/SqlLab` or `superset/views/sql_lab` (`git diff --stat f44d3992 HEAD -- ...` is empty), and all three patches apply unchanged at `f44d3992` too (checked with `git apply --check`) |
| Python, Flask, SQLAlchemy | 3.12.3 (venv made with `uv venv -p 3.12`; the image's default `python3` is 3.13), Flask 3.1.3, SQLAlchemy 2.0.55 |
| metadata and examples DB | SQLite (`~/.superset/superset.db`, `~/.superset/examples.db`), `superset load-examples` |
| Node, npm | 24.16.0 and 11.13.0 (the tarball from nodejs.org named by `superset-frontend/.nvmrc`; the image has Node 22) |
| frontend | production build (`npm run build`), served by Flask on 8088 |
| browser | Playwright 1.63.0 (this repository's), Chromium 1243 headless shell |
| GenClass | this repository at `c1c9e14` (main): `@genclass/runtime` 0.3.0-beta.5 and `@genclass/mcp` 0.2.1, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |

Commands, in order (the brief's run commands, with the deviations noted):

```bash
apt-get install -y build-essential libssl-dev libffi-dev python3-dev libsasl2-dev libldap2-dev libpq-dev \
  default-libmysqlclient-dev pkg-config zstd          # zstd: see below
git clone --filter=blob:none https://github.com/apache/superset.git ~/targets/superset-sqllab   # 730016b8
cd ~/targets/superset-sqllab
uv venv -p 3.12 venv && . venv/bin/activate
uv pip install -r requirements/development.txt && uv pip install -e .
export SUPERSET_CONFIG_PATH=~/targets/sscfg/superset_config.py FLASK_APP=superset   # only a fixed SECRET_KEY
superset db upgrade
superset fab create-admin --username admin --firstname Hunt --lastname Admin --email admin@example.com --password general
superset init
superset load-examples
superset fab create-admin --username hunt2 ... --password general   # a second user for the plain reproductions
cd superset-frontend && npm ci --no-audit --no-fund && npm run build
cd .. && superset run -p 8088 --with-threads           # without --reload/--debugger: a stable server for timing
```

Two local workarounds, neither part of any patch:

- **`xlsx` from a blocked host.** `superset-frontend/package.json` pins `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`,
  and this container's egress proxy refuses `cdn.sheetjs.com` (HTTP 403 on CONNECT, `$HTTPS_PROXY/__agentproxy/status`).
  `package.json` and the lockfile were pointed locally at `npm:@e965/xlsx@0.20.3` (a republish of the same SheetJS
  version on the npm registry) so `npm ci` could run. `xlsx` is used only by `src/utils/downloadAsPivotExcel.ts`,
  nowhere near SQL Lab.
- **`zstd`.** The first `npm run build` failed loading `webpack.config.js`: `simple-zstd` throws "Can not access
  zstd! Is it installed?". `apt-get install zstd` fixed it. Superset's setup docs do not list it among the OS
  dependencies; worth a line upstream some day, not in this contribution.

## 2. How SQL Lab was driven

Scripts in [superset-sqllab/](superset-sqllab/) (each header says how to run it):

- **`hunt.mjs`**, the GenClass loop, modelled on [gitea-explore.mjs](gitea-explore.mjs) and
  [strapi/hunt.mjs](strapi/hunt.mjs): `serve()` from `packages/mcp/dist/index.js` in-process (bridge on a free port),
  driven through JSON-RPC `tools/call` exactly as an agent would (`genclass_clear`, `genclass_explore` start and report,
  `genclass_explain`, `genclass_replay` arm and result, `genclass_findings`). A context route rewrites each Superset
  HTML document to put at the top of `<head>`: `window.GENCLASS_CONFIG = { telemetry: false, mode: "observe",
  model: false, visual: false, devtools: false, report: "silent" }`, the script-tag build from the virtual path
  `/__genclass/`, and a module script that imports `/__genclass/agent.js` and calls
  `connectAgent(window.GenClass.runtime, { url })`. Requests to any host but localhost are aborted. Contexts use
  `bypassCSP: true`, the `local-network-access` permission and Chromium's
  `--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers`. One login through Superset's form,
  reused as `storageState`. Each load waits for `__GENCLASS_AGENT__.connected` and a quiet point before its steps,
  and `whenSettled()` after them.
- **Explore sessions:** `runs: 6` and `slow_ms` 300, 600 and 900, so 8 loads per session (2 fifo baselines and seeds
  1 to 6), every response delayed by a seeded amount in `[0, slow_ms]` (the baselines all get the delay of seed 0),
  then `report`; for the first race finding, `genclass_explain`, then `genclass_replay arm`, one more load, `result`.
- **The secondary oracle**, per load, read outside the page: for autosave the server's copy of the tab
  (`GET /tabstateview/<id>` through Playwright's own request context, which neither the page nor GenClass sees) and the
  PUTs sent; for Format SQL the editor's text; for Save query the POSTs to `/api/v1/saved_query/`. The summary compares
  each seeded load's oracle with the two baselines'.
- **`repro-autosave.mjs`** and **`repro-format-save.mjs`**, the reproductions without GenClass: plain Playwright, a
  context route that lets the request through at once (`route.fetch()`) and holds only its response for a fixed time,
  3 trials per hold time. `repro-format-save.mjs` runs as the second admin (`hunt2`) so its tabs never mix with the
  admin's (SQL Lab's tab state is per user), which also let it run while an explore session was going.
- **What state GenClass saw.** The production bundle is minified, so the discovered component state carries minified
  names (`y.state12`, `cX.state4`, `Connect_Component.state0`); the editor's own text appeared as `cX.state3`/`cX.state4`
  and the debounced unsaved editor as `y.state12` (`sql`, `updatedAt`). The verdicts below rest on the visible tier
  (writes sent, page text), not on those names.

The typing is real keyboard input into Ace (`page.keyboard.type`, 20 ms a key), so GenClass recorded it as typing
bursts on `textbox "Cursor at row 1"`.

## 3. Scenarios and verdicts

Every load reached a quiet point; no run was forced (no hold hit `maxHoldMs`) unless stated.

### 3.1 With GenClass (explore), on the unfixed build

| scenario | slow_ms | explore verdict (as reported) | compared | own oracle: seeded loads differing from the baselines | bug state per load (b1 b2 s1..s6) | replay of the first finding |
|---|---|---|---|---|---|---|
| autosave | 300 | no race found | 6 of 6 | 0 of 6 | 0 0 0 0 0 0 0 0 (lost) | none |
| autosave | 600 | **RACE: 2 of 6** | 6 of 6 | 2 of 6 (seeds 2, 4) | 0 0 0 1 0 1 0 0 (lost) | **reproduced** (r18: one PUT, server holds the old SQL) |
| autosave | 900 | **RACE: 3 of 6** | 6 of 6 | 3 of 6 (seeds 1, 4, 6) | 1 1 0 1 1 0 1 0 (lost) | **reproduced** |
| format | 300 | **RACE: 6 of 6** | 6 of 6 | 6 of 6 | 1 1 1 1 1 1 1 1 (typed text not at the end) | inconclusive (the replay mangled the text differently: section 7 item 5) |
| format | 600 | **RACE: 5 of 6** | 6 of 6 | 5 of 6 | 1 1 1 1 1 1 1 1 | **reproduced** |
| format | 900 | **RACE: 5 of 6** | 6 of 6 | 5 of 6 | 1 1 0 0 0 0 1 1 | inconclusive (as at 300) |
| savequery | 300 | RACE: 2 of 2 (**false**: the harness's tab names, below) | 2 of 6 | 4 of 6 | 1 1 2 2 2 2 1 1 (POSTs) | inconclusive |
| savequery | 600 | no verdict (0 compared: the loads split by scenario) | 0 of 6 | 6 of 6 | 1 1 2 2 2 2 2 2 | none |
| savequery | 900 | no verdict (0 compared) | 0 of 6 | 6 of 6 | 1 1 2 2 2 2 2 2 | none |

Format SQL: the oracle is "the typed ` -- bravo` ends the statement". In every unfixed load but four it did not, and
how it failed depended on when the response landed: dropped entirely (`"SELECT\n  'alpha' AS v"`), or, when the
response landed in the middle of the typing, the cursor moved to the old position (row 1, past the end of the
formatted first line) and the rest of the keystrokes went there (`"SELECTravo\n  'alpha' AS v"`,
`"SELECT-- bravo\n  'alpha' AS v"`). Of the four loads that kept it (900 ms, seeds 1 to 4), three show the formatted
statement followed by ` -- bravo` (the response landed before the typing began) and one (seed 1) the unformatted
statement with ` -- bravo`: the formatting was lost instead, as in the plain reproduction at 300 ms. Because nearly every load fails in its own way, explore's RACE lines here are differences
between failures, baselines included; it is the witness, not the verdict, that names the bug (section 7 item 4).

Save query: the second click is recorded as an action only when the modal was still open, that is only in the loads
that sent two POSTs, so those loads have a different scenario (`click button "Save"` once or twice) and explore did not
compare them with the baselines: no verdict at 600 and 900 ms, which is the limit AGENT.md section 8 states ("a click
that a page only offers in some orders"). At 300 ms the two seeded loads that did share the baselines' scenario were
reported as RACE for page text the harness itself caused (each load adds a tab, so the tab bar's
`"Untitled Query 8"` to `"Untitled Query 11"` differ between loads) and for a PUT keyed by a client id
(`PUT /tabstateview/DMLCgxxbcfm` instead of `:id`): a false report. No `identical-in-flight` witness was recorded in
any load, although two identical `POST /api/v1/saved_query/` from two clicks were in flight together in 16 of the 18
seeded loads (section 7 item 8). The plain reproduction (3.2) is the evidence for this bug.

How to read the 900 ms autosave row: seed 0's delay for the first PUT was long enough to lose the edit, so **both
baselines lost it**, and the three seeded loads explore flagged are the three that kept it. Explore says the outcome
depends on the delivery timing and names the loads that differ from the baseline; it does not say which side is the
bug, and here the "failing run" it replayed is the correct one. The 600 ms row is the clean case (baselines correct,
flagged loads lost).

### 3.2 Without GenClass (plain Playwright, one response held)

| scenario | held | result, 3 trials each |
|---|---|---|
| autosave (`repro-autosave.mjs`, admin) | 0 / 300 / 600 / 900 / 1,500 ms | edit lost **0 / 0 / 3 / 3 / 3 of 3** (server copy; a reload showed the same in 13 of the 15 trials, the other 2 below) |
| Format SQL (`repro-format-save.mjs format`, hunt2) | 0 / 300 / 900 / 1,500 ms | typed text lost **0 / 0 / 3 / 3 of 3**; at 300 ms the editor kept the typed text but lost the formatting (it ended `select 'alpha' as v from (select 1) t -- bravo`) |
| Save query, two clicks 150 ms apart (`repro-format-save.mjs save`, hunt2) | 0 / 300 / 900 ms | duplicate saved query **0 / 3 / 3 of 3** (two POSTs, two rows with the label) |

In 2 of the 15 autosave trials (600 ms trial 2, 900 ms trial 3) a second PUT with `"SELECT ..."` (a new tab's default
text) went out and the reload showed `SELECT ...`: the page had a second tab after the reload, and the first version
of the script did not record which tab a PUT was for (it does now). The tab under test held the old SQL on the server
in both, so both count as lost; the reload column is not used for them.

## 4. The finding: autosave drops edits typed while a save is in flight

### 4.1 What explore saw

Session at 600 ms, seed 2 (run r13). The report, reduced:

```
RACE: 2 of 6 reordered run(s) ended in a different state than the baseline (responses in request order)
- run r13 (seed 2):
    requests sent to "PUT /tabstateview/:id": baseline "2", this run "1"
    state "Connect_Component.state0": baseline "2 items [{error: undefined}, 11]", this run "2 items [{error: undefined}, 10]"
    witness only here: overwrote-newer Connect_Component.state0 by PUT /tabstateview/:id
- run r15 (seed 4): the same
```

`genclass_explain` of the finding (f3), the steps in causal order (times from `connectAgent`):

```
+8.063s send       PUT /tabstateview/:id#1 "form 10 fields"                         (sql = "SELECT 'alpha' AS v")
+8.225s action 3:  type textbox "Cursor at row 1" = "SELECT 'alpha' AS v -- bravo" (9 keystrokes over 248 ms)
+8.500s action 4:  key textbox "Cursor at row 1"                                   (Escape)
+8.621s delivered  PUT /tabstateview/:id#1 (held 543 ms)
+8.627s write      Connect_Component.state0 ... by PUT /tabstateview/:id#1
+13.479s write     y.state12.sql: "SELECT 'alpha' AS v" → "SELECT 'alpha' AS v -- bravo"; y.state12.updatedAt ...
                   (the debounced unsaved editor, 5 s after the last keystroke: and no PUT follows)
```

The response to the save landed 121 ms after the last keystroke; the debounce fired 5 s later with the new SQL, and
nothing was sent. In the baselines the PUT's delay was shorter than the typing (its response landed before the last
keystroke), so the last keystroke's `updatedAt` was newer than the saved time and a second PUT carried the edit.

`genclass_replay` of f3 (one load under seed 2's schedule): "REPRODUCED · ended with the same wrong values as the
failing run"; that load's own oracle: one PUT, server `"SELECT 'alpha' AS v"`, editor `"SELECT 'alpha' AS v -- bravo"`.

### 4.2 Root cause (paths and lines at `730016b8`)

1. `superset-frontend/src/SqlLab/components/SqlEditor/index.tsx` lines 679-682: each change dispatches
   `queryEditorSetSql`; the reducer (`reducers/sqlLab.ts` lines 60-87, `alterUnsavedQueryEditorState`) stores the
   text in `unsavedQueryEditor` with `updatedAt: new Date().getTime()`.
2. `components/EditorAutoSync/index.tsx` lines 107-110: `useDebounceValue(unsavedQueryEditor, 5000)`; lines 186-199:
   when the debounced value changes, `getUnsavedItems` keeps the editors whose `updatedAt` is newer than
   `lastSavedTimestampRef.current` (lines 46-67, `hasUnsavedChanges`), PUTs each through `updateSqlEditorTab`
   (`src/hooks/apiResources/sqlEditorTabs.ts` lines 30-69), and **on resolve** sets
   `lastSavedTimestampRef.current = Date.now()` and dispatches `setEditorTabLastUpdate`.
3. A change made after the PUT was sent and before it resolved has `updatedAt` < the resolve time, so the next
   debounce (5 s after it) filters it out: no request.
4. `middlewares/persistSqlLabStateEnhancer.ts` lines 76-118 keeps unsaved editors in localStorage with the same filter
   against `editorTabLastUpdatedAt`, so the local fallback drops the change too. On reload, `getInitialState` takes the
   server's tab state (`superset/views/sql_lab/views.py` lines 170-204 had stored the first PUT).

Not the cause, though the brief suspected it: the server's PUT handler is a blind field-wise update with no version
check, so two PUTs for one tab that arrive out of order would also leave older SQL. That needs the first PUT to take
longer than the 5 s debounce plus the user's next pause; it was not exercised here (the explore delays are at most
900 ms), and the fix does not change it.

Related upstream, not duplicates (searched 2026-11-03 by the brief's verifier, see the brief): SIP-93 (#21385) designed
this sync; nothing in the tracker reports edits lost to an in-flight autosave.

### 4.3 The fix ([superset-sqllab.patch](superset-sqllab.patch))

```ts
const unsaved = getUnsavedItems(debouncedUnsavedQueryEditor);
// Taken before the requests are sent: changes made while they are in
// flight are newer than what they save and must stay unsaved.
const savedAt = Date.now();
...
lastSavedTimestampRef.current = Math.max(lastSavedTimestampRef.current, savedAt);
```

Everything the PUT carried was made before `savedAt`; anything made after it stays newer than the saved time and goes
out with the next debounce. `Math.max` keeps the value from going backwards if an older batch resolves after a newer
one. No change to the payload, the server, or the number of requests when nothing is typed during a save.

### 4.4 Regression test

`src/SqlLab/components/EditorAutoSync/EditorAutoSync.test.tsx`, new test "sync the changes made while the previous
sync request was in flight", in the file's own style (Jest fake timers, `fetch-mock`, `render` from
`spec/helpers/testing-library` with a real store from `createStore(..., reducerIndex)`): the first PUT is held by a
promise the test resolves; between the request and its resolution the test dispatches `queryEditorSetSql(...,
'SELECT 2')`; after another debounce interval it expects a second PUT whose `sql` is `"SELECT 2"`.

| code | `npx jest src/SqlLab/components/EditorAutoSync`, 3 runs |
|---|---|
| unfixed | 3 of 3 fail: "Expected length: 2, Received length: 1" (the other 6 tests pass) |
| fixed | 3 of 3 pass (7 of 7 tests) |

Related suites with the fix: `npm run test -- src/SqlLab/components/EditorAutoSync src/SqlLab/middlewares
src/hooks/apiResources/sqlEditorTabs src/SqlLab/reducers src/SqlLab/actions/sqlLab.test.ts`: 5 suites, 160 passed,
1 skipped (skipped before the change too). `pre-commit run` hooks `oxfmt-frontend`, `oxlint-frontend`,
`custom-rules-frontend` and `trailing-whitespace` on the two files: passed. `type-checking-frontend` first failed with
TS6305 ("Output file ... has not been built from source") on every file that imports a workspace package, because
the packages' declarations had not been built; after `npm run plugins:build` it passed on all six files the three
patches change (0 errors).

A note on the test, from writing it: the existing tests in that file answer the PUT with a bare `200` (no JSON body).
The first version of the new test did the same, passed on the unfixed code, and made the component log "An error
occurred while saving your editor state." twice (the next test, which counts that warning, then failed): the bare
`200` is handled as a failed save, so the branch that sets the saved timestamp is never reached. The new test answers
with a JSON body (`{ id }`, as the server's `json_success(json.dumps(tab_state_id))` does) and fails on the unfixed
code as it should. The existing tests' bare `200` is left as it is; it may be worth a follow-up upstream.

## 5. The two other bugs

### 5.1 Format SQL overwrites text typed while formatting ([superset-sqllab-format.patch](superset-sqllab-format.patch))

`formatQuery` (`src/SqlLab/actions/sqlLab.ts` lines 1274-1308) POSTs the current SQL to `/api/v1/sqllab/format_sql/`
and, on resolve, dispatches `queryEditorSetSql(queryEditor, json.result)` whatever the editor holds by then;
`EditorWrapper` replaces the Ace text when the store's SQL changes. Typing after Ctrl+Shift+F (or "..." → Format SQL)
and before a slow response is overwritten (table 3.2: 3 of 3 at 900 and 1,500 ms). Under explore, when the response
landed in the middle of the typing, the cursor was moved and the remaining keystrokes landed inside the formatted
statement (`"SELECT-- bravo\n  'alpha' AS v"`): see the note under table 3.1.

Fix: apply the result only when `getUpToDateQuery(getState(), queryEditor).sql` is still the SQL that was sent. Test:
`src/SqlLab/actions/sqlLab.test.ts`, "keeps the edits made while the query was being formatted" (a `redux-mock-store`
whose state is a function, edited between the request and the response; expects no action): fails 3 of 3 unfixed,
passes 3 of 3 fixed; the whole file 100 passed, 1 skipped with the fix. Format, lint and custom-rules hooks passed.

### 5.2 Save query saves twice ([superset-sqllab-savequery.patch](superset-sqllab-savequery.patch))

`SaveQuery/index.tsx`: the modal's Save (and Save as new, Update) buttons are disabled only by `isLabelEmpty`
(lines 256-270); `onSaveWrapper` (lines 155-159) awaits `onSave` then closes the modal. A second click while the POST is
pending posts again (table 3.2: two clicks 150 ms apart give two saved queries with the same label in 3 of 3 trials at
300 and 900 ms, 0 of 3 with no hold). Fix: an `isSaving` state set around the awaited save or update, in
`try`/`finally`, added to the three buttons' `disabled`. Test: `SaveQuery.test.tsx`, "saves once when save is clicked
again while the save is in progress" (the pattern of the file's own "modal stays open while save is in progress"
test): unfixed 3 of 3 fail with "Received number of calls: 2", fixed 3 of 3 pass (18 of 18). Hooks passed.

## 6. The fixed variant

The three fixes together (a local branch with the three commits) built with `npm run build`, the server restarted
(the served autosave chunk was checked to contain the change: `Math.max(f.current,t)`), then the same scripts.

Without GenClass, the same holds as in 3.2:

| scenario | held | unfixed (3.2) | fixed |
|---|---|---|---|
| autosave, edit lost | 0 / 600 / 900 / 1,500 ms | 0 / 3 / 3 / 3 of 3 | **0 / 0 / 0 / 0 of 3** (two PUTs every time, the second with the edit; the server copy and the reload show it) |
| Format SQL, typed text lost | 0 / 300 / 900 / 1,500 ms | 0 / 0 / 3 / 3 of 3 | **0 / 0 / 0 / 0 of 3**; with a hold the late result is now dropped, so the editor keeps the typed text unformatted |
| Save query, duplicate | 0 / 300 / 900 ms | 0 / 3 / 3 of 3 | **0 / 0 / 0 of 3** (one POST, one saved query) |

In autosave's first fixed trial (0 ms) a third PUT went to another tab (`"SELECT ..."`, tab 44) and the reload showed
that tab: the admin had accumulated tabs from the Save query sessions (one added per load). The server copy of the tab
under test held the edit.

With GenClass (explore), the same sessions as 3.1:

| scenario | slow_ms | explore verdict, fixed | compared | own oracle: loads with the bug | replay of the first finding |
|---|---|---|---|---|---|
| autosave | 300 / 600 / 900 | no race found / no race found / no race found | 6 of 6 each | 0 of 8 / 0 of 8 / 0 of 8 | none |
| format | 300 / 600 | no race found / no race found | 6 of 6 each | 0 of 8 / 0 of 8 | none |
| format | 900 | RACE: 3 of 6 (**false**: formatted or not, below) | 6 of 6 | 0 of 8 | "reproduced" (the same formatted/unformatted difference) |
| savequery | 300 | RACE: 5 of 6 (**false**: the harness's tab names, a client-id key) | 6 of 6 | 0 of 8 (one POST each) | not reproduced |
| savequery | 600 | RACE: 2 of 6 (**false**, as at 300) | 6 of 6 | 0 of 8 | not reproduced |
| savequery | 900 | RACE: 6 of 6 (**false**: the page text `"hunt double save"` only in the seeded loads; not investigated) | 6 of 6 | 0 of 8 | "reproduced" (that text again) |

Format SQL at 900 ms, fixed: every load ends with the typed text at the end; three seeded loads show the formatted
statement (the response landed before the typing began, so it was applied), the others the unformatted one (it
landed after, and the fix dropped it). Both are correct outcomes of the fix, so the RACE line is a false report.

**False reports on the fixed variant** (the number to read next to the recall): 4 of the 9 fixed sessions carried a
race-like verdict (format 900, savequery 300, 600, 900), while the oracle found the bug in 0 of the 72 fixed loads.
On the unfixed variant the verdicts were right in 5 of 9 sessions (autosave 600 and 900, format 300, 600 and 900),
gave the right "no race" in 1 (autosave 300), no verdict in 2 (savequery 600, 900) and a false RACE in 1 (savequery
300, where the bug was present but the RACE line named the harness's tab names, not the duplicate).

Jest on the combined branch, every SQL Lab suite (`npm run test -- src/SqlLab src/hooks/apiResources/sqlEditorTabs`):
47 suites, 526 passed, 1 skipped.

## 7. Problems with GenClass itself

Recorded as they were hit; none changed a finding. Product feedback for the launcher, no issue filed.

1. **The baselines carry the bug when it needs latency (explore, verdict wording).** The fifo baselines get seed 0's
   delays (`armExplore`, `packages/mcp/src/store.ts` lines 404-417: "the same extra latency"), so a bug that appears
   only when one response is slow shows up in the baselines whenever seed 0 makes that response slow. Autosave at
   900 ms: both baselines lost the edit; explore reported "RACE: 3 of 6" on the three seeded loads that **kept** it,
   called them the failing runs, and its replay "reproduced" the correct outcome. The verdict was right that the
   outcome depends on timing, but the report and the finding text ("'2' in request order, '1' under seed 2" at 600 ms;
   the reverse at 900 ms) read as if the baseline were the correct behaviour. Suggestions: say "differs from the
   baseline" rather than "failing" when nothing says which side is wrong; add an undelayed request-order load as a
   reference next to the delayed baselines; or show, per differing field, both values without ranking them.
2. **The bug is latency against user input, not response against response.** The autosave and Format bugs need only
   one request: what matters is whether its response lands before or after the user's next keystrokes. Explore found
   them through its per-response seeded delay (`schedule.ts` `delayOf`), not through reordering, which is fine, but
   AGENT.md section 3 and the report wording ("responses in request order", "reordered runs") describe only ordering.
   One sentence in AGENT.md that `slow_ms` also explores "response before or after the user's next action" would have
   saved reading the scheduler to know whether these surfaces were in scope.
3. **Superset's Redux store was not discovered.** No `redux.*` field appeared in any snapshot of any session (Strapi's
   store was found as `redux.adminApi.*`, strapi.md section 2). The fields that carry the autosave bug
   (`sqlLab.unsavedQueryEditor.updatedAt`, `sqlLab.editorTabLastUpdatedAt`) were therefore invisible as such; the
   verdict rested on the PUT count (visible tier), which happened to be enough. What was discovered was component
   state under the production bundle's minified names (`y.state12`, `cX.state4`, `Connect_Component.state0`): readable
   only by guessing from values. Superset creates the store with Redux Toolkit's `configureStore`
   in `src/views/store.ts` (line 185, `sqlLab` a static reducer at line 146) with
   `devTools: process.env.WEBPACK_MODE === 'development' && !disableDebugger` (line 192), so a production build
   registers no DevTools enhancer; whether GenClass's discovery depends on that was not checked (Strapi's admin ran as a
   development build). Suggestion: check discovery against a production Redux Toolkit build, and in reports prefer a
   component's display name or file when the name is minified.
4. **Stale-write findings on bookkeeping (autosave).** Every autosave session listed a `stale-write` finding: "the
   response to PUT /tabstateview/:id overwrote `Connect_Component.state0` after the user's typing had already written
   it" (f1, f2, f4: in 4, 4 and 8 runs). That field is `[{error: undefined}, n]`, a counter (likely react-redux's or
   RTK Query's re-render bookkeeping), not data; nothing the user sees depends on it. False reports, 3 of 3 sessions.
   On Format SQL the same kind of witness was the real signal ("the response to POST /api/v1/sqllab/format_sql/
   overwrote `y.state1` after the user's typing", f6, in 9 of 9 runs, baselines included), but under minified names
   with nothing that says which of the six fields is the editor's text.
5. **Replays of a timing-dependent mangling are inconclusive.** Format SQL at 300 and 900 ms: the replay load showed
   text that matched neither the failing run nor the baseline exactly (`"SELECT- bravo"` against the finding's
   `"SELECT-- bravo"`: how many keystrokes land before the cursor moves depends on milliseconds), so the replay said
   "inconclusive" although it showed the same bug. Suggestion: when the replay's differing lines share a shape with the
   failing run's (same tokens minus a few characters), say "similar" rather than "inconclusive".
6. **Element names hold the page's previous text.** The first action of every load is `click div "<the editor's
   text>"`, and the editor's text at load time is whatever the previous load left on the server, so the names differed
   between loads and explore fell back to "grouped by action kinds and element roles" in every autosave session from
   600 ms and every Format session. The fallback did its job (6 of 6 compared every time), but a click target named by
   the editor's whole content is fragile; a code editor's container could be named by its role and label only.
7. **A request keyed by a client id.** One load's PUT was recorded as `PUT /tabstateview/DMLCgxxbcfm` (SQL Lab's
   nanoid-style client id for a tab not yet synced) where the others were `PUT /tabstateview/:id`; the signature
   normaliser did not recognise an 11-character mixed-case id, so the request counts differed by signature and fed a
   false RACE line (savequery 300 ms).
8. **No `identical-in-flight` witness for the Save query double submit.** Two `POST /api/v1/saved_query/` with the
   same body, from two clicks 150 ms apart, were in flight together in 16 of 18 seeded loads (the harness counted
   them from Playwright's `request` events; the server stored two rows), and no load recorded the witness that
   AGENT.md section 2 describes for exactly this case. Strapi's report saw the witness for a Publish double click;
   the difference here was not investigated (the second click might be merged into the first action, or the hold may
   have released the first response before the second request started in the recording's clock).
9. **Harness problems, not GenClass:** the same Local Network Access flags and permission as the Strapi and Gitea
   harnesses; the script-tag build has no agent entry (paired with the ESM `agent.js`, as in Strapi). A first
   savequery batch was discarded: the harness clicked a hidden duplicate of the add-tab icon and every load timed out
   (fixed with `:visible`; those sessions are not in the tables). No console error from the runtime on any load.

## 8. Sending

The drafts are in [superset-sqllab-issue.md](superset-sqllab-issue.md): the autosave issue in the bug-report form, its
pull request in the template, then the Format SQL issue and pull request as an optional second contribution. The Save
query patch has no draft text: it is a UI-state change that Superset's template would want before/after screenshots
for, and three contributions at once from a new contributor is too many; send it later, if at all, with its own issue.

Superset's rules, checked in the clone at `730016b8`: `CONTRIBUTING.md` and `docs/developer_docs/contributing/guidelines.md`
(an issue before the pull request is "highly recommended"; Conventional Commits titles; tests required; CI green and
one approval; pull requests stay open at least 24 hours), `.github/PULL_REQUEST_TEMPLATE.md`,
`.github/ISSUE_TEMPLATE/bug-report.yml` (blank issues off), `AGENTS.md` ("Run pre-commit before pushing"; Jest and
React Testing Library; `test()` over `describe()`; no `any`), no CLA bot and no DCO (Apache-2.0 contributions), no
AI ban (the repository ships `AGENTS.md`, `CLAUDE.md` and a "Working with LLMs" section in
`docs/developer_docs/contributing/development-setup.md`). Its `AGENTS.md` asks automated scanners filing *security*
findings to name a SECURITY.md row and principal; these are functional bugs, not security findings, and are filed by
a person. The commits carry `Generated-by: Claude Code`, the trailer the ASF generative tooling guidance suggests.

## 9. Time spent

About 1 hour 40 minutes of session time, 16:25 to about 18:05 UTC (the container's clock), with runs overlapping
the writing: about 25 minutes to get Superset running (the Python install with `uv` took under 2 minutes,
`load-examples` 3 minutes, `npm ci` and the build about 5 minutes, plus the blocked `xlsx` host and the missing `zstd`);
10 minutes to read the code paths the brief named; 5 minutes from the first plain reproduction to a confirmed lost
edit; 15 minutes for the autosave fix and its test (the first version of the test passed on the unfixed code, see 4.4);
10 minutes each for the Format SQL and Save query fixes and tests; about 45 minutes of explore sessions (18 sessions of
8 loads, 10 to 45 s a load; one savequery batch discarded, section 7 item 9), run while the report was written; the
rest writing.

## 10. Reproducing

```bash
# GenClass, from this repository
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
# Superset as in section 1, serving on 8088 with admin / general and hunt2 / general
node docs/adoption/hunts/superset-sqllab/repro-autosave.mjs --delay 0,300,600,900,1500 --trials 3
node docs/adoption/hunts/superset-sqllab/repro-format-save.mjs format --delay 0,300,900,1500 --trials 3
node docs/adoption/hunts/superset-sqllab/repro-format-save.mjs save --delay 0,300,900 --trials 3
HUNT_OUT=/tmp/hunt node docs/adoption/hunts/superset-sqllab/hunt.mjs explore autosave 300,600,900 6 --replay
HUNT_OUT=/tmp/hunt node docs/adoption/hunts/superset-sqllab/hunt.mjs explore format 300,600,900 6 --replay
HUNT_OUT=/tmp/hunt node docs/adoption/hunts/superset-sqllab/hunt.mjs explore savequery 300,600,900 6 --replay
node docs/adoption/hunts/superset-sqllab/summarise.mjs /tmp/hunt    # the tables of sections 3 and 6
# the fix: in the Superset clone
git am docs/adoption/hunts/superset-sqllab.patch   # (path from this repository)
cd superset-frontend && npm run test -- src/SqlLab/components/EditorAutoSync
```

The results of this session (the tool texts per session and the summaries) are in
[superset-sqllab/results/](superset-sqllab/results/).
