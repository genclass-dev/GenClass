// Scores this checkout's comparison on explore reports a hunt kept only as text (docs/runtime/RESULTS.md, "explore's verdict on real apps"):
// each report's groups are parsed back into recorded runs (what the report listed per run, over one synthetic baseline)
// and given to compareRuns() from packages/mcp/dist. The harness's own page check is read from the same file's lines
// `load N: DIFFER|same|ERROR ...`.
//
//   node bench/explore/stored.mjs <dir> [--json <file>]
//
// It can only move what a report listed: a run's first 4 page lines per side and first 6 fields. So
//   - a line hidden by those caps stays hidden: runs whose list hit the cap and came out clean are counted `capped`
//     (their verdict is not known from the text), not as cleared;
//   - a baseline that shared a bug, or a difference filed as noise by shape, cannot come back from the text: fixes that
//     need a new load (the baseline with no added delay) or the raw lines are measured on real pages instead;
//   - a report has no send steps, so a POST count here never has "sent directly by a user action" as evidence;
//   - a run's list was cut at 6 fields and 4 lines a side, and a partner filed as noise by the old rule is not listed: so a
//     field with a generated name listed as absent on one side (its partner was noise, or cut) is taken to be there with
//     the same value, and a line that holds a relative time is dropped from a list that hit its cap or a report whose
//     noise holds a relative time. Both are this script's reading of the text, not the comparison: the raw runs a hunt
//     kept check the first (`--raw <state.json>` compares a bridge's recorded runs directly).

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const dir = resolve(args[0] ?? ".");
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const here = new URL(".", import.meta.url);
const { compareRuns, shownField, fieldShape, timeless } = await import(pathToFileURL(resolve(opt("--dist") ?? new URL("../../packages/mcp/dist", here).pathname, "index.js")).href);

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const strings = (s) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));

/** One report's groups as written: its scenario, its noise line and, per listed run, what it listed. */
function parseReport(text) {
  const groups = [];
  let g = null;
  let section = null;
  let run = null;
  for (const line of text.split("\n")) {
    let m;
    if ((m = /^## (.*?) · (\d+) run\(s\) · scenario/.exec(line))) {
      g = { route: m[1], runs: Number(m[2]), scenario: [], races: 0, compared: 0, listed: [], noVerdict: false };
      groups.push(g);
      section = "scenario";
      run = null;
      continue;
    }
    if (!g) continue;
    if (section === "scenario" && line.startsWith("  ")) {
      g.scenario.push(line.trim());
      continue;
    }
    if ((m = /^RACE: (\d+) of (\d+)/.exec(line))) {
      section = "visible";
      g.races = Number(m[1]);
      g.compared = Number(m[2]);
      continue;
    }
    if ((m = /^No race found: none of the (\d+)/.exec(line))) {
      section = "none";
      g.compared = Number(m[1]);
      continue;
    }
    if (line.startsWith("Ignored as noise") && /\bminutes? ago|\bhours? ago|an hour ago|a minute ago/.test(line)) g.timeNoise = true;
    if (/^(No verdict|Only one baseline|No baseline run)/.test(line)) {
      g.noVerdict = true;
      section = "none";
      continue;
    }
    if (line.startsWith("Internal state only")) {
      section = "internal";
      continue;
    }
    if (line.startsWith("Along the way only")) {
      section = "transient";
      continue;
    }
    if ((m = /^- run (\S+) \((.*?)\)/.exec(line))) {
      run = { id: m[1], label: m[2], tier: section, onlyBase: [], onlyRun: [], fields: [], errors: [], witnesses: [] };
      g.listed.push(run);
      continue;
    }
    if (!run || !line.startsWith("    ")) continue;
    if ((m = /^ {4}page text only in the baseline: (.*)$/.exec(line))) run.onlyBase = strings(m[1]);
    else if ((m = /^ {4}page text only in this run: (.*)$/.exec(line))) run.onlyRun = strings(m[1]);
    else if ((m = /^ {4}(field|state|requests sent to) ("(?:[^"\\]|\\.)*"): baseline ("(?:[^"\\]|\\.)*"), this run ("(?:[^"\\]|\\.)*")/.exec(line))) run.fields.push({ where: m[1] === "requests sent to" ? "requests" : m[1], name: JSON.parse(m[2]), baseline: JSON.parse(m[3]), run: JSON.parse(m[4]) });
    else if ((m = /^ {4}error only here: (.*)$/.exec(line))) run.errors.push(JSON.parse(m[1]));
    else if ((m = /^ {4}witness only here: (.*)$/.exec(line))) run.witnesses.push(m[1]);
  }
  return groups;
}

/** A group's listed runs back into recorded runs: two equal baselines and one run per seed, their lines and fields as listed. */
function runsOf(g, plan) {
  const page = { url: `http://localhost:1${g.route}`, route: g.route };
  const steps = [{ k: "act", i: 0, t: 0, kind: "click", target: 'button "x"' }, ...writes];
  // what the listing's caps and the old noise rule hid: see the header
  for (const r of g.listed) {
    r.capped = r.onlyBase.length >= 4 || r.onlyRun.length >= 4;
    if (r.capped || g.timeNoise) {
      // "Today" has no partner a digit rule could have hidden: a count of those is what the run showed
      const partnerHidden = (l) => timeless(l) !== l && /\d|\bago\b/.test(l);
      r.onlyBase = r.onlyBase.filter((l) => !partnerHidden(l));
      r.onlyRun = r.onlyRun.filter((l) => !partnerHidden(l));
    }
    r.fields = r.fields.filter((f) => !(f.where === "field" && fieldShape(f.name) !== f.name && (f.baseline === "(absent)" || f.run === "(absent)")));
  }
  const count = new Map();
  const fields = new Map();
  for (const r of g.listed) {
    const n = new Map();
    for (const l of r.onlyBase) n.set(l, (n.get(l) ?? 0) + 1);
    for (const [l, c] of n) count.set(l, Math.max(count.get(l) ?? 0, c));
    for (const f of r.fields) if (f.baseline !== "(absent)") fields.set(`${f.where}|${f.name}`, f.baseline);
  }
  const baseText = [...count].flatMap(([l, c]) => Array(c).fill(l));
  const snapshotOf = (r) => {
    const text = [...baseText];
    for (const l of r?.onlyBase ?? []) text.splice(text.indexOf(l), 1);
    text.push(...(r?.onlyRun ?? []));
    const s = { t: 1000, state: {}, text, fields: {}, requests: Object.fromEntries(writes.map((w) => [w.by, 1])), witnesses: 0, errors: 0, forced: 0 };
    const put = (where, name, v) => {
      if (where === "state") s.state[name] = v;
      else if (where === "field") s.fields[name] = v;
      else s.requests[name] = Number(v);
    };
    for (const [k, v] of fields) put(k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1), v);
    for (const f of r?.fields ?? []) {
      if (f.run !== "(absent)") put(f.where, f.name, f.run);
      else if (f.where === "state") delete s.state[f.name];
      else if (f.where === "field") delete s.fields[f.name];
      else delete s.requests[f.name];
    }
    return s;
  };
  const run = (id, order, seed, r) => ({ id, started: 0, lastSeen: 0, page, schedule: { order, ...(seed ? { seed } : {}), label: r?.label }, steps, lost: 0, order: [], forced: 0, witnesses: [], errors: (r?.errors ?? []).map((message) => ({ t: 1, name: "Error", message, chain: [] })), detections: [], interventions: [], checks: [], expectations: [], snapshot: snapshotOf(r), snapshots: 1, ended: true });
  const seeds = plan.map((label, i) => {
    const listed = g.listed.find((r) => r.label === label);
    return run(listed?.id ?? `s${i}`, "seeded", i + 1, listed ?? { label });
  });
  return [run("b1", "fifo"), run("b2", "fifo"), ...seeds];
}

const rows = [];
const files = walk(dir).filter((f) => f.endsWith(".txt"));
// the writes other sites' responses made (a finding's explanation lists them, in some reports of a hunt): the same fields in all
const writes = [...new Map(files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/ write (\S+) by ([A-Z]+ [^\s/]+\.[^\s/]+\/[^\s:#]*)/g)]).map((m) => [m[1], { k: "write", t: 1, store: "x", paths: [m[1]], by: m[2] }])).values()];
if (opt("--raw")) {
  const st = JSON.parse(readFileSync(opt("--raw"), "utf8"));
  const byId = new Map(st.runs.map((r) => [r.id, r]));
  for (const x of st.explores) {
    const runs = x.runs.map((id) => byId.get(id)).filter(Boolean);
    for (const g of compareRuns(runs)) console.log(`${x.id} ${g.route}: compared ${g.compared}, ${g.diffs.map((d) => `${d.label}: ${d.tier}`).join(", ") || "no differences"}; noise ${g.noise.filter((n) => !n.startsWith("state")).slice(0, 6).join(", ")}`);
  }
  process.exit(0);
}
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (!/^Explore x\d+: /m.test(text)) continue;
  const planned = [...text.matchAll(/^ {2}\d+\. (seed \d+)$/gm)].map((m) => m[1]);
  const loads = [...text.matchAll(/^load (\d+): (DIFFER|same|ERROR)/gm)].map((m) => m[2]);
  const oracleOf = (label) => (/^seed (\d+)$/.test(label) ? loads[Number(label.slice(5)) + 1] : undefined);
  const baselineWrong = loads.slice(0, 2).filter((l) => l === "DIFFER").length;
  const groups = parseReport(text);
  const row = { file: relative(dir, file), oracle: loads.map((l) => (l === "DIFFER" ? "D" : l === "ERROR" ? "E" : "s")).join(""), compared: 0, seeds: 0, wrongSeeds: 0, baselineWrong, before: { races: 0, tp: 0, fp: 0, fn: 0 }, after: { races: 0, tp: 0, fp: 0, fn: 0 }, capped: 0, cleared: [], left: [] };
  for (const g of groups) {
    if (g.noVerdict || !g.compared) continue;
    row.compared += g.compared;
    const plan = planned.slice(0, g.compared);
    const report = compareRuns(runsOf(g, plan))[0];
    const raced = new Map((report?.diffs ?? []).filter((d) => d.tier === "visible").map((d) => [d.label, d]));
    for (const label of plan) {
      const o = oracleOf(label);
      const before = g.listed.find((r) => r.label === label);
      const wasRace = before?.tier === "visible";
      const isRace = wasRace && raced.has(label);
      row.seeds++;
      if (o === "DIFFER") row.wrongSeeds++;
      const tally = (t, hit) => {
        if (hit) t.races++;
        if (hit && o === "DIFFER") t.tp++;
        if (hit && o === "same") t.fp++;
        if (!hit && o === "DIFFER") t.fn++;
      };
      tally(row.before, wasRace);
      tally(row.after, isRace);
      if (wasRace && !isRace) {
        if (before.capped) row.capped++;
        row.cleared.push(label);
      }
      if (isRace) {
        const d = raced.get(label);
        row.left.push(...d.textOnlyRun, ...d.textOnlyBaseline, ...d.fields.filter(shownField).map((f) => f.name));
      }
    }
  }
  row.left = [...new Set(row.left)].slice(0, 8);
  rows.push(row);
}
rows.sort((a, b) => a.file.localeCompare(b.file));
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(rows, null, 2));
console.log("| report | page check per load | compared | before: races (true, false, missed) | after: races (true, false, missed) | cleared with a capped list | still listed |");
console.log("|---|---|---|---|---|---|---|");
const cell = (t) => `${t.races} (${t.tp}, ${t.fp}, ${t.fn})`;
for (const r of rows) console.log(`| ${r.file} | ${r.oracle} | ${r.compared} | ${cell(r.before)} | ${cell(r.after)} | ${r.capped} | ${r.left.map((l) => JSON.stringify(l.slice(0, 40))).join(", ")} |`);
