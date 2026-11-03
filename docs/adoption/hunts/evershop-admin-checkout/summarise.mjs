// Summarises hunt.mjs output directories (docs/adoption/hunts/evershop-admin-checkout.md section 3). Not part of CI.
//
//   node docs/adoption/hunts/evershop-admin-checkout/summarise.mjs <dir> [<dir> ...] > summary.json
//
// For each <surface>-<slow>.txt: the explore verdict line, and each RACE run sorted by what the report lists for it:
// "page" (page text differs: what a shopper sees), "requests" (only a request count differs), "field" (only a form
// field's presence or value differs), or a mix; next to this harness's own oracle (the page against the server's cart,
// or against Canada's one shipping method), counted over the 6 seeded loads, and the replay's first verdict line.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const out = [];
for (const dir of process.argv.slice(2)) {
  for (const f of readdirSync(dir).filter((x) => /^[a-z-]+-\d+\.txt$/.test(x)).sort()) {
    const [, surface, slow] = /^([a-z-]+)-(\d+)\.txt$/.exec(f);
    const text = readFileSync(join(dir, f), "utf8");
    const loads = [...text.matchAll(/^load (\d+): (STALE|ok) /gm)].map((m) => ({ n: Number(m[1]), stale: m[2] === "STALE" }));
    const verdict = (text.match(/^(RACE: .*?run\(s\)|No race found|No verdict[^.]*)/m) || ["?"])[0];
    const raceBlock = (text.split(/^RACE: [^\n]*\n/m)[1] || "").split(/^(Internal state only|Along the way only|Race finding)/m)[0];
    const runs = raceBlock.split(/^- run /m).slice(1).map((r) => {
      const kinds = new Set();
      if (/page text only/.test(r)) kinds.add("page");
      if (/requests sent to/.test(r)) kinds.add("requests");
      if (/^\s+field "/m.test(r)) kinds.add("field");
      return [...kinds].join("+") || "other";
    });
    const count = (k) => runs.filter((x) => x === k).length;
    const replay = (text.match(/^- r\d+: (.*)$/m) || [null, null])[1];
    out.push({
      variant: dir.replace(/\/+$/, "").split("/").pop(),
      surface,
      slow_ms: Number(slow),
      verdict,
      race_runs: runs.length,
      race_runs_by_kind: Object.fromEntries([...new Set(runs)].map((k) => [k, count(k)])),
      oracle_stale_seeded: `${loads.filter((l) => l.n > 2 && l.stale).length} of ${loads.filter((l) => l.n > 2).length}`,
      oracle_stale_baselines: `${loads.filter((l) => l.n <= 2 && l.stale).length} of ${loads.filter((l) => l.n <= 2).length}`,
      replay,
    });
  }
}
console.log(JSON.stringify(out, null, 1));
