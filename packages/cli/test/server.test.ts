// The `genclass` command against the real collector, in process (telemetry-worker/src/collector.ts handle, with its
// own test database): what src/api.mjs asks is what src/cli.ts answers, and a project walks from "fresh" to "first
// page seen" on real routes.
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../../../telemetry-worker/src/collector.js";
import { CLI_DASHBOARD_FROM } from "../../../telemetry-worker/src/cli.js";
import { cliToken, createApp, detection, now, resetClock, sendBatch, setNow, setPlan, setup, signedIn } from "../../../telemetry-worker/test/account-helpers.js";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { run as runInit } from "../../runtime/bin/lib/init.mjs";
import { fetchApp, fetchOverview, fetchRepoStatus, requestPlan } from "../src/api.mjs";
import { dashboard } from "../src/app.mjs";
import { readState } from "../src/state.mjs";
import { HOST, isolate, printed, tempDir, viteApp } from "./helpers.js";

isolate();
beforeEach(() => {
  resetClock();
});

type Env = Parameters<typeof handle>[1];

/** A fetch that reaches the collector in process; `model` answers the model's API when the worker asks it. */
const through = (env: Env, model?: (url: string, init?: RequestInit) => Promise<Response>) =>
  (async (input: string | URL, init?: RequestInit) => handle(new Request(String(input), { method: init?.method, headers: init?.headers, body: init?.body as never }), env, { now: () => now(), fetch: model as never })) as unknown as typeof fetch;

/** An account with a CLI session, as `genclass login` leaves it. */
async function account(env: Env) {
  const me = await signedIn(env);
  const creds = { host: HOST, access_token: await cliToken(env, me.cookie), account: { id: me.account.id, email: me.account.email, github_login: null } };
  saveCredentials(creds);
  return { ...me, creds };
}

const check = (id: string, weight: number) => ({ id, area: "search", title: `Title of ${id}`, weight, status: "fail", evidence: [`evidence for ${id}`] });
const DIGEST = { app: { name: "shop", framework: "Vite + React", site: "https://shop.example", payments: null, hosting: null }, checks: [check("canonical", 2), check("https", 5), check("title", 4), check("sitemap", 3), check("llms-txt", 1)].map(({ status: _s, ...c }) => c), passed: 20, unknown: 1 };

describe("genclass against the collector (src/api.mjs, telemetry-worker/src/cli.ts)", () => {
  it("the overview: the account, its plan and what suggestions it has, as the server has them", async () => {
    const { env } = setup();
    const me = await account(env);
    const app = await createApp(env, me.cookie, "Shop");
    const r = await fetchOverview(me.creds, { fetchFn: through(env) });
    expect(r).toMatchObject({
      ok: true,
      account: { id: me.account.id, email: "ada@example.com", github_login: null },
      plan: { id: "free", name: "Free" },
      suggestions: { perDay: 3, shown: 1, usedToday: 0, model: false },
      github: { app: false, installUrl: null, connectUrl: null },
      billingUrl: `${HOST}/account/billing`,
    });
    expect((r as any).projects.map((p: any) => [p.name, p.token, p.dashboard_url])).toEqual([["Shop", app.token, `${HOST}/account/apps/${app.id}`]]);
    // a session the server does not know
    expect(await fetchOverview({ ...me.creds, access_token: "gcs_notarealsessiontoken000" }, { fetchFn: through(env) })).toMatchObject({ ok: false, status: 401 });
  });

  it("a project goes from fresh to first page seen on the real routes", async () => {
    const { env } = setup();
    const me = await account(env);
    const dir = tempDir();
    viteApp(dir);
    const deps = { runGit: () => null, fetchFn: through(env) };
    const at = async () => Object.fromEntries((await readState({ cwd: dir }, deps)).steps.map((s) => [s.id, s.state]));
    expect(await at()).toMatchObject({ account: "done", runtime: "next", dashboard: "todo" });
    // the app in the account, and the runtime added with its token
    const app = await createApp(env, me.cookie, "shop");
    await printed(async () => expect(await runInit("init", ["--cwd", dir, "--yes", "--no-install", "--no-network", "--token", app.token])).toBe(0));
    expect(await at()).toMatchObject({ runtime: "done", dashboard: "waiting" });
    // the live site sends its first batch
    expect((await sendBatch(env, app.token, detection())).status).toBe(202);
    const s = await readState({ cwd: dir }, { ...deps, now: now().getTime() });
    expect(s.steps.find((x) => x.id === "dashboard")).toMatchObject({ state: "done", detail: "last page just now" });
    expect(s.app).toMatchObject({ name: "shop", token: app.token, dashboardUrl: `${HOST}/account/apps/${app.id}` });
  });

  it("npx genclass dashboard shows the app's own numbers from the real route, and an older sign-in is asked to sign in again", async () => {
    const { env, sql } = setup();
    setNow(new Date(Date.parse(CLI_DASHBOARD_FROM) + 3_600_000));
    const me = await account(env);
    const dir = tempDir();
    viteApp(dir);
    const app = await createApp(env, me.cookie, "shop");
    await printed(async () => expect(await runInit("init", ["--cwd", dir, "--yes", "--no-install", "--no-network", "--token", app.token])).toBe(0));
    expect((await sendBatch(env, app.token, [{ t: "session", host: "shop.example", route: "/" }, ...detection("duplicate", "/checkout"), ...detection("stale", "/orders/:id")])).status).toBe(202);
    const deps = { runGit: () => null, fetchFn: through(env), now: now().getTime() };
    // Free: the totals, and the way to the rest (the problems, their pages and the fix prompts are Pro's)
    const data = await fetchApp(me.creds, app.id, "7d", deps);
    expect(data).toMatchObject({ ok: true, name: "shop", range: "7d", totals: { found: 2, checks: 0 }, problems: [], visitors: null, visitorsPlan: { plan: "Pro", upgradeUrl: `${HOST}/account/billing` }, problemsPlan: { plan: "Pro", trialDays: 3, price: "$15 / developer / month", upgradeUrl: `${HOST}/account/billing?project=${app.id}` }, dashboardUrl: `${HOST}/account/apps/${app.id}` });
    let code = -1;
    const freeView = await printed(async () => (code = await dashboard({ cwd: dir }, deps)));
    expect(code).toBe(0);
    expect(freeView).toMatch(/Problems found\s+2/);
    expect(freeView.replace(/\s+/g, " ")).toContain("The problems, the pages they happen on and a fix prompt for each come with Pro. Free shows the totals.");
    expect(freeView.replace(/\s+/g, " ")).toContain("3 days free, then $15 / developer / month. Cancel any time. Start: npx genclass upgrade");
    expect(freeView).not.toContain("the same request went out twice");
    // on Pro (here GenClass's grant for this app): every problem
    sql.db.prepare("UPDATE projects SET comp_until = '2027-12-31T00:00:00.000Z', comp_plan = 'team' WHERE id = ?").run(app.id);
    const paid = await fetchApp(me.creds, app.id, "7d", deps);
    expect((paid as any).problemsPlan).toBeNull();
    expect((paid as any).problems.map((p: any) => p.key).sort()).toEqual(["duplicate\t/checkout", "stale\t/orders/:id"]);
    const view = await printed(async () => (code = await dashboard({ cwd: dir }, deps)));
    expect(code).toBe(0);
    expect(view).toContain("last 7 days");
    expect(view).toMatch(/Problems found\s+2/);
    expect(view).toMatch(/1\s+the same request went out twice\s+\/checkout/);
    expect(view).toMatch(/1\s+old data replaced newer data\s+\/orders\/:id/);
    expect(view).toContain(`${HOST}/account/apps/${app.id}`);
    expect(view).not.toContain("SECRET PAGE TEXT");
    // for a coding agent: the same as data
    const j = JSON.parse(await printed(async () => expect(await dashboard({ cwd: dir, json: true }, deps)).toBe(0)));
    expect(j).toMatchObject({ ok: true, app: "shop", totals: { found: 2 } });
    // a sign-in approved before the approval page said the command can show dashboards
    sql.db.exec(`UPDATE auth_sessions SET created = '${new Date(Date.parse(CLI_DASHBOARD_FROM) - 1000).toISOString()}' WHERE kind = 'cli'`);
    expect(await fetchApp(me.creds, app.id, "7d", deps)).toMatchObject({ ok: false, status: 403, reauth: true });
    const old = await printed(async () => expect(await dashboard({ cwd: dir }, deps)).toBe(1));
    expect(old).toContain("npx genclass login");
    expect(old).toContain(`${HOST}/account/apps/${app.id}`);
  });

  it("the GitHub App's status and the plan come back in the shapes the command reads", async () => {
    const { env, sql } = setup({ OPENAI_API_KEY: "sk-test-0123456789abcdef0123" });
    const me = await account(env);
    // a server without the app knows nothing about a repository and says so
    expect(await fetchRepoStatus(me.creds, "acme/shop", { fetchFn: through(env) })).toEqual({ ok: true, known: false, installed: null, evidence: false, prs: 0, last: null, private: false, needsPlan: false, paused: false, connectUrl: null, installUrl: null });
    expect(await fetchRepoStatus(me.creds, "not a repo", { fetchFn: through(env) })).toMatchObject({ ok: false, status: 400 });

    // the plan: the model's order, its own ideas and a website design; Free is shown the first item and the counts
    let asked = 0;
    const design = { title: "Calm product pages", inspired_by: "https://linear.app", why: "why linear", prompt: "Redesign the home page in a calm, precise style: ".repeat(4) };
    const model = async (url: string, init?: RequestInit) => {
      // the design's site answers (the server drops a design whose site does not)
      if (String(url).startsWith("https://linear.app")) return new Response("ok", { status: 200 });
      asked++;
      const failed = JSON.parse(JSON.parse(String(init!.body)).messages[1].content).failed as { id: string }[];
      const items = [...failed].reverse().map((c) => ({ id: c.id, why: `why ${c.id}`, step: `step ${c.id}`, prompt: `prompt ${c.id}` }));
      const ideas = [1, 2].map((n) => ({ title: `idea ${n}`, why: `why idea ${n}`, step: `step idea ${n}`, prompt: `prompt idea ${n}` }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items, ideas, designs: [design] }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const free = await requestPlan(me.creds, DIGEST, { fetchFn: through(env, model) });
    const shut = {
      ok: true,
      source: "model",
      plan: { id: "free", name: "Free" },
      total: 5,
      items: [{ id: "llms-txt", why: "why llms-txt", step: "step llms-txt", prompt: "prompt llms-txt" }],
      locked: 4,
      lockedIds: ["sitemap", "title", "https", "canonical"],
      // what Free does not see is counted, never sent
      ideas: [],
      designs: [],
      ideasLocked: 2,
      designsLocked: 1,
      upgradeUrl: `${HOST}/account/billing?plan=team&from=cli`,
      upgradePlan: { plan: "Pro", price: "$15 / developer / month", trialDays: 3 },
      limited: false,
    };
    expect(free).toMatchObject({ ...shut, cachedAt: null, remainingToday: 2 });
    expect(asked).toBe(1);
    // Free again: the same answer, kept from the first run, and no new model run
    const again = await requestPlan(me.creds, DIGEST, { fetchFn: through(env, model) });
    expect(again).toMatchObject({ ...shut, remainingToday: 2 });
    expect((again as any).cachedAt).toMatch(/^20\d\d-/);
    expect(asked).toBe(1);
    // with Pro: all of it, a new run, the ideas and the design with the site it is inspired by
    setPlan(sql, me.account.id, "free", { comp_until: new Date(now().getTime() + 86_400_000).toISOString(), comp_plan: "team" });
    const team = await requestPlan(me.creds, DIGEST, { fetchFn: through(env, model) });
    expect(team).toMatchObject({ ok: true, source: "model", plan: { id: "team", name: "Pro" }, total: 5, locked: 0, lockedIds: [], upgradeUrl: null, ideasLocked: 0, designsLocked: 0, cachedAt: null });
    expect((team as any).items).toHaveLength(5);
    expect((team as any).ideas.map((i: any) => i.title)).toEqual(["idea 1", "idea 2"]);
    expect((team as any).designs).toEqual([{ title: "Calm product pages", inspiredBy: "https://linear.app", why: "why linear", prompt: design.prompt.trim() }]);
    expect(asked).toBe(2);
    // a server without the route (an older collector) says so, and the command carries on without a plan
    const none = (async () => new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    expect(await requestPlan(me.creds, DIGEST, { fetchFn: none })).toMatchObject({ ok: false, status: 404, missing: true });
    expect(await fetchRepoStatus(me.creds, "acme/shop", { fetchFn: none })).toMatchObject({ ok: false, missing: true });
  });
});
