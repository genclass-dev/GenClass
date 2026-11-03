# Vendure: draft issue and draft pull request

Drafts for the owner to send. Nothing here has been posted to vendurehq/vendure. Evidence and method:
[`vendure.md`](./vendure.md) (refreshed 2026-11-03, section 9). The patch: [`vendure.patch`](./vendure.patch) (against
`master` at `f97b187`, 2026-11-02; it also applies unchanged to the hunt's `aba3e9c`).

## New issue or a comment on #2117: file a new issue

Checked 2026-11-03. [vendurehq/vendure#2117](https://github.com/vendurehq/vendure/issues/2117) is still open, labelled
`@vendure/admin-ui`, `P4: low`, `type: bug`, `contributions welcome`, assigned to michaelbromley, with no linked branch
or pull request. Its last comment is still dlhck's of 2025-04-02: "Will be included in a future release of the new
`@vendure/dashboard`. Happy for community contributions to the legacy `@vendure/admin-ui`". The only later activity is
a label added and removed on 2026-07-17, with no comment.

File a **new issue** for the dashboard, and do not comment on #2117:

- Vendure's CONTRIBUTING asks for a bug fix to start with "an issue detailing the bug" in which you "indicate that you
  intend to fix it", and its `AGENTS.md` asks for `Fixes #ISSUE_NUMBER` (or `Relates to #...`) in the commit body. The
  patch fixes the React dashboard only. `Fixes #2117` would close the admin-ui report, which still reproduces (report
  section 6). A dashboard issue gets the dashboard label and a number the PR can close.
- [vendurehq/vendure#4884](https://github.com/vendurehq/vendure/issues/4884) (closed 2026-09-30 by
  [#5007](https://github.com/vendurehq/vendure/pull/5007)) says "the React dashboard does avoid the double-click". On
  3.8.1 it does not. A new issue puts that on record with the steps. A comment on a two-year-old admin-ui issue would not.
- Mentioning #2117 and #4884 in the new issue adds the cross-reference to both threads, so no comment is needed.

## Before filing (what the 2026-11-03 refresh did, and what is left)

Done by the refresh session (report section 9):

- [x] Searched the tracker for anything filed on the same bug since 2026-10-24. Nothing on the dashboard's double submit
      was found. The search covered issues and pull requests for "double click", "double-click", "double submit",
      "twice dashboard create", "duplicate dashboard create", "isPending createMutation", "submit twice" and
      "useDetailPage isPending". The related #4884 and #5007 are linked below.
- [x] Read the current CONTRIBUTING.md, the issue and PR templates, `.github/ISSUE_TEMPLATE/config.yml` (blank issues
      off) and the repository's `AGENTS.md`. Neither CONTRIBUTING nor AGENTS.md has an AI policy. Many recent `master`
      commits carry a `Co-authored-by: Claude` trailer (36 of the 270 commits since 2026-10-01). Contributions need the
      CLA, which a bot asks you to sign when the PR opens. There is no DCO.
- [x] Rebased the patch on `master` `f97b187` (it applied unchanged). Following Vendure's `AGENTS.md`, the e2e test
      moved from a new `e2e/tests/regression/` file into the existing `e2e/tests/catalog/collections.spec.ts`:
      "`tests/regression/` — **only** for tests that genuinely don't fit any existing suite".
- [x] Ran the unit tests and the e2e tests three times each on the unfixed code and three times each on the fixed code,
      and re-ran the reproduction without GenClass on both. Ran `check-types`, the dashboard unit suite, and eslint and
      prettier on the changed files.
- [x] Rewrote the version, commit, environment and numbers in the drafts below. Line numbers are unchanged since
      `aba3e9c`.

Left for the sender, by hand:

- [ ] Search the tracker once more on the day you file (the queries above), in case something was filed after
      2026-11-03.
- [ ] Reproduce by hand: run the dev server, double-click **Create** on a new collection, and see two collections and
      two `CreateCollection` requests (steps in the issue below).
- [ ] Apply the patch to a fresh fork at current `master`. Replace `#2117` with the new issue's number in the four
      files (`sed -i 's/#2117/#NNNN/g'` on the paths in the patch). Run the tests yourself:
      `npx vitest run src/lib/framework/form-engine/use-generated-form.spec.tsx`, then the e2e command in the PR
      text.
- [ ] Read the whole diff (240 added and 9 removed lines in four files).
- [ ] File the issue, then open the PR against `master` from your fork. Sign the CLA when the bot asks.

---

## Draft issue (template: `.github/ISSUE_TEMPLATE/bug_report.md`)

**Title:** `[dashboard] Double-clicking Create on a detail page creates the entity twice`

**Describe the bug**

On every detail page built with `useDetailPage` (collections, products, facets, customers and the rest), a quick
double-click on the **Create** button sends the create mutation twice and creates two entities. A double-click on
**Update** sends the update mutation twice. This is the dashboard counterpart of #2117 (legacy admin-ui). It is also
not covered by #5007: that fix stops concurrent updates from writing duplicate translation rows (#4884), but a double
Create still makes two separate entities. #4884 says "the React dashboard does avoid the double-click", and on 3.8.1
that is not the case.

Two things combine:

1. `useDetailPage` returns `isPending: updateMutation.isPending || detailQuery?.isPending`
   (`packages/dashboard/src/lib/framework/page/use-detail-page.ts`, line 446). `createMutation.isPending` is not part
   of it, so the Create button (`disabled={... || isPending}`) stays enabled while `create*` is in flight.
2. Even where `isPending` is wired in (the Update button), it cannot stop a fast second click. The form's submit
   handler (`packages/dashboard/src/lib/framework/form-engine/use-generated-form.tsx`, lines 293 to 351) awaits
   `form.trigger()` (line 297) before `form.handleSubmit` (line 350) calls `onSubmit`, which calls `mutate()`
   (`use-detail-page.ts` lines 418 and 430). The button only becomes disabled on the render after `mutate()`. A
   second click in that window starts a second submit with the same values.

**To Reproduce**

1. Run the dev server: `cd packages/dev-server && DB=sqlite bun run populate && DB=sqlite bun run dev:direct`, log in
   to http://localhost:5173/dashboard as superadmin / superadmin.
2. Go to Catalog > Collections > New collection and type a name.
3. Double-click **Create**.
4. Open the collection list: there are two collections with that name (two slugs, `name` and `name-2`), and the
   network tab shows two `CreateCollection` requests.

It also reproduces with Playwright's plain `locator.dblclick()`. The regression test in the linked PR fails on
`master` in 3 of 3 runs for Create and 3 of 3 for Update, with two mutations each time.

**Expected behavior**

One create (or update) mutation per double-click, and one entity.

**Actual behavior**

The mutation is sent twice, and Create makes two entities. Measured on `master` (`f97b187`, 3.8.1) with the SQLite
dev server and the production build of the dashboard. Each trial sent two presses through Chrome DevTools Protocol,
0, 30, 80 or 150 ms apart, 3 trials per page and gap:

- **Create** (Collection, Product, Facet, Customer): 21 of 48 trials sent `create*` twice. That was 12 of 12 at a 0 ms
  gap, 9 of 12 at 30 ms, and none at 80 or 150 ms. The trials left 15 duplicate collections, products and facets in the
  database.
- **Update**: 25 of 48 trials sent the update twice. That was 12 of 12 at 0 ms, 9 of 12 at 30 ms, and 4 of 12 at
  80 ms.

The duplicates get de-duplicated slugs or codes (`name`, `name-2`), so nothing fails visibly. On Customer the server
rejects the second create (the email address is taken), so only the request is duplicated there. The window is about
one request long, so it grows with latency. With 100 ms added to every request, a measurement on 2026-10-24 found
doubled creates on every page at an 80 ms gap.

**Environment**

- @vendure/core version: 3.8.1 (`master` at `f97b187`, 2026-11-02)
- Nodejs version: 22.23.4
- Database: SQLite (dev server, `DB=sqlite`)
- Operating System: Linux
- Browser: Chromium 153
- Package manager: bun 1.4.4

**Workaround**

Click once and wait for the toast.

**Additional context**

I intend to fix this and have a patch ready. It adds `createMutation.isPending` to `isPending`. It also adds a guard in
`useGeneratedForm`'s submit handler that ignores a submit while the previous one is being validated, or while the
promise returned by `onSubmit` is pending (`useDetailPage` returns its `mutateAsync` promise). The patch adds no
dependency. The only API change is that `GeneratedFormOptions.onSubmit` may also return a promise. It includes unit
tests in `use-generated-form.spec.tsx` and a Playwright test in `e2e/tests/catalog/collections.spec.ts`. Related:
#2117 (the same bug in the legacy admin-ui, which this does not touch), #4884 and #5007.

**AI assistance:** I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass, a
tool I work on, which replays the same steps with the server's responses delivered in different orders.

---

## Draft pull request (template: `.github/pull_request_template.md`)

**Base:** `master`. **Title (conventional, lower-case subject):** `fix(dashboard): submit a detail form only once on double-click`

**Commit message** (one commit, body per Vendure's `AGENTS.md`):

```
fix(dashboard): submit a detail form only once on double-click

Fixes #NNNN. Relates to #2117.
```

(Many Vendure commits also carry a `Co-authored-by:` trailer for Claude. Adding one is optional and fits the
disclosure below.)

# Description

Fixes #NNNN. Relates to #2117 (the same bug in the legacy admin-ui, not touched here).

A double-click on Create on any `useDetailPage` page created the entity twice. A double-click on Update sent the
update twice:

- `useDetailPage` left `createMutation.isPending` out of the `isPending` it returns, so the Create button stayed
  enabled while the create mutation was in flight.
- Even with `isPending` wired in, the submit handler in `useGeneratedForm` awaits validation before it calls
  `onSubmit`, and the button is only disabled on the next render, so a fast second click still submitted again. Adding
  `createMutation.isPending` alone does not fix it. With only that change, the new e2e test still failed 10 of 10
  runs in an earlier measurement (2026-10-24).

Changes:

- `useGeneratedForm`: the submit handler ignores a submit while the previous one is being validated, and while the
  promise returned by `onSubmit` is pending. `GeneratedFormOptions.onSubmit` may now return a promise. If it returns
  nothing, the only change is the guard during validation.
- `useDetailPage`: `onSubmit` returns the create or update `mutateAsync` promise. Errors still go to the mutation's
  `onError`, and the rejection is caught. `isPending` now includes `createMutation.isPending`, so the Create button is
  disabled while the request is in flight, as the Update button is.

Tests:

- `use-generated-form.spec.tsx` covers three cases: a second submit during validation is ignored; further submits
  are ignored until the `onSubmit` promise settles; a submit that fails validation releases the guard. The first two
  fail on `master`.
- `e2e/tests/catalog/collections.spec.ts`, `Issue #NNNN: Double-click on Create or Update submits once`, has two
  tests. `dblclick()` on Create must create one collection, checked on the wire and through the Admin API.
  `dblclick()` on Update must send one update. On `master` both failed 3 of 3 runs. With the fix both passed 3 of 3.

Checked locally on `master` `f97b187`: `npm run check-types`, eslint and prettier on the changed files, the dashboard
unit suite (972 passed, 4 skipped) and the new e2e tests:
`CI=true VITE_TEST_PORT=5176 npx playwright test --config e2e/playwright.config.ts e2e/tests/catalog/collections.spec.ts --reporter=list`.

# Breaking changes

None. `GeneratedFormOptions.onSubmit` widens from `=> void` to `=> void | Promise<unknown>`.

# Screenshots

Not applicable.

# Checklist

📌 Always:
- [x] I have set a clear title
- [x] My PR is small and contains a single feature
- [x] I have checked my own PR

👍 Most of the time:
- [x] I have added or updated test cases
- [ ] I have updated the README if needed (not needed)

**AI assistance:** I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass, a
tool I work on, which replays the same steps with the server's responses delivered in different orders.
