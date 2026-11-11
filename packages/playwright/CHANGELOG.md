# Changelog

Changes to `@genclass/playwright`, the Playwright reporter for
[`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) race files.

## Unreleased

- **A test that fails in some runs: which order of steps its failing runs have.** New mode of the command:
  `genclass-playwright-run --explain-flaky[=N] [arguments that select the test]` runs Playwright N times (default 30),
  each run a Playwright run of its own under the next seed (`--repeat-each 1`, so no two runs share a worker, a saved
  login or a server), keeps every run's race files (Playwright empties its output directory at each start: the files
  are set aside and put back at the end), and then compares the order of steps in each test's failing runs with the
  order in its passing runs. It prints the orders that failing runs have and next to no passing run has: "X came
  before Y", or "X came between A and B", with the counts of both kinds of run, the median time between the steps, and
  how often the same search finds as much when the outcomes are shuffled. It uses only what the runtime records on
  every framework (user actions, each request's send, the delivery of its response) and no app state. It is a
  measured comparison, labelled as one, never a diagnosis. It refuses below three failing and three passing runs, and
  calls nothing an explanation when shuffled outcomes do as well in more than 5% of the shuffles. Its exit code is 0
  when the runs were made (failing runs are what it compares). With `GENCLASS_CHAOS=off` the runs differ only by
  their own timing. Measured on the bench, on two apps whose state the runtime does not see and on one real suite:
  [docs/runtime/RESULTS.md](../../docs/runtime/RESULTS.md) section 30.
- **The report says the same when the files already hold enough runs** (retries, several seeds): a section "Failed in
  some runs" in `genclass-report.md` (the reporter and `genclass-playwright-report`) and in the command's summary.
  With too few runs, and no witness in a failing run, one line names the command above for that test. Files without
  a status (written by 0.1.0) give the report they gave. `summarize()` and `buildSummary()` from code are unchanged
  and say none of this: the section is a module of its own (`src/explain.ts`) that the summariser does not import, so
  genclass-dev[bot], which bundles the summariser, reads and writes what it did. New option `after` of `summarize()`
  and `renderMarkdown()`: lines of the caller's own to put after the tests with signatures.
- **Two new optional fields in a race file**, both ignored by a reader that does not know them: `status` (the test's
  own status when the file was written: `passed`, `failed`, `timedOut`, `interrupted`) and `steps` (the page's steps
  in order: `labels`, and `order` as `<kind><label>.<n>+<ms>` tokens; `body` says how many of them happened while the
  test's own code ran, `cut` how many more there were). At most 300 steps and about 5 KB by default (`steps` option,
  `GENCLASS_STEPS`; `false` or `0` for none; `--explain-flaky` keeps 1000), never more than 2000 (`STEPS_LIMITS`), and
  a file stays within 64 KB: steps go into the room the signatures leave. A step names a request by method and path
  (ids as `:id`, no query, no body) and a user action by its kind and the runtime's description of its target, never
  a value that was typed. The validator reads both leniently: a value it cannot read is left out, the file is kept.
- **When a test's own code ends** is taken from the moment Playwright sets `testInfo.duration`, which it does when
  the test's function returns or throws, before after-hooks, screenshots and teardown. The property is watched for
  that one assignment and then put back as it was; where it is not the plain number Playwright makes, nothing is
  touched and the end is where the page was first asked at the end of the test. Only the `steps` use it (a step that
  landed after the test's code cannot have changed its result).
- **Without chaos, `GENCLASS_SEED` (new option `seed`) names a run's file**, so runs started one after the other do
  not write over each other's files. With chaos it is the chaos seed, as before.
- A test that closes its own browser context and fails afterwards has its file written again with the status it
  ended with (when the next test starts, or when the worker exits).

- **The end of a test waits for responses in flight.** Before it collects, the fixture (and the register entry)
  waits for the responses to requests the page had sent a moment ago and not seen answered, so an older response that
  lands after the test's last assertion is recorded. Bounded: at most `waitForResponsesMs` (default: the chaos
  delay's upper bound plus 1000 ms, so 1600 ms; 1000 ms without chaos), never into the last 2 seconds of the test's own
  timeout, nothing for a test that ends with no request in flight or that timed out, and no change to any test's
  outcome. Requests open for longer than the wait (streams, long polls) and requests sent during it are not waited
  for. New option `waitForResponsesMs` and variable `GENCLASS_WAIT_FOR_RESPONSES_MS`; `0` turns it off. When a
  context closes, each page is now asked with `page.evaluate` more than once. Measured in `bench/pr-evidence` and
  [docs/runtime/RESULTS.md](../../docs/runtime/RESULTS.md).
- **Identical requests, and writes to one path, keep their order under chaos.** Two requests with the same method,
  URL and body, and two writes (any method but GET, HEAD, OPTIONS) to the same path whatever their bodies, are still
  delayed, but the one sent second no longer leaves before the first. Swapped writes changed what the server stored
  (two notes in the other order; the older save of a form kept), which no slow answer does: on the bench's autosave
  form the server ended with an older name and the test failed on a value no response order alone gives. Before, a poll or a "+1" held longer than the
  identical request sent after it reached the server second and came back with the newer answer, and its response
  landing last was recorded as `overwrote-newer` although nothing older had replaced anything newer. Requests that
  differ are reordered as before.
- **Chaos reaches an API on the same host and another port.** The default filter was same-origin only, so an app
  whose page is on `localhost:3000` and whose API is on `localhost:8080` (the usual local and CI setup) had no request
  held and no order tried, and only the full report said so. The default is now the page's own host, any port, with
  the same path and Accept conditions; an API on another host name still needs `chaos.match` /
  `GENCLASS_CHAOS_MATCH`. The command's summary now says when chaos held no request, with the variable to set.
- **Chaos holds nothing while the page is offline.** A request sent with no network fails at once; held past the
  moment the network came back, it was sent and answered, so an app that queues what failed offline and sends it
  again saw the later note arrive first (compat's "offline, then sync" scenario: a correct app showed a bug in 4 of
  36 trials with nothing flagged, 8 of 36 once seeds were mirrored). The page now tells the fixture when it goes
  offline and comes back; what was held leaves at that moment.
- **A request's key no longer carries the ids in its path.** Delays are derived from the seed and the request's key
  (method, path, occurrence). A path segment that is an id (digits, a UUID, a long hex string, a generated token) is
  now keyed as `:id`: a record the test created a moment ago has another id in every run, so its requests got another
  delay in every run of the same seed, which the README said could not happen. Found on a real suite, where 5 of 14
  requests of one test changed their delay between two runs of one seed.
- **A finding's operation is guarded against ids in its path.** The operation a finding is known by (`op`, and so its
  `sig`) has to be the same from seed to seed and from push to push (genclass-dev[bot] knows a finding by it), so an
  id a test created must not be in it. The runtime's request keys already write the ids they recognise as `:id`
  (seen on a public suite: `PATCH /api/autosave-posts/:id`), so this fixes nothing that was measured: `opOf` now
  applies the fixture's own id rule as well, to whatever text it is given. No signature in the measurements changed.
- **The command gives Playwright the project's local bins on `PATH`.** `npx playwright test` puts
  `node_modules/.bin` on `PATH`; this command, started with `node <path>` as the workflow file does, did not. A
  project whose `webServer.command` names a local bin then never started: on a public Next.js starter the web server
  ended with `pglite-server: command not found`, exit 127, and no test ran. The `.bin` of the config's directory, of
  the working directory and of each of their parents now come first on `PATH`, also when GenClass is switched off.
- **Seeds come in mirrored pairs.** An even seed gives each request the mirror image of the delay the odd seed before
  it gives (`min + max - delay`), so the default two seeds try each pair of requests in both orders. Seed 1 and every
  odd seed are what they were; even seeds' delays change from 0.1.0. A two-request overwrite then shows in one seed of
  a pair, never both: it needs `--repeat-each 4` to be marked reproducible. `chaos.mirror: false` or
  `GENCLASS_CHAOS_MIRROR=off` gives every seed delays of its own, as before.

## 0.1.0 (2026-11-10)

The first version on npm: the fixture, the reporter, and the same without editing a suite (the command
`genclass-playwright-run` and the entry `@genclass/playwright/register`).

- **A suite nobody edits** (`genclass-playwright-run`, `@genclass/playwright/register`): GenClass on an existing
  Playwright suite with no change to its test files or its `playwright.config`. The command finds the project's own
  Playwright and its config the way Playwright does (`--config` / `-c`, else `playwright.config.ts`, `.js`, `.mts`,
  `.mjs`, `.cts`, `.cjs` in the working directory), writes a config next to it that imports the register entry by
  file URL and then hands Playwright the user's config unchanged (imported or required as Playwright would have
  loaded it), runs `playwright test` on it with every other argument passed through, and removes the file when the
  run ends, also on failure and on SIGINT. Defaults for a first run: chaos on, `--repeat-each 2` unless one is
  given, race files in `test-results/genclass` under the working directory whatever the config's `outputDir`
  (an earlier run's race files there are removed first). It prints where the race files are and what they hold;
  its exit code is Playwright's (2 when Playwright could not be started).
- **The register entry** wraps, in a Playwright worker and through the prototypes of public objects only,
  `browserType.launch`, `launchPersistentContext`, `connect`, `connectOverCDP`, `browser.newContext`, `browser.close`
  and `browserContext.close`. A browser context a test makes gets what the fixture gives a page (the runtime before
  the app's first script, observe mode, telemetry off; the seeded chaos when it is on), at the level of the context,
  so `context.newPage()` pages and popups are covered. The test comes from the project's own `test.info()` (the copy
  of Playwright that runs the worker; never a second one). Before a context closes, its pages are asked and one
  `genclass-races/1` file per test, seed and retry is written, with the fixture's names, fields and `location`;
  several pages or contexts of one test are merged into the one file. A wrapped call keeps its result, its error and
  its API name in Playwright's messages; the entry never throws into a run: a failure is one remembered line and a
  context without GenClass.
- **A context is one test's, or it is left alone.** A context made when no test is running is left as Playwright
  made it, and so is one made while a `beforeAll` or `afterAll` hook runs: the tests of the describe share it. (Which
  hook is running is the one thing the entry reads from outside Playwright's public API,
  `testInfo._currentHookType()`, by shape; where it is missing, the next rule alone applies.) A context counts for
  the test that was running when it was made, and only while that test runs: what its pages hand over at any other
  time is dropped and its requests are no longer held, so a context kept for later tests (a variable, a
  worker-scoped fixture) or left open puts nothing into another test's file. Such a context is not asked at its
  close; its own test's file is written with what it handed over while the test ran, when the next test makes its
  first context, when the context or its browser closes, or when the worker exits. One line in the summary says so.
- **The pages of a context share one binding**, `__genclassPlaywrightContext` (`context.exposeBinding`): a name of
  its own, because Playwright refuses a page-level function whose name the context already has (the fixture's is
  `__genclassPlaywright`). Each page counts with the agent state it reported last, as the fixture's one page does:
  a page whose agent entry did not connect is in the file even when it was closed before the context or another page
  reported after it, and a page whose runtime did not start does not take away the mode of one whose did.
- **Where the register entry starts.** Under the command, in every Playwright worker. Preloaded with
  `NODE_OPTIONS="--import <path to dist/register.js>"` it works the same way without the command. A worker is a
  child process with a channel to its parent, started by Playwright from its own package, with `TEST_WORKER_INDEX`
  set; in any other process (Playwright's runner, a web server, a build tool, a helper a test forks) the import does
  nothing and Playwright is not loaded.
- **Options from the environment** for that mode: `GENCLASS_CHAOS`, `GENCLASS_SEED`, `GENCLASS_CHAOS_DELAY_MS`,
  `GENCLASS_CHAOS_REORDER`, `GENCLASS_CHAOS_MATCH`, `GENCLASS_OUT_DIR`, `GENCLASS_MODEL`, `GENCLASS_MODEL_URL`,
  `GENCLASS_RUNTIME_DIR`, and the off switch `GENCLASS_PLAYWRIGHT=off`. A value that cannot be read becomes its
  default and one line in the summary.
- **A workflow to copy**, `docs/github-app/workflows/genclass.yml`: on pull requests, `contents: read`, one job that
  is allowed to fail; it installs the project's dependencies with the package manager its lockfile names (from the
  repository root when the working directory has no lockfile, as in a workspace), installs this package and
  `@genclass/runtime@beta` outside the project (the lockfile is untouched, and Playwright stays the project's only
  copy), runs the command and uploads the race files as `genclass-races`. With chaos on, the app's API calls are held
  for a seeded time, so a suite that passes normally can fail there: that is why the job is separate and
  non-blocking.
- **The fixture next to the register entry**: the fixture leaves a page alone when the register entry already covers
  its browser context in the same process (nothing is installed twice; that test runs on the environment's
  options). What a run is (options, names, the file) is one module, `session.ts`, which both entries use.
- **Checked** for the mode without edits: unit tests on fakes of Playwright's objects; real Playwright runs without
  a browser, through the command (with a config Playwright imports and one it requires), preloaded, switched off,
  and interrupted with SIGINT in the middle of a test; a real process forked the way a test forks a helper, in which
  the preloaded entry does nothing; a spec run on the installed Playwright that holds what the entry needs from it
  to tell whose a context is (`test/hook-smoke`); and, in the workflow's Chromium job, the search page of the
  fixture's end-to-end check under a suite that imports only `@playwright/test` (`test/e2e-unmodified`). That last
  one has not run yet: its numbers are added when it has.
- `package.json`: `exports["./register"]`, the `genclass-playwright-run` command, and `sideEffects` names
  `dist/register.js` (importing it is what starts it).
- **A web address in the files' text is not a link in the report**: `://` and `www.` get a zero-width space, like `#`
  and `@` before them, so GitHub links no address from a test name or an evidence line and leaves no "mentioned this"
  on another repository's issue. Operations stay as written, in code spans.
- **The format has limits** (`RACES_LIMITS`): the validator refuses a file with more than 200 signatures, or with a
  string over its length (1,000 characters for `test`, 2,000 for `evidence`, 600 for any other), like any other bad
  field.
- **A signature lists at most 64 seeds** (`RACES_LIMITS.seeds`): the validator refuses a file over it, on the count alone.
- **The fixture writes within them**, and keeps a file to 64 KB: it cuts a longer string (it then ends with `…`), and
  of a test with more signatures than fit it writes the most confident and puts the number left out in a new optional
  field, `dropped`. The report says under that test that its list is not complete.
- **A `location` the validator would refuse is left out by the fixture** (a path over 400 characters, or with a
  backslash or a control character in a name): the file is written without it and validates.
- **Where the test is declared**: the fixture writes an optional `location` (`{ file, line }`) into each race file,
  the test file's path relative to the repository root (`GITHUB_WORKSPACE` on GitHub Actions, else the Playwright
  config's directory) and the line Playwright gives for the test. It is left out when there is no line or the file is
  outside that directory, and a `location` that is not a relative path with a line from 1 rejects the file like any
  other bad field. The report does not use it: it is for genclass-dev[bot], the GitHub App
  (`docs/github-app/README.md`), which reads the uploaded race files and comments on the test's line when the pull
  request's diff shows it. `locationOf` and the `RacesLocation` type are exported with the fixture.
- **The fixture**, `@genclass/playwright/fixture`: Playwright's `test` (`test.extend`) and `expect`, with a
  `genclass` option (`use: { genclass: {...} }`). On every `page` it puts `@genclass/runtime`'s script-tag build
  before the app's first script, in observe mode with telemetry off, the visual checks and the devtools off, and
  serves the runtime's `dist/` from the installed package (or `runtimeDir`) on the page's origin at `/__genclass__/`
  with `page.route`, never from a CDN. The model is skipped by default (`model: "skip"`: no 13 MB download) and the
  file carries the runtime's witnesses, computed without the model through the agent entry connected with every
  hold off (`overwrote-newer`, `identical-in-flight`); `model: "load"` adds the model's detections with their
  confidence (the model's diagnosis probability, from the runtime's `decide` event). At the end of each test it
  writes one `genclass-races/1` file to `genclass` in the project's outputDir (test-results/genclass, emptied by
  Playwright at each run; or `outDir`), named after the test, its id, its seed and, for a retry, the attempt, with
  the seed, the chaos settings and a `fixture` record (the model option, whether the agent entry connected, how many
  requests chaos held, whether a service worker controlled the page, a mode switch it overrode). A test skipped in
  its body writes nothing. The runtime is held to observe: a URL or localStorage switch that raised the mode is set
  back. The agent link gets a stand-in fetch for its own address, so the fixture adds no console error, failed
  request or CSP report to the page. `enabled: false` makes it inert. Peer dependencies only (`@playwright/test`,
  `@genclass/runtime`, both optional: the reporter needs neither); `typesVersions` for `moduleResolution: node`;
  `engines` `^20.19.0 || >=22.12.0` (CommonJS test projects load the ESM-only fixture with require).
- **Seeded chaos** (`chaos: { seed, delayMs, reorder, match }`): with `page.route` each matched request is held for a
  latency derived from the seed and the request's key (method, path, occurrence, assigned when the page sends it),
  then passed on with `route.fallback()`, so it still reaches the test's own routes (`context.route`,
  `routeFromHAR`) and the browser's network stack, with redirects, cookies, CORS and streaming as they are, and a run
  repeats exactly. `reorder: false` sends matched requests in their order, at least 30 ms apart (latency only). Only
  fetch and XHR requests inside `match` (default: same-origin `/api*` or an Accept header asking for JSON, decided
  from the request); never the runtime's own files, documents, scripts or anything outside the filter. Off unless
  given. With `repeatEach`, the repeat index is added to the seed, so two repeats give the report its two seeds.
- **Witnesses in the report**: signatures with trigger `witness` get their own group (shown only when there are
  any), no confidence on the line (a fact that happened, not a probability) and a footer sentence saying what they
  are; they are never counted as duplicate submits or stale responses. Files with a `fixture` record get notes
  for runs the fixture could not check (no witnesses recorded, a service worker in control) and for chaos that held
  no request; a `model: "skip"` file gets no model note. Files without a `fixture` record are reported as before.
- **Measured** (`test/e2e`, run by the workflow in Chromium; six runs of five seeds): on the MCP e2e search page
  (its store on the fixture's runtime through the script-tag mapping) with latency 0 to 600 ms and reordering, the
  buggy page gets `witness:overwrote-newer` on `GET /api/search` in 30 of 30 seeds, the same page with latency only
  in 0 of 30, and the fixed page in 0 of 30; no other signature, console error or failed request anywhere. With
  `model: "load"` (one run by hand, two seeds, before chaos moved to requests) the model loaded through the
  fixture's path and gave no likely detection on that page (`stale` at 0.64 in one seed, below the 0.90 report
  gate; nothing in the other), while the witness was recorded in both.
- First version of the reader side: `@genclass/playwright/reporter` (a Playwright reporter by shape: reads
  `test-results/genclass/*.json` in the `genclass-races/1` format at the end of the run, writes and prints
  `genclass-report.md`), `@genclass/playwright/summarize` (the pure files-to-markdown function, with
  `buildSummary`, `renderMarkdown`, `parseRaces` and `validateRaces`), and the `genclass-playwright-report` command
  for sharded runs. Groups by test and by signature, marks signatures flagged in 2 or more seeds as reproducible,
  lists files that fail validation with the reason, and says nothing about interventions. No runtime dependencies.
- Playwright can load the reporter by name: every export has a `default` condition next to `import`, because
  Playwright resolves a reporter id with CommonJS `require.resolve`, which does not match `import` (before this,
  `reporter: [["@genclass/playwright/reporter"]]` stopped the run with `ERR_PACKAGE_PATH_NOT_EXPORTED`). CI now runs
  a real Playwright run (no browser) that loads it this way.
- `printsToStdio()` is false, so listed alone the reporter no longer stops Playwright from adding its line/dot
  reporter.
- Safe to post on GitHub: `#` before a digit, `GH-` before a digit and `@` before a name get a zero-width space
  (U+200B), so the runtime's request ids (`#15`) do not link the repository's issues and Playwright tags (`@smoke`)
  mention no one. Mode values are escaped like other text from the files.
- `maxChars` (reporter and summariser option, `--max-chars` for the command; default 60000, `0` for no limit) keeps
  the report within one GitHub comment, leaving out list entries, then the least important signatures of each test,
  then whole tests, with a note saying what was left out; the counts include everything.
- The "model was not ready" note is only for files that flagged nothing, and no longer says those runs could not
  flag anything (a file can carry detections with state `unloaded`).
- Docs: the README opens with what the package is and links `@genclass/runtime` on npm; the config example imports
  `defineConfig`; the measured double-submit list names all 14 data layers and the runtime build the matrix ran;
  the privacy note gives the versions that send diagnostics from local hosts (`0.1.0-beta.3` to `0.2.1`); links
  outside the package are absolute, so they work on npm. `homepage` points at the README.
