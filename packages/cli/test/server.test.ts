// The `genclass` command against the real collector, in process (telemetry-worker/src/collector.ts handle, with its
// own test database): what src/api.mjs asks is what src/cli.ts answers, and a project walks from "fresh" to "first
// page seen" on real routes.
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../../../telemetry-worker/src/collector.js";
import { cliToken, createApp, detection, now, resetClock, sendBatch, setPlan, setup, signedIn } from "../../../telemetry-worker/test/account-helpers.js";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { run as runInit } from "../../runtime/bin/lib/init.mjs";
import { fetchOverview, fetchRepoStatus, requestPlan } from "../src/api.mjs";
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
      suggestions: { perDay: 3, shown: 3, usedToday: 0, model: false },
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
    expect(await at()).toMatchObject({ account: "done", runtime: "next", "first-page": "todo" });
    // the app in the account, and the runtime added with its token
    const app = await createApp(env, me.cookie, "shop");
    await printed(async () => expect(await runInit("init", ["--cwd", dir, "--yes", "--no-install", "--no-network", "--token", app.token])).toBe(0));
    expect(await at()).toMatchObject({ runtime: "done", "first-page": "waiting" });
    // the live site sends its first batch
    expect((await sendBatch(env, app.token, detection())).status).toBe(202);
    const s = await readState({ cwd: dir }, { ...deps, now: now().getTime() });
    expect(s.steps.find((x) => x.id === "first-page")).toMatchObject({ state: "done", detail: "last page just now" });
    expect(s.app).toMatchObject({ name: "shop", token: app.token, dashboardUrl: `${HOST}/account/apps/${app.id}` });
  });

  it("the GitHub App's status and the plan come back in the shapes the command reads", async () => {
    const { env, sql } = setup({ OPENAI_API_KEY: "sk-test-0123456789abcdef0123" });
    const me = await account(env);
    // a server without the app knows nothing about a repository and says so
    expect(await fetchRepoStatus(me.creds, "acme/shop", { fetchFn: through(env) })).toEqual({ ok: true, known: false, installed: null, evidence: false, prs: 0, last: null, private: false, needsPlan: false, paused: false, connectUrl: null, installUrl: null });
    expect(await fetchRepoStatus(me.creds, "not a repo", { fetchFn: through(env) })).toMatchObject({ ok: false, status: 400 });

    // the plan: the model's order, Free shown the first three and told which are held back
    const model = async (_url: string, init?: RequestInit) => {
      const failed = JSON.parse(JSON.parse(String(init!.body)).messages[1].content).failed as { id: string }[];
      const items = [...failed].reverse().map((c) => ({ id: c.id, why: `why ${c.id}`, step: `step ${c.id}`, prompt: `prompt ${c.id}` }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const free = await requestPlan(me.creds, DIGEST, { fetchFn: through(env, model) });
    expect(free).toEqual({
      ok: true,
      source: "model",
      plan: { id: "free", name: "Free" },
      total: 5,
      items: ["llms-txt", "sitemap", "title"].map((id) => ({ id, why: `why ${id}`, step: `step ${id}`, prompt: `prompt ${id}` })),
      locked: 2,
      lockedIds: ["https", "canonical"],
      upgradeUrl: `${HOST}/account/billing`,
      remainingToday: 2,
      limited: false,
    });
    // with Team: all of it
    setPlan(sql, me.account.id, "free", { comp_until: new Date(now().getTime() + 86_400_000).toISOString(), comp_plan: "team" });
    const team = await requestPlan(me.creds, DIGEST, { fetchFn: through(env, model) });
    expect(team).toMatchObject({ ok: true, source: "model", plan: { id: "team", name: "Team" }, total: 5, locked: 0, lockedIds: [], upgradeUrl: null });
    expect((team as any).items).toHaveLength(5);
    // a server without the route (an older collector) says so, and the command carries on without a plan
    const none = (async () => new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    expect(await requestPlan(me.creds, DIGEST, { fetchFn: none })).toMatchObject({ ok: false, status: 404, missing: true });
    expect(await fetchRepoStatus(me.creds, "acme/shop", { fetchFn: none })).toMatchObject({ ok: false, missing: true });
  });
});
