# EverShop: draft issue and pull request (not sent)

Drafts for `evershopcommerce/evershop`, prepared on 2026-11-03 against `dev` at `6ec59f9`
(report: `evershop-admin-checkout.md`, patch: `evershop-admin-checkout.patch`). EverShop has no CLA, DCO or AI
policy (CONTRIBUTING.md, `.github/` templates, CODE_OF_CONDUCT.md read on 2026-11-03) and no issue-first rule; the
issue goes first anyway so the owner, who often reimplements evidenced fixes himself, has the bug in his own words
either way. Contributions are under GPL-3.0 (CONTRIBUTING.md).

## Before sending (the sender)

- [ ] Search the tracker for duplicates filed since 2026-11-03: `is:issue cart total quantity`, `syncCartWithServer`,
      `stale cart`, `shipping methods country`, `dedup`; and open pull requests touching `CartContext.tsx`.
- [ ] Check that `dev` still has the code: `syncCartWithServer` in `CartContext.tsx` calling
      `client.query(query, {}, { requestPolicy: 'network-only' })` without a queue, and `fetchAvailableShippingMethods`
      dispatching every answer. Rebase the patch the day it is sent (`git am --3way`); `dev` moves daily.
- [ ] Reproduce once yourself with the issue's snippet (or `docs/adoption/hunts/evershop-admin-checkout/repro.mjs`),
      and watch it in a headed browser (`chromium.launch({ headless: false })`): the line at quantity 2 with its old
      price. DevTools throttling does not reproduce it (it slows the update as much as the query: 0 of 12 loads at
      400 and 800 ms latency in the hunt), so do not offer it as the way to see it.
- [ ] Run the tests yourself: `git am` the patch, `npm run compile:dev`, then
      `ALLOW_CONFIG_MUTATIONS=true NODE_OPTIONS=--experimental-vm-modules node node_modules/jest/bin/jest.js packages/evershop/dist/components/frontStore/cart`
      (13 tests pass); revert `CartContext.tsx` only and see `cartSyncOverlap` and `shippingQuoteOrder` fail.
- [ ] Read the diff (39 lines in `CartContext.tsx`, two test files). Fill in your own Node, OS and browser in the
      issue's Background.
- [ ] Decide whether to send the shipping fix in the same pull request (as drafted) or as a second one; the owner may
      prefer one bug per PR.
- [ ] Fork, branch `fix/cart-sync-shared-query` from `dev`, `git am` the patch (it carries a placeholder author: set
      yours with `git commit --amend --reset-author` on both commits), push, open the PR against `dev`, link the issue.
- [ ] Do not use `--no-verify` (the project's CLAUDE.md: never bypass husky).

---

## Issue

**Title:** `[BUG] Cart shows the old price and totals after changing two lines quickly`

**Describe the bug**
On the cart page, when two cart changes are made close together (the "+" of two lines within half a second, or "+"
on one line and Remove on another) and the first change's cart query answers after the second change's request, the
page can end with the old cart: the changed line
shows its new quantity next to its old price, and the subtotal and total are the old ones (in the steps below,
"Ceramic Coffee Cup - White" at quantity 2 for $15.00, subtotal and total $39.00, while the server's cart is $30.00
and $54.00). It stays like that until the next change or a reload.

The cause is in `syncCartWithServer` (`packages/evershop/src/components/frontStore/cart/CartContext.tsx`): after each
change it runs `client.query(query, {}, { requestPolicy: 'network-only' })`. urql gives a query the result of an
identical query that is already in flight (`dedupExchange`, in the default exchanges of the storefront's client), so
when the second change's request returns while the first change's cart query is still on its way, the second sync
gets that first query's answer, which the server gave before it had the second change. `network-only` does not
prevent this. Each line's quantity is debounced separately (500 ms in `ItemQuantity.tsx`), so two lines changed
within half a second send their updates about that far apart.

A related case in checkout: `fetchAvailableShippingMethods` puts every answer into the cart state, so when the
address changes again while a quote is on its way (country United States, then Canada) and the older quote answers
last, the Canadian address lists the United States methods. Changing the province or postal code afterwards re-quotes
and repairs it; it stays when the country is the last field changed.

**To Reproduce**
It needs the cart query to answer more slowly than the second update (the cart query is the bigger request and the
server computes the whole cart for it; on a real connection the order depends on the server's load and the
network). Throttling the whole network in DevTools does not: it slows the update
as much as the query. The simplest way is to delay only the cart query's response, for example with Playwright:

```js
// a guest cart with CUP-001-WHT and PEN-002-BLK at quantity 1 (npm run seed), then:
await page.goto('http://localhost:3000/cart');
await page.route('**/api/graphql', async (route) => {
  const response = await route.fetch();
  await new Promise((r) => setTimeout(r, 800)); // the cart query answers 800 ms late
  await route.fulfill({ response });
});
const plus = (i) => page.locator('.cart__item').nth(i).locator('.inline-flex.items-center.rounded-md button').nth(1);
await plus(0).click();
await page.waitForTimeout(150);
await plus(1).click();
```

1. Add two products to the cart, each at quantity 1, and open `/cart`.
2. Delay the response to `POST /api/graphql` (above).
3. Click "+" on the first line, then within half a second "+" on the second line.
4. When the requests have finished, one line shows quantity 2 with its quantity-1 price, and the subtotal and total
   are too low. There is one `POST /api/graphql` for the two changes.
5. Reload: the cart is right.

For the shipping case: set up two shipping zones (United States and Canada) with one method each, open `/checkout`,
pick United States, about a second later pick Canada, with the United States quote slow (for example a Playwright
route delaying the `GetCartShippingMethods` answer for `country: "US"` by 2.5 s): the methods listed are the United
States ones.

**Expected behavior**
After the last change, the cart page shows the server's cart: each line's price and the totals match its quantity.
The shipping methods are those of the address as it is now.

**Screenshots**
None (the numbers above are from the page text).

**Background (please complete the following information):**
 - NodeJS Version: 22.23.4 (sender: your version)
 - Postgres Version: 16.15
 - EverShop Version: 2.3.0, `dev` at 6ec59f9 (2026-11-03)
 - OS: Ubuntu 24.04 (sender: yours)
 - Browser: Chromium 1243 headless (Playwright 1.63); sender: the browser of the manual check

**Additional context**
Measured with that script: stale in 3 of 3 loads with the 800 ms delay, right in 3 of 3 without it (and in 12 of 12
with the whole network slowed by 400 or 800 ms instead); the shipping case in 3 of 3 with the United States quote
2.5 s late, 0 of 3 without. PR #1195 (merged 2026-11-01) made the sync await the real fetch; this is a different
case, needing two changes close together. A pull request with a fix and Jest tests follows.

A separate note, not part of the fix: `checkout()` in `CheckoutContext.tsx` retries the order POST on a network error
(`retry()`, 3 retries). When the server has created the order and the response is lost, the retry is answered
"404 Invalid cart" (the cart is no longer active) and the shopper sees a failed checkout for an order that exists. No
duplicate order is created (checked 3 times).

I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed
the change and ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which
replays the same steps with the server's responses delivered in different orders.

---

## Pull request

**Title:** `fix(cart): fetch the cart after each change, and keep the latest shipping quote`

**Body:**

## PR Checklist
Please check if your PR fulfills the following requirements:

- [x] Tests for the changes have been added (for bug fixes / features)

## PR Type
What kind of change does this PR introduce?

<!-- Please check the one that applies to this PR using "x". -->
- [x] Bugfix
- [ ] Feature
- [ ] Code style update (formatting, local variables)
- [ ] Refactoring (no functional changes, no api changes)
- [ ] Build related changes
- [ ] CI related changes
- [ ] Other... Please describe:

## What is the current behavior?
<!-- Please describe the current behavior that you are modifying, or link to a relevant issue. -->

Two cart changes close together (the quantities of two lines, or a quantity and a remove) each fetch the cart again
with `client.query(..., { requestPolicy: 'network-only' })`. urql gives a query the result of an identical one
already in flight, so the second change can get the first change's fetch, answered before the second change reached
the server: the cart page keeps that line's old price and the old totals until the next change or a reload.

In checkout, `fetchAvailableShippingMethods` stores every answer, so an older address's quote that answers last
replaces the newer address's methods.

Issue Number: #<issue>


## What is the new behavior?

- `syncCartWithServer` queues its fetches: each one starts once the one before it has finished, so its query is sent
  after its own change's response and is never merged into an older query. A single change is unchanged; a second
  change close behind a first waits for the first's cart query.
- `fetchAvailableShippingMethods` numbers its quotes and keeps only the latest one's answer; only the latest clears
  `fetchingShippingMethods`.
- Tests: `cart/tests/unit/cartSyncOverlap.test.tsx` uses a real urql client (default exchanges, `fetch` faked) so
  urql's own deduplication is what it exercises: two updates, the first query answered with the cart before the second
  update, then a second query must be sent and the state must end with both changes.
  `cart/tests/unit/shippingQuoteOrder.test.tsx` answers a United States and a Canada quote in the reverse order and
  expects Canada's methods. Both fail on `dev` (3 of 3 runs) and pass with the change.
- `npm test`: everything else passes except `lib/middleware/tests/unit/delegate.test.js` "Middleware function return
  desired value", which fails the same way on `dev` without this change.

## Does this PR introduce a breaking change?
- [ ] Yes
- [x] No

<!-- If this PR contains a breaking change, please describe the impact and migration path for existing applications below. -->


## Other information

Checked on a production build (`npm run build && npm run start`) with a Playwright script that delays only the cart
query's response by 800 ms: before, the page was stale in 3 of 3 loads; after, right in 3 of 3. For the shipping
quote delayed 2.5 s: United States methods for a Canadian address in 3 of 3 before, Canada's in 3 of 3 after.

I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed
the change and ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which
replays the same steps with the server's responses delivered in different orders.
