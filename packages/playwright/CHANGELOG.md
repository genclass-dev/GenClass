# Changelog

Changes to `@genclass/playwright`, the Playwright reporter for
[`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) race files. Version 0.1.0 is not on npm yet;
everything below is unreleased.

## Unreleased

- **Page errors**: the fixture also hands over the page's uncaught errors and unhandled rejections the agent entry
  records, as `page-error|<name>|<request>` signatures (trigger `page-error`, never the model's `error`), keeping only
  the error's name, its message shape (quoted values as `…`, numbers as `N`: `@genclass/mcp`'s `shape()`, copied,
  with a test that the two agree), the request nearest to it in its causal chain (or `no request`) and whether its
  top stack frame is on the page's origin. Errors from another origin's script (or a browser extension) are left out
  and counted in `fixture.thirdPartyErrors`; one without a stack frame naming a script is kept. The report gives them
  a group, a table row and a footer paragraph of their own, with no confidence; the model's footer paragraph now
  counts the model's groups only. The README's Privacy section says that error message shapes appear in the files.
- **The quiet point**: with chaos on, the fixture first lets the page reach the agent entry's quiet point (at most
  2 s, chaos still on its plan), then collects, then releases what chaos holds; the wait for the page's answer is
  raised above that bound. `fixture.settled` (validated) says whether it settled, and the report notes a test whose
  page had not (never a signature).
- **Systematic orders**: `chaos.order: "systematic"` (default `"random"`) makes the repeat index pick the order:
  repeat 0 natural (nothing held, and no "chaos held no request" note), repeat 1 reverse (bursts of matched requests,
  ending at `windowMs`, default 600, or 100 ms after their latest request, released newest first 30 ms apart, each
  request held at most `windowMs` + 1000 ms), repeat 2 and later the seeded delays of the default. Needs `repeatEach`
  of 3 or more; refused with `reorder: false`. Each file records `chaos.order` and, for the reverse order, its bursts'
  keys and release order (`chaos.bursts`); the report shows the order next to each seed (`2 (reverse)`) and counts
  only the reordering seeds toward Reproducible. The reverse order is repeatable for the same request timing, not on
  the wall clock. No false-report rate is measured for it yet; the default is unchanged. Like all chaos it holds
  requests, never responses (the fixture's agent link still runs with `hold: false`): it is not `@genclass/mcp`'s
  explore plan `systematic`.
- **Measured visual checks**: `visual: true` (default off) turns on the runtime's checks, report only, and runs one
  more pass at the end of the test (at most 2 s); each becomes a `check|<kind>|<route>` signature in a group titled
  as measured checks, with evidence from the kind, the selector and the measured numbers only (never the element's
  text or the console line). Without `dist/visual/index.js` the checks stay off and `fixture.visual` says they did
  not run. A check never hides what the model or the agent entry could not check: the "witnesses not recorded" note
  counts witness, page-error and model signatures, the model's note model and witness signatures.
- Every new row, group, footer paragraph, note and file field appears only when it applies (`fixture.settled`
  whenever chaos is on, page-error signatures when the page threw): the report of files without them is byte for
  byte what it was, and so is the file of a test without chaos, errors or checks.
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
