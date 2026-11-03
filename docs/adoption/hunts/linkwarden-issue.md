# Draft issue and pull request text for Linkwarden's maintainers

Drafts for the GenClass owner to send, or not. Nothing here has been posted anywhere. Facts and commands are from
[linkwarden.md](linkwarden.md) in this directory; the patch is [linkwarden.patch](linkwarden.patch), against
`linkwarden/linkwarden` `dev` at `45325d45c5326f4418159294dcafdafbb95fbd62` (2026-10-19).

## Before sending (for the sender)

- [ ] **Contact first.** Linkwarden's README asks contributors to "please stay in touch with @daniel31x13 before
      starting". Send him a short note (GitHub or the project's Discord) with the issue text below and ask whether he
      wants the pull request; send the issue and the pull request only after that, or after a few days without an
      answer.
- [ ] Search the tracker again for duplicates filed since 2026-11-03: `repo:linkwarden/linkwarden theme`,
      `repo:linkwarden/linkwarden "font size"`, `repo:linkwarden/linkwarden preference`, `dark mode reverts`,
      issues and pull requests, open and closed.
- [ ] Reproduce it yourself: run the issue's script on `dev` (expect `page: dark`, `server: light`), then with the
      patch applied (expect `page: light`, `server: light`). DevTools throttling does not reorder the two responses,
      so it is not a manual reproduction.
- [ ] Run `yarn vitest run packages/router/user.test.ts` on `dev` without the patch (1 failed, 1 passed) and with it
      (2 passed).
- [ ] Read the whole diff (one hook, one new test file) and be able to explain the `context.update` check.
- [ ] Record the before/after video the PR template asks for: the issue's script with `chromium.launch({ headless:
      false })` and Playwright's `recordVideo` context option (before, the page ends dark; after, it ends light).
- [ ] Tick the template's boxes only for what you did yourself; pick the AI usage level honestly ("Heavy" fits: the
      investigation, the fix and the test were drafted by Claude Code and reviewed by you).
- [ ] Branch from `dev` and open the pull request against `dev` (`check-branch.yml` fails any pull request into
      `main` whose head is not `dev`).

## Issue (template: Bug Report, label `bug`)

**Title:** Theme and reader text settings can revert to an older value when two changes are made quickly

**Describe the bug**

When two preference changes are made before the first one's response is back (the light/dark switch clicked twice, or
the reader view's font size "+" clicked a few times), the page can
end on an older value than the one the user picked last, while the server has stored the last one. For example: the
page is light, the user toggles to dark and straight back to light; the server stores "light", but the page turns dark
and the switch shows dark until the next reload.

It happens whenever the response to the earlier `PUT /api/v1/users/:id/preference` arrives after the response to the
later one, which a slow or busy connection does from time to time. `useUpdateUserPreference`
(`packages/router/user.tsx`) applies each change optimistically and then, in `onSuccess`, writes that request's
response over the `["user"]` cache and sets `data-theme` on `<html>` from it. Responses can arrive in any order, so the
earlier change's response, arriving last, overwrites the newer state.

**To Reproduce**

The responses have to come back in reverse order, which a real connection does only now and then (DevTools
throttling slows both requests alike, so it does not reorder them). The script below makes it happen every time by
delaying only the answer to the first preference request; the request itself reaches the server at once, and nothing
else is reordered or changed.

1. Run Linkwarden from `dev` (`yarn web:dev`), log in as a user whose theme is light, and save the session as
   Playwright storage state.
2. Open any link's reader view (`/preserved/<id>?format=3`).
3. Click the sun/moon switch in the reader view's top bar twice, quickly (light → dark → light), with the first
   response delayed (script below).
4. See the page turn dark and the switch show dark after both requests finish. Reload: the page is light (the server
   stored light).

Scripted (Playwright, run here with 1.63.0; logged-in storage state; delays only the first preference response by 1.5 s):

```js
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: "http://localhost:3000", storageState: "storage-state.json" });
let seen = 0;
await ctx.route(/\/api\/v1\/users\/\d+\/preference$/, async (route) => {
  const res = await route.fetch(); // the server handles the request now
  if (++seen === 1) await new Promise((r) => setTimeout(r, 1500)); // only its answer is late
  await route.fulfill({ response: res });
});
const page = await ctx.newPage();
await page.goto("/preserved/1?format=3"); // any link id
const toggle = page.locator("label:has(input.theme-controller)").first();
await page.waitForLoadState("networkidle");
await toggle.click(); // light → dark
await toggle.click(); // dark → light
await page.waitForTimeout(4500);
console.log("page:", await page.evaluate(() => document.documentElement.getAttribute("data-theme")));
const me = await (await ctx.request.get("/api/v1/auth/session")).json();
const user = await (await ctx.request.get(`/api/v1/users/${me.user.id}`)).json();
console.log("server:", user.response.theme);
await browser.close();
```

Output on `dev` at `45325d4`: `page: dark`, `server: light` (and 3 of 3 trials of the same steps ended dark with
light stored; without the delay, 3 of 3 ended light).

The same happens with the reader view's font size: "+" three times from 20px, with the first response delayed, shows
22px while the server stored 26px (3 of 3 trials; 26px in 3 of 3 without the delay).

**Expected behavior**

The page shows the last value picked (light; 26px), the same as the server stores.

**Screenshots**

(the sender's before/after recording)

**Desktop (please complete the following information):**
 - OS: Linux (Ubuntu 24.04)
 - Browser: Chromium headless shell (Playwright 1.63.0's build 1243)
 - Version: Linkwarden `dev` at `45325d45c5326f4418159294dcafdafbb95fbd62` (2026-10-19), `yarn web:dev`

**Smartphone (please complete the following information):**
 - Not tested (the hook lives in `packages/router`, shared with the mobile app; whether the mobile app calls it in
   the same way was not checked).

**Additional context**

- Root cause: `packages/router/user.tsx`, `useUpdateUserPreference`: `onSuccess` writes every response with
  `queryClient.setQueryData(["user"], data)` and sets `data-theme` from it, whatever order the responses come in;
  `onMutate` already applies each change optimistically, so the latest choice is in the cache until an older response
  replaces it.
- `useUpdateUser` in the same file has the same shape (optimistic write, then the response written on success); it is
  what the sidebar's collection drag and drop and the settings pages call. It was not exercised here, so it is not in
  the fix.
- The profile menu's Theme submenu (`ProfileDropdown.tsx`) and `MainLayout.tsx` call the same hook; they were not
  tried, but two quick picks there go through the same `onSuccess`.
- A fix is ready as a pull request (one hook, one new Vitest file), if you want it.

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass, a
tool I work on, which replays the same steps with the server's responses delivered in different orders.

## Pull request (template: `.github/pull_request_template.md`), base `dev`

**Title:** fix(router): keep the latest preference when update responses arrive out of order

## What does this PR do?

`useUpdateUserPreference` writes each response over the `["user"]` cache (and sets `data-theme` from it) in
`onSuccess`. When two preference changes are in flight together (the light/dark switch clicked twice, a few font size
steps in the reader view) and the earlier one's response arrives last, the page ends on the older value while the
server has the newer one. This change numbers the updates in `onMutate` and lets only the latest one write its
response; an older response no longer replaces a newer choice. The optimistic update, the request and the single-change
behaviour are unchanged.

- Fixes #XXXX (GitHub issue number)

Test: `packages/router/user.test.ts` (Vitest, jsdom, colocated like the other `*.test.ts`) renders the hook in a
`QueryClientProvider`, sends "dark" then "light", and answers the two `PUT`s in both orders. Without the fix the
out-of-order case fails (`expected 'dark' to be 'light'`); with it both pass.

## Visual Demo

A visual demonstration is strongly recommended, for both the original and new change **(video / image)**.

#### Video Demo (if applicable):

- (the sender's recording: reader view, switch clicked twice with the first response delayed; before: ends dark,
  after: ends light)

#### Image Demo (if applicable):

- (optional)

## AI Assistance (Required)

We allow AI-assisted development, but reviewers need transparency to assess risk, maintainability, and correctness.

#### AI usage level (check one)

- [ ] None (no AI used)
- [ ] Light (spellcheck/rewording/comments/docs only)
- [ ] Medium (AI suggested small code changes/snippets that I adapted)
- [ ] Heavy (AI significantly shaped the implementation or architecture)

#### Which tool(s) where used?

- Claude (Claude Code), and GenClass (a tool I work on) to find the race. I used Claude (Claude Code) to investigate
  this, write the fix and the tests, and draft this description; I reviewed the change and ran the tests and the
  manual check myself. The race was found with GenClass, which replays the same steps with the server's responses
  delivered in different orders.

## What was verified by the author?

<!-- Add what you personally checked to ensure correctness and safety. -->

- [ ] I reviewed **and** understood all AI/human generated code
- [ ] I validated behavior locally (tests/manual verification)
- [ ] I checked edge cases and failure modes

## Submission Acknowledgement

- [ ] I acknowledge that a decent size PR without self-review might be rejected
