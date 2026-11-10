# @genclass/playwright

### Explain your flaky e2e test: which response landed over newer data, which click submitted twice.

`@genclass/playwright` is GenClass for Playwright: it puts
[`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) ([genclass.dev](https://genclass.dev)), the
open-source (Apache-2.0) browser library that reports race conditions in web apps while they happen, on every page
your tests open, and turns what it flagged into one pull-request report. This page covers `@genclass/playwright`
0.1.0 and the `genclass-races/1` file format. Two parts that share that file format:

- **The fixture** (`@genclass/playwright/fixture`) puts [`@genclass/runtime`](../runtime) on every page your tests
  open, before the app's first script, in observe mode with telemetry off. With `chaos` it holds the app's API
  requests for a seeded time before they leave, so the response orders a slow network produces happen in your test,
  the same way every run. At the end of each test it writes one JSON file (format `genclass-races/1`) with what the runtime saw, the
  seed and the chaos that produced it.
- **The reporter** (`@genclass/playwright/reporter`) reads those files when the suite ends, marks what reproduced
  across seeds, writes one markdown file, `genclass-report.md`, and prints it. A short GitHub Actions step posts that
  file as one pull-request comment that updates in place.

For a suite you would rather not edit, one command does what the fixture does, with no change to a spec or to
`playwright.config`: [Without changing your tests](#without-changing-your-tests).

What the fixture records without a model download: two happens-before facts the runtime computes on its own
(`overwrote-newer`, a response that wrote a field over what a newer request or the user had written;
`identical-in-flight`, two identical requests in flight together from separate user actions). With the model loaded
(`model: "load"`, a 13 MB download), the file also carries the model's diagnoses with their confidence. Both are
things to look at, not verdicts: the report says what happened and leaves the call to you.

The runtime only observes: it never holds, delays or changes anything the app does. Chaos, when you turn it on, holds
matched requests before they leave (that is its job) and never changes what they say. No finding changes a test's
outcome, and the fixture logs nothing to the page's console. No runtime dependencies: `@playwright/test` and
`@genclass/runtime` are peer dependencies (the reporter alone needs neither).

## Install

```bash
npm install -D @genclass/playwright @genclass/runtime@beta
```

Playwright 1.40 or later; `@genclass/runtime` 0.3.0-beta.1 or later, which is on the `beta` dist-tag (`latest` is
0.2.x, which has no agent entry, so the fixture stops with an error naming it). The package is ESM only. A test
project that is CommonJS (no `"type": "module"`) needs Node 20.19+ or 22.12+, where `require` loads ES modules, and,
to type-check its specs, `module` and `moduleResolution` set to `nodenext` (or `bundler`).

## Use

Two lines in the config, one import in a spec:

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";
import type { GenClassFixtures } from "@genclass/playwright/fixture";

export default defineConfig<GenClassFixtures>({
  use: { genclass: { chaos: { seed: 1, delayMs: [0, 600] } } },
  reporter: [["list"], ["@genclass/playwright/reporter"]],
});
```

The type argument tells TypeScript about the `genclass` option (without it, `defineConfig` rejects `use.genclass`).

```ts
// tests/search.spec.ts
import { test, expect } from "@genclass/playwright/fixture";

test("shows the results of the last query", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search").pressSequentially("react", { delay: 80 });
  await expect(page.locator("#results li").first()).toContainText("react");
});
```

`test` is Playwright's `test.extend` with GenClass on its `page`; `expect` is Playwright's. Everything else in the
spec stays as it was. The run ends with `test-results/genclass/<test>-<id>-s<seed>.json` per test (a retry adds
`-r<n>`, so a failing first attempt is kept) and `genclass-report.md` next to the config.

Two seeds, so the report can mark what reproduced: `repeatEach: 2` in the config (or `npx playwright test
--repeat-each 2`). The fixture adds the repeat index to the seed, so the repeats run under seeds 1 and 2, and a
signature flagged in both is **Reproducible** in the report.

### The `genclass` option

Set in `use` in the config, or `test.use({ genclass: {...} })` in a spec or a `describe` block.

| key | default | what |
|---|---|---|
| `enabled` | `true` | `false`: the fixture does nothing (the page is Playwright's own, no file is written). |
| `mode` | `"observe"` | The only value. The runtime reports and never holds, delays or changes anything; guard and heal are not for tests. |
| `model` | `"skip"` | `"skip"`: no model download; the file carries the runtime's witnesses, facts computed without the model, and no model confidences. `"load"`: the runtime loads its model (from `modelUrl`, else the package default on jsDelivr: 13 MB, cached by the browser) and the file also carries its detections with their confidence. |
| `modelUrl` | package default | With `model: "load"`: a model directory URL (the runtime's `model.baseUrl`). |
| `chaos` | off | Seeded network chaos (below): an object, or `true` for the defaults. Off unless given. |
| `outDir` | `genclass` in the project's `outputDir` | Where the files go, relative to the config's directory. The default (test-results/genclass) is emptied by Playwright at the start of each run, so files of an earlier run are never read as more seeds. The reporter reads it by default. |
| `runtimeDir` | the installed package's `dist/` | `@genclass/runtime`'s `dist/` directory, when it is not resolvable from your project. |

### Chaos

```ts
use: { genclass: { chaos: { seed: 1, delayMs: [0, 600], reorder: true, match: ["/api", /\/graphql$/] } } }
```

| key | default | what |
|---|---|---|
| `seed` | `1` | Every delay is derived from it. With `repeatEach`, the fixture adds the repeat index. |
| `delayMs` | `[0, 600]` | Extra latency per matched response, uniform in `[min, max]` ms, at most 10000. |
| `reorder` | `true` | `false`: matched requests leave in the order the page sent them, at least 30 ms apart (latency only: with a server that answers in order, nothing overtakes). |
| `match` | same-origin `/api*` or `Accept: json` | Which requests: a path prefix (`"/api"`), a URL prefix (`"https://api.example.com/"`), a RegExp tested against the full URL, a function of `{ url, method, resourceType, sameOrigin, accept }`, or a list of those. Without it: same-origin requests whose path starts with `/api` or whose Accept header asks for JSON. |

How it works: with `page.route`, the fixture holds each matched request for its planned time and then passes it on
(`route.fallback()`), the way a slow uplink would. The request then takes its normal path: your own routes
(`page.route`, `context.route`, `routeFromHAR`) and the browser's network stack, with its cookies, redirects, CORS and
streaming as they are. Each matched request is keyed when the page sends it, by its method, path and occurrence in
the test (`GET /api/search#3`; a cross-origin one by host name without the port); its delay comes from a small PRNG
seeded by `seed` and that key, so the same test under the same seed gets the same delays whatever the wall clock or
the server does, and a finding comes with the seed that produced it. Nothing is dropped, changed, buffered or
invented. Only fetch and XHR requests are ever held, never documents, scripts, styles, images, WebSockets or the
runtime's own files; a request outside `match` is passed on at once.

Two things to know. A route of yours registered after the fixture's (Playwright tries the last one first) that
fulfils a request answers before chaos sees it, so that request gets no delay; call `route.fallback()` in it to let
chaos run. And `page.route` does not see requests a service worker handles; with a service worker controlling the
page, set `serviceWorkers: "block"` in `use`. The race file records how many requests chaos held and whether a
service worker was in control, and the report notes a test where chaos held nothing.

### The model trade-off

By default (`model: "skip"`) nothing is downloaded and the file carries the runtime's **witnesses**: facts the
runtime computes from what it already traces (the causal chain of every request, the version history of every
store field), with no model involved:

- `overwrote-newer`: a request's response chain wrote a field that, since the request started, a newer operation
  (one that started after it, outside its causal chain) or the user had written. Older data over newer data.
- `identical-in-flight`: two identical requests (same method, URL and body) in flight together, from two separate
  user actions.

A witness is a fact, not a diagnosis: some overwrites are intended, and many are repaired a moment later. The report
keeps them in their own group, shows no confidence for them and says so in its footer. They need state the runtime
can see: stores registered with the runtime, or found by automatic state discovery (React component state, Redux,
and Zustand stores whose devtools middleware is enabled, `devtools(..., { enabled: true })`; at its default the
middleware is off outside development builds and the store is not found), which the fixture turns on.

With `model: "load"` the runtime downloads its model (about 13 MB with onnxruntime-web's wasm). Each Playwright test
gets a fresh browser context, so in practice every test downloads it again. The model comes from jsDelivr unless
`modelUrl` names your own copy; onnxruntime-web's wasm comes from jsDelivr either way. The file then also carries the
model's **detections** (`delivery:stale`,
`request:duplicate`, `failure:failing`, ...) with the model's confidence and the evidence line it printed, grouped
by diagnosis in the report. What the model flags, and how often it is wrong on correct apps, was measured on the
framework compatibility matrix (the "What to expect" section below).

### What the fixture puts on the page

For the runtime to see the app's first requests and state, it has to be there before the app's first script, so
the fixture adds one init script per page: the runtime's script-tag build (`dist/genclass.global.js`) with the
page configuration `mode: "observe"`, `telemetry: false`, no visual checks, no devtools overlay and the model as
chosen. If a URL or localStorage switch (`?genclass=heal`, `localStorage.genclass`, say from a saved storage state)
raised the mode, the fixture sets it back to observe and the race file says so. Likely detections reach the test
runner from the runtime's `decide` event. The runtime's files are served from disk on the page's own origin at
`/__genclass__/` with `page.route`, never from a CDN. The page then loads the runtime's agent entry
(`dist/agent.js`) and connects it with every hold off (`hold: false`), so the witnesses are computed. The agent link
is given a stand-in `fetch` for its own address when it connects, so it sends nothing at all: no request, no console
line, no failed request, nothing to a Content-Security-Policy report. Like the runtime's own observers, the agent
entry wraps the page's `setTimeout` and `clearTimeout` (to see pending debounces; it calls the originals).

What the page gets: the globals `GenClass` (the runtime), `GENCLASS_CONFIG` (its configuration),
`__GENCLASS_AGENT__` (the agent entry) and `__GENCLASS_PLAYWRIGHT__` (the fixture's collector); one function exposed
by Playwright (`__genclassPlaywright`); and, from automatic state discovery, stand-ins for the React and Redux
DevTools hooks (`__REACT_DEVTOOLS_GLOBAL_HOOK__`, `__REDUX_DEVTOOLS_EXTENSION__`,
`__REDUX_DEVTOOLS_EXTENSION_COMPOSE__`) when the page has none. A page route, any route, also turns off the browser's
HTTP cache for that page in Playwright, so cached responses are fetched again.

Limits, as they are today:

- Only the `page` fixture is instrumented. Pages from `context.newPage()` or popups are not (the register entry of
  [Without changing your tests](#without-changing-your-tests) works on the whole browser context instead).
- Top frame only, on http(s) pages. `page.setContent` (about:blank) and iframes get nothing.
- An app that already starts GenClass itself (`GenClass.init()` from the ESM entry) runs a second runtime next to
  the fixture's; stores it registered with `rt.atom` or `rt.guard` on its own runtime are not visible to the
  fixture's, which sees network, user actions and what automatic discovery finds. An app integrated through the
  script tag (`window.GenClass`) shares the fixture's runtime.
- The witnesses need writes the runtime can attribute to a response (registered or discovered state). Apps whose
  state the runtime cannot see produce no witnesses; the model's detections about requests (duplicates, failures)
  do not depend on state.
- The fixture's runtime does not know your app's own `redact` function (it is set where your app calls
  `GenClass.init`). Values in the witness lines are summarised and redacted by the runtime's default rules (field names
  that say they hold a secret), not by yours.
- With a service worker controlling the page, `/__genclass__/` and chaos go past `page.route`: set
  `serviceWorkers: "block"`. The report notes a test where the witnesses could not be recorded (the agent entry did
  not load) or a service worker was in control, instead of calling it clean.

## Without changing your tests

For a suite that already exists: no import changes in a spec, nothing is added to `playwright.config`. One command
runs your own Playwright with GenClass on the pages your tests open:

```bash
npm install -D @genclass/playwright @genclass/runtime@beta
npx genclass-playwright-run            # every argument goes to "playwright test": --project, --grep, a file, ...
```

When the run ends it prints where the race files are and what they hold, for example:

```text
GenClass: 4 race files in test-results/genclass (2 tests): 1 signature in 1 test, 1 reproducible (flagged in 2 or more seeds of the same test).
  search.spec.ts > search > shows the results of the last query
    witness:overwrote-newer · GET /api/search · 2 of 2 seeds (1, 2) · reproducible
  The report: node node_modules/@genclass/playwright/bin/genclass-playwright-report.mjs test-results/genclass --out -
```

What the command does, in order:

1. It finds your project's own Playwright (`@playwright/test` resolved from your config's directory, then from the
   working directory; it never brings or loads another copy, which Playwright refuses) and your config the way
   Playwright finds it: `--config` / `-c` when you pass one, else `playwright.config.ts`, `.js`, `.mts`, `.mjs`,
   `.cts` or `.cjs` in the working directory.
2. It writes one small file next to your config, `<your config>.genclass-<pid>.mjs`, that imports the register entry
   (`@genclass/playwright/register`, by absolute file URL) and then hands Playwright your config unchanged, imported
   or required as Playwright itself would have loaded it. Playwright loads its config again in every worker, before
   any test file: that is how the entry gets there. The file is removed when the run ends, also when the run fails
   or is interrupted (a run killed with `SIGKILL` leaves it behind: delete it).
3. It runs `playwright test --config <that file>` with your other arguments as they are, and adds `--repeat-each 2`
   unless you pass a `--repeat-each` yourself: two seeds, so the report can mark a finding **Reproducible**.
4. Chaos is on unless `GENCLASS_CHAOS` says otherwise, and the race files go to `test-results/genclass` under the
   working directory, whatever your config's `outputDir` is. Race files of an earlier run in that directory are
   removed first (files whose `schema` is `genclass-races/1`; nothing else is touched).
5. Its exit code is Playwright's. It is 2 when Playwright could not be started at all (it is not installed there,
   `@genclass/runtime` is not installed, or the file of step 2 could not be written); nothing has run then.

What the register entry does in each Playwright worker: through the prototypes of Playwright's public objects, it
wraps `browserType.launch`, `launchPersistentContext`, `connect` and `connectOverCDP` (the browser they return is the
way to the rest), `browser.newContext` and `browser.close`, and `browserContext.close`. A browser context a test
makes then gets what the fixture gives a page, at the level of the context (`context.addInitScript`,
`context.route`, `context.exposeBinding`): the runtime before the app's first script, in observe mode with
telemetry off, the seeded chaos when it is on, and the collection of what the runtime saw. So pages from
`context.newPage()`, popups and contexts your tests make with `browser.newContext()` are covered too. Before a
context closes, its pages are asked what they saw and the test's file is written: one `genclass-races/1` file per
test, seed and retry, with the same name, fields and `location` as the fixture's. A test that opens several pages or
contexts gets one file, merged: each page counts with what it reported last, so a page whose agent entry did not
connect keeps the file from saying that it connected, also when that page was closed before its context. What the
pages get is what the fixture's pages get ([What the fixture puts on the page](#what-the-fixture-puts-on-the-page)),
except that the exposed function is the context's and is named `__genclassPlaywrightContext`.

Which test a context belongs to comes from your own Playwright's `test.info()`, and a context is one test's or it is
left alone:

- A context made when no test is running is left exactly as Playwright made it.
- So is a context made while a `beforeAll` or `afterAll` hook runs, which the tests of the describe share (the
  shared-page pattern); the summary says so in one line. Playwright counts the first test as running during
  `beforeAll`, so the entry asks which hook is running the way Playwright's own `context` fixture does, with
  `testInfo._currentHookType()`. That method is not public API: it is the one such read in this package, it is
  checked before it is called, and where it is missing the next rule still keeps every file right.
- A context counts for the test that was running when it was made, and only while that test runs. What its pages
  hand over at any other time is dropped, and its requests are then passed on without a hold. So a context kept for
  later tests (in a variable, in a worker-scoped fixture) or one a test did not close puts nothing into another
  test's file. Its own test's file holds what the context handed over while that test ran; it is written when the
  next test makes its first context, when the context or its browser closes, or when the worker exits, without
  asking the pages again. The runtime stays on such a context's pages and goes on observing; nothing more is
  recorded from it, and the summary has one line saying that a context was still open after its test.

A wrapped call is the original call: the same receiver and arguments, the same result, the same error under the same
API name (`browserType.launch: ...`). It adds one stack frame of this package to those seven calls, and the entry's
own calls (`browserContext.exposeBinding`, `route`, `addInitScript`, and a `page.evaluate` when a context closes)
are ordinary Playwright calls, so a trace lists them. If anything inside the entry fails, the context is handed back
as Playwright made it, the test goes on, and one line is remembered for the command's summary (`GenClass notes:`).

### Options

An unmodified config has no `use.genclass`, so the options are environment variables. A value that cannot be read is
replaced by its default and reported in the summary; it never fails a run.

| variable | default | what |
|---|---|---|
| `GENCLASS_CHAOS` | `on` under the command; `off` with the register entry alone | `on` or `off` (also `1`/`0`, `true`/`false`, `yes`/`no`): the seeded chaos of the [Chaos](#chaos) section. |
| `GENCLASS_SEED` | `1` | The chaos seed, a whole number from 0. Playwright's repeat index is added, so `--repeat-each 2` runs seeds 1 and 2. |
| `GENCLASS_CHAOS_DELAY_MS` | `0,600` | `min,max`: extra latency per matched request in ms, at most 10000. |
| `GENCLASS_CHAOS_REORDER` | `on` | `off`: matched requests leave in the order the page sent them (latency only). |
| `GENCLASS_CHAOS_MATCH` | same-origin `/api*` or `Accept: json` | Which requests, as comma-separated path prefixes (`/api,/graphql`) or URL prefixes (`https://api.example.com/`). |
| `GENCLASS_OUT_DIR` | `test-results/genclass` | Where the race files go, against the working directory. |
| `GENCLASS_MODEL` | `skip` | `load`: the runtime loads its model in the page, as with the fixture's `model: "load"`; `GENCLASS_MODEL_URL` names a model directory URL. |
| `GENCLASS_RUNTIME_DIR` | the `@genclass/runtime` installed next to `@genclass/playwright`, else your project's | `@genclass/runtime`'s `dist/` directory, when it is somewhere else. |
| `GENCLASS_PLAYWRIGHT` | on | `off` (also `0`, `false`, `no`): the off switch. The entry does nothing, and the command runs Playwright as it is. |

### In CI: one new workflow file

[`docs/github-app/workflows/genclass.yml`](https://github.com/genclass-dev/GenClass/blob/main/docs/github-app/workflows/genclass.yml)
is a whole workflow to copy to `.github/workflows/genclass.yml`: on pull requests, with `contents: read` only, it
installs your dependencies with the package manager your lockfile names, installs `@genclass/playwright` and
`@genclass/runtime@beta` outside your project (so your `package.json` and lockfile are untouched), installs the
browsers your Playwright wants, runs the command and uploads `test-results/genclass` as the artifact
`genclass-races`, which [genclass-dev[bot]](https://github.com/genclass-dev/GenClass/blob/main/docs/github-app/README.md)
reads. It assumes that `npx playwright test` works on a fresh checkout, which usually means your config has a
`webServer` that starts the app. For a Playwright project in a subdirectory, set `defaults.run.working-directory`
and prefix the artifact's path with it; when that directory has no lockfile of its own (pnpm, Yarn, Bun and npm
workspaces keep one at the repository root), the dependencies are installed from the repository root.

**With chaos on, your app's API calls are held for a seeded time before they leave** (0 to 600 ms each, in an order
the seed decides). A suite that passes normally can fail there: an assertion that only holds when responses arrive
in the order they were sent, a short timeout. That is what the run is for, and it is why the workflow's job is
separate from your own e2e job and allowed to fail (`continue-on-error: true`): it never blocks a pull request.
`GENCLASS_CHAOS=off` keeps the runtime and its witnesses without the holds.

Installed outside the project, `@playwright/test` stays your project's only copy: it is an optional peer dependency
of this package, and npm does not install optional peer dependencies on its own (read from npm 10.9's installer, not
measured with a published package).

### What it covers, and what it does not

Covered: every browser context a test makes, while that test runs. That is Playwright's `context` and `page`
fixtures, `browser.newContext()` and `browser.newPage()` in a test, in a `beforeEach` or `afterEach` hook or in a
test-scoped fixture of your own, `launchPersistentContext`, and a browser your test launches or connects to itself;
in every project of the config (`chromium`, `firefox` and `webkit` share the prototype the entry wraps; the
end-to-end check runs Chromium only). Retries and shards need nothing: the file name carries the test's id, its
seed and the attempt.

Not covered, as it is today:

- **Contexts made outside a test** (`globalSetup`, a script of your own): there is no test to name, so they are left
  alone. A context that already exists when a test connects (the default context of `connectOverCDP`) is left alone
  too.
- **Reuse mode** (`reuseContext`, `PW_TEST_REUSE_CONTEXT`, the VS Code extension's "Show browser"): Playwright makes
  that context through a private method, which this package does not touch.
- **Electron and Android** (`_electron`, `_android`): their contexts are not created by the wrapped methods.
- **Requests a service worker handles**: `context.route` does not see them, so neither the chaos nor the runtime's
  own files reach those pages (the file says a service worker was in control, and the report notes it).
  `serviceWorkers: "block"` is the way around, and it is a change to your config.
- **Iframes and `page.setContent`**: the runtime starts in the top frame of http(s) pages only.
- **A context shared by several tests.** One made in a `beforeAll` (or `afterAll`) hook is left alone: no runtime,
  no chaos, no file, so tests that only use such a shared page do not appear in the report. One made in a
  worker-scoped fixture, or kept in a variable for later tests, is covered for the test that was running when it was
  made, until that test ends; the later tests that use it are not covered, and nothing it sees then is recorded or
  held. In a Playwright whose `testInfo` has no `_currentHookType` method, a `beforeAll` context is treated like
  that too.
- **A context still open when its test ends** (the test closed neither it nor its browser) is not asked afterwards:
  the test's file holds what the context's pages had handed over while the test ran (detections and witnesses as
  they happened, the mode, whether the agent entry connected; not whether a service worker was in control), and is
  written when the next test makes its first context, when the context or its browser closes, or when the worker
  exits.
- **A suite that answers every request itself** (`routeFromHAR` with `notFound: "abort"`, a catch-all `page.route`)
  also answers the request for the runtime's agent entry on `/__genclass__/`: it does not load, the file says so, and
  a test that counts failed requests or console errors can see that one. `context.unrouteAll()` in a test removes
  GenClass's routes with yours. A page whose Content-Security-Policy does not allow scripts from its own origin
  blocks the agent entry the same way.
- **A spec that already imports the fixture**: the entry covers its context first and the fixture leaves that page
  to it, so that test runs on the environment's options, not on `use.genclass`. Nothing is installed twice. Every
  published fixture does this (0.1.0 is the first), whichever copy of the package the spec imports it from: the
  entry's state is one per process.
- **What the runtime cannot see**: as with the fixture, the witnesses need state the runtime can attribute a write
  to ([The model trade-off](#the-model-trade-off)).
- **Yarn Plug'n'Play**: the command finds Playwright with Node's own module resolution.

Also different from a plain run: `testInfo.config.configFile` is the generated file's path (same directory as
yours), any route turns off the browser's HTTP cache, and closing a context takes a moment longer (its pages are
asked first; at most 2 seconds for a page that never answers).

### Without the command

Where a generated config cannot work (the suite is started by a script of its own, or the config's directory cannot
be written to), preload the register entry instead. It works the same way from there: it waits in the processes
Playwright starts from its own package, begins when one becomes a worker, and does nothing in any other process (a
helper process one of your tests forks included: Playwright is never loaded there).

```bash
NODE_OPTIONS="--import /abs/path/to/node_modules/@genclass/playwright/dist/register.js" GENCLASS_CHAOS=on npx playwright test --repeat-each 2
```

(A `file://` URL works in place of the path, and is the form to use when the path has a space in it.) Here chaos is
off unless you set `GENCLASS_CHAOS=on`, `--repeat-each` is yours to pass, nothing empties the output directory
before the run, and a remembered line is printed on stderr instead of in a summary. `NODE_OPTIONS` reaches every
Node process of the run (your web server, your package manager); the entry does nothing there, but a script in your
suite that sets its own `NODE_OPTIONS` drops it, and then nothing is recorded.

## Measured

The fixture's end-to-end check, [`test/e2e`](test/e2e) (run by [`.github/workflows/playwright-reporter.yml`](../../.github/workflows/playwright-reporter.yml)),
on the search page of the MCP server's own e2e ([`packages/mcp/test/e2e/app/app.js`](../mcp/test/e2e/app/app.js)):
a search box whose results are written by each response, so a slower older answer can land over newer results; the
fixed variant keeps only the answer to the latest query. The test types "react" at 80 ms per key; the backend
answers in 40 ms, in order, so without chaos the race never shows. The page's `app.js` is unchanged, but the check's
server ([`test/e2e/server.mjs`](test/e2e/server.mjs)) maps its `@genclass/runtime` import to the page's script-tag
runtime, so its `rt.atom("search")` store is registered with the fixture's runtime: the script-tag integration case.
The same app with its own ESM runtime gets no witness (the store is on another runtime; see the limits above): a
review run of the unmodified app recorded none in 5 of 5 seeds. Headless Chromium 153 (Playwright 1.63.0),
2026-10-25, `model: "skip"`, six runs of the check, five seeds each (`repeatEach: 5`), so 30 seeds per row:

| page | chaos | seeds with `witness:overwrote-newer` on `GET /api/search` | any other signature | console errors or failed requests |
|---|---|---:|---:|---:|
| buggy | latency 0 to 600 ms, reorder | 30 of 30 | 0 | 0 |
| buggy | latency 0 to 600 ms, latency only (`reorder: false`) | 0 of 30 | 0 | 0 |
| fixed | latency 0 to 600 ms, reorder | 0 of 30 | 0 | 0 |

So on this page the fixture finds the race under every seed, reports nothing on the correct variant (the false
report count that goes next to every recall number here), and reports nothing when the chaos cannot reorder, which
is the check that the witness comes from the order and not from the latency.

The same buggy page with `model: "load"` (one run by hand on 2026-10-24, two seeds, not part of the workflow because
it downloads the model, and before the chaos moved from responses to requests): the model loaded through the fixture's path (`genclass-runtime-r17` 2.0.0-rc4t, WASM, in a
worker) and the witness was recorded in 2 of 2 seeds, but the model itself produced no likely detection: in seed 1
its top diagnosis for the late delivery was `stale` at 0.64, below the 0.90 report gate, and in seed 2 it raised
no decision. That matches the compatibility matrix below (stale detection is the model's weak case) and is why the
witnesses are the default.

The same page under a suite nobody edited ([`test/e2e-unmodified`](test/e2e-unmodified), which imports only
`@playwright/test`), run through `genclass-playwright-run`, is the second half of that check
([`test/e2e/unmodified.mjs`](test/e2e/unmodified.mjs)): it requires the witness on the buggy page in at least one of
the command's two seeds, nothing on the fixed page and nothing in a latency-only run. It has no row in the table
yet: it was written without a browser at hand, and its numbers are added after its first runs in CI.

One page is not a benchmark: the numbers to expect on your app depend on what state the runtime can see (above).
Wider measurements (the six demos, the real-app corpus) are the next step and will go to
[`docs/runtime/RESULTS.md`](../../docs/runtime/RESULTS.md).

## The reporter

```ts
// playwright.config.ts
reporter: [["list"], ["@genclass/playwright/reporter"]],
```

Listed alone (`reporter: [["@genclass/playwright/reporter"]]`) it works too: it prints only the report, once, at the
end, so Playwright still adds its own line reporter (dot on CI) for progress and failures, as it does next to the
html reporter. Playwright finds the reporter by its module name; `playwright-reporter.yml` checks that with a real
Playwright run (no browser).

| option | default | what |
|---|---|---|
| `dir` | `test-results/genclass` and `genclass` inside each project's `outputDir` | Where the fixture's files are, relative to the config's directory (a string or a list). |
| `outputFile` | `"genclass-report.md"` | The report, relative to the config's directory. `false`: print only. |
| `quiet` | `false` | Do not print the report at the end of the run. |
| `minSeeds` | `2` | Seeds a signature must be flagged in, within one test, to be marked **Reproducible**. |
| `title` | `"GenClass race report"` | The report's heading. |
| `maxChars` | `60000` | Keep the report under this many characters, so it fits in one GitHub comment (GitHub rejects comment bodies over 65,536). `0`: no limit. |

The reporter never changes the run's status and never throws into Playwright: a report it cannot write is one line
on stderr. It reads files; it does not inject anything (the fixture does that), and Playwright is not imported by
it: the reporter implements Playwright's reporter interface by shape, and the summariser is a pure function you can
call from any script.

### Without the reporter, or with shards

```bash
npx genclass-playwright-report [dir ...] [--out <file>|-] [--min-seeds <n>] [--max-chars <n>] [--title <text>] [--quiet]
```

Same report from the same files (default dir `test-results/genclass`, default out `genclass-report.md`, `-` prints
only, default `--max-chars 60000`, `0` for no limit). For sharded runs, collect each shard's `test-results/genclass/`
and pass the directories. Exit code 0 when the report was written, whatever it says; 1 when the file could not be
written; 2 on a usage error.

From code (pure, no I/O):

```ts
import { summarize } from "@genclass/playwright/summarize";
const markdown = summarize([{ name: "checkout-1.json", content: jsonText }], { minSeeds: 2 });
```

`buildSummary` returns the same report as data (tests, signatures, seeds, totals, skipped files), and
`validateRaces` / `parseRaces` check one file.

### The file format

One JSON file per test and seed in `test-results/genclass/`, format `genclass-races/1`:

```ts
interface GenClassRacesFile {
  schema: "genclass-races/1";
  test: string;                  // "[chromium] checkout.spec.ts > checkout > places one order"
  seed: number;                  // the chaos seed of this run
  signatures: {
    sig: string;                 // "trigger|diagnosis|op"
    trigger: string;             // the runtime's trigger kind ("request", "delivery", "failure", ...) or "witness"
    diagnosis: string;           // the model's diagnosis ("duplicate", "stale", "failing", ...) or the witness kind
    op: string;                  // "POST /api/orders"
    confidence: number;          // the model's probability for that diagnosis, 0 to 1; 1 for a witness (a fact)
    evidence: string;            // the line the runtime printed, or the witness's line
    seeds: number[];             // the seeds this signature was seen in
  }[];                           // at most 200
  dropped?: number;              // written by the fixture: signatures of this test it left out to stay within the limits
  mode?: string;                 // "observe"
  model?: { state?: string; name?: string; version?: string; device?: string } | null;  // null: GenClass never started
  chaos?: { latencyMs?: [number, number]; reorder?: boolean; routes?: unknown[] } | null;  // the chaos option (latencyMs is delayMs)
  fixture?: {                    // written by the fixture: what it could and could not do on the page
    model: "skip" | "load";      // the fixture's model option
    agent: string | null;        // null: the agent entry connected and witnesses were recorded; else why not
    chaosApplied: number | null; // how many requests chaos held (null: chaos off)
    serviceWorker: boolean;      // a service worker controlled the page
    modeOverridden?: string;     // a URL or localStorage switch had asked for this mode; set back to observe
  };
  location?: {                   // written by the fixture: where the test is declared
    file: string;                // "tests/checkout.spec.ts": relative to the repository root, "/" separators
    line: number;
  };
}
```

`location` is relative to the checkout on GitHub Actions (`GITHUB_WORKSPACE`), else to the Playwright config's
directory, and is left out when Playwright gives no line or the test file is outside that directory. The report does
not use it; [genclass-dev[bot]](https://github.com/genclass-dev/GenClass/blob/main/docs/github-app/README.md), the GitHub
App, puts a finding next to the test with it when that line is part of a pull request's diff.

The format has limits, exported as `RACES_LIMITS`, so that a reader that takes files from anyone
(genclass-dev[bot] reads the artifacts of pull requests, also from forks) knows how much one file can hold:

| | |
|---|---|
| Signatures in one file | 200 |
| Seeds in one signature's `seeds` list | 64 (the fixture writes one); over it the file is refused, on the count alone |
| A test's name (`test`) | 1,000 characters |
| An evidence line (`evidence`) | 2,000 characters |
| Any other string (`sig`, `trigger`, `diagnosis`, `op`, `mode`, the `model` and `fixture` strings) | 600 characters |
| The file | 64 KB (65,536 bytes of UTF-8) |

The validator refuses a file with more than 200 signatures, on the count alone, and a file with a string over its
length, like any other bad field. It sees parsed values, so it does not check the file's size: genclass-dev[bot] reads
files up to it. The fixture writes within the limits. It cuts a longer string (the cut one ends with `…`; an operation
is cut the same way in every seed, so it stays one signature). When a test has more signatures than fit, by count or
by size, it writes the most confident ones (a witness, a fact, counts as 1) and puts the number it left out in
`dropped`. The report then says under that test that its list is not complete. Leaving signatures out is the only way
the fixture makes a file smaller: a file over 64 KB with no signature in it, which takes a `chaos.match` list of that
size, is written as it is.

The type is exported as `GenClassRacesFile`. A file that does not validate is never half-read: the report lists it
under **Files skipped** with the field and the reason (for example
`signatures[0].confidence: expected a number from 0 to 1, got 1.4`), so a change of format shows up in the comment
instead of as an empty report.

How the report groups them:

- **by test**, then **by signature**: the same `sig` in several files of one test is one line, with the seeds merged,
  the highest confidence and that occurrence's evidence line;
- **Reproducible** when a signature was flagged in at least `minSeeds` seeds of the same test; a signature seen in
  fewer seeds may depend on that seed's timing;
- **groups by the model's diagnosis label**: `duplicate` (Duplicate submits), `stale` (Stale responses), `failing`
  (Failing endpoints) and everything else (Other detections: `transient`, `inconsistent`, `overload`, ...).
  `expected` is not a detection and is left out. Nothing looks at facts or decides on its own what is a bug;
- **witnesses** (trigger `witness`) get their own group, shown only when there are any, with no confidence on the
  line and a footer sentence saying what they are; they are never counted as duplicate submits or stale responses;
- a file that flagged nothing and whose `model.state` is not `ready` (for example `loading`, or `null` for a page
  where GenClass never started) may not have been checked, and the report notes it for that test. A fixture file
  with `model: "skip"` gets no model note; the fixture record decides instead: a file that flagged nothing while the
  witnesses could not be recorded, or while a service worker controlled the page, gets a note too, and so does a test
  where chaos was on but held no request. A file with detections is reported as usual whatever the state: the runtime
  can unload an idle model after it ran;
- a test whose files carry `dropped` gets a note with how many signatures the fixture left out, so a list that is not
  complete does not read as complete;
- **nothing about interventions.** The files do not say what an action did to your app, so the report makes no
  claim about interventions, correct or false.

What it does so the comment is safe to post:

- text from the files (test names, evidence lines, modes) is escaped, so it cannot turn into markup;
- `#` before a digit, `GH-` before a digit and `@` before a name get an invisible zero-width space (U+200B). The
  runtime's evidence lines name requests by id (`#15`), which GitHub would otherwise link to issue or pull request
  15 of your repository (adding a "mentioned this" entry there), and a Playwright tag in a test title (`@smoke`)
  would mention a user or team. The text reads the same; copied, it carries the invisible character. Code spans
  (operations, file names) are left as they are, since GitHub links nothing inside them;
- `://` and `www.` get the same invisible character (`https:` then `//`, `www` then `.`). GitHub turns a bare web
  address into a link wherever it stands, and the address of an issue or pull request in another repository also
  adds a "mentioned this" entry there. An address in a test name or an evidence line is therefore shown as text, not
  as a link;
- the report is kept under `maxChars` (default 60000 characters). Left out first: entries of the "nothing flagged"
  and "Files skipped" lists, then the least important signatures of each test (fewer seeds and lower confidence
  first), then whole tests from the end. The counts always include everything, and a note under the first line says
  what was left out.

### What the comment looks like

This is the exact output for the unit-test fixture in [`test/fixtures/races`](https://github.com/genclass-dev/GenClass/tree/main/packages/playwright/test/fixtures/races): two tests, two
seeds each, one signature flagged in both seeds and one in a single seed, both model detections (a run with
`model: "load"`). The fixture is synthetic (the evidence lines are written for the test, not taken from a real run);
`test/package.test.ts` fails if this block and the summariser drift apart. Each `#` of a request id below is
followed by the invisible zero-width space described above.

```markdown
<!-- genclass-report -->
## GenClass race report

**2 signatures** in 2 tests, **1 reproducible** (flagged in 2 or more seeds of the same test) · 4 files read in `test-results/genclass`

| | signatures | reproducible |
|---|---:|---:|
| Duplicate submits | 1 | 1 |
| Stale responses | 1 | 0 |
| Failing endpoints | 0 | 0 |
| Other detections | 0 | 0 |

### checkout.spec.ts > checkout > places one order

2 seeds (1, 2) · 1 signature

**Duplicate submits**

- **Reproducible**: 2 of 2 seeds (1, 2) · `POST /api/orders` · `request:duplicate` · confidence 0.97
  > 1 identical POST /api/orders request in the last 10s (#​15, 0.03s earlier, still in flight); no user action between them.

### search.spec.ts > search > shows the results of the last query

2 seeds (1, 2) · 1 signature

**Stale responses**

- 1 of 2 seeds (2) · `GET /api/search` · `delivery:stale` · confidence 0.91
  > The response of GET /api/search (#​21) arrives after a newer GET /api/search (#​23) was answered; it would replace results.query, which #​23 wrote 0.31s ago.

---

Each line is a diagnosis by GenClass's on-device model in the page under test, one per signature (trigger, diagnosis, operation). Reproducible: flagged in 2 or more seeds of the same test. A signature seen in fewer seeds may depend on that seed's timing: re-run with more seeds before acting on it. Confidence is the model's probability for the diagnosis (the highest over the seeds), and the quoted evidence line is from that seed.
```

A run with the default `model: "skip"` looks like this instead (the e2e check above, shortened to the one flagged
test; the request ids carry the same invisible character):

```markdown
| | signatures | reproducible |
|---|---:|---:|
| Duplicate submits | 0 | 0 |
| Stale responses | 0 | 0 |
| Failing endpoints | 0 | 0 |
| Other detections | 0 | 0 |
| Witnesses (facts measured without the model) | 1 | 1 |

### search.spec.ts > search > buggy page: results of the last query

5 seeds (1, 2, 3, 4, 5) · 1 signature · chaos: latency 0–600 ms, reorder

**Witnesses (facts measured without the model)**

- **Reproducible**: 5 of 5 seeds (1, 2, 3, 4, 5) · `GET /api/search` · `witness:overwrote-newer`
  > The response of GET /api/search#​1 wrote search.results over what newer GET /api/search#​4, started 0.26s after GET /api/search#​1, had written (2 items \["reac one", "reac two"\] → 2 items \["r one", "r two"\]).
```

The first line of every report is an HTML comment, invisible on GitHub, that lets a CI step find and update its own
comment.

## Post it on the pull request

No new secret: the workflow's own `GITHUB_TOKEN` with `pull-requests: write`. On pull requests from forks that token
is read-only, so the step is skipped there (the job summary still works).

The reporter's `genclass-report.md` is kept under 60000 characters by default, which fits in one comment (GitHub
rejects bodies over 65,536). The job summary takes up to 1 MiB per step, so the summary step below renders a longer
report from the same files with the command (300000 characters stays under 1 MiB even if every character took three
bytes).

```yaml
# .github/workflows/e2e.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test --repeat-each 2   # the fixture writes the race files, the reporter the report

      - name: GenClass report in the job summary
        if: ${{ !cancelled() }}
        run: npx genclass-playwright-report --max-chars 300000 --out - >> "$GITHUB_STEP_SUMMARY"

      - name: GenClass report on the pull request (one comment, updated in place)
        if: ${{ !cancelled() && hashFiles('genclass-report.md') != '' && github.event.pull_request.head.repo.full_name == github.repository }}
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: genclass-report
          path: genclass-report.md
```

The same with the GitHub CLI only (it updates the bot's comment that starts with the report's marker, or adds one):

```yaml
      - name: GenClass report on the pull request
        if: ${{ !cancelled() && hashFiles('genclass-report.md') != '' && github.event.pull_request.head.repo.full_name == github.repository }}
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          id=$(gh api "repos/$REPO/issues/$PR/comments" --paginate \
            --jq '.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("<!-- genclass-report -->"))) | .id' | head -n 1)
          if [ -n "$id" ]; then
            gh api -X PATCH "repos/$REPO/issues/comments/$id" -F body=@genclass-report.md > /dev/null
          else
            gh api -X POST "repos/$REPO/issues/$PR/comments" -F body=@genclass-report.md > /dev/null
          fi
```

### With the GitHub App instead

[genclass-dev[bot]](https://github.com/genclass-dev/GenClass/blob/main/docs/github-app/README.md), GenClass's GitHub App
(not installable yet), does the posting itself: the workflow only uploads the race files, with no write permission, so
it is the same for pull requests from forks. The app keeps one comment per pull request, numbers the findings, says
from push to push which are new, still flagged or not flagged at the new commit, and answers `@genclass-dev replay 1`.

```yaml
      - run: npx playwright test --repeat-each 2
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: genclass-races
          path: test-results/genclass
          retention-days: 7
```

Use one or the other: with the app installed, leave out the comment step above, or a pull request gets two comments.

## What to expect from the model

With `model: "load"`, the report passes on what the runtime's model flagged. That was measured on the framework
compatibility matrix
([`compat/RESULTS.md`](https://github.com/genclass-dev/GenClass/blob/main/compat/RESULTS.md), run of
2026-10-10; headless Chromium, 10 seeds per cell, model `genclass-runtime-r17` 2.0.0-rc4t, the default of
`@genclass/runtime-model` 0.2.0, WASM, balanced profile, whose report threshold is 0.90). The runtime was
`@genclass/runtime` packed at commit `d04eff3` (version string 0.1.0-beta.4, never published): the 0.1.0-beta.4 code
plus the "Model ready" log fix. 0.2.0's audit trail, protect presets, hold-budget ceilings and invariant fixes, 0.2.1's
first-request hold and telemetry defaults and every later release were not run through the matrix
([`docs/runtime/RESULTS.md`](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md) §16):

- **Double submit** (scenario b, a create form clicked twice): 10 `request:duplicate` detections over 10 seeds in
  each of the 14 data layers where the scenario applies (React state, TanStack Query, Zustand with its devtools
  middleware at the default and with `enabled: true`, Redux, Apollo, Next.js state, SWR, Pinia, Svelte stores,
  Angular fetch, Angular XHR, Solid, plain fetch).
- **Stale typeahead** (scenario a; the app showed stale results on 10 of 10 seeds without GenClass in 11 data
  layers): `delivery:stale` detections over 10 seeds were 2 (React state), 5 (Zustand with its devtools middleware
  set to `enabled: true`), 1 (Redux) and 2 (Next.js state), and 0 in the other 7 layers with the bug (Zustand with
  the middleware at its default, Pinia, Svelte stores, Angular fetch and XHR, plain HTML fetch and push). Stale
  detection needs state the runtime can discover: React component state, Redux, and Zustand stores whose devtools
  middleware is enabled (the discovery table of the same page).
- **On correct apps** (scenarios c to h, 880 runs): 319 findings. 270 of them report a failure the scenario injects
  on purpose (an HTTP 500, going offline), which the app handles correctly; in your report those appear under Failing
  endpoints and Other detections. 49 are false findings, `request:overload` ×45 and `request:duplicate` ×4, all on the
  polling scenario (g).

So with the model, lead with duplicate submits, expect stale signatures only where that state is discovered, and
treat any line as the model's diagnosis to check, not a confirmed bug. The witnesses (the default) were measured
only on the one page above so far.

## Privacy

This package reads and writes files on the machine that runs it, serves the runtime's files to the page it tests
from disk, and sends nothing anywhere: with `model: "skip"` no network request leaves your test environment
because of it; with `model: "load"` the page downloads the model (from jsDelivr, or `modelUrl`) and
onnxruntime-web's wasm (from jsDelivr). The runtime on the page runs with `telemetry: false`. The register entry and
`genclass-playwright-run` are the same in this: they write the generated config next to yours, the race files, and
one temporary file for the lines the workers remember, and send nothing.

The files hold test titles, operation names and the runtime's evidence lines. For a witness that line includes the
store field's name and the runtime's short summary of its value before and after (`2 items ["r one", "r two"]`;
fields whose name says they hold a secret are redacted by the runtime, as elsewhere). The comment you post contains
the same, so read a report before posting it from a repository whose test data is private.

Without the fixture (the reporter alone, with `@genclass/runtime` installed in your app), the runtime under
test sends **anonymous diagnostics by default** on public hosts: GenClass's decisions and counts,
no text from your page unless the app opts in, to the GenClass maintainers to improve the model. They are off on
`localhost` and other local hosts (`*.localhost`, `*.local`, `*.test`, `127.0.0.1`, private networks) from
`@genclass/runtime` 0.2.2, which is where e2e suites usually run. Earlier versions (`0.1.0-beta.3` to `0.2.1`) send
from local hosts too, and `0.1.0-beta.3` to `0.2.0` include the redacted situation text by default. With those
versions, or with a test server on a non-local host name, pass `telemetry: false` to the runtime under test; the
other opt-outs are `?genclass=no-telemetry`, `localStorage.setItem("genclass.telemetry", "off")` and Global Privacy
Control. Details:
[`TELEMETRY.md`](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/TELEMETRY.md).

## Development

From the repository root (CI runs these in `.github/workflows/playwright-reporter.yml`):

```bash
npm run typecheck -w @genclass/playwright
npm run build -w @genclass/playwright
cd packages/playwright && npx vitest run   # chaos, race files, the installer on a fake page, schema, summariser (exact output), reporter, commands, package invariants; the register entry on fakes of Playwright's objects, the generated config and the run command as exact text and argv
```

With `dist/` built, `test/run.test.ts` also runs Playwright itself on [`test/register-smoke`](test/register-smoke)
(an ordinary project; no page, so no browser): through the command (with a config Playwright imports and one it
requires), with the entry preloaded by `NODE_OPTIONS`, and with the off switch. The spec there checks from inside the
worker that the generated config was loaded, that the prototype of `chromium` is patched and that a wrapped call
still fails with Playwright's own error. It also interrupts the command in the middle of a test
([`test/interrupt-smoke`](test/interrupt-smoke)) and requires Playwright's own exit code and no generated config left,
and it forks a helper process the way a test would, with the entry preloaded, and requires that the entry stays idle
there and that Playwright is not loaded. [`test/hook-smoke`](test/hook-smoke) is run by `test/worker.test.ts` on the
installed Playwright (no browser either): its spec holds the two things the entry needs from Playwright to tell whose
a browser context is, which hook is running and which test is the one running, and fails when a Playwright no
longer has them.

The end-to-end check needs both builds and Chromium:

```bash
npm run build -w @genclass/runtime && npm run build -w @genclass/playwright
npx playwright install --with-deps chromium
node packages/playwright/test/e2e/run.mjs   # one run of the table in "Measured": exit 0 when the buggy page has the witness in at least 1 of 5 seeds and nothing else, and the other two rows have nothing; then the same page under the unmodified suite, through genclass-playwright-run
```

Each Playwright run of that check is a child process with a time limit, so the check ends by itself; what it found
is printed as JSON, and a failure says what was expected and what was found.

The workflow also runs Playwright itself on `test/playwright-smoke` (no browser: its one test writes race files and
uses no page), which loads `@genclass/playwright/reporter` by name the way your config does, and checks that the
reporter's file equals the command's rendering of the same files. The module-resolution test in
`test/package.test.ts` needs `dist/` (build first); without it, outside CI, it is skipped.

Apache-2.0.
