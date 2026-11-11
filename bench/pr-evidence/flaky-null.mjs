#!/usr/bin/env node
// Tests with no order to find: simulated runs whose outcome is a coin that has nothing to do with the order of their
// steps, given to the comparison of failing and passing runs (packages/playwright/src/order.ts). How often it calls
// anything explained is its false-explanation rate where the truth is known. Numbers: docs/runtime/RESULTS.md,
// section 30. No browser and no app: the runs are made here, seeded, so the same command prints the same numbers.
//
//   node bench/pr-evidence/flaky-null.mjs [--trials 300] [--out results/flaky-null.json] [--order <a built order module>]
//
// What differs between a failing and a passing run in each family is only how much of it was recorded:
//   longer      one click, requests /a and /b in flight, the test ends when /a is answered. A failing run waits for
//               its check to give up and records /b wherever it lands. A passing run has ended when /b lands after /a:
//               "late" (the fixture's wait caught it, after the test's own code) or "open" (never delivered).
//               This is the case an independent review found (RESULTS.md section 30).
//   longer-cut  the same, and a passing run goes on: a second click 30 ms after /a is answered, and a third request.
//   equal       every run records everything, whatever its outcome.
//   stop-early  one click, twelve requests, two more clicks; a failing run stops at a moment of its own.
// --order: the comparison of another build (a module that exports explainOrder), for a before and after.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const TRIALS = Number(opt("trials", "300"));
const module = opt("order", null);
const { explainOrder } = await import(module ? pathToFileURL(resolve(module)).href : "../../packages/playwright/dist/explain.js");

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

/** Steps in the order of their times; `end`: what lands after it is late, `drop`: or is not recorded at all. */
function events(items, end = Infinity, drop = false) {
  const sorted = items.map((x, i) => ({ x, i })).sort((a, b) => a.x.t - b.x.t || a.i - b.i).map((o) => o.x);
  const body = sorted.filter((x) => x.t <= end).map((x) => ({ kind: x.kind, label: x.label, n: 1, t: x.t }));
  const late = drop ? [] : sorted.filter((x) => x.t > end).map((x) => ({ kind: x.kind, label: x.label, n: 1, t: x.t, late: true }));
  return [...body, ...late];
}

const FAMILIES = {
  /** `after`: "late" or "open"; `bFast`: /b is usually answered sooner than /a. */
  longer: (random, failed, { after, bFast }) => {
    const ta = 20 + Math.floor(random() * 600);
    const tb = 20 + Math.floor(random() * (bFast ? 380 : 600));
    const items = [{ kind: "a", label: 'click button "Load"', t: 0 }, { kind: "s", label: "GET /api/a", t: 2 }, { kind: "s", label: "GET /api/b", t: 3 }, { kind: "r", label: "GET /api/a", t: ta }, { kind: "r", label: "GET /api/b", t: tb }];
    return events(items, failed ? ta + 5000 : ta + 15, after === "open");
  },
  "longer-cut": (random, failed, { bFast }) => {
    const ta = 20 + Math.floor(random() * 600);
    const tb = 20 + Math.floor(random() * (bFast ? 380 : 600));
    const items = [{ kind: "a", label: 'click button "Load"', t: 0 }, { kind: "s", label: "GET /api/a", t: 2 }, { kind: "s", label: "GET /api/b", t: 3 }, { kind: "r", label: "GET /api/a", t: ta }, { kind: "r", label: "GET /api/b", t: tb }];
    if (failed) return events(items, ta + 5000);
    const tc = ta + 52 + Math.floor(random() * 600);
    items.push({ kind: "a", label: 'click button "Next"', t: ta + 30 }, { kind: "s", label: "GET /api/c", t: ta + 32 }, { kind: "r", label: "GET /api/c", t: tc });
    return events(items, tc + 15);
  },
  equal: (random, _failed, { requests }) => {
    const items = [{ kind: "a", label: 'click button "Load"', t: 0 }];
    for (let k = 0; k < requests; k++) items.push({ kind: "s", label: `GET /api/r${k}`, t: 1 });
    for (let k = 0; k < requests; k++) items.push({ kind: "r", label: `GET /api/r${k}`, t: 5 + Math.floor(random() * 600) });
    items.push({ kind: "a", label: 'click button "Next"', t: 300 }, { kind: "a", label: 'click button "Done"', t: 650 });
    return events(items);
  },
  "stop-early": (random, failed, { requests }) => {
    const items = [{ kind: "a", label: 'click button "Load"', t: 0 }];
    for (let k = 0; k < requests; k++) items.push({ kind: "s", label: `GET /api/r${k}`, t: 1 });
    for (let k = 0; k < requests; k++) items.push({ kind: "r", label: `GET /api/r${k}`, t: 5 + Math.floor(random() * 600) });
    items.push({ kind: "a", label: 'click button "Next"', t: 300 }, { kind: "a", label: 'click button "Done"', t: 650 });
    return events(items, failed ? 100 + Math.floor(random() * 500) : Infinity, true);
  },
};

const CASES = [
  { family: "longer", runs: 40, fail: 0.3, after: "late", bFast: false },
  { family: "longer", runs: 40, fail: 0.3, after: "late", bFast: true },
  { family: "longer", runs: 40, fail: 0.3, after: "open", bFast: false },
  { family: "longer", runs: 40, fail: 0.3, after: "open", bFast: true },
  { family: "longer-cut", runs: 40, fail: 0.3, bFast: false },
  { family: "longer-cut", runs: 40, fail: 0.3, bFast: true },
  { family: "equal", runs: 12, fail: 0.4, requests: 12 },
  { family: "equal", runs: 20, fail: 0.35, requests: 12 },
  { family: "equal", runs: 30, fail: 0.25, requests: 12 },
  { family: "equal", runs: 40, fail: 0.3, requests: 2 },
  { family: "stop-early", runs: 12, fail: 0.4, requests: 12 },
  { family: "stop-early", runs: 20, fail: 0.35, requests: 12 },
  { family: "stop-early", runs: 30, fail: 0.25, requests: 12 },
];

const rows = [];
CASES.forEach((c, at) => {
  const tally = { explained: 0, chance: 0, "no-difference": 0, "too-few-runs": 0 };
  for (let trial = 1; trial <= TRIALS; trial++) {
    const random = mulberry32(700_000 + at * 10_007 + trial * 13);
    const runs = [];
    for (let i = 0; i < c.runs; i++) {
      const failed = random() < c.fail;
      runs.push({ failed, events: FAMILIES[c.family](random, failed, c) });
    }
    tally[explainOrder(runs, { shuffles: 300 }).verdict]++;
  }
  const compared = TRIALS - tally["too-few-runs"];
  const { family, ...settings } = c;
  rows.push({ family, ...settings, trials: TRIALS, compared, explained: tally.explained, chance: tally.chance, noDifference: tally["no-difference"] });
  console.log(`${family.padEnd(11)} ${JSON.stringify(settings).padEnd(58)} explained in ${String(tally.explained).padStart(3)} of ${compared} compared (${((100 * tally.explained) / Math.max(1, compared)).toFixed(1)}%)`);
});
const by = {};
for (const r of rows) {
  const k = r.family.startsWith("longer") ? "failing runs last longer" : r.family === "equal" ? "runs equally long" : "failing runs stop early";
  by[k] ??= { compared: 0, explained: 0 };
  by[k].compared += r.compared;
  by[k].explained += r.explained;
}
for (const [k, v] of Object.entries(by)) console.log(`== ${k}: explained in ${v.explained} of ${v.compared} (${((100 * v.explained) / Math.max(1, v.compared)).toFixed(1)}%)`);
const out = opt("out", null);
if (out) {
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ date: new Date().toISOString().slice(0, 10), node: process.version, trials: TRIALS, shuffles: 300, comparison: module ? "another build (--order)" : "packages/playwright/dist/explain.js", summary: by, rows }, null, 1) + "\n");
  console.log(`\nwritten ${path.startsWith(HERE) ? join("bench", "pr-evidence", path.slice(HERE.length + 1)) : path}`);
}
