// `genclass remove`: the runtime CLI's remove (the import, the config file, the package), then what this command's
// other steps wrote in the project: GenClass's entry in the agent configuration, the skill, the pull-request
// workflow.
//
// Invariants:
// - Only what GenClass wrote is taken out. The agent configuration keeps every other server and key, and the
//   file is deleted only when GenClass's entry was all it held. The skill goes only while it carries the marker (a
//   file the person made their own stays). The workflow goes only while its text is exactly what this command writes
//   for this project (an edited one stays, and is named).
// - Shown before it is done. --yes does it, a terminal is asked once, --dry-run writes nothing, and without a
//   terminal and without --yes nothing is written.
// - Nothing in the account is touched: the app and what it found stay there.

import { readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { c, interactive, out } from "../../runtime/bin/lib/ui.mjs";
import { SKILL_MARK, SKILL_PATH, workflowFor } from "./actions.mjs";
import { gitInfo } from "./git.mjs";
import { WORKFLOW_PATH } from "./state.mjs";
import { agree, bad, good, note } from "./tui.mjs";

const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * What this command's steps left in the project, as changes to make and files to keep.
 * @param {string} cwd
 * @param {{ runGit?: (args: string[], cwd: string) => string | null }} [deps]
 * @returns {{ changes: { file: string, path: string, kind: "delete" | "modify", after?: string, what: string }[], kept: { file: string, why: string }[] }}
 */
export function planLeftovers(cwd, deps = {}) {
  const changes = [];
  const kept = [];
  // 1. the agent configuration: GenClass's server entry, and the file when that was all it held
  for (const file of [".mcp.json", ".cursor/mcp.json"]) {
    const path = join(cwd, file);
    const text = read(path);
    if (text === null) continue;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const servers = json && typeof json === "object" && !Array.isArray(json) && json.mcpServers && typeof json.mcpServers === "object" && !Array.isArray(json.mcpServers) ? json.mcpServers : null;
    if (!servers || !Object.prototype.hasOwnProperty.call(servers, "genclass")) continue;
    if (!/@genclass\/mcp|genclass-mcp/.test(JSON.stringify(servers.genclass))) {
      kept.push({ file, why: 'its "genclass" entry is not the one this command writes' });
      continue;
    }
    const { genclass: _gone, ...others } = servers;
    const { mcpServers: _old, ...rest } = json;
    const next = Object.keys(others).length ? { ...json, mcpServers: others } : rest;
    if (Object.keys(next).length) changes.push({ file, path, kind: "modify", after: `${JSON.stringify(next, null, 2)}\n`, what: "GenClass's MCP server entry; your other servers stay" });
    else changes.push({ file, path, kind: "delete", what: "GenClass's MCP server was all it held" });
  }
  // 2. the skill, while it is the file this command wrote
  const skill = read(join(cwd, SKILL_PATH));
  if (skill !== null) {
    if (skill.includes(SKILL_MARK)) changes.push({ file: SKILL_PATH, path: join(cwd, SKILL_PATH), kind: "delete", what: "the skill your coding agent follows" });
    else kept.push({ file: SKILL_PATH, why: "you made it your own (its marker line is gone)" });
  }
  // 3. what the coding agent's tools recorded on this machine (.genclass, written by @genclass/mcp when it runs)
  try {
    if (statSync(join(cwd, ".genclass")).isDirectory()) changes.push({ file: ".genclass/", path: join(cwd, ".genclass"), kind: "delete", what: "what the coding agent's tools recorded on this machine" });
  } catch {
    /* no such folder */
  }
  // 4. the pull-request workflow at the repository's root, while it is the text this command writes
  const root = gitInfo(cwd, deps.runGit).root;
  if (root) {
    const path = join(root, WORKFLOW_PATH);
    const text = read(path);
    if (text !== null) {
      const file = relative(cwd, path).split(sep).join("/") || WORKFLOW_PATH;
      if (text === workflowFor(relative(root, cwd).split(sep).join("/"))) changes.push({ file, path, kind: "delete", what: "the pull-request workflow" });
      else if (/genclass-playwright-run|@genclass\/playwright/.test(text)) kept.push({ file, why: "it was edited since this command wrote it; delete it by hand if you no longer want it" });
    }
  }
  return { changes, kept };
}

/** Removes folders that became empty, from `dir` up to (not including) `stop`. */
function prune(dir, stop) {
  for (let d = dir; d.startsWith(stop) && d !== stop; d = dirname(d)) {
    try {
      if (readdirSync(d).length) return;
      rmdirSync(d);
    } catch {
      return;
    }
  }
}

/** The flags of `remove` this file needs; the runtime CLI's command parses its own from the same arguments. */
function flags(args) {
  const o = { yes: false, dryRun: false, cwd: process.cwd() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--cwd" && args[i + 1]) o.cwd = resolve(args[++i]);
    else if (a.startsWith("--cwd=")) o.cwd = resolve(a.slice(6));
  }
  return o;
}

/**
 * `genclass remove`. Exit code 0, or 1 when something could not be removed (or nothing was, for want of a yes).
 * @param {string[]} args
 * @param {{ runtime?: () => Promise<number>, runGit?: (args: string[], cwd: string) => string | null }} [deps]
 */
export async function remove(args, deps = {}) {
  const runtime = deps.runtime ?? (async () => (await import("../../runtime/bin/lib/init.mjs")).run("remove", args));
  if (args.some((a) => a === "--help" || a === "-h")) return runtime();
  const code = await runtime();
  if (code !== 0) return code;
  const o = flags(args);
  const plan = planLeftovers(o.cwd, deps);
  if (!plan.changes.length && !plan.kept.length) return 0;
  out(`  ${c.bold("Also set up by this command")}`);
  for (const ch of plan.changes) out(`    ${ch.kind === "delete" ? c.red("delete") : c.yellow("edit  ")}  ${c.bold(ch.file)}  ${c.gray(ch.what)}`);
  for (const k of plan.kept) out(`    ${c.gray("keep  ")}  ${k.file}  ${c.gray(k.why)}`);
  out();
  if (!plan.changes.length) return 0;
  if (o.dryRun) {
    out(`  ${c.gray("Dry run: nothing was written.")}`);
    out();
    return 0;
  }
  if (!o.yes) {
    if (!interactive()) {
      out(`  Not a terminal, so these were left. Re-run with ${c.bold("--yes")}.`);
      out();
      return 1;
    }
    if (!(await agree("Remove these too?"))) {
      out("  Left as they are.");
      out();
      return 0;
    }
  }
  let failed = false;
  const done = [];
  for (const ch of plan.changes) {
    try {
      if (ch.kind === "delete") {
        // one folder is removed whole: GenClass's own, by its exact name in the project's folder
        rmSync(ch.path, ch.file === ".genclass/" ? { recursive: true } : {});
        prune(dirname(ch.path), o.cwd);
      } else writeFileSync(ch.path, ch.after);
      done.push(ch.file);
    } catch (e) {
      failed = true;
      bad(`Could not ${ch.kind === "delete" ? "delete" : "edit"} ${ch.file}: ${e?.message ?? e}`);
    }
  }
  if (done.length) good(`Removed. ${c.gray(`(${done.join(", ")})`)}`);
  if (done.some((f) => f.endsWith(WORKFLOW_PATH))) note("If the workflow file was committed, commit its removal too.");
  note("Your app stays in your account with what it found. Nothing there was changed.");
  out();
  return failed ? 1 : 0;
}
