# Race hunt: Linkwarden web app (`dev` at 45325d4)

A GenClass race hunt on Linkwarden's web app, run on 2026-11-03 in a cloud session (adoption swarm, slug
`linkwarden`, type hunt), with the real `@genclass/runtime` (0.3.0-beta.5, this repository at `c1c9e14`) injected
into the app by Playwright and the real `@genclass/mcp` (0.2.1, same commit) driven the way a coding agent drives it.
Linkwarden's source was not modified for the hunt; the fix is a patch for its maintainers
([linkwarden.patch](linkwarden.patch), draft issue and pull request text in
[linkwarden-issue.md](linkwarden-issue.md)). Nothing was sent to Linkwarden's repository, Discord or maintainers.

**Headline.** One real race, in `useUpdateUserPreference` (`packages/router/user.tsx`), the hook behind the theme
switch, the profile menu's theme picker and the reader view's text style menu. Each change is applied optimistically,
then its response is written over the `["user"]` cache (and onto `<html data-theme>`) in `onSuccess`, in whatever
order the responses arrive. Two quick changes whose responses come back out of order leave the page on the older
value while the server stores the newer one: the light/dark switch clicked twice (light → dark → light) ended **dark**
on the page with **light** on the server; three "+" clicks on the reader's font size (20 → 26px) ended showing 22px or
24px with 26px on the server, and in 3 loads lost a step on the server too (24px stored). Explore reported it in every
font-size session (3 or 4 of 6 reordered loads, 6 sessions) and in every theme session from seed 7 (3 or 4 of 6, 3
sessions); every replay reproduced it; a plain Playwright script that only delays the first preference response
reproduces it in 3 of 3 trials for each of the two cases (the theme ends dark, the font size shows 22px), and in 0 of
3 without the delay. A 16-line change in one hook (only the latest update writes its response) plus a Vitest file
fixes it: the test fails 3 of 3 runs before and passes 3 of 3 after; on the fixed app 0 of 72 reordered loads ended
differently in 12 explore sessions (32 of 72 before), and the delayed-response script ended on the last choice in 6
of 6 trials. The two scenarios from the brief's list (a link renamed while the preservation poll is in flight, pin
then unpin) showed no order-dependent page.

One measured caveat about GenClass itself, which matters for anyone reading a negative: with the default seeds 1 to 6,
explore said **"No race found"** on the racing theme switch at all three latencies, because for that pair of request
keys every one of the six seeds orders `PUT …/preference#1` before `#2` (section 6, item 1).

Sections: 1 setup, 2 how the app was driven, 3 scenarios and verdicts, 4 the finding, 5 the brief's other surfaces,
6 problems with GenClass itself, 7 time spent, 8 reproducing.

## 1. Setup

| what | version |
|---|---|
| Linkwarden | `linkwarden/linkwarden` branch `dev`, commit `45325d45c5326f4418159294dcafdafbb95fbd62` (2026-10-19, "minor fix"), the commit the patch is against; `apps/web` Next.js 15.5.21 (Pages Router, dev server), React 19.1.0, `@tanstack/react-query` 5.51.15, Prisma 6.10.1, Vitest 4.1.0 |
| Node, Yarn | 22.23.4, 4.12.0 (corepack) |
| database | PostgreSQL 16.15 from apt, no Meilisearch (search falls back to PostgreSQL), no worker |
| browser | Chromium 1243 (headless shell, preinstalled), Playwright 1.63.0 from this repository's `node_modules` |
| GenClass | `@genclass/runtime` 0.3.0-beta.5 and `@genclass/mcp` 0.2.1 from this repository at `c1c9e14`, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |

Commands, in order:

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# PostgreSQL
apt-get install -y postgresql && service postgresql start
su postgres -c "psql -c \"CREATE USER linkwarden WITH PASSWORD 'linkwarden' CREATEDB;\" -c \"CREATE DATABASE linkwarden OWNER linkwarden;\""

# Linkwarden, outside this checkout
git clone https://github.com/linkwarden/linkwarden.git ~/targets/linkwarden && cd ~/targets/linkwarden && git checkout dev
export COREPACK_NPM_REGISTRY=https://registry.npmjs.org     # repo.yarnpkg.com is blocked by this container's proxy (403)
corepack enable && corepack prepare yarn@4.12.0 --activate
yarn install            # exits 1 here: apps/web's postinstall `playwright install --with-deps chromium` cannot reach
                        # cdn.playwright.dev (blocked, 403), so the root postinstall stops before patch-package
npx patch-package && yarn prisma:generate                   # the two steps the failed postinstall skipped
printf 'NEXTAUTH_URL=http://localhost:3000/api/v1/auth\nNEXTAUTH_SECRET=<random>\nDATABASE_URL=postgresql://linkwarden:linkwarden@localhost:5432/linkwarden\nDISABLE_BROWSER=true\nNEXT_TELEMETRY_DISABLED=1\n' > .env
yarn prisma:deploy
yarn web:dev            # http://localhost:3000

# seed (this repository): user test/password through POST /api/v1/users, 3 collections, 120 links on .example.test
node docs/adoption/hunts/linkwarden/seed.mjs --links 120
# with DISABLE_BROWSER=true the app marks a new link preserved at once (every format "unavailable"); the 12 newest
# were set back to pending so the 5 s preservation polling of the list and the link pages runs, as without a worker:
psql postgresql://linkwarden:linkwarden@localhost:5432/linkwarden -c 'update "Link" set "lastPreserved"=null where id > 108;'
```

## 2. How the app was driven

[linkwarden/hunt.mjs](linkwarden/hunt.mjs) is the whole loop, adapted from [strapi/hunt.mjs](strapi/hunt.mjs):

- **MCP server in-process.** `serve()` from `packages/mcp/dist/index.js` with its bridge on a free port; the tools
  are called through JSON-RPC `tools/call`: `genclass_explore` (start with `runs: 6`, `slow_ms` 300, 600 or 900 and
  `seed`; then `report`), `genclass_explain`, `genclass_replay` (arm, one load, result), `genclass_findings`,
  `genclass_status`.
- **Injection without touching Linkwarden.** A context route rewrites every HTML document from `localhost:3000` to
  add, at the top of `<head>`: `window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false,
  visual: false, devtools: false }` and the bridge URL; the script-tag build `/__genclass/genclass.global.js`
  (served by the route from `packages/runtime/dist`); and a module script that imports `/__genclass/agent.js` and
  calls `connectAgent(window.GenClass.runtime, { url })`. No model, no telemetry; every host but `localhost` is
  aborted; Chromium runs with `--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers` (a
  route-fulfilled document has no address space of its own, as in the Strapi hunt). State discovery found the React
  component state and the TanStack Query hook results (`ToggleDarkMode.external0.data`,
  `TextStyleDropdown.external0.data`, `CardView.*`, ...): 500 to 1,000 fields per snapshot.
- **One page load per run, same start state.** Before every load the harness resets with `psql` what its scenarios
  change (the link's name, pin and pending state; the user's theme `light`, font size `20px`, line height `1.8`), so
  the same steps send the same requests with the same bodies on every run. Each load waits for
  `window.__GENCLASS_AGENT__.connected`, the page's control, and a first `whenSettled()`, does its steps, awaits
  `whenSettled()` again, then reads its own oracle: the DOM (what the scenario's control shows) and the server's
  stored values (`psql`). The context closes 600 ms later so the last batch reaches the bridge.
- **Secondary oracle.** `compareOracles` in the harness compares each seeded load's DOM plus server state with the
  two fifo baselines'; a seeded load differs when it equals neither. It is this script's own check, next to the
  explore verdict, never a replacement for it. [linkwarden/summarise.mjs](linkwarden/summarise.mjs) reduces the
  session files to [linkwarden/results.json](linkwarden/results.json) (every load's delivery order of the writes, its
  oracle and the server state) and the table below; [linkwarden/sweep.sh](linkwarden/sweep.sh) runs every session.

## 3. Scenarios and verdicts

Every verdict below is the explore report's own wording reduced to counts. A session is one `genclass_explore` session
of 8 loads (2 fifo baselines, 6 seeded), all loads with the same steps; "compared" is the report's own count of seeded
runs compared against two baselines (one group in every session: the recorded actions were the same on every load);
"internal only" counts seeded runs the report listed with store differences only (React `useId` values such as
`Tooltip.state1` `«r4»`/`«r6»`, `isFetchedAfterMount`, the reader content's state present in some orders); "forced"
counts responses released because their hold ran out. Every load of every session below reached a quiet point.

| scenario | slow_ms | seeds | explore verdict | compared | internal only | DOM+server oracle: seeded loads differing | replay | stale-write findings | forced | load errors |
|---|---|---|---|---|---|---|---|---|---|---|
| edit-name | 300 | 1-6 | no race | 6 of 6 | 6 | 0 of 6 | - | 20 | 0 | 0 |
| edit-name | 600 | 1-6 | no race | 6 of 6 | 6 | 0 of 6 | - | 20 | 1 | 0 |
| edit-name | 900 | 1-6 | no race | 6 of 6 | 6 | 0 of 6 | - | 20 | 1 | 0 |
| pin-unpin | 300 | 1-6 | no race | 6 of 6 | 6 | 0 of 6 | - | 20 | 0 | 0 |
| pin-unpin | 600 | 1-6 | no race | 6 of 6 | 6 | 0 of 6 | - | 20 | 0 | 0 |
| pin-unpin | 900 | 1-6 | no race | 6 of 6 | 6 | 0 of 6 | - | 20 | 2 | 0 |
| theme-twice | 300 | 1-6 | no race | 6 of 6 | 5 | 0 of 6 | - | 12 | 0 | 0 |
| theme-twice | 300 | 7-12 | race: 3 of 6 | 6 of 6 | 2 | 3 of 6 (seeds 7, 8, 11) | reproduced | 14 | 0 | 0 |
| theme-twice | 600 | 1-6 | no race | 6 of 6 | 5 | 0 of 6 | - | 12 | 0 | 0 |
| theme-twice | 600 | 7-12 | race: 3 of 6 | 6 of 6 | 3 | 3 of 6 (seeds 7, 8, 12) | reproduced | 16 | 0 | 0 |
| theme-twice | 900 | 1-6 | no race | 6 of 6 | 5 | 0 of 6 | - | 12 | 0 | 0 |
| theme-twice | 900 | 7-12 | race: 4 of 6 | 6 of 6 | 2 | 4 of 6 (seeds 7, 8, 11, 12) | reproduced | 16 | 0 | 0 |
| font-size | 300 | 1-6 | race: 3 of 6 | 6 of 6 | 1 | 3 of 6 (seeds 2, 4, 5) | reproduced | 12 | 0 | 0 |
| font-size | 300 | 7-12 | race: 4 of 6 | 6 of 6 | 1 | 4 of 6 (seeds 7, 8, 9, 11) | reproduced | 14 | 0 | 0 |
| font-size | 600 | 1-6 | race: 4 of 6 | 6 of 6 | 0 | 4 of 6 (seeds 2, 3, 4, 5) | reproduced | 12 | 0 | 0 |
| font-size | 600 | 7-12 | race: 4 of 6 | 6 of 6 | 1 | 4 of 6 (seeds 7, 8, 11, 12) | reproduced | 12 | 0 | 0 |
| font-size | 900 | 1-6 | race: 3 of 6 | 6 of 6 | 1 | 3 of 6 (seeds 2, 4, 5) | reproduced | 12 | 0 | 0 |
| font-size | 900 | 7-12 | race: 4 of 6 | 6 of 6 | 1 | 4 of 6 (seeds 7, 8, 11, 12) | reproduced | 14 | 0 | 0 |

Columns: *stale-write findings* is the number of stale-write findings `genclass_findings` listed at the end of the
session (the bridge was cleared before each session); section 6, items 2 and 3, says what they were. *load errors*
counts loads whose steps failed (none in this table). The pin-unpin sessions ran last, after the patch had been
applied to the dev server for the fixed-variant check; the patch changes only `useUpdateUserPreference`, which
pinning does not call (`lib/client/pinLink.ts` → `useUpdateLink`). A first pin-unpin sweep was discarded: the harness
clicked the card's menu while the previous one was still closing, and 22 of its 24 loads timed out before their
second step (section 6, item 6). The edit-name sessions ran with the harness's earlier `openCardMenu`, which pressed
Escape before opening the menu (recorded as a `key` action, on every load alike).

Scenario by scenario (the files and lines are at `45325d4`):

- **theme-twice** (reader view `/preserved/120?format=3`, the light/dark switch in its top bar clicked twice: light
  → dark → light; `components/ToggleDarkMode.tsx` → `useUpdateUserPreference`): **the race of section 4** in every
  session from seed 7: the loads that delivered `PUT /api/v1/users/:id/preference#2` before `#1` (seeds 7, 8, 11 or
  12, depending on the delay) ended with `data-theme="dark"` and the switch on dark, the server holding `light`. Seeds
  1 to 6 delivered `#1` first in all 18 seeded loads, so those three sessions compared nothing that could differ
  (section 6, item 1).
- **font-size** (reader view, the text style menu (`components/TextStyleDropdown.tsx`), "+" on the font size three
  times: 20 → 22 → 24 → 26px; the menu stays open): **the same race**, in every session. Three `PUT`s give more
  orders: a load that delivered `#1` last showed 22px, one that delivered `#2` last showed 24px, with 26px on the
  server. In 3 loads (300 ms seeds 4 and 9, 600 ms seed 3) the server stored 24px: `#1`'s response (22px) landed
  between the second and third click and replaced the optimistic 24px, so the third click computed 22 → 24 from it
  and sent 24px. The user clicked "+" three times and the setting moved twice.
- **edit-name** (the list `/links`, the first card's menu → "Edit link", type a new name, wait until the list's 5 s
  preservation poll `GET /api/v1/search?cursor=0&sort=0` is sent, then "Save changes" at once, so the poll and the
  `PUT /api/v1/links/:id` overlap): no race; section 5.
- **pin-unpin** (the list, the first card's menu → "Pin to Dashboard", then at once the menu again → "Unpin"): no race;
  section 5.

## 4. The finding

### 4.1 What explore saw

Session `theme-twice`, 600 ms, seeds 7 to 12 (the 300 and 900 ms sessions are the same story). Baselines: both ended
light. The report, reduced:

```
Compared: 6 of 6 reordered run(s) against two baselines.
RACE: 3 of 6 reordered run(s) ended in a different state than the baseline (responses in request order): what the
page shows, its form values, the writes it sent or its errors differ.
- run r14 (seed 7):
    field "input": baseline "unchecked", this run "checked"
- run r15 (seed 8):
    field "input": baseline "unchecked", this run "checked"
- run r19 (seed 12):
    field "input": baseline "unchecked", this run "checked"
Race finding(s): f47.
```

`genclass_explain f47`, the evidence in causal order, reduced to the lines about the two requests and the switch's
hook result (times from `connectAgent`; the holds in brackets are the schedule's; the long field lists are cut at
"…"):

```
+5.188s action 1: click checkbox
+5.197s send PUT /api/v1/users/:id/preference#1 "{theme: \"dark\"}" (action 1)
+5.206s write ToggleDarkMode.external0.data, … by action 1: "… changed theme: \"light\" → \"dark\""
+5.285s action 4: click checkbox
+5.286s send PUT /api/v1/users/:id/preference#2 "{theme: \"light\"}" (action 4)
+5.293s write ToggleDarkMode.external0.data, … by action 4: "… changed theme: \"dark\" → \"light\""
+5.718s delivered PUT /api/v1/users/:id/preference#2 (held 406 ms)
+5.730s write ToggleDarkMode.external0.data, … by PUT /api/v1/users/:id/preference#2
+5.749s delivered PUT /api/v1/users/:id/preference#1 (held 509 ms)
+5.766s write ToggleDarkMode.external0.data, ToggleDarkMode.external0.dataUpdatedAt by PUT /api/v1/users/:id/preference#1:
        "ToggleDarkMode.external0.data: 36 → 36 entries: changed theme: \"light\" → \"dark\" and 1 more"
```

The writes by actions 1 and 4 are `onMutate`'s optimistic updates; the writes by the two `PUT`s are `onSuccess`.
So: both changes were applied at once and the server received them in order (it stored `light`), but `#1`'s response,
delivered last, wrote `theme: "dark"` over the cache and onto `<html data-theme>`. In the fifo baselines `#1`'s
response comes first and `#2`'s repairs it; that repair is visible as `overwrote-newer` witnesses in every baseline
(the response to `{theme: "dark"}` overwrote the newer optimistic "light"): in request order the page flips to dark for
one round trip before settling on light.

The replay (`genclass_replay arm` with the finding, one load, `result`): "REPRODUCED · ended with the same wrong values
as the failing run" in all three theme sessions; for font size "REPRODUCED · the page shows the failing run's text
again" in all six.

### 4.2 Reproduction without GenClass

[linkwarden/repro.mjs](linkwarden/repro.mjs): a logged-in context, `context.route` on
`/api/v1/users/:id/preference` that lets each request reach the server at once (`route.fetch()`) and only holds the
answer to the **first** one by `--delay` ms; nothing else is touched and nothing is injected into the page. Then the
steps (switch twice; or "+" three times), a wait of delay + 3 s, the page's state and the server's stored values.

| case | first response delayed | trials | page after delay + 3 s | server stored |
|---|---|---|---|---|
| theme (switch twice, light → dark → light) | 1,500 ms | 3 | `data-theme="dark"`, switch on dark, 3 of 3 | `light`, 3 of 3 |
| theme | 0 ms | 3 | `data-theme="light"`, switch on light, 3 of 3 | `light`, 3 of 3 |
| font (+ three times, 20 → 26px) | 1,500 ms | 3 | 22px, 3 of 3 | 26px, 3 of 3 |
| font | 0 ms | 3 | 26px, 3 of 3 | 26px, 3 of 3 |

Commands: `node docs/adoption/hunts/linkwarden/repro.mjs --case theme --delay 1500 --trials 3` (and `--delay 0`,
and `--case font`). Every trial sent the expected number of `PUT`s (2 and 3).

[linkwarden/issue-repro.mjs](linkwarden/issue-repro.mjs) is the script quoted in the issue draft, verbatim but for its
session file and link id: on the unfixed app it printed `page: dark` and `server: light`.

### 4.3 Root cause (`packages/router/user.tsx` at `45325d45c5326f4418159294dcafdafbb95fbd62`)

1. Lines 93 to 135, `useUpdateUserPreference`: `onMutate` (lines 128 to 133) cancels `["user"]` and merges the change
   into the cached user (optimistic); `mutationFn` sends `PUT /api/v1/users/:id/preference` with the change only;
   `onSuccess` (lines 122 to 127) writes the whole user from the response with `setQueryData(["user"], data)` and sets
   `data-theme` on `<html>` from `data.theme`.
2. TanStack Query runs mutations of one `useMutation` concurrently (no `scope` here), so two quick changes are two
   requests in flight. Their responses can arrive in either order; each one's `onSuccess` writes its own snapshot of
   the user. The last response delivered wins, whichever change it answers.
3. The callers read the cache: `ToggleDarkMode.tsx` line 45 `checked={data?.theme === "dark"}`; `TextStyleDropdown.tsx`
   shows `data?.readableFontSize` and computes the next step from it (lines 186 to 219), which is how an older
   response also makes the next click send an older base value (the 24px stored above). `ProfileDropdown.tsx` line 149
   (the dashboard's Theme submenu) and `MainLayout.tsx` line 37 call the same hook.

`useUpdateUser` in the same file (lines 59 to 91; the sidebar's collection drag and drop, `CollectionListing.tsx` line
280, and the settings pages) has the same shape. It was not exercised in this hunt and is not in the patch; the issue
draft mentions it as a pointer.

### 4.4 The fix

[linkwarden.patch](linkwarden.patch), against `45325d4`, in Linkwarden's style (Prettier 3.1.1 clean, the root
`.prettierrc`): a module-level counter `latestPreferenceUpdate`; `onMutate` takes the next number and returns it as the
mutation's context; `onSuccess` returns early unless its context is the latest number, so only the newest change's
response is written over the cache and `data-theme`. Nothing else changes: the optimistic write, the request, the
single-change path and the error path (which, as before, does not roll back). It also removes the in-order flicker of
section 4.1, since `#1`'s response is no longer written while `#2` is in flight: on the fixed variant the 12 true
`overwrote-newer` witnesses per load are gone (24 per load before, 12 after, the 12 left being section 6, item 2). The counter is module state, shared by every
caller in one JavaScript context, and uses nothing web-only, so the hook stays usable from the Expo app
(`packages/router` is shared with it; the mobile app was not run). 16 added lines and 1 changed in `user.tsx` (4 of them the comment), one new test file of 118 lines.

Checked on the patch: `tsc --noEmit --strict` on `user.tsx` and the test (exit 0); `prettier --check` (clean); the whole
Vitest suite (`vitest run` at the root): 13 of 14 files pass, 52 tests passed and 16 skipped; the one failing file,
`apps/web/lib/api/controllers/links/linkId/updateLinkOrder.test.ts`, is a database test that fails the same way without
the patch ("Environment variable not found: DATABASE_URL") and was not pointed at the hunt's database. Linkwarden's
Playwright suite (`yarn workspace @linkwarden/web e2e`, one login spec) was not run: its Playwright 1.57 wants
Chromium build 1200, which this container cannot download (`cdn.playwright.dev` blocked).

### 4.5 Test and fixed-variant check

`packages/router/user.test.ts` (in the patch), colocated like `apps/web/lib/copyToClipboard.test.ts` and in its style
(`// @vitest-environment jsdom`, `vi` mocks, no testing-library, which the repository does not have): renders the hook
in a `QueryClientProvider` with `react-dom/client` and `act`, mocks `next-auth/react`'s `useSession`, stubs `fetch` so
each `PUT` waits until the test answers it, sends "dark" then "light", and answers in request order (test 1) and in
reverse (test 2); both expect the cache and `data-theme` to say "light".

| variant | `yarn vitest run packages/router/user.test.ts`, 3 runs | the delayed-response script, 1,500 ms, 3 trials each |
|---|---|---|
| `dev` at `45325d4` | **1 failed, 1 passed**, 3 of 3 runs: the reversed case, `expected 'dark' to be 'light'` | theme: dark shown, light stored, 3 of 3; font: 22px shown, 26px stored, 3 of 3 |
| with the patch | **2 passed**, 3 of 3 runs | theme: light shown and stored, 3 of 3; font: 26px shown and stored, 3 of 3; the issue's script printed `page: light`, `server: light` |

The same explore sessions on the fixed variant (the patch applied to the running dev server, which reloaded it):

| scenario | slow_ms | seeds | explore verdict | compared | internal only | DOM+server oracle: seeded loads differing | replay | stale-write findings | forced | load errors |
|---|---|---|---|---|---|---|---|---|---|---|
| theme-twice | 300 | 1-6 | no race | 6 of 6 | 5 | 0 of 6 | - | 12 | 0 | 0 |
| theme-twice | 300 | 7-12 | no race | 6 of 6 | 4 | 0 of 6 | - | 12 | 0 | 0 |
| theme-twice | 600 | 1-6 | no race | 6 of 6 | 5 | 0 of 6 | - | 12 | 0 | 0 |
| theme-twice | 600 | 7-12 | no race | 6 of 6 | 4 | 0 of 6 | - | 19 | 0 | 0 |
| theme-twice | 900 | 1-6 | no race | 6 of 6 | 5 | 0 of 6 | - | 12 | 0 | 0 |
| theme-twice | 900 | 7-12 | no race | 6 of 6 | 4 | 0 of 6 | - | 16 | 0 | 0 |
| font-size | 300 | 1-6 | no race | 6 of 6 | 3 | 0 of 6 | - | 12 | 0 | 0 |
| font-size | 300 | 7-12 | no race | 6 of 6 | 2 | 0 of 6 | - | 14 | 0 | 0 |
| font-size | 600 | 1-6 | no race | 6 of 6 | 3 | 0 of 6 | - | 12 | 0 | 0 |
| font-size | 600 | 7-12 | no race | 6 of 6 | 2 | 0 of 6 | - | 12 | 0 | 0 |
| font-size | 900 | 1-6 | no race | 6 of 6 | 3 | 0 of 6 | - | 12 | 0 | 0 |
| font-size | 900 | 7-12 | no race | 6 of 6 | 2 | 0 of 6 | - | 14 | 0 | 0 |

So: no reordered load of the fixed variant ended differently, 0 of 72, against 32 of 72 in the same 12 sessions
before the fix (theme 10 of 36, all from seeds 7 to 12; font size 22 of 36). The DOM+server oracle agrees on every
load, and the stale-write findings that remain (12 to 19 per session) are the false witnesses of section 6, item 2.

## 5. The brief's other surfaces

- **A link renamed while the preservation poll is in flight** (edit-name). The brief's first candidate: `useGetLink`
  polls `["link", id]` and writes the polled row into every list cache from inside its `queryFn`, which no cancel can
  stop. On the web app that hook runs only on `/links/[id]` and the preservation page (`pages/links/[id].tsx`,
  `components/Preservation/PreservationPageContent.tsx`), where nothing edits the name; the list's modal edits through
  `useUpdateLink`, whose `onMutate` cancels `["links"]`, `["publicLinks"]` and `["dashboardData"]` (`links.tsx` lines
  659 to 661). A cancelled `useFetchLinks` poll's late response is discarded (its `queryFn` has no side effect), and
  the `onSuccess` invalidations refetch after the `PUT`. The harness made the overlap certain (it waited for the poll
  request, then saved), and every load ended with the new name on the card and the server: 8 of 8 loads in each of
  the three sessions (300, 600, 900 ms), "No race found" over 6 of 6 compared, 0 of 6 seeded loads differing by the
  DOM+server oracle in each (1 forced delivery at 600 ms and 1 at 900 ms). Not checked: a change made on
  `/links/[id]` itself while its `useGetLink` poll runs (`LinkDetails`' icon popover calls `submit()`, which sends
  `useUpdateLink`, on that page too; a late poll's side-effect writes would land in list caches that page does not
  show).
- **Pin then unpin** (pin-unpin): `usePinLink` → `useUpdateLink`, two `PUT /api/v1/links/:id` in flight. By the
  source, the final state comes from the `["links"]` refetch the later `onSuccess` starts, a request sent after both
  writes reached the server, so the delivery order of the two `PUT` responses does not decide it. Measured: "No race
  found" in the three sessions (6 of 6 compared each); the two `PUT`s' responses were delivered in reverse in 3 of
  the 18 seeded loads (600 ms seed 5, 900 ms seeds 1 and 5), and every load ended with the card's menu offering "Pin
  to Dashboard" and nothing pinned on the server.
- **Not run** (time): bulk edit or delete followed by a sort change, collection create/edit/move, the dashboard's
  pinned list. Their hooks are invalidate-only or write the response on success for one collection at a time (`EditCollectionModal`
  guards with `submitLoader`); the sidebar's collection drag and drop goes through `useUpdateUser`, the shape of
  section 4.3, and is the first thing to try next.

## 6. Problems with GenClass itself

Recorded as they were hit; none changed the finding.

1. **Six seeds that never swap a pair (a false negative worded as a negative).** Seeded priority is
   `hash32("<seed>|<key>")`. For the keys `PUT /api/v1/users/:id/preference#1` and `#2`, seeds 1 to 6 all give `#1`
   the higher priority (computed with a copy of `hash32` from `packages/runtime/src/agent/schedule.ts` lines 53 to 66: `#2` goes first only
   at seeds 7, 8, 11 and 12 of 1 to 12).
   With the default `seed: 1, runs: 6`, explore delivered the two `PUT`s in request order in all 18 seeded loads of the
   three theme sessions and said "No race found: none of the 6 compared reordered run(s) ended with a different page"
   on a page that races in 3 or 4 of 6 loads from seed 7. If each seed orders a pair either way with even odds, a session whose race needs one pair swapped misses it about 1
   time in 64
   of this. Suggestions: make each session's seeds cover both orders of every overlapping pair it sees (for example
   one run with the reverse of request order, or seed pairs whose priorities are complements), or say in the report
   when the reordered runs never changed the order of the unsafe requests ("the 2 PUTs were delivered in request
   order in all 6 runs").
2. **False `overwrote-newer` witnesses on every optimistic mutation (TanStack's notify batch read as a newer
   timer).** Every load of every theme session recorded 12 `overwrote-newer` witnesses of the form "the response to
   `PUT …/preference#2` overwrote `ToggleDarkMode.external0.data` after a newer 'timer 0ms' had already written it",
   in the baselines and on the fixed variant too. The "newer timer" is TanStack Query's `notifyManager` flushing the
   same change's own optimistic `setQueryData` to the hook results in a `setTimeout(0)` that fires just after the
   mutation's `fetch` started, so GenClass sees a write by a timer that began after the request and counts the
   response as overwriting newer data. On the unfixed app the baselines carried 24 such witnesses per load: these 12
   plus 12 true ones (`#1`'s response over `#2`'s optimistic value, the in-order flicker of section 4.1); on the fixed
   app 12 remain, all false. They become stale-write findings: 12 to 19 per fixed session in `genclass_findings`,
   while explore's verdict on the same sessions is "No race found" (the comparison is right; the findings list is not).
   Suggestion: carry the causal chain through a `setTimeout(0)` scheduled inside a write (a notify batch is part of
   the write that scheduled it, as a `queueMicrotask` would be), or do not count a response overwriting a value that
   its own request's initiating action wrote.
3. **One fact, many findings, and findings on bookkeeping.** Each overwrite is reported once per hook result that
   mirrors the `["user"]` query (`AuthRedirect.external0`, `.external3`,
   `LinkActions.external1`, `.external4`, `ToggleDarkMode.external0`, `TextStyleDropdown.external0`, each `.data` and
   `.dataUpdatedAt`): 12 to 16 stale-write findings for one cache write. Suggestion: group witnesses whose fields hold
   the same value written by the same response. On the two scenarios with no race (edit-name, pin-unpin) every
   session listed 20 stale-write findings (120 over the 6 sessions) with 0 of 6 loads differing: 87 on TanStack
   Query's fetch bookkeeping (`fetchStatus`, `isFetching`, `isRefetching`, `isStale`, `dataUpdatedAt` of hook
   results, e.g. "the response to GET /api/v1/tags overwrote Sidebar.external2.fetchStatus after a newer PUT
   /api/v1/links/:id"), 24 on `DndContext`'s `droppable.containers` and `draggable.nodes` (rebuilt from each list
   response), 9 on component counters (`CardView.state4`, the virtualised list's rendered count, and one `state3`).
   Explore's verdict was right ("No race found"); the findings list was 120 false reports.
4. **The checkbox's recorded value is the opposite of what it became.** The recording says `change checkbox =
   unchecked` after the click that turned the switch to dark (and `checked` after the one back to light): the input is
   controlled (`checked={data?.theme === "dark"}`), and the value seems to be read before React re-renders it from the
   optimistic cache. Harmless for the comparison (the end state is read at the quiet point), confusing in the explain
   trace.
5. **No console errors from the runtime** on any load. Linkwarden's own console carried, on every load alike, a React
   "`<button>` cannot be a descendant of `<button>`" hydration error (the reader view's text style trigger,
   `TextStyleDropdown`) and Radix "`DialogContent` requires a `DialogTitle`" errors (the edit modal).
6. **Harness, not GenClass.** (a) The Linkwarden dev server, started as a background job of the session, was stopped
   at that job's 30-minute limit in the middle of the sweep; the five sessions that ran against the stopped server
   (edit-name 600 and 900, the three pin-unpin sessions) wrote no result and were run again after a restart with a
   two-hour limit. (b) The first pin-unpin harness clicked the card's "More" button while Radix was still closing the
   menu just used, which opens nothing: 22 of 24 loads timed out at the second step. Explore still printed a verdict
   for those sessions ("No race found: none of the 4 compared", "none of the 6 compared"), comparing loads whose
   steps had failed the same way; the harness now waits for the closing menu and retries the click, and the three
   sessions were run again. Only complete sessions are in the tables.

## 7. Time spent

About 1 hour 15 minutes of session time to the last measurement (16:33 to 17:45 UTC), plus the writing. Roughly:
10 minutes to install Linkwarden (two blocked downloads worked around: corepack through the npm registry, the
Playwright browser skipped), migrate and seed; 15 minutes reading `packages/router` and the components and writing
the harness; 5 minutes from the first explore report with a race (theme, seed 7) to the root cause; 10 minutes for
the fix and the Vitest test, run both ways, in a separate worktree while the sweep ran; the explore sessions ran in
the background throughout (30 kept sessions of 8 loads, 240 loads, every one settled, 6 to 16 s a load; 8 more discarded: 5 that ran against the
stopped dev server and wrote no result, 3 pin-unpin sessions with the broken first harness; all re-run); the rest writing. The race was on a surface
outside the brief's list that reading the hooks pointed to; the brief's two list surfaces took two scenarios and six
sessions to rule out.

## 8. Reproducing

```bash
# setup: section 1; then, in this repository, with `yarn web:dev` running:
node docs/adoption/hunts/linkwarden/seed.mjs --links 120
psql postgresql://linkwarden:linkwarden@localhost:5432/linkwarden -c 'update "Link" set "lastPreserved"=null where id > 108;'
bash docs/adoption/hunts/linkwarden/sweep.sh                    # every session, unfixed (about 40 minutes)
node docs/adoption/hunts/linkwarden/summarise.mjs               # results.json and the table
node docs/adoption/hunts/linkwarden/repro.mjs --case theme --delay 1500 --trials 3   # without GenClass
node docs/adoption/hunts/linkwarden/repro.mjs --case font --delay 1500 --trials 3
# the fix: in ~/targets/linkwarden, `git apply <this repo>/docs/adoption/hunts/linkwarden.patch` (the dev server
# reloads), then HUNT_TAG=fixed bash docs/adoption/hunts/linkwarden/sweep.sh theme-twice font-size
yarn vitest run packages/router/user.test.ts                    # in ~/targets/linkwarden
```
