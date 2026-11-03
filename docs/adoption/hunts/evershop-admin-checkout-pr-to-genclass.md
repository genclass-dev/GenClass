**Title:** adopt(evershop-admin-checkout): ready to send: stale cart totals after two quick changes, and stale shipping quotes, in EverShop

**Status: ready to send** (the sender has only the by-hand items of the "before sending" list left).

**What was found.** On EverShop's cart page, two changes close together (the "+" of two lines within the 500 ms
quantity debounce, or a "+" and a Remove) can leave the page with an earlier cart: urql merges the second change's
cart query into the first one's, still in flight and answered before the second change reached the server, so a line
shows its new quantity at its old price with the old totals ($39.00 instead of $54.00) until the next change or a
reload. A second, smaller race in checkout: an older shipping quote that answers last replaces the newer address's
methods (a Canadian address listing the United States method). Both are fixed in `CartContext.tsx` with Jest tests in
the package's style.

**Files.**
- `docs/adoption/hunts/evershop-admin-checkout.md`: the report (setup, every scenario with its verdict, negatives
  included, the evidence in causal order, root cause, fixes, tests, fixed variant, problems with GenClass, time).
- `docs/adoption/hunts/evershop-admin-checkout.patch`: two commits for `evershopcommerce/evershop` `dev` at `6ec59f9`
  (`git am`; checked to apply cleanly there), the fixes and `cartSyncOverlap.test.tsx`, `shippingQuoteOrder.test.tsx`.
- `docs/adoption/hunts/evershop-admin-checkout-issue.md`: the issue (bug template) and the PR (PR template), both
  with the disclosure paragraph, and the "before sending" checklist.
- `docs/adoption/hunts/evershop-admin-checkout/`: `hunt.mjs` (explore harness), `repro.mjs` and `requote-repro.mjs`
  (reproductions without GenClass), `place-order.mjs` (place-order probe), `summarise.mjs`, `explore-summary.json`
  and excerpts of the explore reports, the explain output and the generated test.
- `docs/adoption/hunts/README.md`: the row.

**To send (a person).** Do the checklist at the top of `evershop-admin-checkout-issue.md`: search the tracker for
duplicates since 2026-11-03; reproduce once with the issue's snippet (DevTools throttling does **not** reproduce it,
measured 0 of 12); run the cart tests with and without the fix; read the diff. Then from a personal account: open the
issue with the issue text (fill in your Node, OS and browser), fork `evershopcommerce/evershop`, branch from `dev`,
`git am` the patch rebased on that day's `dev`, set yourself as author (`git commit --amend --reset-author` on both
commits), push, open the PR against `dev` with the PR text and the issue number. Decide first whether to split the
shipping fix into its own PR. If asked how it was found: the disclosure paragraph says it; the maintainers need
nothing from GenClass to run the tests. The owner often reimplements evidenced fixes himself; that is a good outcome.

**Measured** (explore: 2 fifo baselines + 6 seeded loads per session, at 300, 600 and 900 ms; "wrong" = the harness's
own oracle against the server's cart):
- qty and remove on dev: explore RACE with page text in 4 of 6 sessions, 7 of 36 seeded loads wrong (plus an earlier
  qty batch: 5 of 18); replays REPRODUCED. On the fixed build: "No race found" in 6 of 6, 0 of 36 wrong.
- Without GenClass (`repro.mjs`, only the cart query delayed 800 ms): stale 3 of 3 on dev, 0 of 3 fixed; 0 of 3 with
  no delay; 0 of 12 with uniform network latency (400/800 ms) on dev.
- Shipping re-quote (`requote-repro.mjs`, the US quote 2.5 s late): US methods for Canada 3 of 3 on dev, 0 of 3 fixed.
  Explore did **not** find it (48 loads).
- Jest: the two new tests fail 3 of 3 on dev, pass 3 of 3 fixed; full suite 10,373 passed, 1 pre-existing failure
  (`delegate.test.js`, also on dev). eslint clean.
- Negatives: coupon double-click (24 of 24, one POST), single-line "+" (24 of 24), Place Order double click (5 of 5
  valid trials: one order), admin grids (full-page navigations, not a surface).
- False-report rate of explore: of 34 RACE runs on dev, 22 had no visible difference (18 a `POST /api/graphql`
  count only, 4 a count and React `useId` field ids); on the fixed build 2 of 9 sessions (4 of 54 seeded loads) still
  got a RACE verdict, all from that requote noise, with 0 wrong pages.

**Problems with GenClass itself** (report section 7): GraphQL queries sent as POST count as writes in the visible
tier (most of the false RACE runs, and replays "REPRODUCED" on them); React `useId` ids keyed form fields; the
shipping re-quote race was missed (debounce 800 ms vs. the hold limit); every GraphQL request has one signature; the
generated test's locators for icon-only buttons and its single-token assertions; witnesses on loading flags. Also two
wrong commands in the swarm brief's EverShop setup.

**Time.** About 50 minutes by the container's clock (16:34 to about 17:25 UTC).

**Branch.** Pushed to `claude/loving-fermat-uiovwf` (the branch this session was assigned) rather than
`adopt/evershop-admin-checkout`.
