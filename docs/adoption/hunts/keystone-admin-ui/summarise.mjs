// Prints the scenario table of docs/adoption/hunts/keystone-admin-ui.md section 5 from the result files, and writes
// results/summary.json (one small row per session). Not part of any test suite.
// Usage: node docs/adoption/hunts/keystone-admin-ui/summarise.mjs [results dir]

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? join(here, "results");
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "summary.json" && !f.startsWith("smoke")).sort();
const rows = [];
for (const f of files) {
  const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const loads = s.loads ?? [];
  const okLoads = loads.filter((l) => l.ok === true).length;
  const failed = loads.filter((l) => l.error).length;
  const forced = loads.reduce((n, l) => n + (l.dom?.agent?.forced ?? 0), 0);
  const witnesses = loads.reduce((n, l) => n + (l.dom?.agent?.witnesses?.length ?? 0), 0);
  const report = s.report ?? "";
  let verdict = "n/a (natural loads)";
  if (report) {
    const race = /RACE: (\d+) of (\d+)/.exec(report);
    const none = /No race found: none of the (\d+)/.exec(report);
    const noVerdict = /No verdict/.test(report);
    verdict = race ? `RACE: ${race[1]} of ${race[2]}` : none ? `no race, 0 of ${none[1]}` : noVerdict ? "no verdict" : "?";
    const internal = /Internal state only[^:]*: (\d+) of (\d+)/.exec(report);
    if (internal) verdict += ` (+${internal[1]} internal only)`;
    const along = /Along the way only[^:]*: (\d+) of (\d+)/.exec(report);
    if (along) verdict += ` (+${along[1]} along the way only)`;
  }
  const diffs = [...report.matchAll(/^ {4}(.+)$/gm)].map((m) => m[1].trim());
  const what = [...new Set(diffs.map((d) => d.replace(/"[^"]*"/g, '"…"').slice(0, 90)))].slice(0, 3).join("; ") || "nothing";
  const wireOps = {};
  for (const l of loads) for (const [k, v] of Object.entries(l.wire ?? {})) (wireOps[k] ??= new Set()).add(v);
  const wire = Object.entries(wireOps).map(([k, v]) => `${k} ${[...v].sort((a, b) => a - b).join("/")}`).join(", ");
  rows.push({ file: f, scenario: s.scenario, slow_ms: s.slow_ms, inject: s.inject, verdict, what, oracle: `${okLoads}/${loads.length}`, failed, forced, witnesses, wire });
}
writeFileSync(join(dir, "summary.json"), JSON.stringify(rows, null, 2));
console.log("| scenario | slow_ms | GenClass | explore verdict (as reported) | what differed | harness oracle as expected | holds ran out | witnesses | GraphQL operations per load (min/max) |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.scenario} | ${r.slow_ms} | ${r.inject ? "on" : "off"} | ${r.verdict} | ${r.what.replace(/\|/g, "\\|")} | ${r.oracle}${r.failed ? ` (${r.failed} failed)` : ""} | ${r.forced} | ${r.witnesses} | ${r.wire} |`);
}
