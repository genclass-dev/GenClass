// Summarises the explore sessions hunt.mjs wrote to $HUNT_OUT (one JSON per scenario, latency and variant) into
// docs/adoption/hunts/tandoor-recipes/results.json and the markdown table of the report's section 3. Not part of CI.
//
//   node docs/adoption/hunts/tandoor-recipes/summarise.mjs

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUT } from "./seed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rows = [];
for (const f of readdirSync(OUT).filter((n) => /^[a-z-]+-\d+(-fixed)?\.json$/.test(n))) {
  const r = JSON.parse(readFileSync(join(OUT, f), "utf8"));
  const seeded = r.loads.filter((l) => l.schedule?.order === "seeded");
  const base = r.loads.filter((l) => l.schedule?.order === "fifo");
  const verdict = /^(RACE: \d+ of \d+|No race found|No verdict[^.]*)/m.exec(r.report)?.[1] ?? "?";
  const internal = /^Internal state only[^:]*: (\d+) of (\d+)/m.exec(r.report);
  const along = /^Along the way only[^:]*: (\d+) of (\d+)/m.exec(r.report);
  const compared = /Compared: (\d+) of (\d+)/.exec(r.report);
  rows.push({
    scenario: r.scenario,
    slow_ms: r.slow_ms,
    variant: r.variant,
    verdict,
    internal_only: internal ? Number(internal[1]) : 0,
    along_the_way: along ? Number(along[1]) : 0,
    compared: compared ? `${compared[1]} of ${compared[2]}` : "?",
    oracle_wrong_seeded: `${seeded.filter((l) => l.oracle?.wrong?.length).length} of ${seeded.length}`,
    oracle_wrong_baselines: `${base.filter((l) => l.oracle?.wrong?.length).length} of ${base.length}`,
    oracle_errors: r.loads.filter((l) => l.error).length,
    forced: r.loads.reduce((n, l) => n + (l.snapshot?.forced ?? 0), 0),
    replay: r.replay ? (/REPRODUCED/.test(r.replay.result) ? "reproduced" : /NOT REPRODUCED|not reproduced/i.test(r.replay.result) ? "not reproduced" : "inconclusive") : "none",
    replay_oracle: r.replay?.load?.oracle ? (r.replay.load.oracle.wrong.length ? "wrong" : "correct") : null,
  });
}
const order = ["picker", "search-pages", "list-pages", "shopping-check", "shopping-uncheck"];
rows.sort((a, b) => a.variant.localeCompare(b.variant) * -1 || order.indexOf(a.scenario) - order.indexOf(b.scenario) || a.slow_ms - b.slow_ms);
writeFileSync(join(here, "results.json"), `${JSON.stringify(rows, null, 2)}\n`);
console.log("| scenario | slow_ms | variant | explore verdict | internal only | along the way | own oracle wrong (seeded) | own oracle wrong (baselines) | replay | forced |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.scenario} | ${r.slow_ms} | ${r.variant} | ${r.verdict} (compared ${r.compared}) | ${r.internal_only} | ${r.along_the_way} | ${r.oracle_wrong_seeded} | ${r.oracle_wrong_baselines} | ${r.replay}${r.replay_oracle ? ` (oracle ${r.replay_oracle})` : ""} | ${r.forced} |`);
