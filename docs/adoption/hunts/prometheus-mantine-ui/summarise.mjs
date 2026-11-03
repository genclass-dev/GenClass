// Summarises results/*.json (written by hunt.mjs) into the report's results table and summaries/sessions.json.
//
//   node docs/adoption/hunts/prometheus-mantine-ui/summarise.mjs
//
// One row per explore session or plain run: the explore verdict as reported (first line), what it said differed,
// how many loads the harness's own oracle found equal to the reference load, and the responses the schedule released
// only because their hold ran out ("forced", per load, summed).

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "results");
const order = ["tree", "table", "graph", "format", "targets", "sd", "delete"];
const rows = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ f, d: JSON.parse(readFileSync(join(dir, f), "utf8")) }))
  .sort((a, b) => order.indexOf(a.d.scenario) - order.indexOf(b.d.scenario) || (a.d.plain - b.d.plain) || (a.d.slow_ms ?? 0) - (b.d.slow_ms ?? 0));

const verdictOf = (report) => {
  if (!report) return "n/a (no GenClass)";
  const race = /RACE: ([^\n]+)/.exec(report);
  if (race) return `RACE: ${race[1]}`.slice(0, 80);
  const none = /No race found: none of the (\d+) compared/.exec(report);
  if (none) return `no race, 0 of ${none[1]}`;
  return report.split("\n").find((l) => /race|Compared/i.test(l))?.slice(0, 80) ?? "?";
};
const internalOf = (report) => {
  if (!report) return "";
  const m = /Internal state only[^:]*: (\d+) of (\d+)/.exec(report);
  const lines = [...report.matchAll(/^\s+(requests sent to [^\n]+|store [^\n]+|announcement[^\n]+)$/gm)].map((x) => x[1]);
  return m ? `internal only in ${m[1]} of ${m[2]}: ${[...new Set(lines.map((l) => l.replace(/baseline "\d+", this run "\d+"/, "count differs")))].join("; ")}` : "";
};
const differs = (report) => {
  if (!report) return "";
  const noise = /Ignored as noise[^:]*: ([^\n]+)/.exec(report);
  return noise ? `noise ignored: ${noise[1]}` : "";
};

const out = [];
out.push("| scenario | mode | explore verdict (as reported) | other lines in the report | oracle: loads equal to the reference | forced holds | file |");
out.push("|---|---|---|---|---|---|---|");
const sessions = [];
for (const { f, d } of rows) {
  const same = d.loads.filter((l) => l.same).length;
  const forced = d.loads.reduce((a, l) => a + (l.agent?.forced ?? 0), 0);
  const held = d.loads.reduce((a, l) => a + (l.held?.length ?? 0), 0);
  const mode = d.plain ? `plain, superseded request held ${d.delay_ms} ms (${held} held)` : `explore ${d.slow_ms} ms`;
  const other = [internalOf(d.report), differs(d.report)].filter(Boolean).join("; ");
  const errors = d.loads.filter((l) => l.error || l.pageErrors?.length).length;
  out.push(`| ${d.scenario} | ${mode} | ${verdictOf(d.report)} | ${other || "-"} | ${same} of ${d.loads.length}${errors ? ` (${errors} with errors)` : ""} | ${d.plain ? "-" : forced} | \`${f}\` |`);
  sessions.push({ file: f, scenario: d.scenario, plain: d.plain, slow_ms: d.slow_ms, delay_ms: d.delay_ms, loads: d.loads.length, oracleSame: same, verdict: verdictOf(d.report), other, forced: d.plain ? null : forced, held, errors });
}
mkdirSync(join(here, "summaries"), { recursive: true });
writeFileSync(join(here, "summaries", "sessions.json"), JSON.stringify(sessions, null, 2));
console.log(out.join("\n"));
