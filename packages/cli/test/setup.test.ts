// The guided setup's walk on a terminal (src/setup.mjs walk, stepKey, closing, show): what each answer at a step's
// prompt does. Only Enter (or y, yes) starts a step; n and no skip it as s does, q stops, and anything else is asked
// again, so a "no" never writes a file, opens a page or starts a sign-in. Every request goes to a stand-in for
// genclass.dev (fetch is replaced for every test), never to the real one.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { run as runInit } from "../../runtime/bin/lib/init.mjs";
import { setup, show, stepKey } from "../src/setup.mjs";
import { readState, WORKFLOW_PATH } from "../src/state.mjs";
import { ACCOUNT, fakeServer, HOST, isolate, overview, printed, SESSION, tempDir, TOKEN, viteApp } from "./helpers.js";
import { plainLines, tooWide } from "./stats.js";

isolate();

const input = new PassThrough();
(input as unknown as { isTTY: boolean }).isTTY = true;
const real = Object.getOwnPropertyDescriptor(process, "stdin")!;
beforeAll(() => Object.defineProperty(process, "stdin", { value: input, configurable: true }));
afterAll(() => Object.defineProperty(process, "stdin", real));
/** Lines typed at the prompts, one after another (exactly as many as the walk asks for: nothing is left over). */
const type = (...lines: string[]) => lines.forEach((l, i) => setTimeout(() => input.write(`${l}\n`), 30 * (i + 1)));

type Server = ReturnType<typeof fakeServer>;
let server: Server;
/** genclass.dev for this test: `routes`, and every request recorded; nothing reaches the network. */
const net = (routes: Parameters<typeof fakeServer>[0] = {}) => {
  server = fakeServer(routes);
  vi.stubGlobal("fetch", server.fetchFn);
  return server;
};
beforeEach(() => void net());
afterEach(() => vi.unstubAllGlobals());

const signIn = () => saveCredentials({ host: HOST, access_token: SESSION, account: ACCOUNT });
/** What was printed as one line of words, without colours and without the bar beside a note. */
const flat = (t: string) => plainLines(t).map((l) => l.replace(/^\s*[▎|] /, "")).join(" ").replace(/\s+/g, " ");
async function at58(fn: () => unknown): Promise<string> {
  const before = process.stdout.columns;
  process.stdout.columns = 58;
  try {
    return await printed(fn);
  } finally {
    process.stdout.columns = before;
  }
}
const deviceCalls = () => server.calls.filter((x) => x.path === "/api/device/code");
const githubCalls = () => server.calls.filter((x) => x.path === "/api/cli/github");
const overviewCalls = () => server.calls.filter((x) => x.path === "/api/cli/overview");

/** A Vite app with Playwright tests in a git repository on GitHub (acme/shop): every step of the walk applies. */
function repoApp(): string {
  const dir = realpathSync(tempDir());
  viteApp(dir, { devDependencies: { vite: "^8.0.0", "@vitejs/plugin-react": "^5.0.0", "@playwright/test": "^1.50.0" } });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/shop.git"], { cwd: dir });
  return dir;
}
/** genclass.dev for a signed-in account whose GitHub App is not on acme/shop yet. */
const SIGNED_IN = {
  "GET /api/cli/overview": { json: overview() },
  "GET /api/cli/github": { json: { repo: "acme/shop", known: true, installed: false, evidence: false, prs: 0, last: null, private: false, needs_plan: false, paused: false, connect_url: `${HOST}/github/connect`, install_url: `${HOST}/github/install` } },
};
/** What the walk wrote in the app: GenClass's import, the workflow, the agent configuration. */
const written = (dir: string) => ({
  runtime: readFileSync(join(dir, "src/main.jsx"), "utf8").includes("@genclass/runtime") || existsSync(join(dir, "src/genclass.config.js")),
  workflow: existsSync(join(dir, WORKFLOW_PATH)),
  agent: existsSync(join(dir, ".mcp.json")),
});

describe("the walk's keys (src/setup.mjs stepKey)", () => {
  it("only Enter, y or yes starts a step; s, skip, n and no skip it; q, quit, exit and stop stop; d unfolds; anything else is asked again", () => {
    for (const a of ["", " ", "y", "Y", "yes", "YES", " yes "]) expect(stepKey(a), JSON.stringify(a)).toBe("go");
    for (const a of ["s", "S", "skip", "n", "N", "no", "No", "NO"]) expect(stepKey(a), a).toBe("skip");
    for (const a of ["q", "Q", "quit", "exit", "stop"]) expect(stepKey(a), a).toBe("quit");
    expect(stepKey("d")).toBe("details");
    expect(stepKey("D")).toBe("details");
    // a word read whole: none of these is a key, and none starts a step
    for (const a of ["nope", "nah", "x", "yes please", "no thanks", "sure", "ok", "1", "dd", "stop it", "continue"]) expect(stepKey(a), a).toBeNull();
  });
});

describe("the walk's answers, step by step (src/setup.mjs walk)", () => {
  it("Sign in: n and no skip it (no sign-in is started, nothing is opened); y and Enter start it", async () => {
    const dir = tempDir();
    viteApp(dir);
    for (const no of ["n", "no", "N", "s"]) {
      net();
      type(no);
      const said = await at58(async () => expect(await setup({ cwd: dir })).toBe(0));
      expect(deviceCalls(), no).toEqual([]);
      expect(tooWide(said)).toEqual([]);
      // the walk ends with what is still to do and the command that does it; nothing Pro's is offered signed out
      // 0.3.9: a walk that ends signed out says so, with the one command back to the sign-in
      expect(flat(said)).toContain("Not signed in yet.");
      expect(flat(said)).toContain("Run npx genclass again");
      expect(said).not.toContain("npx genclass suggest");
    }
    // a word that is not a key is asked again, and starts nothing
    net();
    type("nope", "q");
    const again = await at58(async () => expect(await setup({ cwd: dir })).toBe(0));
    expect(flat(again)).toContain("Enter continues, d shows every part, s skips this step, q stops.");
    expect(flat(again)).toContain("Stopped. Run npx genclass again any time");
    expect(deviceCalls()).toEqual([]);
    // y and Enter start the sign-in (genclass.dev here cannot start one; the walk offers it once more, and q stops)
    for (const yes of ["y", "yes", ""]) {
      net();
      type(yes, "q");
      const said = await at58(async () => expect(await setup({ cwd: dir })).toBe(0));
      expect(deviceCalls(), JSON.stringify(yes)).toHaveLength(1);
      expect(flat(said)).toContain("Could not start the sign-in");
      expect(flat(said)).toContain("Enter tries the sign-in again with a new code.");
    }
  });

  it("Pro: n stops at its own question, and no checkout is opened or waited for", async () => {
    const dir = tempDir();
    viteApp(dir);
    signIn();
    const CHECKOUT = `${HOST}/account/billing?plan=pro&start=1`;
    net({ "GET /api/cli/overview": { json: overview({ cli: { paid: false, plan: "Pro", price: "$15 / developer / month", trial_days: 3, checkout_url: CHECKOUT } }) } });
    type("n");
    const said = await at58(async () => expect(await setup({ cwd: dir })).toBe(0));
    expect(said).toContain("to start the free trial");
    expect(said).not.toContain("Waiting for the payment");
    // 0.3.9: the card has said how to start it later; no second stop line
    expect(overviewCalls()).toHaveLength(1);
  });

  it("Runtime, Test workflow, GitHub App, Coding agent and Suggestions: n and no skip each one; nothing is written, opened or run", async () => {
    const dir = repoApp();
    signIn();
    net(SIGNED_IN);
    const runSuggest = vi.fn(async () => 0);
    // one answer per step, in the walk's order
    type("n", "no", "N", "No", "n");
    const said = await at58(async () => expect(await setup({ cwd: dir }, { runSuggest })).toBe(0));
    for (const step of ["Add GenClass to this app", "Add the test workflow", "Connect the GitHub App", "Connect your coding agent", "See what your app is missing"]) expect(flat(said), step).toContain(`Next ${step}`);
    expect(written(dir)).toEqual({ runtime: false, workflow: false, agent: false });
    expect(runSuggest).not.toHaveBeenCalled();
    // the GitHub App step asked genclass.dev nothing of its own (one question per reading of the state) and opened nothing
    expect(githubCalls().length).toBe(overviewCalls().length);
    expect(said).not.toContain("Opening GitHub");
    expect(said).not.toContain("Write .mcp.json");
    expect(tooWide(said)).toEqual([]);
    // what is still to do is named at the end, and suggest is offered: the account has what it needs
    expect(flat(said)).toContain("Not done yet: Add GenClass to this app");
    expect(flat(said)).toContain("Run npx genclass init");
    expect(said).toContain("npx genclass suggest");
  });

  it("Test workflow: Enter and yes write it (the step's Enter is the yes for that file); q stops at the next step", async () => {
    for (const yes of ["", "yes", "y"]) {
      const dir = repoApp();
      signIn();
      net(SIGNED_IN);
      type("s", yes, "q");
      const said = await at58(async () => expect(await setup({ cwd: dir })).toBe(0));
      expect(written(dir), JSON.stringify(yes)).toEqual({ runtime: false, workflow: true, agent: false });
      expect(flat(said)).toContain(`Wrote ${WORKFLOW_PATH}`);
      expect(githubCalls().length).toBe(overviewCalls().length);
    }
    // a word that is not a key, at the same step: asked again, and nothing is written
    const dir = repoApp();
    signIn();
    net(SIGNED_IN);
    type("s", "maybe", "q");
    const said = await at58(async () => expect(await setup({ cwd: dir })).toBe(0));
    expect(written(dir).workflow).toBe(false);
    expect(flat(said)).toContain("Enter continues, d shows every part, s skips this step, q stops.");
  });

  it("Coding agent: n at the step writes nothing and asks nothing more; Enter shows the files and asks once", async () => {
    const dir = tempDir();
    viteApp(dir);
    signIn();
    net({ "GET /api/cli/overview": { json: overview() } });
    // runtime skipped, then the agent: n
    type("s", "n", "q");
    const no = await at58(async () => expect(await setup({ cwd: dir })).toBe(0));
    expect(no).not.toContain(".mcp.json (create)");
    expect(written(dir).agent).toBe(false);
    // Enter: the step's Enter is the yes for what its sentence says it adds (0.3.9); the preview is shown first and
    // no second question is asked
    type("s", "", "q");
    const yes = await at58(async () => expect(await setup({ cwd: dir })).toBe(0));
    expect(yes).toContain(".mcp.json");
    expect(yes).not.toContain("Write .mcp.json");
    expect(written(dir).agent).toBe(true);
  });

  it("Suggestions: n skips them; Enter runs them", async () => {
    const dir = tempDir();
    viteApp(dir);
    signIn();
    net({ "GET /api/cli/overview": { json: overview() } });
    const runSuggest = vi.fn(async () => 0);
    type("s", "s", "no");
    await at58(async () => expect(await setup({ cwd: dir }, { runSuggest })).toBe(0));
    expect(runSuggest).not.toHaveBeenCalled();
    // an empty answer with nothing typed after it is the end of the input (0.3.9), so q follows
    type("s", "s", "", "q");
    await at58(async () => expect(await setup({ cwd: dir }, { runSuggest })).toBe(0));
    expect(runSuggest).toHaveBeenCalledTimes(1);
    expect(runSuggest.mock.calls[0][0]).toMatchObject({ cwd: dir, fromSetup: true });
  });

  it("Dashboard (a saved session, genclass.dev unreachable): n skips it without asking; the header names the account as not checked", async () => {
    const dir = tempDir();
    viteApp(dir);
    await printed(async () => expect(await runInit("init", ["--cwd", dir, "--yes", "--no-install", "--no-network", "--token", TOKEN])).toBe(0));
    signIn();
    vi.stubGlobal("fetch", async () => Promise.reject(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } })));
    // the dashboard, then the coding agent, then the suggestions
    type("n", "n", "n");
    const said = await at58(async () => expect(await setup({ cwd: dir }, { runSuggest: vi.fn(async () => 0) })).toBe(0));
    expect(flat(said)).toContain("Next See your first page");
    expect(said).not.toContain("Is your site deployed with GenClass in it?");
    expect(said).toContain("ada@example.com (not checked)");
    expect(said).not.toContain("not signed in");
    expect(tooWide(said)).toEqual([]);
  });
});

describe("the end of a walk with nothing left to do here (src/setup.mjs closing)", () => {
  it("setup --yes after a sign-in that could not start: says it is not done and the command for it, and offers nothing Pro's", async () => {
    const dir = tempDir();
    viteApp(dir);
    const said = await at58(async () => expect(await setup({ cwd: dir, yes: true })).toBe(1));
    expect(flat(said)).toContain("Could not start the sign-in");
    expect(flat(said)).toContain("Not signed in yet.");
    expect(said).not.toContain("npx genclass suggest");
    expect(said).toContain("Day to day");
    expect(tooWide(said)).toEqual([]);
  });

  it("the header and the card name a saved session genclass.dev could not check, never as not signed in", async () => {
    const dir = tempDir();
    viteApp(dir);
    signIn();
    const offline = await readState({ cwd: dir }, { runGit: () => null, fetchFn: (async () => Promise.reject(new Error("fetch failed"))) as never });
    expect(offline.account).toBeNull();
    expect(offline.savedAccount).toBe("ada@example.com");
    const view = await at58(() => show(offline));
    expect(view).toContain("ada@example.com (not checked)");
    expect(view).not.toContain("not signed in");
    // checked: the account as it is; a session genclass.dev refused: not signed in
    const online = await readState({ cwd: dir }, { runGit: () => null, fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview() } }).fetchFn });
    expect(online.savedAccount).toBeNull();
    expect(await at58(() => show(online))).not.toContain("not checked");
    const expired = await readState({ cwd: dir }, { runGit: () => null, fetchFn: fakeServer({ "GET /api/cli/overview": { status: 401, json: { ok: false } } }).fetchFn });
    expect(expired.savedAccount).toBeNull();
    expect(await at58(() => show(expired))).toContain("not signed in");
  });
});

describe("--no-browser, listed in the help for every command (src/cli.mjs)", () => {
  /** stdout and stderr of one command line. */
  async function both(argv: string[]): Promise<{ code: number; text: string }> {
    const { run } = await import("../src/cli.mjs");
    let text = "";
    const e = vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => ((text += String(s)), true)) as never);
    try {
      let code = -1;
      const said = await printed(async () => (code = await run(argv)));
      return { code, text: `${said}${text}` };
    } finally {
      e.mockRestore();
    }
  }

  it("the runtime CLI's commands that do not take it get their words without it: no usage error for it", async () => {
    const who = await both(["whoami", "--no-browser"]);
    expect(who.text).not.toContain("unknown option");
    expect(who.code).toBe(1);
    // a word that is wrong is still said, and it is that word
    const connect = await both(["connect", "--no-browser", "--bogus"]);
    expect(connect.code).toBe(2);
    expect(connect.text).toContain("unknown option --bogus");
    expect(connect.text).not.toContain("unknown option --no-browser");
    const scan = await both(["scan", "--no-browser"]);
    expect(scan.code).toBe(2);
    expect(scan.text).not.toContain("unknown option");
    const remove = await both(["remove", "--no-browser", "--dry-run", "--cwd", tempDir()]);
    expect(remove.text).not.toContain("unknown option");
    expect(remove.code).toBe(0);
    // init's opt-out, which runs without Pro: with --no-browser it still only turns the diagnostics off
    const dir = tempDir();
    viteApp(dir);
    await printed(async () => expect(await runInit("init", ["--cwd", dir, "--yes", "--no-install", "--no-network", "--token", TOKEN])).toBe(0));
    const off = await both(["init", "--no-telemetry", "--yes", "--no-install", "--no-browser", "--cwd", dir]);
    expect(off.text).not.toContain("unknown option");
    expect(off.code).toBe(0);
    expect(readFileSync(join(dir, "src/genclass.config.js"), "utf8")).toContain("telemetry: false");
  });
});
