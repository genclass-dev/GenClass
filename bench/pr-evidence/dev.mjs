#!/usr/bin/env node
// The development set of this bench: Tiny Desk (bench/pr-evidence/tiny-desk), a small React app with four planted
// races, the fixed version of each, a notifications poll and a button meant to send the same request twice, and ten
// plain Playwright tests that all pass at normal speed. Changes to the fixture were chosen on this app; compat's app
// (run.mjs) is the held-out measurement and was not looked at to choose them.
//
// It runs the suite through genclass-playwright-run under each setting and counts, per planted race, in how many
// seeds the race's own signature was flagged; what was flagged on the fixed versions; and every other line.
//
//   node bench/pr-evidence/dev.mjs --seeds 10
//   node bench/pr-evidence/dev.mjs --seeds 40 --grep detail --settings wait,wait+mirror
//
// Settings: npm (the packages as published, installed under .work/npm), base (the local build with the end-of-test
// wait and the mirrored seeds both off: what 0.1.0 did), wait (the wait on), wait+mirror (both on: the default).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const APP = join(HERE, "tiny-desk");
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const SEEDS = Number(opt("seeds", "10"));
const GREP = opt("grep", null);
const SETTINGS = opt("settings", "npm,base,wait,wait+mirror").split(",").filter(Boolean);
const OUT = resolve(opt("out", join(HERE, "results", `dev-${GREP ?? "all"}-${SEEDS}.json`)));
const NPM = join(HERE, ".work", "npm");
const LOCAL = { runner: join(REPO, "packages", "playwright", "bin", "genclass-playwright-run.mjs"), runtime: join(REPO, "packages", "runtime", "dist") };

// each planted race: the test that reaches it, and the signature that is the race itself
const PLANTED = {
  search: { test: "buggy > search", sig: "witness|overwrote-newer|GET /api/search" },
  checkout: { test: "buggy > checkout", sig: "witness|identical-in-flight|POST /api/orders" },
  profile: { test: "buggy > profile", sig: "witness|overwrote-newer|PUT /api/profile" },
  detail: { test: "buggy > detail", sig: "witness|overwrote-newer|GET /api/items/lamp" },
};
// a consequence of a planted race, counted with it and not as noise
const CONSEQUENCE = new Set(["buggy > checkout|witness|overwrote-newer|POST /api/orders"]);

function sh(cmd, args, o) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...o });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

if (!existsSync(join(APP, "node_modules"))) sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: APP, stdio: "inherit" });
if (SETTINGS.includes("npm") && !existsSync(join(NPM, "node_modules", "@genclass", "playwright"))) {
  mkdirSync(NPM, { recursive: true });
  sh("npm", ["install", "--prefix", NPM, "--no-audit", "--no-fund", "@genclass/playwright@0.1.0", "@genclass/runtime@0.3.0-beta.5"], { stdio: "inherit" });
}

function run(setting) {
  const races = join(HERE, ".work", "dev", setting.replace("+", "-"));
  rmSync(races, { recursive: true, force: true });
  const env = { ...process.env, GENCLASS_OUT_DIR: races, TINY_DESK_PORT: opt("port", "5817") };
  let runner = LOCAL.runner;
  if (setting === "npm") runner = join(NPM, "node_modules", "@genclass", "playwright", "bin", "genclass-playwright-run.mjs");
  else {
    env.GENCLASS_RUNTIME_DIR = LOCAL.runtime;
    if (!setting.includes("wait")) env.GENCLASS_WAIT_FOR_RESPONSES_MS = "0";
    if (!setting.includes("mirror")) env.GENCLASS_CHAOS_MIRROR = "off";
  }
  const args = [runner, "--repeat-each", String(SEEDS), ...(GREP ? ["-g", GREP] : [])];
  const t0 = Date.now();
  const r = sh(process.execPath, args, { cwd: APP, env });
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const passed = Number(/(\d+) passed/.exec(r.out)?.[1] ?? 0);
  const failed = Number(/(\d+) failed/.exec(r.out)?.[1] ?? 0);
  const files = existsSync(races) ? readdirSync(races).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(races, f), "utf8"))) : [];
  const short = (t) => String(t).replace(/^desk\.spec\.js > /, "").replace(/^(buggy|fixed) > (\w+).*$/, "$1 > $2");
  const planted = {};
  for (const [name, p] of Object.entries(PLANTED)) {
    const mine = files.filter((f) => short(f.test) === p.test);
    const seeds = mine.filter((f) => (f.signatures ?? []).some((s) => s.sig === p.sig)).map((f) => f.seed).sort((a, b) => a - b);
    // pairs of seeds in a row, as two runs give them: (1,2), (3,4), ...
    let any = 0;
    let both = 0;
    let pairs = 0;
    for (let s = 1; s + 1 <= SEEDS; s += 2) {
      if (!mine.some((f) => f.seed === s) || !mine.some((f) => f.seed === s + 1)) continue;
      pairs++;
      const a = seeds.includes(s);
      const b = seeds.includes(s + 1);
      if (a || b) any++;
      if (a && b) both++;
    }
    planted[name] = { runs: mine.length, flagged: seeds.length, seeds, pairs, pairsAny: any, pairsBoth: both };
  }
  const fixedRuns = files.filter((f) => /^fixed > (search|checkout|profile|detail)$/.test(short(f.test)));
  const fixedFlagged = fixedRuns.filter((f) => (f.signatures ?? []).length > 0).map((f) => ({ test: short(f.test), seed: f.seed, sigs: f.signatures.map((s) => s.sig) }));
  const other = {};
  for (const f of files) {
    for (const s of f.signatures ?? []) {
      const t = short(f.test);
      if (Object.values(PLANTED).some((p) => p.test === t && p.sig === s.sig) || CONSEQUENCE.has(`${t}|${s.sig}`)) continue;
      const k = `${t} | ${s.sig.replace(/^witness\|/, "")}`;
      other[k] = (other[k] ?? 0) + 1;
    }
  }
  return { setting, seconds, passed, failed, files: files.length, planted, fixed: { runs: fixedRuns.length, flagged: fixedFlagged }, other };
}

const result = { date: new Date().toISOString().slice(0, 10), seeds: SEEDS, grep: GREP, node: process.version, settings: [] };
for (const s of SETTINGS) {
  process.stdout.write(`${s} ... `);
  const r = run(s);
  result.settings.push(r);
  console.log(`${r.seconds}s, ${r.passed} passed, ${r.failed} failed, ${r.files} race files`);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 1) + "\n");
for (const r of result.settings) {
  console.log(`\n== ${r.setting}: ${r.seconds}s, ${r.passed} passed, ${r.failed} failed ==`);
  for (const [name, p] of Object.entries(r.planted)) if (p.runs) console.log(`   ${name.padEnd(9)} flagged in ${String(p.flagged).padStart(2)} of ${p.runs} seeds; of ${p.pairs} pairs: in at least one seed ${p.pairsAny}, in both ${p.pairsBoth}`);
  console.log(`   fixed versions: ${r.fixed.flagged.length} of ${r.fixed.runs} runs flagged`);
  for (const [k, n] of Object.entries(r.other)) console.log(`   other: ${k} x${n}`);
}
console.log(`\nwritten ${OUT}`);
