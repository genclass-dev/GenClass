// Summarises the Navidrome hunt's raw explore output (hunt.mjs writes <scenario>-<slow>[-mirror][-<variant>].json to
// HUNT_OUT) into results.json next to this file and a markdown table on stdout (docs/adoption/hunts/navidrome.md,
// section 3). Not part of CI.
//
//   node docs/adoption/hunts/navidrome/summarise.mjs [HUNT_OUT]
//
// Per session: explore's own verdict reduced to counts (the primary result), this harness's DOM oracle (secondary:
// a seeded load "differs" when the oracle says the page disagrees with the server, or, for search, when a row does not
// match the final query), the replay of the session's first finding, and the forced deliveries.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? process.env.HUNT_OUT ?? join(homedir(), "targets/nd-hunt/out");

const count = (re, s) => {
  const m = re.exec(s);
  return m ? `${m[1]} of ${m[2]}` : null;
};
const rows = [];
for (const f of readdirSync(OUT).filter((x) => x.endsWith(".json")).sort()) {
  const d = JSON.parse(readFileSync(join(OUT, f), "utf8"));
  if (!d.loads) continue;
  const m = /^(.+?)-(\d+)(-mirror)?(?:-(\w+))?\.json$/.exec(f);
  const r = d.report ?? "";
  const seeded = d.loads.filter((l) => l.schedule?.order === "seeded");
  const fifo = d.loads.filter((l) => l.schedule?.order === "fifo");
  // search has no server-side truth to compare with (the server's full-text search matches words, so the rows of
  // "Track 1 of album 2" include "Track 2 of album 1"): its oracle is "the same rows as the first baseline"
  if (d.scenario === "search") for (const l of d.loads) l.ok = JSON.stringify(l.oracle?.shown) === JSON.stringify(fifo[0]?.oracle?.shown);
  const puts = (l) => (l.snapshot?.order ?? []).filter((k) => /tracks\/:id/.test(k)).length;
  rows.push({
    scenario: d.scenario,
    slow_ms: d.slow_ms,
    mirror: !!m?.[3],
    variant: m?.[4] ?? "unfixed",
    verdict: /RACE:/.test(r)
      ? `race in ${count(/RACE: (\d+) of (\d+)/, r)}`
      : /No race found/.test(r)
        ? "no race"
        : /No verdict/.test(r)
          ? "no verdict"
          : "?",
    compared: count(/Compared: (\d+) of (\d+)/, r),
    internalOnly: count(/Internal state only[^:]*: (\d+) of (\d+)/, r),
    alongTheWay: count(/Along the way only[^:]*: (\d+) of (\d+)/, r),
    groups: (r.match(/^## /gm) ?? []).length,
    oracleBaselinesDiffer: fifo.filter((l) => l.ok === false).length,
    oracleSeededDiffer: seeded.every((l) => l.error) ? "n/a (steps failed)" : `${seeded.filter((l) => l.ok === false).length} of ${seeded.filter((l) => !l.error).length}`,
    seedsDiffering: seeded.filter((l) => l.ok === false).map((l) => l.schedule.seed),
    errors: d.loads.filter((l) => l.error).length,
    forced: d.loads.reduce((n, l) => n + (l.snapshot?.forced ?? 0), 0),
    ...(d.scenario === "reorder" ? { putsPerLoad: d.loads.map(puts) } : {}),
    replay: /NOT REPRODUCED/i.test(d.replay ?? "") ? "not reproduced" : /REPRODUCED/.test(d.replay ?? "") ? "reproduced" : d.finding ? "inconclusive" : "none",
  });
}
writeFileSync(join(here, "results.json"), `${JSON.stringify(rows, null, 2)}\n`);
console.log("| scenario | variant | slow_ms | mirror | explore verdict | compared | internal only | along the way | DOM oracle: seeded differing (seeds) | baselines differing | replay | forced | errors |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const x of rows)
  console.log(
    `| ${x.scenario} | ${x.variant} | ${x.slow_ms} | ${x.mirror ? "yes" : "no"} | ${x.verdict} | ${x.compared ?? "-"} | ${x.internalOnly ?? "0"} | ${x.alongTheWay ?? "0"} | ${x.oracleSeededDiffer}${x.seedsDiffering.length ? ` (${x.seedsDiffering.join(", ")})` : ""} | ${x.oracleBaselinesDiffer} | ${x.replay} | ${x.forced} | ${x.errors} |`,
  );
