// Summarises the hunt's explore sessions (one JSON file per session, written by hunt.mjs explore into HUNT_OUT) into
// docs/adoption/hunts/linkwarden/results.json and prints the report's table rows (docs/adoption/hunts/linkwarden.md,
// section 3). The raw session files stay out of git (each is 0.5 to 3 MB); this summary regenerates from them.
//
//   node docs/adoption/hunts/linkwarden/summarise.mjs [dir]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? process.env.HUNT_OUT ?? "/root/targets/lw-hunt-out";
const order = ["edit-name", "pin-unpin", "theme-twice", "font-size"];
const rows = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
  if (!r.report || !r.loads) continue;
  const verdict =
    /RACE: (\d+) of (\d+)/.exec(r.report)?.slice(1, 3).join(" of ").replace(/^/, "race: ") ??
    (/No race found/.test(r.report) ? "no race" : /No verdict/.test(r.report) ? "no verdict" : "?");
  const internal = /Internal state only[^:]*: (\d+) of (\d+)/.exec(r.report);
  const along = /Along the way only[^:]*: (\d+) of (\d+)/.exec(r.report);
  const compared = /Compared: (\d+) of (\d+)/.exec(r.report);
  const groups = (r.report.match(/^## /gm) ?? []).length;
  const unsafe = (l) => (l.snapshot?.order ?? []).filter((k) => /^(PUT|POST|DELETE|PATCH) /.test(k)).map((k) => k.replace(/^(\w+) \/api\/v1\/(\S+?)#(\d+)$/, "$1 $2#$3"));
  rows.push({
    scenario: r.scenario,
    slow_ms: r.slow_ms,
    seeds: `${r.seed ?? 1}-${(r.seed ?? 1) + r.runs - 1}`,
    variant: r.variant ?? "unfixed",
    verdict,
    compared: compared ? `${compared[1]} of ${compared[2]}` : null,
    groups,
    internalOnly: internal ? Number(internal[1]) : 0,
    alongTheWay: along ? Number(along[1]) : 0,
    oracleDiffering: r.oracle?.seededDiffering?.map((d) => d.seed) ?? [],
    baselinesAgree: r.oracle?.baselinesAgree ?? null,
    forced: r.loads.reduce((n, l) => n + (l.snapshot?.forced ?? 0), 0),
    errors: r.loads.filter((l) => l.error).length,
    staleWriteFindings: (r.findings?.match(/\[stale-write\]/g) ?? []).length,
    replay: r.replay?.result ? (/REPRODUCED/.test(r.replay.result) ? "reproduced" : /not reproduced/i.test(r.replay.result) ? "not reproduced" : "inconclusive") : null,
    loads: r.loads.map((l) => ({
      schedule: l.schedule?.seed !== undefined ? `seed ${l.schedule.seed}` : l.schedule?.order,
      writes: unsafe(l).join(" → "),
      shown: l.oracle,
      server: l.server ? { name: l.server.name, pinned: l.server.pinned, theme: l.server.theme, fontSize: l.server.fontSize } : null,
      ms: l.ms,
    })),
  });
}
rows.sort((a, b) => order.indexOf(a.scenario) - order.indexOf(b.scenario) || a.variant.localeCompare(b.variant) || a.slow_ms - b.slow_ms || a.seeds.localeCompare(b.seeds));
writeFileSync(join(here, "results.json"), JSON.stringify(rows, null, 1) + "\n");
for (const variant of ["unfixed", "fixed"]) {
  console.log(`\n${variant}:\n`);
  console.log("| scenario | slow_ms | seeds | explore verdict | compared | internal only | DOM+server oracle: seeded loads differing | replay | stale-write findings | forced | load errors |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows.filter((x) => x.variant === variant))
    console.log(`| ${r.scenario} | ${r.slow_ms} | ${r.seeds} | ${r.verdict} | ${r.compared ?? "-"} | ${r.internalOnly} | ${r.oracleDiffering.length} of 6${r.oracleDiffering.length ? ` (seeds ${r.oracleDiffering.join(", ")})` : ""}${r.baselinesAgree === false ? ", baselines differ" : ""} | ${r.replay ?? "-"} | ${r.staleWriteFindings} | ${r.forced} | ${r.errors} |`);
}
