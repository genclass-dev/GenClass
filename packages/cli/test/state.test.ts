// Where a project stands (src/state.mjs): each of the seven steps is read from what is on disk and what genclass.dev
// answers, and there is exactly one next step.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteCredentials, saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { run as runInit } from "../../runtime/bin/lib/init.mjs";
import { chooseAppPlan, choosePlan, planNow } from "../src/actions.mjs";
import { forgetPro, requirePro } from "../src/paywall.mjs";
import { status } from "../src/setup.mjs";
import { agentConfigs, appsBelow, genclassWorkflows, hasPlaywright, planName, readState, stateJson, WORKFLOW_PATH } from "../src/state.mjs";
import { renamedRepo } from "../src/git.mjs";
import { saveNotes } from "../src/store.mjs";
import { planCard } from "../src/tui.mjs";
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
    expect(states(s)).toEqual({ account: "next", plan: "todo", runtime: "blocked", "app-plan": "optional", dashboard: "optional", workflow: "optional", "github-app": "optional", agent: "optional", suggestions: "todo" });
    expect(s.next?.id).toBe("account");
    expect(s.steps.find((x) => x.id === "runtime")!.detail).toContain("no web app in this folder");
    expect(s.app.isApp).toBe(false);
    expect(s.signedIn).toBe(false);
  });

  it("a fresh app, signed out: sign in is next and nothing is asked of genclass.dev", async () => {
    const dir = tempDir();
    viteApp(dir);
    const server = fakeServer({});
    const s = await readState({ cwd: dir }, { runGit: noGit, fetchFn: server.fetchFn });
    expect(server.calls).toEqual([]);
    expect(states(s)).toEqual({ account: "next", plan: "todo", runtime: "todo", "app-plan": "optional", dashboard: "todo", workflow: "optional", "github-app": "optional", agent: "todo", suggestions: "todo" });
    expect(s.steps.find((x) => x.id === "runtime")!).toMatchObject({ run: "npx genclass init", detail: "Vite + React" });
    expect(s.steps.find((x) => x.id === "workflow")!.detail).toBe("not a git repository yet");
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
    expect(states(without)).toMatchObject({ account: "done", runtime: "next", dashboard: "todo" });
    expect(without.steps.find((x) => x.id === "runtime")!).toMatchObject({ run: "npx genclass connect", detail: "added, but this app is not in your account yet" });
    expect(without.app.token).toBe(TOKEN);
    // in the account, nothing received yet: waiting on a deploy, which is no command, so the next step is after it
    const waiting = await readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project()] }) } }).fetchFn });
    expect(states(waiting)).toMatchObject({ runtime: "done", dashboard: "waiting", agent: "next" });
    expect(waiting.steps.find((x) => x.id === "runtime")!.detail).toBe('added · app "shop"');
    expect(waiting.steps.find((x) => x.id === "dashboard")).toMatchObject({ detail: "deploy, then open your site once", human: "deploy your app and open the live site once" });
    expect(waiting.app.dashboardUrl).toBe(`${HOST}/account/apps/proj000000000001`);
    // the live site was opened
    const now = Date.parse("2026-11-12T12:00:00Z");
    const seen = await readState({ cwd: dir }, { runGit: noGit, now, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project({ last_event: "2026-11-12T09:00:00.000Z" })] }) } }).fetchFn });
    expect(seen.steps.find((x) => x.id === "dashboard")).toMatchObject({ state: "done", detail: "last page 3 hours ago" });
  });

  it("the test workflow, then the GitHub App: Playwright, the workflow file, then what the app is doing, in that order", async () => {
    const dir = tempDir();
    viteApp(dir, { devDependencies: { vite: "^8.0.0", "@vitejs/plugin-react": "^5.0.0", "@playwright/test": "^1.50.0" } });
    await addRuntime(dir);
    signIn();
    const git = onGithub(dir);
    const base = { "GET /api/cli/overview": { json: overview({ projects: [project({ last_event: "2026-11-12T09:00:00.000Z" })] }) } };
    const read = (routes: Parameters<typeof fakeServer>[0] = {}) => readState({ cwd: dir }, { runGit: git, fetchFn: fakeServer({ ...base, ...routes }).fetchFn });
    const wf = (s: Awaited<ReturnType<typeof readState>>) => s.steps.find((x) => x.id === "workflow")!;
    const pr = (s: Awaited<ReturnType<typeof readState>>) => s.steps.find((x) => x.id === "github-app")!;
    expect(hasPlaywright(dir, { has: () => false })).toBe(false);

    // no workflow file yet: it is the next step, and the app comes after it
    const none = await read();
    expect(wf(none)).toMatchObject({ state: "next", title: "Test workflow", doing: "Add the test workflow", detail: "Playwright found · no workflow file yet", run: "npx genclass setup" });
    // the GitHub App does not wait for the workflow: it also comments production findings, which need no tests
    expect(pr(none).state).not.toBe("optional");
    expect(pr(none).detail).not.toBe("after the test workflow");
    write(dir, { [WORKFLOW_PATH]: "name: genclass\njobs:\n  genclass:\n    steps:\n      - run: node genclass-playwright-run.mjs\n", ".github/workflows/ci.yml": "name: ci\n" });
    expect(genclassWorkflows(dir)).toEqual([WORKFLOW_PATH]);

    // a genclass.dev that cannot say (an older collector): the page says where to look, and it is not the next step
    const old = await read();
    expect(wf(old)).toMatchObject({ state: "done", detail: WORKFLOW_PATH });
    expect(pr(old)).toMatchObject({ state: "waiting", run: null });
    const status = (over: Record<string, unknown>) => ({ "GET /api/cli/github": { json: { repo: "acme/shop", known: true, installed: true, evidence: false, prs: 0, last: null, private: false, needs_plan: false, paused: false, connect_url: `${HOST}/github/connect`, install_url: `${HOST}/github/install`, ...over } } });
    // GitHub has not told this account anything yet: continue with GitHub
    const unknown = await read(status({ known: false, installed: null }));
    expect(pr(unknown)).toMatchObject({ state: "next", human: "install the GitHub App and continue with GitHub in your browser" });
    // GitHub's answer does not list the repository
    expect(pr(await read(status({ installed: false })))).toMatchObject({ state: "next", detail: "not on acme/shop yet", human: "install the GitHub App on this repository" });
    // installed, no race files read yet: waiting for the first pull request
    expect(pr(await read(status({})))).toMatchObject({ state: "waiting", human: "commit the workflow file and open a pull request" });
    // reviewing
    expect(pr(await read(status({ evidence: true, prs: 4 })))).toMatchObject({ state: "done", detail: "reviewing · 4 pull requests so far" });
    expect(pr(await read(status({ evidence: true, prs: 1 })))).toMatchObject({ detail: "reviewing · 1 pull request so far" });
    // a private repository without a plan, and a paused one, wait and say why
    expect(pr(await read(status({ private: true, needs_plan: true })))).toMatchObject({ state: "waiting", detail: "private repository: reviews come with Pro" });
    expect(pr(await read(status({ paused: true })))).toMatchObject({ state: "waiting" });
    // a genclass.dev with no GitHub App (a collector someone hosts themselves): the step does not apply
    const noApp = await readState({ cwd: dir }, { runGit: git, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project({ last_event: "2026-11-12T09:00:00.000Z" })], github: { app: false, install_url: null, connect_url: null } }) } }).fetchFn });
    expect(pr(noApp)).toMatchObject({ state: "optional", detail: "this genclass.dev has no GitHub App" });
    // the repository's name went to the server as it is in the remote
    const server = fakeServer({ ...base, ...status({}) });
    await readState({ cwd: dir }, { runGit: git, fetchFn: server.fetchFn });
    expect(server.calls.map((c) => `${c.path}${c.query}`)).toEqual(["/api/cli/overview", "/api/cli/github?repo=acme%2Fshop"]);
  });

  it("the test workflow and the GitHub App do not apply without GitHub or without Playwright, and say which", async () => {
    const dir = tempDir();
    viteApp(dir);
    signIn();
    const f = fakeServer({ "GET /api/cli/overview": { json: overview() } }).fetchFn;
    const step = (id: string) => async (runGit: (a: string[]) => string | null) => (await readState({ cwd: dir }, { runGit, fetchFn: f })).steps.find((x) => x.id === id)!;
    const pr = step("workflow");
    const app = step("github-app");
    expect(await pr(noGit)).toMatchObject({ state: "optional", detail: "not a git repository yet" });
    expect(await pr((a) => (a[1] === "--show-toplevel" ? dir : a[0] === "remote" ? "https://gitlab.com/acme/shop.git" : "main"))).toMatchObject({ state: "optional", detail: "the repository is not on GitHub" });
    expect(await pr(onGithub(dir))).toMatchObject({ state: "optional", detail: "no Playwright tests yet" });
    expect(await app(noGit)).toMatchObject({ state: "optional", detail: "not a git repository yet" });
    // without Playwright the test workflow does not apply, the GitHub App still does (production findings on pull requests)
    expect((await app(onGithub(dir))).state).not.toBe("optional");
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
    expect(s.steps.find((x) => x.id === "suggestions")).toMatchObject({ state: "waiting", detail: "7 to do, 2 urgent · checked 2 days ago", human: "work through the list: npx genclass suggest" });
    // with nothing left on the list it is done
    saveNotes(dir, { suggest: { at: "2026-11-12T11:00:00.000Z", failed: 0, urgent: 0, passed: 26, top: [] } });
    expect((await readState({ cwd: dir }, { runGit: noGit, now: Date.parse("2026-11-12T12:00:00Z") })).steps.find((x) => x.id === "suggestions")).toMatchObject({ state: "done", detail: "nothing to do · checked 1 hour ago" });
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

  it("GenClass in the app but the app not in the account: putting it there is next, and the first page is not offered before it", async () => {
    // a project set up earlier (by someone else, or before an account) with a key this account does not have
    const dir = tempDir();
    viteApp(dir);
    await addRuntime(dir);
    signIn();
    const server = fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project({ token: "gc_SomeoneElsesKey0000000" })] }) } });
    const s = await readState({ cwd: dir }, { runGit: noGit, fetchFn: server.fetchFn });
    expect(s.next?.id).toBe("runtime");
    expect(s.next?.run).toBe("npx genclass connect");
    expect(s.steps.find((x) => x.id === "runtime")!.detail).toBe("added, but this app is not in your account yet");
    // that step skipped (or failed) in this run: the next one is not "See your first page", which has nothing to
    // watch for until the app is in the account
    const after = await readState({ cwd: dir, skip: ["runtime"] }, { runGit: noGit, fetchFn: server.fetchFn });
    expect(after.next?.id).not.toBe("dashboard");
    expect(after.next?.id).toBe("agent");
    // once it is in the account, the first page is next
    const linked = fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project()] }) } });
    expect((await readState({ cwd: dir }, { runGit: noGit, fetchFn: linked.fetchFn })).steps.find((x) => x.id === "dashboard")!.state).toBe("waiting");
  });

  it("a step skipped for this run is not the next one, and --json says what to run and what only a person can do", async () => {
    const dir = tempDir();
    viteApp(dir);
    // skipping the sign-in skips everything after Pro too: the genclass command is Pro's (CONTRACT: the gate's side doors)
    const s = await readState({ cwd: dir, skip: ["account"] }, { runGit: noGit });
    expect(s.next).toBeNull();
    // before the sign-in, the first screen says what the command costs
    expect(s.steps[0].why).toBe("Opens genclass.dev. Then Pro: 3 days free, then $15 / developer / month, with a card on Stripe.");
    expect(s.steps[1].detail).toBe("3 days free, then $15 / developer / month");
    // with Pro, a skipped step is not the next one
    signIn();
    const fetchFn = fakeServer({ "GET /api/cli/overview": { json: overview({ plan: { id: "team", name: "Pro" }, cli: { paid: true, via: "plan" } }) } }).fetchFn;
    const p = await readState({ cwd: dir, skip: ["runtime"] }, { runGit: noGit, fetchFn });
    expect(p.next?.id).toBe("agent");
    const pro = await readState({ cwd: dir }, { runGit: noGit, fetchFn });
    expect(pro.next?.id).toBe("runtime");
    const j = stateJson(pro);
    expect(j.next).toMatchObject({ id: "runtime", title: "Add GenClass to this app", run: "npx genclass init", human: null });
    // every step has a short name, what doing it is called, one sentence and a fuller one
    for (const x of [...s.steps, ...pro.steps]) expect([x.title.length > 0, x.doing.length > 0, x.why.length > 0 && x.why.length < 100, x.more.length > 0], x.id).toEqual([true, true, true, true]);
    expect(j.steps.map((x) => x.id)).toEqual(["account", "plan", "runtime", "app-plan", "dashboard", "workflow", "github-app", "agent", "suggestions"]);
    expect(stateJson(s).steps[0]).toMatchObject({ state: "todo", run: "npx genclass login", human: "approve the sign-in in your browser" });
    expect(j.complete).toBe(false);
    expect(JSON.stringify(j)).not.toContain(SESSION);
  });
});

describe("genclass: a folder that is not a web app (src/state.mjs appsBelow, src/setup.mjs show)", () => {
  it("finds the web apps below it: three folders deep, not inside an app, build output or hidden folders", async () => {
    const root = tempDir();
    write(root, { "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }) });
    viteApp(join(root, "apps", "web"));
    viteApp(join(root, "apps", "web", "examples", "inner")); // inside an app: not looked at
    viteApp(join(root, "packages", "ui", "playground"));
    viteApp(join(root, "node_modules", "some-app"));
    viteApp(join(root, ".cache", "app"));
    viteApp(join(root, "dist", "app"));
    viteApp(join(root, "a", "b", "c", "too-deep"));
    write(join(root, "packages", "lib"), { "package.json": JSON.stringify({ name: "lib", main: "index.js" }) });
    expect(appsBelow(root)).toEqual({ apps: [{ dir: "apps/web", label: "Vite + React" }, { dir: "packages/ui/playground", label: "Vite + React" }], more: 0 });
    // more than it names are counted, not listed
    for (let i = 0; i < 4; i++) viteApp(join(root, "sites", `s${i}`));
    expect(appsBelow(root, 3)).toMatchObject({ apps: [{ dir: "apps/web" }, { dir: "packages/ui/playground" }, { dir: "sites/s0" }], more: 3 });
    expect(appsBelow(join(root, "nowhere"))).toEqual({ apps: [], more: 0 });
  });

  it("the view names them with the command that sets each one up; an app's own folder has no such list", async () => {
    const root = tempDir();
    write(root, { "package.json": JSON.stringify({ name: "mono", private: true }) });
    viteApp(join(root, "apps", "web"));
    const s = await readState({ cwd: root }, { runGit: noGit });
    expect(s.app.below).toEqual({ apps: [{ dir: "apps/web", label: "Vite + React" }], more: 0 });
    expect(stateJson(s).app.below.apps[0].dir).toBe("apps/web");
    const said = (await printed(async () => expect(await status({ cwd: root })).toBe(0))).replace(/\s+/g, " ");
    expect(said).toContain("No web app in this folder. There is one below it:");
    expect(said).toContain("npx genclass --cwd apps/web");
    expect(said).toContain("Vite + React");
    const app = await readState({ cwd: join(root, "apps", "web") }, { runGit: noGit });
    expect(app.app.below).toBeUndefined();
    // nothing below either: where to run it
    const empty = tempDir();
    expect((await printed(async () => expect(await status({ cwd: empty })).toBe(0))).replace(/\s+/g, " ")).toContain("Run npx genclass inside your web app's folder, or name it: npx genclass --cwd <folder>");
  });
});

describe("genclass: an app on Vite 7 with GenClass in it (src/state.mjs, src/vite.mjs)", () => {
  it("the runtime step is not done until the build setting is there, and says what is missing", async () => {
    const dir = tempDir();
    viteApp(dir, { devDependencies: { vite: "^7.0.0", "@vitejs/plugin-react": "^5.0.0" } });
    await addRuntime(dir);
    const s = await readState({ cwd: dir }, { runGit: noGit });
    const rt = s.steps.find((x) => x.id === "runtime")!;
    // signed out, signing in comes first; the step itself is still to do
    expect(rt).toMatchObject({ state: "todo", doing: "Add two Vite settings", detail: "added · Vite 7 needs two build settings", run: "npx genclass setup", vite: true });
    expect(rt.why).toContain('"vite build" fails on Vite 7');
    // with the setting there (by this command or by hand) the step is done
    write(dir, { "vite.config.js": 'export default { worker: { format: "es" } };\n' });
    expect((await readState({ cwd: dir }, { runGit: noGit })).steps.find((x) => x.id === "runtime")).toMatchObject({ state: "done" });
  });
});

describe("genclass: a repository that was renamed on GitHub (src/git.mjs renamedRepo, src/state.mjs)", () => {
  const head = (status: number, location?: string) =>
    (async () => new Response(null, { status, headers: location ? { location } : {} })) as unknown as typeof fetch;

  it("github.com's redirect gives the current name; anything else gives none", async () => {
    expect(await renamedRepo("acme/shop-old", { fetchFn: head(301, "https://github.com/acme/shop") })).toBe("acme/shop");
    expect(await renamedRepo("acme/shop", { fetchFn: head(200) })).toBeNull(); // not renamed
    expect(await renamedRepo("acme/secret", { fetchFn: head(404) })).toBeNull(); // private, or gone
    expect(await renamedRepo("acme/Shop", { fetchFn: head(301, "https://github.com/acme/shop") })).toBeNull(); // only its letter case
    expect(await renamedRepo("acme/shop-old", { fetchFn: head(301, "https://evil.example/acme/shop") })).toBeNull(); // not GitHub
    expect(await renamedRepo("acme/shop-old", { fetchFn: head(301, "https://github.com/login?return_to=x") })).toBeNull();
    expect(await renamedRepo("not a repo", { fetchFn: head(301, "https://github.com/acme/shop") })).toBeNull();
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await renamedRepo("acme/shop-old", { fetchFn: down })).toBeNull();
  });

  it("the app is looked up under the current name, so an installed app is not reported as missing", async () => {
    const dir = tempDir();
    viteApp(dir, { devDependencies: { vite: "^8.0.0", "@vitejs/plugin-react": "^5.0.0", "@playwright/test": "^1.50.0" } });
    await addRuntime(dir);
    write(dir, { [WORKFLOW_PATH]: "name: genclass\njobs:\n  genclass:\n    steps:\n      - run: node genclass-playwright-run.mjs\n" });
    signIn();
    const asked: string[] = [];
    const server = fakeServer({
      "GET /api/cli/overview": { json: overview({ projects: [project()] }) },
      "GET /api/cli/github": (url: URL) => {
        const repo = url.searchParams.get("repo")!;
        asked.push(repo);
        return { json: repo === "acme/shop" ? { known: true, installed: true, evidence: true, prs: 34 } : { known: true, installed: false } };
      },
    });
    const git = (args: string[]) => (args[0] === "rev-parse" && args[1] === "--show-toplevel" ? dir : args[0] === "remote" ? "https://github.com/acme/shop-old.git" : args[0] === "rev-parse" ? "main" : null);
    // without an answer from GitHub the old name stands, and the app looks missing
    const stale = await readState({ cwd: dir }, { runGit: git, fetchFn: server.fetchFn });
    expect(stale.steps.find((x) => x.id === "github-app")).toMatchObject({ state: "next", detail: "not on acme/shop-old yet" });
    // GitHub says the repository is acme/shop now: asked again under that name
    asked.length = 0;
    const s = await readState({ cwd: dir }, { runGit: git, fetchFn: server.fetchFn, renamedRepo: async (r: string) => (r === "acme/shop-old" ? "acme/shop" : null) });
    expect(asked).toEqual(["acme/shop-old", "acme/shop"]);
    const step = s.steps.find((x) => x.id === "github-app")!;
    expect(step).toMatchObject({ state: "done", detail: "reviewing · 34 pull requests so far" });
    expect(step.more).toContain("GitHub now calls this repository acme/shop");
    expect(step.more).toContain("git remote set-url origin https://github.com/acme/shop.git");
    expect(s.git).toMatchObject({ github: "acme/shop", renamedFrom: "acme/shop-old" });
  });
});

describe("genclass: Pro right after the sign-in, and each app's plan page (src/state.mjs, src/paywall.mjs, src/actions.mjs choosePlan, planNow, src/tui.mjs planCard)", () => {
  const OFFER = {
    plan: { id: "team", name: "Pro" },
    price: "$15 / developer / month",
    summary: "Everything for up to 3 apps, per developer.",
    features: ["Every suggestion, with a prompt for your agent", "GitHub App on private repositories", "Visitor analytics", "Alerts to Sentry, PostHog, Datadog, Slack or a webhook"],
    checkout_url: `${HOST}/account/billing?plan=pro&start=1`,
    trial_days: 3,
    free: { name: "Free", apps: 1, history_days: 7, suggestions_shown: 1 },
  };
  const CHECKOUT = `${HOST}/account/billing?plan=pro&start=1`;
  const LOCKED = { paid: false, plan: "Pro", price: "$15 / developer / month", trial_days: 3, checkout_url: CHECKOUT };
  const PRO = { plan: { id: "team", name: "Pro" }, cli: { paid: true } };
  const NEEDS_PRO = { ok: false, error: "the genclass command comes with Pro", needs_pro: true, signed_in: true, plan: "Pro", price: "$15 / developer / month", trial_days: 3, checkout_url: CHECKOUT, run: "npx genclass upgrade" };
  const plain = (t: string) => t.replace(/\u001b\[[0-9;]*m/g, "");
  const flat = (t: string) => plain(t).replace(/\s+/g, " ");

  it("the genclass command is Pro's: without it, Pro is the step right after the sign-in, before anything else", async () => {
    const dir = tempDir();
    viteApp(dir);
    // signed out: the sign-in first, Pro right after it
    const out = await readState({ cwd: dir }, { runGit: noGit });
    expect(out.steps.map((x) => x.id).slice(0, 4)).toEqual(["account", "plan", "runtime", "app-plan"]);
    expect(out.steps.find((x) => x.id === "plan")).toMatchObject({ state: "todo", after: "account" });
    expect(out.next?.id).toBe("account");
    signIn();
    const locked = fakeServer({ "GET /api/cli/overview": { json: overview({ offer: OFFER, cli: LOCKED }) } });
    const s = await readState({ cwd: dir }, { runGit: noGit, fetchFn: locked.fetchFn });
    expect(s.next?.id).toBe("plan");
    const step = s.steps.find((x) => x.id === "plan")!;
    expect(step).toMatchObject({ title: "Pro", doing: "Start your 3-day free trial", detail: "$15 / developer / month, 3 days free", why: "Every genclass command comes with Pro, 3 days free to start.", run: "npx genclass upgrade", human: `start Pro in your browser: ${CHECKOUT}` });
    expect(step.more).toContain("nothing is charged if you cancel before the 3 days end");
    expect(step.more).toContain("Free stays on the website");
    expect(s.account?.cli).toEqual({ paid: false, plan: "Pro", price: "$15 / developer / month", trialDays: 3, checkoutUrl: CHECKOUT });
    // Pro (paid, in its trial, a grant): done, and the runtime is next
    const paid = await readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview(PRO) } }).fetchFn });
    expect(paid.steps.find((x) => x.id === "plan")).toMatchObject({ state: "done", detail: "Pro" });
    expect(paid.next?.id).toBe("runtime");
    // a member of a paying team (the server says why: via "team")
    const member = await readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ cli: { paid: true, via: "team" } }) } }).fetchFn });
    expect(member.steps.find((x) => x.id === "plan")).toMatchObject({ state: "done", detail: "through your team's plan" });
    // a server that sells nothing here (via "open"), or does not say why: never "your team's plan"
    const open = await readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ cli: { paid: true, via: "open" } }) } }).fetchFn });
    expect(open.steps.find((x) => x.id === "plan")).toMatchObject({ state: "done", detail: "open on this genclass.dev" });
    const unsaid = await readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ cli: { paid: true } }) } }).fetchFn });
    expect(unsaid.steps.find((x) => x.id === "plan")!.detail).not.toContain("team");
    // a server that does not say (older, self-hosted) locks nothing
    const older = await readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview() } }).fetchFn });
    expect(older.steps.find((x) => x.id === "plan")).toMatchObject({ state: "optional" });
    expect(older.next?.id).toBe("runtime");
    // what the server sends is not trusted: a checkout on another host becomes its own billing page
    const evil = await readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ cli: { ...LOCKED, checkout_url: "https://evil.example/pay" } }) } }).fetchFn });
    expect(evil.steps.find((x) => x.id === "plan")!.human).toBe(`start Pro in your browser: ${HOST}/account/billing`);
  });

  it("with nobody to ask (--yes, --json, no terminal) nothing is opened or waited for: one line with the trial's checkout, and exit code 1", async () => {
    const dir = tempDir();
    viteApp(dir);
    signIn();
    const fetchFn = fakeServer({ "GET /api/cli/overview": { json: overview({ offer: OFFER, cli: LOCKED }) } }).fetchFn;
    const state = await readState({ cwd: dir }, { runGit: noGit, fetchFn });
    const said = await printed(async () => expect(await choosePlan(state, { yes: true })).toBe("quit"));
    expect(flat(said)).toContain(`The genclass command comes with Pro ($15 / developer / month): start your 3-day free trial at ${CHECKOUT}`);
    // the gate every command passes: the same line, exit code 1; --json says it as data
    forgetPro();
    expect(flat(await printed(async () => expect(await requirePro({ yes: true }, { fetchFn })).toBe(1)))).toContain(`start your 3-day free trial at ${CHECKOUT}`);
    // one shape for needs_pro, wherever it comes from (the gate, a route's 402, upgrade)
    expect(JSON.parse(await printed(async () => expect(await requirePro({ json: true }, { fetchFn })).toBe(1)))).toEqual(NEEDS_PRO);
    // Pro: in, and not asked again in this process
    const paid = fakeServer({ "GET /api/cli/overview": { json: overview(PRO) } });
    expect(await requirePro({ yes: true }, { fetchFn: paid.fetchFn })).toBe(0);
    expect(await requirePro({ yes: true }, { fetchFn: paid.fetchFn })).toBe(0);
    expect(paid.calls).toHaveLength(1);
    expect(await choosePlan(await readState({ cwd: dir }, { runGit: noGit, fetchFn: paid.fetchFn }), { yes: true })).toBe("skipped");
    // a server that does not say, or cannot be reached, locks nothing here (its own routes still answer 402)
    forgetPro();
    expect(await requirePro({ yes: true }, { fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview() } }).fetchFn })).toBe(0);
    forgetPro();
    expect(await requirePro({ yes: true }, { fetchFn: (async () => { throw new Error("offline"); }) as never })).toBe(0);
    // signed out, with nobody to sign in: what to run, exit code 1
    forgetPro();
    deleteCredentials();
    expect(flat(await printed(async () => expect(await requirePro({ yes: true }, { fetchFn })).toBe(1)))).toContain("Sign in first: npx genclass login");
  });

  it("every command but signing in, the plan, status, help and remove passes the gate first (src/cli.mjs FREE_COMMANDS)", async () => {
    const { FREE_COMMANDS, run } = await import("../src/cli.mjs");
    expect(FREE_COMMANDS).toEqual(["login", "logout", "whoami", "plan", "upgrade", "profile", "status", "remove", "help", "version"]);
    deleteCredentials();
    forgetPro();
    const dir = tempDir();
    viteApp(dir);
    for (const cmd of ["dashboard", "problems", "suggest", "connections", "export", "init"]) {
      const said = await printed(async () => expect(await run([cmd, "--yes", "--cwd", dir]), cmd).toBe(1));
      expect(flat(said), cmd).toContain("Sign in first: npx genclass login. The genclass command comes with Pro");
    }
    // the home's commands pass the gate too (the home opens on q before the sign-in)
    const nested = await printed(async () => expect(await run(["suggest", "--no-model", "--yes", "--cwd", dir], { nested: true })).toBe(1));
    expect(flat(nested)).toContain("Sign in first: npx genclass login");
    // a scan that did not run ends with 2 (its 1 means "problems found"), and says where the page check is free
    for (const cmd of ["scan", "audit"]) {
      const said = await printed(async () => expect(await run([cmd, "https://example.com", "--cwd", dir]), cmd).toBe(2));
      expect(flat(said), cmd).toContain("Sign in first: npx genclass login");
      expect(flat(said), cmd).toContain("Free, without Pro: the page check on the website https://genclass.dev/scan");
    }
    // where things stand is not gated: it shows Pro as the step after the sign-in
    expect(JSON.parse(await printed(async () => expect(await run(["status", "--json", "--cwd", dir])).toBe(0))).steps.map((x: { id: string }) => x.id).slice(0, 2)).toEqual(["account", "plan"]);
    // a word a command does not take is told so before anything is asked of genclass.dev
    const { vi } = await import("vitest");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(await run(["agent", "nonsense"])).toBe(2);
      expect(await run(["analytics", "nonsense"])).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("each app's plan page: a new app opens it once (Continue with Pro for a paying account), an app past what the plan covers waits there", async () => {
    const dir = tempDir();
    viteApp(dir);
    await addRuntime(dir);
    signIn();
    const url = `${HOST}/account/billing?project=p1`;
    const app = (extra: object) => project({ id: "p1", plan: { id: "team", name: "Pro", source: "paid" }, needs_plan: false, plan_chosen: false, plan_url: url, ...extra });
    const read = async (p: object, over: object = PRO) => readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ ...over, projects: [p] }) } }).fetchFn });
    // Pro covers it, no choice yet: Continue with Pro, on its page
    const s = await read(app({}));
    expect(s.next?.id).toBe("app-plan");
    const step = s.steps.find((x) => x.id === "app-plan")!;
    expect(step).toMatchObject({ doing: "Continue with Pro for this app", detail: "covered by Pro: continue on its plan page", human: `open this app's plan page: ${url}&from=cli`, after: "runtime" });
    expect(step.offer).toMatchObject({ checkoutUrl: `${url}&from=cli`, project: { id: "p1" }, needs: false, current: "Pro", paying: true });
    // continued: nothing to choose
    expect((await read(app({ plan_chosen: true }))).steps.find((x) => x.id === "app-plan")).toMatchObject({ state: "optional", detail: "Pro" });
    expect((await read(app({ plan: { id: "team", name: "Pro", source: "comp" }, plan_chosen: true }))).steps.find((x) => x.id === "app-plan")).toMatchObject({ detail: "Pro (set up by GenClass)" });
    // a fourth app on Pro: locked, more apps are Enterprise's; a choice made earlier does not close it
    const fourth = (await read(app({ plan: { id: "free", name: "Free", source: null }, needs_plan: true, plan_chosen: true }))).steps.find((x) => x.id === "app-plan")!;
    expect(fourth).toMatchObject({ state: "next", detail: "Your plan covers no more apps", why: "Your plan covers no more apps. More apps come with Enterprise, by email." });
    expect(fourth.offer).toMatchObject({ needs: true, paying: true, current: null });
    // with nobody at a terminal the page is opened (here: it cannot be) and the step stays open
    const said = await printed(async () => expect(await chooseAppPlan(await read(app({})), { yes: true, noBrowser: true })).toBe("skipped"));
    expect(flat(said)).toContain(`Open ${url}&from=cli`);
    expect(flat(said)).toContain("Your Pro plan covers shop: continue with it on its plan page.");
    // an app of a team the account is in: its owner chooses
    expect((await read(project({ shared: true }))).steps.find((x) => x.id === "app-plan")).toMatchObject({ state: "optional", detail: "the team's owner chooses it" });
    // a server that sells nothing and an app on Free: nothing to choose
    expect((await read(app({ plan: { id: "free", name: "Free", source: null } }), { cli: null })).steps.find((x) => x.id === "app-plan")).toMatchObject({ state: "optional" });
  });

  it("a new app opens its plan page at once (after login, connect, init, apps new, and before its views); a choice made does not", async () => {
    const dir = tempDir();
    viteApp(dir);
    await addRuntime(dir);
    signIn();
    const url = `${HOST}/account/billing?project=p1`;
    const app = (extra: object) => project({ id: "p1", plan: { id: "team", name: "Pro", source: "paid" }, needs_plan: false, plan_chosen: false, plan_url: url, ...extra });
    const read = (p: object) => readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ ...PRO, projects: [p] }) } }).fetchFn });
    // nobody at a terminal here: it says where the page is and goes on
    // an app Pro covers has a plan: the line says so (it continues once on its page), and nothing waits on it
    let r = "";
    const said = await printed(async () => (r = await planNow({ cwd: dir }, { readState: async () => read(app({})) })));
    expect(r).toBe("covered");
    expect(flat(said)).toContain(`shop is covered by your Pro plan. Continue with it once on its plan page: ${url}&from=cli`);
    expect(flat(said)).not.toContain("has no plan yet");
    // the app named by its id, the same
    expect(await printed(async () => expect(await planNow({ cwd: dir }, { readState: async () => read(app({})) }, "p1")).toBe("covered"))).toContain("covered by your Pro plan");
    // a fourth app on Pro: nothing to pay for (more apps are Enterprise's), so nothing is opened or waited for
    const fourth = app({ plan: { id: "free", name: "Free", source: null }, needs_plan: true });
    const locked = await printed(async () => expect(await planNow({ cwd: dir }, { readState: async () => read(fourth) })).toBe("locked"));
    expect(flat(locked)).toContain("Your plan covers no more apps, and shop is one more. More apps come with Enterprise, by email.");
    expect(flat(locked)).toContain(`${url}&from=cli`);
    expect(locked).not.toMatch(/Waiting|No payment yet|has no plan yet/);
    // on Free, an app with no plan yet: it is chosen in the browser
    const freeApp = project({ id: "p1", plan: { id: "free", name: "Free", source: null }, needs_plan: false, plan_chosen: false, plan_url: url });
    const onFree = (p: object) => readState({ cwd: dir }, { runGit: noGit, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ offer: OFFER, cli: LOCKED, projects: [p] }) } }).fetchFn });
    const freeSaid = await printed(async () => expect(await planNow({ cwd: dir }, { readState: async () => onFree(freeApp) })).toBe("open"));
    expect(flat(freeSaid)).toContain(`shop has no plan yet. Choose it in the browser: ${url}&from=cli`);
    // nothing to choose: Continue clicked, or GenClass's grant continued, or a team's app
    for (const p of [app({ plan_chosen: true }), app({ plan: { id: "team", name: "Pro", source: "comp" }, plan_chosen: true }), project({ shared: true })]) {
      expect(await printed(async () => expect(await planNow({ cwd: dir }, { readState: async () => read(p) })).toBe("none"))).toBe("");
    }
    // the header names this app's plan, not the account's best one
    const st = await read(app({ plan: { id: "free", name: "Free", source: null } }));
    expect(planName({ ...st, account: { ...st.account, plan: { id: "team", name: "Pro" } } } as never)).toBe("Free");
  });

  it("the card is the paid plan, large, in the server's words, as wide as the welcome card", async () => {
    const cols = process.stdout.columns;
    try {
      for (const width of [58, 80]) {
        process.stdout.columns = width;
        const card = plain(await printed(() => planCard({ plan: { name: "Pro" }, price: OFFER.price, summary: OFFER.summary, features: OFFER.features, trialDays: 3 }, null, "Start your 3-day free trial")));
        const lines = card.split("\n").filter((l) => /[│╭╰]/.test(l));
        expect(new Set(lines.map((l) => [...l].length)), `${width} columns`).toEqual(new Set([Math.max(60, width) - 2]));
        expect(card).toContain("Start your 3-day free trial");
        expect(card).toContain("P R O");
        expect(card).toContain("$15 / developer / month");
        expect(card).toContain("Everything for up to 3 apps, per developer.");
        expect(card.replace(/[│\s]+/g, " ")).toContain("3 days free, then $15 / developer / month. Cancel any time.");
        expect(card).toContain("✔ Visitor analytics");
        expect(card.replace(/[│\s]+/g, " ")).toContain("✔ Alerts to Sentry, PostHog, Datadog, Slack or a webhook");
      }
      // an app's card says so
      expect(plain(await printed(() => planCard({ plan: { name: "Pro" }, price: OFFER.price, features: [] }, "corner-bakery")))).toContain("A plan for corner-bakery");
      // text from a server cannot draw on the terminal
      expect(await printed(() => planCard({ plan: { name: "Te\u001b[2Jam" }, price: "$1\u0007", features: ["x\u001b[31m"] }, "a\u001b[0m", "b\u001b[2J"))).not.toMatch(/\u0007|\u001b\[2J|\u001b\[31m/);
    } finally {
      process.stdout.columns = cols;
    }
  });
});

describe("genclass: setups made without init's markers (review, 2026-11-12)", () => {
  it("a hand-written setup whose key is in the account is done, not 'Put this app in your account' forever", async () => {
    const dir = tempDir();
    viteApp(dir);
    write(dir, { "src/main.jsx": `import "@genclass/runtime/auto";\nwindow.GENCLASS_CONFIG = { token: "${TOKEN}" };\n` });
    signIn();
    const server = fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project()] }) } });
    const s = await readState({ cwd: dir }, { runGit: noGit, fetchFn: server.fetchFn });
    expect(s.steps.find((x) => x.id === "runtime")).toMatchObject({ state: "done" });
    expect(s.steps.find((x) => x.id === "runtime")!.detail).toContain("added by hand");
    expect(s.next?.id).not.toBe("runtime");
  });

  it("an app set up with @genclass/nuxt or @genclass/astro is not fresh: GenClass is not added a second time", async () => {
    for (const [dep, file, text] of [
      ["nuxt", "nuxt.config.ts", `export default defineNuxtConfig({ modules: [["@genclass/nuxt", { token: "${TOKEN}" }]] });\n`],
      ["astro", "astro.config.mjs", `import genclass from "@genclass/astro";\nexport default { integrations: [genclass({ token: "${TOKEN}" })] };\n`],
    ] as const) {
      const dir = tempDir();
      write(dir, { "package.json": JSON.stringify({ name: "site", dependencies: { [dep]: "^5.0.0", [`@genclass/${dep}`]: "^0.1.0" } }), [file]: text });
      const s = await readState({ cwd: dir }, { runGit: noGit });
      const rt = s.steps.find((x) => x.id === "runtime")!;
      expect([dep, rt.run]).not.toEqual([dep, "npx genclass init"]);
      expect([dep, s.app.token]).toEqual([dep, TOKEN]);
    }
  });

  it("for a coding agent the command of a step is the one that runs without a terminal", async () => {
    const { stateJson } = await import("../src/state.mjs");
    const dir = tempDir();
    viteApp(dir);
    await addRuntime(dir);
    signIn();
    const server = fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [project()] }) } });
    const j = stateJson(await readState({ cwd: dir }, { runGit: noGit, fetchFn: server.fetchFn }));
    for (const x of j.steps) expect([x.id, x.run]).not.toEqual([x.id, "npx genclass setup"]);
    expect(j.next?.run === null || !/^npx genclass setup$/.test(j.next!.run ?? "")).toBe(true);
  });
});
