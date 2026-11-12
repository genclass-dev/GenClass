// `genclass remove` (src/remove.mjs): after the runtime is out, what this command's other steps wrote goes too, and
// nothing a person made their own.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { skillText, SKILL_PATH, workflowFor, writeSkill } from "../src/actions.mjs";
import { planLeftovers, remove } from "../src/remove.mjs";
import { WORKFLOW_PATH } from "../src/state.mjs";
import { isolate, printed, tempDir, viteApp, write } from "./helpers.js";

isolate();

const MCP = { command: "npx", args: ["-y", "@genclass/mcp@0.2.2"] };
const atRoot = (dir: string) => (args: string[]) => (args[0] === "rev-parse" && args[1] === "--show-toplevel" ? dir : null);
const ok = async () => 0;

describe("genclass remove: what this command set up (src/remove.mjs)", () => {
  it("a project with nothing of it has nothing to remove, and the runtime's own answer is the exit code", async () => {
    const dir = tempDir();
    viteApp(dir);
    expect(planLeftovers(dir, { runGit: atRoot(dir) })).toEqual({ changes: [], kept: [] });
    expect(await printed(async () => expect(await remove(["--cwd", dir, "--yes"], { runtime: ok, runGit: atRoot(dir) })).toBe(0))).toBe("");
    // the runtime's remove said no: nothing else is looked at
    write(dir, { ".mcp.json": JSON.stringify({ mcpServers: { genclass: MCP } }) });
    expect(await remove(["--cwd", dir, "--yes"], { runtime: async () => 1, runGit: atRoot(dir) })).toBe(1);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });

  it("takes out the agent entry, the skill and the workflow it wrote, and leaves the folders it emptied", async () => {
    const dir = tempDir();
    viteApp(dir);
    write(dir, { ".mcp.json": `${JSON.stringify({ mcpServers: { genclass: MCP } }, null, 2)}\n`, [WORKFLOW_PATH]: workflowFor("")!, ".github/workflows/ci.yml": "name: ci\n" });
    expect(writeSkill(dir)).toBe("written");
    write(dir, { ".genclass/agent/runs.json": "[]" }); // what the coding agent's tools keep in the project
    const plan = planLeftovers(dir, { runGit: atRoot(dir) });
    expect(plan.kept).toEqual([]);
    expect(plan.changes.map((ch) => `${ch.kind} ${ch.file}`)).toEqual(["delete .mcp.json", `delete ${SKILL_PATH}`, "delete .genclass/", `delete ${WORKFLOW_PATH}`]);
    // a dry run names them and writes nothing
    const dry = await printed(async () => expect(await remove(["--cwd", dir, "--dry-run"], { runtime: ok, runGit: atRoot(dir) })).toBe(0));
    expect(dry).toContain("Also set up by this command");
    expect(dry).toContain("Dry run: nothing was written.");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    // without a terminal and without --yes: nothing is written, and the exit code says so
    expect(await printed(async () => expect(await remove(["--cwd", dir], { runtime: ok, runGit: atRoot(dir) })).toBe(1))).toContain("Re-run with --yes");
    expect(existsSync(join(dir, SKILL_PATH))).toBe(true);
    const said = await printed(async () => expect(await remove([`--cwd=${dir}`, "-y"], { runtime: ok, runGit: atRoot(dir) })).toBe(0));
    expect(said).toContain("Removed.");
    expect(said.replace(/\s+/g, " ")).toContain("Your app stays in your account");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false); // the folders the skill was alone in
    expect(existsSync(join(dir, ".genclass"))).toBe(false);
    expect(existsSync(join(dir, WORKFLOW_PATH))).toBe(false);
    expect(existsSync(join(dir, ".github/workflows/ci.yml"))).toBe(true); // the person's own workflow
    expect(planLeftovers(dir, { runGit: atRoot(dir) })).toEqual({ changes: [], kept: [] });
  });

  it("keeps what is not its own: other servers and keys, an edited skill, an edited workflow, a foreign entry", async () => {
    const dir = tempDir();
    viteApp(dir);
    write(dir, {
      ".mcp.json": JSON.stringify({ mcpServers: { genclass: MCP, other: { command: "node", args: ["x.js"] } }, note: "mine" }),
      ".cursor/mcp.json": JSON.stringify({ mcpServers: { genclass: { command: "my-own-tool" } } }),
      [SKILL_PATH]: skillText().replace(/<!-- genclass:init[^\n]*\n/, ""),
      [WORKFLOW_PATH]: `${workflowFor("")!}# my own step\n`,
      ".claude/settings.json": "{}",
    });
    const plan = planLeftovers(dir, { runGit: atRoot(dir) });
    expect(plan.changes.map((ch) => `${ch.kind} ${ch.file}`)).toEqual(["modify .mcp.json"]);
    expect(plan.kept.map((k) => k.file).sort()).toEqual([".cursor/mcp.json", SKILL_PATH, WORKFLOW_PATH].sort());
    const said = await printed(async () => expect(await remove(["--cwd", dir, "--yes"], { runtime: ok, runGit: atRoot(dir) })).toBe(0));
    expect(said).toContain("keep");
    expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { other: { command: "node", args: ["x.js"] } }, note: "mine" });
    expect(existsSync(join(dir, SKILL_PATH))).toBe(true);
    expect(existsSync(join(dir, WORKFLOW_PATH))).toBe(true);
    expect(existsSync(join(dir, ".cursor/mcp.json"))).toBe(true);
    // a file that is not JSON is not touched or reported
    write(dir, { ".mcp.json": "{ not json" });
    expect(planLeftovers(dir, { runGit: atRoot(dir) }).changes).toEqual([]);
  });

  it("an app below the repository's root: its workflow is the one written for that folder, at the root", async () => {
    const root = tempDir();
    const app = join(root, "apps", "web");
    viteApp(app);
    write(root, { [WORKFLOW_PATH]: workflowFor("apps/web")! });
    const plan = planLeftovers(app, { runGit: atRoot(root) });
    expect(plan.changes.map((ch) => `${ch.kind} ${ch.file}`)).toEqual([`delete ../../${WORKFLOW_PATH}`]);
    // the root's own workflow text is not this folder's: kept, and said
    write(root, { [WORKFLOW_PATH]: workflowFor("")! });
    expect(planLeftovers(app, { runGit: atRoot(root) })).toMatchObject({ changes: [], kept: [{ file: `../../${WORKFLOW_PATH}` }] });
  });
});
