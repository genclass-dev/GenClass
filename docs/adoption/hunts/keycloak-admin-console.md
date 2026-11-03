# Race hunt: Keycloak admin console (nightly 999.0.0-SNAPSHOT)

A GenClass race hunt on Keycloak's admin console (`js/apps/admin-ui`, React 18, react-hook-form, PatternFly 5), run on
2026-11-03 in a cloud session against the nightly server on this machine, with the real `@genclass/runtime` injected by
Playwright and the real `@genclass/mcp` driven the way a coding agent drives it. Keycloak's source was not modified for
the hunt; the fix is a patch for its maintainers ([keycloak-admin-console.patch](keycloak-admin-console.patch); the
issue and pull request drafts, with the sender's checklist, are in
[keycloak-admin-console-issue.md](keycloak-admin-console-issue.md)). Nothing was sent to Keycloak's repository,
tracker, discussions or maintainers.

**Status: ready to send**, after the by-hand items in the drafts' "Before sending" list.

**Headline.** One real race, a lost update on Realm settings. After a save on the General tab the console reloads the
realm; until that reload has returned, a save on the Login tab (switching "User registration" on) sends the realm as
it was before the first save, and the server stores it: the new display name is reverted, and both saves showed a
success notification. `genclass_explore` reported it at 900 ms with a 400 ms pause between the two saves (1 of 6
reordered loads in one session, 2 of 6 in a second) and at 300, 600 and 900 ms with no pause; its
`genclass_explain` timeline shows the Login tab's `PUT` leaving while the reload is still held. Without GenClass, a
Playwright script that only slows that reload loses the display name in 6 of 6 trials (300 and 1,000 ms, 3 each) and
0 of 3 without the delay; with Chromium's own latency emulation at 2,000 ms and the Login tab clicked 0.8 s after the
notification, 3 of 3, and 0 of 3 with a 3 s pause or at 300 or 600 ms of latency. A small fix in the admin UI (18
added lines in two files: the saved representation goes into the realm context at once) makes the new Playwright test
pass (3 of 3; it fails 3 of 3 without the fix), the plain reproduction keep both saves in 12 of 12 trials, and the
related suites pass (15 of 15). Explore on the fixed console: no race in 4 of 4 sessions, and the display name kept in
32 of 32 loads (section 4.5). The other scenarios (two Login switches in a row, user search, a double click on Create
user, and the two-tab scenario with the user slower than the reload) showed no order-dependent result; the double
click shows a deterministic double submit (section 6.1).

Two things to know before reading the numbers. First, this race is between a response and the user's next action,
not between two responses, so whether a run loses the edit depends on the reload's latency against the harness's
pause, and explore's fifo baselines get latency too: at 600 ms with no pause both baselines lost the edit and explore
flagged the seeded loads that *kept* it (section 3). The verdict says "the page depends on the order"; the server-side
oracle says which side is wrong. Second, three of explore's own behaviours misled on this target (a replay that said
"the fix holds" on the unfixed console, a session where two disagreeing baselines hid the race, and the case above);
section 7 has them.

Sections: 1 setup, 2 how the console was driven, 3 scenarios and verdicts, 4 the finding, 5 reproducing, 6 other
observations, 7 problems with GenClass itself, 8 time spent.

## 1. Setup

| what | version |
|---|---|
| Keycloak source | `keycloak/keycloak` `main` at `15a9bbb8ae20c141f947ff656ef9d7b3b521471e` (2026-11-03T15:22:46Z), shallow clone in `~/targets/keycloak-admin-console`; the patch is against this commit |
| Keycloak server | nightly `keycloak-999.0.0-SNAPSHOT.tar.gz` from the `nightly` release, `Last-Modified: Tue, 03 Nov 2026 07:54:52 GMT`, 173,686,485 bytes, sha256 `3faea72ff57b3a453c0a8a4001f7c73da09ed18841f1d58d4c0ca9e6e69db938`; `kc.sh start-dev` with the features `scripts/start-server.js` passes, embedded dev-file database, Quarkus 3.40.1.1 |
| admin console under test | unfixed: the console bundled in the nightly (the three files the fix touches were last changed upstream in `fe6a063f`, 2026-10-28, before the nightly was built); fixed: Vite 5174 dev server (`pnpm dev`) on the patched checkout, server started with `pnpm start --admin-dev` |
| Node, pnpm, JDK | Node 24.9.0 (the version `js/pom.xml` pins; the machine has 22, so the official tarball was unpacked into `~/targets`), pnpm 11.1.1 through corepack, OpenJDK 21.0.12 (preinstalled) |
| browser | Chromium 1243 (the machine's preinstalled build). GenClass's harness uses this repository's Playwright 1.63.0; Keycloak's suite pins `@playwright/test` 1.64.1, which wants Chromium 1248, so its tests ran through a local config (not in the patch) that adds `launchOptions.executablePath: "/opt/pw-browsers/chromium"` and keeps only the `chromium` project |
| GenClass | `@genclass/runtime` and `@genclass/mcp` from this repository at `c1c9e14`, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |

Commands, in order (Keycloak's own docs: `js/apps/keycloak-server/README.md`, `js/apps/admin-ui/CONTRIBUTING.md`):

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# Keycloak, outside this checkout
git clone --depth 50 https://github.com/keycloak/keycloak.git ~/targets/keycloak-admin-console
curl -sS -o ~/targets/node24.tar.xz https://nodejs.org/dist/v24.9.0/node-v24.9.0-linux-x64.tar.xz && tar xf ~/targets/node24.tar.xz -C ~/targets
export PATH=~/targets/node-v24.9.0-linux-x64/bin:$PATH
cd ~/targets/keycloak-admin-console/js && corepack enable --install-directory ~/targets/node-v24.9.0-linux-x64/bin
HUSKY=0 pnpm install
# the start script downloads the nightly with Node's fetch, which does not go through this machine's proxy;
# the same asset was downloaded with curl and unpacked where the script looks for it
curl -sSL -o ~/targets/kc-nightly.tar.gz https://github.com/keycloak/keycloak/releases/download/nightly/keycloak-999.0.0-SNAPSHOT.tar.gz
mkdir -p apps/keycloak-server/server && tar xzf ~/targets/kc-nightly.tar.gz -C apps/keycloak-server/server --strip-components=1
cd apps/keycloak-server && pnpm start        # :8080, admin/admin; for the fixed variant: pnpm start --admin-dev
cd ../admin-ui && pnpm dev                   # fixed variant only: Vite on :5174
```

Setup took about 10 minutes: no failures beyond the two notes above (Node 24, the proxy).

## 2. How the console was driven

[keycloak-admin-console/hunt.mjs](keycloak-admin-console/hunt.mjs) is the whole loop, modelled on
[gitea-explore.mjs](gitea-explore.mjs) and [strapi/hunt.mjs](strapi/hunt.mjs):

- **MCP server in-process.** `serve()` from `packages/mcp/dist/index.js`, its bridge on a free port; the tools are
  called through JSON-RPC `tools/call`: `genclass_clear`, `genclass_explore` (`start`, `report`), `genclass_explain`,
  `genclass_replay` (`arm`, `result`), `genclass_findings`.
- **Injection without touching Keycloak, through `addInitScript`.** The console signs in through keycloak-js with
  `onLoad: "login-required"`: every page load is a console document, a redirect to the login endpoint (answered at
  once from the saved SSO cookie) and a second console document with the code in its URL. That second document is the
  end of a redirect chain, and Playwright does not route a document reached by a redirect (fulfilling the login
  endpoint's 302 from the route did not change that), so the Gitea and Strapi pattern of rewriting the HTML could not
  reach it. The harness therefore adds an init script, as the target brief suggested: the script-tag build's own source
  (`packages/runtime/dist/genclass.global.js`) with `window.GENCLASS_CONFIG = { telemetry: false, mode: "observe",
  model: false, visual: false, devtools: false }`, run only in a console document whose URL carries `code=` (the first
  document only redirects and would take an armed run), then a dynamic import of `/__genclass/agent.js` (served from
  `packages/runtime/dist` by a route) and `connectAgent(GenClass.runtime, { url: bridge })`. Requests to any host but
  localhost are aborted. Each load is a fresh browser context with the saved admin session and the
  `local-network-access` permission.
- **Same server state before every load.** One realm, `genclass-hunt`, with display name "Original display name" and
  30 users (`alpha1`..`alpha15`, `beta1`..`beta15`), set up once (`hunt.mjs setup`); before each load the scenario
  resets what it changes through the admin REST API (display name, the three Login switches, the double-click user).
- **The steps.** Each scenario waits for the agent link and GenClass's quiet point after the page is up, performs its
  steps, awaits `whenSettled()`, then reads its own **oracle**: the realm or users as the server stores them (admin
  REST API) and what the page shows. [keycloak-admin-console/summarise.mjs](keycloak-admin-console/summarise.mjs) puts
  that oracle next to explore's verdict ("wrong" per scenario: the display name not kept; a switch not on; rows that
  are not the `beta` users; more than one user or an error toast). It is this harness's own check, beside the explore
  verdict, never a replacement for it.
- **Explore.** `genclass_explore start` with `runs: 6` and `slow_ms` 300, 600 and 900 (8 loads per session: 2 fifo
  baselines, 6 seeded orders); then `report`; on a race, `genclass_explain` of the first finding, `genclass_replay arm`,
  one more load, `genclass_replay result`. `pause_ms` is a wait the harness adds between the two user steps of a
  scenario (the same in every load of a session).

What GenClass saw: the scenario was recorded as `type input "Display name" = ...`, `click button "Save"`,
`submit form`, `click tab "Login"`, `click label "OnOff"`, `click checkbox "User registration"`; state discovery found
the React component state (react-hook-form's form state, the alerts, the realm context as `loading_3.state2`) and
`localStorage` (`gB.state0`, the recent-realms list); no store library. Nothing was hand-mirrored with `rt.atom()`.

## 3. Scenarios and verdicts

Every verdict is the explore report's own line reduced to counts. *Oracle wrong* counts the loads whose server state
or page was wrong by this harness's check (section 2): first the two fifo baselines, then the six seeded loads. Every
load of every session reached a quiet point, with no harness error, unless the row says otherwise.

| scenario | pause_ms | slow_ms | console | explore verdict | oracle wrong: baselines | oracle wrong: seeded | replay of the first finding |
|---|---|---|---|---|---|---|---|
| realm-tabs | 400 | 300 | unfixed | no race | 0 of 2 | 0 of 6 | none |
| realm-tabs | 400 | 600 | unfixed | no race | 0 of 2 | 0 of 6 | none |
| realm-tabs | 400 | 900 | unfixed | race: 1 of 6 (seed 2) | 0 of 2 | 1 of 6 | not counted (harness bug: `result` without the finding id) |
| realm-tabs | 400 | 900 | unfixed (second session) | race: 2 of 6 (seeds 1, 2) | 0 of 2 | 2 of 6 | **not reproduced** (the replay load kept the display name) |
| realm-tabs | 0 | 300 | unfixed | race: 5 of 6 | 0 of 2 | 5 of 6 | not counted (harness bug) |
| realm-tabs | 0 | 300 | unfixed (second session) | **no race found** | 1 of 2 | 5 of 6 | none |
| realm-tabs | 0 | 600 | unfixed | race: 3 of 6 | **2 of 2** | 3 of 6 | not counted (harness bug) |
| realm-tabs | 0 | 900 | unfixed | race: 3 of 6 | 0 of 2 | 3 of 6 | not counted (harness bug) |
| login-switches | 0 | 300, 600, 900 | unfixed | no race (each) | 0 of 2 (each) | 0 of 6 (each) | none |
| user-search | 0 | 300, 600, 900 | unfixed (second sessions, oracle selector fixed) | no race (each; also in the first three) | 0 of 2 (each) | 0 of 6 (each) | none |
| user-create-double | 0 | 300, 600, 900 | unfixed | no race (each) | 2 of 2 (each) | 6 of 6 (each) | none |
| realm-tabs | 0 | 300 | fixed (Vite) | no race | 0 of 2 | 0 of 6 | none |
| realm-tabs | 0 | 600 | fixed (Vite) | no race | 0 of 2 | 0 of 6 | none |
| realm-tabs | 0 | 900 | fixed (Vite) | no race | 0 of 2 | 0 of 6 | none |
| realm-tabs | 400 | 900 | fixed (Vite) | no race | 0 of 2 | 0 of 6 | none |

Scenario by scenario:

- **realm-tabs** (General tab: new display name, Save, wait for "Realm successfully updated", wait `pause_ms`, Login
  tab, "User registration" on, wait for "changed successfully"): **the race of section 4**. With a 400 ms pause the
  reload (delayed 0 to `slow_ms` per response, hashed from the seed) only loses at 900 ms, in the seeded loads where
  the reload was held longer than the pause and the tab switch took (in run r22 the reload arrived 833 ms after it was
  sent, "held 816 ms", and the Login tab's `PUT` left at 592 ms). With no pause the harness clicks the Login tab 50 to
  150 ms after the save's response (52 and 142 ms in two explained runs), so whether a load loses depends on that
  load's delay for the reload; the baselines get delays too, which is how both baselines lost at 600 ms (the explore verdict then marked the three seeded loads
  that kept the name; the oracle shows the other three lost it as the baselines did). The second session at 300 ms had
  one baseline that lost and one that kept the name; explore treated the difference between the baselines as noise
  and reported no race while 5 of 6 seeded loads lost the edit (section 7, item 2). A replay of seed 1 from the
  second 900 ms session kept the name (section 7, item 1). Across the 64 unfixed realm-tabs loads of the 8 sessions
  (baselines included, replays not), the oracle counted 22 with the display name lost.
- **login-switches** (Login tab: "User registration" on, then "Forgot password" on at once, two `PUT`s in flight):
  both switches on in all 24 loads. `LoginTab.tsx` mutates the context's realm object in place
  (`Object.assign(realm, switches)`, line 44), so the second `PUT` already carries the first switch: an accident that
  protects this case.
- **user-search** (Users: search "alpha" + Enter, then "beta" + Enter at once): the list showed the `beta` users in
  all 24 loads (the oracle's selector read nothing in the first three sessions; they were rerun with the fixed
  selector, and those are the counts given; explore's own verdict was "no race" in both sets). The table's fetch is
  aborted when its key changes (`useFetch` in `js/libs/ui-shared/src/utils/useFetch.ts`), as the brief expected.
- **user-create-double** (Add user: username, then a double click on Create): two `POST /admin/realms/{realm}/users`
  in every load, one user created, and both "The user has been created" and "Could not create user: User exists with
  same username ..." shown, in every order: not order-dependent, so not a race (section 6.1).

## 4. The finding

### 4.1 What explore saw

Session realm-tabs, 400 ms pause, 900 ms (the first one). Baselines: both kept the new display name. Seed 2 ended with
the page header showing "Original display name". The report, reduced:

```
Compared: 6 of 6 reordered run(s) against two baselines.
RACE: 1 of 6 reordered run(s) ended in a different state than the baseline (responses in request order): what the page
shows, its form values, the writes it sent or its errors differ.
- run r22 (seed 2):
    page text only in the baseline: "Display name from the General tab", "Display name from the General tab"
    page text only in this run: "Original display name", "Original display name"
```

`genclass_explain` of the finding, the evidence in causal order (times from `connectAgent`, holds in brackets; the
store writes are React component state as GenClass named it, `loading_3.state2` being the realm in `RealmContext`):

```
+4.087s action 1: click button "Save"
+4.111s send      PUT /admin/realms/genclass-hunt/ui-ext#1 "{id: \"genclass-hunt\", realm: \"genclass-hunt\", +105}"
+4.860s delivered PUT /admin/realms/genclass-hunt/ui-ext#1 (held 713 ms)
+4.882s write globalAlerts.state1 by PUT .../ui-ext#1: 0 items → 1 item          (the success notification)
+4.890s send      GET /admin/realms/genclass-hunt#2                               (the reload: refresh())
+5.416s action 3: click tab "Login"
+5.479s action 5: click checkbox "User registration"
+5.482s send      PUT /admin/realms/genclass-hunt#1 "{id: \"96a8f586-2fd3-497d-bb58…\", +105}"   (the whole realm)
+5.723s delivered GET /admin/realms/genclass-hunt#2 (held 816 ms)
+5.738s write loading_3.state2 by GET .../genclass-hunt#2: changed displayName: "Original display name" → "Display name f…"
+6.626s delivered PUT /admin/realms/genclass-hunt#1 (held 1.1 s)
+6.653s send      GET /admin/realms/genclass-hunt#3
+7.362s delivered GET /admin/realms/genclass-hunt#3 (held 678 ms)
+7.375s write loading_3.state2 by GET .../genclass-hunt#3: changed displayName: "Display name from the General tab" → "Or…"
```

So: the Login tab's `PUT` (the whole representation: GenClass's summary shows 106 fields) left at +5.482 s, while the reload that carries the
new display name was still held (delivered at +5.723 s); the server stored the `PUT`, and the next reload brought the
old name back into the page. In the second 900 ms session (run r129, seed 1) the reload was delivered at +5.878 s and
the `PUT` left at +5.880 s, 2 ms later, still with the old name: the click handler ran before React re-rendered with
the reloaded realm.

### 4.2 Reproduction without GenClass

[keycloak-admin-console/repro-lost-update.mjs](keycloak-admin-console/repro-lost-update.mjs): a throwaway realm per
trial with display name "Original display name", the console's login form, General tab: new display name, Save,
wait for the notification, Login tab, "User registration" on, wait for its notification; then the realm as the
server stores it. Two ways of making the reload slow, nothing reordered:

```
# route mode: only GET /admin/realms/{realm} waits `delay` ms (every other request untouched), unfixed nightly
refetch delayed    0 ms, trials 1-3: both saved
refetch delayed  300 ms, trials 1-3: display name LOST  {"displayName":"Original display name","registrationAllowed":true}
refetch delayed 1000 ms, trials 1-3: display name LOST  {"displayName":"Original display name","registrationAllowed":true}

# THROTTLE_MS: Chromium's latency emulation on every request (CDP Network.emulateNetworkConditions, what DevTools'
# throttling uses); PAUSE_MS: the wait after the save notification before clicking the Login tab
latency 2000 ms, pause  800 ms, trials 1-3: display name LOST
latency 2000 ms, pause 3000 ms, trials 1-3: both saved
latency  300 ms, pause  800 ms, trials 1-3: both saved
latency  600 ms, pause  400 ms, trials 1-3: both saved
```

So a person hits it on a link with round trips around two seconds (or a server slow to answer the realm GET), not on
a normal one; the page gives no sign of it until the next reload, and both saves report success.

### 4.3 Root cause (paths under `js/apps/admin-ui/src/`, lines at `15a9bbb8`)

1. `context/realm-context/RealmContext.tsx`: the realm representation every realm page uses is React state, set only
   by `useFetch(... adminClient.realms.findOne ..., setRealmRepresentation, [realm, key])` (lines 45 to 50);
   `refresh()` (line 30) bumps `key` to refetch it.
2. `realm-settings/RealmSettingsTabs.tsx`, `save` (lines 232 to 299): builds `{ ...realm, ...r, id: r.realm }` from
   that context realm and the tab's form values (line 268), `PUT`s it to `admin/realms/{realm}/ui-ext` (line 278), and
   only then calls `refresh()` (line 298). Until the refetch lands, the context still holds the realm from before the
   save.
3. `realm-settings/LoginTab.tsx`, `updateSwitchValue` (lines 32 to 50): `adminClient.realms.update(...,
   Object.assign(realm, switches))` (line 44) with `realm` the same context object: a full `PUT
   /admin/realms/{realm}` of every field as the context last saw it. Keycloak's realm update applies every non-null
   field, so the old display name is written back (a realm created without a display name does not show the loss: an
   absent field is left alone, which is why the reproduction gives the realm one).
4. The same window exists for the tabs that save through `save` from the shared form (`SessionsTab.tsx`,
   `TokensTab.tsx`: `useFormContext`, `handleSubmit(save)`), whose values are reseeded from the context realm by the
   effect on `[setValue, realm]` (`RealmSettingsTabs.tsx` lines 204 to 230); only the General-then-Login pair was
   measured here.

The same three files have the same code in release 26.8.1 (read from `raw.githubusercontent.com` at tag `26.8.1`:
`RealmSettingsTabs.tsx` lines 257, 267 and 287, `LoginTab.tsx` lines 43 to 47, `RealmContext.tsx` lines 30 and 49);
26.8.1 was not run.

### 4.4 The fix

[keycloak-admin-console.patch](keycloak-admin-console.patch), against `15a9bbb8`: after a successful save,
`RealmSettingsTabs` puts what it saved into the realm context at once, so every tab builds on it until the refetch
lands (the refetch still runs and replaces it with the server's copy). Two fields differ from what was sent: `upConfig`
is left out (it is the user profile configuration the `ui-ext` endpoint saves alongside the realm, not a realm field;
keeping it would make a later save from another tab send this save's user profile configuration again), and `id` stays
the realm's id (the save sends the realm *name* as `id`; the server ignores it, checked by a `PUT` with `id` set to
the name, but `clients/registration/DetailProvider.tsx` and the Kerberos and LDAP forms read
`realmRepresentation.id` as a component's `parentId`).

```diff
+  /** Replaces the realm representation, e.g. with the one just saved, until the next refresh lands. */
+  setRealmRepresentation: (realm: RealmRepresentation) => void;
 ...
       if (!response.ok) throw new Error(response.statusText);
+      // The other tabs build their saves on the realm in the context, so use what was just saved
+      // until the refetch lands; otherwise a save from another tab in the meantime reverts this one.
+      setRealmRepresentation({ ...omit(savedRealm, "upConfig"), id: realm.id });
       addAlert(t("realmSaveSuccess"), AlertVariant.success);
```

Choices and limits, for the sender to be able to defend:

- It adds a member to `RealmContextType`, and `RealmContext` is exported from the package's `index.ts` (the admin UI
  is also published as a library). A custom provider would need the new member. An optional member would avoid that
  at the cost of a `?.` at the call.
- It does not close the window between clicking Save and that save's own response: a second save sent before the
  first one's response still carries the older values. Closing that would need the other tabs' saves to wait or be
  disabled while one is in flight, a larger change.
- One more effect: setting the context realm reruns the effect on `[setValue, realm]` in `RealmSettingsTabs`, so the
  localization texts are fetched once more per save (`GET /admin/realms/{realm}/localization/{locale}`).
- Smaller alternatives considered: making `LoginTab` send only the switches (the server leaves absent fields alone)
  fixes this pair, but leaves the tabs that save through `save` building on the old realm, and it would end
  `LoginTab`'s in-place mutation of the context realm, which a save made right after a switch may rely on today (not
  measured); refetching before each save adds a request to every save and still races the user.
- Not changed: the authentication policy pages already call `realmUpdated(updatedRealm)` with the realm they saved
  (`authentication/policies/Policies.tsx` passes `refresh`, which ignores the argument). That suggests the same intent
  there, and the same window probably exists between the policy tabs; not measured, so not touched.

### 4.5 Test and fixed-variant check

The regression test is in Keycloak's own suite and style: `test/realm-settings/general.spec.ts`, a new
`test.describe("Realm settings saves on two tabs")` beside the existing "Realm settings delete" block, using
`login`, `goToRealm`, `goToRealmSettings`, `fillDisplayName`, `clickSaveRealm`, `assertNotificationMessage`,
`goToLoginTab`, `toggleLoginSettingAndExpectSuccess` and `adminClient`. It holds `GET /admin/realms/{realm}` with
`page.route` until the Login tab's `PUT` has been sent (deterministic, no timing), then reads the realm through the
admin client and expects both the display name and `registrationAllowed: true`.

```bash
cd ~/targets/keycloak-admin-console/js/apps/admin-ui
pnpm exec playwright test --config playwright.local.config.ts test/realm-settings/general.spec.ts -g "two tabs" --repeat-each 3
```

| run | result |
|---|---|
| unfixed nightly console | 3 of 3 failed: `Expected: "Display name saved on the General tab"`, `Received: "Display name before the save"` |
| fixed (Vite, patched checkout) | 3 of 3 passed |
| the fix stashed, test kept (same Vite build) | 3 of 3 failed, same message |
| `general.spec.ts`, `login.spec.ts`, `session.spec.ts`, `tokens.spec.ts` on the fixed console | 15 passed, 0 failed (10, 2, 2, 1) |
| `pnpm lint` (ESLint, typescript-eslint strict-type-checked) on the three files | 0 errors, 6 warnings, all on lines the patch does not touch |
| `tsc --noEmit -p tsconfig.json` in `js/apps/admin-ui` | clean |
| `repro-lost-update.mjs` on the fixed console | both saved in 12 of 12: route delay 0, 300 and 1,000 ms (3 each), and 2,000 ms latency with a 0.8 s pause (3) |
| explore, realm-tabs on the fixed console (no pause at 300, 600, 900 ms; 400 ms pause at 900 ms) | "No race found" in 4 of 4 sessions; the oracle: display name kept in 32 of 32 loads (the unfixed nightly lost it in 22 of 64); 0 RACE lines over 24 reordered loads, so no false report on the fixed variant; "Internal state only" on 9 of 24 (8 of them the number of `GET .../localization/en` requests, one a `PartialImportDialog` state) |

The unfixed explore sessions ran on the nightly's production build and the fixed ones on the Vite dev server (React's
development build): the comparison between them is the oracle's count, not a like-for-like timing. On the Vite build
with the fix stashed, the regression test fails 3 of 3, so the dev build alone does not make the bug go away.

The Login switch helper (`test/utils/form.ts`, `setSwitchState`) prints "check failed ... state reached via check on
attempt 1" for every switch in `login.spec.ts` too: the switch only follows the server after the refetch, and the
helper's retry handles it. Not related to this change.

`pnpm lint` over the whole package also reported an error in the local Playwright config used to point Keycloak's
suite at this machine's Chromium (formatting); that file is not in the patch and was deleted afterwards.

## 5. Reproducing

```bash
# Keycloak running as in section 1 (nightly, :8080); GenClass built; from this repository's root
node docs/adoption/hunts/keycloak-admin-console/repro-lost-update.mjs 0,300,1000 3
THROTTLE_MS=2000 PAUSE_MS=800 node docs/adoption/hunts/keycloak-admin-console/repro-lost-update.mjs x 3
node docs/adoption/hunts/keycloak-admin-console/hunt.mjs setup
node docs/adoption/hunts/keycloak-admin-console/hunt.mjs explore realm-tabs 300,600,900 6 400
node docs/adoption/hunts/keycloak-admin-console/hunt.mjs explore realm-tabs 300,600,900 6 0
node docs/adoption/hunts/keycloak-admin-console/hunt.mjs explore login-switches 300,600,900 6 0     # also user-search, user-create-double
node docs/adoption/hunts/keycloak-admin-console/summarise.mjs > docs/adoption/hunts/keycloak-admin-console/results.json
# fixed variant: git apply the patch in the Keycloak checkout, `pnpm start --admin-dev` + `pnpm dev`, then the same with HUNT_VARIANT=fixed
```

Outputs go to `HUNT_OUT` (default `/root/targets/kc-hunt-out`): per session a `.txt` with the plan, every load's
oracle and delivery order, the report, the findings, the explanation and the replay; per scenario a summary JSON.
[keycloak-admin-console/results.json](keycloak-admin-console/results.json) is `summarise.mjs`'s output for this hunt.
The session files of three sessions (realm-tabs 400 ms pause at 900 ms and no pause at 300 ms, second sessions; the
user-search rerun) were deleted by mistake with a cleanup glob before the summary was written; their summaries were
rebuilt from the run logs, which hold every load's oracle and the explore report (marked with `"source"` in
`results.json`), and the replay result of f14 quoted in section 7 is from this session's console output.

## 6. Other observations

### 6.1 A double click on Create user sends two requests (deterministic, not drafted)

`user/CreateUser.tsx` `save` and `components/form/FixedButtonGroup.tsx`: the Create button is not disabled while the
request is in flight. A double click sent two `POST /admin/realms/{realm}/users` in 24 of 24 loads; the server created
one user and refused the second, so the page showed "The user has been created" and "Could not create user:
User exists with same username" (or "... username or email") together, then moved to the new user. Nothing is lost,
the result is the same in every order (explore: no race, correctly), and it is a separate change from the realm fix
(Keycloak wants one change per pull request), so no draft was written; a sender may file it on its own.

### 6.2 Negative and unexplored

- A General save made long after a Login switch (3 s apart) kept both (checked once with a throwaway script, not
  kept). The General tab's form is seeded once on mount (`GeneralTab.tsx`, `useEffect(setupForm, [])`) with every
  realm field, so a stale switch value in that save was plausible; it did not happen, and why was not pursued.
- Not exercised: the authentication flow editor (`authentication/FlowDetails.tsx` `executeChange`, which the brief
  names: child moves fired without `await`, each ending in `refresh()`), driven by drag and drop; the user details and
  attributes tabs (`user/EditUser.tsx`, one shared form, so the stale-form window the brief names would need a
  different oracle); client and role mapping dialogs. Time went to the realm finding's fix and its checks.
- `RealmContext`'s `refresh` is `() => setKey(key + 1)`, a closure over `key`: two saves whose `refresh()` calls come
  from the same render bump it to the same value and refetch once. Not observed to matter here; noted for the
  reviewer.

## 7. Problems with GenClass itself

1. **A replay said "the fix holds" on unfixed code.** `genclass_replay` of f14 (seed 1, 900 ms, second session) armed
   the seeded schedule, the harness ran the same steps, and the result was "r135: not reproduced · the page shows the
   baseline's text ... The recorded order no longer produces it: the fix holds for this schedule". Nothing had been
   fixed. The race depends on the reload's delay against the user's next click, and the replay reproduces the delivery
   order, not the time between a delivery and an action, so a race of this kind can replay clean by chance. The
   wording should not assume a fix; "not reproduced" alone, or with "the run's timing differed", would be accurate.
2. **Two disagreeing baselines hid the race.** In the second 300 ms session with no pause, one fifo baseline lost the
   display name and the other kept it. Explore reported "No race found" over 6 compared runs while 5 of 6 seeded loads
   lost it (and listed only two as "Internal state only", for the `localStorage` copy of the realm list). The page
   lines that differ between the baselines were treated as noise, and they are not listed in "Ignored as noise",
   which names store fields only: a reader cannot see that the page itself was set aside. Two baselines that disagree
   on what the page shows are a finding in themselves (the outcome depends on timing even in request order); the
   report should say so rather than "No race found".
3. **The baseline is not the correct run when the race is with the user.** At 600 ms with no pause both baselines lost
   the edit; the RACE lines named the three seeded loads that kept it ("page text only in the baseline: Original
   display name"). The verdict was right that the page depends on timing, and the explanation of those runs shows the
   correct sequence. A reader who assumes "baseline = expected" fixes the wrong thing. The race finding's text could
   say "differs from the baseline" without implying which is wrong, or note when the baselines' own timing put a user
   action before a pending response.
4. **`genclass_replay result` without `id` answers "No finding ."** The harness first called `result` without the
   finding id (the arm message does say `{action:"result", id:"f1"}`); the answer was the bare "No finding ." Since
   exactly one replay was armed, the tool could use it, or say "pass the id of the armed replay (f1)".
5. **No hook for apps that sign in by redirect.** The documented injection (rewrite the HTML in a route) cannot reach a
   document reached through a redirect (keycloak-js, any OIDC `login-required` app), and fulfilling the 302 from the
   route did not help. `addInitScript` with the IIFE source inlined works, but `findScript()` then finds no tag, so
   `base` falls back to the jsDelivr URL (harmless here with the model off, and blocked by the harness anyway). A
   documented `GENCLASS_CONFIG.base`, or an injection recipe for redirect sign-ins in AGENT.md, would have saved
   this detour (about 10 minutes here).
6. **One causality label looks wrong.** In run r129 the Login tab's `PUT` is recorded as `send PUT
   /admin/realms/genclass-hunt#1 ... via GET /admin/realms/genclass-hunt`: it was caused by the click on the switch
   (`action 5`, 12 ms earlier), and the GET had been delivered 2 ms before it. Attribution by "last delivery before
   the send" would explain it.
7. **Scenario recording of a switch.** The "User registration" switch was recorded as `change checkbox "User
   registration" = unchecked` although it was being turned on: the input's `checked` only follows the server after the
   refetch (the app re-renders from the context), so the recorded value is the pre-click state, and the scenario's
   last step names the wrong end state. Minor.

## 8. Time spent

About 1 h 20 min of wall time by the container's clock (first command 16:30 UTC, pull request about 17:50): setup
10 min (Node 24, the nightly, `pnpm install`, the server up at 16:35); reading the code and the plain reproduction
20 min; the harness and the redirect-injection problem 10 min; the unfixed explore sessions about 25 min, unattended,
while the fix, the test, the lint and the drafts were written; the fixed variant (restart with `--admin-dev`, tests,
suites, reproduction, explore) 20 min, during which the report was written. Setup was not a blocker.
