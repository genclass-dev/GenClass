// The fourth part of the end-to-end check (run.mjs calls it last): a test that fails in some runs and passes in
// others (../e2e-flaky: its config and its spec import only @playwright/test), run through
// `genclass-playwright-run --explain-flaky=16`, in a real browser. It requires:
//
//   - sixteen Playwright runs, one per seed (1 to 16), each announced by the command, and sixteen valid race files,
//     one per seed, in test-results/genclass;
//   - every file carries the test's own status (passed or failed), and the page's steps in order: the typing, two
//     search requests sent and their two answers, and where the test's own code ended;
//   - the test failed in at least three runs and passed in at least three. Which seeds fail follows from the seeds'
//     delays: the first request is held at least 80 ms longer than the second under seeds 1, 6, 9, 11, 14 and 16 (by
//     25 ms to 411 ms), so about six of sixteen fail; how many did is printed;
//   - the command's comparison says every failing run has one order and no passing run has it, and that order is the
//     answer to the 2nd search landing before the answer to the 1st: what the page does wrong, found from the order
//     of responses alone;
//   - in every failing run's file the order is that way round, and in no passing run's (within the test's own code);
//   - the command exits 0 although Playwright failed in some runs, leaves no generated config and prints no
//     "GenClass notes:".
//
// It cannot hang: the command is a child process with a time limit (child.mjs), and each of its Playwright runs has
// the project's own limits (globalTimeout 60 s, a 2 s assertion).

import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSteps } from "../../dist/explain.js";
import { ending, runNode } from "./child.mjs";
import { notesOf, readRaces, removeGenerated, summaryOf } from "./unmodified.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "../e2e-flaky");
const RUNS = 16;
/** Sixteen Playwright runs of a few seconds each, a web server start in every one. */
const RUN_LIMIT_MS = 420_000;
const ORDER = "the response to the 2nd `GET /api/search` came before the response to the 1st `GET /api/search`";

/** Where the answers to the two searches are in a file's steps, among those that landed while the test's code ran: [1st, 2nd] (-1: not there). */
function answers(file) {
  const steps = decodeSteps(file.steps).filter((e) => !e.late);
  return [1, 2].map((n) => steps.findIndex((e) => e.kind === "r" && e.label === "GET /api/search" && e.n === n));
}

export async function runFlaky(summary, fail) {
  const f = (summary.flaky = {});
  const stop = (message) => {
    const removed = removeGenerated(project);
    if (removed.length) f.removedAfterFailure = removed;
    fail(`flaky test: ${message}`);
  };
  rmSync(join(project, "test-results"), { recursive: true, force: true });
  removeGenerated(project);
  const bin = resolve(here, "../../bin/genclass-playwright-run.mjs");
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GENCLASS_") || k === "GENCLASS_RUNTIME_DIR" || k === "GENCLASS_E2E_FLAKY_PORT") base[k] = v;
  const run = await runNode([bin, `--explain-flaky=${RUNS}`], { cwd: project, env: { ...base, CI: "1" }, timeoutMs: RUN_LIMIT_MS });
  const at = run.out.lastIndexOf("\nGenClass: ");
  console.log(run.out.slice(at >= 0 ? at : -3000));
  f.exit = run.status;
  f.ms = run.ms;
  if (run.error || run.timedOut) stop(`the command ended with ${ending(run, RUN_LIMIT_MS)}`);
  if (run.status !== 0) stop(`the command exited with ${run.status}, expected 0 (failing runs are what it compares; its summary: ${summaryOf(run.out)})`);
  const announced = run.out.split("\n").filter((l) => /^GenClass: run \d+ of 16 \(seed \d+\)$/.test(l));
  if (announced.length !== RUNS) stop(`expected ${RUNS} runs announced, found ${announced.length}`);

  let files;
  try {
    files = readRaces(join(project, "test-results", "genclass"));
  } catch (e) {
    stop(e.message);
  }
  f.files = files.length;
  const seeds = files.map((x) => x.file.seed).sort((a, b) => a - b);
  if (seeds.join() !== Array.from({ length: RUNS }, (_, i) => i + 1).join()) stop(`expected one race file per seed 1 to ${RUNS}, found seeds ${seeds.join(", ") || "none"}`);
  const failing = files.filter((x) => x.file.status === "failed");
  const passing = files.filter((x) => x.file.status === "passed");
  f.failed = failing.map((x) => x.file.seed).sort((a, b) => a - b);
  f.passed = passing.length;
  if (failing.length + passing.length !== RUNS) stop(`a file without the test's status, or with another: ${files.map((x) => `${x.file.seed}:${x.file.status}`).join(" ")}`);
  for (const x of files) {
    if (!x.file.steps) stop(`${x.name}: no steps in the file`);
    const steps = decodeSteps(x.file.steps);
    const has = (kind, label) => steps.some((e) => e.kind === kind && e.label === label);
    if (!steps.some((e) => e.kind === "a" && e.label.startsWith("type ")) || !has("s", "GET /api/search") || steps.filter((e) => e.kind === "s" && e.label === "GET /api/search").length !== 2)
      stop(`${x.name}: expected the typing and two searches sent in its steps, found ${x.file.steps.order} with labels ${JSON.stringify(x.file.steps.labels)}`);
    if (x.file.steps.body === undefined) stop(`${x.name}: the file does not say where the test's own code ended`);
    if (steps.filter((e) => e.kind === "r" && e.label === "GET /api/search").length !== 2) stop(`${x.name}: expected the answers to both searches in its steps, found ${x.file.steps.order}`);
  }
  if (failing.length < 3 || passing.length < 3) stop(`the test failed in ${failing.length} and passed in ${passing.length} of ${RUNS} runs; the check needs at least three of each (seeds that failed: ${f.failed.join(", ") || "none"})`);

  // the order the comparison should find, read from the files themselves
  const stale = (x) => {
    const [first, second] = answers(x.file);
    return first >= 0 && second >= 0 && second < first;
  };
  f.failingWithTheOrder = failing.filter(stale).length;
  f.passingWithTheOrder = passing.filter(stale).map((x) => x.file.seed);
  if (f.failingWithTheOrder !== failing.length) stop(`${failing.length - f.failingWithTheOrder} failing runs do not have the answer to the 2nd search before the answer to the 1st`);
  if (f.passingWithTheOrder.length) stop(`passing runs with the answer to the 2nd search before the answer to the 1st, within the test's own code: seeds ${f.passingWithTheOrder.join(", ")}`);

  const wanted = [
    `GenClass: ${RUNS} runs, each a Playwright run of its own (seeds 1 to ${RUNS}): ${RUNS} race files in test-results/genclass (1 test).`,
    `· failed in ${failing.length} of ${RUNS} runs (under the delays)`,
    `Compared ${failing.length} failing runs with ${passing.length} passing runs: every failing run has this order of steps, and no passing run does.`,
    `1. In ${failing.length} of ${failing.length} failing runs and in none of the `,
    ORDER,
  ];
  for (const line of wanted) if (!run.out.includes(line)) stop(`the command did not print "${line}" (its summary: ${summaryOf(run.out)})`);
  f.said = run.out.split("\n").find((l) => l.includes(ORDER))?.trim();
  const notes = notesOf(run.out);
  if (notes.length) stop(`the register entry remembered ${notes.length} line(s): ${notes.join(" | ")}`);
  const left = removeGenerated(project);
  if (left.length) stop(`a generated config was left in the project: ${left.join(", ")}`);
  if (!existsSync(join(project, "playwright.config.ts"))) stop("the project's own config is gone");
}
