// The second half of the end-to-end check (run.mjs calls it after the fixture's half): the same search page, tested
// by a suite nobody edited (../e2e-unmodified: its config and its spec import only @playwright/test), run through the
// command `genclass-playwright-run`. It requires of that path what run.mjs requires of the fixture:
//
//   run 1, latency only   GENCLASS_CHAOS_REORDER=off GENCLASS_OUT_DIR=races-latency-only  <command> --grep "buggy page"
//     - Playwright passes; two race files (seeds 1 and 2, the command's own --repeat-each 2) in races-latency-only;
//     - each says chaos 0 to 600 ms with reorder false, held requests, the agent connected; no signature in either:
//       requests that leave in order come back in order, so nothing overtakes.
//   run 2, the defaults   <command>
//     - Playwright passes; four race files in test-results/genclass (the default, under the working directory):
//       the buggy page and the fixed page, seeds 1 and 2 each;
//     - each says chaos 0 to 600 ms with reorder true, held requests, the agent connected, mode observe, the model
//       off, and where the test is declared (search.spec.ts and a line);
//     - the buggy page has `witness|overwrote-newer|GET /api/search` in at least one of its two seeds and no other
//       signature; the fixed page has no signature in either seed (the false-report count on the correct variant);
//     - the command printed where the files are, the witness's line, and "1 reproducible" when it is in both seeds.
//   after each run: the generated config is gone from the project's directory: nothing is there but the project's two
//   files, Playwright's test-results and the latency-only race files; and the command printed no "GenClass notes:"
//   (the register entry remembers a line whenever it could not do its work on a context: none is expected here).
//
// If the register entry did nothing, this fails twice over: no race file is written, and the page itself throws
// (server.mjs maps the app's runtime import to window.GenClass, which only the entry puts there).
//
// It cannot hang: each of the two runs is a child process with a time limit (child.mjs: RUN_LIMIT_MS, then SIGTERM,
// then SIGKILL), inside it Playwright has its own limits (the project's globalTimeout, test timeout and web server
// timeout), and the register entry caps its own waits (15 s on a new context, 2 s on a page at close). A config the
// command generated is never left in the tree: one left by an earlier, killed run of this check is removed before
// the first run, one left by a run of this check is reported as a failure and then removed.
//
// The spec itself requires that no page logged a console error or had a failed request. Run 1 comes first because
// Playwright empties its outputDir (test-results) when a run starts: this way both sets of files are still there at
// the end for whoever reads a failed run.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRaces } from "../../dist/summarize.js";
import { ending, runNode } from "./child.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const project = resolve(here, "../e2e-unmodified");
export const SIG = "witness|overwrote-newer|GET /api/search";
const LATENCY_DIR = "races-latency-only";
/** The longest one run through the command may take, in ms (two to four tests of a few seconds each, a browser start, a web server start). */
export const RUN_LIMIT_MS = 180_000;

/** The race files of a directory, validated: [{ name, file }]. Throws with the reason when one does not validate. */
export function readRaces(dir) {
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : [];
  return names.map((name) => {
    const r = parseRaces(readFileSync(join(dir, name), "utf8"));
    if (!r.ok) throw new Error(`${name} does not validate: ${r.errors.join("; ")}`);
    return { name, file: r.file };
  });
}

/** What every file of this check must say about its run. Throws with the first thing that is wrong. */
export function checkFile(f, reorder) {
  const c = f.file.chaos;
  if (!c || !c.latencyMs || c.latencyMs[0] !== 0 || c.latencyMs[1] !== 600 || c.reorder !== reorder) throw new Error(`${f.name}: chaos settings missing or wrong: ${JSON.stringify(c)} (expected latency 0 to 600 ms, reorder ${reorder})`);
  if (f.file.mode !== "observe") throw new Error(`${f.name}: mode ${f.file.mode}, expected observe`);
  if (!f.file.model || f.file.model.state !== "off") throw new Error(`${f.name}: model ${JSON.stringify(f.file.model)}, expected state "off" (model skipped)`);
  const fx = f.file.fixture;
  if (!fx || fx.model !== "skip" || fx.agent !== null || fx.serviceWorker !== false || !(fx.chaosApplied > 0)) throw new Error(`${f.name}: fixture record ${JSON.stringify(fx)}, expected the agent connected and chaos applied`);
  const l = f.file.location;
  if (!l || !l.file.endsWith("search.spec.ts") || !(l.line >= 1)) throw new Error(`${f.name}: location ${JSON.stringify(l)}, expected search.spec.ts and a line`);
}

const seedsOf = (list) => list.map((f) => f.file.seed).sort((a, b) => a - b);
const sigs = (list) => list.flatMap((f) => f.file.signatures.map((s) => `seed ${f.file.seed}: ${s.sig}`));

/** Checks the files of the latency-only run. Returns what it found; throws with what is wrong. */
export function checkLatencyOnly(files) {
  const out = { files: files.length, seeds: seedsOf(files), signatures: sigs(files) };
  if (files.length !== 2 || !files.every((f) => f.file.test.includes("buggy page: results"))) throw new Error(`latency only: expected 2 race files of the buggy page (1 test × 2 seeds), found ${files.map((f) => f.name).join(", ") || "none"}`);
  if (out.seeds.join() !== "1,2") throw new Error(`latency only: expected seeds 1 and 2, found ${out.seeds.join(", ")}`);
  for (const f of files) checkFile(f, false);
  if (out.signatures.length !== 0) throw new Error(`latency only: signatures on the buggy page with reorder off (latency keeps the order, so nothing should overtake): ${out.signatures.join(", ")}`);
  return out;
}

/** Checks the files of the run on the defaults. Returns what it found; throws with what is wrong. */
export function checkDefaults(files) {
  const buggy = files.filter((f) => f.file.test.includes("buggy page: results"));
  const fixed = files.filter((f) => f.file.test.includes("fixed page: results"));
  const stale = (f) => f.file.signatures.some((s) => s.sig === SIG);
  const out = {
    files: files.length,
    seeds: { buggy: seedsOf(buggy), fixed: seedsOf(fixed) },
    buggy: { staleSeeds: buggy.filter(stale).map((f) => f.file.seed), otherSignatures: sigs(buggy).filter((s) => !s.endsWith(SIG)), evidence: buggy.filter(stale).map((f) => f.file.signatures.find((s) => s.sig === SIG).evidence) },
    fixed: { signatures: sigs(fixed) },
    tests: [...new Set(files.map((f) => f.file.test))].sort(),
    locations: [...new Set(files.map((f) => (f.file.location ? `${f.file.location.file}:${f.file.location.line}` : "none")))].sort(),
  };
  if (files.length !== 4 || buggy.length !== 2 || fixed.length !== 2) throw new Error(`defaults: expected 4 race files (2 tests × 2 seeds), found buggy ${buggy.length}, fixed ${fixed.length} of ${files.length}: ${files.map((f) => f.name).join(", ") || "none"}`);
  for (const s of Object.values(out.seeds)) if (s.join() !== "1,2") throw new Error(`defaults: expected seeds 1 and 2 for each test, found buggy ${out.seeds.buggy.join(", ")}, fixed ${out.seeds.fixed.join(", ")}`);
  for (const f of files) checkFile(f, true);
  if (out.buggy.staleSeeds.length === 0) throw new Error(`defaults: no overwrote-newer witness on the buggy page in either seed (expected ${SIG} in at least 1 of 2 seeds; the buggy page's files hold ${sigs(buggy).join(", ") || "no signature"})`);
  if (out.buggy.otherSignatures.length !== 0) throw new Error(`defaults: other signatures on the buggy page: ${out.buggy.otherSignatures.join(", ")}`);
  if (out.fixed.signatures.length !== 0) throw new Error(`defaults: signatures on the fixed page (false reports): ${out.fixed.signatures.join(", ")}`);
  return out;
}

/** What is left in the project's directory besides the project and Playwright's output (a generated config, say). */
export function leftovers(dir = project) {
  const expected = new Set(["playwright.config.ts", "search.spec.ts", "test-results", LATENCY_DIR]);
  return readdirSync(dir).filter((n) => !expected.has(n) && !n.startsWith(".")).sort();
}

/** Removes the configs genclass-playwright-run generated in the directory ("<config>.genclass-<id>.mjs") and returns their names. */
export function removeGenerated(dir = project) {
  const names = readdirSync(dir).filter((n) => /\.genclass-[A-Za-z0-9]+\.mjs$/.test(n)).sort();
  for (const n of names) rmSync(join(dir, n), { force: true });
  return names;
}

/** The lines of the command's own summary in its output ("GenClass: ..." and what is indented under it), for a failure message. */
export function summaryOf(out) {
  const lines = out.split("\n");
  const at = lines.findIndex((l) => l.startsWith("GenClass"));
  return at < 0 ? "no line starting with GenClass" : lines.slice(at).filter((l) => l.trim()).join(" / ");
}

/** The lines the register entry remembered, as the command printed them under "GenClass notes:" (none when all went well). */
export function notesOf(out) {
  const lines = out.split("\n");
  const at = lines.indexOf("GenClass notes:");
  if (at < 0) return [];
  const notes = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith("  - ")) break;
    notes.push(l.slice(4));
  }
  return notes;
}

/** The lines the command must print for the latency-only run (parts of its summary, src/run.ts runSummary). */
export function latencyLines() {
  return [`GenClass: 2 race files in ${LATENCY_DIR} (1 test): 0 signatures in 0 tests, 0 reproducible`];
}

/** The lines the command must print for the run on the defaults, with the witness in `n` of the two seeds. */
export function defaultsLines(n) {
  return [`GenClass: 4 race files in test-results/genclass (2 tests): 1 signature in 1 test, ${n === 2 ? 1 : 0} reproducible`, `    witness:overwrote-newer · GET /api/search · ${n} of 2 seeds`];
}

async function command(args, env) {
  const bin = resolve(here, "../../bin/genclass-playwright-run.mjs");
  // this check's own settings only: nothing of GenClass from the environment the check was started in, except where
  // the runtime's build is (for a checkout whose node_modules points at another one)
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GENCLASS_") || k === "GENCLASS_RUNTIME_DIR" || k === "GENCLASS_E2E_UNMODIFIED_PORT") base[k] = v;
  const run = await runNode([bin, ...args], { cwd: project, env: { ...base, CI: "1", ...env }, timeoutMs: RUN_LIMIT_MS });
  console.log(run.out.slice(-4000));
  return run;
}

/**
 * Runs the unmodified suite through the command, twice, and checks what was written. `summary.unmodified` gets what
 * was found as it goes (so a failed run still says how far it got); `fail(message)` is called with the first thing
 * that is wrong and does not return. Whatever happens, no generated config is left in the project's directory.
 */
export async function runUnmodified(summary, fail) {
  const u = (summary.unmodified = {});
  const stop = (message) => {
    const removed = removeGenerated();
    if (removed.length) u.removedAfterFailure = removed;
    fail(`unmodified suite${message}`);
  };
  for (const p of [join(project, "test-results"), join(project, LATENCY_DIR)]) rmSync(p, { recursive: true, force: true });
  // a config an earlier run of this check left when it was killed is not this run's
  const stale = removeGenerated();
  if (stale.length) u.removedBefore = stale;
  if (!existsSync(resolve(here, "../../dist/register.js")) || !existsSync(resolve(here, "../../dist/run.js"))) stop(": build @genclass/playwright first (dist/register.js and dist/run.js)");
  if (leftovers().length) stop(`: unexpected files in ${project} before the run: ${leftovers().join(", ")} (expected only playwright.config.ts and search.spec.ts)`);

  /** What every run through the command must have done, whatever its settings. */
  const ran = (name, run) => {
    if (run.error || run.timedOut || run.status !== 0) stop(`, ${name}: the run through genclass-playwright-run ended with ${ending(run, RUN_LIMIT_MS)}, expected exit code 0 (its output is above; its summary: ${summaryOf(run.out)})`);
    const notes = notesOf(run.out);
    if (notes.length) stop(`, ${name}: the register entry remembered ${notes.length} line${notes.length === 1 ? "" : "s"}, expected none: ${notes.join(" | ")}`);
  };
  const printed = (name, run, lines) => {
    for (const line of lines) if (!run.out.includes(line)) stop(`, ${name}: the command did not print "${line}"; it printed: ${summaryOf(run.out)}`);
  };
  const clean = (name) => {
    if (leftovers().length) stop(`, ${name}: left behind in ${project}: ${leftovers().join(", ")} (expected nothing but the project's two files, test-results and ${LATENCY_DIR})`);
  };

  // run 1: latency only, on the buggy page
  const latency = await command(["--grep", "buggy page"], { GENCLASS_CHAOS_REORDER: "off", GENCLASS_OUT_DIR: LATENCY_DIR });
  u.latencyOnly = { playwrightStatus: latency.status, ms: latency.ms };
  ran("latency only", latency);
  try {
    Object.assign(u.latencyOnly, checkLatencyOnly(readRaces(join(project, LATENCY_DIR))));
  } catch (e) {
    stop(`, ${e.message}`);
  }
  printed("latency only", latency, latencyLines());
  clean("latency only");

  // run 2: the command's defaults (chaos on with reordering, two seeds, test-results/genclass)
  const defaults = await command([], {});
  u.defaults = { playwrightStatus: defaults.status, ms: defaults.ms };
  ran("defaults", defaults);
  try {
    Object.assign(u.defaults, checkDefaults(readRaces(join(project, "test-results", "genclass"))));
  } catch (e) {
    stop(`, ${e.message}`);
  }
  printed("defaults", defaults, defaultsLines(u.defaults.buggy.staleSeeds.length));
  clean("defaults");
  // the latency-only files are still there (they are outside Playwright's outputDir)
  const kept = readRaces(join(project, LATENCY_DIR)).length;
  if (kept !== 2) stop(`: expected the 2 latency-only race files to be there after the second run, found ${kept}`);
  u.ok = true;
}
