// Prints the explore tables of superset-sqllab.md (sections 3.1 and 6) from hunt.mjs's <surface>-summary.json files.
//
//   node docs/adoption/hunts/superset-sqllab/summarise.mjs <dir with *-summary.json> [label]
//
// Per session: the explore verdict, the harness's own oracle (seeded loads whose oracle differs from both baselines'),
// the per-load bug state (autosave and format: 1 = the typed text is not where the user left it; savequery: the
// number of POSTs to /api/v1/saved_query/), and the replay line. Also writes <dir>/results.json, the small summary
// committed with the report.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const label = process.argv[3] ?? "";
if (!dir) throw new Error("usage: summarise.mjs <dir> [label]");
const out = {};
for (const f of readdirSync(dir).filter((n) => n.endsWith("-summary.json")).sort()) {
  const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
  out[s.surface] = s.sessions.map(({ loads, ...rest }) => ({
    ...rest,
    oracle: loads.map((o) => (s.surface === "autosave" ? { puts: o.puts?.length, server: o.server } : s.surface === "format" ? { shown: o.shown } : { posts: o.savedQueryPosts })),
  }));
  console.log(`\n${s.surface}${label ? ` (${label})` : ""}`);
  console.log("| slow_ms | explore verdict | own oracle: seeded loads differing | per load (b1 b2 s1..s6) | replay |");
  console.log("|---|---|---|---|---|");
  for (const x of s.sessions) {
    const replay = (x.replay.match(/(REPRODUCED|not reproduced|inconclusive)[^·]*·?[^.]*/i) ?? [""])[0].trim();
    // format: recomputed from the shown text (the typed text must end the statement), whatever the harness version
    const per = s.surface === "format" ? x.loads.map((o) => (o.shown?.trimEnd().endsWith("-- bravo") ? 0 : 1)) : x.lostOrDuplicated;
    console.log(`| ${x.slow_ms} | ${x.verdict} | ${x.oracleDiffering} | ${per.join(" ")} | ${replay || "none"} |`);
  }
}
writeFileSync(join(dir, "results.json"), JSON.stringify(out, null, 2));
