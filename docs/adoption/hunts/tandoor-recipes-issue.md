# Draft issues and pull requests for Tandoor Recipes' maintainers

Drafts for the GenClass owner to send, or not. Nothing here has been posted anywhere. Facts and commands come from
`tandoor-recipes.md` in this directory; the patch is `tandoor-recipes.patch` (two commits against `develop` at
`cbb96e151fe0c57c16a4456fe1bd04230b1c1e5c`).

There are two independent bugs, so there are two issues and two pull requests. They can be sent as one PR if the
sender prefers: the commits touch different files. Tandoor's Bug Report form has these fields: Tandoor Version,
Setup, Reverse Proxy, Other, Bug description, Relevant logs. Pull requests have no template; titles follow
`fix(scope): ...`. The CLA assistant bot blocks each PR until the sender has signed at
https://cla-assistant.io/TandoorRecipes/recipes.

## Before sending (the sender, by hand)

- [ ] Read the CLA's text after logging in at cla-assistant.io and decide whether to sign it. The licence is AGPL-3.0
      with the Commons Clause, and the maintainer sells licence exceptions, so the CLA probably grants relicensing
      rights. The swarm session could not read the CLA text without a login.
- [ ] Search the tracker and the open PRs again for duplicates filed since 2026-11-03: `sync queue`, `uncheck`,
      `shopping list unchecked`, `ShoppingStore`, `pagination wrong page`, `search results page`, `VModelSelect`,
      `abort`. On 2026-11-03, the only open PR touching one of the four files was #4831 (VModelSelect's
      `updateAutoselectValue`, a different function; the patch applies next to it).
- [ ] Reproduce each bug by hand on a local Tandoor (the "manual" steps below, with DevTools throttling), and run
      `docs/adoption/hunts/tandoor-recipes/repro.mjs all 5` on the unfixed and on the fixed build. Expect 5 of 5
      wrong, then 0 of 5, for each case.
- [ ] Read the diff. Re-commit it under your own name (`git am` keeps the placeholder author "GenClass hunt"; use
      `git commit --amend --reset-author` on each commit). Rebase onto the then-current `develop`.
- [ ] Make each sentence of the disclosure paragraph true before sending (you reviewed the change and ran the checks
      yourself).
- [ ] Open the issue first, then the PR that references it. Wait for the CLA bot to pass.

---

## Issue 1

**Title:** Unchecking a shopping list item right after checking items is lost (server keeps it checked)

**Tandoor Version:** develop at cbb96e15 (2.7.2 + merge commit, 2026-10-27)

**Setup:** Manual Setup

**Reverse Proxy:** No reverse proxy

**Other:** Django `runserver` with `DEBUG=1`, SQLite, production `yarn build` of vue3; Chromium

**Bug description:**

If I check two items on the shopping list and then uncheck the first one while the first two updates are still
being sent, the uncheck never reaches the server. The list shows the item unchecked. The server still has it
checked, so after a reload (or on another device of the household) it is checked again. Instead of the uncheck, the
second item's update is sent twice.

Steps (manual):

1. Shopping list with a few entries, "Show checked entries" on (so an item can be tapped again).
2. In DevTools, throttle the network to "Slow 4G" (or any profile with about 500 ms latency).
3. Quickly tap the check of item A, then item B, then item A again (all within about half a second).
4. Watch the network panel: two `POST /api/shopping-list-entry/bulk/` requests go out (A checked, B checked).
   After they finish, a third one goes out with B checked again. A's uncheck is never sent.
5. Reload: A is checked.

Deterministic reproduction with Playwright (no extra tools; `route.fetch()` holds the first two responses until
after the third tap, then delivers them in request order):

```js
// assumes a logged-in storage state and entries "carrot" and "garlic", all unchecked
await page.addInitScript(() => localStorage.setItem("TANDOOR_DEVICE_SETTINGS", JSON.stringify({ shopping_show_checked_entries: true })));
let release; const gate = new Promise((r) => (release = r));
let firstDone; const first = new Promise((r) => (firstDone = r));
const sent = [];
await page.route("**/api/shopping-list-entry/bulk/", async (route) => {
  const n = sent.push(route.request().postData());
  if (n > 2) return route.continue();
  const response = await route.fetch();
  await gate;
  if (n === 2) { await first; await new Promise((r) => setTimeout(r, 30)); }
  await route.fulfill({ response });
  if (n === 1) firstDone();
});
await page.goto("http://localhost:8000/shopping");
const tap = (food) => page.getByRole("option").filter({ hasText: new RegExp(`^\\W*${food}\\s*$`) }).getByRole("button").first().click();
await tap("carrot");
await tap("garlic");
while (sent.length < 2) await page.waitForTimeout(20);
await tap("carrot");          // uncheck
release();
await page.waitForTimeout(3000);
console.log(sent);            // [carrot true, garlic true, garlic true]: no carrot false
// GET /api/shopping-list-entry/ → carrot checked: true
```

This gives a wrong result in 5 of 5 runs here.

Cause: `ShoppingStore._replaySyncQueue` removes each finished request from `itemCheckSyncQueue` with
`splice(index, 1)`, where `index` is the entry's position when the run started. With the queue
`[A checked, B checked, A unchecked]`, A's response removes index 0. B's response then removes index 1, which by
then is "A unchecked", so it is dropped unsent. B stays in the queue and is sent again 500 ms later. When the third
entry's 100 ms timer fires before the first responses arrive, a second run also starts while the first is in flight
and re-sends the entries that are still in flight.

The race was found with GenClass, a tool I work on, which replays the same steps with the server's responses
delivered in different orders.

**Relevant logs:**

```
POST /api/shopping-list-entry/bulk/ {"ids":[1],"checked":true}
POST /api/shopping-list-entry/bulk/ {"ids":[3],"checked":true}
POST /api/shopping-list-entry/bulk/ {"ids":[3],"checked":true}
(no {"ids":[1],"checked":false})
```

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass,
a tool I work on, which replays the same steps with the server's responses delivered in different orders.

---

## Pull request 1

**Title:** fix(shopping): keep changes made while the sync queue is running

**Body:**

Fixes #(issue 1).

`_replaySyncQueue` removed each finished entry by the index it had when the run started. Once an earlier entry was
removed the indexes shifted, so a later entry was removed without ever being sent (unchecking an item right after
checking two: the server keeps it checked), and the finished one stayed in the queue and was sent again. A run that
started while the previous one was in flight also re-sent the entries still in flight, concurrently with newer
changes to the same entries.

Changes (`vue3/src/stores/ShoppingStore.ts` only, +20 −3):
- remove the finished entry itself (`indexOf`), in both the success and the error path;
- while a run's requests are in flight, a new run returns at once. The running batch already schedules the queue
  again (`runSyncQueue(500)`) when entries remain, so changes made meanwhile are sent after it, in the order they
  were made.

Offline behaviour is unchanged: a `FetchError` still keeps the entry as `waiting_failed_before` for the existing
retry.

How I tested it (the frontend has no test setup, so this is a reproduction script plus manual steps):
- the Playwright script in the issue: before the change, wrong in 5 of 5 runs (the server keeps carrot checked;
  bulk requests sent: carrot true, garlic true, garlic true); after it, 0 of 5 (carrot true, garlic true, carrot
  false; the server keeps carrot unchecked);
- manually with DevTools throttling, the steps in the issue;
- `yarn build` passes.

The diff keeps the file's existing formatting; I did not run prettier over the file, since that would reformat most
of it.

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass,
a tool I work on, which replays the same steps with the server's responses delivered in different orders.

---

## Issue 2

**Title:** Search results, model lists and selects can show the results of an earlier request (page change, typing)

**Tandoor Version:** develop at cbb96e15 (2.7.2 + merge commit, 2026-10-27)

**Setup:** Manual Setup

**Reverse Proxy:** No reverse proxy

**Other:** Django `runserver` with `DEBUG=1`, SQLite, production `yarn build` of vue3; Chromium

**Bug description:**

Three places show the response that arrives last instead of the response to the latest request. On a slow
connection that can leave the wrong results on screen:

1. **Recipe search** (`/advanced-search`, more than one page of recipes): click page 2, then quickly page 1. If page
   2's response arrives after page 1's, the pagination says 1 but the cards are page 2's recipes.
2. **Model lists** (`/list/Food`, any model with more than two pages): click "Next page" twice quickly. If page 2's
   response arrives last, the footer says "21-30 of N" but the rows are page 2's.
3. **Model selects** (every keyword, food, unit or recipe picker in the editors): type a letter, pause for a moment,
   type the rest of a word. If the first search answers after the second, the menu lists the matches for the first
   letter, and a click picks one of those.

Steps (manual): DevTools, throttle to "Slow 4G", then do the steps above. Deterministic with Playwright by slowing
the first response only:

```js
await page.route("**/api/recipe/?*", async (route) => {
  if (new URL(route.request().url()).searchParams.get("page") === "2") await new Promise((r) => setTimeout(r, 800));
  return route.continue();
});
await page.goto("http://localhost:8000/advanced-search");
await page.getByRole("button", { name: "Go to page 2" }).click();
await page.getByRole("button", { name: "Go to page 1" }).click();
await page.waitForTimeout(2000);
// pagination shows 1, the first card is page 2's first recipe
```

Here, with 72 recipes, 38 foods and 20 keywords: the search shows page 2's "Island pie" under page 1 (5 of 5 runs).
The foods list shows "cheese" (page 2) under "21-30 of 38" (5 of 5). The Keyword select shows "baking, barbecue,
bread, breakfast, brunch" for the input "bread" when the search for "b" is slowed (5 of 5).

Cause:
- `SearchPage.vue` `searchRecipes` and `ModelListPage.vue` `loadItems` pass the signal from `useDebouncedSearch`,
  which is only aborted and replaced when the search text changes. Page changes, the per-page select and filters
  reuse the same signal, so the earlier request is never aborted.
- `VModelSelect.vue` `searchItems` has the 300 ms debounce as its only guard; any pause longer than that sends a
  second search, and `items.value` takes whichever response lands last.

The race was found with GenClass, a tool I work on, which replays the same steps with the server's responses
delivered in different orders.

**Relevant logs:**

```
GET /api/recipe/?page=2&page_size=50&query=   (answered last)
GET /api/recipe/?page=1&page_size=50&query=   (answered first)
```

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass,
a tool I work on, which replays the same steps with the server's responses delivered in different orders.

---

## Pull request 2

**Title:** fix(search): ignore responses of superseded list requests

**Body:**

Fixes #(issue 2).

The recipe search, the model lists and the model select showed the response that arrived last, not the one for the
latest request: switching pages twice quickly could show page 2's recipes under page 1, and typing in a select after
a short pause could list the results of the first letters.

Changes (+32 −10):
- `SearchPage.vue`, `ModelListPage.vue`: call `useDebouncedSearch`'s existing `abort()` before each search or page
  load, so the request still in flight is aborted and this one gets a fresh signal. Only a request that was not
  aborted clears `loading` (and scrolls to the top on the search page). `ModelListPage`'s catch now also ignores an
  abort wrapped in the client's `FetchError` (`err.cause`), as `SearchPage` already does, so an aborted page load
  shows no error.
- `VModelSelect.vue`: a counter ignores the responses of earlier searches; the latest search clears `loading`.

How I tested it (no frontend test setup, so reproduction scripts plus manual steps):
- the Playwright scripts in the issue (one slowed response each): before the change, wrong in 5 of 5 runs for the
  search, the foods list and the Keyword select; after it, 0 of 5 each;
- after the change, two quick page changes with page 2 slowed show no error snackbar and no console error on
  either page;
- manually with DevTools throttling;
- `yarn build` passes.

The diff keeps the files' existing formatting; I did not run prettier over them, since that would reformat most of
each file.

AI assistance: I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this
description; I reviewed the change and ran the tests and the manual check myself. The race was found with GenClass,
a tool I work on, which replays the same steps with the server's responses delivered in different orders.

---

## What the sender may be asked, and the answer

- *Why no unit test?* The vue3 app has no test framework yet (`docs/contribute/guidelines.md` asks for someone to set
  one up), and adding one is the kind of larger change the guidelines want discussed first. The reproduction scripts
  above are the regression check; happy to turn them into a Vitest or Playwright test if a setup is agreed.
- *Does the shopping change slow syncing?* A change made while a batch is in flight now waits for that batch; with no
  batch in flight it is sent after the same 100 ms as before.
- *What is GenClass?* An open-source tool that records a page's requests and replays the same steps with the
  responses in different orders; nothing of it is in the patch.
