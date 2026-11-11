#!/usr/bin/env node
// The pull-request evidence bench: what genclass-dev[bot] would have to read for a repository whose Playwright suite
// nobody edited, measured on compat's React app (six data layers, eight scenarios, a seeded mock backend and an oracle
// that reads only the DOM and the server's state). compat's apps are not written for GenClass and are never changed
// for it; nothing in packages/ was fitted to them (bench/pr-evidence/README.md says how changes were chosen).
//
// For each setting it runs the same spec (specs/compat.spec.mjs) three ways:
//   plain   Playwright alone: how often the oracle sees a bug without GenClass, and the wall-clock time to compare with
//   off     through genclass-playwright-run with GENCLASS_CHAOS=off: the runtime on the page, no request held
//   on      the same with the seeded chaos on (the command's default)
// and joins, per layer, scenario and seed, the oracle's verdict with the signatures in that test's race file.
//
//   node bench/pr-evidence/setup.mjs                       once: builds the app
//   node bench/pr-evidence/run.mjs --seeds 6               all three, the local build of both packages
//   node bench/pr-evidence/run.mjs --runner <path to genclass-playwright-run.mjs> --runtime-dir <dist> --label npm-0.1.0
//
// Flags: --seeds N (default 6)  --workers N (3)  --modes plain,off,on  --layers a,b  --scenarios a,b
//        --runner <file> (default packages/playwright/bin/genclass-playwright-run.mjs)
//        --runtime-dir <dir> (default packages/runtime/dist)  --label <name> (default "local")  --out <file.json>
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const SEEDS = Number(opt("seeds", "6"));
const WORKERS = Number(opt("workers", "3"));
const MODES = opt("modes", "plain,off,on").split(",").filter(Boolean);
const LABEL = opt("label", "local");
const RUNNER = resolve(opt("runner", join(REPO, "packages", "playwright", "bin", "genclass-playwright-run.mjs")));
const RUNTIME_DIR = resolve(opt("runtime-dir", join(REPO, "packages", "runtime", "dist")));
const OUT = resolve(opt("out", join(HERE, "results", `${LABEL}.json`)));
const WORK = join(HERE, ".work", "runs", LABEL);
const LEGIT = ["c", "d", "e", "f", "g", "h"];

function versionNear(file, name) {
  try {
    let dir = dirname(file);
    for (let i = 0; i < 6; i++, dir = dirname(dir)) {
      const p = join(dir, "package.json");
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, "utf8"));
        if (j.name === name) return j.version;
      }
    }
  } catch {
    /* unknown */
  }
  return null;
}

function runMode(mode) {
  const dir = join(WORK, mode);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    BENCH_VERDICT_DIR: join(dir, "verdicts"),
    BENCH_WORKERS: String(WORKERS),
    ...(opt("layers", null) ? { BENCH_LAYERS: opt("layers") } : {}),
    ...(opt("scenarios", null) ? { BENCH_SCENARIOS: opt("scenarios") } : {}),
  };
  const args = ["--config", "playwright.config.mjs", "--repeat-each", String(SEEDS)];
  let cmd;
  if (mode === "plain") {
    const cli = createRequire(join(HERE, "noop.js")).resolve("@playwright/test/cli");
    cmd = [process.execPath, [cli, "test", ...args]];
  } else {
    env.GENCLASS_CHAOS = mode === "on" ? "on" : "off";
    env.GENCLASS_OUT_DIR = join(dir, "races");
    env.GENCLASS_RUNTIME_DIR = RUNTIME_DIR;
    cmd = [process.execPath, [RUNNER, ...args]];
  }
  const t0 = Date.now();
  const r = spawnSync(cmd[0], cmd[1], { cwd: HERE, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  writeFileSync(join(dir, "output.log"), `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  const summary = (r.stdout ?? "").split("\n").filter((l) => /^\s+\d+ (passed|failed|flaky|skipped|did not run)/.test(l) || /^GenClass( notes)?:/.test(l)).map((l) => l.trim());
  return { mode, seconds, exit: r.status, summary, dir };
}

const readJsonDir = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : []);

function analyse(run) {
  const verdicts = readJsonDir(join(run.dir, "verdicts"));
  const races = new Map();
  for (const f of readJsonDir(join(run.dir, "races"))) {
    const parts = String(f.test ?? "").split(" > ");
    // "compat.spec.mjs > <layer> > <scenario> > <name>"
    races.set(`${parts[1]}|${parts[2]}|${f.seed}`, f);
  }
  const cells = new Map();
  const cell = (layer, scenario) => {
    const k = `${layer}|${scenario}`;
    if (!cells.has(k)) cells.set(k, { layer, scenario, trials: 0, errors: 0, bug: 0, flagged: 0, bugFlagged: 0, noFile: 0, agentDown: 0, sigs: {} });
    return cells.get(k);
  };
  for (const v of verdicts) {
    const c = cell(v.layer, v.scenario);
    c.trials++;
    if (!v.ok) c.errors++;
    const bug = typeof v.bug === "string";
    if (bug) c.bug++;
    if (run.mode === "plain") continue;
    const f = races.get(`${v.layer}|${v.scenario}|${v.seed}`);
    if (!f) {
      c.noFile++;
      continue;
    }
    if (f.fixture?.agent !== null) c.agentDown++;
    const sigs = (f.signatures ?? []).map((s) => s.sig);
    if (sigs.length) {
      c.flagged++;
      if (bug) c.bugFlagged++;
    }
    for (const s of sigs) (c.sigs[s] ??= []).push(v.seed);
  }
  return [...cells.values()].sort((x, y) => (x.layer + x.scenario).localeCompare(y.layer + y.scenario));
}

const result = {
  label: LABEL,
  date: new Date().toISOString().slice(0, 10),
  seeds: SEEDS,
  workers: WORKERS,
  runner: RUNNER.startsWith(REPO) ? RUNNER.slice(REPO.length + 1) : RUNNER,
  playwrightPackage: versionNear(RUNNER, "@genclass/playwright"),
  runtimePackage: versionNear(join(RUNTIME_DIR, "x"), "@genclass/runtime"),
  node: process.version,
  runs: [],
};
for (const mode of MODES) {
  process.stdout.write(`${LABEL}: ${mode} ... `);
  const run = runMode(mode);
  const cells = analyse(run);
  const sum = (f) => cells.reduce((n, c) => n + f(c), 0);
  const legit = cells.filter((c) => LEGIT.includes(c.scenario));
  const totals = {
    trials: sum((c) => c.trials),
    errors: sum((c) => c.errors),
    oracleBugs: sum((c) => c.bug),
    noFile: sum((c) => c.noFile),
    agentDown: sum((c) => c.agentDown),
    legitTrials: legit.reduce((n, c) => n + c.trials, 0),
    legitFlagged: legit.reduce((n, c) => n + c.flagged, 0),
    legitOracleBugs: legit.reduce((n, c) => n + c.bug, 0),
  };
  result.runs.push({ mode: run.mode, seconds: run.seconds, exit: run.exit, summary: run.summary, totals, cells });
  console.log(`${run.seconds}s, ${totals.trials} trials, ${totals.errors} errors`);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 1) + "\n");

// a short table on the terminal: per mode and scenario, across the layers
for (const run of result.runs) {
  console.log(`\n== ${LABEL} / ${run.mode}: ${run.seconds}s ==`);
  for (const l of run.summary) console.log(`   ${l}`);
  const by = new Map();
  for (const c of run.cells) {
    const k = c.scenario;
    if (!by.has(k)) by.set(k, { trials: 0, bug: 0, flagged: 0, bugFlagged: 0, sigs: {} });
    const b = by.get(k);
    b.trials += c.trials;
    b.bug += c.bug;
    b.flagged += c.flagged;
    b.bugFlagged += c.bugFlagged;
    for (const [s, seeds] of Object.entries(c.sigs)) b.sigs[s] = (b.sigs[s] ?? 0) + seeds.length;
  }
  for (const [k, b] of [...by].sort()) {
    const kind = LEGIT.includes(k) ? "legit" : "bug  ";
    const sigs = Object.entries(b.sigs).map(([s, n]) => `${s.replace(/^witness\|/, "")} x${n}`).join("; ");
    console.log(`   ${k} ${kind} trials ${String(b.trials).padStart(3)}  oracle bug ${String(b.bug).padStart(3)}  flagged ${String(b.flagged).padStart(3)}  (of bug trials ${b.bugFlagged})  ${sigs}`);
  }
}
console.log(`\nwritten ${OUT}`);
