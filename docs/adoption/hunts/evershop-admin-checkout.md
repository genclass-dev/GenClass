# Race hunt: EverShop storefront cart and checkout (2.3.0, dev `6ec59f9`)

A GenClass race hunt on the EverShop storefront, run on 2026-11-03 in a cloud session (the adoption swarm,
`docs/adoption/swarm.md`, slug `evershop-admin-checkout`), with the real `@genclass/runtime` (0.3.0-beta.5, this
repository at `c1c9e14`) injected into the store's pages by Playwright and the real `@genclass/mcp` (0.2.1) driven the
way a coding agent drives it. EverShop's source was not modified for the hunt; the fixes are a patch for its
maintainers (`evershop-admin-checkout.patch`, draft issue and pull request text in `evershop-admin-checkout-issue.md`).
Nothing was sent to EverShop's repository, tracker or maintainers.

**Headline.** One real race on the cart page, found by `genclass_explore` on the first surface it was pointed at and
reproduced without GenClass: when two cart changes are made close together (the "+" of two lines within the
500 ms quantity debounce, or a "+" and a Remove) and the cart query of the first change is still on the wire when
the second change's request returns, the second change gets the first change's cart. urql 3 gives a query the result
of an identical one already in flight (its `dedupExchange`), and that query was answered before the second change
reached the server. The page then shows the line at its new quantity but its old price, and the old subtotal and
total ($39.00 instead of $54.00), until the next change or a reload; the server's cart is right. Explore showed it in
7 of 36 seeded loads across the qty and remove scenarios (and 5 of 18 more in an earlier qty batch), its replays said
"REPRODUCED", and a Playwright script that only delays the cart query's response by 800 ms reproduces it in 3 of 3
loads (0 of 3 without the delay). A second, smaller race in checkout was confirmed without GenClass but **not found
by explore**: an older shipping quote that answers last replaces the newer address's methods (a Canadian address
listed the United States method in 3 of 3 loads with that quote 2.5 s late, 0 of 3 without). The patch fixes both in
`CartContext.tsx` (39 lines changed) with two Jest tests in the package's style, each failing 3 of 3 on dev and
passing 3 of 3 with the fix; on the fixed build the plain reproductions give 0 of 3 and 0 of 3, and explore says "No
race found" in all 6 cart sessions. The coupon double-click, the double-click on Place Order and a single line's
"+" were negatives; the admin grids are full-page navigations and were not a surface.

Sections: 1 setup, 2 how the store was driven, 3 scenarios and verdicts, 4 the finding, 5 the second finding (shipping
re-quote), 6 observations (a lost checkout response, negatives), 7 problems with GenClass itself, 8 time spent,
9 reproducing.

## 1. Setup

| what | version |
|---|---|
| EverShop | 2.3.0, `evershopcommerce/evershop` branch `dev` at `6ec59f9f242a3fb880f06f2f0e0654ab482269a3` (2026-11-03 09:32 +0700, "Merge pull request #1204"), the commit the patch is against; production build (`npm run build && npm run start`) |
| stack | React 19.2.7, urql 3.0.4 over `@urql/core` 3.2.2 (default exchanges: dedup, cache, fetch), Jest 29.7.0 |
| Node, npm | 22.23.4; npm 9.9.4 (`npm install -g npm@9`, as the project's CI) |
| database | PostgreSQL 16.15 (Ubuntu 24.04 package, `service postgresql start`) |
| browser | Chromium 1243 (headless shell), Playwright 1.63.0 (this repository's `@playwright/test`) |
| GenClass | `@genclass/runtime` 0.3.0-beta.5 and `@genclass/mcp` 0.2.1 from this repository at `c1c9e14`, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |

Commands, in order (the brief's sequence, with two corrections marked):

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# EverShop, in ~/targets/evershop-admin-checkout
git clone https://github.com/evershopcommerce/evershop ~/targets/evershop-admin-checkout   # branch dev
npm install -g npm@9 && npm install --no-audit --no-fund
npm run compile && npm run compile:db
service postgresql start
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres'" -c 'CREATE DATABASE evershop'
export DB_HOST=localhost DB_PORT=5432 DB_USER=postgres DB_PASSWORD=postgres DB_NAME=evershop DB_SSLMODE=disable
# correction 1: `npm run setup` exits at once when DB_HOST is set ("Look like you have already installed the system",
#   src/bin/install/index.js line 26), and the `evershop` bin is not linked when `npm install` runs before `compile`
#   (sh: evershop: not found). The schema comes from the CI's script instead, the admin from user:create:
node scripts/ci/migrateCoreSchema.mjs                       # "77 tables in evershop"
printf 'DB_HOST="localhost"\nDB_PORT="5432"\nDB_NAME="evershop"\nDB_USER="postgres"\nDB_PASSWORD="postgres"\nDB_SSLMODE="disable"\n' > .env
node packages/evershop/dist/bin/evershop.js user:create --name Admin --email admin@example.com --password '<8+ chars>'
node packages/evershop/dist/bin/evershop.js seed --all      # 15 products (CUP-001-WHT $15, PEN-002-BLK $12, ...)
npm run build && npm run start                              # http://localhost:3000
```

Seeded for the surfaces, directly in the database (the store's own tables, rows named `e2e-hunt` / `E2EHUNT10`):

```sql
-- a 10% coupon on the whole order
INSERT INTO coupon (description, discount_amount, discount_type, coupon, condition, user_condition)
VALUES ('e2e hunt 10%', 10, 'percentage_discount_to_entire_order', 'E2EHUNT10',
        '{"order_total":"","order_qty":"","required_products":[]}', '{"groups":[],"emails":"","purchased":""}');
-- two shipping zones, one core method each: US -> "e2e-hunt US Ground" $5, CA -> "e2e-hunt Canada Post" $9
-- (shipping_zone, shipping_zone_country, shipping_zone_provider 'core', core_shipping_method, core_shipping_method_rate)
-- Cash on Delivery on (the store reads its settings at boot: restart after this)
INSERT INTO setting (name, value, is_json) VALUES ('codPaymentStatus', '1', false);
```

The exact zone SQL is the `WITH ... INSERT` in section 9.

## 2. How the store was driven

`evershop-admin-checkout/hunt.mjs` is the whole loop, modelled on `gitea-explore.mjs`:

- **MCP server in-process.** `serve()` from `packages/mcp/dist/index.js`, bridge on a free port, no state directory;
  `genclass_clear`, `genclass_explore` (start, report), `genclass_explain`, `genclass_findings` and `genclass_replay`
  (arm, result) through JSON-RPC `tools/call`.
- **Injection without touching EverShop.** A context-level `page.route` serves `packages/runtime/dist/` under
  `/__genclass/rt/` and rewrites each HTML document to start `<head>` with the script tag
  (`genclass.global.js`, `data-manual`), `GenClass.init({ model: false, telemetry: false, report: "silent",
  mode: "observe", visual: false, devtools: false })` and a module script that imports `/__genclass/rt/agent.js` and
  calls `connectAgent(rt)`; the context gets the `local-network-access` permission. No model, nothing downloaded,
  telemetry off. React state discovery found the cart context's reducer state (`evershopGlobal.state0.*`) and the
  form fields' component state.
- **One page load per run, a fresh context each.** A plain visit of `/` (before the route is installed) issues the
  session cookie, the cart is built over HTTP (`POST /api/cart/mine/items` through the context's request client, as
  `tests/e2e/.../cartShelf.spec.ts` does), so `/cart` (or `/checkout`) is the only page load explore sees.
- **Explore.** For each of `slow_ms` 300, 600 and 900: `genclass_explore start` with `runs: 6` (8 loads: 2 fifo
  baselines, 6 seeded orders), the same steps each load, `whenSettled(15000)` after an 800 ms wait for the
  quantity debounce (1,300 ms on `/checkout` for the re-quote debounce), then `report`; on a race finding,
  `genclass_explain` and a replay (`arm`, one more load, `result`).
- **Own oracle.** After each load the harness reads what the page shows (each line's SKU, quantity and price, the
  order summary, the item count) and compares it with a fresh, uninstrumented load of `/cart` in the same session:
  the server's cart. On `/checkout` it compares the listed shipping methods with Canada's one method. It also logs the
  cart requests on the wire. `summarise.mjs` reduces the outputs to `explore-summary.json` and sorts every RACE run by
  what the report lists for it (page text, a request count, a form field).

## 3. Scenarios and verdicts

Explore verdicts are the report's own wording, reduced; the RACE runs are split by what the report lists for each:
**page** (page text differs), **requests** (only the number of `POST /api/graphql` differs), **field** (only a form
field's id or presence differs). The oracle column counts seeded loads whose page differed from the server's cart (or
from Canada's method); both baselines matched the server in every session. Batch A is a first qty session batch
(before the replay call was fixed in the harness, so no replay); batch B is the full run.

| scenario | slow_ms | variant | explore verdict | RACE runs by kind | oracle: seeded loads wrong | replay |
|---|---|---|---|---|---|---|
| qty (A) | 300 | dev | RACE: 3 of 6 | page+requests 2, requests 1 | 2 of 6 | not run |
| qty (A) | 600 | dev | RACE: 3 of 6 | page 1, requests 2 | 1 of 6 | not run |
| qty (A) | 900 | dev | RACE: 5 of 6 | page 2, requests 3 | 2 of 6 | not run |
| qty | 300 | dev | RACE: 3 of 6 | page+requests 2, requests 1 | 2 of 6 | REPRODUCED |
| qty | 600 | dev | RACE: 3 of 6 | requests 3 | 0 of 6 | REPRODUCED (the request count) |
| qty | 900 | dev | RACE: 4 of 6 | page 1, requests 3 | 1 of 6 | REPRODUCED (page text) |
| remove | 300 | dev | RACE: 3 of 6 | page+requests 3 | 3 of 6 | REPRODUCED |
| remove | 600 | dev | RACE: 3 of 6 | page 1, requests 2 | 1 of 6 | REPRODUCED |
| remove | 900 | dev | RACE: 3 of 6 | requests 3 | 0 of 6 | REPRODUCED (the request count) |
| qty-one | 300 / 600 / 900 | dev | No race found (6 of 6 compared, each) | none | 0 of 18 | none |
| coupon | 300 / 600 / 900 | dev | No race found (each) | none | 0 of 18 | none |
| requote | 300 | dev | No race found | none | 0 of 6 | none |
| requote | 600 | dev | RACE: 1 of 6 | requests+field 1 | 0 of 6 | REPRODUCED (field ids) |
| requote | 900 | dev | RACE: 3 of 6 | requests+field 3 | 0 of 6 | REPRODUCED (field ids) |
| qty | 300 / 600 / 900 | fixed | No race found (each) | none | 0 of 18 | none |
| remove | 300 / 600 / 900 | fixed | No race found (each) | none | 0 of 18 | none |
| requote | 300 | fixed | No race found | none | 0 of 6 | none |
| requote | 600 | fixed | RACE: 1 of 6 | requests+field 1 | 0 of 6 | REPRODUCED (field ids) |
| requote | 900 | fixed | RACE: 3 of 6 | requests+field 3 | 0 of 6 | REPRODUCED (field ids) |

Every load reached a quiet point; no load had a page error. In every session the RACE runs that list page text are
exactly the loads the oracle found wrong (qty A: 2, 1, 2; qty B: 2, 0, 1; remove: 3, 1, 0). The others are false
reports (section 7, items 1 and 2).

Scenario by scenario:

- **qty** (two lines at qty 1: "+" on line 1, 150 ms later "+" on line 2): **the race of section 4.** Wrong loads
  show `CUP-001-WHT` at quantity 2 for $15.00, subtotal and total $39.00; the server has $30.00 and $54.00. In every
  wrong load the wire shows one cart query for the two changes, sent between the two PATCHes.
- **remove** ("+" on line 1, 150 ms later Remove on line 2): the same mechanism through `removeItem` (the Remove is
  sent at once, the "+" after its 500 ms debounce): the kept line shows quantity 2 for $12.00.
- **qty-one** (one line, "+" twice 150 ms apart): one debounced PATCH, one query, the right cart in 24 of 24 loads.
  The control that the debounce itself is fine.
- **coupon** (type E2EHUNT10, click Apply twice 60 ms apart): one coupon POST and the 10% discount in 24 of 24
  explore loads; without GenClass, two clicks back to back (`--gap 0`) also sent one POST in 3 of 3. The brief's
  "no in-flight disable" is not right: `CouponForm.tsx` passes `isLoading={state.isLoading}` (the cart's `loading`,
  `Coupon.tsx` line 47) to the `Button`, which is `disabled={disabled || isLoading}`.
- **requote** (`/checkout`: country United States, 1 s later Canada): the methods were Canada's in 48 of 48 loads,
  fixed and unfixed. Explore did not produce the order that matters (the United States quote answering after
  Canada's); section 5 confirms that race without GenClass.
- **place-order** (without GenClass, `place-order.mjs`): section 6.
- **Admin grids** (not run): `modules/catalog/pages/admin/productGrid/Grid.jsx` lines 241, 259, 287 and 319 and
  `modules/oms/pages/admin/orderGrid/Grid.jsx` lines 169 and 194 assign `window.location.href`: every filter, sort
  and page is a full navigation of a multi-page app (the root `CLAUDE.md`: "Not a SPA"), so no response can
  overtake another. The admin type-ahead selectors were not driven (time went to the two checkout scenarios).

Counting: on dev, 7 of the 18 sessions on the five driven surfaces gave a RACE verdict with a visible difference
behind it, 4 gave a RACE verdict with none (request counts, field ids), 7 said "No race found" with the page right.
Of the 34 RACE runs on dev, 12 list page text (each one a load the oracle found wrong), 18 only a `POST /api/graphql`
count and 4 a count and form-field ids.
On the fixed build, 6 of 6 cart sessions said "No race found"; the 2 requote RACE verdicts there are false reports
(4 of 18 seeded loads flagged, 0 of 18 wrong).

## 4. The finding: a cart change can get an earlier change's cart

### 4.1 What explore saw

Session qty, 900 ms, batch B (`evershop-admin-checkout/report-qty-900.txt`). Baselines: both loads right. The report,
for run r21 (seed 1):

```
RACE: 4 of 6 reordered run(s) ended in a different state than the baseline (responses in request order): ...
- run r21 (seed 1):
    page text only in the baseline: "4", "$30.00", "$54.00", "$54.00"
    page text only in this run: "3", "$15.00", "$39.00", "$39.00"
    witness only here: overwrote-newer evershopGlobal.state0.loadingStates.updatingItem by POST /api/graphql
```

("4" and "3" are the header's item count.) `genclass_explain` of the finding (`explain-qty-900-f11.txt`), the
evidence in causal order (times from `connectAgent`; holds in brackets):

```
+0.058s action 0: click button
+0.240s action 1: click button
+0.561s send PATCH /api/cart/:id/items/:id#1 "{qty: 1, action: \"increase\"}" (action 0) via timer 500ms
+0.615s delivered PATCH /api/cart/:id/items/:id#1 (held 28 ms)
+0.624s send POST /api/graphql#1 "{query: \"query Query {\n myCart …\", +2}" (action 0) via PATCH /api/cart/:id/items/:id
+0.741s send PATCH /api/cart/:id/items/:id#2 "{qty: 1, action: \"increase\"}" (action 1) via timer 500ms
+0.915s delivered PATCH /api/cart/:id/items/:id#2 (held 149 ms)
+1.091s delivered POST /api/graphql#1 (held 445 ms)
+1.096s write evershopGlobal.state0.data, ... by POST /api/graphql#1
Delivery order: PATCH /api/cart/:id/items/:id#1 → PATCH /api/cart/:id/items/:id#2 → POST /api/graphql#1
```

So: the cart query of the first change was sent at +0.624 s, before the second PATCH (+0.741 s); the second PATCH's
response arrived (+0.915 s) while that query was still on the wire, and no second query was ever sent. Both changes'
syncs ended with the answer of `POST /api/graphql#1`, which the server gave before it had the second change. In the
fifo baselines the query is delivered before the second PATCH's response, so the second sync sends a query of its
own. The replay (`genclass_replay arm` with f11, one load, `result`): "REPRODUCED · the page shows the failing run's
text again" (and the same at 300 ms).

### 4.2 Reproduction without GenClass

`evershop-admin-checkout/repro.mjs`: plain Playwright, the same cart and clicks, and `page.route` delivering only the
response to `POST /api/graphql` late (the PATCH requests are not touched):

```
delay 0 ms, trial 1..3:   matches the server · shown PEN-002-BLKx2@$24.00,CUP-001-WHTx2@$30.00 | subtotal $54.00 · cart queries sent 2
delay 800 ms, trial 1..3: STALE · shown PEN-002-BLKx2@$24.00,CUP-001-WHTx2@$15.00 | subtotal $39.00
                          · server PEN-002-BLKx2@$24.00,CUP-001-WHTx2@$30.00 | subtotal $54.00 · cart queries sent 1
```

What it needs is the cart query answering more slowly than the second update, not a slow network as such. Slowing
every request alike with Chromium's network emulation (`Network.emulateNetworkConditions`, latency 400 and 800 ms,
clicks 150 and 450 ms apart, 3 loads each, on the unfixed build) gave the right cart in 12 of 12 loads with two cart
queries each: the PATCH is delayed as much as the query, so the first query is sent after the second PATCH. The cart
query is the largest request on the page (the whole cart with totals, items, addresses and methods, computed by the
server) and the PATCH is small, so the needed order is plausible under server load or a variable connection (not
measured here); DevTools throttling does not give it, and the issue draft says so.

### 4.3 Root cause (paths and lines at `6ec59f9`)

1. `packages/evershop/src/components/frontStore/cart/ItemQuantity.tsx`, lines 95 to 117: each line debounces its
   quantity by 500 ms (`debounce = 500`, line 47) and then calls `updateItem`; the +/- buttons are disabled while the
   cart is `loading` (line 160), but a timer already set still fires, so two lines changed within half a second send
   two PATCHes about 150 ms apart.
2. `packages/evershop/src/components/frontStore/cart/CartContext.tsx`, `updateItem` (line 724) and `removeItem`
   (line 667) await their request inside `retry()` and then `syncCartWithServer` (lines 556 to 600), which runs
   `client.query(query, {}, { requestPolicy: 'network-only' }).toPromise()` and dispatches `SET_CART` with the result.
3. `@urql/core` 3.2.2, `dedupExchange` (`dist/urql-core.mjs` lines 439 to 469, in the client's default exchanges,
   `components/common/react/client/HydrateFrontStore.tsx` `createClient({ url: '/api/graphql' })`): a query whose key
   (query and variables, here always the same) is already in flight is filtered out, and its `toPromise()` resolves
   with the in-flight operation's result. `network-only` does not opt out: the client dispatches it again, and the
   exchange drops it.
4. So the second sync gets the first query's answer, from before the second change, and `SET_CART` puts it on the
   page. The line's `ItemQuantity` keeps its own quantity (2), so the page shows quantity 2 next to the price, the
   subtotal and the total for 1. Nothing fetches the cart again until the next change.

Related upstream: PR #1195 (merged 2026-11-01) made `syncCartWithServer` await the real fetch (before it, `synced`
turned true before the cart arrived); this race is in the code that PR introduced, and needs two changes close
together. #1180 / #1193 (server-side duplicate `order_placed`) and #623 (cart discarded after a failed Stripe
payment) are different bugs. The tracker was not searched for duplicates in this session (rule 1 of the swarm brief;
the "before sending" list has it).

### 4.4 The fix

First commit of `evershop-admin-checkout.patch`: `syncCartWithServer` queues its fetches. The body is renamed
`fetchCart`, unchanged, and

```ts
const syncQueue = React.useRef<Promise<unknown>>(Promise.resolve());
const syncCartWithServer = useCallback(
  (trigger?: string): Promise<CartData | undefined> => {
    const sync = syncQueue.current.then(() => fetchCart(trigger));
    syncQueue.current = sync;
    return sync;
  },
  [fetchCart]
);
```

Each sync starts its query once the previous one has finished, so its query is sent after its own change's response
and is never merged into an older one. `fetchCart` never rejects (it catches and returns `undefined`), so a failed
fetch does not stop the queue. Cost: a second change close behind a first waits for the first's cart query (one query
time); changes made one at a time are unchanged. Alternatives considered: a counter that drops older results does not
help here, because the second sync's only result *is* the older one; a dummy variable to change the query key would
work around urql rather than say what the code needs.

### 4.5 Tests and the fixed variant

`packages/evershop/src/components/frontStore/cart/tests/unit/cartSyncOverlap.test.tsx` (in the patch), in the style
of `cartSync.test.tsx` next to it (`domSetup.js`, `jest.unstable_mockModule('urql')`, React `act`), with one
difference that matters: the `useClient` mock returns a **real** urql client (`createClient` from `urql`, default
exchanges) and fakes only `fetch`, so urql's own deduplication is what the test exercises. It starts `updateItem` for
line 1 (its PATCH answers, its cart query stays open), then for line 2, answers the first query with the cart the
server had then (line 1 changed, line 2 not), and expects a second query, answered with both changes, and the state
to end with both quantities at 2.

| variant | `cartSyncOverlap.test` (3 runs) | `repro.mjs` (800 ms, 3 trials) | explore qty + remove (6 sessions, 36 seeded loads) |
|---|---|---|---|
| dev `6ec59f9` | **3 of 3 failed**: `expect(cartQueries).toHaveLength(2)`, "Received length: 1" | stale in 3 of 3 | RACE with page text in 4 of 6 sessions; 7 of 36 loads wrong |
| with the patch | 3 of 3 passed | right in 3 of 3 (and 3 of 3 without the delay) | "No race found" in 6 of 6; 0 of 36 loads wrong |

The fixed build's explore sessions ran on a new MCP server, so the unfixed findings were not replayed against it;
the plain reproduction and the 36 loads are the check. Commands: `npm run compile:dev` then
`ALLOW_CONFIG_MUTATIONS=true NODE_OPTIONS=--experimental-vm-modules node node_modules/jest/bin/jest.js
packages/evershop/dist/components/frontStore/cart` (the 4 cart suites, 13 tests, pass with the patch). The whole
suite (`npm test` with the hunt's Postgres): 10,373 passed, 522 skipped, 1 failed: `lib/middleware/tests/unit/
delegate.test.js` "Middleware function return desired value", which fails the same way on dev without the patch
(3 of 3 runs there). `npx eslint` on the changed source: clean. Prettier reports the three files; its diffs in
`CartContext.tsx` are all on lines the patch does not touch (dev's file is not prettier-clean either), and the two
new tests are written like `cartSync.test.tsx`, which is not prettier-formatted; the husky pre-commit hook ran on
both commits and changed nothing. The project's Playwright suite (`tests/e2e`) was not run: it needs its own
`globalSetup` admin and `.env`, and the unit tests cover the bug without a browser.

## 5. The second finding: an older shipping quote replaces the newer one

`components/frontStore/checkout/Shipment.tsx` lines 78 to 119 re-quote 800 ms after each change of the shipping
address's geographic fields, through `fetchAvailableShippingMethods` (`CartContext.tsx` lines 1215 to 1270 at
`6ec59f9`): `client.query(ShippingMethodsQuery, { country, ... })` and `SET_CART` with the methods of whatever
answer arrives, with no check that it is still the latest address. Different addresses are different query keys, so
urql runs both and the last answer wins.

`evershop-admin-checkout/requote-repro.mjs` (plain Playwright): `/checkout`, country United States, 1 s later Canada,
with only the United States quote's response delivered late:

```
US quote delayed 0 ms, trial 1..3:    country Canada · methods e2e-hunt Canada Post · quotes delivered US then CA
US quote delayed 2500 ms, trial 1..3: country Canada · methods e2e-hunt US Ground · quotes delivered CA then US+2502ms
```

Filling in the rest of the address afterwards (province, postal code) re-quotes and repairs the list (checked once:
"e2e-hunt Canada Post" after the postal code), so in the usual order of a checkout form the wrong list lasts only
until the next geographic edit; it stays when the country (or the postal code) is the last field changed, and with
carrier rates (the repository ships UPS and Easyship extensions) a quote of several seconds is plausible. Not
checked: what the server answers when the stale method is picked.

Explore did not find it: 48 loads (6 sessions) all ended with Canada's method; the RACE verdicts on this surface are
false reports (section 7). With the 800 ms debounce, the United States quote must be held more than about a second
beyond Canada's request, and the seeded orders at these latencies did not produce it.

The fix (second commit of the patch): a counter of quotes (`shippingQuote`, a ref); an answer whose number is not
the latest is dropped, and only the latest clears `fetchingShippingMethods`. Test:
`cart/tests/unit/shippingQuoteOrder.test.tsx` (the fake client of `cartSync.test.tsx`, queries held open and answered
in the test's order): Canada answered first and the United States last ends with Canada's method; an older answer
while the newer is on the way leaves the list and the loading state alone. On dev 2 of 2 tests fail, 3 of 3 runs
(`Received: "US Ground"`); with the patch 2 of 2 pass, 3 of 3 runs. On the fixed build `requote-repro.mjs` gives
"e2e-hunt Canada Post" in 3 of 3 with the 2.5 s delay (and 3 of 3 without).

## 6. Observations and negatives

**Place Order** (`place-order.mjs`, without GenClass; a guest cart, the Canada address, the zone's method, Cash on
Delivery, order counts from the database by the trial's e-mail address):

| mode | trials that reached the POST | checkout POSTs | orders | page |
|---|---|---|---|---|
| `dblclick` (two clicks about 12 ms apart) | 2 of 3 | 1 each | 1 each | `/checkout/success/<id>` |
| two clicks 80 ms apart | 3 of 3 | 1 each | 1 each | `/checkout/success/<id>` |
| first response dropped after the server handled it | 3 of 8 | 2 each | 1 each | stays on `/checkout`; the second POST answered `404 Invalid cart` |

The double click is a negative (the form is disabled and `SET_PLACING_ORDER` set before the second click lands). The
trials that did not reach the POST are this harness's form setup (the Place Order click came before the form was
valid), not EverShop. The dropped response is not a race, but it is worth a line to the maintainers:
`CheckoutContext.tsx` `checkout()` (lines 310 to 372) wraps the order POST in `retry()` (line 183, 3 retries), the
server has already turned the cart into an order, so the retry gets "Invalid cart" and the shopper sees a failed
checkout for an order that exists (no duplicate order: 1 in 3 of 3). It is a note in the issue, not in the patch.
The legacy `placeOrder()` (lines 273 to 307) throws when `response.ok` is true (inverted); no caller was found in the
storefront components (`grep -rn placeOrder packages/evershop/src` finds only its definition and the context value),
so it is mentioned nowhere upstream.

**Negatives**: the coupon double-click (24 of 24 explore loads and 3 of 3 back-to-back clicks: one POST), a single
line's "+" twice (24 of 24 right), the Place Order double click (above), the admin grids (full navigations, section
3). `AddToCart.tsx` uses `cartState.loading` as `isLoading` (line 48); not driven.

## 7. Problems with GenClass itself

1. **A GraphQL query sent as POST counts as a write (false RACE).** The visible tier counts "the number of unsafe
   requests (POST, PUT, PATCH, DELETE) to a signature". EverShop (like most GraphQL clients) sends queries as
   `POST /api/graphql`, and how many it sends depends on the order here (urql merges an identical in-flight query), so
   18 of the 34 RACE runs on dev listed only "requests sent to \"POST
   /api/graphql\": baseline \"1\", this run \"2\"" (or "\"8\" / \"7\"") with the page the same (and 8 more, 4 on dev and all 4 on the fixed build's requote, listed
   that count next to form-field ids, item 2); the replays then said
   "REPRODUCED · ended with the same wrong values" for those findings, which is the request count again. Suggestion:
   treat a POST whose body is a GraphQL `query` (not a `mutation`) as a safe request, or let the report say "only the
   number of POST /api/graphql requests differs" outside the RACE tier when the body says `query`.
2. **React `useId` ids as form fields (false RACE).** On `/checkout` the form values are keyed by element ids such as
   `base-ui-_r_i_` and `base-ui-_r_f_` (Base UI generates them with `useId`, which counts renders), and the set of
   ids depended on the order: "field \"base-ui-_r_i_\": baseline \"\", this run \"(absent)\"; field
   \"base-ui-_r_f_\": baseline \"(absent)\", this run \"\"". The page was right in all 8 such runs (4 on dev, 4 on the
   fixed build) and in 48 of 48 requote loads. Suggestion: key unnamed fields by role and label, or treat a field present in one run and absent in the
   other under a generated-looking id (`_r_`, `:r…:`) as noise when the empty values match.
3. **A miss: the shipping re-quote race (section 5)** was not produced in 48 loads at 300, 600 and 900 ms; it needs one
   response held more than a second beyond a later request that is sent after an 800 ms debounce. The default
   `maxHoldMs` (1.5 s) and the latencies leave little room; a `slow_ms` above the app's debounce, or a schedule that
   holds the older of two same-signature requests until the newer is delivered, would cover debounced inputs.
4. **Every cart query has the same signature.** `POST /api/graphql#1`, `#2`: the delivery order and the witnesses
   name the GraphQL endpoint, not the operation (`AddressSchema`, `GetCartShippingMethods`, the cart `Query`); the
   explain output's body preview (`"{query: \"query Query {\n myCart …\", +2}"`) is the only hint. Suggestion: add the
   `operationName` (or the first field) to the signature of a GraphQL POST.
5. **The generated regression test** (`generated-test-qty-900-f11.md`) clicks `page.locator("button").first()` twice
   (the "+" buttons are icon-only, "the recorded element \"button\" had no name"), which is the page's first button,
   not the two lines' "+"; and it asserts `not.toContain("3")` on the page text, which any "3" on the page fails.
   Suggestion: record a positional or structural locator for unnamed buttons (the nth button inside the nth repeated
   block), and assert whole lines rather than single short tokens.
6. **Witnesses on loading flags.** The "Along the way only" and witness lines (`overwrote-newer
   evershopGlobal.state0.syncStatus.synced by PATCH ...`, `... loadingStates.updatingItem by POST /api/graphql`) are
   bookkeeping of the cart reducer, set by both operations in either order; they never pointed at the bug.
7. **Harness notes (not GenClass bugs).** The swarm brief's EverShop commands were wrong twice (section 1); the
   harness's first replay call omitted `id` on `result` and got "No finding" (fixed, batch B); the `place-order`
   setup is flaky (6 of 14 trials did not get the form valid). No console errors from the runtime on any load.

## 8. Time spent

By the container's clock (UTC; file timestamps in the session's scratch directory), about 50 minutes from the first
`npm ci` to the commit: 16:34 first `npm ci` (it was cut short once by the global npm@9 install running beside it);
16:37 EverShop built and seeded (the `npm run setup` detour of section 1 included); 16:41 the first explore session
of the qty surface, which raced; 16:43 the GenClass-free reproduction and the root cause; 16:47 to 16:55 the explore
batch on dev (qty, qty-one, remove, coupon, requote); 17:02 both fixes and their tests; 17:10 the last fixed-variant
session; about 10 minutes more to measure the uniform-latency case on a rebuilt dev and write. Explore loads took
about 4 s each. The time the session spent reading EverShop's sources and GenClass's docs is not separable in these
stamps.

## 9. Reproducing

With EverShop running as in section 1 and GenClass built:

```bash
# the two shipping zones
PGPASSWORD=postgres psql -h localhost -U postgres evershop <<'SQL'
WITH us AS (INSERT INTO shipping_zone (name) VALUES ('e2e-hunt US') RETURNING shipping_zone_id),
     ca AS (INSERT INTO shipping_zone (name) VALUES ('e2e-hunt CA') RETURNING shipping_zone_id),
     mu AS (INSERT INTO core_shipping_method (name, is_enabled, sort_order) VALUES ('e2e-hunt US Ground', true, 0) RETURNING core_shipping_method_id),
     mc AS (INSERT INTO core_shipping_method (name, is_enabled, sort_order) VALUES ('e2e-hunt Canada Post', true, 0) RETURNING core_shipping_method_id),
     a AS (INSERT INTO shipping_zone_country (zone_id, country) SELECT shipping_zone_id, 'US' FROM us),
     b AS (INSERT INTO shipping_zone_country (zone_id, country) SELECT shipping_zone_id, 'CA' FROM ca),
     c AS (INSERT INTO shipping_zone_provider (zone_id, provider_code, is_enabled) SELECT shipping_zone_id, 'core', true FROM us UNION ALL SELECT shipping_zone_id, 'core', true FROM ca),
     d AS (INSERT INTO core_shipping_method_rate (method_id, zone_id, is_enabled, cost) SELECT mu.core_shipping_method_id, us.shipping_zone_id, true, 5 FROM mu, us UNION ALL SELECT mc.core_shipping_method_id, ca.shipping_zone_id, true, 9 FROM mc, ca)
SELECT 1;
SQL
H=docs/adoption/hunts/evershop-admin-checkout
node $H/repro.mjs                          # section 4.2
node $H/requote-repro.mjs                  # section 5
node $H/hunt.mjs --surface qty --slow 300,600,900 --out /tmp/evershop-hunt    # also: remove, qty-one, requote; coupon --gap 60
node $H/hunt.mjs --surface qty --genclass 0 --runs 3                         # the same steps without GenClass
node $H/place-order.mjs                    # section 6
node $H/summarise.mjs /tmp/evershop-hunt   # the table of section 3
# the patch: in the EverShop clone at 6ec59f9
git am docs/adoption/hunts/evershop-admin-checkout.patch && npm run compile:dev && npm test
```
