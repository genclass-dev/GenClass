# Draft: Umami bug issue and PR body (list search)

Drafts for a person to file upstream if they choose to. Nothing here has been sent to umami-software/umami. Refreshed
2026-11-03 (section 15 of `umami.md`): the patch, `umami.patch` in this directory, applies unchanged to `dev` at
`c958b3772` (2026-11-02), and the test and the reproduction were re-run there.

What Umami asks of contributors (`CONTRIBUTING.md` and `.github/` on `dev` at `c958b3772`, read 2026-11-03):

- "**All pull requests should target `dev`.**" ... "PRs opened against `master` will be asked to retarget `dev`."
- "Keep PRs focused — one logical change per PR." "Ensure the project builds and lints cleanly: `pnpm install`,
  `pnpm build`, `pnpm lint`." "Fill in the PR description with what changed and why. Link any related issues."
- "Search existing issues before opening a new one." "For bugs, include reproduction steps, expected vs. actual
  behavior, and your environment (Umami version, database, browser)."
- "By contributing, you agree that your contributions will be licensed under the MIT License." No CLA or DCO sign-off.
- Issues are a form (`.github/ISSUE_TEMPLATE/1.bug_report.yml`: Describe the Bug, Database, Relevant log output, Umami
  version, how you deploy, browser); blank issues are off. There is no pull request template.
- No AI or LLM policy in `CONTRIBUTING.md`, `README.md`, `soc2.md` or `.github/`. The disclosure paragraph below is
  the swarm's own wording (`docs/adoption/swarm.md` rule 3).

## Before sending

Done by the refresh session (2026-11-03), nothing left to do unless the date moves:

- [x] Searched the tracker for duplicates since the hunt (2026-10-24): issues and pull requests with "search typed
  text", "search box reverts", "DataGrid search", "search input loses", "search typing", "debounce", "search reset",
  "search field", "SearchField", and every issue and pull request created since 2026-10-24 (20 issues, 32 pull
  requests). Nothing on this bug. Related, not the same: #4705 (server-side `LIKE` escaping in search, fixed on `dev`
  by "Fix inconsistent search. ... Closes #4705") and the open #4725 (page-size picker), which also edits `DataGrid.tsx`;
  the patch applies on top of #4725's branch too (hunks offset by 11 lines).
- [x] The patch applies to `dev` at `c958b3772` with `git apply`; the test fails 3 of 3 without the fix and passes 3 of 3
  with it; the throttled reproduction without any tool reproduces it (numbers below).
- [x] `pnpm build` and `pnpm lint` on the patched tree (CONTRIBUTING's checks): build passes; lint has the same 6
  errors, 12 warnings and 11 infos as `dev` without the change, none in the changed files; `biome check` on the two
  files is clean.

By hand, by the sender, before sending (the disclosure paragraph says you did these):

- [ ] Re-run the duplicate search for anything newer than 2026-11-03, for example
  `repo:umami-software/umami is:issue created:>=2026-11-03 search` and the same with `is:pull-request`. If #4725 has
  merged, rebase the patch onto `dev` (it applied with offsets on that branch) and re-run the test.
- [ ] Reproduce by hand in Chrome with the issue's steps (DevTools throttling, 300 ms latency).
- [ ] Run the test yourself on `dev` without and with the fix (commands under "Tests" in the PR body).
- [ ] Read the whole diff (`umami.patch`: 12 lines in `DataGrid.tsx`, one new spec file).
- [ ] File the issue with the form's fields as below, then open the PR against `dev` from your fork and put
  `Closes #<issue>` in its description. Suggested commit message, in the style of Umami's recent contributor fixes
  (`fix(reports): ...`, `fix(admin): ...`): `fix(common): keep typed search text when the URL catches up with an
  earlier search`.

---

## Issue

**Title:** Search box on list pages drops typed text when the search navigation is slow

**Describe the Bug**

On every list page with a search box (Websites, Admin > Users, Admin > Websites, Admin > Teams, team members and
websites, Links, Pixels, Boards, and the website Sessions, Events, Replays, Segments, Cohorts, Errors and revenue
sessions tables: 18 `DataGrid` call sites with `allowSearch`), text typed after a short pause can disappear. If you
type, pause long enough for the search to start (600 ms), and keep typing before that navigation has finished, the box
jumps back to what it held when the pause began. What you typed after the pause is gone, the list shows the results
for the shorter term, and no further search is made for the text you typed.

When the old value lands in the middle of a word, the characters typed after it are appended to the old value instead:
typing `shop stu` gave `shopu`, `shoptu` or `shopstu` in my runs.

To reproduce:

1. Run Umami 3.4.1 (or `dev`) and sign in; have a few websites, for example `shop studio 1` and `shop site 1`.
2. In Chrome DevTools > Network > Throttling, add a custom profile with 300 ms latency and no bandwidth limit, and
   select it (any connection where a page navigation takes a few hundred ms will do).
3. Open `/websites`, click the search box and type `shop`.
4. Wait about 0.7 s (just over the 600 ms search debounce), then type ` stu` straight away.
5. When the navigation for `?search=shop` lands, the box goes back to `shop` (or to `shop` plus whatever you typed after
   that moment, such as `shoptu`); the list shows the results for that value and no search for `shop stu` follows.

Expected: the box keeps `shop stu`, and after the debounce the URL and the list follow it (`shop studio 1` only).

Measured: headless Chromium with the network emulation DevTools throttling uses (`Network.emulateNetworkConditions`,
latency only, no request interception), production build on localhost, typing at 90 ms per key with a 700 ms pause;
10 trials per cell, counting trials where the box did not end with the full text:

<!-- refresh-throttle-table -->

With the fix below, 0 of 10 at every latency on both pages.

Cause: `src/components/common/DataGrid.tsx` keeps the box's text in local state and syncs it with the URL both ways
(added in 079cfdde, first released in v3.3.0):

```tsx
useEffect(() => {
  setSearch(queryParams?.search || '');
}, [queryParams?.search]);

useEffect(() => {
  const currentSearch = queryParams?.search || '';
  if (search === currentSearch) {
    return;
  }
  const timer = window.setTimeout(() => {
    router.push(updateParams({ search: search || undefined, page: 1 }));
  }, searchDelay || DEFAULT_SEARCH_DELAY);
  return () => window.clearTimeout(timer);
}, [queryParams?.search, router, search, searchDelay, updateParams]);
```

`router.push` is a soft navigation: `useSearchParams()` only changes when the navigation commits, after the RSC
request for the new URL has come back. If the user types more in the meantime, the commit makes the first effect copy
the older, pushed value over the newer text. The second effect then sees `search === currentSearch` and cancels the
pending push, so the newer text is never searched either. (A newer push made before the older navigation commits is
safe: the App Router discards the older navigation.)

I have a fix with a Playwright test and will open a PR against `dev`.

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass, a
tool I work on, which replays the same steps with the server's responses delivered in different orders.

**Database:** PostgreSQL

**Relevant log output:** (leave empty: nothing is logged)

**Which Umami version are you using?** 3.4.1 (also `dev` at c958b3772)

**How are you deploying your application?** Self-hosted, `pnpm build && pnpm start` (production build), PostgreSQL 16

**Which browser are you using?** Chrome (Chromium 153)

---

## Pull request

**Title:** fix(common): keep typed search text when the URL catches up with an earlier search

**Base:** `dev`

**What**

`DataGrid` copies `?search=` into its search box whenever the URL changes. When the user keeps typing while the search
navigation is still loading, that copy replaced the newer text with the value that had been pushed, and the pending
push for the newer text was cancelled. Text typed during a slow navigation was lost on all 18 searchable list pages.

This remembers the value `DataGrid` itself pushed and skips the URL-to-state copy once, when the URL arrives at that
value: the box already holds it or something newer, and the debounce then pushes the newer text as usual. Any other URL
change (back and forward, a link to a filtered list) is still copied into the box.

Closes #<issue>

**Tests**

`tests/e2e/data-grid-search.spec.ts` (Playwright, in the style of `session-modal-dismiss.spec.ts`):

- `keeps text typed while the search navigation is loading`: holds the response of the first search navigation with
  `page.route` until the second part has been typed, then checks the box, the URL and the list. Fails on `dev`
  (`Expected pattern: /[?&]search=revert(\+|%20)beta(&|$)/`, `Received string:
  "http://localhost:3000/websites?search=revert&page=1"`); passes with the fix.
- `control: going back restores the previous search`: the URL-to-box sync still works for back navigation. Passes before
  and after.

Run against a production build, one worker as in CI:

```bash
pnpm build && pnpm start
PLAYWRIGHT_SKIP_WEB_SERVER=1 npx playwright test tests/e2e/data-grid-search.spec.ts --workers 1
```

<!-- refresh-pr-checks -->

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass, a
tool I work on, which replays the same steps with the server's responses delivered in different orders.
