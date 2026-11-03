// Summarises the raw run files of docs/adoption/hunts/vendure-hunt.mjs (its OUT=... JSON) into the small table the
// 2026-11-03 refresh of docs/adoption/hunts/vendure.md commits as vendure-refresh/summary.json. Not part of CI.
//
//   node docs/adoption/hunts/vendure-refresh/summarize.mjs master-nogc.json patch-nogc.json master-gc.json > summary.json
//
// Per run: trials, failed trials, trials that sent the mutation twice, duplicate entities in the database (Create),
// error responses, and, when GenClass was injected, trials with a duplicate-request witness on the mutation; per
// action and gap the same counts, so the report's tables can be checked against the raw rows.

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const out = {};
for (const file of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  const rows = run.rows.filter((r) => !r.failed);
  const count = (rs, f) => rs.filter(f).length;
  const cell = (rs) => ({
    trials: rs.length,
    twoMutations: count(rs, (r) => r.wire >= 2),
    duplicateEntities: rs.some((r) => r.action === "create") ? rs.reduce((a, r) => a + Math.max(0, (r.created ?? 0) - 1), 0) : null,
    trialsWithTwoEntities: rs.some((r) => r.action === "create") ? count(rs, (r) => r.created >= 2) : null,
    genclassDuplicate: run.genclass ? count(rs, (r) => r.genclass > 0) : null,
    genclassFalse: run.genclass ? count(rs, (r) => r.genclass > 0 && r.wire < 2) : null,
  });
  const byActionGap = {};
  for (const r of rows) ((byActionGap[`${r.action} ${r.gap}`] ??= []).push(r));
  const byPage = {};
  for (const r of rows) ((byPage[`${r.action} ${r.entity}`] ??= []).push(r));
  out[basename(file, ".json")] = {
    label: run.label,
    base: run.base,
    latencyMs: run.latency,
    genclass: run.genclass,
    failed: run.rows.length - rows.length,
    errors: [...new Set(rows.flatMap((r) => r.errors ?? []))],
    total: Object.fromEntries(
      [...new Set(rows.map((r) => r.action))].map((a) => [a, cell(rows.filter((r) => r.action === a))]),
    ),
    byActionGap: Object.fromEntries(Object.entries(byActionGap).map(([k, rs]) => [k, cell(rs)])),
    byPage: Object.fromEntries(Object.entries(byPage).map(([k, rs]) => [k, cell(rs)])),
  };
}
console.log(JSON.stringify(out, null, 2));
