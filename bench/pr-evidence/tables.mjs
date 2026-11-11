#!/usr/bin/env node
// Prints the tables of RESULTS.md section 29 from this bench's result files, so the numbers there are the files'.
//   node bench/pr-evidence/tables.mjs heldout results/before.json results/after.json
//   node bench/pr-evidence/tables.mjs dev results/dev-a.json [results/dev-b.json ...]
import { readFileSync } from "node:fs";

const [kind, ...files] = process.argv.slice(2);
const read = (f) => JSON.parse(readFileSync(f, "utf8"));
const LEGIT = ["c", "d", "e", "f", "g", "h"];
const short = (s) => s.replace(/^witness\|/, "").replace("|", " ");

if (kind === "heldout") {
  for (const f of files) {
    const r = read(f);
    console.log(`\n### ${r.label} (${r.date}, ${r.seeds} seeds, @genclass/playwright ${r.playwrightPackage}, @genclass/runtime ${r.runtimePackage})\n`);
    console.log("| mode | seconds | trials | a, b: trials where the oracle saw the bug | of those, flagged | c to h: trials flagged | of those in f | c to h: trials where the oracle saw a bug |");
    console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const run of r.runs) {
      const bug = run.cells.filter((c) => !LEGIT.includes(c.scenario));
      const legit = run.cells.filter((c) => LEGIT.includes(c.scenario));
      const sum = (list, k) => list.reduce((n, c) => n + c[k], 0);
      const f = legit.filter((c) => c.scenario === "f");
      console.log(`| ${run.mode} | ${run.seconds} | ${run.totals.trials} | ${sum(bug, "bug")} | ${run.mode === "plain" ? "" : sum(bug, "bugFlagged")} | ${run.mode === "plain" ? "" : sum(legit, "flagged")} | ${run.mode === "plain" ? "" : sum(f, "flagged")} | ${sum(legit, "bug")} |`);
    }
    for (const run of r.runs.filter((x) => x.mode !== "plain")) {
      console.log(`\n${r.label} / ${run.mode}: lines on scenarios c to h, by scenario and signature (trials flagged of 36; lines)\n`);
      const by = new Map();
      for (const c of run.cells.filter((x) => LEGIT.includes(x.scenario))) {
        const b = by.get(c.scenario) ?? { flagged: 0, bug: 0, sigs: {} };
        b.flagged += c.flagged;
        b.bug += c.bug;
        for (const [s, seeds] of Object.entries(c.sigs)) b.sigs[s] = (b.sigs[s] ?? 0) + seeds.length;
        by.set(c.scenario, b);
      }
      for (const [k, b] of [...by].sort()) console.log(`- ${k}: ${b.flagged} of 36 flagged, oracle bug in ${b.bug}; ${Object.entries(b.sigs).map(([s, n]) => `${short(s)} ×${n}`).join(", ") || "no line"}`);
      const layers = new Map();
      for (const c of run.cells) {
        const L = layers.get(c.layer) ?? { bug: 0, bugFlagged: 0, legit: 0, legitNoF: 0, trialsNoF: 0 };
        if (LEGIT.includes(c.scenario)) {
          L.legit += c.flagged;
          if (c.scenario !== "f") {
            L.legitNoF += c.flagged;
            L.trialsNoF += c.trials;
          }
        } else {
          L.bug += c.bug;
          L.bugFlagged += c.bugFlagged;
        }
        layers.set(c.layer, L);
      }
      console.log(`\n| layer | bug trials | flagged | c to h without f: trials flagged |\n|---|---:|---:|---:|`);
      for (const [n, L] of [...layers].sort()) console.log(`| ${n} | ${L.bug} | ${L.bugFlagged} | ${L.legitNoF} of ${L.trialsNoF} |`);
    }
  }
} else if (kind === "dev") {
  for (const f of files) {
    const r = read(f);
    console.log(`\n### ${f.split("/").pop()} (${r.date}, seeds 1 to ${r.seeds}${r.grep ? `, tests matching "${r.grep}"` : ""})\n`);
    console.log("| setting | seconds | passed | failed | search | checkout | profile | detail | detail: seed pairs with it in at least one / both | fixed versions: runs with a line on their own operations | other lines |");
    console.log("|---|---:|---:|---:|---|---|---|---|---|---|---|");
    for (const s of r.settings) {
      const p = s.planted;
      const cell = (x) => (x && x.runs ? `${x.flagged} of ${x.runs}` : "");
      const other = Object.entries(s.other);
      const own = s.fixed.flagged.filter((x) => x.sigs.some((g) => !/notifications/.test(g)));
      const kinds = {};
      for (const [k, n] of other) {
        const g = /notifications/.test(k) ? "poll" : /cart/.test(k) ? (/identical/.test(k) ? "cart, identical" : "cart, overwrote") : k;
        kinds[g] = (kinds[g] ?? 0) + n;
      }
      console.log(`| ${s.setting} | ${s.seconds} | ${s.passed} | ${s.failed} | ${cell(p.search)} | ${cell(p.checkout)} | ${cell(p.profile)} | ${cell(p.detail)} | ${p.detail?.pairs ? `${p.detail.pairsAny} / ${p.detail.pairsBoth} of ${p.detail.pairs}` : ""} | ${own.length} of ${s.fixed.runs} | ${Object.entries(kinds).map(([k, n]) => `${k} ×${n}`).join("; ") || "none"} |`);
    }
  }
} else {
  console.error("usage: tables.mjs heldout|dev <result files>");
  process.exit(1);
}
