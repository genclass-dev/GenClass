// Reduces the explore session files hunt.mjs wrote (one <scenario>-<slow>.json per session, tens of KB each, kept
// out of git) to results.json beside this file: per session the explore verdict, the race-like runs split by what
// differed, GenClass's duplicate-request finding, forced deliveries and this harness's own oracle.
//
//   node docs/adoption/hunts/medusa-admin/summarise.mjs <dir with the session files> [label]
//
// Kinds of difference, read from the report's per-run lines:
//   relative-time  page text that is only a relative time ("12 minutes ago", "less than a minute ago")
//   request-count  "requests sent to ..." (a cache refetching once more or once less)
//   state          "state ..." (discovered component or store fields)
//   page-text      any other page text: a real candidate, read by hand
// The own oracle compares the dialog's quantity inputs and the server's preview after the load with both baselines;
// "order-only" marks a seeded load whose only difference is the order of the actions inside the open order change
// (the same items and quantities).

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
const label = process.argv[3] ?? "unfixed";
const REL = /^(less than a minute ago|\d+ (second|minute|hour|day)s? ago|a minute ago|an hour ago)$/;

function kinds(runBlock) {
  const k = new Set();
  for (const line of runBlock.split("\n").map((l) => l.trim())) {
    const text = /^page text only in (?:the baseline|this run): (.*)$/.exec(line);
    if (text) {
      const parts = [...text[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
      for (const p of parts) k.add(REL.test(p) ? "relative-time" : `page-text: ${p}`);
    } else if (line.startsWith("requests sent to")) k.add("request-count");
    else if (line.startsWith("state ")) k.add("state");
  }
  return [...k];
}

const sessions = [];
for (const f of readdirSync(dir).filter((x) => /^[a-z-]+-\d+\.json$/.test(x)).sort()) {
  const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const r = d.report ?? "";
  const verdict = (/^(RACE: .*|No race found: .*|No verdict.*)$/m.exec(r)?.[1] ?? "no verdict line").split(":")[0];
  const raceSection = r.includes("RACE:") ? r.slice(r.indexOf("RACE:"), r.indexOf("Internal state only") > 0 ? r.indexOf("Internal state only") : r.indexOf("Race finding")) : "";
  const runs = [...raceSection.matchAll(/- run (r\d+) \(seed (\d+)\)[^\n]*\n((?:    [^\n]*\n?)*)/g)].map((m) => ({ run: m[1], seed: Number(m[2]), kinds: kinds(m[3]) }));
  const ended = /RACE: (\d+) of (\d+)/.exec(r);
  const internal = /Internal state only \(not a race by this check\): (\d+) of (\d+)/.exec(r);
  const dup = /- (f\d+) \[duplicate-request\][^\n]*· (\d+)× in (\d+) run\(s\)[^\n]*\n\s+(.*)/.exec(d.findings ?? "");
  const norm = (l) => JSON.stringify({ dom: l.dom?.qty, items: (l.server?.items ?? []).map((i) => ({ ...i, actions: i.actions.split(",").sort().join(",") })) });
  const exact = (l) => JSON.stringify({ dom: l.dom?.qty, server: l.server });
  const fifo = d.loads.filter((l) => l.gc?.schedule?.order === "fifo");
  const seeded = d.loads.filter((l) => l.gc?.schedule?.order === "seeded");
  const baseExact = new Set(fifo.map(exact));
  const baseNorm = new Set(fifo.map(norm));
  sessions.push({
    scenario: d.scenario,
    slow_ms: d.slow_ms,
    label,
    loads: d.loads.length,
    errors: d.loads.filter((l) => l.error).length,
    verdict,
    endedDifferently: ended ? `${ended[1]} of ${ended[2]}` : "0",
    internalOnly: internal ? `${internal[1]} of ${internal[2]}` : "0",
    raceRunKinds: runs.map((x) => `seed ${x.seed}: ${x.kinds.join(", ")}`),
    duplicateRequest: dup ? { id: dup[1], seen: `${dup[2]}x in ${dup[3]} runs`, text: dup[4].trim() } : null,
    forced: d.loads.reduce((n, l) => n + (l.gc?.forced ?? 0), 0),
    ownOracle: {
      baselinesAgree: baseExact.size <= 1,
      seededDiffering: seeded.filter((l) => !baseExact.has(exact(l))).map((l) => `seed ${l.gc.schedule.seed}${baseNorm.has(norm(l)) ? " (order-only)" : ""}`),
    },
    endState: [...new Set(d.loads.map((l) => `${JSON.stringify(l.dom?.qty)} ${l.server?.openChanges?.join(" ")}`))],
  });
}
const out = join(here, "results.json");
const prev = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")).filter((s) => s.label !== label) : [];
writeFileSync(out, JSON.stringify([...prev, ...sessions], null, 1));
for (const s of sessions)
  console.log(
    `| ${s.scenario} | ${s.slow_ms} | ${s.verdict}: ${s.endedDifferently} ended differently, internal only ${s.internalOnly} | ${[...new Set(s.raceRunKinds.flatMap((k) => k.split(": ").slice(1).join(": ").split(", ")))].join("; ") || "-"} | ${s.duplicateRequest ? s.duplicateRequest.seen : "-"} | ${s.ownOracle.seededDiffering.length} of 6${s.ownOracle.seededDiffering.length ? ` (${s.ownOracle.seededDiffering.join(", ")})` : ""} | ${s.forced} | ${s.endState.join(" / ")} |`,
  );
