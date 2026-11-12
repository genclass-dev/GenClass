// Where a project stands (src/state.mjs): each of the six steps is read from what is on disk and what genclass.dev
// answers, and there is exactly one next step.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { run as runInit } from "../../runtime/bin/lib/init.mjs";
import { agentConfigs, genclassWorkflows, hasPlaywright, readState, stateJson, WORKFLOW_PATH } from "../src/state.mjs";
import { saveNotes } from "../src/store.mjs";
import { ACCOUNT, fakeServer, HOST, isolate, overview, printed, project, SESSION, tempDir, TOKEN, viteApp, write } from "./helpers.js";

isolate();

const signIn = () => saveCredentials({ host: HOST, access_token: SESSION, account: ACCOUNT });
/** A git answer for a repository on GitHub whose root is `root`. */
const onGithub = (root: string, name = "acme/shop") => (args: string[]) => (args[0] === "rev-parse" && args[1] === "--show-toplevel" ? root : args[0] === "remote" ? `git@github.com:${name}.git` : args[1] === "--abbrev-ref" ? "main" : null);
const noGit = () => null;
const states = (s: Awaited<ReturnType<typeof readState>>) => Object.fromEntries(s.steps.map((x) => [x.id, x.state]));
/** Adds the runtime the way the guided setup does: the runtime CLI's own init, with a token and nothing installed. */
const addRuntime = async (dir: string) => {
  let code = -1;
  await printed(async () => (code = await runInit("init", ["--cwd", dir, "--yes", "--no-install", "--no-network", "--token", TOKEN])));
  expect(code).toBe(0);
};

describe("genclass: the state of a project (src/state.mjs header)", () => {
  it("a folder that is no web app says so, and signing in is still the next step", async () => {
    const dir = tempDir();
    const s = await readState({ cwd: dir }, { runGit: noGit });
    expect(states(s)).toEqual({ account: "next", runtime: "blocked", "first-page": "optional", "pull-requests": "optional", agent: "optional", suggestions: "todo" });
    expect(s.next?.id).toBe("account");
    expect(s.steps[1]!.detail).toContain("no web app in this folder");
    expect(s.app.isApp).toBe(false);
    expect(s.signedIn).toBe(false);
  });

  it("a fresh app, signed out: sign in is next and nothing is asked of genclass.dev", async () => {
    const dir = tempDir();
    viteApp(dir);
    const server = fakeServer({});
    const s = await readState({ cwd: dir }, { runGit: noGit, fetchFn: server.fetchFn });
    expect(server.calls).toEqual([]);
    expect(states(s)).toEqual({ account: "next", runtime: "todo", "first-page": "todo", "pull-requests": "optional", agent: "todo", suggestions: "todo" });
    expect(s.steps[1]).toMatchObject({ run: "genclass init", detail: "Vite + React" });
    expect(s.steps[3]!.detail).toBe("not a git repository yet");
    expect(s.app).toMatchObject({ name: "shop", framework: "Vite + React", isApp: true, token: null });
  });

  it("signed in: the account and its plan are read once, and adding the runtime is next", async () => {
    const dir = tempDir();
    viteApp(dir);
    signIn();
    const server = fakeServer({ "GET /api/cli/overview": { json: overview() } });
    const s = await readState({ cwd: dir }, { runGit: noGit, fetchFn: server.fetchFn });
    expect(server.calls.map((c) => [c.method, c.path, c.auth])).toEqual([["GET", "/api/cli/overview", `Bearer ${SESSION}`]]);
    expect(states(s)).toMatchObject({ account: "done", runtime: "next" });
    expect(s.steps[0]!.detail).toBe("ada@example.com · Free plan");
    expect(s.account).toMatchObject({ label: "ada@example.com", plan: { id: "free", name: "Free" } });
  });

  it("the runtime added by init: done once the app is in the account, then the first page waits for the live site", async () => {
    const dir = tempDir();
    viteApp(dir);
    await addRuntime(dir);
    signIn();
    // the token is in the code but the account has no such app: connecting is next
    const without = await readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview() } }).fetchFn });
    expect(states(without)).toMatchObject({ account: "done", runtime: "next", "first-page": "todo" });
    expect(without.steps[1]).toMatchObject({ run: "genclass connect", detail: "added, but this app is not in your account yet" });
    expect(without.app.token).toBe(TOKEN);
    // in the account, nothing received yet: waiting on a deploy, which is no command, so the next step is after it
    const waiting = await readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project()] }) } }).fetchFn });
    expect(states(waiting)).toMatchObject({ runtime: "done", "first-page": "waiting", agent: "next" });
    expect(waiting.steps[1]!.detail).toBe('added · app "shop"');
    expect(waiting.steps[2]).toMatchObject({ detail: "deploy, then open your site once", human: "deploy your app and open the live site once" });
    expect(waiting.app.dashboardUrl).toBe(`${HOST}/account/apps/proj000000000001`);
    // the live site was opened
    const now = Date.parse("2026-11-12T12:00:00Z");
    const seen = await readState({ cwd: dir }, { runGit: noGit, now, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project({ last_event: "2026-11-12T09:00:00.000Z" })] }) } }).fetchFn });
    expect(seen.steps[2]).toMatchObject({ state: "done", detail: "last page 3 hours ago" });
  });

  it("pull requests: Playwright, the workflow file, then what the GitHub App is doing, in that order", async () => {
    const dir = tempDir();
    viteApp(dir, { devDependencies: { vite: "^7.0.0", "@vitejs/plugin-react": "^5.0.0", "@playwright/test": "^1.50.0" } });
    await addRuntime(dir);
    signIn();
    const git = onGithub(dir);
    const base = { "GET /api/cli/overview": { json: overview({ projects: [project({ last_event: "2026-11-12T09:00:00.000Z" })] }) } };
    const read = (routes: Parameters<typeof fakeServer>[0] = {}) => readState({ cwd: dir }, { runGit: git, fetchFn: fakeServer({ ...base, ...routes }).fetchFn });
    const pr = (s: Awaited<ReturnType<typeof readState>>) => s.steps.find((x) => x.id === "pull-requests")!;
    expect(hasPlaywright(dir, { has: () => false })).toBe(false);

    // no workflow file yet
    expect(pr(await read())).toMatchObject({ state: "next", detail: `Playwright found · ${WORKFLOW_PATH} is missing`, run: "genclass setup" });
    write(dir, { [WORKFLOW_PATH]: "name: genclass\njobs:\n  genclass:\n    steps:\n      - run: node genclass-playwright-run.mjs\n", ".github/workflows/ci.yml": "name: ci\n" });
    expect(genclassWorkflows(dir)).toEqual([WORKFLOW_PATH]);

    // a genclass.dev that cannot say (an older collector): the page says where to look, and it is not the next step
    expect(pr(await read())).toMatchObject({ state: "waiting", run: null });
    const status = (over: Record<string, unknown>) => ({ "GET /api/cli/github": { json: { repo: "acme/shop", known: true, installed: true, evidence: false, prs: 0, last: null, private: false, needs_plan: false, paused: false, connect_url: `${HOST}/github/connect`, install_url: `${HOST}/github/install`, ...over } } });
    // GitHub has not told this account anything yet: continue with GitHub
    const unknown = await read(status({ known: false, installed: null }));
    expect(pr(unknown)).toMatchObject({ state: "next", human: "install the GitHub App and continue with GitHub in your browser" });
    // GitHub's answer does not list the repository
    expect(pr(await read(status({ installed: false })))).toMatchObject({ state: "next", detail: "the GitHub App is not on acme/shop yet" });
    // installed, no race files read yet: waiting for the first pull request
    expect(pr(await read(status({})))).toMatchObject({ state: "waiting", human: "commit the workflow file and open a pull request" });
    // reviewing
    expect(pr(await read(status({ evidence: true, prs: 4 })))).toMatchObject({ state: "done", detail: "reviewing · 4 pull requests so far" });
    expect(pr(await read(status({ evidence: true, prs: 1 })))).toMatchObject({ detail: "reviewing · 1 pull request so far" });
    // a private repository without a plan, and a paused one, wait and say why
    expect(pr(await read(status({ private: true, needs_plan: true })))).toMatchObject({ state: "waiting", detail: "private repository: reviews come with the Team plan" });
    expect(pr(await read(status({ paused: true })))).toMatchObject({ state: "waiting" });
    // the repository's name went to the server as it is in the remote
    const server = fakeServer({ ...base, ...status({}) });
    await readState({ cwd: dir }, { runGit: git, fetchFn: server.fetchFn });
    expect(server.calls.map((c) => `${c.path}${c.query}`)).toEqual(["/api/cli/overview", "/api/cli/github?repo=acme%2Fshop"]);
  });

  it("pull requests do not apply without GitHub or without Playwright, and say which", async () => {
    const dir = tempDir();
    viteApp(dir);
    signIn();
    const f = fakeServer({ "GET /api/cli/overview": { json: overview() } }).fetchFn;
    const pr = async (runGit: (a: string[]) => string | null) => (await readState({ cwd: dir }, { runGit, fetchFn: f })).steps.find((x) => x.id === "pull-requests")!;
    expect(await pr(noGit)).toMatchObject({ state: "optional", detail: "not a git repository yet" });
    expect(await pr((a) => (a[1] === "--show-toplevel" ? dir : a[0] === "remote" ? "https://gitlab.com/acme/shop.git" : "main"))).toMatchObject({ state: "optional", detail: "the repository is not on GitHub" });
    expect(await pr(onGithub(dir))).toMatchObject({ state: "optional", detail: "no Playwright tests yet: add some and this step appears" });
    write(dir, { "playwright.config.ts": "export default {};\n" });
    expect(await pr(onGithub(dir))).toMatchObject({ state: "todo" });
  });

  it("the coding agent and the suggestions are read from files: an MCP config that names GenClass, and the last run's notes", async () => {
    const dir = tempDir();
    viteApp(dir);
    expect(agentConfigs(dir)).toEqual([]);
    write(dir, { ".mcp.json": JSON.stringify({ mcpServers: { other: { command: "x" } } }) });
    expect(agentConfigs(dir)).toEqual([]);
    write(dir, { ".mcp.json": JSON.stringify({ mcpServers: { genclass: { command: "npx", args: ["-y", "@genclass/mcp@0.2.2"] } } }), ".cursor/mcp.json": '{"mcpServers":{"genclass":{"command":"npx","args":["-y","@genclass/mcp"]}}}' });
    expect(agentConfigs(dir)).toEqual([".mcp.json", ".cursor/mcp.json"]);
    saveNotes(dir, { site: "https://shop.example", suggest: { at: "2026-11-10T12:00:00.000Z", failed: 7, urgent: 2, passed: 19, top: ["https"] } });
    const s = await readState({ cwd: dir }, { runGit: noGit, now: Date.parse("2026-11-12T12:00:00Z") });
    expect(s.steps.find((x) => x.id === "agent")).toMatchObject({ state: "done", detail: ".mcp.json, .cursor/mcp.json" });
    expect(s.steps.find((x) => x.id === "suggestions")).toMatchObject({ state: "done", detail: "7 to do, 2 urgent · checked 2 days ago" });
    expect(s.app.site).toBe("https://shop.example");
    // the notes are kept outside the project
    expect(existsSync(join(dir, ".genclass"))).toBe(false);
  });

  it("a session genclass.dev no longer accepts is not signed in; offline, the saved session is shown as not checked", async () => {
    const dir = tempDir();
    viteApp(dir);
    signIn();
    const expired = await readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { status: 401, json: { ok: false, error: "not signed in" } } }).fetchFn });
    expect(expired.steps[0]).toMatchObject({ state: "next", detail: "the saved session expired: sign in again" });
    expect(expired.signedIn).toBe(false);
    const offline = await readState({ cwd: dir }, { runGit: noGit, fetchFn: (async () => Promise.reject(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }))) as never });
    expect(offline.steps[0]!.state).toBe("done");
    expect(offline.steps[0]!.detail).toContain("not checked");
    expect(offline.next?.id).toBe("runtime");
    // an older genclass.dev without the overview: the account and its apps from /api/me, the plan unknown
    const old = await readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/me": { json: { account: ACCOUNT, projects: [] } } }).fetchFn });
    expect(old.steps[0]).toMatchObject({ state: "done", detail: "ada@example.com" });
    expect(old.account?.plan).toBeNull();
  });

  it("a step skipped for this run is not the next one, and --json says what to run and what only a person can do", async () => {
    const dir = tempDir();
    viteApp(dir);
    const s = await readState({ cwd: dir, skip: ["account"] }, { runGit: noGit });
    expect(s.next?.id).toBe("runtime");
    const j = stateJson(s);
    expect(j.next).toMatchObject({ id: "runtime", run: "genclass init", human: null });
    expect(j.steps.map((x) => x.id)).toEqual(["account", "runtime", "first-page", "pull-requests", "agent", "suggestions"]);
    expect(j.steps[0]).toMatchObject({ state: "todo", run: "genclass login", human: "approve the sign-in in your browser" });
    expect(j.complete).toBe(false);
    expect(JSON.stringify(j)).not.toContain(SESSION);
  });
});
