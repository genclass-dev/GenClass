// The `genclass` command's routes (src/cli.ts, src/suggest.ts): the account's overview, what the GitHub App is doing
// on one repository, and the suggestions plan (the model, the plan's numbers, what is never stored).
import { beforeEach, describe, expect, it } from "vitest";
import { askModel, byWeight, DEFAULT_MODEL, MODEL_URL, planFromAnswer, readDigest, suggestRetention, suggestionLimits } from "../src/suggest.js";
import { PLANS } from "../src/plans.js";
import { advance, call, cliToken, createApp, now, resetClock, setPlan, setup, signedIn } from "./account-helpers.js";
import { APP_ID, fakeGithub, githubSetup, INSTALLATION, OWNER, REPO } from "./github-helpers.js";

beforeEach(() => {
  resetClock();
});

const KEY = "sk-test-model-key-0123456789abcdef";
const FUTURE = () => new Date(now().getTime() + 86_400_000).toISOString();

/** A signed-in account with a CLI session: the bearer token `genclass login` would save. */
async function cliUser(env: Parameters<typeof call>[0], email = "ada@example.com") {
  const me = await signedIn(env, email);
  return { ...me, bearer: await cliToken(env, me.cookie) };
}

const check = (id: string, weight: number, over: Record<string, unknown> = {}) => ({ id, area: "search", title: `Title of ${id}`, weight, evidence: [`evidence for ${id}`], ...over });
const DIGEST = {
  app: { name: "polar-parts", framework: "Next.js 15 (App Router)", site: "https://polarparts.example", payments: "stripe", hosting: "vercel" },
  checks: [check("canonical", 2), check("text-without-js", 5), check("description", 3), check("test-keys-live", 5), check("llms-txt", 1)],
  passed: 17,
  unknown: 2,
};

/** A stand-in for the model's API: records each request and answers with `content` (a string, or what a function returns). */
function fakeModel(content: string | ((body: any) => string), status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers as HeadersInit).entries()), body });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "nope" } }), { status });
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "function" ? content(body) : content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}
const answer = (items: { id: string; why?: string; step?: string; prompt?: string }[]) => JSON.stringify({ items: items.map((i) => ({ why: `why ${i.id}`, step: `step ${i.id}`, prompt: `prompt ${i.id}`, ...i })) });

describe("genclass command: GET /api/cli/overview (src/cli.ts)", () => {
  it("needs a signed-in account; a CLI session gets the account, its plan, its apps and what suggestions it has", async () => {
    const { env, sql } = githubSetup();
    expect((await call(env, "GET", "/api/cli/overview", { origin: null })).status).toBe(401);
    expect((await call(env, "GET", "/api/cli/overview", { bearer: "gcs_notasession0123456789", origin: null })).status).toBe(401);
    const me = await cliUser(env);
    const app = await createApp(env, me.cookie, "Shop");
    const r = await call(env, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.account).toEqual({ id: me.account.id, email: "ada@example.com", github_login: null });
    expect(j.plan).toEqual({ id: "free", name: "Free" });
    expect(j.suggestions).toEqual({ per_day: 3, shown: 3, used_today: 0, model: false });
    expect(j.projects.map((p: any) => [p.id, p.name, p.token, p.last_event])).toEqual([[app.id, "Shop", app.token, null]]);
    expect(j.github).toEqual({ app: true, install_url: "https://genclass.dev/github/install", connect_url: "https://genclass.dev/github/connect" });
    expect(j.billing_url).toBe("https://genclass.dev/account/billing");
    // the browser session reads it too; nothing else is a method of it
    expect((await call(env, "GET", "/api/cli/overview", { cookie: me.cookie, origin: null })).status).toBe(200);
    expect((await call(env, "POST", "/api/cli/overview", { bearer: me.bearer, body: {} })).status).toBe(405);
    expect((await call(env, "GET", "/api/cli/nothing", { bearer: me.bearer, origin: null })).status).toBe(404);
    // a plan with more, and a server that has a model
    setPlan(sql, me.account.id, "free", { comp_until: FUTURE(), comp_plan: "team" });
    const team = (await (await call({ ...env, OPENAI_API_KEY: KEY }, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any;
    expect(team.plan).toEqual({ id: "team", name: "Team" });
    expect(team.suggestions).toEqual({ per_day: 30, shown: null, used_today: 0, model: true });
    expect(JSON.stringify(team)).not.toContain(KEY);
  });

  it("a server without the GitHub App says so, and every plan in plans.json has its numbers", async () => {
    const { env } = setup();
    const me = await cliUser(env);
    const j = (await (await call(env, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any;
    expect(j.github).toEqual({ app: false, install_url: null, connect_url: null });
    expect(PLANS.map((p) => [p.id, suggestionLimits(p)])).toEqual([
      ["free", { per_day: 3, shown: 3 }],
      ["team", { per_day: 30, shown: null }],
      ["enterprise", { per_day: 100, shown: null }],
    ]);
    // a plan that leaves the numbers out is the smallest
    expect(suggestionLimits({ ...PLANS[0]!, suggestions: undefined })).toEqual({ per_day: 3, shown: 3 });
  });
});

describe("genclass command: GET /api/cli/github (src/cli.ts, src/github/http.ts repoStatusForAccount)", () => {
  const cookieOf = (r: Response, name: string) => r.headers.getSetCookie().find((x) => x.startsWith(`${name}=`))!.split(";")[0]!;
  /** GitHub's view of the person, then Connect GitHub in the browser session. */
  async function connect(env: Parameters<typeof call>[0], cookie: string, repos: Record<string, unknown>[]) {
    const gh = fakeGithub();
    gh.user.installations = [{ id: INSTALLATION, app_id: Number(APP_ID), account: OWNER, repository_selection: "selected", suspended_at: null }];
    gh.user.repositories.set(INSTALLATION, repos);
    const start = await call(env, "GET", "/github/connect", { cookie, origin: null });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const back = await call(env, "GET", `/github/callback?code=good-code&state=${encodeURIComponent(state)}`, { cookie: `${cookie}; ${cookieOf(start, "gc_oauth_ghapp")}`, origin: null, fetch: gh.fetch });
    expect(back.status).toBe(302);
    return gh;
  }
  const can = { admin: false, push: true, pull: true };
  const REPOS = [
    { id: REPO.id, full_name: REPO.full_name, private: false, default_branch: "main", permissions: can },
    { id: 7002, full_name: "acme/vault", private: true, default_branch: "main", permissions: can },
  ];
  const URLS = { connect_url: "https://genclass.dev/github/connect", install_url: "https://genclass.dev/github/install" };
  const UNKNOWN = { known: false, installed: null, evidence: false, prs: 0, last: null, private: false, needs_plan: false, paused: false, ...URLS };

  it("says nothing about a repository until GitHub has told this account it can reach it", async () => {
    const { env, sql } = githubSetup();
    const me = await cliUser(env);
    const get = async (repo: string, bearer = me.bearer) => call(env, "GET", `/api/cli/github?repo=${encodeURIComponent(repo)}`, { bearer, origin: null });
    expect((await call(env, "GET", "/api/cli/github?repo=acme/shop", { origin: null })).status).toBe(401);
    for (const bad of ["", "acme", "acme/shop/x", "acme/..", "https://github.com/acme/shop", "a b/c"]) expect((await get(bad)).status, bad).toBe(400);
    // the app has done things on the repository, and this account has no answer from GitHub: nothing of it is said
    const iso = now().toISOString();
    sql.db.prepare("INSERT INTO github_repo_facts (repo_id, installation_id, evidence, updated) VALUES (?, ?, ?, ?)").run(REPO.id, INSTALLATION, iso, iso);
    for (const [n, reviews] of [[1, 2], [2, 1], [3, 0]]) sql.db.prepare("INSERT INTO github_prs (repo_id, number, installation_id, reviews, updated) VALUES (?, ?, ?, ?, ?)").run(REPO.id, n!, INSTALLATION, reviews!, iso);
    expect(await (await get("acme/shop")).json()).toEqual({ repo: "acme/shop", ...UNKNOWN });

    // after Connect: what the app is doing there, whatever the case of the name typed
    await connect(env, me.cookie, REPOS);
    expect(await (await get("Acme/Shop")).json()).toEqual({ repo: "acme/shop", known: true, installed: true, evidence: true, prs: 2, last: iso, private: false, needs_plan: false, paused: false, ...URLS });
    // a private repository on an installation without a plan is not reviewed
    expect(await (await get("acme/vault")).json()).toMatchObject({ known: true, installed: true, evidence: false, private: true, needs_plan: true });
    // GitHub's answer does not list it: the app is not on it
    expect(await (await get("acme/other")).json()).toEqual({ repo: "acme/other", ...UNKNOWN, known: true, installed: false });
    // paused on the account page
    expect((await call(env, "POST", `/api/account/github/repos/${REPO.id}`, { cookie: me.cookie, body: { paused: true } })).status).toBe(200);
    expect(await (await get("acme/shop")).json()).toMatchObject({ paused: true });
    // another account has no answer of its own, and learns nothing
    const eve = await cliUser(env, "eve@example.com");
    expect(await (await get("acme/shop", eve.bearer)).json()).toEqual({ repo: "acme/shop", ...UNKNOWN });
    // the answer runs out after 30 minutes
    advance(31 * 60_000);
    expect(await (await get("acme/shop")).json()).toEqual({ repo: "acme/shop", ...UNKNOWN });
  });

  it("an answer cut at 300 repositories does not say a repository it leaves out has no app; a server without the app knows nothing", async () => {
    const { env, sql } = githubSetup();
    const me = await cliUser(env);
    await connect(env, me.cookie, REPOS);
    const row = sql.rows("SELECT id, data FROM challenges WHERE kind = 'ghapp:grant'")[0]!;
    sql.db.prepare("UPDATE challenges SET data = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(String(row.data)), more: true }), row.id as string);
    expect(await (await call(env, "GET", "/api/cli/github?repo=acme/other", { bearer: me.bearer, origin: null })).json()).toMatchObject({ known: false, installed: null });
    expect(await (await call(env, "GET", "/api/cli/github?repo=acme/shop", { bearer: me.bearer, origin: null })).json()).toMatchObject({ known: true, installed: true });
    const bare = setup();
    const you = await cliUser(bare.env);
    expect(await (await call(bare.env, "GET", "/api/cli/github?repo=acme/shop", { bearer: you.bearer, origin: null })).json()).toMatchObject({ known: false, installed: null, connect_url: null, install_url: null });
  });
});

describe("genclass command: POST /api/cli/suggest (src/suggest.ts header)", () => {
  const post = (env: Parameters<typeof call>[0], bearer: string, body: unknown, f?: (url: string, init?: RequestInit) => Promise<Response>) => call(env, "POST", "/api/cli/suggest", { bearer, body, origin: null, fetch: f as never });

  it("takes the CLI's session and a digest of failed checks, and nothing else", async () => {
    const { env } = setup();
    const me = await cliUser(env);
    expect((await call(env, "POST", "/api/cli/suggest", { body: DIGEST, origin: null })).status).toBe(401);
    // a browser session cannot spend an account's runs
    const web = await call(env, "POST", "/api/cli/suggest", { cookie: me.cookie, body: DIGEST });
    expect(web.status).toBe(403);
    expect((await call(env, "GET", "/api/cli/suggest", { bearer: me.bearer, origin: null })).status).toBe(405);
    expect((await call(env, "POST", "/api/cli/suggest", { bearer: me.bearer, body: "checks=1", headers: { "content-type": "text/plain" }, origin: null })).status).toBe(415);
    for (const [body, why] of [
      [{}, "checks must be a list"],
      [{ checks: "x" }, "checks must be a list"],
      [{ checks: [{ id: "Bad Id" }] }, "every check needs an id"],
      [{ checks: [check("a", 1), check("a", 2)] }, "listed twice"],
      [{ checks: Array.from({ length: 61 }, (_, i) => check(`c${i}`, 1)) }, "at most 60 checks"],
    ] as const) {
      const r = await post(env, me.bearer, body);
      expect(r.status, why).toBe(400);
      expect(((await r.json()) as any).error, why).toContain(why);
    }
    expect((await post(env, me.bearer, { ...DIGEST, checks: [check("big", 1, { title: "x".repeat(70_000) })] })).status).toBe(413);
  });

  it("without a model the plan is the checks by weight; Free is shown the first three, a plan with more is shown all", async () => {
    const { env, sql } = setup();
    const me = await cliUser(env);
    const model = fakeModel(answer([]));
    const r = await post(env, me.bearer, DIGEST, model.fetch);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: true,
      source: "checks",
      plan: { id: "free", name: "Free" },
      total: 5,
      items: ["text-without-js", "test-keys-live", "description"].map((id) => ({ id, why: null, step: null, prompt: null })),
      locked: 2,
      locked_ids: ["canonical", "llms-txt"],
      upgrade_url: "https://genclass.dev/account/billing",
      remaining_today: 3,
      limited: false,
    });
    // no model was asked and no run was counted
    expect(model.calls).toEqual([]);
    expect(sql.rows("SELECT * FROM suggest_usage")).toEqual([]);
    setPlan(sql, me.account.id, "free", { comp_until: FUTURE(), comp_plan: "team" });
    const team = (await (await post(env, me.bearer, DIGEST)).json()) as any;
    expect(team.items.map((i: any) => i.id)).toEqual(["text-without-js", "test-keys-live", "description", "canonical", "llms-txt"]);
    expect([team.locked, team.locked_ids, team.upgrade_url, team.remaining_today]).toEqual([0, [], null, 30]);
    // nothing failed: an empty plan, and still no model
    expect(await (await post({ ...env, OPENAI_API_KEY: KEY }, me.bearer, { ...DIGEST, checks: [] }, model.fetch)).json()).toMatchObject({ source: "checks", total: 0, items: [], locked: 0 });
    expect(model.calls).toEqual([]);
  });

  it("with a model: it orders and explains, only the ids that were sent come back, cleaned, and the key goes nowhere but the model", async () => {
    const s = setup({ OPENAI_API_KEY: ` ${KEY}\n` });
    const me = await cliUser(s.env);
    setPlan(s.sql, me.account.id, "free", { comp_until: FUTURE(), comp_plan: "team" });
    // the model reorders, repeats one id, invents another, and writes control characters and an escape sequence
    const model = fakeModel(
      answer([
        { id: "test-keys-live", why: "Nobody can pay:\u001b[31m the site uses a test key.\n\nSecond line." },
        { id: "invented-finding", why: "not a check" },
        { id: "text-without-js" },
        { id: "test-keys-live", why: "again" },
        { id: "description", prompt: "p".repeat(2000) },
      ]),
    );
    const r = await post(s.env, me.bearer, { ...DIGEST, extra: "dropped", app: { ...DIGEST.app, secret: "dropped-too" }, checks: DIGEST.checks.map((c) => ({ ...c, source: "x".repeat(50) })) }, model.fetch);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.source).toBe("model");
    expect(j.items.map((i: any) => i.id)).toEqual(["test-keys-live", "text-without-js", "description", "canonical", "llms-txt"]);
    expect(j.items[0]).toEqual({ id: "test-keys-live", why: "Nobody can pay: [31m the site uses a test key. Second line.", step: "step test-keys-live", prompt: "prompt test-keys-live" });
    expect(j.items[2].prompt).toHaveLength(900);
    // what the model left out follows in weight order, with no text
    expect(j.items.slice(3)).toEqual([{ id: "canonical", why: null, step: null, prompt: null }, { id: "llms-txt", why: null, step: null, prompt: null }]);
    expect(JSON.stringify(j)).not.toMatch(/invented-finding|\u001b/);
    expect([j.total, j.locked, j.remaining_today, j.limited]).toEqual([5, 0, 29, false]);
    // one request, to the model's API, with the key (trimmed) and the default model
    expect(model.calls).toHaveLength(1);
    const sent = model.calls[0]!;
    expect(sent.url).toBe(MODEL_URL);
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent.body.model).toBe(DEFAULT_MODEL);
    expect(sent.body.response_format.json_schema.strict).toBe(true);
    // the model got the digest and nothing the digest does not hold
    const user = JSON.parse(sent.body.messages[1].content);
    expect(user).toEqual({ app: DIGEST.app, passed: 17, not_checked: 2, failed: DIGEST.checks });
    expect(JSON.stringify(sent.body)).not.toMatch(/dropped|xxxxxxxxxx/);
    // the key is in no answer and no table, and nothing of the digest or the plan is stored
    expect(JSON.stringify(j)).not.toContain(KEY);
    const tables = s.sql.rows("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => String(t.name));
    const dump = JSON.stringify(tables.map((t) => s.sql.rows(`SELECT * FROM "${t}"`)));
    expect(dump).not.toMatch(/sk-test-model|polar-parts|polarparts|evidence for|Nobody can pay|text-without-js/);
    expect(s.sql.rows("SELECT account_id, day, runs FROM suggest_usage")).toEqual([{ account_id: me.account.id, day: now().toISOString().slice(0, 10), runs: 1 }]);
    // another model, when the server names one
    const other = fakeModel(answer(DIGEST.checks.map((c) => ({ id: c.id }))));
    await post({ ...s.env, SUGGEST_MODEL: "gpt-5.1" }, me.bearer, DIGEST, other.fetch);
    expect(other.calls[0]!.body.model).toBe("gpt-5.1");
    await post({ ...s.env, SUGGEST_MODEL: "not a model name!" }, me.bearer, DIGEST, other.fetch);
    expect(other.calls[1]!.body.model).toBe(DEFAULT_MODEL);
  });

  it("a plan's runs for the day are counted; when they are used up the checks' own order is the answer, and the next day starts again", async () => {
    const s = setup({ OPENAI_API_KEY: KEY });
    const me = await cliUser(s.env);
    const model = fakeModel(answer(DIGEST.checks.map((c) => ({ id: c.id }))));
    for (const left of [2, 1, 0]) {
      const j = (await (await post(s.env, me.bearer, DIGEST, model.fetch)).json()) as any;
      expect([j.source, j.remaining_today, j.limited, j.items.length, j.locked]).toEqual(["model", left, false, 3, 2]);
    }
    const over = (await (await post(s.env, me.bearer, DIGEST, model.fetch)).json()) as any;
    expect([over.source, over.remaining_today, over.limited, over.upgrade_url]).toEqual(["checks", 0, true, "https://genclass.dev/account/billing"]);
    expect(over.items.map((i: any) => i.id)).toEqual(["text-without-js", "test-keys-live", "description"]);
    expect(model.calls).toHaveLength(3);
    expect(s.sql.rows("SELECT runs FROM suggest_usage")).toEqual([{ runs: 3 }]);
    expect(((await (await call(s.env, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any).suggestions.used_today).toBe(3);
    // another account has its own
    const eve = await cliUser(s.env, "eve@example.com");
    expect(((await (await post(s.env, eve.bearer, DIGEST, model.fetch)).json()) as any).source).toBe("model");
    // the next UTC day
    advance(24 * 3600_000);
    expect(((await (await post(s.env, me.bearer, DIGEST, model.fetch)).json()) as any).source).toBe("model");
    // the sweep drops rows older than three days, and deleting the account drops its rows
    advance(4 * 24 * 3600_000);
    await suggestRetention(s.sql.api, now());
    expect(s.sql.rows("SELECT * FROM suggest_usage")).toEqual([]);
    await post(s.env, eve.bearer, DIGEST, model.fetch);
    expect(s.sql.rows("SELECT account_id FROM suggest_usage")).toEqual([{ account_id: eve.account.id }]);
  });

  it("a model that fails, is slow, or answers something else gives the checks' own order, never an error", async () => {
    const s = setup({ OPENAI_API_KEY: KEY });
    const me = await cliUser(s.env);
    setPlan(s.sql, me.account.id, "free", { comp_until: FUTURE(), comp_plan: "team" });
    const weights = ["text-without-js", "test-keys-live", "description", "canonical", "llms-txt"];
    const cases: [string, (url: string, init?: RequestInit) => Promise<Response>][] = [
      ["HTTP 500", fakeModel("", 500).fetch],
      ["HTTP 401", fakeModel("", 401).fetch],
      ["not JSON", fakeModel("Sure! Here is your plan").fetch],
      ["JSON of another shape", fakeModel(JSON.stringify({ plan: [] })).fetch],
      ["fewer than half of the checks", fakeModel(answer([{ id: "canonical" }, { id: "nope" }])).fetch],
      ["a thrown request", async () => Promise.reject(new Error("network down"))],
      ["a timeout", async () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))],
    ];
    for (const [name, f] of cases) {
      const r = await post(s.env, me.bearer, DIGEST, f);
      expect(r.status, name).toBe(200);
      const j = (await r.json()) as any;
      expect(j.source, name).toBe("checks");
      expect(j.items.map((i: any) => i.id), name).toEqual(weights);
    }
  });

  it("on a database without the table of migration 0015 there is no count, so no model, and still an answer", async () => {
    const s = setup({ OPENAI_API_KEY: KEY });
    const me = await cliUser(s.env);
    s.sql.db.exec("DROP TABLE suggest_usage");
    const model = fakeModel(answer(DIGEST.checks.map((c) => ({ id: c.id }))));
    const j = (await (await post(s.env, me.bearer, DIGEST, model.fetch)).json()) as any;
    expect([j.source, j.limited, j.total]).toEqual(["checks", false, 5]);
    expect(model.calls).toEqual([]);
    expect(((await (await call(s.env, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any).suggestions.used_today).toBe(0);
  });
});

describe("genclass command: the digest and the model's answer (src/suggest.ts)", () => {
  it("readDigest keeps the fields it knows, cut and cleaned, and drops the rest", () => {
    const d = readDigest({
      app: { name: " Polar\u0007 Parts ", framework: 7, site: "https://x.example", payments: "stripe", hosting: null, more: "x" },
      checks: [{ id: "title", area: "launch", title: "t".repeat(300), weight: 99, evidence: ["a".repeat(500), 5, "b\nc", "d", "e"], extra: 1 }, { id: "x", weight: "nope" }],
      passed: 3.5,
      unknown: 9999,
    }) as any;
    expect(d.app).toEqual({ name: "Polar Parts", framework: null, site: "https://x.example", payments: "stripe", hosting: null });
    expect(d.checks[0]).toEqual({ id: "title", area: "launch", title: "t".repeat(100), weight: 5, evidence: ["a".repeat(160), "b c"] });
    expect(d.checks[1]).toEqual({ id: "x", area: "other", title: "x", weight: 1, evidence: [] });
    expect([d.passed, d.unknown]).toEqual([0, 500]);
    expect(byWeight(d.checks).map((c: any) => c.id)).toEqual(["title", "x"]);
  });

  it("planFromAnswer and askModel never let an id through that was not sent", async () => {
    const digest = readDigest(DIGEST) as any;
    expect(planFromAnswer(null, digest)).toBeNull();
    expect(planFromAnswer("x".repeat(200_001), digest)).toBeNull();
    const plan = planFromAnswer(answer([{ id: "llms-txt" }, { id: "__proto__" }, { id: "canonical" }, { id: "description" }]), digest)!;
    expect(plan.map((p) => p.id)).toEqual(["llms-txt", "canonical", "description", "text-without-js", "test-keys-live"]);
    // no key, or nothing failed: no request at all
    const model = fakeModel(answer([]));
    expect(await askModel({}, model.fetch, digest)).toBeNull();
    expect(await askModel({ OPENAI_API_KEY: KEY }, model.fetch, { ...digest, checks: [] })).toBeNull();
    expect(model.calls).toEqual([]);
  });
});
