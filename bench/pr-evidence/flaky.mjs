#!/usr/bin/env node
// The comparison of a test's failing runs with its passing ones (packages/playwright/src/order.ts), measured: does
// the order it names first agree with what is known about the test, and how often does it name anything when the
// outcomes say nothing. Numbers: docs/runtime/RESULTS.md, section 30.
//
//   node bench/pr-evidence/flaky.mjs dev   --seeds 60 --batch 30
//       the development set (tiny-desk): every test under each seed, then per test and per batch of seeds the
//       comparison, and for a buggy test whether its first line names the two requests its overwrote-newer witness names
//       (--no-run --from <name>: from the race files of an earlier run, kept as .work/flaky/<name>/races)
//   node bench/pr-evidence/flaky.mjs held  --apps vue-vite,plain-html --scenarios a,h --data 1,2,3,4,5,6,7,8,9,10 --seeds 30
//       the held-out set: compat's apps whose state the runtime does not see (setup.mjs builds them), the typeahead
//       scenarios, compat's oracle as the outcome; a hit is a first line that says a newer search's response came
//       before an older one's, which is what those scenarios are. --data: one test per data seed (the word typed and
//       the backend's own delays stay the same in every run of it; only GenClass's delays change), each a batch of
//       its own. Without --data the scenario's data changes with the seed, as in compat's matrix: runs of one "test"
//       are then runs of ten different ones, which is what the first measurement did (results/flaky-held-data-varies.json)
//   node bench/pr-evidence/flaky.mjs files <dir> [--batch N] [--label <what these runs are>]
//       race files that are already there (a real suite's runs), each test's comparison in full
//
// In every mode the same runs are also compared with their outcomes shuffled (--rounds times per batch, seeded): the
// share of those the comparison calls explained is the false-explanation rate, given next to every hit rate.
//
// A batch is one investigation: the runs a developer would have made before reading the answer (--batch of them,
// seeds in a row). Flags: --seeds N  --batch N  --rounds N (20)  --workers N (3)  --out <file.json>
//        --first-seed N (held: the delays of seeds N, N+1, ...)  --from <name> (the directory under .work/flaky)
//        --no-run (use the race files of the last run)  --grep <pattern> (dev)  --port N (dev, 5817)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chanceText, decodeSteps, differenceText, explainOrder, runsOf, verdictText } from "../../packages/playwright/dist/explain.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const [MODE, ...argv] = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const SEEDS = Number(opt("seeds", MODE === "held" ? "120" : "60"));
const BATCH = Number(opt("batch", "30"));
const ROUNDS = Number(opt("rounds", "20"));
const WORKERS = opt("workers", "3");
/** held: the seed of the first repeat's delays (GENCLASS_SEED), for a sample under other delays than seeds 1 to N. */
const FIRST = Number(opt("first-seed", "1"));
const RUNNER = join(REPO, "packages", "playwright", "bin", "genclass-playwright-run.mjs");
const RUNTIME = join(REPO, "packages", "runtime", "dist");
const WORK = join(HERE, ".work", "flaky");
const quote = (s) => `\`${s}\``;

const readJsonDir = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : []);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The same runs with their outcomes dealt at random (as many failing as there were), `rounds` times: how many are called explained. */
function shuffled(runs, rounds, seed) {
  const failing = runs.filter((r) => r.failed).length;
  const random = mulberry32(seed);
  let explained = 0;
  for (let i = 0; i < rounds; i++) {
    const dealt = runs.map((r) => ({ r, key: random() })).sort((a, b) => a.key - b.key);
    if (explainOrder(dealt.map((d, at) => ({ failed: at < failing, events: d.r.events }))).verdict === "explained") explained++;
  }
  return { rounds, explained };
}

const stepName = (s) => `${s.kind}:${s.label}#${s.n}`;
const first = (x) => (x.differences[0] ? { kind: x.differences[0].kind, form: x.differences[0].form, steps: x.differences[0].steps.map(stepName), failing: x.differences[0].failing, passing: x.differences[0].passing, ms: x.differences[0].ms } : null);

/** One investigation: the comparison of these runs, and of the same runs with shuffled outcomes. */
function investigate(runs, seed) {
  const x = explainOrder(runs);
  const out = { failing: x.failing, passing: x.passing, verdict: x.verdict, strongest: x.strongest, strength: Math.round(x.strength * 1000) / 1000, covered: x.covered, lines: x.differences.length, more: x.more, first: first(x), chance: x.chance && { ...x.chance, needed: Number.isFinite(x.chance.needed) ? Math.round(x.chance.needed * 1000) / 1000 : null }, text: [verdictText(x), ...x.differences.map((d, i) => `${i + 1}. ${differenceText(d, x, quote)}`), chanceText(x)].filter(Boolean) };
  if (x.verdict !== "too-few-runs") out.shuffled = shuffled(runs, ROUNDS, seed);
  return out;
}

const batchesOf = (seeds) => {
  const out = [];
  for (let from = 1; from + BATCH - 1 <= seeds; from += BATCH) out.push([from, from + BATCH - 1]);
  return out.length ? out : [[1, seeds]];
};

function sh(cmd, args, o) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...o });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const pct = (n, d) => (d ? `${n} of ${d} (${Math.round((100 * n) / d)}%)` : "0 of 0");

// ------------------------------------------------------------------------------------------------ development set

/** "The response of GET /api/items/lamp#1 wrote … over what newer GET /api/items/desk#1, started …" -> the two requests. */
function witnessPair(evidence) {
  const m = /^The response of (\S+ \S+)#(\d+) wrote .*? over what newer (\S+ \S+)#(\d+), started /.exec(evidence ?? "");
  return m ? [`r:${m[1]}#${m[2]}`, `r:${m[3]}#${m[4]}`] : null;
}

function dev() {
  const app = join(HERE, "tiny-desk");
  // --from: the race files of another run of this set, kept under .work/flaky (with --no-run)
  const races = join(WORK, opt("from", "dev"), "races");
  let seconds = null;
  if (!flag("no-run")) {
    if (!existsSync(join(app, "node_modules"))) sh("npm", ["ci", "--no-audit", "--no-fund"], { cwd: app, stdio: "inherit" });
    rmSync(races, { recursive: true, force: true });
    const grep = opt("grep", null);
    const t0 = Date.now();
    const r = sh(process.execPath, [RUNNER, "--repeat-each", String(SEEDS), ...(grep ? ["-g", grep] : [])], { cwd: app, env: { ...process.env, GENCLASS_OUT_DIR: races, GENCLASS_RUNTIME_DIR: RUNTIME, TINY_DESK_PORT: opt("port", "5817") } });
    seconds = Math.round((Date.now() - t0) / 100) / 10;
    mkdirSync(join(WORK, "dev"), { recursive: true });
    writeFileSync(join(WORK, "dev", "output.log"), r.out);
  }
  const files = readJsonDir(races);
  const byTest = new Map();
  for (const f of files) byTest.set(f.test, [...(byTest.get(f.test) ?? []), f]);
  const rows = [];
  for (const [test, all] of [...byTest].sort()) {
    for (const [from, to] of batchesOf(SEEDS)) {
      const mine = all.filter((f) => f.seed >= from && f.seed <= to);
      const runs = runsOf(mine);
      const row = { test: test.replace(/^desk\.spec\.js > /, ""), seeds: [from, to], files: mine.length, failed: runs.failed, passed: runs.passed, ...investigate(runs.runs, from) };
      // the requests the overwrote-newer witness of a failing run names, per failing run that has one
      const pairs = mine.filter((f) => f.status === "failed" || f.status === "timedOut").map((f) => witnessPair((f.signatures ?? []).find((s) => s.diagnosis === "overwrote-newer")?.evidence));
      row.witnessed = pairs.filter(Boolean).length;
      if (row.first) {
        const named = new Set(row.first.steps);
        const operations = new Set(row.first.steps.map((s) => s.replace(/#\d+$/, "")));
        row.sameRequests = pairs.filter((p) => p && row.first.form === "pair" && p.every((k) => named.has(k))).length;
        row.sameOperations = pairs.filter((p) => p && p.every((k) => operations.has(k.replace(/#\d+$/, "")))).length;
      }
      rows.push(row);
    }
  }
  // a test that both fails and passes in a batch, three times each, is one the comparison can be asked about
  const askable = rows.filter((r) => r.verdict !== "too-few-runs");
  const never = rows.filter((r) => r.failed === 0);
  const summary = {
    investigations: rows.length,
    askable: askable.length,
    explained: askable.filter((r) => r.verdict === "explained").length,
    firstLineNamesTheWitnessRequests: askable.filter((r) => r.verdict === "explained" && r.sameRequests > 0).length,
    firstLineNamesTheWitnessOperations: askable.filter((r) => r.verdict === "explained" && r.sameOperations > 0).length,
    shuffledRounds: askable.reduce((n, r) => n + (r.shuffled?.rounds ?? 0), 0),
    shuffledExplained: askable.reduce((n, r) => n + (r.shuffled?.explained ?? 0), 0),
    alwaysPassing: never.length,
    alwaysPassingWithAnExplanation: never.filter((r) => r.verdict === "explained").length,
  };
  for (const r of rows) {
    console.log(`\n${r.test} · seeds ${r.seeds[0]} to ${r.seeds[1]} · failed ${r.failed} of ${r.files} · ${r.verdict}${r.shuffled ? ` · shuffled outcomes explained ${r.shuffled.explained} of ${r.shuffled.rounds}` : ""}`);
    if (r.verdict !== "too-few-runs") for (const l of r.text) console.log(`   ${l}`);
    if (r.first && r.verdict === "explained") console.log(`   witness in ${r.witnessed} failing runs: names the same two requests in ${r.sameRequests}, the same two operations in ${r.sameOperations}`);
  }
  console.log(`\n== development set: ${SEEDS} seeds, batches of ${BATCH}${seconds ? `, ${seconds}s` : ""} ==`);
  console.log(`   tests that failed and passed at least three times each in a batch: ${summary.askable} of ${summary.investigations} test-batches`);
  console.log(`   explained: ${pct(summary.explained, summary.askable)}; first line names the two requests of a failing run's witness: ${pct(summary.firstLineNamesTheWitnessRequests, summary.askable)} (the two operations: ${summary.firstLineNamesTheWitnessOperations})`);
  console.log(`   the same runs with shuffled outcomes, called explained: ${pct(summary.shuffledExplained, summary.shuffledRounds)}`);
  console.log(`   test-batches that never failed: ${summary.alwaysPassing}, with an explanation: ${summary.alwaysPassingWithAnExplanation}`);
  return { mode: "dev", seeds: SEEDS, batch: BATCH, rounds: ROUNDS, seconds, summary, rows };
}

// ------------------------------------------------------------------------------------------------ held-out set

/** A newer search's response before an older one's: what compat's typeahead scenarios (a, h) are, by construction. */
function staleSearch(firstLine) {
  if (!firstLine || firstLine.form !== "pair") return false;
  const m = firstLine.steps.map((s) => /^r:GET \/api\/search#(\d+)$/.exec(s));
  return !!m[0] && !!m[1] && Number(m[0][1]) > Number(m[1][1]);
}

function held() {
  const apps = opt("apps", "vue-vite,solid-vite").split(",").filter(Boolean);
  const scenarios = opt("scenarios", "a,h");
  const data = opt("data", null);
  const rows = [];
  const runs = [];
  for (const app of apps) {
    // --from: another directory under .work/flaky for this run's files (a second sample that keeps the first)
    const dir = join(WORK, opt("from", data ? "held-fixed" : "held"), app);
    if (!flag("no-run")) {
      if (!existsSync(join(HERE, ".work", app, "dist", "index.html"))) throw new Error(`build the app first: node bench/pr-evidence/setup.mjs ${app}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const env = { ...process.env, BENCH_APP: app, BENCH_SCENARIOS: scenarios, BENCH_WORKERS: WORKERS, BENCH_VERDICT_DIR: join(dir, "verdicts"), GENCLASS_CHAOS: "on", GENCLASS_SEED: String(FIRST), GENCLASS_OUT_DIR: join(dir, "races"), GENCLASS_RUNTIME_DIR: RUNTIME, ...(data ? { BENCH_DATA_SEEDS: data } : {}) };
      const t0 = Date.now();
      const r = sh(process.execPath, [RUNNER, "--config", "playwright.config.mjs", "--repeat-each", String(SEEDS)], { cwd: HERE, env });
      writeFileSync(join(dir, "output.log"), r.out);
      runs.push({ app, seconds: Math.round((Date.now() - t0) / 100) / 10, exit: r.status });
    }
    // "compat.spec.mjs > <layer> > <scenario> > [data <n> >] <name>"
    const races = new Map();
    for (const f of readJsonDir(join(dir, "races"))) {
      const parts = String(f.test ?? "").split(" > ");
      const d = /^data (\d+)$/.exec(parts[3] ?? "")?.[1] ?? "";
      races.set(`${parts[1]}|${parts[2]}|${d}|${f.seed}`, f);
    }
    const cells = new Map();
    for (const v of readJsonDir(join(dir, "verdicts"))) {
      const k = `${v.layer}|${v.scenario}|${v.data ?? ""}`;
      cells.set(k, [...(cells.get(k) ?? []), v]);
    }
    const byData = (a, b) => a[0].split("|").slice(0, 2).join("|").localeCompare(b[0].split("|").slice(0, 2).join("|")) || Number(a[0].split("|")[2]) - Number(b[0].split("|")[2]);
    for (const [k, verdicts] of [...cells].sort(byData)) {
      const [layer, scenario, d] = k.split("|");
      // with the data held fixed, a test's runs are one batch; else batches of seeds in a row
      for (const [from, to] of d ? [[1, SEEDS]] : batchesOf(SEEDS)) {
        const mine = verdicts.filter((v) => v.seed >= from && v.seed <= to);
        let errors = 0;
        let noSteps = 0;
        const trial = [];
        for (const v of mine) {
          // the verdict counts repeats from 1; the race file carries the seed of that repeat's delays
          const f = races.get(`${layer}|${scenario}|${d}|${v.seed + FIRST - 1}`);
          if (!v.ok) errors++;
          else if (!f?.steps) noSteps++;
          else trial.push({ failed: typeof v.bug === "string", events: decodeSteps(f.steps) });
        }
        const row = { app, layer, scenario, ...(d ? { data: Number(d) } : {}), seeds: [from + FIRST - 1, to + FIRST - 1], trials: mine.length, errors, noSteps, bug: trial.filter((t) => t.failed).length, ...investigate(trial, from + (d ? Number(d) * 1000 : 0)) };
        row.hit = row.verdict === "explained" && staleSearch(row.first);
        rows.push(row);
      }
    }
  }
  const askable = rows.filter((r) => r.verdict !== "too-few-runs");
  const summary = {
    investigations: rows.length,
    askable: askable.length,
    explained: askable.filter((r) => r.verdict === "explained").length,
    hits: askable.filter((r) => r.hit).length,
    shuffledRounds: askable.reduce((n, r) => n + (r.shuffled?.rounds ?? 0), 0),
    shuffledExplained: askable.reduce((n, r) => n + (r.shuffled?.explained ?? 0), 0),
  };
  for (const r of rows) {
    console.log(`\n${r.app} / ${r.layer} / scenario ${r.scenario}${r.data ? ` / data ${r.data}` : ""} · seeds ${r.seeds[0]} to ${r.seeds[1]} · the oracle saw the bug in ${r.bug} of ${r.trials} · ${r.verdict}${r.verdict === "explained" ? (r.hit ? " · HIT" : " · another first line") : ""}${r.shuffled ? ` · shuffled outcomes explained ${r.shuffled.explained} of ${r.shuffled.rounds}` : ""}`);
    if (r.verdict !== "too-few-runs") for (const l of r.text) console.log(`   ${l}`);
  }
  console.log(`\n== held-out set: ${apps.join(", ")}; scenarios ${scenarios}; ${data ? `data seeds ${data}, each under ${SEEDS} seeds` : `${SEEDS} seeds, batches of ${BATCH}`} ==`);
  for (const r of runs) console.log(`   ${r.app}: ${r.seconds}s, exit ${r.exit}`);
  console.log(`   batches with at least three trials of each outcome: ${summary.askable} of ${summary.investigations}`);
  console.log(`   first line is the stale search (a newer search's response before an older one's): ${pct(summary.hits, summary.askable)}; called explained at all: ${summary.explained}`);
  console.log(`   the same trials with shuffled outcomes, called explained: ${pct(summary.shuffledExplained, summary.shuffledRounds)}`);
  return { mode: "held", apps, scenarios, data: data ? data.split(",").map(Number) : null, firstSeed: FIRST, seeds: SEEDS, batch: data ? SEEDS : BATCH, rounds: ROUNDS, workers: Number(WORKERS), runs, summary, rows };
}

// ------------------------------------------------------------------------------------------------ files that are there

function filesMode() {
  const dir = resolve(argv.find((a) => !a.startsWith("--")) ?? ".");
  const byTest = new Map();
  for (const f of readJsonDir(dir)) byTest.set(f.test, [...(byTest.get(f.test) ?? []), f]);
  const rows = [];
  for (const [test, all] of [...byTest].sort()) {
    const sorted = [...all].sort((a, b) => a.seed - b.seed);
    const size = argv.includes("--batch") ? BATCH : sorted.length;
    for (let at = 0; at < sorted.length; at += size) {
      const mine = sorted.slice(at, at + size);
      const runs = runsOf(mine);
      const row = { test, seeds: [mine[0].seed, mine[mine.length - 1].seed], files: mine.length, failed: runs.failed, passed: runs.passed, withoutSteps: runs.withoutSteps, ...investigate(runs.runs, mine[0].seed) };
      rows.push(row);
      console.log(`\n${test} · seeds ${row.seeds[0]} to ${row.seeds[1]} · failed ${row.failed} of ${row.files} · ${row.verdict}${row.shuffled ? ` · shuffled outcomes explained ${row.shuffled.explained} of ${row.shuffled.rounds}` : ""}`);
      for (const l of row.text) console.log(`   ${l}`);
    }
  }
  // where the files were, as a path inside the repository or else by its last name only: never a machine's own path
  const inside = relative(REPO, dir);
  const where = inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : basename(dir);
  return { mode: "files", dir: where, ...(opt("label", null) ? { label: opt("label") } : {}), rounds: ROUNDS, rows };
}

if (!["dev", "held", "files"].includes(MODE)) {
  console.error("usage: node bench/pr-evidence/flaky.mjs dev|held|files [flags] (see the top of this file)");
  process.exit(2);
}
if (!existsSync(join(REPO, "packages", "playwright", "dist", "summarize.js"))) throw new Error("build first: npm run build -w @genclass/runtime && npm run build -w @genclass/playwright");
const result = { date: new Date().toISOString().slice(0, 10), node: process.version, ...(MODE === "dev" ? dev() : MODE === "held" ? held() : filesMode()) };
const out = opt("out", MODE === "files" ? null : join(HERE, "results", `flaky-${MODE}.json`));
if (out && flag("no-run") && existsSync(resolve(out))) {
  // compared again from the race files of the run the file is about: when that run was made and how long it took stay
  try {
    const was = JSON.parse(readFileSync(resolve(out), "utf8"));
    result.recompared = result.date;
    result.date = was.date ?? result.date;
    if (was.seconds != null) result.seconds = was.seconds;
    if (Array.isArray(was.runs) && was.runs.length) result.runs = was.runs;
  } catch {
    /* not a result file of this script: written afresh */
  }
}
if (out) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), JSON.stringify(result, null, 1) + "\n");
  console.log(`\nwritten ${resolve(out)}`);
}
