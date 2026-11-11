// The third part of the end-to-end check (run.mjs calls it last): tests that stop at their first matching assertion
// (../e2e-early), with the fixture's wait at the end of a test on (the default) and, for comparison, off.
//
//   run 1, the default   playwright test --config ../e2e-early/playwright.config.ts
//     - Playwright passes; twelve race files in ../e2e-early/test-results/genclass (two tests, seeds 1 to 6), each
//       valid, with chaos applied and the agent connected;
//     - the buggy page has `witness|overwrote-newer|GET /api/search` in at least one seed and no other signature:
//       the answers that landed after the test's last assertion were seen;
//     - the fixed page has no signature in any seed (the false-report count on the correct variant).
//   run 2, the wait off  GENCLASS_E2E_EARLY_WAIT=0 ... (race files in ../e2e-early/races-no-wait)
//     - Playwright passes, twelve valid files, and nothing on the fixed page. How many seeds of the buggy page have the
//       witness is printed next to run 1's count and not required: without the wait it depends on which answers happen
//       to land before the last assertion.
//
// It cannot hang: each run is a child process with a time limit (child.mjs), and Playwright has its own inside it.

import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ending, runNode } from "./child.mjs";
import { SIG, readRaces } from "./unmodified.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "../e2e-early");
const RUN_LIMIT_MS = 240_000;
const cli = resolve(here, "../../../../node_modules/@playwright/test/cli.js");

function check(files, label) {
  const buggy = files.filter((f) => f.file.test.includes("buggy page: stops"));
  const fixed = files.filter((f) => f.file.test.includes("fixed page: stops"));
  if (files.length !== 12 || buggy.length !== 6 || fixed.length !== 6) throw new Error(`${label}: expected 12 race files (2 tests × 6 seeds), found buggy ${buggy.length}, fixed ${fixed.length} of ${files.length}`);
  for (const f of files) {
    const fx = f.file.fixture;
    if (!fx || fx.agent !== null || !(fx.chaosApplied > 0)) throw new Error(`${label}: ${f.name}: fixture record ${JSON.stringify(fx)}, expected the agent connected and chaos applied`);
  }
  const stale = (f) => f.file.signatures.some((s) => s.sig === SIG);
  const sigs = (list) => list.flatMap((f) => f.file.signatures.map((s) => `seed ${f.file.seed}: ${s.sig}`));
  const out = { staleSeeds: buggy.filter(stale).map((f) => f.file.seed).sort((a, b) => a - b), otherSignatures: sigs(buggy).filter((s) => !s.endsWith(SIG)), fixedSignatures: sigs(fixed) };
  if (out.otherSignatures.length !== 0) throw new Error(`${label}: other signatures on the buggy page: ${out.otherSignatures.join(", ")}`);
  if (out.fixedSignatures.length !== 0) throw new Error(`${label}: signatures on the fixed page (false reports): ${out.fixedSignatures.join(", ")}`);
  return out;
}

export async function runEarly(summary, fail) {
  summary.early = {};
  for (const p of [join(project, "test-results"), join(project, "races-no-wait")]) rmSync(p, { recursive: true, force: true });
  for (const [label, env, dir] of [
    ["wait", {}, join(project, "test-results", "genclass")],
    ["noWait", { GENCLASS_E2E_EARLY_WAIT: "0" }, join(project, "races-no-wait")],
  ]) {
    const run = await runNode([cli, "test", "--config", join(project, "playwright.config.ts")], { cwd: project, env: { ...process.env, CI: "1", ...env }, timeoutMs: RUN_LIMIT_MS });
    console.log(run.out.slice(-1500));
    if (run.error || run.timedOut || run.status !== 0) fail(`ends early (${label}): the Playwright run ended with ${ending(run, RUN_LIMIT_MS)}, expected exit code 0 (its output is above)`);
    try {
      summary.early[label] = { playwrightMs: run.ms, ...check(readRaces(dir), label) };
    } catch (e) {
      fail(`ends early: ${e.message}`);
    }
  }
  if (summary.early.wait.staleSeeds.length === 0) fail(`ends early: with the wait on, no overwrote-newer witness on the buggy page in any of six seeds (expected ${SIG} in at least 1: the answers still in flight at the end of the test were not seen)`);
  summary.early.ok = true;
}
