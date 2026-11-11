// End-to-end: the fixture on a real page in headless Chromium (playwright-reporter.yml runs it after building
// @genclass/runtime and this package). It runs Playwright with ./playwright.config.ts (the search page of server.mjs,
// the fixture with seeded chaos, five seeds per test, this package's reporter), then checks what was written:
//   - the buggy page: a `witness|overwrote-newer|GET /api/search` signature in at least one of the five seeds (the
//     count is printed: a race shows under some orders, not all) and no other signature;
//   - the buggy page with `reorder: false` (latency only, responses keep their order): no signature in any seed,
//     since nothing overtakes;
//   - the fixed page: no signature at all in any of the five seeds (the false-report count on the correct variant);
//   - every file validates as genclass-races/1 and carries the seed, the chaos settings and a fixture record saying
//     the agent connected and chaos held requests;
//   - (in search.spec.ts) no page logged a console error or had a failed request;
//   - genclass-report.md names the buggy test under the witness group and lists the fixed test under "nothing
//     flagged"; the command renders the same report from the same files.
// Then the same page under a suite nobody edited (../e2e-unmodified, which imports only @playwright/test), run through
// the command genclass-playwright-run: unmodified.mjs has what that half does and requires (the witness on the buggy
// page in at least one of two seeds, nothing on the fixed page and nothing in the latency-only run).
// Then tests that stop at their first matching assertion (../e2e-early): early.mjs has what that part requires (with the
// fixture's end-of-test wait, the witness on the buggy page in at least one of six seeds and nothing on the fixed page).
// Then a test that fails in some runs (../e2e-flaky), through `genclass-playwright-run --explain-flaky`: flaky.mjs has
// what that part requires (the comparison of its failing and passing runs names the two answers that came in the
// wrong order).
// Exit code 0 when all hold; the summary is printed as JSON, also when something does not (`failed` then says what
// was expected and what was found).
//
// It cannot hang: Playwright runs as a child process with a time limit (child.mjs: RUN_LIMIT_MS, then SIGTERM, then
// SIGKILL), and inside it the config sets a globalTimeout, a test timeout and a web server timeout.
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/playwright
//   node packages/playwright/test/e2e/run.mjs

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSteps } from "../../dist/explain.js";
import { parseRaces, summarize } from "../../dist/summarize.js";
import { ending, runNode } from "./child.mjs";
import { runEarly } from "./early.mjs";
import { runFlaky } from "./flaky.mjs";
import { runUnmodified } from "./unmodified.mjs";

/** The longest the fixture's Playwright run may take, in ms (fifteen tests of a few seconds each). */
const RUN_LIMIT_MS = 300_000;

const here = dirname(fileURLToPath(import.meta.url));
const racesDir = join(here, "test-results", "genclass");
const reportPath = join(here, "genclass-report.md");
const summary = {};
const fail = (msg) => {
  summary.failed = msg;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
};

for (const p of [join(here, "test-results"), reportPath]) rmSync(p, { recursive: true, force: true });
if (!existsSync(resolve(here, "../../../runtime/dist/genclass.global.js"))) fail("build @genclass/runtime first");
if (!existsSync(resolve(here, "../../dist/fixture.js"))) fail("build @genclass/playwright first");

const cli = resolve(here, "../../../../node_modules/@playwright/test/cli.js");
const run = await runNode([cli, "test", "--config", join(here, "playwright.config.ts")], { cwd: here, env: { ...process.env, CI: "1" }, timeoutMs: RUN_LIMIT_MS });
console.log(run.out.slice(-4000));
summary.playwrightStatus = run.status;
summary.playwrightMs = run.ms;
if (run.error || run.timedOut || run.status !== 0) fail(`the Playwright run of the fixture's suite ended with ${ending(run, RUN_LIMIT_MS)}, expected exit code 0 (its output is above)`);

// the files
const names = existsSync(racesDir) ? readdirSync(racesDir).filter((n) => n.endsWith(".json")).sort() : [];
summary.files = names.length;
if (names.length !== 15) fail(`expected 15 race files (3 tests × 5 seeds), found ${names.length}`);
const files = [];
for (const n of names) {
  const r = parseRaces(readFileSync(join(racesDir, n), "utf8"));
  if (!r.ok) fail(`${n} does not validate: ${r.errors.join("; ")}`);
  files.push({ name: n, file: r.file });
}
const buggy = files.filter((f) => f.file.test.includes("buggy page: results"));
const fifo = files.filter((f) => f.file.test.includes("buggy page, latency only"));
const fixed = files.filter((f) => f.file.test.includes("fixed page"));
if (buggy.length !== 5 || fifo.length !== 5 || fixed.length !== 5) fail(`expected 5 files per test, found buggy ${buggy.length}, latency-only ${fifo.length}, fixed ${fixed.length}`);
const seedsOf = (list) => list.map((f) => f.file.seed).sort((a, b) => a - b);
summary.seeds = { buggy: seedsOf(buggy), latencyOnly: seedsOf(fifo), fixed: seedsOf(fixed) };
for (const [test, s] of Object.entries(summary.seeds)) if (s.join() !== "1,2,3,4,5") fail(`expected seeds 1 to 5 for each test, found ${s.join(", ")} for ${test}`);
for (const f of files) {
  const reorder = !fifo.includes(f);
  if (!f.file.chaos || !f.file.chaos.latencyMs || f.file.chaos.latencyMs[0] !== 0 || f.file.chaos.latencyMs[1] !== 600 || f.file.chaos.reorder !== reorder) fail(`${f.name}: chaos settings missing or wrong: ${JSON.stringify(f.file.chaos)}`);
  if (f.file.mode !== "observe") fail(`${f.name}: mode ${f.file.mode}, expected observe`);
  if (!f.file.model || f.file.model.state !== "off") fail(`${f.name}: model ${JSON.stringify(f.file.model)}, expected state "off" (model skipped)`);
  const fx = f.file.fixture;
  if (!fx || fx.model !== "skip" || fx.agent !== null || fx.serviceWorker !== false || !(fx.chaosApplied > 0)) fail(`${f.name}: fixture record ${JSON.stringify(fx)}, expected the agent connected and chaos applied`);
  // the test's own status, and the page's steps in order: one typing burst, five searches sent, their answers
  if (f.file.status !== "passed") fail(`${f.name}: status ${JSON.stringify(f.file.status)}, expected "passed"`);
  const steps = f.file.steps ? decodeSteps(f.file.steps) : [];
  const of = (kind) => steps.filter((e) => e.kind === kind && (kind === "a" || e.label === "GET /api/search"));
  if (of("a").length < 1 || of("s").length !== 5 || of("r").length !== 5 || of("s").map((e) => e.n).join() !== "1,2,3,4,5")
    fail(`${f.name}: expected the typing, five searches sent (numbered 1 to 5) and their five answers in the file's steps, found ${JSON.stringify(f.file.steps)}`);
  if (f.file.steps.body === undefined || f.file.steps.cut !== undefined) fail(`${f.name}: steps without the end of the test's code, or cut: ${JSON.stringify({ body: f.file.steps.body, cut: f.file.steps.cut })}`);
}
summary.steps = { perFile: files.map((f) => decodeSteps(f.file.steps).length).sort((a, b) => a - b), bytes: Math.max(...files.map((f) => JSON.stringify(f.file.steps).length)) };
const SIG = "witness|overwrote-newer|GET /api/search";
const stale = (f) => f.file.signatures.some((s) => s.sig === SIG);
const sigs = (list) => list.flatMap((f) => f.file.signatures.map((s) => `seed ${f.file.seed}: ${s.sig}`));
summary.buggy = { staleSeeds: buggy.filter(stale).map((f) => f.file.seed), otherSignatures: sigs(buggy).filter((s) => !s.endsWith(SIG)), evidence: buggy.filter(stale).map((f) => f.file.signatures.find((s) => s.sig === SIG).evidence) };
summary.latencyOnly = { signatures: sigs(fifo) };
summary.fixed = { signatures: sigs(fixed) };
if (summary.buggy.staleSeeds.length === 0) fail(`no overwrote-newer witness on the buggy page in any seed (expected ${SIG} in at least 1 of 5 seeds; the buggy page's files hold ${sigs(buggy).join(", ") || "no signature"})`);
if (summary.buggy.otherSignatures.length !== 0) fail(`other signatures on the buggy page: ${summary.buggy.otherSignatures.join(", ")}`);
if (summary.latencyOnly.signatures.length !== 0) fail(`signatures on the buggy page with reorder off (latency keeps the order, so nothing should overtake): ${summary.latencyOnly.signatures.join(", ")}`);
if (summary.fixed.signatures.length !== 0) fail(`signatures on the fixed page (false reports): ${summary.fixed.signatures.join(", ")}`);

// the report
if (!existsSync(reportPath)) fail("the reporter wrote no genclass-report.md");
const report = readFileSync(reportPath, "utf8");
const expected = summarize(names.map((n) => ({ name: `test-results/genclass/${n}`, content: readFileSync(join(racesDir, n), "utf8") })), { sources: ["test-results/genclass"] });
if (report !== expected) fail("genclass-report.md differs from the command's rendering of the same files");
if (!report.includes("| Witnesses (facts measured without the model) |")) fail("the report has no witness row");
if (!report.includes("search.spec.ts > search > buggy page: results of the last query")) fail("the report does not name the buggy test");
if (!/`GET \/api\/search` · `witness:overwrote-newer`/.test(report)) fail("the report has no overwrote-newer line for GET /api/search");
if (!report.includes("2 tests with nothing flagged") || !report.includes("fixed page: results of the last query (5 seeds: 1, 2, 3, 4, 5)")) fail("the report does not list the fixed test under nothing flagged");
if (report.includes("model was not ready")) fail("the report notes a model that was not ready (the model was off by choice)");
summary.reportFirstLines = report.split("\n").slice(0, 4);

// the same page, a suite nobody edited, through genclass-playwright-run
await runUnmodified(summary, fail);

// tests that stop at their first matching assertion: the fixture's wait at the end of a test
await runEarly(summary, fail);

// a test that fails in some runs: its failing runs against its passing ones, through --explain-flaky
await runFlaky(summary, fail);

summary.ok = true;
console.log(JSON.stringify(summary, null, 2));
