# Draft issue and pull request text for Grafana's maintainers

Drafts for the GenClass owner to send, or not. Nothing here has been posted anywhere. Facts and commands are from
[grafana-panel-refresh.md](grafana-panel-refresh.md) in this directory; the patch is
[grafana-panel-refresh.patch](grafana-panel-refresh.patch) (against grafana/grafana `98b107414cf6b39f4b13e9d9608f05a9716f00fc`,
2026-11-03; it touches only `public/`, which is identical at that day's `main` head `6cf5131d`).

Grafana's rules that shape these drafts (read 2026-11-03): one issue first with the "New Bug Report" template, then one
frontend pull request that closes it (`Fixes #`), titled `<Area>: <Summary>`, with tests that replicate the bug; the
CLA through the CLA assistant on the first pull request; **signed commits are mandatory** ("Unsigned commits and pull
requests will be rejected and closed. This includes pull requests that have been authored by Agents.",
CONTRIBUTING.md). Grafana has no AI-assistance policy or wording of its own, so the disclosure paragraph is the swarm's
(docs/adoption/swarm.md section 2.3), placed under "Special notes for your reviewer". Do not link #133236 or #133596:
they are other bugs.

## Before sending (the sender, by hand)

- [ ] Search the tracker again for duplicates filed since 2026-11-03: `is:issue users search page`,
      `service accounts search`, `org users pagination`, `"api/users/search"`, `stale` + `admin`.
- [ ] Run Grafana locally at the current `main`, create more than 100 users (`seed.mjs` in this repository does it
      through the HTTP API), and reproduce by hand once: in Chrome DevTools, block nothing but add a "Slow 3G" throttle,
      click page 2 and then page 3 of Administration → Users and access → Users within a second, and watch whether
      the list settles on page 3. Throttling alone does not reorder two responses of equal size, so the reliable
      reproduction is the script below; run it yourself and paste your own output.
- [ ] Apply the patch on the current `main` (`git am`), run
      `pnpm exec jest --no-watch public/app/features/admin public/app/features/serviceaccounts public/app/features/users`
      (the three new tests fail without the source change and pass with it), `pnpm typecheck`, `pnpm lint`,
      `pnpm prettier:check` and `pnpm knip` (or let CI do the last ones).
- [ ] Read the whole diff (7 files, about 230 lines, most of them tests). Make sure you can explain why the org-users
      catch block is left as it is (its `isLoading` flag means "loaded" on that page).
- [ ] Re-sign every commit with your own verified key before pushing:
      `git rebase --exec 'git commit --amend --no-edit --reset-author -S' origin/main`, and check GitHub shows
      "Verified" on the branch. Sign the CLA when the assistant asks.
- [ ] File the issue first; put its number in the pull request's `Fixes #`.

## Issue

**Template:** New Bug Report. **Title:** `Admin: User and service account lists can show an older page or search result when responses arrive out of order`

**What happened?**

On the three user-management lists, when the response for an earlier page or search arrives after the response for a
later one, the list shows the earlier result and keeps it:

- Administration → Users and access → Users, "All users" (`/admin/users`): click page 2 and then page 3; if the page-2
  response is the slower one, the table ends on page 2's users and the pager jumps back to 2. The same happens for the
  search box: type `lunar`, pause, then `-o`; the table keeps the ten `lunar` users while the box says `lunar-o`.
- Administration → Users and access → Service accounts (`/org/serviceaccounts`): the same for pages and for search.
- Administration → Users and access → Users, "Organization users" tab (`/org/users`): the same for pages; for search,
  typing a new word (`lunar`, then replacing it with `amber`) ends with an empty table ("No users found") although ten
  `amber` users exist, because the stale `lunar` list is then filtered on the client by `amber`.

Nothing on the screen says the list is out of date; a reload or another click fixes it. It needs the earlier
request to be the slower one, which happens on a loaded server or a slow connection when someone pages or types
quickly.

**What did you expect to happen?**

The list shows the page and the search the user asked for last.

**Did this work before?**

Not known. At `98b10741` none of the three thunks has a request id, an abort or a sequence check; I did not test older
versions.

**How do we reproduce it?**

1. Run Grafana from `main` (or 13.4.0-local at `98b10741`), log in as admin/admin, create 160 users and 120 service
   accounts (any way; we used `POST /api/admin/users` and `POST /api/serviceaccounts`).
2. Save this script as `repro.mjs` next to a `node_modules` with `@playwright/test` (1.63, Chromium) and run
   `node repro.mjs http://localhost:3000 /admin/users` (or `/org/serviceaccounts`, `/org/users`). It opens the list,
   clicks page 2 and then page 3 three times with only the page-2 response delayed by 1.5 s, and three times without
   the delay.

```js
import { chromium } from "@playwright/test";

const G = process.argv[2] ?? "http://localhost:3000";
const LIST = process.argv[3] ?? "/admin/users";
const SEARCH = { "/admin/users": "/api/users/search", "/org/serviceaccounts": "/api/serviceaccounts/search", "/org/users": "/api/org/users/search" }[LIST];

const browser = await chromium.launch();
const login = await browser.newContext();
await login.request.post(`${G}/login`, { data: { user: "admin", password: "admin" } });
const storageState = await login.storageState();
await login.close();

for (const delay of [0, 1500]) {
  for (let t = 0; t < 3; t++) {
    const ctx = await browser.newContext({ storageState, viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    let armed = false;
    await page.route(`**${SEARCH}?*`, async (route) => {
      if (armed && delay && new URL(route.request().url()).searchParams.get("page") === "2") {
        await new Promise((r) => setTimeout(r, delay));
      }
      return route.fallback();
    });
    await page.goto(G + LIST);
    if (LIST === "/org/users") await page.getByRole("tab", { name: "Organization users" }).click();
    const pageButton = (n) => page.locator("ol li button").filter({ hasText: new RegExp(`^${n}$`) }).first();
    await pageButton(3).waitFor();
    await page.waitForLoadState("networkidle");
    const expected = await page.evaluate(async (url) => (await (await fetch(url)).json()), `${SEARCH}?perpage=${LIST === "/org/users" ? 30 : 50}&page=3&query=`);
    const firstExpected = (expected.users ?? expected.serviceAccounts ?? expected.orgUsers)[0];
    armed = true;
    await pageButton(3).scrollIntoViewIfNeeded();
    const [b2, b3] = [await pageButton(2).boundingBox(), await pageButton(3).boundingBox()];
    await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.mouse.click(b3.x + b3.width / 2, b3.y + b3.height / 2);
    await page.waitForTimeout(delay + 1500);
    const firstRow = (await page.locator("table tbody tr").first().innerText()).replace(/\s+/g, " ").trim();
    const selected = await page.locator('ol li button[aria-current="page"]').innerText();
    const wanted = firstExpected.login ?? firstExpected.name;
    console.log(`page-2 response delayed ${delay} ms: selected page ${selected}, first row "${firstRow.slice(0, 50)}" -> ${firstRow.includes(wanted) ? "page 3 (correct)" : `NOT page 3 (page 3 starts with ${wanted})`}`);
    await ctx.close();
  }
}
await browser.close();
```

Result on `98b10741` (production frontend build, `pnpm build`), `/admin/users`:

```
SENDER: paste your own output here (the hunt's run of the same steps is in the report: 5 of 5 delayed loads ended on
page 2, 0 of 5 without the delay)
```

**Cause** (lines at `98b10741`)

- `public/app/features/admin/state/actions.ts` `fetchUsers()` (lines 291-306): `await getBackendSrv().get(url)` with no
  `requestId`, then `dispatch(usersFetched(result))` for whatever arrives. `changePage`/`changeSort` call it at once,
  `changeQuery`/`changeFilter` through a 500 ms debounce (lines 308-345); `usersFetched` also copies the response's
  `page` into the state (`reducers.ts` line 147), so the pager moves back too.
- `public/app/features/serviceaccounts/state/actions.ts` `fetchServiceAccounts()` (lines 43-84): the same, debounce
  500 ms with `leading: true` (line 86).
- `public/app/features/users/state/actions.ts` `loadUsers()` (lines 22-53): the same, debounce 300 ms (line 55); the
  page then filters the stored users by the current query on the client (`state/selectors.ts`), which hides a stale
  result when the new query only narrows the old one but not otherwise.

`backend_srv` already has what these need: a request with a `requestId` cancels the earlier in-flight request with the
same id (`public/app/core/services/backend_srv.ts` lines 547-580), as the query history and other callers use.

**Is the bug inside a dashboard panel?** No.

**Environment (with versions)?**

```
Grafana: 13.4.0-local, built from main at 98b107414cf6b39f4b13e9d9608f05a9716f00fc (backend `make build-go`
         CGO_ENABLED=0, SQLite; frontend `pnpm build`)
OS: Ubuntu 24.04 (Linux 6.18)
Browser: Chromium 1243 (headless, Playwright 1.63.0)
```

**Grafana platform?** Other (built from source). **Datasource(s)?** None.

**How it was found** (one sentence, last): The race was found with GenClass (https://github.com/genclass-dev/GenClass-lib),
which replays the same clicks with the server's responses delivered in different orders; the script above reproduces
it without it.

## Pull request

**Title:** `Admin: Ignore superseded user and service account list responses`

**What is this feature?**

A bug fix. The server-admin users list, the service accounts list and the org users list now pass a fixed `requestId`
to `getBackendSrv().get(...)` for their search request (`admin-users-search`, `service-accounts-search`,
`org-users-search`). `backend_srv` cancels the previous in-flight request with the same id when a new one starts, so a
response for an older page, sort, filter or search can no longer replace the newer one. The cancelled request
rejects with `cancelled: true`; the admin and service-account thunks return early on it (nothing logged, and the
admin list stays in its loading state until the newer response arrives).

While there: the admin users thunk's `catch` called `usersFetchEnd()` without `dispatch`, so a failed search left
the list loading; it now dispatches it. The org users `catch` is left unchanged (on that page `isLoading: true` means
"loaded", see `usersLoaded` in `users/state/reducers.ts`).

**Why do we need this feature?**

Paging or searching quickly on these lists can leave them showing an older page or search result when the earlier
response is the slower one (steps in #ISSUE). With a 1.5 s delay on only the earlier response, the list ended on the
wrong result in 5 of 5 loads on each list before the change and 0 of 5 after (0 of 5 without the delay, before and
after).

**Who is this feature for?**

Grafana admins and org admins who manage users and service accounts, on larger instances or slower connections.

**Which issue(s) does this PR fix?**:

Fixes #ISSUE

**Special notes for your reviewer:**

- Tests: `public/app/features/{admin,serviceaccounts,users}/state/actions.test.ts` drive each thunk through the app's
  store and a real `BackendSrv` whose responses the test releases in any order (a small helper,
  `public/test/helpers/backendSrvWithPendingResponses.ts`). Each clicks page 2 and then page 3, answers page 3 first
  and page 2 last, and expects page 3's rows; they fail on `main` (the store holds page 2's rows) and pass with the
  change. No snapshots, no component rendering.
- Not covered: with licensed RBAC, `fetchServiceAccounts` and `loadUsers` follow the search with
  `POST /api/access-control/users/roles/search`, which has no `requestId` here. I could not run Enterprise, so I left
  it alone; the final state is still the newest search in that case, but I would add a `requestId` there too if you
  prefer.
- A separate thing I noticed, not changed here: the org users search box regex-escapes the query (`FilterInput`'s
  default `escapeRegex`), so a search containing `-` or `.` (`lunar-o`, an email) sends `lunar\-o` and finds nobody,
  while the server-admin list (which passes `escapeRegex={false}`) finds the users.

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass, a
tool I work on, which replays the same steps with the server's responses delivered in different orders.

Please check that:
- [x] It works as expected from a user's perspective.
- [ ] If this is a pre-GA feature, it is behind a feature toggle. (not applicable: a bug fix)
- [ ] The docs are updated, and if this is a notable improvement, it's added to our What's New doc. (not applicable)
