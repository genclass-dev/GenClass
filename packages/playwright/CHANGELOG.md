# Changelog

Changes to `@genclass/playwright`, the Playwright reporter for
[`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) race files.

## 0.1.0 (2026-11-10)

The first version on npm.

- **A web address in the files' text is not a link in the report**: `://` and `www.` get a zero-width space, like `#`
  and `@` before them, so GitHub links no address from a test name or an evidence line and leaves no "mentioned this"
  on another repository's issue. Operations stay as written, in code spans.
- **The format has limits** (`RACES_LIMITS`): the validator refuses a file with more than 200 signatures, or with a
  string over its length (1,000 characters for `test`, 2,000 for `evidence`, 600 for any other), like any other bad
  field.
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
  outside the package are absolute, so they work on npm. `homepage` points at the README, and the package
  description says the race files come from the GenClass Playwright fixture, which is not released yet.
