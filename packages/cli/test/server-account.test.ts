// The account's side of `genclass` against the real collector, in process (telemetry-worker/src/cli.ts, the routes a
// newer approval lists): plan, team, connections, export, funnels, the agent link and ask. What src/api.mjs asks is
// what the server answers, and each command says the next step when the answer is no.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../../../telemetry-worker/src/collector.js";
import { CLI_ACCOUNT_FROM } from "../../../telemetry-worker/src/cli.js";
import { resetTokenCache } from "../../../telemetry-worker/src/dashboard.js";
import { resetOwnerCache } from "../../../telemetry-worker/src/paid.js";
import { resetStandIns } from "../../../telemetry-worker/src/suggest.js";
import { cliToken, createApp, detection, now, resetClock, sendBatch, setNow, setPlan, setup, signedIn } from "../../../telemetry-worker/test/account-helpers.js";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { answerLines, ask, forget, marks } from "../src/ask.mjs";
import { askModel, fetchAccount, fetchConnections } from "../src/api.mjs";
import { signInAgain } from "../src/app.mjs";
import { agentLink, apps, claudeAdd, connections, exportEvents, freeLine, funnels, plan, profile, team, upgrade } from "../src/manage.mjs";
import { analytics } from "../src/views.mjs";
import { HOST, isolate, printed, tempDir } from "./helpers.js";
import { plainLines, tooWide } from "./stats.js";

isolate();
beforeEach(() => {
  resetClock();
  resetStandIns();
  resetTokenCache();
  resetOwnerCache();
  forget();
  // every terminal here is approved after the approval page began to list these routes
  setNow(new Date(Date.parse(CLI_ACCOUNT_FROM) + 3_600_000));
});

type Env = Parameters<typeof handle>[1];
type Model = (url: string, init?: RequestInit) => Promise<Response>;
const SEAL = Buffer.from(new Uint8Array(32).map((_, i) => i * 7 + 1)).toString("base64");
const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX";
const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", INTEGRATIONS_KEY: SEAL };

/** A fetch that reaches the collector in process; `outside` answers what the worker itself asks (the model, a destination). */
const through = (env: Env, outside?: Model) =>
  (async (input: string | URL, init?: RequestInit) => handle(new Request(String(input), { method: init?.method, headers: init?.headers, body: init?.body as never }), env, { now: () => now(), fetch: outside as never })) as unknown as typeof fetch;

/** An account with a CLI session and one app, as `genclass login` and the setup leave them. */
async function account(env: Env, outside?: Model) {
  const me = await signedIn(env);
  const creds = { host: HOST, access_token: await cliToken(env, me.cookie), account: { id: me.account.id, email: me.account.email, github_login: null } };
  saveCredentials(creds);
  const app = await createApp(env, me.cookie, "Shop");
  const dir = tempDir();
  const deps = { runGit: () => null, fetchFn: through(env, outside), now: now().getTime(), home: tempDir(), readPrefs: () => ({}), savePrefs: () => true };
  return { ...me, creds, app, dir, deps, o: { cwd: dir, app: "Shop" } };
}
const team3 = (sql: ReturnType<typeof setup>["sql"], id: string) => setPlan(sql, id, "team", { stripe_mode: "live", seats: 3, subscription_id: "sub_t000000001", subscription_status: "active", current_period_end: "2026-12-13T12:00:00.000Z" });
const older = (sql: ReturnType<typeof setup>["sql"]) => sql.db.exec(`UPDATE auth_sessions SET created = '${new Date(Date.parse(CLI_ACCOUNT_FROM) - 1000).toISOString()}' WHERE kind = 'cli'`);
const flat = (text: string) => plainLines(text).join(" ").replace(/\s+/g, " ");
/** What `fn` prints on a 58-column terminal, and its exit code. */
async function said(fn: () => Promise<number>): Promise<{ text: string; code: number }> {
  const before = process.stdout.columns;
  process.stdout.columns = 58;
  let code = -1;
  try {
    const text = await printed(async () => (code = await fn()));
    return { text, code };
  } finally {
    process.stdout.columns = before;
  }
}
/** Runs `fn` with someone at a terminal who types `lines`, one after the other. */
async function typing<T>(lines: string[], fn: () => Promise<T>): Promise<T> {
  const input = new PassThrough();
  (input as unknown as { isTTY: boolean }).isTTY = true;
  const real = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  lines.forEach((l, i) => setTimeout(() => input.write(`${l}\n`), 40 * (i + 1)));
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "stdin", real);
  }
}

describe("genclass plan, team and apps (src/manage.mjs)", () => {
  it("Free: the limits and what is used, what the plan leaves out, and the paid plan with where it starts", async () => {
    const { env } = setup(LIVE);
    const me = await account(env);
    expect(await fetchAccount(me.creds, me.deps)).toMatchObject({ ok: true, plan: { id: "free", name: "Free", price: null }, limits: { apps: 3, historyDays: 7, seats: 1, suggestionsPerDay: 3 }, used: { apps: 1, seats: 1 }, includes: { analytics: false, forwarding: false, export: false } });
    const { text, code } = await said(() => plan(me.o, me.deps));
    expect(code).toBe(0);
    expect(tooWide(text)).toEqual([]);
    const f = flat(text);
    expect(f).toContain("Plan Free");
    expect(f).toContain("Apps 1 of 3");
    expect(f).toContain("History 7 days");
    expect(f).toContain("Model runs 0 of 3 used today");
    expect(f).toContain("Not included visitor analytics, alerts to Slack, Sentry and others, the stored events as a file, private repositories");
    // the paid plan's card, in the server's words, and (nobody at a terminal) where it starts
    expect(f).toContain("T E A M");
    expect(f).toContain("$15 / project / month");
    // plans are per project: the account's one app on Free has its own plan page
    expect(text).toContain(`${HOST}/account/billing?project=${me.app.id}&from=cli`);
    expect(f).toContain("Apps and their plans Shop Free");
    expect(JSON.parse((await said(() => plan({ ...me.o, json: true }, me.deps))).text)).toMatchObject({ ok: true, plan: { id: "free" }, limits: { apps: 3 }, offer: { plan: { id: "team" } } });
  });

  it("Free says so after a command, with the way up; profile and upgrade name the app on Free and its plan page", async () => {
    const { env, sql } = setup(LIVE);
    const me = await account(env);
    const line = await said(async () => ((await freeLine(me.o, me.deps)) ? 0 : 1));
    expect(line.code).toBe(0);
    expect(tooWide(line.text)).toEqual([]);
    expect(flat(line.text)).toContain("You are on Free, which has limits (3 apps, 100 live fixes a month, 7 days of history). Team has none, for $15 / project / month. Upgrade now: npx genclass upgrade");
    // profile: who, the plan, each app's plan, and the choices (nobody at a terminal: as commands)
    const p = await said(() => profile(me.o, me.deps));
    expect(p.code).toBe(0);
    expect(tooWide(p.text)).toEqual([]);
    const f = flat(p.text);
    expect(f).toContain("Profile");
    expect(f).toContain("Signed in as ada@example.com");
    expect(f).toContain("Plan Free (limited)");
    expect(f).toContain("Apps and their plans Shop Free");
    expect(f).toContain("Upgrade Shop to Team $15 / project / month npx genclass upgrade");
    expect(f).toContain("Sign out npx genclass logout");
    expect(JSON.parse((await said(() => profile({ ...me.o, json: true }, me.deps))).text)).toMatchObject({ ok: true, plan: { id: "free" }, apps: [{ name: "Shop", plan: { id: "free" } }], upgrade_url: `${HOST}/account/billing?project=${me.app.id}&from=cli` });
    // upgrade: the paid plan's card and the app's plan page
    const u = await said(() => upgrade(me.o, me.deps));
    expect(u.code).toBe(0);
    expect(tooWide(u.text)).toEqual([]);
    expect(flat(u.text)).toContain("A plan for Shop");
    expect(u.text).toContain(`${HOST}/account/billing?project=${me.app.id}&from=cli`);
    // on Team: no line, nothing to upgrade
    sql.db.prepare("UPDATE projects SET plan = 'team', stripe_mode = 'live', subscription_id = 'sub_s', subscription_status = 'active' WHERE id = ?").run(me.app.id);
    expect(await freeLine(me.o, me.deps)).toBe(false);
    expect(flat((await said(() => upgrade(me.o, me.deps))).text)).toContain("Nothing to upgrade here");
  });

  it("Team: the price, when it renews, the seats; a sign-in from before still gets the plan's name and what to do", async () => {
    const { env, sql } = setup(LIVE);
    const me = await account(env);
    team3(sql, me.account.id);
    const f = flat((await said(() => plan(me.o, me.deps))).text);
    expect(f).toContain("Plan Team $15 / project / month");
    expect(f).toContain("Renews 2026-12-13");
    // Team is per project, everyone on it included
    expect(f).toContain("People 1 • no limit");
    expect(f).toContain("Apps and their plans Shop Team");
    expect(f).toContain("Apps 1 • no limit");
    expect(f).toContain("Includes visitor analytics, alerts to Slack, Sentry and others, the stored events as a file, private repositories");
    expect(f).not.toContain("T E A M");
    // a sign-in the real server calls current is left alone by `genclass login`
    expect(await signInAgain({}, { ...me.deps, signIn: async () => "done" })).toBeNull();
    older(sql);
    const old = flat((await said(() => plan(me.o, me.deps))).text);
    expect(old).toContain("Plan Team");
    expect(old).toContain("npx genclass login");
    // and the command that line names does sign in again, instead of answering "already signed in"
    let signed = 0;
    await printed(async () => expect(await signInAgain({}, { ...me.deps, signIn: async () => (signed++, "done") })).toBe(0));
    expect(signed).toBe(1);
  });

  it("team: Free is one person and says which plan holds a team; Team lists its people and makes an invite link once", async () => {
    const { env, sql } = setup(LIVE);
    const me = await account(env);
    const free = flat((await said(() => team(me.o, me.deps))).text);
    expect(free).toContain("Team 1 of 1 seat used");
    expect(free).toContain("Free is for one person.");
    expect(free).toContain("npx genclass plan");
    const no = await said(() => team({ ...me.o, args: ["invite"] }, me.deps));
    expect(no.code).toBe(1);
    expect(flat(no.text)).toContain("A team comes with the Team plan.");
    team3(sql, me.account.id);
    const made = await said(() => team({ ...me.o, args: ["invite"] }, me.deps));
    expect(made.code).toBe(0);
    expect(tooWide(made.text)).toEqual([]);
    const link = /https:\/\/genclass\.dev\/account\/join\/[A-Za-z0-9]{32}/.exec(made.text)?.[0];
    expect(link).toBeTruthy();
    expect(flat(made.text)).toContain("It works once");
    const list = flat((await said(() => team(me.o, me.deps))).text);
    expect(list).toContain("Team 1 person");
    expect(list).toContain("ada@example.com owner");
    expect(list).toContain("an invite link is open until");
    expect(list).toContain("npx genclass team invite");
    // removing someone stays in the browser, and the screen says where
    expect(list).toContain(`${HOST}/account/billing`);
  });

  it("apps: the account's apps, a new one by name, and the plan's limit said with what starts more", async () => {
    const { env } = setup(LIVE);
    const me = await account(env);
    const list = await said(() => apps({ cwd: me.dir }, me.deps));
    expect(flat(list.text)).toContain("1 app on Free");
    expect(flat(list.text)).toContain("Shop nothing received yet");
    expect(list.text).toContain('npx genclass dashboard --app "Shop"');
    const made = await said(() => apps({ cwd: me.dir, args: ["new", "Blog", "two"] }, me.deps));
    expect(made.code).toBe(0);
    expect(flat(made.text)).toMatch(/Made Blog two\. Project key gc_[A-Za-z0-9]{22}/);
    await said(() => apps({ cwd: me.dir, args: ["new", "Third"] }, me.deps));
    const over = await said(() => apps({ cwd: me.dir, args: ["new", "Fourth"] }, me.deps));
    // a fourth app is made, and needs a plan of its own
    expect(over.code).toBe(0);
    expect(flat(over.text)).toContain("Free covers 3 apps: this one needs a paid plan.");
    expect(over.text).toMatch(/account\/billing\?project=[0-9a-f]+/);
    expect((await said(() => apps({ cwd: me.dir, args: ["new"] }, me.deps))).code).toBe(2);
    expect(JSON.parse((await said(() => apps({ cwd: me.dir, json: true }, me.deps))).text).apps.map((a: any) => a.name)).toEqual(["Blog two", "Fourth", "Shop", "Third"]);
  });
});

describe("genclass apps and team: the small words (src/manage.mjs)", () => {
  it("the hint names the app that heard from its site last; a plan with no seat count says person or people", async () => {
    const { env, sql } = setup(LIVE);
    const me = await account(env);
    await createApp(env, me.cookie, "Another");
    await createApp(env, me.cookie, "Aaa first by name");
    await sendBatch(env, me.app.token, [{ t: "session", host: "shop.example", route: "/" }]);
    expect((await said(() => apps({ cwd: me.dir }, me.deps))).text).toContain('npx genclass dashboard --app "Shop"');
    // a plan GenClass granted has no seat count: one person is "1 person"
    setPlan(sql, me.account.id, "free", { comp_until: new Date(now().getTime() + 86_400_000).toISOString(), comp_plan: "team" });
    const one = flat((await said(() => team(me.o, me.deps))).text);
    expect(one).toContain("Team 1 person");
    expect(one).not.toContain("1 people");
  });
});

describe("genclass connections (src/manage.mjs connections)", () => {
  it("Free sees the destinations and which plan sends to them; a change is refused with the command that starts the plan", async () => {
    const { env } = setup(LIVE);
    const me = await account(env);
    const { text, code } = await said(() => connections(me.o, me.deps));
    expect(code).toBe(0);
    expect(tooWide(text)).toEqual([]);
    const f = flat(text);
    for (const d of ["Slack", "Sentry", "PostHog", "Datadog", "Webhook"]) expect(f).toContain(`${d} not set up`);
    expect(f).toContain("Alerts come with the Team plan. npx genclass plan");
    expect(f).toContain("Private link off");
    // setting one up on Free: the plan is why, said before anything is asked for, with the command that starts it
    const no = await typing([], () => said(() => connections({ ...me.o, args: ["add", "slack"] }, me.deps)));
    expect(no.code).toBe(1);
    expect(flat(no.text)).toContain("Sending alerts comes with the Team plan.");
    expect(flat(no.text)).toContain("npx genclass plan");
    expect(no.text).not.toContain("Slack incoming webhook URL");
    // a destination that was never set up cannot be turned on: the server's own sentence
    const never = await said(() => connections({ ...me.o, args: ["on", "slack"] }, me.deps));
    expect(never.code).toBe(1);
    expect(flat(never.text)).toContain("slack is not set up for this app");
  });

  it("Team: add one (what is typed is never shown), test it, turn it off, remove it", async () => {
    const { env, sql } = setup(LIVE);
    const sent: string[] = [];
    const me = await account(env, async (url) => (sent.push(url), new Response("ok", { status: 200 })));
    team3(sql, me.account.id);
    // the address is typed at a hidden prompt, then Enter says yes to the test record
    const add = await typing([SLACK, ""], () => said(() => connections({ ...me.o, args: ["add", "slack"] }, me.deps)));
    expect(add.code).toBe(0);
    expect(add.text).not.toContain("XXXXXXXXXXXX");
    expect(add.text).not.toContain("hooks.slack.com/services");
    const f = flat(add.text);
    expect(f).toContain("Send Shop's new problems to Slack");
    expect(f).toContain("is not shown");
    expect(f).toContain("Slack is set up: hooks.slack.com, webhook ...XXXXXX.");
    expect(f).toContain("A test record reached Slack.");
    expect(sent).toEqual([SLACK]);
    expect(await fetchConnections(me.creds, me.app.id, me.deps)).toMatchObject({ ok: true, forwarding: true, list: [{ kind: "slack", enabled: true, summary: "hooks.slack.com, webhook ...XXXXXX" }] });
    const list = await said(() => connections(me.o, me.deps));
    expect(tooWide(list.text)).toEqual([]);
    expect(flat(list.text)).toMatch(/Slack on hooks\.slack\.com, webhook \.\.\.XXXXXX last sent/);
    expect(flat(list.text)).toContain("npx genclass connections add slack");
    expect(flat((await said(() => connections({ ...me.o, args: ["test", "slack"] }, me.deps))).text)).toContain("A test record reached Slack.");
    expect(flat((await said(() => connections({ ...me.o, args: ["off", "slack"] }, me.deps))).text)).toContain("Slack is off. Its settings are kept.");
    expect(flat((await said(() => connections(me.o, me.deps))).text)).toMatch(/Slack off/);
    expect(flat((await said(() => connections({ ...me.o, args: ["remove", "slack"], yes: true }, me.deps))).text)).toContain("Slack is removed.");
    expect((await fetchConnections(me.creds, me.app.id, me.deps) as any).list).toEqual([]);
    // a wrong address is the server's sentence; an unknown destination or change lists what there is
    const bad = await typing(["https://example.com/hook"], () => said(() => connections({ ...me.o, args: ["add", "slack"] }, me.deps)));
    expect(bad.code).toBe(1);
    expect(flat(bad.text)).toContain("paste a Slack incoming webhook URL");
    const which = await said(() => connections({ ...me.o, args: ["add", "pagerduty"] }, me.deps));
    expect(which.code).toBe(2);
    expect(flat(which.text)).toContain("slack, sentry, posthog, datadog, webhook");
    // with nobody at a terminal nothing is asked and nothing is set
    const piped = await said(() => connections({ ...me.o, args: ["add", "sentry"] }, me.deps));
    expect(piped.code).toBe(1);
    expect(flat(piped.text)).toContain("needs a terminal");
  });
});

describe("genclass export and funnels (src/manage.mjs)", () => {
  it("export: Team gets every stored event into a file, or to a pipe; Free is told which plan has it", async () => {
    const { env, sql } = setup(LIVE);
    const me = await account(env);
    const no = await said(() => exportEvents(me.o, me.deps));
    expect(no.code).toBe(1);
    expect(flat(no.text)).toContain("The stored events as a file comes with the Team plan.");
    expect(flat(no.text)).toContain("npx genclass plan");
    team3(sql, me.account.id);
    resetOwnerCache();
    await sendBatch(env, me.app.token, [{ t: "session", host: "shop.example", route: "/" }, ...detection("stale", "/search")]);
    const day = now().toISOString().slice(0, 10);
    const got = await said(() => exportEvents(me.o, me.deps));
    expect(got.code).toBe(0);
    expect(tooWide(got.text)).toEqual([]);
    const from = new Date(now().getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
    const name = `genclass-shop-${from}-${day}.jsonl`;
    expect(got.text).toContain(`Wrote ${name}`);
    expect(flat(got.text)).toContain("3 events");
    const lines = readFileSync(join(me.dir, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event.t)).toEqual(["session", "decision", "detect"]);
    // CSV to a pipe: the data and nothing else
    const csv = await said(() => exportEvents({ ...me.o, format: "csv", out: "-" }, me.deps));
    expect(csv.text.split(/\r?\n/)[0]).toBe("received_at,session,runtime,model,country,type,seq,route,trigger,diagnosis,event");
    expect(csv.text.split(/\r?\n/).filter(Boolean)).toHaveLength(4);
    // days with nothing stored write no file; days that are not days say how they are written
    const none = await said(() => exportEvents({ ...me.o, from: "2026-11-01", to: "2026-11-02", out: "none.jsonl" }, me.deps));
    expect(flat(none.text)).toContain("No events stored for 2026-11-01 to 2026-11-02.");
    expect(existsSync(join(me.dir, "none.jsonl"))).toBe(false);
    expect((await said(() => exportEvents({ ...me.o, from: "yesterday" }, me.deps))).code).toBe(2);
    expect(JSON.parse((await said(() => exportEvents({ ...me.o, json: true, out: "j.jsonl" }, me.deps))).text)).toMatchObject({ ok: true, events: 3, format: "jsonl" });
  });

  it("funnels: add one, see it counted in analytics, remove it; without visitor analytics the plan is named", async () => {
    const { env, sql } = setup(LIVE);
    const me = await account(env);
    const no = await said(() => funnels({ ...me.o, args: ["add", "Checkout", "/cart", "/checkout"] }, me.deps));
    expect(no.code).toBe(1);
    expect(flat(no.text)).toContain("Funnels (part of visitor analytics) comes with the Team plan.");
    team3(sql, me.account.id);
    expect(flat((await said(() => funnels(me.o, me.deps))).text)).toContain("No funnel yet.");
    const add = await said(() => funnels({ ...me.o, args: ["add", "Checkout", "/cart", "/checkout", "/thanks"] }, me.deps));
    expect(add.code).toBe(0);
    expect(flat(add.text)).toContain("Saved the funnel Checkout: /cart → /checkout → /thanks");
    const view = await said(() => analytics({ ...me.o, section: "funnels" }, me.deps));
    expect(flat(view.text)).toContain("Checkout /cart 0 /checkout 0 /thanks 0");
    expect((await said(() => funnels({ ...me.o, args: ["add", "One"] }, me.deps))).code).toBe(2);
    expect((await said(() => funnels({ ...me.o, args: ["remove", "Nope"] }, me.deps))).code).toBe(2);
    expect(flat((await said(() => funnels({ ...me.o, args: ["remove", "checkout"] }, me.deps))).text)).toContain("Removed the funnel checkout.");
    expect(JSON.parse((await said(() => funnels({ ...me.o, json: true }, me.deps))).text).funnels).toEqual([]);
  });
});

describe("genclass agent link (src/manage.mjs agentLink)", () => {
  it("makes the app's private link once it is said yes to, and gives it to the agent in the person's own settings", async () => {
    const { env } = setup();
    const me = await account(env);
    // nobody at a terminal and no --yes: nothing is made
    const asked = await said(() => agentLink(me.o, me.deps));
    expect(asked.code).toBe(1);
    expect(flat(asked.text)).toContain("add --yes");
    const ran: { cmd: string; args: string[]; cwd: string }[] = [];
    const made = await said(() => agentLink({ ...me.o, yes: true }, { ...me.deps, find: () => null, copy: async () => true, run: async (cmd: string, args: string[], cwd: string) => (ran.push({ cmd, args, cwd }), 0) }));
    expect(made.code).toBe(0);
    const url = /https:\/\/genclass\.dev\/dashboard\/[A-Za-z0-9]{32}/.exec(made.text)![0];
    const f = flat(made.text);
    expect(f).toContain("Anyone with the link can read this app's numbers, so it goes into your own agent settings, not into the repository.");
    expect(f).toContain(`claude mcp add genclass -e GENCLASS_DASHBOARD=${url} -e GENCLASS_REPORT=on -- npx -y @genclass/mcp@`);
    expect(f).toContain("The command is on your clipboard.");
    expect(ran).toEqual([]);
    // the link reads the app's numbers without a sign-in, which is what the MCP server does with it
    expect((await handle(new Request(`${HOST}/api/projects/${url.split("/").pop()}?range=7d`), env, { now: () => now() })).status).toBe(200);
    expect(claudeAdd("U").slice(0, 8)).toEqual(["mcp", "add", "genclass", "-e", "GENCLASS_DASHBOARD=U", "-e", "GENCLASS_REPORT=on", "--"]);
    // with Claude Code on the machine and a yes, it is added there, in the folder
    const withClaude = await typing(["", ""], () => said(() => agentLink(me.o, { ...me.deps, find: () => "/bin/claude", copy: async () => true, run: async (cmd: string, args: string[], cwd: string) => (ran.push({ cmd, args, cwd }), 0) })));
    expect(withClaude.code).toBe(0);
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ cmd: "/bin/claude", cwd: me.dir });
    expect(ran[0]!.args.slice(0, 3)).toEqual(["mcp", "add", "genclass"]);
    expect(flat(withClaude.text)).toContain("Claude Code has it for this folder.");
    // a second link replaced the first
    expect((await handle(new Request(`${HOST}/api/projects/${url.split("/").pop()}?range=7d`), env, { now: () => now() })).status).toBe(404);
  });
});

describe("genclass ask (src/ask.mjs)", () => {
  const model = (text: string, seen: any[] = []) => (async (_url: string, init?: RequestInit) => (seen.push(JSON.parse(String(init!.body))), new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 }))) as Model;

  it("a question is answered from the app's numbers; a follow-up carries the turn before it; what is sent is said first", async () => {
    const { env } = setup({ OPENAI_API_KEY: "sk-test-0123456789abcdef0123" });
    const seen: any[] = [];
    const me = await account(env, model("Two problems this week.\n\n- /checkout: the same request went out twice\n- /search: an older answer replaced a newer one, which is the kind of thing that happens when a slow response for an earlier query lands last", seen));
    await sendBatch(env, me.app.token, [{ t: "session", host: "shop.example", route: "/" }, ...detection("duplicate", "/checkout"), ...detection("stale", "/search")]);
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => (errs.push(String(s)), true)) as never);
    const first = await said(() => ask({ ...me.o, question: "What is going wrong?" }, me.deps));
    spy.mockRestore();
    expect(first.code).toBe(0);
    expect(tooWide(first.text)).toEqual([]);
    // nobody at a terminal: what is sent is said, once, on the error stream
    expect(errs.join("")).toContain("Your question goes to GenClass's model on genclass.dev, with this app's dashboard numbers");
    expect(errs.join("")).toContain("No code leaves your machine");
    const f = flat(first.text);
    expect(f).toContain("▎ Two problems this week.");
    expect(f).toContain("▎ - /checkout: the same request went out twice");
    expect(f).toContain("From Shop's numbers, last 7 days • 2 questions left today");
    expect(f).toContain("npx genclass problems");
    // list lines keep their mark and wrap under their own text
    expect(plainLines(first.text).some((l) => /^ {2}▎ {3}\S/.test(l))).toBe(true);
    expect(seen[0].messages.at(-1)).toEqual({ role: "user", content: "What is going wrong?" });
    expect(JSON.parse(seen[0].messages[1].content.slice(seen[0].messages[1].content.indexOf("{"))).problems_by_kind_and_page).toHaveLength(2);
    // the follow-up: the first question and its answer go along
    await said(() => ask({ ...me.o, question: "And on which page?" }, me.deps));
    expect(seen[1].messages.slice(2).map((m: any) => [m.role, m.content.slice(0, 22)])).toEqual([["user", "What is going wrong?"], ["assistant", "Two problems this week"], ["user", "And on which page?"]]);
    // as data
    const j = JSON.parse((await said(() => ask({ ...me.o, json: true, question: "How many?" }, me.deps))).text);
    expect(j).toMatchObject({ ok: true, app: "Shop", question: "How many?", remaining_today: 0 });
    // the day's runs are used: said, with the plan that has more and the numbers themselves
    const over = await said(() => ask({ ...me.o, question: "Once more?" }, me.deps));
    expect(over.code).toBe(1);
    expect(flat(over.text)).toContain("Today's 3 model runs are used (ask and suggest share them).");
    expect(flat(over.text)).toContain("npx genclass plan");
    expect(flat(over.text)).toContain("npx genclass problems");
    expect(seen).toHaveLength(3);
  });

  it("on a terminal the first question waits for Enter after saying what is sent, and q sends nothing", async () => {
    const { env } = setup({ OPENAI_API_KEY: "sk-test-0123456789abcdef0123" });
    const seen: any[] = [];
    const me = await account(env, model("Fine.", seen));
    const saved: Record<string, unknown>[] = [];
    const deps = { ...me.deps, savePrefs: (p: Record<string, unknown>) => (saved.push(p), true) };
    const stopped = await typing(["q"], () => said(() => ask({ ...me.o, question: "How is it?" }, deps)));
    expect(stopped.code).toBe(1);
    expect(flat(stopped.text)).toContain("The model is OpenAI's.");
    expect(seen).toEqual([]);
    expect(saved).toEqual([]);
    const went = await typing([""], () => said(() => ask({ ...me.o, question: "How is it?" }, deps)));
    expect(went.code).toBe(0);
    expect(flat(went.text)).toContain("▎ Fine.");
    expect(saved).toEqual([{ askTold: true }]);
    // told once: the next question asks nothing
    const again = await said(() => ask({ ...me.o, question: "And now?" }, { ...deps, readPrefs: () => ({ askTold: true }) }));
    expect(again.text).not.toContain("OpenAI");
  });

  it("an answer's Markdown marks become the terminal's: no backticks or asterisks left on the screen", () => {
    expect(marks("Fix `/` first, then **the slow** page")).toBe("Fix / first, then the slow page");
    expect(answerLines("- Run `npx genclass fix` on **/checkout**, then look again", 40)).toEqual(["- Run npx genclass fix on /checkout,", "  then look again"]);
    expect(marks("a ` b and ** c")).toBe("a ` b and ** c");
  });

  it("no model on the server, a sign-in from before, and no question each say the next step", async () => {
    const { env, sql } = setup();
    const me = await account(env);
    const deps = { ...me.deps, readPrefs: () => ({ askTold: true }) };
    expect(await askModel(me.creds, { id: me.app.id, question: "How is it?" }, me.deps)).toMatchObject({ ok: true, answer: null, why: "no-model" });
    const none = await said(() => ask({ ...me.o, question: "How is it?" }, deps));
    expect(none.code).toBe(1);
    expect(flat(none.text)).toContain("This genclass.dev has no model to ask");
    expect(flat(none.text)).toContain("npx genclass problems");
    older(sql);
    const old = await said(() => ask({ ...me.o, question: "How is it?" }, deps));
    expect(old.code).toBe(1);
    expect(flat(old.text)).toContain("This sign-in is from before the command could do this. Run npx genclass login once");
    const empty = await said(() => ask({ ...me.o, question: "  " }, deps));
    expect(empty.code).toBe(2);
    expect(empty.text).toContain('npx genclass ask "what is going wrong on my site?"');
  });
});
