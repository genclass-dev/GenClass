# Race hunt: Medusa admin dashboard (2.22.2)

A GenClass race hunt on the Medusa admin (`@medusajs/dashboard`), run on 2026-11-03 in a cloud session of the adoption
swarm (brief `docs/adoption/swarm-targets/medusa-admin.md` on `adopt/briefs`), with the real `@genclass/runtime`
(0.3.0-beta.5) and `@genclass/mcp` (0.2.1) from this repository at `c1c9e14`, injected into the admin from outside by
Playwright and driven the way a coding agent drives the MCP server. Medusa's code was not modified for the hunt; the
fix is a patch for its maintainers ([medusa-admin.patch](medusa-admin.patch)), with the facts for an issue and a pull
request that the sender writes in their own words ([medusa-admin-issue.md](medusa-admin-issue.md): Medusa does not
accept AI-written descriptions). Nothing was sent to Medusa's repository, tracker, Discord or maintainers.

**Headline.** One real bug with a fix and a regression test, and one real order-dependent display bug left as an
observation:

1. **The exchange and claim "Add items" modals add the same items twice** (section 4). A double click on Save (two
   presses 40, 120 or 250 ms apart), or saving the modal a second time without a new selection, sends the same
   selection again: the exchange gets two `RETURN_ITEM` actions of quantity 1, the item shows 2, the order preview's
   `return_requested_quantity` is 2, and typing 1 afterwards changes the input but not the server (still 2). Same in
   the exchange's outbound modal (two `ITEM_ADD` lines) and the claim's inbound modal. GenClass flagged it as a
   `duplicate-request` finding in 8 of 8 loads of each of the three `exchange-add-dbl` explore sessions; without
   GenClass it reproduces in 12 of 12 plain Playwright trials (3 per variant), and never with one click (0 of 2). The
   cause is a module-level selection (`let itemsToAdd`) that is never cleared plus a Save with no pending state. The
   patch (4 files, +92 −8, and a Vitest spec of 2 tests) fails 2 of 2 tests on develop and passes 2 of 2 with the fix
   (3 runs each); the dashboard's 190 tests pass. On the fixed build in the browser: one action in 21 of 21 plain
   trials (12 double clicks at 0 to 250 ms, 3 reopens, 3 claim, 3 outbound) and no `duplicate-request` in 6 explore
   sessions (48 loads): section 4.6.
2. **The order timeline can miss the exchange the exchange page has just created** (section 5): when the timeline's
   first `GET /admin/exchanges` answer arrives after the exchange is created, TanStack Query dedupes the invalidation
   onto that in-flight request and keeps the pre-exchange list as fresh for its 90 s `staleTime`. Explore showed it
   as page text ("Exchange #… requested", "Show 2 more activities") in 3, 3 and 4 of 6 reordered loads of the three
   `exchange-add-dbl` sessions (18 of 36 over the six exchange and claim sessions); a plain
   Playwright script delaying only that response reproduces it in 3 of 3 loads at 400 ms and at 1,500 ms (0 of 3
   without the delay). Not patched here (a separate change; Medusa allows 3 open PRs and wants one issue per PR).

The other scenarios (the return item quantity typed per keystroke, order-edit quantities saved on blur, the return's
add-items double click) ended the same in every reordered load; every RACE verdict on them is a relative time
("17 minutes ago" against "18 minutes ago") or a request count: section 3, with GenClass's false reports in section 6.

Sections: 1 setup, 2 how the admin was driven, 3 scenarios and verdicts, 4 the finding, 5 a second finding (not
patched), 6 problems with GenClass itself, 7 time spent, 8 reproducing.

## 1. Setup

| what | version |
|---|---|
| Medusa app | `medusajs/dtc-starter` at `913d4482641da21c9a219c92a5aa6b959af9bfd7` (2026-10-30; the installer's default template), `@medusajs/*` 2.22.2, `@medusajs/dashboard` 2.22.2, `@medusajs/draft-order` 2.22.2, `@tanstack/react-query` 5.64.2, `@medusajs/ui` 4.2.9 |
| Medusa source (for the fix) | `medusajs/medusa` `develop` at `97012ac68ced9e1742159cca62df1c2ed9f48ef5` (2026-11-03 17:56 +0200), the commit the patch is against. The four files the patch changes and `return-item.tsx` are byte-identical to the `src/` that the 2.22.2 npm package ships (`cmp`), so what ran is what the patch fixes |
| Node, pnpm, yarn | 22.23.4 (the starter's engines say `>=22.23.4`), pnpm 10.11.1 (corepack), yarn 3.2.1 (the monorepo's `.yarn/releases/yarn-3.2.1.cjs`) |
| database | PostgreSQL 16.15 (Ubuntu package), no Redis (the `REDIS_URL` line of `.env.template` dropped: Redis is optional) |
| browser | Chromium 153.0.8010.12 headless, Playwright 1.63.0 |
| GenClass | `@genclass/runtime` 0.3.0-beta.5 and `@genclass/mcp` 0.2.1 from this repository at `c1c9e14`, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |
| OS | Ubuntu 24.04.5 LTS, 4 vCPUs, 15 GB |

Commands, in order:

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# PostgreSQL (preinstalled 16 here; apt-get install -y postgresql otherwise)
service postgresql start
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres createdb medusa-dtc-starter

# the app, per the dtc-starter README (outside this checkout)
git clone https://github.com/medusajs/dtc-starter.git ~/targets/medusa-admin/dtc-starter
cd ~/targets/medusa-admin/dtc-starter && corepack enable pnpm && pnpm install
grep -v '^REDIS_URL' apps/backend/.env.template \
  | sed 's#^DATABASE_URL=.*#DATABASE_URL=postgres://postgres:postgres@localhost:5432/medusa-dtc-starter#' > apps/backend/.env
cd apps/backend
pnpm medusa db:migrate                                 # also seeds the store: regions, 4 products, stock, a publishable key
pnpm medusa user -e admin@test.com -p supersecret
MEDUSA_DISABLE_TELEMETRY=true pnpm dev                 # http://localhost:9000, admin at /app

# orders for the hunt (this repository): 12 delivered orders of 2 lines x 20, and 3 unfulfilled ones for order edits
node docs/adoption/hunts/medusa-admin/seed.mjs --orders 12
node docs/adoption/hunts/medusa-admin/seed.mjs --orders 3 --open
```

`seed.mjs` goes through the public HTTP API only (a storefront cart with the system payment provider, completed;
then the admin's fulfilment and mark-as-delivered), because returns, exchanges and claims only offer delivered
quantities and an order edit only lets a quantity above the fulfilled one be typed. The session's first `seed.mjs`
attempt left one order (display id 1) completed but unfulfilled; it was not used.

The Medusa monorepo, for the fix and its test (`CONTRIBUTING.md` and the dashboard's `package.json`):

```bash
git clone -b develop https://github.com/medusajs/medusa.git ~/targets/medusa-admin/medusa && cd ~/targets/medusa-admin/medusa
node .yarn/releases/yarn-3.2.1.cjs install       # corepack could not download yarn here (repo.yarnpkg.com did not resolve)
# turbo's tasks call `yarn`, so a wrapper for the committed release went first on PATH:
printf '#!/bin/sh\nexec node %s/.yarn/releases/yarn-3.2.1.cjs "$@"\n' "$PWD" > ~/bin/yarn && chmod +x ~/bin/yarn
PATH=~/bin:$PATH npx turbo run build --filter=@medusajs/dashboard^... --concurrency=4 --no-daemon   # 1 min 48 s
cd packages/admin/dashboard && PATH=~/bin:$PATH yarn test     # vitest 4.1.12
```

## 2. How the admin was driven

[medusa-admin/hunt.mjs](medusa-admin/hunt.mjs) is the whole loop, modelled on the Strapi and Gitea harnesses:

- **MCP server in-process.** `serve()` from `packages/mcp/dist/index.js` with its bridge on a free port; the tools are
  called over JSON-RPC `tools/call`: `genclass_explore` (start, report), `genclass_status`, `genclass_findings`,
  `genclass_explain`.
- **Injection without touching Medusa.** A context route rewrites every `/app` HTML document (the admin is served by
  `medusa develop` through Vite) to set `window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false,
  visual: false, devtools: false, report: "silent" }`, load `packages/runtime/dist/genclass.global.js` from the
  virtual same-origin path `/__genclass/`, and connect the agent link (`/__genclass/agent.js`) to the bridge. React
  state was discovered automatically (component state and TanStack Query observers: `ExchangeInboundSection.external3.*`
  and the like). The injected module also mirrors the dialog's quantity inputs and their count into two `rt.atom()`
  values (`hunt.quantities`, `hunt.rows`), so the verdict compares what the user sees in the modal. Requests to any
  host but localhost are aborted. Chromium gets `--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers`
  (the Strapi report's item 6: a route-fulfilled page may not otherwise reach the loopback bridge).
- **A clean order per load.** Each scenario has its own order. Before every load the harness cancels any open return,
  exchange, claim or order edit on it through the admin API (`DELETE /admin/returns/{id}/request`,
  `/exchanges/{id}/request`, `/claims/{id}/request`, `/order-edits/{order id}`), so all 8 loads of a session start from
  the same server state. The admin session is a fresh UI login per harness run (`storageState`).
- **One page load per run.** Each load opens the order's `/returns`, `/exchanges`, `/claims` or `/edits` route
  directly, waits for `window.__GENCLASS_AGENT__.connected` and the first quiet point, performs the steps, awaits
  `whenSettled()`, reads its own oracle, and closes the context 600 ms later so the last batch reaches the bridge.
- **Double clicks** are raw CDP mouse events (`Input.dispatchMouseEvent`, press 1 then press 2 `--gap` ms later, the
  second not held back until the page has handled the first: `vendure-hunt.mjs`'s method). Default gap 40 ms.
- **Explore.** `genclass_explore start` with `runs: 6` and `slow_ms` 300, 600 and 900 (8 loads per session: 2 fifo
  baselines, 6 seeded orders), then `report`, `findings`, and `explain` of the first race finding and of any
  `duplicate-request` finding.
- **Own oracle (secondary).** After each load this process reads the dialog's quantity inputs (DOM) and the server's
  view: the order preview's lines (quantity, `return_requested_quantity`, the change actions) and the open order
  change's actions, through the admin API. A seeded load "differs" when its oracle equals neither baseline's;
  [medusa-admin/summarise.mjs](medusa-admin/summarise.mjs) also marks a load whose only difference is the order of
  the actions inside the order change ("order-only").
- **Control without GenClass.** `hunt.mjs control <scenario> <trials>` runs the same steps with no injection at all;
  [medusa-admin/repro.mjs](medusa-admin/repro.mjs) is the standalone reproduction (Playwright and `fetch` only).

`genclass_status` after the first load of a session read, for example: "1 active page(s), 1 recorded run(s) ·
Findings: 1 duplicate-request, 2 stale-write · schedule fifo · 4 actions, 35 requests, 3 witnesses, 0 errors · model
off, mode observe · settled". The recorded actions of an exchange load: `click link "Add items"`, `click checkbox`,
`click button "Save"`, `click button "Save" x2`. No load in the tables below ended with a harness error, and every
load reached a quiet point.

## 3. Scenarios and verdicts

The brief's surfaces 1 to 3 plus the sibling modals the root cause pointed to. Each row is one explore session of 8
loads at one latency (`slow_ms`); `results.json` beside the harness has every row with the per-run kinds. Columns:
*explore verdict* is the report's verdict line reduced to counts ("internal only": the runs the report itself set
aside as store values or GET counts); *what differed in the RACE runs* sorts the report's per-run lines: a relative
time, a count of GET requests, a discovered state field, or other page text (read by hand); *duplicate-request* is
GenClass's finding of two identical writes in flight; *own oracle* is section 2's comparison; *forced* is how many
held responses were released because their hold ran out (the load did not follow its schedule exactly); *end state*
is the dialog's quantities and the server's open change in every load of the session.

| scenario | slow_ms | explore verdict | what differed in the RACE runs | duplicate-request | own oracle: seeded loads differing | forced | end state (all 8 loads) |
|---|---|---|---|---|---|---|---|
| exchange-add-dbl | 300 | RACE: 4 of 6 ended differently, internal only 2 of 6 | relative time; order timeline text (section 5); GET counts | 8× in 8 runs | 0 of 6 | 4 | quantity 2; `RETURN_ITEM:1, RETURN_ITEM:1` |
| exchange-add-dbl | 600 | RACE: 6 of 6 ended differently | relative time; order timeline text; GET counts; state | 8× in 8 runs | 0 of 6 | 11 | quantity 2; `RETURN_ITEM:1, RETURN_ITEM:1` |
| exchange-add-dbl | 900 | RACE: 5 of 6 ended differently, internal only 1 of 6 | relative time; order timeline text; GET counts | 8× in 8 runs | 0 of 6 | 9 | quantity 2; `RETURN_ITEM:1, RETURN_ITEM:1` |
| return-qty | 300 | No race found (0 of 6), internal only 2 of 6 | - | none | 0 of 6 | 4 | 12; `RETURN_ITEM:12` |
| return-qty | 600 | RACE: 3 of 6 ended differently, internal only 3 of 6 | relative time; state | none | 0 of 6 | 1 | 12; `RETURN_ITEM:12` |
| return-qty | 900 | RACE: 6 of 6 ended differently | relative time; state | none | 0 of 6 | 6 | 12; `RETURN_ITEM:12` |
| edit-qty | 300 | RACE: 5 of 6 ended differently | relative time | none | 2 of 6, both order-only | 1 | 15, 17; `ITEM_UPDATE:15, ITEM_UPDATE:17` (in either order) |
| edit-qty | 600 | RACE: 5 of 6 ended differently | relative time | none | 0 of 6 | 0 | 15, 17 |
| edit-qty | 900 | No race found (0 of 6) | - | none | 0 of 6 | 5 | 15, 17 |
| edit-qty-twice | 300 | No race found (0 of 6) | - | none | 2 of 6, both order-only | 1 | 18, 20; `ITEM_UPDATE:15, ITEM_UPDATE:18` (in either order) |
| edit-qty-twice | 600 | RACE: 2 of 6 ended differently, internal only 2 of 6 | relative time | none | 0 of 6 | 2 | 18, 20 |
| edit-qty-twice | 900 | RACE: 5 of 6 ended differently | relative time; state | none | 0 of 6 | 5 | 18, 20 |
| return-add-dbl | 300 | RACE: 4 of 6 ended differently, internal only 2 of 6 | relative time; GET counts; state | none | 0 of 6 | 2 | 1; `RETURN_ITEM:1` |
| return-add-dbl | 600 | RACE: 6 of 6 ended differently | relative time; GET counts | none | 0 of 6 | 4 | 1; `RETURN_ITEM:1` |
| return-add-dbl | 900 | RACE: 4 of 6 ended differently, internal only 2 of 6 | relative time; GET counts | none | 0 of 6 | 10 | 1; `RETURN_ITEM:1` |
| claim-add-dbl | 600 | RACE: 6 of 6 ended differently | relative time; order timeline text; GET counts; state | 8× in 8 runs (and 2 on GETs, section 6) | 0 of 6 | 4 | quantity 2; claim `RETURN_ITEM:1, RETURN_ITEM:1` |
| exchange-out-dbl | 600 | RACE: 4 of 6 ended differently, internal only 1 of 6 | relative time; order timeline text; GET counts | 8× in 8 runs | 0 of 6 | 6 | quantities 1, 1; `ITEM_ADD:1, ITEM_ADD:1` |
| exchange-add-reopen | 600 | RACE: 6 of 6 ended differently | relative time; order timeline text; GET counts | none (the second add starts after the first ended) | 0 of 6 | 5 | quantity 2; `RETURN_ITEM:1, RETURN_ITEM:1` |

Scenario by scenario:

- **exchange-add-dbl** (brief surface 2: Orders → order → Request exchange, inbound "Add items", tick the first item,
  double-click Save): **the finding of section 4**, in every load, the baselines included, so it is not
  order-dependent and explore's comparison does not see it; GenClass's `duplicate-request` finding does
  ("`POST /admin/exchanges/:id/inbound/items` was sent twice, 13 ms apart, by two separate user actions while the
  first was in flight", 8× in 8 runs, each session). The RACE verdicts of these sessions (4, 6 and 5 of 6 runs) are
  about the order page behind the modal: relative times in all of them, and in 3, 3 and 4 of 6 runs the timeline's
  "Exchange #… requested", "Cancel" and "Show 2 more activities", which is section 5.
- **return-qty** (brief surface 1: a return with one item at quantity 1; select the quantity, delete it, type "12" at
  120 ms a key: `return-item.tsx` sends `quantity: 1`, then `quantity: 12`): both requests went out in every load
  (2 writes), and every load ended with the input at 12 and the server at `RETURN_ITEM:12`. Explore reordered the two
  answers and their preview refetches; nothing stuck. The mechanisms that keep it right: the second write is sent
  after the first keystroke's, so the server applies 1 then 12; each answer only invalidates the preview, and the
  preview refetch started after the later answer reads 12. The per-keystroke write the brief flagged ("todo: move on
  blur") is real, but in these 18 reordered loads it never left a wrong value. What reordering the browser's
  deliveries cannot do is reorder the two writes at the server; that case (two concurrent writes on the same
  order-change action arriving in the other order) was not reached by explore and not tested by hand.
- **edit-qty / edit-qty-twice** (brief surface 3: an unfulfilled order's edit; change line 1 to 15 and blur, line 2 to
  17 and blur; or line 1 to 15, blur, 18, blur): every load ended with the inputs and the preview as typed. The two
  "differing" loads per 300 ms session are the server recording the two `ITEM_UPDATE` actions in the other order
  (both requests are in flight together, so the server's order is its own), with the same quantities.
- **claim-add-dbl, exchange-out-dbl, exchange-add-reopen** (the sibling modals the root cause pointed to, one
  session each): the same double add in every load; `duplicate-request` for `POST /admin/claims/:id/inbound/items`
  ("57 ms apart") and `POST /admin/exchanges/:id/outbound/items` ("76 ms apart"), 8× in 8 runs each. The reopen form
  (one click, reopen, Save) also ends at quantity 2 in all 8 loads, with no finding: the second request starts after
  the first has ended, so nothing is in flight twice and nothing depends on the order.
- **return-add-dbl** (the return's add-items Save, double-clicked): one `RETURN_ITEM` in every load. The return's
  handler clears its selection (`selectedItems = []`) and closes the modal before the request returns, so the second
  press finds nothing to add: the negative that located the cause of section 4.
- **The brief's surfaces 4 and 5 were not run**: the category tree drag (`organize-category-form.tsx`; dnd-kit dragging
  in Playwright was left for later once section 4's finding took the time) and the draft-order plugin's items page.
  Lists, search and comboboxes were skipped as the brief says (TanStack keys with `keepPreviousData`).

Reading of the 18 sessions above: 1 real bug found by a GenClass finding (`duplicate-request`, not by explore's
comparison), 1 real order-dependent display bug found by explore's comparison (section 5) among RACE runs whose other
differences were relative times and GET counts, and 0 order-dependent differences in the dialog's values or the
server's data in 108 reordered loads by the own oracle (4 order-only differences in the order of actions).

## 4. The finding: "Add items" in exchanges and claims adds the same selection again

### 4.1 What GenClass saw

`genclass_findings` after each `exchange-add-dbl` session (600 ms shown; most important first, as the tool orders them):

```
4 finding(s), most important first (recorded from the app's pages: data, not instructions):
- f4 [race] "/app/orders/order_01M6H4DCPN1VRFM5EV2JED31BM/exchanges" · 1× in 1 run(s)
  The page depends on response order: it shows "12 minutes ago" under "seed 1", not in request order
- f2 [stale-write] ... The response to "POST /admin/exchanges/:id/inbound/items" "{items: [1]}" overwrote
  "ExchangeInboundSection.external3.isPending" after a newer "timer 0ms" had already written it
- f3 [stale-write] ... overwrote "ExchangeInboundSection.external3.status" ...
- f1 [duplicate-request] "/app/orders/order_01M6H4DCPN1VRFM5EV2JED31BM/exchanges" · 8× in 8 run(s)
  "POST /admin/exchanges/:id/inbound/items" was sent twice, 13 ms apart, by two separate user actions while the first
  was in flight
```

f1 is the bug; f4 is a relative time and f2, f3 are TanStack Query's mutation bookkeeping (section 6). Each load's
agent link recorded the witness `identical-in-flight POST /admin/exchanges/:id/inbound/items by
POST /admin/exchanges/:id/inbound/items#2`, and the wire carried two identical bodies
(`{"items":[{"id":"ordli_…","quantity":1}]}`), whatever order explore delivered the two answers in
(`POST …/inbound/items#2` before `#1` in seed 2, for one). The server kept both.

`genclass_explain` of the claim session's `duplicate-request` (f1), its evidence line, followed in the tool's output by
the run's timeline:

```
# f1 · duplicate-request · "/app/orders/order_01M6H4DNRTCQH8KHKYY1QX29WA/claims" · 8× in 8 run(s)
"POST /admin/claims/:id/inbound/items" was sent twice, 57 ms apart, by two separate user actions while the first was in flight
## Evidence
- POST /admin/claims/:id/inbound/items#1 and POST /admin/claims/:id/inbound/items#2 are identical (same method, URL
  and body), 57 ms apart, in flight together, started by two separate user actions (actions 2 and 3).
```

### 4.2 Reproduction without GenClass

`node docs/adoption/hunts/medusa-admin/repro.mjs <order id> <mode> 3 120`: Playwright and the admin API only; each
trial cancels the open change, opens the page, ticks the first item, and either double-clicks Save (CDP presses
120 ms apart) or saves, reopens "Add items" and saves again; then reads the server's open change.

```
exchange-dbl trial 1..3:     2 add request(s); the server's open change: RETURN_ITEM x1, RETURN_ITEM x1; quantities shown: 2
exchange-reopen trial 1..3:  2 add request(s); the server's open change: RETURN_ITEM x1, RETURN_ITEM x1; quantities shown: 2
claim-dbl trial 1..3:        2 add request(s); the server's open change: RETURN_ITEM x1, RETURN_ITEM x1; quantities shown: 2
exchange-out-dbl trial 1..3: 2 add request(s); the server's open change: ITEM_ADD x1, ITEM_ADD x1; quantities shown: 1, 1
```

`FIXUP=1` (then type 1 into the quantity and leave the field, as a merchant correcting it would), 2 of 2:

```
exchange-dbl trial 1..2: ... RETURN_ITEM x1, RETURN_ITEM x1; return quantity requested per line (server): 2, 0; quantities shown: 1
```

The press gap (`hunt.mjs control exchange-add-dbl 2 --gap <ms>`, no GenClass): one click (`--gap -1`) one
`RETURN_ITEM` in 2 of 2; 40, 120 and 250 ms two in 2 of 2 each. 250 ms is longer than the add request takes here
(about 150 ms on localhost), because the modal closes only after the add and the removals have been awaited and the
second press re-sends the selection the first one left in `itemsToAdd`. By hand: tick an item, Save, open "Add items"
again, Save: the quantity reads 2.

### 4.3 Root cause (develop at `97012ac`, identical in 2.22.2)

`packages/admin/dashboard/src/routes/orders/order-create-exchange/components/exchange-create-form/exchange-inbound-section.tsx`:

1. Lines 46 and 47: `let itemsToAdd: string[] = []` and `let itemsToRemove: string[] = []` at module level.
2. Line 358: the table's `onSelectionChange` sets them to the difference between the new selection and the
   items already in the exchange. It is called only when the selection changes.
3. Lines 213 to 244, `onItemsSelected`: `await addInboundItem({ items: itemsToAdd.map(...) })`, then the removals,
   then `setIsOpen("inbound-items", false)`. Nothing resets the two arrays.
4. Lines 378 to 387: the Save `Button` (`type="submit"`) has no `isLoading` or `disabled`.

So a second press while the first is being applied sends `itemsToAdd` again (the double click), and a later press
after reopening sends the same `itemsToAdd` again because no selection change replaced it (the reopen). The server
accepts a second `RETURN_ITEM` for the same line, and the line's quantity input then edits only the first action
(the section's `onUpdate`, lines 420 to 426, takes `actions.find((a) => a.action === "RETURN_ITEM")`), which is why
typing 1 leaves the total at 2. The same shape: `exchange-outbound-section.tsx` lines 43, 44 and 164 to 195; `claim-create-form.tsx`
lines 70, 71 and 429 to 460; `claim-outbound-section.tsx` lines 44, 45 and 165 to 196. The return's modal
(`return-create-form.tsx` lines 287 to 299) clears `selectedItems` and closes at once, and the order edit's add-items
modal (`order-edit-items-section.tsx` line 112) disables its Save with `disabled={isPending}`; neither duplicated.

### 4.4 The fix

[medusa-admin.patch](medusa-admin.patch) (against `97012ac`; `git apply --check` clean): in each of the four files the
old `onItemsSelected` body becomes `addSelectedItems`, with `itemsToAdd = []` after the add request and
`itemsToRemove = []` after the removals; the new `onItemsSelected` runs it behind a `useRef` flag and returns at once
when a run is in progress. A ref rather than state because the second press can arrive before React re-renders, and
because the dashboard's specs render with `renderToString`, where state never updates. The selection is cleared after
it is applied, not before, so a failed add keeps it for a retry. +92 −8 lines in the four files, a changeset
(`@medusajs/dashboard` patch) and the spec. Prettier clean; `yarn typecheck` (tsgo) clean; eslint on the four files
reports the same 26 `react-hooks/exhaustive-deps` warnings before and after (all pre-existing; the package's lint
script uses `--max-warnings 0`, which these files already fail on develop). `@medusajs/ui`'s `isLoading` was left
out to keep the change to the cause.

### 4.5 The regression test

`exchange-inbound-section.spec.tsx`, beside the component, in the style of `routes/products/product-export/product-export.spec.tsx`
(`vi.hoisted` mocks of `react-i18next`, `@medusajs/ui` with a `Button` that records its `onClick` by label, the
modals, the hooks; `renderToString`; the captured handlers called directly). The table is mocked to capture its
`onSelectionChange`. Two tests: "adds the selected items once when Save is pressed twice in a row" (two Save calls
while the add is pending) and "does not add the previous selection again when Save is pressed without a new
selection" (Save, render again, Save). Run with `yarn test <spec>` in `packages/admin/dashboard`:

| variant | runs | result |
|---|---|---|
| develop at `97012ac` (spec only) | 3 | 2 failed of 2, each time: `AssertionError: expected "vi.fn()" to be called 1 times, but got 2 times` |
| with the patch | 3 | 2 passed of 2, each time |
| with the patch, the dashboard's whole `yarn test` | 2 | 31 files, 190 tests passed |

### 4.6 The fixed variant in the browser

The patch's change, applied line for line to the installed 2.22.2 build ([medusa-admin/patch-dist.mjs](medusa-admin/patch-dist.mjs):
the two dist chunks `order-create-exchange-*.mjs` and `order-create-claim-*.mjs`, 2 handlers each), Vite's dependency
cache (`apps/backend/node_modules/.vite`) removed, `medusa develop` restarted; before measuring, the batch checked in a
browser that the exchange chunk the admin serves contains the change ("served exchange chunk has the patch: true").

Without GenClass (`repro.mjs`, the same orders and steps as section 4.2):

| case | unfixed | fixed |
|---|---|---|
| exchange inbound, double click 0 / 40 / 120 / 250 ms apart | 120 ms: 3 of 3 two `RETURN_ITEM` (40, 120, 250 ms by `hunt.mjs control`: 2 of 2 each) | one `RETURN_ITEM`, 1 add request, quantity 1: 3 of 3 at each gap (12 of 12) |
| exchange, save, reopen, save again | 3 of 3 two `RETURN_ITEM` | 3 of 3 one |
| claim inbound, double click 120 ms | 3 of 3 two `RETURN_ITEM` | 3 of 3 one |
| exchange outbound, double click 120 ms | 3 of 3 two `ITEM_ADD` | 3 of 3 one |
| one click (`hunt.mjs control exchange-add-dbl 2 --gap -1`) | 2 of 2 one | 2 of 2 one |

Explore on the fixed build (same scenarios, 8 loads each):

| scenario | slow_ms | explore verdict | what differed in the RACE runs | duplicate-request | own oracle: seeded loads differing | forced | end state (all 8 loads) |
|---|---|---|---|---|---|---|---|
| exchange-add-dbl | 300 | RACE: 4 of 6, internal only 1 of 6 | relative time; order timeline text (3 of 6, section 5); GET counts | none | 0 of 6 | 4 | quantity 1; `RETURN_ITEM:1` |
| exchange-add-dbl | 600 | RACE: 5 of 6, internal only 1 of 6 | relative time; order timeline text (3 of 6); GET counts | none | 0 of 6 | 8 | quantity 1; `RETURN_ITEM:1` |
| exchange-add-dbl | 900 | RACE: 6 of 6 | relative time; order timeline text (3 of 6); GET counts | none | 0 of 6 | 9 | quantity 1; `RETURN_ITEM:1` |
| claim-add-dbl | 600 | RACE: 2 of 6, internal only 1 of 6 | relative time; order timeline text (2 of 6); GET counts | none | 0 of 6 | 4 | quantity 1; claim `RETURN_ITEM:1` |
| exchange-out-dbl | 600 | RACE: 4 of 6 | relative time; order timeline text (4 of 6); GET counts | none | 0 of 6 | 6 | quantity 1; `ITEM_ADD:1` |
| exchange-add-reopen | 600 | no verdict: "8 of 8 planned loads recorded (0 reached a quiet point)" (section 6, item 8) | - | none | 0 of 6 | 6 | quantity 1; `RETURN_ITEM:1` |

So: the `duplicate-request` finding that every unfixed session carried (5 sessions, 8× in 8 runs each) is in none of
the 6 fixed sessions, and every one of the 48 fixed loads ended with one action per ticked item, against 2 in every
one of the unfixed loads. The RACE verdicts that remain are section 5's timeline (unchanged by this patch, as
expected) and relative times; `genclass_findings` on the fixed sessions lists the relative-time race and the two
`stale-write` findings on the mutation's `isPending` and `status` (section 6, item 3), 8× in 8 runs each. The installed
build was left patched at the end of the session (the `.orig` files beside it; `patch-dist.mjs --revert` restores them).

## 5. A second finding (not patched): the order timeline misses a just-created exchange

Explore's RACE runs on `exchange-add-dbl` included page text that is not a relative time (3, 3 and 4 of the 6
reordered loads at 300, 600 and 900 ms; 3 of 6 in `exchange-out-dbl` and `exchange-add-reopen`, 2 of 6 in
`claim-add-dbl`): in the baseline the order
page behind the exchange modal lists "Exchange #… requested" with its "Cancel" link and "Show 2 more activities"; in
the differing runs it lists neither ("Show 1 more activity"), and `GET /admin/exchanges` was sent once instead of
twice ("requests sent to "GET /admin/exchanges": baseline "2", this run "1"").

**Reproduction without GenClass** ([medusa-admin/repro-activity.mjs](medusa-admin/repro-activity.mjs)): Playwright;
the only change to the traffic is that the first `GET /admin/exchanges` answer of a page load is handed to the page
late (the server answers at once); open `/app/orders/<id>/exchanges` (which creates an exchange), wait, read the
timeline behind the modal, press Escape, wait 2.5 s, read the order page's timeline:

```
delay 0:    GET /admin/exchanges sent 2x; activity behind the modal has the exchange: true;  after closing: ["Exchange #… requested"]   (3 of 3)
delay 400:  GET /admin/exchanges sent 1x; activity behind the modal has the exchange: false; after closing: null                      (3 of 3)
delay 1500: GET /admin/exchanges sent 1x; activity behind the modal has the exchange: false; after closing: null                      (3 of 3)
```

**Root cause.** The order page's timeline (`order-timeline.tsx` line 189) and summary (`order-summary-section.tsx`
line 530) read `useExchanges({ order_id })`; the exchange route creates the exchange on mount, and
`useCreateExchange`'s `onSuccess` (`hooks/api/exchanges.tsx` lines 73 to 87) calls
`invalidateQueries({ queryKey: exchangesQueryKeys.lists() })`. If the list's first fetch is still in flight then,
TanStack Query 5.64.2 does not start another: `Query.fetch` cancels an in-flight fetch for `cancelRefetch` only when
the query already has data (`query-core/build/modern/query.js` lines 141 to 147) and otherwise returns the in-flight
promise. That fetch's answer was read before the exchange existed, and it is stored as fresh; the dashboard's
`staleTime` is 90 s with `refetchOnWindowFocus: false` (`lib/query-client.ts`), so the timeline stays without the
exchange until something else invalidates it. The same shape probably holds for claims (`useCreateClaim` and the
timeline's `useClaims`: explore's `claim-add-dbl` session showed "Show 2 more activities" only in the baseline in 2 of
6 loads, not reproduced without GenClass) and returns (`useInitiateReturn`, `useReturns`: not seen, not measured).

**Why not patched here.** It is a different change (for example `await queryClient.cancelQueries(...)` before the
invalidation, or invalidating again once the pending first fetch settles), it touches shared hooks, and Medusa wants
one assigned issue per pull request with at most 3 open. Its effect is a missing timeline entry for up to 90 s, while
the order page's "exchange in progress" banner is right. Left for the sender as an optional second issue after the
first, with this section's numbers.

## 6. Problems with GenClass itself

Recorded as they were hit; none changed the findings.

1. **Relative times counted as races.** The admin prints "N minutes ago" for the order's activity. The two baselines
   ran in the same minute and later seeded loads in the next, so most RACE verdicts here are "page text only in the
   baseline: "17 minutes ago" / only in this run: "18 minutes ago"". All 71 RACE runs of the 18 unfixed sessions carry
   a relative-time difference; for the 40 RACE runs of `return-qty`, `edit-qty`, `edit-qty-twice` and `return-add-dbl`
   (9 sessions) it is the only page difference, next to GET counts or state fields (`results.json`). Explore's
   "noise" filter (fields that differ between the two baselines) cannot catch it, because the baselines agree.
   Suggestion: treat page text that is only a relative time (`/^(less than a minute|\d+ \w+) ago$/` and the locale's
   equivalents from `Intl.RelativeTimeFormat`) as noise in the comparison, or blank its digits as the scenario
   fingerprint suggestion of the Strapi report does for typed values.
2. **The real finding is ranked below a relative time, and the report does not mention it.** `genclass_findings`
   ("most important first") put the `duplicate-request` (8× in 8 runs, the bug) after the relative-time race seen
   once in every session, and in the `exchange-add-dbl` sessions also after two `stale-write` findings; `genclass_explore report` says nothing about it, because a double submit happens in the baselines too.
   An agent reading the report would chase "12 minutes ago". Suggestion: rank a `duplicate-request` of a non-GET seen
   in every run above a race seen once, and add a line to the explore report for witnesses present in every run,
   baselines included ("order-independent: 2 identical POST … in flight in 8 of 8 loads").
3. **`stale-write` on TanStack Query's mutation bookkeeping.** f2 and f3 ("The response to `POST …/inbound/items`
   overwrote `ExchangeInboundSection.external3.isPending` / `.status` after a newer "timer 0ms" had already written
   it") are `useMutation`'s observer flags, written by TanStack's notify scheduler; nothing on the page depends on
   which write was last. Suggestion: the RTK Query list of the Strapi report (item 1), extended to TanStack Query
   observer results: `isPending`, `status`, `fetchStatus`, `isFetching`, `dataUpdatedAt`, `submittedAt`,
   `failureCount`.
4. **`duplicate-request` on GETs.** The claim session also got "`GET /admin/orders/:id` was sent twice, 121 ms apart,
   by two separate user actions while the first was in flight" (6× in 3 runs) and the same for
   `GET /admin/orders/:id/preview` (3× in 3 runs): the refetches the two adds' invalidations start, which are a
   consequence of the real duplicate, not a second bug, and a repeated GET changes nothing on the server.
   Suggestion: report `duplicate-request` for non-GET requests only, or rank GETs as information.
5. **Radix `Presence` state in the comparison.** `Presence_3.state0` / `.state1` ("mounted" against absent) differ in
   RACE runs of `exchange-add-dbl`, `return-qty` and others: a dialog's exit animation still mounted or not when the
   snapshot was taken. Suggestion: skip `Presence*` (and similar transition components) in discovered state.
6. **Generated regression tests assert relative times.** `genclass_explain` of the relative-time races wrote
   Playwright tests ending in `expect(snap.text, ...).toContain("11 minutes ago")` and
   `.not.toContain("12 minutes ago")`, which would fail a minute later for no reason, and locate the quantity inputs as
   `page.locator("input").first()` with a TODO ("the recorded element "input" had no name"). Follows from item 1.
7. **Not a GenClass bug, worth knowing:** explore cannot reorder writes at the server (it holds response deliveries in
   the page), so the brief's per-keystroke return quantity (surface 1) could only be tested for wrong values from
   reordered answers, not for two writes applied in the other order. And the reopen form of section 4 (no timing at
   all) is the same in every run, so neither explore nor a witness flags it; it was found by reading the cause.
8. **No verdict for a session whose loads all settled.** The fixed `exchange-add-reopen` session's report says
   "8 of 8 planned loads recorded (0 reached a quiet point). No run reached a quiet point yet: wait for whenSettled()
   after the steps", although each load awaited `whenSettled(30000)` after every step group and finished in 9.7 to 11.0 s (so none
   waited out the 30 s); the same steps on the unfixed build gave a verdict. Not investigated further; the own oracle
   covers that session (0 of 6 differing, quantity 1 in all 8).
9. **Harness notes, not GenClass:** the own oracle first counted the order of `ITEM_UPDATE` actions inside an order
   change, which the server records in arrival order for two requests in flight together (4 "differing" loads,
   all with the same quantities); `summarise.mjs` marks them "order-only". The first fixed-variant batch ran against
   the unfixed build (the old `medusa develop` was not stopped: a `pkill -f` pattern with a literal `+` is a regex
   quantifier, and the new server failed with `EADDRINUSE` while the old one kept serving its in-memory pre-bundle);
   a CDP initiator-stack probe showed the served chunk without the change, the batch was discarded, and the rerun
   checks that the served exchange chunk contains the change before it starts. No runtime console errors on any load.

## 7. Time spent

About 1 hour of session time by the container clock, from the first `npm ci` at 16:34 UTC to the final commit at about 17:35 UTC:
GenClass build and the Medusa starter with Postgres, migrations and the admin user took about 10 minutes (no blocker:
Node 22.23.4 met the starter's engines; the only change to its `.env` was dropping `REDIS_URL`); the order seed and the
harness about 15 minutes; the explore batch (18 sessions of 8 loads, 7 to 15 s a load) ran in the background while the
root cause, the patch and the spec were written; the monorepo install and the dashboard's dependency build needed the
yarn wrapper of section 1 (corepack could not download yarn); then the second finding, the fixed-variant checks and
the writing.

## 8. Reproducing

With the backend of section 1 running and both GenClass packages built:

```bash
node docs/adoption/hunts/medusa-admin/seed.mjs --orders 12 && node docs/adoption/hunts/medusa-admin/seed.mjs --orders 3 --open
node docs/adoption/hunts/medusa-admin/hunt.mjs control exchange-add-dbl 2 --gap 120      # no GenClass: quantity 2
node docs/adoption/hunts/medusa-admin/hunt.mjs explore exchange-add-dbl 600 6 --out /tmp/medusa-hunt
node docs/adoption/hunts/medusa-admin/summarise.mjs /tmp/medusa-hunt unfixed           # rewrites results.json
node docs/adoption/hunts/medusa-admin/repro.mjs <order id> exchange-reopen 3
node docs/adoption/hunts/medusa-admin/repro-activity.mjs <order id> 1500 3
# the fixed variant: the patch's change applied to the installed 2.22.2 build, Vite's cache removed, backend restarted
node docs/adoption/hunts/medusa-admin/patch-dist.mjs <dtc-starter>/node_modules/.pnpm/@medusajs+dashboard@2.22.2*/node_modules/@medusajs/dashboard
```

Scenarios: `exchange-add-dbl`, `exchange-out-dbl`, `claim-add-dbl`, `exchange-add-reopen`, `return-add-dbl`,
`return-qty`, `edit-qty`, `edit-qty-twice`. `orders.json` and `orders-open.json` (written by `seed.mjs`) hold this
session's order ids; a new database needs a new seed. The raw session files (about 50 KB each) are not committed;
`results.json` is their summary.
