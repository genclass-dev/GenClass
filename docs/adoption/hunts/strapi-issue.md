# Draft issue and pull request text for Strapi's maintainers

Drafts for the GenClass owner to send, or not. Nothing here has been posted anywhere. Facts and commands are from
`strapi.md` in this directory; the patch is `strapi.patch`.

> **Do not send (refresh, 2026-11-03).** Strapi fixed this on its default branch, `develop`, on 2026-11-02 through
> strapi/strapi#27368 (merged as `00afc67`): the admin now waits for the permissions before mounting the Content
> Manager. On `develop` at `200d300` the regression test below passes 3 of 3 without the fix and the reproduction
> script reaches the list 3 of 3 with the permissions delayed 1.5 s and 5 s; on `66d9d05`, the commit before #27368,
> the test fails 3 of 3 and the script ends on the 403 page 3 of 3 (`strapi.md` section 8). The fix is not released
> (5.60.0 has the old code; the 5.61.0 candidate, strapi/strapi#28371, does not include it). The texts below are kept,
> with their facts updated, as the record; `strapi.patch` still applies to 5.60.0, and
> `strapi-refresh/develop.patch` is its rebase onto `develop`, redundant there.
>
> If this is ever revived (a regression after #27368, or a test-only contribution a maintainer asked for), before
> sending:
>
> - [x] Search the tracker for the same bug since the hunt (done 2026-11-03, `strapi.md` section 8.3: nothing filed;
>   #27368 fixed it). Search again on the day of sending.
> - [x] Read the current contribution rules (done 2026-11-03, section 8.4: CLA required, Conventional Commits, target
>   `develop`, no AI policy; the issue template is now the YAML form `BUG_REPORT.yml`, so fill its fields from the
>   text below).
> - [x] Re-run the reproduction and the test on the current default branch (done 2026-11-03, section 8.2).
> - [ ] Reproduce by hand on your own machine (the script below, or Chrome DevTools' request blocking or throttling of
>   `GET /admin/users/me/permissions`).
> - [ ] Run the test yourself in Strapi's harness (`yarn test:e2e --setup --domains content-manager --concurrency=1`).
> - [ ] Read the whole diff, sign the CLA (cla.strapi.io), and keep the AI assistance paragraph true.

## Issue

**Title:** Content Manager redirects to its 403 page when the permissions response arrives after its init responses

### Bug report

**Required system information**

- Strapi version: 5.59.0 (`@strapi/strapi` and `@strapi/content-manager` 5.59.0, git head `c04f9bc085eb06219fa7707a484159bed60fce68`)
- Node: 22.22.0, npm 10.9.4
- Database: SQLite (the `create-strapi` quickstart)
- Operating system: Linux (headless Chromium 1243 through Playwright 1.63.0 for the reproduction)
- Admin panel served by `strapi develop`; the same code path runs in the built admin

**Describe the bug**

A logged-in super admin who opens a Content Manager URL directly (a bookmark, a browser reload, the redirect after
login) lands on `/admin/content-manager/403`, "You don't have the permissions to access that content", although they
have every permission. A reload usually shows the list. It happens whenever the response to
`GET /admin/users/me/permissions` arrives after the responses to `GET /content-manager/init` and
`GET /content-manager/content-types-settings`. On a fast local network the permissions answer first almost every
time, so the symptom is intermittent and looks random.

**Steps to reproduce the behavior**

The only thing the reproduction does is delay that one response, as a slower network would; nothing is reordered or
changed otherwise.

1. `npx create-strapi@latest my-app --javascript --use-npm --skip-cloud --no-example` (Strapi 5.59.0), add any
   collection type (an `article` with a `title`), `npm run develop`, create the first admin.
2. Log in once in a Playwright browser context and keep its storage state (or log in inside the script).
3. Run this script (Playwright 1.63, Chromium), which opens the collection type's list URL three times with the
   permissions response delayed by 1.5 s and three times without:

```js
import { chromium } from "@playwright/test";

const APP = "http://localhost:1337";
const LIST = "/admin/content-manager/collection-types/api::article.article";
const FORBIDDEN = "You don't have the permissions to access that content";
const browser = await chromium.launch();
for (const delay of [0, 1500]) {
  for (let t = 0; t < 3; t++) {
    const ctx = await browser.newContext({ storageState: "storageState.json" });
    if (delay) await ctx.route("**/admin/users/me/permissions", async (route) => {
      await new Promise((r) => setTimeout(r, delay));
      await route.continue();
    });
    const page = await ctx.newPage();
    await page.goto(APP + LIST);
    const outcome = await Promise.race([
      page.locator("table tbody tr").first().waitFor().then(() => "list"),
      page.getByText(FORBIDDEN).waitFor().then(() => "403 page"),
    ]);
    console.log(`permissions delayed ${delay} ms: ${outcome} (${new URL(page.url()).pathname})`);
    await ctx.close();
  }
}
await browser.close();
```

Result on 5.59.0:

```
permissions delayed 0 ms: list (/admin/content-manager/collection-types/api::article.article)   x3
permissions delayed 1500 ms: 403 page (/admin/content-manager/403)                              x3
```

**Expected behavior**

The list view, after the permissions have loaded. The 403 page should only be shown to a user whose loaded
permissions do not cover any content type.

**Cause** (file paths and lines at `c04f9bc`)

- `packages/core/admin/admin/src/features/Auth.tsx` lines 183 to 191 and 532 to 544: while
  `GET /admin/users/me/permissions` is pending, the auth context exposes `permissions: []` (the
  `_defaultPermissions` default) and `isLoading: true`.
- `packages/core/content-manager/admin/src/hooks/useContentManagerInitData.ts` lines 186 to 207: as soon as
  `/content-manager/init` and `/content-manager/content-types-settings` have data, `formatData` runs and authorises
  the links through `checkUserHasPermissions` (`Auth.tsx` lines 486 to 496), which filters the links' permissions
  against that empty list, so no link is authorised, and `setInitialData` stores empty link lists with
  `isLoading: false` (`modules/app.ts` line 58).
- `packages/core/content-manager/admin/src/layout.tsx` lines 66 to 105: `authorisedModels.length === 0` with
  content types to display means `<Navigate to="/content-manager/403" replace />`.
- When the permissions arrive, `checkUserHasPermissions` changes identity, `formatData` runs again and the links are
  filled in, but the router is already on `/content-manager/403`, and the redirect to the first authorised model
  (`layout.tsx` lines 113 to 118) is skipped on that path, so the user stays there.

Related: #20332 (Strapi 5 beta, "You don't have permission" on a fresh install until a refresh), closed in June 2024
through #20609; #16039 (Strapi 4.6.1, "Getting 403 when the page reloads in content-manager", closed). The ordering
case above is still present in 5.59.0 and 5.60.0. On `develop` it was fixed by #27368 (merged 2026-11-02), which
makes the admin wait for the permissions before it mounts the Content Manager.

**Fix**

`useContentManagerInitData` waits for the auth context's `isLoading` before computing the links (the Layout keeps
showing its loading state until then), 12 added lines; see the patch. With the fix the script above reaches the list
in 3 of 3 delayed loads, and the regression test below passes.

### Regression test

`tests/e2e/tests/content-manager/permissions-loading.spec.ts` (in the patch): logs in, delays the permissions
response by 1.5 s with `page.route`, opens the Article list URL and expects the "Article" heading rather than the 403
page. It fails on 5.59.0 (the heading never appears, the URL is `/admin/content-manager/403`) and passes with the
fix.

**How it was found**

By reordering the admin's responses with GenClass, an open-source library that reports races in web apps
(https://github.com/genclass-dev/GenClass-lib): on this page, 2 of 6 reordered loads ended on the 403 page, and the
delayed-response script above is the reproduction without it.

**AI assistance**

I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed
the change and ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which
replays the same steps with the server's responses delivered in different orders.

## Pull request

**Title:** fix(content-manager): wait for the user's permissions before authorising the content type links

**Body**

### What does it do?

`useContentManagerInitData` now waits for the auth context's `isLoading` to be false, besides the `init` and
`content-types-settings` responses, before it authorises the content type links and dispatches `setInitialData`.
Until then the Content Manager layout keeps its loading state instead of computing an empty link list and sending
the user to `/content-manager/403`.

### Why is it needed?

When the response to `GET /admin/users/me/permissions` arrives after the Content Manager's two init responses (a
slower network, a cold server, a large permission set), the links are authorised against the auth context's empty
default permissions, every link is refused, and `layout.tsx` redirects to the 403 page, where the user stays after
the permissions have arrived. Fixes (issue number).

### How to test it?

- `tests/e2e/tests/content-manager/permissions-loading.spec.ts` delays the permissions response by 1.5 s and opens
  the Article list URL directly: it fails on 5.59.0 and on `develop` before #27368 (`66d9d05`; the page ends on
  `/admin/content-manager/403`) and passes with this change. (Since #27368 it also passes on `develop` without it.)
- Manually: in a Playwright script or with a proxy, delay `GET /admin/users/me/permissions` by about 1.5 s and open
  `/admin/content-manager/collection-types/<uid>` while logged in.

### Related issue(s)/PR(s)

(issue number); related to #20332, #20609, #16039 and #27368.

### AI assistance

I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed
the change and ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which
replays the same steps with the server's responses delivered in different orders.

## A second, smaller observation (not in the patch)

With Playwright's `dblclick` on **Publish** in the edit view, the two clicks reach the page about 12 ms apart and two
`POST /content-manager/collection-types/<uid>/<id>/actions/publish` requests go out (24 of 24 tries), both answered
"Published document"; the same `dblclick` on **Save** sends one `PUT`. Two clicks 60 ms apart send one publish request:
the button is `disabled` right after the first click (`performPublish` sets the form's `isSubmitting` first,
`DocumentActions.tsx` line 857). So this needs a second click inside the few milliseconds before React re-renders
the button, which synthetic input produces and a human double click does not; it is noted here for completeness,
not reported as a bug. If wanted, a ref set at the start of `performPublish` and cleared in its `finally` would
close the window without a render in between.
