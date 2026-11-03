# Draft issue and PR text for Payload's maintainers

Drafts the owner can send. Factual, reproduction without GenClass, one disclosed sentence on how it was found. Not
sent by the sessions that wrote and refreshed them (see payload.md, sections 1 to 11 and "Refresh (2026-11-03)").

Refreshed 2026-11-03 against Payload's current templates and code: the issue form is now "Functionality Bug (v3)"
(`.github/ISSUE_TEMPLATE/1.bug_report_v3.yml`, the only bug form; it requires a public reproduction link), and the pull
request template asks for the target branch (`main` is v4, `3.x` takes v3 bug fixes) and `### What?`, `### Why?`,
`### How?`, `Fixes #`. Facts below are from payload `main` at `c2a3239` (4.0.0-beta.6) and `3.x` at `49b3c0b`
(3.92.1), both 2026-11-03.

## Before sending (the sender, in this order)

Done by the refresh session on 2026-11-03 (payload.md, "Refresh"):

- [x] Searched the tracker for the same bug since the hunt (issues and pull requests; `RelationshipProvider`,
  `loadRelationshipDocs`, `where[id][in]`, `unreturnedIDs`, "relationship requested twice", "relationship cell
  loading", "relationship list view duplicate requests"): nothing filed on it. Related, not the same:
  payloadcms/payload#18108 and its PR payloadcms/payload#18109 (list cells stuck on "<No Reference>", `useIntersect`,
  open); payloadcms/payload#19110 (content branching, open, maintainer's) wraps this provider and adds a `branch`
  parameter: the `main` patch applies cleanly on top of its head `a735998`.
- [x] Read CONTRIBUTING.md, AGENTS.md, the PR template, the issue forms and `.github/ai-reviewer-prompt.md` at
  `c2a3239`. No AI policy restricts contributions: CONTRIBUTING.md has an "AI Code Tool Compatibility" section and the
  repository ships configuration for Claude Code, Cursor and Copilot. No CLA or DCO.
- [x] Rebased: `payload-refresh-main.patch` (against `main` `c2a3239`) and `payload-refresh-3x.patch` (against `3.x`
  `49b3c0b`) apply with plain `git apply`; neither file changed upstream since the hunt.
- [x] The regression test, three runs each way, on `main`: fails 3 of 3 unfixed, passes 3 of 3 fixed (SQLite). The
  relationship spec as a whole: no failure with the fix that does not also happen without it (payload.md, "Refresh").
  On `3.x` the suite could not start here (MongoDB's download host is blocked in this container, and on SQLite and
  Postgres the `fields` seed itself fails, unfixed too); the two files are byte-identical to v3.92.0's, where the
  hunt's MongoDB runs gave 3 of 3 failing and 3 of 3 passing.
- [x] The reproduction without GenClass on payload 3.92.1: 6 of 6 runs request the categories batch twice, 0 of 6
  with the fix; without the delay hook 0 of 3 as served and 0 of 3 under DevTools "Slow 4G" values.

By hand (a session cannot do these):

- [ ] Make the reproduction repository from `payload-refresh/repro/` (its README has the two commands) and push it
  public under your own account; put its URL in the issue's "Link to the code that reproduces this issue".
- [ ] In it, `npm run dev`, follow the README's steps in a browser and see the second `/api/categories` request
  yourself. Run `npx payload info` there and paste the output into "Environment Info".
- [ ] Read both patches line by line; in a Payload checkout run the test unfixed and fixed (payload-refresh/README.md
  has the commands; Payload's `pnpm docker:start` gives the MongoDB the suite expects). Run `pnpm oxfmt --check` and
  `pnpm oxlint` on the two files. Before offering the `3.x` backport, run its test there too (MongoDB).
- [ ] Search the tracker once more on the day you send (the words above).
- [ ] Open the issue (the form, the fields below). Then fork payloadcms/payload, push a branch with
  `payload-refresh-main.patch` as one commit titled like the PR, open the PR against `main` with "Fixes #<issue>",
  and leave "Allow edits and access to secrets by maintainers" on (CONTRIBUTING asks for it). Offer the `3.x` patch in
  the PR ("happy to open the 3.x backport") rather than opening both at once.

## Issue

Form: **Functionality Bug (v3)**.

**Title:** List view requests the same relationship documents again while their first request is still pending

**Describe the Bug**

In the list view, relationship cells load the documents they show in batches, one request per collection
(`GET /api/<slug>?depth=0&draft=true&limit=250&where[id][in]=...`), through `RelationshipProvider`
(`packages/ui/src/elements/Table/RelationshipProvider/index.tsx`). A requested id is stored as `null` until its
response arrives, and `loadRelationshipDocs` requests every id that is still `null` (line 58 on `3.x`, 59 on `main`).
The loader runs again on every change of that state (debounced 100 ms): when another collection's batch comes back, or
when more cells mount. So while one batch is slow, each of those changes requests the pending ids again.

On a list with two relationship columns (say `category` and `author`), a slow `categories` batch is requested a second
time as soon as the `users` batch lands; after a search or sort, when new rows request their ids while an earlier
batch is still pending, the earlier ids are included again. Each repeated request is a full `where[id][in]` query over
every pending id of that collection (10 in the reproduction). The documents shown are correct in the end (every
response carries the same data), so this is a redundant-request bug, not a wrong-display bug.

Separately, and not changed by the PR below: `REQUEST` in `reducer.ts` sets a document back to `null` whenever a newly
mounted cell asks for it, even when it is already loaded, so after a search, sort or page change the new rows' batch
also fetches loaded documents again. That may be intended (fresh titles after an edit), so it is only mentioned here.
Also in `reducer.ts`, line 30: `unreturnedIDs.splice(unreturnedIDs.indexOf(doc.id), 1)` compares a numeric `doc.id`
(SQLite, Postgres) with string ids, so `indexOf` is `-1` and the last id is removed instead; when some documents are
not returned, the wrong ids are marked `false` (read from the code, not reproduced).

**Link to the code that reproduces this issue**

<the sender's public repository, made from payload-refresh/repro/>

**Reproduction Steps**

The reproduction is the `blank` template (`create-payload-app@3.92.1`, SQLite) with a `posts` collection whose list
columns relate to `categories` and `users`, a `beforeOperation` hook on `categories` that delays reads by 1 s, and an
`onInit` seed (one user, 10 categories, 10 posts).

1. `npm install`, `npm run dev`, log in at `/admin` as `dev@payloadcms.com` / `test`.
2. Open DevTools, Network panel, filter on `limit=250` (the key is sent encoded, `where%5Bid%5D%5Bin%5D`).
3. Open `/admin/collections/posts`.

`/api/categories` is requested twice with the same ten ids, the second time 112 to 211 ms after the first (nine runs),
once `/api/users` has answered and while the first `categories` request is still pending. Without the hook the two batches land within the provider's
100 ms debounce of each other and the second request does not happen. Type into the search box while a batch is still
pending: the new rows' batch includes the pending ids again.

**Which area(s) are affected?**

`area: ui`

**Environment Info**

```text
<the output of `npx payload info` in the reproduction repository>
```

(Checked on payload, `@payloadcms/ui`, `@payloadcms/next`, `@payloadcms/db-sqlite` 3.92.1, next 16.3.3, react
19.2.6, Node 22.23.4, Chromium 153. The same code path is on `main` at `c2a3239`, 4.0.0-beta.6.)

**AI assistance**

I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed
the change and ran the tests and the manual check myself. The bug was found with GenClass, a tool I work on, which
replays the same steps with the server's responses delivered in different orders: the number of these requests changed
with the order while the page did not.

## PR

Target branch: **`main`** (v4). `payload-refresh-3x.patch` is the same change for `3.x`, to offer as a backport.

**Title:** fix(ui): do not re-request relationship documents whose batch is still pending

### What?

The list view's relationship cells no longer request the same documents again while an earlier request for them is
still pending. Fixes #<issue>.

### Why?

`loadRelationshipDocs` in `RelationshipProvider` requests every id whose value is `null`, and runs again on every
change of `documents` (debounced 100 ms). An id stays `null` from its request until its response, so each change in
that window requests it again: another collection's batch landing, new rows mounting after a search or a sort.
Whenever one collection's batch answers more than 100 ms after another's (a slow query, a slower collection, an uneven
network), this is one extra `where[id][in]` request per pending batch per change.

### How?

`RelationshipProvider` keeps the ids whose request is in flight, per collection, in a ref (a `Map` from id to the batch
that requested it), and leaves them out of the next batch. A batch marks its ids before `fetch` and, when it is over,
releases the ids it still owns: a later batch (a locale change) may have taken one over. A request that throws (a
network error) is logged with `console.error` and its ids are released, so the next change requests them again; an
error response still marks them `false`, as before. The loader also checks the latest `documents` (a ref kept current
by an effect declared before the loader's), because for one run after a response has been applied the debounced copy
can still show its ids as `null` when they are no longer in flight. `reloadAll` (a locale change) still requests
everything. No change to what is rendered.

The code avoids `??=` and a `try` without `catch` in the component: `babel-plugin-react-compiler` 19.1.0-rc.3 (the
`3.x` build) bails out on both and would emit the component without memoization. Run through the package's SWC and
Babel steps, the file compiles with a `_c(19)` memo cache, on `main` (`babel-plugin-react-compiler` 1.0.0) and on
`3.x` (unfixed: `_c(15)` on both).

Test: a new test in `test/fields/collections/Relationship/e2e.spec.ts`, in its own `describe` with a `test.afterEach`
that releases the held request and removes the routes: it adds a row related to an `array-fields` document so the list
view loads two batches, holds the first batch on a promise (the pattern of the Tabs spec), waits for the other batch's
response and 500 ms more for the provider's debounced loader, releases the held batch, waits for its response, and
asserts that no `<slug>:<id>` pair was requested twice. Waiting for the other batch's response means the window is
exercised on every run. On `main` (`pnpm dev fields` on SQLite), it fails 3 of 3 runs without the fix
(`Expected length: 3, Received length: 4`, 5 and 7: the held `array-fields` id requested again after the `text-fields`
batch landed) and passes 3 of 3 with it. `oxfmt --check` passes on both files; `oxlint` reports nothing in the
provider and three warnings in the new test lines, of kinds the spec already has: `payload(no-wait-function)` on the
two `wait(500)` (asserting that a request is not sent needs a window) and `payload(no-flaky-assertions)` on the final
`toHaveLength`, which runs after both batches have answered.

It sits before the list-filter tests because `should not duplicate relationship filter options when switching
operators` leaves a relationship filter open on the shared page, and its lookup can fail after the next test's
`reInitializeDB`, so whichever test runs next can fail on the console error "There was a problem loading the document
with ID of ..." (seen on v3.92.0 with MongoDB, on both codes).

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The bug was found with GenClass, a
tool I work on, which replays the same steps with the server's responses delivered in different orders.
