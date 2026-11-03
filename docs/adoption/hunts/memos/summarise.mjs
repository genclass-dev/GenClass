// Summarises the explore harness's per-surface summaries (explore.mjs --out <dir>) into one small table.
//
//   node docs/adoption/hunts/memos/summarise.mjs <out-dir> [<out-dir-fixed>] > docs/adoption/hunts/memos/results.json
//
// For each surface and latency: GenClass's verdict line, how many of the 8 loads the harness's own oracle saw end
// with the page disagreeing with the server ("DIFFER"), how many of the 6 seeded loads that was, how many loads
// errored (a step that the order made impossible), and the delivery order of the two writes in each DIFFER load.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SURFACES = ["pin", "archive", "tasks", "reaction", "comment"];
const table = {};
for (const dir of process.argv.slice(2)) {
  const label = dir.replace(/\/+$/, "").split("/").pop();
  table[label] = {};
  for (const surface of SURFACES) {
    const file = join(dir, `${surface}-summary.json`);
    if (!existsSync(file)) continue;
    const s = JSON.parse(readFileSync(file, "utf8"));
    table[label][surface] = s.sessions.map((x) => ({
      slow_ms: x.slow_ms,
      genclass: x.verdict,
      oracle_differ_of_8: x.shown.filter((l) => l.startsWith("DIFFER")).length,
      oracle_differ_seeded_of_6: x.shown.slice(2).filter((l) => l.startsWith("DIFFER")).length,
      baselines_differ: x.shown.slice(0, 2).filter((l) => l.startsWith("DIFFER")).length,
      errors: x.shown.filter((l) => l.startsWith("ERROR")).length,
      differ_loads: x.shown
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.startsWith("DIFFER"))
        .map(({ l, i }) => `load ${i + 1}: ${l.replace(/ \[delivered.*$/, "")}; writes delivered ${(l.match(/(UpdateMemo|UpsertMemoReaction|CreateMemoComment)#\d/g) ?? []).join(", ")}`),
    }));
  }
}
console.log(JSON.stringify(table, null, 2));
