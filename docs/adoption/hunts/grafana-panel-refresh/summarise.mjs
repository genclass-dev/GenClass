// Prints the scenario table of docs/adoption/hunts/grafana-panel-refresh.md from the result files hunt.mjs wrote.
//
//   node docs/adoption/hunts/grafana-panel-refresh/summarise.mjs [results dir]
//
// One row per explore session (scenario x latency): explore's verdict, how many reordered loads this harness's own
// oracle found wrong, and how many of the two fifo baselines it found wrong (a wrong baseline means the oracle, not the
// app, is off). Then one row per plain (no GenClass) reproduction.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "results");
const files = readdirSync(dir).sort();

console.log("| scenario | slow_ms | explore verdict | oracle: reordered loads wrong | oracle: baselines wrong |");
console.log("|---|---|---|---|---|");
for (const f of files.filter((x) => /^explore-.*\.json$/.test(x))) {
  const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
  for (const s of d.sessions) {
    const wrong = s.loads.map((l) => /: WRONG|: ERROR/.test(l));
    const base = wrong.slice(0, 2).filter(Boolean).length;
    const seeded = wrong.slice(2).filter(Boolean).length;
    console.log(`| ${d.scenario} | ${s.slow_ms} | ${s.verdict} | ${seeded} of ${wrong.length - 2} | ${base} of 2 |`);
  }
}

const plain = files.filter((x) => /^plain-.*\.json$/.test(x));
if (plain.length) {
  console.log("\n| reproduction without GenClass | first list response delayed | delayed loads wrong | control loads wrong |");
  console.log("|---|---|---|---|");
  for (const f of plain) {
    const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
    console.log(`| ${f.replace(/^plain-|\.json$/g, "")} | ${d.delay_ms} ms | ${d.delayed} | ${d.control} |`);
  }
}
