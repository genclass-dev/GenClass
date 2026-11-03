# Draft: issue and pull request for apache/superset (SQL Lab autosave drops edits typed while a save is in flight)

Prepared 2026-11-03 against apache/superset `master` at `730016b8614d549205f0c56591ced269e1cd8d0e` (the patch
also applies unchanged at `f44d3992`, the commit the session brief recorded). Report:
[superset-sqllab.md](superset-sqllab.md). Patch: [superset-sqllab.patch](superset-sqllab.patch). A second, separate
fix for Format SQL (section C) is in [superset-sqllab-format.patch](superset-sqllab-format.patch). Nothing below has
been sent.

Superset's guidelines ask for an issue before a pull request ("highly recommended" for small bug fixes), so file the
issue first (A), then open the pull request (B) with its number. Bug issues use the form
`.github/ISSUE_TEMPLATE/bug-report.yml` (blank issues are disabled); each heading below is one field of that form.

---

## A. Issue (form "Bug report")

**Title:** `SQL Lab: an edit typed while the tab state is being saved is never saved (lost on reload)`

### Bug description

With `SQLLAB_BACKEND_PERSISTENCE` (on by default), `EditorAutoSync` saves the editor 5 s after the last change
(`PUT /tabstateview/<id>`). When the PUT resolves, it stores `Date.now()` as the "last saved" time
(`superset-frontend/src/SqlLab/components/EditorAutoSync/index.tsx`, the `useEffect` at lines 186-199). A change
typed **after the PUT was sent but before its response arrived** has an `updatedAt` older than that time, so it is
treated as already saved: the next debounce finds nothing unsaved and never sends it, and the localStorage fallback
(`persistSqlLabStateEnhancer`, which filters with the same timestamp) drops it too. The page keeps showing the new
text, but the server keeps the old SQL, and a reload brings the old SQL back.

The window is the save request's round trip. With a fast local server it is a few milliseconds; on a slower network
or a busy server (hundreds of ms) it is easy to hit: pause long enough for an autosave, then keep typing.

To reproduce (Chrome DevTools can stand in for a slow server: Network → throttling "Slow 4G", or a custom profile
with about 1 s latency):

1. Open SQL Lab, any tab. Clear the editor and type `SELECT 'alpha' AS v`.
2. Stop typing. After 5 s the tab state is saved (`PUT /tabstateview/<id>` in the Network panel).
3. While that request is still pending, type ` -- bravo` at the end.
4. Wait at least 10 s (two more autosave windows). No further `PUT /tabstateview/<id>` is sent.
5. Reload the page. The editor shows `SELECT 'alpha' AS v`: ` -- bravo` is gone. `GET /tabstateview/<id>` also
   returns `"sql": "SELECT 'alpha' AS v"`.

Expected: the second change is saved by the next autosave, and the reload shows `SELECT 'alpha' AS v -- bravo`.

Measured on a local master build (SQLite metadata, examples loaded), with a Playwright script that holds only the
`PUT /tabstateview/<id>` response for a fixed time (the request reaches the server at once) and types the second
change 150 ms after the PUT is sent (it ends about 420 ms after the PUT):

| response held | edit lost (server copy and reload) |
|---|---|
| 0 ms | 0 of 3 |
| 300 ms | 0 of 3 |
| 600 ms | 3 of 3 |
| 900 ms | 3 of 3 |
| 1,500 ms | 3 of 3 |

(At 300 ms the response arrives before the last keystroke, whose newer `updatedAt` still triggers a save.)

### Screenshots/recordings

Not attached. (Sender: optionally attach a short screen recording of steps 1-5 with DevTools throttling, made by
hand.)

### Superset version

master / latest-dev

### Python version

3.12

### Node version

18 or greater

### Browser

Chrome

### Additional context

- Feature flags: defaults (`SQLLAB_BACKEND_PERSISTENCE` is on by default).
- Metadata database SQLite, examples database SQLite (`superset load-examples`), Superset run natively with
  `superset run -p 8088 --with-threads` and the frontend built with `npm run build`.
- Nothing in the server logs: every request succeeds. The lost change is never sent.
- Related, not the same: SIP-93 (#21385) introduced this sync design.
- A fix with a regression test is ready; I will open a pull request referencing this issue.
- A second, smaller case of the same kind (Format SQL overwriting text typed while the format request is pending) is
  described in a separate issue, if wanted (section C below).

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass,
a tool I work on, which replays the same steps with the server's responses delivered in different orders.

### Checklist

- [x] I have searched Superset docs and Slack and didn't find a solution to my problem.
- [x] I have searched the GitHub issue tracker and didn't find a similar bug report.
- [x] I have checked Superset's logs for errors and if I found a relevant Python stacktrace, I included it here as
  text in the "additional context" section.

(Sender: tick the first box only after searching Slack yourself; the session searched docs and the tracker only.)

---

## B. Pull request (template `.github/PULL_REQUEST_TEMPLATE.md`)

**Title:** `fix(sqllab): keep editor changes made while the tab state is being saved`

### SUMMARY

`EditorAutoSync` records when the editor tabs were last saved and only sends editors whose `updatedAt` is newer. It
took that time when the `PUT /tabstateview/<id>` response arrived, so a change typed while the request was in flight
counted as saved although the request did not carry it: it was never sent, the localStorage fallback dropped it as
well, and a reload showed the previous SQL (#nnn).

The fix takes the timestamp before the requests are sent, so only what they carried counts as saved; anything typed
during the round trip stays unsaved and goes out with the next autosave. `Math.max` keeps the value from moving
backwards if an older batch resolves after a newer one. No change in the request payloads, the server or the
number of requests when nothing is typed during a save.

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass,
a tool I work on, which replays the same steps with the server's responses delivered in different orders.

### BEFORE/AFTER SCREENSHOTS OR ANIMATED GIF

Not applicable: no UI change.

### TESTING INSTRUCTIONS

Unit test (fails without the fix: one PUT instead of two; passes with it):

```bash
cd superset-frontend
npm run test -- src/SqlLab/components/EditorAutoSync
```

Related suites, all passing with the change:

```bash
npm run test -- src/SqlLab/components/EditorAutoSync src/SqlLab/middlewares src/hooks/apiResources/sqlEditorTabs src/SqlLab/reducers src/SqlLab/actions/sqlLab.test.ts
```

Manually: throttle the network in DevTools (about 1 s latency), type in SQL Lab, wait for the autosave PUT, type
more while it is pending, wait 10 s, reload. Without the fix the second change is gone; with it a second PUT is
sent and the reload shows it.

### ADDITIONAL INFORMATION

- [x] Has associated issue: Fixes #nnn
- [ ] Required feature flags:
- [ ] Changes UI
- [ ] Includes DB Migration (follow approval process in [SIP-59](https://github.com/apache/superset/issues/13351))
  - [ ] Migration is atomic, supports rollback & is backwards-compatible
  - [ ] Confirm DB migration upgrade and downgrade tested
  - [ ] Runtime estimates and downtime expectations provided
- [ ] Introduces new feature or API
- [ ] Removes existing feature or API

---

## C. Optional second issue and pull request: Format SQL overwrites text typed while formatting

Send only after A and B have had a maintainer response, and only if they welcome it. Same issue form; the version,
Python, Node, browser, flags and checklist fields as in A.

**Issue title:** `SQL Lab: Format SQL overwrites text typed while the format request is pending`

**Bug description:**

`formatQuery` (`superset-frontend/src/SqlLab/actions/sqlLab.ts`, lines 1274-1308) posts the current SQL to
`/api/v1/sqllab/format_sql/` and, when the response arrives, sets the editor's SQL to the formatted result whatever
the editor holds by then. Text typed after pressing Format SQL (or Ctrl+Shift+F) and before a slow response arrives
is replaced.

1. Type `select 'alpha' as v from (select 1) t` in SQL Lab.
2. Press Ctrl+Shift+F (or "..." → Format SQL) and immediately type ` -- bravo` at the end.
3. With a slow response (DevTools throttling), the editor ends with the formatted statement and without
   ` -- bravo`.

Expected: the formatted text is applied only if the query was not edited meanwhile (or the edit is kept).

Measured as in A, with only the `format_sql` response held and the typing starting 150 ms after the request:

| response held | typed text lost |
|---|---|
| 0 ms | 0 of 3 |
| 300 ms | 0 of 3 (the response landed during the typing; the editor ended unformatted, with the typed text) |
| 900 ms | 3 of 3 |
| 1,500 ms | 3 of 3 |

**PR title:** `fix(sqllab): keep edits typed while the query is being formatted`

**PR SUMMARY:** `formatQuery` now applies the formatted SQL only when the editor's SQL is still the one that was
sent (`getUpToDateQuery(getState(), queryEditor).sql === sql`); otherwise the response is ignored and the user's
newer text stays. The trade-off, stated plainly: a user who types while a slow format request is pending keeps their
text unformatted and presses Format SQL again; before, they kept the formatting and lost the text (or, when the
response landed mid-typing, had the rest of their keystrokes land inside the formatted statement). The new test in `src/SqlLab/actions/sqlLab.test.ts` ("keeps the edits made while the query was
being formatted") edits the query between the request and the response and expects no `QUERY_EDITOR_SET_SQL`; it
fails without the fix. Then the disclosure paragraph as in A. **TESTING INSTRUCTIONS:**
`npm run test -- src/SqlLab/actions/sqlLab.test.ts`. **ADDITIONAL INFORMATION:** as in B, with this issue's number.

---

## Before sending (the sender, by hand)

- [ ] Search the tracker again for anything filed since 2026-11-03: issues and pull requests with "tabstateview",
  "EditorAutoSync", "autosave", "lost" + "SQL Lab", "unsaved" + "sqllab", "format sql" + "overwrite". If one covers
  this, comment there instead of filing.
- [ ] Reproduce A by hand in a browser (DevTools throttling) on current master. Do the same for C before sending C.
- [ ] `git am` the patch on a fresh branch of your fork's master, set yourself as the author, keep the
  `Generated-by: Claude Code` trailer (the ASF generative tooling guidance recommends one; adjust the wording if you
  prefer `Co-authored-by`), and read the whole diff.
- [ ] Run the unit test with and without the fix, and the related suites (commands in B).
- [ ] `pre-commit run` on the staged files (Superset's AGENTS.md asks for it before pushing). The session ran the
  oxfmt, oxlint, custom rules and type-checking hooks on the changed files (all passed; the type check needs
  `npm run plugins:build` first in a fresh checkout).
- [ ] Fill in the issue number in B ("Fixes #nnn" in two places), then open B from your fork. Superset keeps a pull
  request open at least 24 hours and needs CI green and one approval.
- [ ] Make every sentence of the AI assistance paragraph true before sending (you ran the tests and the manual
  check), and answer review questions yourself.
