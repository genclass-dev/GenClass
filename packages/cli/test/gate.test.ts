// The Pro gate's edges (src/cli.mjs, src/paywall.mjs) and the text helpers at 58 columns (src/tui.mjs): what works
// without Pro (the telemetry opt-out, an app's private dashboard link, a command's own usage errors), what login does
// before and after Pro, the paywall's question at a terminal, and lines that never break a command or overflow.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { run as runInit } from "../../runtime/bin/lib/init.mjs";
import { connectAgent, projectPlan, sameApp, upgradeOffer } from "../src/actions.mjs";
import { run, telemetryOnly } from "../src/cli.mjs";
import { fetchOverview } from "../src/api.mjs";
import { forgetPro, noteAccount, proOffer, startPro } from "../src/paywall.mjs";
import { layOut } from "../src/suggest/index.mjs";
import { fitLine, spinner, warn, wrap } from "../src/tui.mjs";
import { ACCOUNT, fakeServer, HOST, isolate, overview, printed, project, SESSION, tempDir, TOKEN, viteApp, write } from "./helpers.js";
import { plainLines } from "./stats.js";

isolate();

const flat = (t: string) => plainLines(t).join(" ").replace(/\s+/g, " ");
const signIn = () => saveCredentials({ host: HOST, access_token: SESSION, account: ACCOUNT });
const CHECKOUT = `${HOST}/account/billing?plan=pro&start=1`;
const LOCKED = { paid: false, plan: "Pro", price: "$15 / developer / month", trial_days: 3, checkout_url: CHECKOUT };
/** stderr, quiet for a call (usage errors go there). */
async function quietErr<T>(fn: () => Promise<T>): Promise<{ value: T; err: string }> {
  let err = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => ((err += String(chunk)), true)) as never);
  try {
    return { value: await fn(), err };
  } finally {
    spy.mockRestore();
  }
}
/** The runtime's own init, set up with a token and nothing installed (an app with GenClass in it). */
const setUp = async (dir: string) => {
  await printed(async () => expect(await runInit("init", ["--cwd", dir, "--yes", "--no-install", "--no-network", "--token", TOKEN])).toBe(0));
};

describe("genclass without Pro: every opt-out and the app's own link keep working (AGENTS.md rule 8; src/cli.mjs)", () => {
  it("init --no-telemetry (and --telemetry) on an app with GenClass in it runs signed out, with no gate", async () => {
    const dir = tempDir();
    viteApp(dir);
    await setUp(dir);
    forgetPro();
    const off = await printed(async () => expect(await run(["init", "--no-telemetry", "--yes", "--no-install", "--cwd", dir])).toBe(0));
    expect(off).not.toContain("Sign in first");
    expect(readFileSync(join(dir, "src/genclass.config.js"), "utf8")).toContain("telemetry: false");
    const on = await printed(async () => expect(await run(["init", "--telemetry", "--yes", "--no-install", "--cwd", dir])).toBe(0));
    expect(on).not.toContain("Sign in first");
    expect(readFileSync(join(dir, "src/genclass.config.js"), "utf8")).not.toContain("telemetry: false");
    // what is only the opt-out: the switch with where, whether to ask and what not to run
    expect(telemetryOnly(["--no-telemetry"])).toBe(true);
    expect(telemetryOnly(["--telemetry", "--cwd", "web", "--yes", "--dry-run", "--no-install", "--no-network"])).toBe(true);
    expect(telemetryOnly(["--no-telemetry", "--mode", "guard"])).toBe(false);
    expect(telemetryOnly(["--yes"])).toBe(false);
    // on an app without GenClass, init --no-telemetry would add it: that is the command's, behind the gate
    const fresh = tempDir();
    viteApp(fresh);
    const gated = await printed(async () => expect(await run(["init", "--no-telemetry", "--yes", "--cwd", fresh])).toBe(1));
    expect(flat(gated)).toContain("Sign in first: npx genclass login");
    expect(existsSync(join(fresh, "src/genclass.config.js"))).toBe(false);
  });

  it("a command's own usage error comes before the gate: nothing is asked of genclass.dev for words that are wrong", async () => {
    const dir = tempDir();
    viteApp(dir);
    forgetPro();
    for (const argv of [["init", "--bogus"], ["connect", "--mode", "guard"], ["scan"], ["audit", "not a url"], ["scan", "https://a.example", "--bogus"]]) {
      const r = await quietErr(() => printed(async () => expect(await run([...argv, "--cwd", dir]), argv.join(" ")).toBe(2)));
      expect(r.value, argv.join(" ")).not.toContain("Sign in first");
      expect(r.err, argv.join(" ")).toMatch(/unknown option|needs a URL|not a URL|unexpected argument|needs a value/);
    }
  });

  it("signed out, genclass dashboard in a folder with an app's private link prints it, as 0.3.6 did", async () => {
    const link = `${HOST}/dashboard/${"a".repeat(32)}`;
    const dir = tempDir();
    viteApp(dir);
    write(dir, { ".genclass.local": `GENCLASS_TOKEN=${TOKEN}\nGENCLASS_DASHBOARD=${link}\n` });
    forgetPro();
    const said = await printed(async () => expect(await run(["dashboard", "--cwd", dir])).toBe(0));
    expect(said).toContain(link);
    expect(said).not.toContain("Sign in first");
    expect(flat(said)).not.toContain("free for every app");
  });

  it("an account without Pro is told so before ask's privacy notice, and nothing is agreed to", async () => {
    const dir = tempDir();
    viteApp(dir);
    await setUp(dir);
    signIn();
    const fetchFn = fakeServer({ "GET /api/cli/overview": { json: overview({ cli: LOCKED, projects: [project()] }) } }).fetchFn;
    const { ask } = await import("../src/ask.mjs");
    let saved = false;
    const r = await quietErr(() => printed(async () => expect(await ask({ question: "which page is slow?", cwd: dir }, { fetchFn, savePrefs: () => (saved = true) })).toBe(1)));
    expect(flat(r.value)).toContain(`start your 3-day free trial at ${CHECKOUT}`);
    expect(r.err).not.toContain("Your question goes to");
    expect(saved).toBe(false);
  });
});

describe("genclass login: the sign-in only, Pro next, and the app connected only once Pro is on (src/cli.mjs, runtime login.mjs offerConnect)", () => {
  it("without Pro nothing is written in the folder; with Pro the folder's app is offered to the account", async () => {
    const saved = process.env.GENCLASS_TEST_DIST_TAGS;
    process.env.GENCLASS_TEST_DIST_TAGS = "fail";
    try {
      const dir = tempDir();
      viteApp(dir);
      const before = readFileSync(join(dir, "src/main.jsx"), "utf8");
      signIn();
      const me = { json: { ok: true, account: ACCOUNT, projects: [] } };
      const locked = fakeServer({ "GET /api/me": me, "GET /api/cli/overview": { json: overview({ cli: LOCKED }) } });
      vi.stubGlobal("fetch", locked.fetchFn);
      forgetPro();
      const no = await printed(async () => expect(await run(["login", "--yes", "--no-install", "--cwd", dir])).toBe(0));
      expect(flat(no)).toContain(`The genclass command comes with Pro ($15 / developer / month): start your 3-day free trial at ${CHECKOUT}`);
      expect(no).not.toMatch(/Connect shop|Changes|GenClass is in your app/);
      expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toBe(before);
      expect(locked.calls.some((x) => x.method === "POST")).toBe(false);
      // Pro: the runtime login's own question comes after it (here, with no terminal, it says how to connect)
      const paid = fakeServer({ "GET /api/me": me, "GET /api/cli/overview": { json: overview({ plan: { id: "team", name: "Pro" }, cli: { paid: true, via: "plan" } }) } });
      vi.stubGlobal("fetch", paid.fetchFn);
      forgetPro();
      const yes = flat(await printed(async () => expect(await run(["login", "--cwd", dir])).toBe(0)));
      expect(yes).toContain("Pro is on: every genclass command works.");
      expect(yes).toMatch(/Not a terminal: run \S+( \S+)? connect --yes here to connect this app\./);
      expect(yes.indexOf("Pro is on")).toBeLessThan(yes.indexOf("Not a terminal"));
    } finally {
      vi.unstubAllGlobals();
      if (saved === undefined) delete process.env.GENCLASS_TEST_DIST_TAGS;
      else process.env.GENCLASS_TEST_DIST_TAGS = saved;
    }
  });
});

describe("genclass: a team member's new app goes into the team's account (src/paywall.mjs noteAccount, runtime init.mjs accountWhere)", () => {
  it("the overview's team_plan and via say so, and the runtime's lines are told; the runtime alone says your account", async () => {
    signIn();
    const fetchFn = fakeServer({ "GET /api/cli/overview": { json: overview({ account: { ...ACCOUNT, team_plan: { id: "pro", name: "Pro" } }, cli: { paid: true, via: "team" } }) } }).fetchFn;
    const me = await fetchOverview({ host: HOST, access_token: SESSION, account: ACCOUNT }, { fetchFn });
    expect(me.ok && me.account.teamPlan).toEqual({ id: "pro", name: "Pro" });
    const saved = (globalThis as { __GENCLASS_CLI__?: unknown }).__GENCLASS_CLI__;
    const host: { into?: string | null } = {};
    (globalThis as { __GENCLASS_CLI__?: unknown }).__GENCLASS_CLI__ = host;
    try {
      noteAccount({ plan: { id: "free", name: "Free" }, cli: { paid: true, via: "team" }, teamPlan: { id: "pro", name: "Pro" } });
      expect(host.into).toBe("your team's account");
      noteAccount({ plan: { id: "free", name: "Free" }, cli: null, teamPlan: { id: "pro", name: "Pro" } });
      expect(host.into).toBe("your team's account");
      // their own plan: their own account
      noteAccount({ plan: { id: "pro", name: "Pro" }, cli: { paid: true, via: "plan" }, teamPlan: { id: "pro", name: "Pro" } });
      expect(host.into).toBeNull();
    } finally {
      (globalThis as { __GENCLASS_CLI__?: unknown }).__GENCLASS_CLI__ = saved;
    }
    const { accountWhere } = await import("../../runtime/bin/lib/init.mjs");
    expect(accountWhere(ACCOUNT)).toBe("your account (ada@example.com)");
  });
});

describe("genclass: the plan's card and its answers (src/paywall.mjs, src/suggest/index.mjs layOut)", () => {
  it("a used trial is not promised in the card; a Pro account with no plan from the server sees every suggestion", () => {
    const features = ["3 days free to start", "Up to 3 apps", "Visitor analytics"];
    expect(proOffer({ plan: "Pro", price: "$15", trialDays: null, checkoutUrl: CHECKOUT }, { features } as never).features).toEqual(["Up to 3 apps", "Visitor analytics"]);
    expect(proOffer({ plan: "Pro", price: "$15", trialDays: 3, checkoutUrl: CHECKOUT }, { features } as never).features).toEqual(features);
    const results = [1, 2, 3].map((i) => ({ id: `c${i}`, status: "fail", weight: i, title: `t${i}`, why: "w", fix: "f", prompt: "p" }));
    expect(layOut(results as never, null).filter((i) => i.open)).toHaveLength(1);
    expect(layOut(results as never, null, true).filter((i) => i.open)).toHaveLength(3);
  });
});

describe("genclass at 58 columns: commands stay whole, a spinner never wraps (src/tui.mjs)", () => {
  it("wrap never breaks a command, and warnings are wrapped like every other line", async () => {
    const text = "Sign in first: npx genclass login. The genclass command comes with Pro. Off: npx genclass init --no-telemetry and more: npx genclass --cwd <folder> or npx genclass apps new \"My shop\" or npm install -g genclass by hand.";
    for (const cols of [32, 40, 54]) {
      const lines = wrap(text, cols);
      const joined = lines.join("\n");
      for (const cmd of ["npx genclass login.", "npx genclass init --no-telemetry", "npx genclass --cwd <folder>", 'npx genclass apps new "My shop"', "npm install -g genclass"]) expect(joined, `${cols}: ${cmd}`).toContain(cmd);
      // nothing but a command longer than the line is longer than the line
      for (const l of lines) if (!/genclass/.test(l)) expect(l.length, l).toBeLessThanOrEqual(cols);
    }
    // a sentence is still a sentence: "the genclass command" is prose, not a command to keep whole
    expect(wrap("the genclass command comes with Pro", 12)).toEqual(["the genclass", "command", "comes with", "Pro"]);
    const cols = process.stdout.columns;
    process.stdout.columns = 58;
    try {
      const said = await printed(() => warn("Could not add the genclass command. npx genclass keeps working, and this sentence goes on again for a while."));
      for (const l of plainLines(said)) expect(l.length, l).toBeLessThanOrEqual(58);
      expect(flat(said)).toContain("npx genclass keeps working");
    } finally {
      process.stdout.columns = cols;
    }
  });

  it("a spinner's line fits the window: the stop hint goes on its own line when it does not fit after it", async () => {
    expect(fitLine("Waiting for you to approve in the browser (Enter to stop waiting)", 58).length).toBeLessThanOrEqual(53);
    expect(fitLine("short", 58)).toBe("short");
    const cols = process.stdout.columns;
    const isTTY = process.stdout.isTTY;
    process.stdout.columns = 58;
    (process.stdout as { isTTY: boolean }).isTTY = true;
    try {
      const said = await printed(async () => {
        const sp = spinner("Waiting for you to approve in the browser", { stoppable: true });
        await new Promise((r) => setTimeout(r, 200));
        sp.stop(null);
      });
      // every frame, without its redraw codes, fits on one line of 58 columns
      for (const frame of said.split("\r").map((f) => f.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\n/g, ""))) expect(frame.length, frame).toBeLessThanOrEqual(57);
      expect(said).toContain("Enter stops the wait.");
    } finally {
      process.stdout.columns = cols;
      (process.stdout as { isTTY: boolean | undefined }).isTTY = isTTY;
    }
  });
});

describe("genclass at a terminal: the paywall's question, the plan page's wait, the agent's files (src/paywall.mjs, src/actions.mjs)", () => {
  const input = new PassThrough();
  (input as unknown as { isTTY: boolean }).isTTY = true;
  const real = Object.getOwnPropertyDescriptor(process, "stdin")!;
  beforeAll(() => Object.defineProperty(process, "stdin", { value: input, configurable: true }));
  afterAll(() => Object.defineProperty(process, "stdin", real));
  const type = (...lines: string[]) => lines.forEach((l, i) => setTimeout(() => input.write(`${l}\n`), 30 * (i + 1)));
  const cli = { paid: false, plan: "Pro", price: "$15 / developer / month", trialDays: 3, checkoutUrl: CHECKOUT };

  it("n, no, s and exit at Pro's card stop as q does; the card says which account it is for", async () => {
    for (const answer of ["n", "no", "s", "exit", "q"]) {
      type(answer);
      let got: boolean | null = null;
      const said = await printed(async () => (got = await startPro(cli, null, { account: "ada@example.com" }, { waitMs: 50, everyMs: 10 })));
      expect(got, answer).toBe(false);
      expect(said, answer).not.toMatch(/Waiting for the payment|Your browser is opening/);
      expect(flat(said), answer).toContain("For ada@example.com");
      // stopped: what starts it later, without the price again (it is on the card)
      expect(flat(said), answer).toContain("Not started. Run npx genclass upgrade any time to start your 3-day free trial.");
      expect(flat(said).match(/\$15/g), answer).toHaveLength(1);
    }
    // the card once per process: a later command that needs Pro gets one line (the gate), upgrade and plan the card
    type("q");
    const again = await printed(async () => expect(await startPro(cli, null, { short: true }, { waitMs: 50, everyMs: 10 })).toBe(false));
    expect(flat(again).trim()).toBe("That comes with Pro. Run npx genclass upgrade to start your 3-day free trial.");
  });

  it("the plan page's wait: a Free choice made before it is not its answer; a stopped wait says it once", async () => {
    signIn();
    const app = project({ id: "p1", plan: { id: "free", name: "Free", source: null }, needs_plan: false, plan_chosen: true, plan_url: `${HOST}/account/billing?project=p1` });
    const state = { account: { offer: { plan: { id: "team", name: "Pro" }, price: "$15", features: [], free: { name: "Free", apps: 1 }, checkoutUrl: CHECKOUT }, cli: null, plan: { id: "free", name: "Free" } }, projects: [{ ...app, needsPlan: false, planChosen: true, planUrl: app.plan_url, plan: app.plan }], app: { token: TOKEN } };
    const offer = upgradeOffer(state as never)!;
    expect(offer).toMatchObject({ chosen: true, needs: false });
    const fetchFn = fakeServer({ "GET /api/cli/overview": { json: overview({ projects: [app] }) } }).fetchFn;
    const said = await printed(async () => expect(await projectPlan(offer, { noBrowser: true }, { fetchFn, waitMs: 120, everyMs: 10 })).toBe("quit"));
    expect(said).not.toContain("is on Free for now");
    expect(flat(said)).toContain("No choice yet.");
    // the account's checkout, stopped: "No payment yet" once, not twice
    type("");
    const pay = await printed(async () => expect(await startPro(cli, null, {}, { fetchFn: fakeServer({ "GET /api/cli/overview": { json: overview({ cli: LOCKED }) } }).fetchFn, waitMs: 60, everyMs: 10 })).toBe(false));
    expect(flat(pay).match(/No payment yet/g)).toHaveLength(1);
    expect(pay).not.toContain("goes on from there");
  });

  it("the coding agent's files are shown; on their own they are asked about (no writes nothing), in the walk the step's Enter was the yes", async () => {
    const dir = tempDir();
    viteApp(dir);
    type("n");
    const said = await printed(async () => expect(await connectAgent({ cwd: dir }, {})).toBe("skipped"));
    expect(said).toContain(".mcp.json");
    expect(said).toContain(".claude/skills/genclass/SKILL.md");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    // the walk: shown, then written, with no second question
    const walked = await printed(async () => expect(await connectAgent({ cwd: dir }, { confirmed: true })).toBe("done"));
    expect(walked).toContain(".mcp.json");
    expect(walked).not.toContain("and the skill?");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });

  it("taken out and added again: the account's app of the same name is used, not a second one", async () => {
    const dir = tempDir();
    viteApp(dir);
    signIn();
    const state = { signedIn: true, cwd: dir, projects: [{ id: "p1", name: "shop", token: TOKEN }], steps: [{ id: "runtime", run: "npx genclass init" }] };
    // no app of that name: a new one, as before
    expect(await sameApp({ ...state, projects: [{ id: "p2", name: "blog", token: TOKEN }] } as never, { yes: true })).toBeNull();
    // at a terminal it asks; no makes a new app
    type("n");
    expect(await printed(async () => expect(await sameApp(state as never, {})).toBeNull())).toContain("Use your existing shop?");
    // --yes: that app's key is written, and nothing is sent
    const again = await sameApp(state as never, { yes: true, noInstall: true });
    expect(again).toBeTypeOf("function");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => (calls.push(String(u)), new Response("{}", { status: 404 })));
    try {
      await printed(async () => expect(await again!()).toBe(0));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(readFileSync(join(dir, "src/genclass.config.js"), "utf8")).toContain(TOKEN);
    expect(calls.filter((u) => /projects/.test(u))).toEqual([]);
  });
});
