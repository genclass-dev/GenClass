// `genclass fix` (src/fix.mjs): the problems found on the live site, handed to the person's coding agent. Nothing
// starts without a key press, and GenClass itself changes no code.
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { AGENTS, copyText, findAgents, fix, onPath, pickProblem } from "../src/fix.mjs";
import { problemList } from "../src/kinds.mjs";
import { run as runInit } from "../../runtime/bin/lib/init.mjs";
import { ACCOUNT, fakeServer, HOST, isolate, overview, printed, project, SESSION, tempDir, TOKEN, viteApp, write } from "./helpers.js";
import { NOW, plainLines, STATS, tooWide } from "./stats.js";

isolate();

// a terminal someone is at: what they type is written to `input`
const input = new PassThrough();
(input as unknown as { isTTY: boolean }).isTTY = true;
const real = Object.getOwnPropertyDescriptor(process, "stdin")!;
beforeAll(() => Object.defineProperty(process, "stdin", { value: input, configurable: true }));
afterAll(() => Object.defineProperty(process, "stdin", real));
const type = (line: string) => setTimeout(() => input.write(`${line}\n`), 20);

/** A signed-in project folder whose app is the account's, and a server that answers for it. */
async function project1(stats: Record<string, unknown> = STATS) {
  const dir = tempDir();
  viteApp(dir);
  // GenClass added with the app's key, as `npx genclass` leaves it, and its MCP server in the agent's configuration
  await printed(async () => expect(await runInit("init", ["--cwd", dir, "--yes", "--no-install", "--no-network", "--token", TOKEN])).toBe(0));
  write(dir, { ".mcp.json": JSON.stringify({ mcpServers: { genclass: { command: "npx", args: ["-y", "@genclass/mcp"] } } }) });
  saveCredentials({ host: HOST, access_token: SESSION, account: ACCOUNT });
  const server = fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project()] }) }, "GET /api/cli/app": { json: stats } });
  const started: { agent: string; prompt: string; cwd: string }[] = [];
  const copied: string[] = [];
  const deps = {
    fetchFn: server.fetchFn,
    runGit: () => null,
    now: NOW,
    home: tempDir(),
    agents: (only: string | null) => (only && only !== "claude" ? [] : [{ cmd: "claude", name: "Claude Code", args: (p: string) => [p] }]),
    start: async (a: { cmd: string }, prompt: string, cwd: string) => (started.push({ agent: a.cmd, prompt, cwd }), 0),
    copy: async (text: string) => (copied.push(text), true),
  };
  return { dir, deps, started, copied, server };
}

describe("genclass fix: which problem, which agent (src/fix.mjs)", () => {
  it("pickProblem: a number from the list, a kind, its name, or all", () => {
    const list = problemList(STATS.breakdowns);
    expect(pickProblem(list, "1")).toMatchObject({ key: "duplicate" });
    expect(pickProblem(list, "3")).toMatchObject({ key: "text-invisible", check: true });
    expect(pickProblem(list, "stale")).toMatchObject({ key: "stale" });
    expect(pickProblem(list, "Double Submits")).toMatchObject({ key: "duplicate" });
    expect(pickProblem(list, "all")).toBe("all");
    expect(pickProblem(list, "a")).toBe("all");
    for (const none of ["0", "99", "nope", "", null]) expect(pickProblem(list, none)).toBeNull();
  });

  it("an agent is one whose command is on the PATH; --agent picks one by command or name", () => {
    const dir = tempDir();
    write(dir, { claude: "#!/bin/sh\n", notes: "x" });
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(`${dir}/claude`, 0o755);
    expect(onPath("claude", { PATH: `/nonexistent:${dir}` }, "linux")).toBe(`${dir}/claude`);
    // a file that cannot be run is not a command
    expect(onPath("notes", { PATH: dir }, "linux")).toBeNull();
    expect(onPath("codex", { PATH: dir }, "linux")).toBeNull();
    const find = (cmd: string) => (cmd === "codex" || cmd === "gemini" ? `/bin/${cmd}` : null);
    expect(findAgents(null, find).map((a) => a.cmd)).toEqual(["codex", "gemini"]);
    expect(findAgents("gemini", find).map((a) => a.name)).toEqual(["Gemini CLI"]);
    expect(findAgents("Codex", find).map((a) => a.cmd)).toEqual(["codex"]);
    expect(findAgents("claude", find)).toEqual([]);
    // the prompt is one argument, never a shell line
    expect(AGENTS.map(([cmd, , args]) => [cmd, args("P")])).toEqual([["claude", ["P"]], ["codex", ["P"]], ["cursor-agent", ["P"]], ["gemini", ["-i", "P"]]]);
  });

  it("copyText tries the platform's clipboard commands in turn and says whether one took it", async () => {
    const { EventEmitter } = await import("node:events");
    const tried: string[] = [];
    const run = (works: string | null) => ((cmd: string) => {
      tried.push(cmd);
      const child = new EventEmitter() as any;
      child.stdin = { on() {}, end(text: string) { child.got = text; } };
      setImmediate(() => (cmd === works ? child.emit("close", 0) : child.emit("error", new Error("ENOENT"))));
      return child;
    }) as never;
    expect(await copyText("x", "linux", run("xclip"))).toBe(true);
    expect(tried).toEqual(["wl-copy", "xclip"]);
    tried.length = 0;
    expect(await copyText("x", "linux", run(null))).toBe(false);
    expect(tried).toEqual(["wl-copy", "xclip", "xsel"]);
    expect(await copyText("x", "darwin", run("pbcopy"))).toBe(true);
  });
});

describe("genclass fix: the command (src/fix.mjs fix)", () => {
  it("--print gives the prompt and nothing else, for one kind or for all; an unknown one says what there is", async () => {
    const { dir, deps, started } = await project1();
    const one = await printed(async () => expect(await fix({ cwd: dir, what: "stale", print: true }, deps)).toBe(0));
    expect(one.startsWith("Fix a problem GenClass found in production in this web app (shop): stale responses, 11 times in the last 7 days")).toBe(true);
    expect(one).not.toContain("────");
    const all = await printed(async () => expect(await fix({ cwd: dir, print: true }, deps)).toBe(0));
    expect(all.startsWith("Fix the problems GenClass found in this web app (shop) and prove each fix")).toBe(true);
    expect(all).toContain("- Double submits, 14 times, on /checkout.");
    const errs: string[] = [];
    const spy = (await import("vitest")).vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => (errs.push(String(s)), true)) as never);
    try {
      expect(await printed(async () => expect(await fix({ cwd: dir, what: "nope", print: true }, deps)).toBe(2))).toBe("");
      expect(errs.join("")).toContain('No problem "nope" in this period.');
    } finally {
      spy.mockRestore();
    }
    expect(started).toEqual([]);
    // as data, for a coding agent that runs the command itself
    const j = JSON.parse(await printed(async () => expect(await fix({ cwd: dir, json: true, what: "2" }, deps)).toBe(0)));
    expect(j.problems.map((p: any) => [p.key, p.name, p.count, p.visual_check])).toContainEqual(["text-invisible", "Invisible text", 6, true]);
    expect(j.prompt).toContain("stale responses, 11 times");
  });

  it("on a terminal: the list, a pick, then Enter starts the agent in the app's folder with the prompt", async () => {
    const { dir, deps, started } = await project1();
    const cols = process.stdout.columns;
    process.stdout.columns = 58;
    try {
      type("2");
      setTimeout(() => type(""), 60);
      const said = await printed(async () => expect(await fix({ cwd: dir }, deps)).toBe(0));
      expect(tooWide(said)).toEqual([]);
      const flat = plainLines(said).join(" ").replace(/\s+/g, " ");
      expect(flat).toContain("What GenClass found on the live site");
      expect(flat).toMatch(/1 Double submits 14 times on \/checkout/);
      expect(flat).toMatch(/3 Invisible text 6 times, visual check on \/pricing/);
      expect(flat).toContain("A prompt for stale responses is ready.");
      expect(flat).toContain("GenClass changes no code: the agent does, with you watching.");
      expect(flat).toContain("Enter start Claude Code");
      expect(flat).toContain("Starting Claude Code in this folder, with the prompt.");
      expect(flat).toContain("Back from Claude Code.");
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ agent: "claude", cwd: dir });
      expect(started[0]!.prompt).toContain("stale responses, 11 times in the last 7 days, on /search (9), /checkout (2).");
    } finally {
      process.stdout.columns = cols;
    }
  });

  it("Enter at the list means all of them; c copies, p prints, q stops; nothing starts on its own", async () => {
    const { dir, deps, started, copied } = await project1();
    type("");
    setTimeout(() => type("c"), 60);
    const said = await printed(async () => expect(await fix({ cwd: dir }, deps)).toBe(0));
    expect(said).toContain("A prompt for all 6 kinds of problem is ready.");
    expect(said).toContain("Copied the prompt.");
    expect(copied[0]).toContain("Fix the problems GenClass found in this web app (shop)");
    type("p");
    expect(await printed(async () => expect(await fix({ cwd: dir, what: "1" }, deps)).toBe(0))).toContain("Fix a problem GenClass found in production in this web app (shop): double submits, 14 times");
    type("q");
    await printed(async () => expect(await fix({ cwd: dir, what: "1" }, deps)).toBe(0));
    expect(started).toEqual([]);
    // --copy asks nothing
    await printed(async () => expect(await fix({ cwd: dir, what: "failing", copy: true }, deps)).toBe(0));
    expect(copied[1]).toContain("failing endpoints, 3 times");
  });

  it("no agent on the machine, another folder's app, an agent that does not start, and nothing to fix", async () => {
    const { dir, deps, copied } = await project1();
    type("");
    const none = await printed(async () => expect(await fix({ cwd: dir, what: "1" }, { ...deps, agents: () => [] })).toBe(0));
    expect(none).toContain("No coding agent's command found on this machine");
    expect(none).not.toContain("Enter start");
    expect(copied).toHaveLength(1);
    // run from a folder that is not the app's: the agent is not started on some other code
    const other = tempDir();
    type("");
    const away = await printed(async () => expect(await fix({ cwd: other, app: "shop", what: "1" }, deps)).toBe(0));
    expect(plainLines(away).join(" ").replace(/\s+/g, " ")).toContain("This folder is not shop's.");
    // the agent's command fails to start: the prompt is printed to paste by hand
    type("");
    const failed = await printed(async () => expect(await fix({ cwd: dir, what: "1" }, { ...deps, start: async () => null })).toBe(1));
    expect(failed).toContain("Claude Code did not start.");
    expect(failed).toContain("Fix a problem GenClass found in production");
    // nothing found in the period
    const clean = await project1({ ...STATS, totals: { sessions: 10 }, breakdowns: {} });
    expect(await printed(async () => expect(await fix({ cwd: clean.dir }, clean.deps)).toBe(0))).toContain("there is nothing to fix");
  });
});
