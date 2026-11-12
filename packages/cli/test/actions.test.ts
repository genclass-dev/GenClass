// What the guided setup writes and how it looks (src/actions.mjs, src/tui.mjs, src/git.mjs, src/cli.mjs): the
// workflow file, the agent configuration, cleaned text, git remotes and the command line.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_FILE as COLLECTOR_WORKFLOW } from "../../../telemetry-worker/src/github/workflow-file.js";
import { addWorkflow, connectAgent, connectGithubApp, mcpServer, planAgentConfig, runtimeArgs, workflowFor } from "../src/actions.mjs";
import { BUILD, WORKFLOW_FILE } from "../src/assets.mjs";
import { parseArgs, run, USAGE } from "../src/cli.mjs";
import { githubName, gitInfo } from "../src/git.mjs";
import { WORKFLOW_PATH } from "../src/state.mjs";
import { ago, checklist, clean, summary, visible, wrap } from "../src/tui.mjs";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { ACCOUNT, fakeServer, HOST, isolate, printed, SESSION, tempDir, viteApp, write } from "./helpers.js";

isolate();

const repo = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const ESC = String.fromCharCode(27);

describe("genclass: the one workflow file (src/assets.mjs, src/actions.mjs workflowFor)", () => {
  it("is the docs file, character for character, and the same text the GitHub App links to", () => {
    expect(WORKFLOW_FILE).toBe(readFileSync(repo("docs/github-app/workflows/genclass.yml"), "utf8"));
    expect(WORKFLOW_FILE).toBe(COLLECTOR_WORKFLOW);
    expect(WORKFLOW_PATH).toBe(".github/workflows/genclass.yml");
    expect(workflowFor("")).toBe(WORKFLOW_FILE);
  });

  it("for an app below the repository's root, the job runs in its folder and uploads from it; a folder name it cannot use gives no file", () => {
    const sub = workflowFor("apps/web")!;
    expect(sub).toContain("    timeout-minutes: 45\n    defaults:\n      run:\n        working-directory: apps/web\n    steps:\n");
    expect(sub).toContain("          path: apps/web/test-results/genclass\n");
    expect(sub.split("\n").length).toBe(WORKFLOW_FILE.split("\n").length + 3);
    // nothing else changed
    expect(sub.replace("    defaults:\n      run:\n        working-directory: apps/web\n", "").replace("apps/web/test-results", "test-results")).toBe(WORKFLOW_FILE);
    for (const bad of ["../x", "a/../b", "a b", "a\nb: c", "a/./b", "a//b", "$(rm -rf)", "x".repeat(201)]) expect(workflowFor(bad), bad).toBeNull();
  });

  it("is written at the repository's root with --yes, never over a file that is there, and nothing is committed", async () => {
    const dir = tempDir();
    viteApp(dir);
    const state = { cwd: dir, git: { root: dir, github: null }, workflows: [] } as never;
    const out = await printed(async () => expect(await addWorkflow(state, { yes: true })).toBe("done"));
    expect(readFileSync(join(dir, WORKFLOW_PATH), "utf8")).toBe(WORKFLOW_FILE);
    expect(out).toContain("new file");
    expect(out).toContain(`git add ${WORKFLOW_PATH} && git commit -m "Add GenClass to pull requests" && git push`);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    // a second time the file is there: it is left alone
    write(dir, { [WORKFLOW_PATH]: "mine\n" });
    const again = await printed(async () => expect(await addWorkflow(state, { yes: true })).toBe("skipped"));
    expect(again).toContain("already there");
    expect(readFileSync(join(dir, WORKFLOW_PATH), "utf8")).toBe("mine\n");
    // without a terminal and without --yes nothing is written
    const other = tempDir();
    viteApp(other);
    const st = { cwd: other, git: { root: other, github: null }, workflows: [] } as never;
    await printed(async () => expect(await addWorkflow(st, {})).toBe("skipped"));
    expect(existsSync(join(other, WORKFLOW_PATH))).toBe(false);
    // on a terminal the step's Enter is the yes: the walk passes it on, and the file is written without a second question
    await printed(async () => expect(await addWorkflow(st, { confirmed: true })).toBe("done"));
    expect(readFileSync(join(other, WORKFLOW_PATH), "utf8")).toBe(WORKFLOW_FILE);
  });

  it("the GitHub App: without a terminal nothing is opened or waited for, and the two links are printed", async () => {
    const dir = tempDir();
    viteApp(dir);
    const state = { cwd: dir, git: { root: dir, github: "acme/shop" } } as never;
    // signed out, or no GitHub repository: nothing to do
    expect(await connectGithubApp(state, {})).toBe("skipped");
    saveCredentials({ host: HOST, access_token: SESSION, account: ACCOUNT });
    expect(await connectGithubApp({ cwd: dir, git: { root: dir, github: null } } as never, {})).toBe("skipped");
    const answer = (over: Record<string, unknown>) => ({ "GET /api/cli/github": { json: { repo: "acme/shop", known: true, installed: false, evidence: false, prs: 0, last: null, private: false, needs_plan: false, paused: false, connect_url: `${HOST}/github/connect`, install_url: `${HOST}/github/install`, ...over } } });
    const ask = async (routes: Parameters<typeof fakeServer>[0], o = {}) => {
      const server = fakeServer(routes);
      vi.stubGlobal("fetch", server.fetchFn);
      try {
        let result = "";
        const said = await printed(async () => (result = await connectGithubApp(state, o)));
        return { result, said, calls: server.calls };
      } finally {
        vi.unstubAllGlobals();
      }
    };
    const not = await ask(answer({}));
    expect(not.result).toBe("skipped");
    expect(not.said).toContain(`${HOST}/github/install`);
    expect(not.said).toContain("Continue with GitHub");
    expect(not.calls.map((c) => `${c.path}${c.query}`)).toEqual(["/api/cli/github?repo=acme%2Fshop"]);
    // already on the repository: done, with one request
    const on = await ask(answer({ installed: true }), { yes: true });
    expect([on.result, on.calls.length]).toEqual(["done", 1]);
    expect(on.said).toContain("The GenClass GitHub App is on acme/shop.");
    // a genclass.dev without the route says where to look in the browser
    const older = await ask({});
    expect(older.result).toBe("skipped");
    expect(older.said).toContain(`${HOST}/account/github`);
  });
});

describe("genclass: nothing is drawn on a page (src/actions.mjs runtimeArgs)", () => {
  it("the runtime is added without the developer overlay, and what init then writes has no overlay line", async () => {
    const dir = tempDir();
    viteApp(dir);
    const fresh = { cwd: dir, signedIn: true, steps: [{ id: "runtime", run: "genclass init" }] } as never;
    expect(runtimeArgs(fresh, { yes: true })).toEqual({ cmd: "init", args: ["--cwd", dir, "--yes", "--in-account", "--no-devtools"] });
    expect(runtimeArgs({ cwd: dir, signedIn: false, steps: [{ id: "runtime", run: "genclass init" }] } as never, {})).toEqual({ cmd: "init", args: ["--cwd", dir, "--no-devtools"] });
    // an app that already has the runtime is only put in the account: nothing in its code is touched
    expect(runtimeArgs({ cwd: dir, signedIn: true, steps: [{ id: "runtime", run: "genclass connect" }] } as never, {})).toEqual({ cmd: "connect", args: ["--cwd", dir, "--in-account"] });
    // init with those arguments: one import, and no line that mounts anything
    const { run: runInit } = await import("../../runtime/bin/lib/init.mjs");
    await printed(async () => expect(await runInit("init", ["--cwd", dir, "--yes", "--no-install", "--no-network", "--no-telemetry", "--no-devtools"])).toBe(0));
    const entry = readFileSync(join(dir, "src/main.jsx"), "utf8");
    expect(entry).toContain('import "@genclass/runtime/auto"');
    expect(entry).not.toMatch(/devtools|mountDevtools/);
    expect(readFileSync(join(dir, "index.html"), "utf8")).not.toMatch(/devtools|genclass/i);
  });
});

describe("genclass: the coding agent's configuration (src/actions.mjs planAgentConfig)", () => {
  it("adds GenClass's MCP server at the version this CLI was built with, and keeps what is there", async () => {
    expect(mcpServer()).toEqual({ command: "npx", args: ["-y", `@genclass/mcp@${JSON.parse(readFileSync(repo("packages/mcp/package.json"), "utf8")).version}`] });
    const dir = tempDir();
    viteApp(dir);
    const fresh = planAgentConfig(dir);
    expect(fresh.file).toBe(".mcp.json");
    expect(fresh.change).toMatchObject({ kind: "create", before: "" });
    expect(JSON.parse(fresh.change!.after)).toEqual({ mcpServers: { genclass: mcpServer() } });
    // an existing file keeps its servers and its other keys
    write(dir, { ".mcp.json": JSON.stringify({ mcpServers: { other: { command: "x" }, genclass: { command: "old" } }, extra: 1 }) });
    const merged = planAgentConfig(dir);
    expect(merged.change!.kind).toBe("modify");
    expect(JSON.parse(merged.change!.after)).toEqual({ mcpServers: { other: { command: "x" }, genclass: mcpServer() }, extra: 1 });
    // a project that uses Cursor and has no .mcp.json gets Cursor's file
    const cur = tempDir();
    write(cur, { ".cursor/rules.md": "x" });
    expect(planAgentConfig(cur).file).toBe(".cursor/mcp.json");
    // a file that is not a JSON object is left alone, and the person is told what to add
    for (const text of ["{ not json", "[1, 2]", '"text"']) {
      const d = tempDir();
      write(d, { ".mcp.json": text });
      expect(planAgentConfig(d)).toMatchObject({ change: null });
      const said = await printed(async () => expect(await connectAgent({ cwd: d } as never, { yes: true })).toBe("skipped"));
      expect(said).toContain('"genclass": {"command":"npx"');
      expect(readFileSync(join(d, ".mcp.json"), "utf8")).toBe(text);
    }
    // --yes writes it
    const w = tempDir();
    await printed(async () => expect(await connectAgent({ cwd: w } as never, { yes: true })).toBe("done"));
    expect(JSON.parse(readFileSync(join(w, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { genclass: mcpServer() } });
  });
});

describe("genclass: text and git helpers (src/tui.mjs, src/git.mjs)", () => {
  it("clean() takes escape sequences and control characters out of text that came from elsewhere", () => {
    expect(clean(`ok${ESC}[31m red${ESC}[0m ${ESC}]0;title\u0007 a\r\nb\tc ${String.fromCharCode(0x9b)}2J`)).toBe("ok red 0;title a b c");
    expect(clean(`line${String.fromCharCode(0x2028)}two${String.fromCharCode(0)}`)).toBe("line two");
    expect(clean("x".repeat(500), 20)).toBe(`${"x".repeat(19)}…`);
    expect(clean(null)).toBe("");
    expect(clean(42)).toBe("42");
    expect(visible(`${ESC}[1mbold${ESC}[22m`)).toBe(4);
  });

  it("the short view is at most one line per kind of thing; the full list has one line per part", async () => {
    const steps = [
      { title: "Account", doing: "Sign in", state: "done", detail: "ada@example.com" },
      { title: "Runtime", doing: "Add GenClass to this app", state: "done", detail: "added" },
      { title: "Dashboard", doing: "See your first page", state: "waiting", detail: "deploy, then open your site once" },
      { title: "Test workflow", doing: "Add the test workflow", state: "next", detail: "Playwright found" },
      { title: "GitHub App", doing: "Connect the GitHub App", state: "todo", detail: "after the test workflow" },
      { title: "Coding agent", doing: "Connect your coding agent", state: "todo", detail: "" },
      { title: "Suggestions", doing: "See what your app is missing", state: "optional", detail: "" },
    ];
    const short = (await printed(() => summary(steps))).trimEnd().split("\n");
    expect(short.map((l) => l.replace(/\s+/g, " ").trim().split(" ").slice(1).join(" "))).toEqual(["Done Account • Runtime", "Next Add the test workflow", "Waiting Dashboard: deploy, then open your site once", "Later GitHub App • Coding agent"]);
    const full = (await printed(() => checklist(steps))).trimEnd().split("\n");
    expect(full).toHaveLength(7);
    expect(full[3]).toContain("Test workflow");
    // nothing done, nothing waiting: two lines
    expect((await printed(() => summary([{ title: "Account", doing: "Sign in", state: "next" }, { title: "Runtime", state: "todo" }]))).trimEnd().split("\n")).toHaveLength(2);
  });

  it("wrap() and ago() are plain", () => {
    expect(wrap("one two three four five", 9)).toEqual(["one two", "three", "four five"]);
    expect(wrap("a\nb", 20)).toEqual(["a", "b"]);
    const now = Date.parse("2026-11-12T12:00:00Z");
    expect([ago("2026-11-12T11:59:30Z", now), ago("2026-11-12T11:50:00Z", now), ago("2026-11-12T09:00:00Z", now), ago("2026-11-11T12:00:00Z", now), ago("2026-09-01T00:00:00Z", now), ago("nope", now)]).toEqual(["just now", "10 minutes ago", "3 hours ago", "1 day ago", "2 months ago", ""]);
  });

  it("a GitHub remote gives owner/name in every form git writes it; anything else gives none", () => {
    for (const r of ["https://github.com/acme/shop.git", "https://github.com/acme/shop", "https://user@github.com/acme/shop.git", "git@github.com:acme/shop.git", "ssh://git@github.com/acme/shop", "git://github.com/acme/shop.git", "https://GitHub.com/acme/shop/"]) expect(githubName(r), r).toBe("acme/shop");
    expect(githubName("git@github.com:Acme-Inc/web.app.git")).toBe("Acme-Inc/web.app");
    for (const r of ["", null, "https://gitlab.com/acme/shop.git", "https://github.com/acme", "https://github.com/acme/shop/extra", "git@github.com:acme/..", "https://evil.example/github.com/acme/shop", "https://github.com.evil.example/acme/shop"]) expect(githubName(r as never), String(r)).toBeNull();
    const dir = tempDir();
    expect(gitInfo(dir, () => null)).toEqual({ repo: false, root: null, remote: null, github: null, branch: null });
    expect(gitInfo(dir, (a) => (a[1] === "--show-toplevel" ? dir : a[0] === "remote" ? "git@github.com:acme/shop.git" : "HEAD"))).toEqual({ repo: true, root: dir, remote: "git@github.com:acme/shop.git", github: "acme/shop", branch: null });
  });
});

describe("genclass: the command line (src/cli.mjs, src/main.mjs)", () => {
  it("parses its own flags and leaves the rest for the command", () => {
    expect(parseArgs(["--yes", "--cwd", "/x", "--json", "https://a.example", "--other"])).toEqual({ o: { yes: true, cwd: "/x", json: true }, rest: ["https://a.example", "--other"] });
    expect(parseArgs(["--cwd=/y", "-y", "--no-browser", "--no-model", "--all"])).toEqual({ o: { cwd: "/y", yes: true, noBrowser: true, noModel: true, all: true }, rest: [] });
    expect(parseArgs(["--cwd"]).error).toBe("--cwd needs a value");
  });

  it("help, the version and an unknown command", async () => {
    expect(await printed(async () => expect(await run(["--help"])).toBe(0))).toContain(USAGE);
    expect(await printed(async () => expect(await run(["version"])).toBe(0))).toBe(`genclass ${BUILD.version} (installs @genclass/runtime ${BUILD.runtimeVersion}, @genclass/mcp ${BUILD.mcpVersion})\n`);
    expect(await run(["frobnicate"])).toBe(2);
    expect(await run(["status", "--frob"])).toBe(2);
    expect(USAGE).not.toMatch(/[—–]/);
  });

  it("the real entry names itself to the runtime CLI's modules: its commands say genclass, not the runtime package", () => {
    const dir = tempDir();
    viteApp(dir);
    const env = { ...process.env, NO_COLOR: "1", GENCLASS_HOST: "" };
    const main = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
    const status = execFileSync(process.execPath, [main, "status", "--cwd", dir], { env, encoding: "utf8" });
    expect(status).toContain("GenClass");
    expect(status).toContain("shop");
    expect(status).toContain("Next  Sign in");
    expect(status).toContain("Later    Runtime");
    expect(status).toContain("Every part: genclass status --all");
    // the full list on request: every part of GenClass by name
    const all = execFileSync(process.execPath, [main, "status", "--all", "--cwd", dir], { env, encoding: "utf8" });
    for (const part of ["Account", "Runtime", "Dashboard", "Test workflow", "GitHub App", "Coding agent", "Suggestions"]) expect(all, part).toContain(part);
    expect(all).not.toContain("Every part:");
    expect(status).toContain("Run genclass login");
    // a command handed to the runtime CLI's own code prints this command's name
    // (signed out, whoami says how to sign in and exits 1)
    const ran = spawnSync(process.execPath, [main, "whoami"], { env, encoding: "utf8" });
    const who = `${ran.stdout}${ran.stderr}`;
    expect(ran.status).toBe(1);
    expect(who).toContain("npx genclass login");
    expect(who).not.toContain("@genclass/runtime");
    const json = JSON.parse(execFileSync(process.execPath, [main, "status", "--json", "--cwd", dir], { env, encoding: "utf8" }));
    expect(json.next).toMatchObject({ id: "account", run: "genclass login" });
    // without a terminal, `genclass` alone changes nothing and prints the checklist
    const bare = execFileSync(process.execPath, [main, "--cwd", dir], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(bare).toContain("Next  Sign in");
    // the art is for a terminal only: nothing piped holds it
    expect(bare).not.toContain("█");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  });
});
