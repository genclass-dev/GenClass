// Summarises hunt.mjs result folders into one small JSON (docs/adoption/hunts/gotify/results.json):
// per surface and latency, GenClass's explore verdict and this harness's own oracle (loads showing the bug).
//
//   node docs/adoption/hunts/gotify/summarise.mjs <results-unfixed dir> <results-fixed dir> > results.json

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// what the harness's own oracle line says when a load shows the bug
const BUG = {
  "nav-during-load": (l) => /spinner=1 rows=0 /.test(l),
  "refresh-twice": (l) => /spinner=1 rows=0 /.test(l),
  "refresh-once": (l) => /spinner=1 rows=0 /.test(l),
  "push-during-load": (l) => !/shown 1x/.test(l),
  "create-app-double": (l) => !/named like the form: 1 /.test(l),
  "create-client-double": (l) => !/named like the form: 1 /.test(l),
  "delete-then-leave": (l) => !/by the server 1x/.test(l),
};

function summarise(dir) {
  const out = [];
  for (const f of readdirSync(dir).filter((f) => /-\d+\.txt$/.test(f)).sort()) {
    const [, surface, slow] = /^(.*)-(\d+)\.txt$/.exec(f);
    const text = readFileSync(join(dir, f), "utf8");
    const loads = [...text.matchAll(/^load (\d+): (.*)$/gm)].map((m) => m[2]);
    const bug = loads.map((l) => BUG[surface](l));
    const verdict = /^RACE: (\d+) of (\d+)/m.exec(text);
    const along = /^Along the way only.*?: (\d+) of (\d+)/m.exec(text);
    out.push({
      surface,
      slow_ms: Number(slow),
      explore: verdict ? `RACE ${verdict[1]} of ${verdict[2]}` : /^No race found/m.test(text) ? "no race" : "no verdict",
      along_the_way: along ? `${along[1]} of ${along[2]}` : null,
      oracle_bug_baselines: `${bug.slice(0, 2).filter(Boolean).length} of 2`,
      oracle_bug_seeded: `${bug.slice(2).filter(Boolean).length} of ${bug.length - 2}`,
      forced: (text.match(/forced/g) ?? []).length,
      race_lines: [...text.matchAll(/^ {4}(state|page text|requests|form)[^\n]*$/gm)].map((m) => m[0].trim().slice(0, 160)).filter((v, i, a) => a.indexOf(v) === i).slice(0, 8),
    });
  }
  return out;
}

const [unfixed, fixed] = process.argv.slice(2);
console.log(JSON.stringify({ unfixed: summarise(unfixed), ...(fixed ? { fixed: summarise(fixed) } : {}) }, null, 2));
