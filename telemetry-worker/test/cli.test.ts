// The `genclass` command's routes (src/cli.ts, src/suggest.ts): the account's overview, what the GitHub App is doing
// on one repository, and the suggestions plan (the model, the plan's numbers, what is never stored).
import { beforeEach, describe, expect, it } from "vitest";
import { appKey, askModel, byWeight, DEFAULT_MODEL, designsFromAnswer, ideasFromAnswer, keepAnswer, lastAnswer, liveDesigns, MAX_DESIGNS, MAX_IDEAS, MODEL_URL, MODELS_URL, planFromAnswer, readDigest, resetStandIns, siteAddress, standIn, suggestRetention, suggestionLimits } from "../src/suggest.js";
import { PLANS } from "../src/plans.js";
import { CLI_DASHBOARD_FROM } from "../src/cli.js";
import { advance, call, cliToken, createApp, detection, now, resetClock, sendBatch, setNow, setPlan, setup, signedIn } from "./account-helpers.js";
import { APP_ID, fakeGithub, githubSetup, INSTALLATION, OWNER, REPO } from "./github-helpers.js";

beforeEach(() => {
  resetClock();
  resetStandIns();
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
    expect(j.plan).toEqual({ id: "free", name: "Free", source: null });
    // Free is shown one item of the suggestions since 2026-11-12
    expect(j.suggestions).toEqual({ per_day: 3, shown: 1, used_today: 0, model: false });
    expect(j.projects.map((p: any) => [p.id, p.name, p.token, p.last_event])).toEqual([[app.id, "Shop", app.token, null]]);
    expect(j.github).toEqual({ app: true, install_url: "https://genclass.dev/github/install", connect_url: "https://genclass.dev/github/connect" });
    expect(j.billing_url).toBe("https://genclass.dev/account/billing");
    // a server that sells nothing offers nothing
    expect(j.offer).toBeNull();
    // one that sells: an account on Free is told the first paid plan in the plans file's own words, with the address
    // that opens its checkout, and Free's limits in numbers (the command's plan step)
    const selling = { ...env, STRIPE_SECRET_KEY: "sk_live_fake" };
    const offered = (await (await call(selling, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any;
    const teamPlan = PLANS.find((p) => p.id === "team")!;
    expect(offered.offer).toEqual({
      // the plan id stays team; its name is Pro since 2026-11-12
      plan: { id: "team", name: "Pro" },
      price: "$15 / developer / month",
      summary: teamPlan.summary,
      features: teamPlan.features.filter((f) => f.available && !/^Everything in /.test(f.text)).map((f) => f.text).slice(0, 12),
      // Pro is the account's (plans.json version 5), bought on the plan page of its first app on Free
      checkout_url: `https://genclass.dev/account/billing?project=${app.id}&from=cli`,
      // an account that has never had a subscription starts with Pro's 3 days free (src/billing.ts trialFor)
      trial_days: 3,
      // Pro is per developer since version 5, not sold by units of apps
      apps_per_unit: null,
      // Free covers one app since version 5
      free: { name: "Free", apps: 1, history_days: 7, suggestions_shown: 1, live_fixes: 100 },
    });
    // each app says its plan, whether Free was chosen for it, and its plan page
    expect(offered.projects[0]).toMatchObject({ plan: { id: "free", name: "Free", source: null }, needs_plan: false, plan_chosen: false, plan_url: `https://genclass.dev/account/billing?project=${app.id}` });
    sql.db.prepare("UPDATE projects SET plan_chosen = '2026-11-12T00:00:00.000Z' WHERE id = ?").run(app.id);
    expect(((await (await call(selling, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any).projects[0].plan_chosen).toBe(true);
    // the app on a subscription of its own (version 4: it gives the account Pro): nothing left to offer
    sql.db.prepare("UPDATE projects SET plan = 'team', stripe_mode = 'live', subscription_id = 'sub_x', subscription_status = 'active' WHERE id = ?").run(app.id);
    expect(((await (await call(selling, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any).offer).toBeNull();
    // its subscription ends: the app is on Free again and offered Pro, without a second trial (one per account)
    sql.db.prepare("UPDATE projects SET plan = NULL, stripe_mode = NULL, subscription_status = 'canceled' WHERE id = ?").run(app.id);
    expect(((await (await call(selling, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any).offer).toMatchObject({ plan: { name: "Pro" }, trial_days: null });
    sql.db.prepare("UPDATE projects SET plan = NULL, stripe_mode = NULL, subscription_id = NULL, subscription_status = NULL WHERE id = ?").run(app.id);
    expect(offered.offer.features).toContain("Visitor analytics");
    expect(offered.offer.features).toContain("3 days free to start");
    expect(offered.offer.features.join(" ")).not.toContain("Everything in Free");
    // a test key sells only to the accounts on its list
    expect(((await (await call({ ...env, STRIPE_SECRET_KEY: "sk_test_fake" }, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any).offer).toBeNull();
    expect(((await (await call({ ...env, STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_TEST_ACCOUNTS: "ada@example.com" }, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any).offer.plan.id).toBe("team");
    // the browser session reads it too; nothing else is a method of it
    expect((await call(env, "GET", "/api/cli/overview", { cookie: me.cookie, origin: null })).status).toBe(200);
    expect((await call(env, "POST", "/api/cli/overview", { bearer: me.bearer, body: {} })).status).toBe(405);
    expect((await call(env, "GET", "/api/cli/nothing", { bearer: me.bearer, origin: null })).status).toBe(404);
    // a plan with more, and a server that has a model
    setPlan(sql, me.account.id, "free", { comp_until: FUTURE(), comp_plan: "team" });
    const team = (await (await call({ ...env, OPENAI_API_KEY: KEY }, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any;
    expect(team.plan).toEqual({ id: "team", name: "Pro", source: "comp" });
    expect(team.suggestions).toEqual({ per_day: 30, shown: null, used_today: 0, model: true });
    // an account with GenClass's grant is offered none, whatever the server sells: since version 5 a grant covers
    // every app of the account, the account's own or one copied onto an app (migration 0016)
    const offerNow = async () => ((await (await call({ ...selling, OPENAI_API_KEY: KEY }, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any);
    const granted = await offerNow();
    expect(granted.offer).toBeNull();
    expect(granted.projects[0]).toMatchObject({ plan: { id: "team", source: "comp" }, needs_plan: false });
    setPlan(sql, me.account.id, "free", { comp_until: null, comp_plan: null });
    expect((await offerNow()).offer.checkout_url).toBe(`https://genclass.dev/account/billing?project=${app.id}&from=cli`);
    sql.db.prepare("UPDATE projects SET comp_until = ?, comp_plan = 'team' WHERE id = ?").run(FUTURE(), app.id);
    expect((await offerNow()).offer).toBeNull();
    expect(JSON.stringify(team)).not.toContain(KEY);
  });

  it("a server without the GitHub App says so, and every plan in plans.json has its numbers", async () => {
    const { env } = setup();
    const me = await cliUser(env);
    const j = (await (await call(env, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any;
    expect(j.github).toEqual({ app: false, install_url: null, connect_url: null });
    expect(PLANS.map((p) => [p.id, suggestionLimits(p)])).toEqual([
      ["free", { per_day: 3, shown: 1 }],
      ["team", { per_day: 30, shown: null }],
      ["enterprise", { per_day: 100, shown: null }],
    ]);
    // a plan that leaves the numbers out gets 3 runs a day and 3 items (Free's numbers before 2026-11-12)
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

  it("without a model the plan is the checks by weight; Free is shown the first one, a plan with more is shown all", async () => {
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
      items: [{ id: "text-without-js", why: null, step: null, prompt: null }],
      locked: 4,
      locked_ids: ["test-keys-live", "description", "canonical", "llms-txt"],
      ideas: [],
      designs: [],
      ideas_locked: 0,
      designs_locked: 0,
      cached_at: null,
      // the plan page that starts Pro from the command, and what Pro is
      upgrade_url: "https://genclass.dev/account/billing?plan=pro&from=cli",
      upgrade_plan: { name: "Pro", price: "$15 / developer / month", trial_days: 3 },
      remaining_today: 3,
      limited: false,
    });
    // no model was asked, no run was counted and nothing was kept
    expect(model.calls).toEqual([]);
    expect(sql.rows("SELECT * FROM suggest_usage")).toEqual([]);
    expect(sql.rows("SELECT * FROM suggest_results")).toEqual([]);
    setPlan(sql, me.account.id, "free", { comp_until: FUTURE(), comp_plan: "team" });
    const team = (await (await post(env, me.bearer, DIGEST)).json()) as any;
    expect(team.items.map((i: any) => i.id)).toEqual(["text-without-js", "test-keys-live", "description", "canonical", "llms-txt"]);
    expect([team.locked, team.locked_ids, team.upgrade_url, team.remaining_today, team.ideas_locked, team.designs_locked]).toEqual([0, [], null, 30, 0, 0]);
    // nothing failed and nothing to go on (no site, no about): an empty plan, and still no model
    expect(await (await post({ ...env, OPENAI_API_KEY: KEY }, me.bearer, { ...DIGEST, app: { name: "polar-parts" }, checks: [] }, model.fetch)).json()).toMatchObject({ source: "checks", total: 0, items: [], locked: 0 });
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
    // the digest's app has what its site says it is about since 2026-11-12 (none was sent here)
    expect(user).toEqual({ app: { ...DIGEST.app, about: null }, passed: 17, not_checked: 2, failed: DIGEST.checks });
    expect(JSON.stringify(sent.body)).not.toMatch(/dropped|xxxxxxxxxx/);
    // the answer asks for the checks, the model's ideas and the website designs
    expect(sent.body.response_format.json_schema.schema.required).toEqual(["items", "ideas", "designs"]);
    // the key is in no answer and no table, and nothing of the digest is stored
    expect(JSON.stringify(j)).not.toContain(KEY);
    const tables = s.sql.rows("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => String(t.name));
    const dump = JSON.stringify(tables.map((t) => s.sql.rows(`SELECT * FROM "${t}"`)));
    expect(dump).not.toMatch(/sk-test-model|polar-parts|polarparts|evidence for/);
    // the answer is kept, one row for the account and the app (suggest_results, migration 0019), under a hash of the
    // site: the model's text as it was sent back, and nothing else; no other table holds any of it
    const kept = s.sql.rows("SELECT account_id, app_key, created, body FROM suggest_results");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ account_id: me.account.id, app_key: await appKey(readDigest(DIGEST) as any), created: now().toISOString() });
    expect(String(kept[0]!.app_key)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(String(kept[0]!.body))).toEqual({ source: "model", items: j.items, ideas: [], designs: [] });
    const rest = JSON.stringify(tables.filter((t) => t !== "suggest_results").map((t) => s.sql.rows(`SELECT * FROM "${t}"`)));
    expect(rest).not.toMatch(/Nobody can pay|text-without-js/);
    expect(s.sql.rows("SELECT account_id, day, runs FROM suggest_usage")).toEqual([{ account_id: me.account.id, day: now().toISOString().slice(0, 10), runs: 1 }]);
    // another model, when the server names one
    const other = fakeModel(answer(DIGEST.checks.map((c) => ({ id: c.id }))));
    await post({ ...s.env, SUGGEST_MODEL: "gpt-5.1" }, me.bearer, DIGEST, other.fetch);
    expect(other.calls[0]!.body.model).toBe("gpt-5.1");
    await post({ ...s.env, SUGGEST_MODEL: "not a model name!" }, me.bearer, DIGEST, other.fetch);
    expect(other.calls[1]!.body.model).toBe(DEFAULT_MODEL);
    // a plan that shows everything asks the model each time; the next answer replaces the kept one
    expect(s.sql.rows("SELECT COUNT(*) AS n FROM suggest_results")).toEqual([{ n: 1 }]);
    expect(JSON.parse(String(s.sql.rows("SELECT body FROM suggest_results")[0]!.body)).items[0].why).toBe("why canonical");
  });

  it("a plan's runs for the day are counted; when they are used up the checks' own order is the answer, and the next day starts again", async () => {
    const s = setup({ OPENAI_API_KEY: KEY });
    const me = await cliUser(s.env);
    const model = fakeModel(answer(DIGEST.checks.map((c) => ({ id: c.id }))));
    // Free keeps one answer per app (the next test): each run here is for another app, by its site
    const at = (n: number) => ({ ...DIGEST, app: { ...DIGEST.app, site: `https://shop${n}.example` } });
    for (const [n, left] of [[1, 2], [2, 1], [3, 0]] as const) {
      const j = (await (await post(s.env, me.bearer, at(n), model.fetch)).json()) as any;
      expect([j.source, j.remaining_today, j.limited, j.items.length, j.locked, j.cached_at]).toEqual(["model", left, false, 1, 4, null]);
    }
    const over = (await (await post(s.env, me.bearer, at(4), model.fetch)).json()) as any;
    expect([over.source, over.remaining_today, over.limited, over.upgrade_url, over.cached_at]).toEqual(["checks", 0, true, "https://genclass.dev/account/billing?plan=pro&from=cli", null]);
    expect(over.items.map((i: any) => i.id)).toEqual(["text-without-js"]);
    expect(model.calls).toHaveLength(3);
    expect(s.sql.rows("SELECT runs FROM suggest_usage")).toEqual([{ runs: 3 }]);
    expect(((await (await call(s.env, "GET", "/api/cli/overview", { bearer: me.bearer, origin: null })).json()) as any).suggestions.used_today).toBe(3);
    // an app that has its answer kept still gets it with no run left: the model's order, not the checks'
    const again = (await (await post(s.env, me.bearer, at(1), model.fetch)).json()) as any;
    expect([again.source, again.remaining_today, again.limited, again.items[0].id, again.cached_at]).toEqual(["model", 0, false, "canonical", now().toISOString()]);
    expect(model.calls).toHaveLength(3);
    // another account has its own
    const eve = await cliUser(s.env, "eve@example.com");
    expect(((await (await post(s.env, eve.bearer, DIGEST, model.fetch)).json()) as any).source).toBe("model");
    // the next UTC day: a new app gets a run again; an app with a kept answer is shown it, with no run
    advance(24 * 3600_000);
    expect(((await (await post(s.env, me.bearer, at(5), model.fetch)).json()) as any).source).toBe("model");
    expect(((await (await post(s.env, me.bearer, at(1), model.fetch)).json()) as any).remaining_today).toBe(2);
    expect(model.calls).toHaveLength(5);
    // the sweep drops usage rows older than three days; the kept answers stay (they go with the account)
    advance(4 * 24 * 3600_000);
    await suggestRetention(s.sql.api, now());
    expect(s.sql.rows("SELECT * FROM suggest_usage")).toEqual([]);
    expect(s.sql.rows("SELECT COUNT(*) AS n FROM suggest_results")).toEqual([{ n: 5 }]);
    await post(s.env, eve.bearer, at(6), model.fetch);
    expect(s.sql.rows("SELECT account_id FROM suggest_usage")).toEqual([{ account_id: eve.account.id }]);
  });

  it("Free is shown the answer it got first for an app again, with when it was made and no new model run; Pro sees all of it", async () => {
    const s = setup({ OPENAI_API_KEY: KEY });
    const me = await cliUser(s.env);
    const ids = ["test-keys-live", "text-without-js", "description", "canonical", "llms-txt"];
    const prompt = (site: string) => `Redesign the home page in the direction of ${site}: a wide grid, a large type scale, a calm palette, generous spacing and a short hero. `.repeat(2);
    const body = (n: number) =>
      JSON.stringify({
        items: ids.map((id) => ({ id, why: `why ${id} ${n}`, step: `step ${id}`, prompt: `prompt ${id}` })),
        ideas: [1, 2, 3].map((i) => ({ title: `Idea ${i} of run ${n}`, why: "w", step: "s", prompt: "p" })),
        designs: ["https://linear.app", "https://stripe.com"].map((site) => ({ title: `Like ${site}`, inspired_by: site, why: "w", prompt: prompt(site) })),
      });
    const calls: string[] = [];
    let run = 0;
    const f = async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url === MODEL_URL) return new Response(JSON.stringify({ choices: [{ message: { content: body(++run) } }] }), { status: 200 });
      // the design references: their sites answer
      expect(init?.method).toBe("GET");
      return new Response("<html></html>", { status: 200 });
    };
    const first = (await (await post(s.env, me.bearer, DIGEST, f)).json()) as any;
    expect(first).toMatchObject({
      source: "model",
      total: 5,
      items: [{ id: "test-keys-live", why: "why test-keys-live 1", step: "step test-keys-live", prompt: "prompt test-keys-live" }],
      locked: 4,
      locked_ids: ids.slice(1),
      ideas: [],
      designs: [],
      ideas_locked: 3,
      designs_locked: 2,
      cached_at: null,
      upgrade_url: "https://genclass.dev/account/billing?plan=pro&from=cli",
      upgrade_plan: { name: "Pro", price: "$15 / developer / month", trial_days: 3 },
      remaining_today: 2,
      limited: false,
    });
    // what Free does not see is counted, never sent
    expect(JSON.stringify(first)).not.toMatch(/Idea \d|Redesign|linear\.app|stripe\.com|why text-without-js/);
    // one model request, and each design's site checked once
    expect(calls).toEqual([MODEL_URL, "https://linear.app", "https://stripe.com"]);
    const made = now().toISOString();
    // later, with other failed checks, and the same site written another way: the same answer, no new run
    advance(3_600_000);
    for (const site of ["https://polarparts.example", "https://PolarParts.example/"]) {
      const again = (await (await post(s.env, me.bearer, { ...DIGEST, app: { ...DIGEST.app, site }, checks: DIGEST.checks.slice(0, 2) }, f)).json()) as any;
      expect(again).toMatchObject({ source: "model", total: 5, items: [{ id: "test-keys-live", why: "why test-keys-live 1" }], locked: 4, ideas_locked: 3, designs_locked: 2, cached_at: made, remaining_today: 2 });
    }
    expect(calls).toHaveLength(3);
    expect(s.sql.rows("SELECT runs FROM suggest_usage")).toEqual([{ runs: 1 }]);
    // an app without a site is kept under its name; another app is another answer
    const other = (await (await post(s.env, me.bearer, { ...DIGEST, app: { ...DIGEST.app, site: null, name: "Other app" } }, f)).json()) as any;
    expect([other.cached_at, other.items[0].why]).toEqual([null, "why test-keys-live 2"]);
    expect(s.sql.rows("SELECT COUNT(*) AS n FROM suggest_results WHERE account_id = ?", me.account.id)).toEqual([{ n: 2 }]);
    // one app of the account on Pro: the whole answer, a new run each time, nothing counted or hidden
    const app = await createApp(s.env, me.cookie, "Shop");
    s.sql.db.prepare("UPDATE projects SET plan = 'team', stripe_mode = 'live', subscription_id = 'sub_p', subscription_status = 'active' WHERE id = ?").run(app.id);
    const pro = (await (await post(s.env, me.bearer, DIGEST, f)).json()) as any;
    expect(pro).toMatchObject({ source: "model", plan: { id: "team", name: "Pro" }, total: 5, locked: 0, locked_ids: [], ideas_locked: 0, designs_locked: 0, cached_at: null, upgrade_url: null, remaining_today: 27 });
    expect(pro.items.map((i: any) => i.id)).toEqual(ids);
    expect(pro.items[0].why).toBe("why test-keys-live 3");
    expect(pro.ideas).toEqual([1, 2, 3].map((i) => ({ title: `Idea ${i} of run 3`, why: "w", step: "s", prompt: "p" })));
    expect(pro.designs).toEqual(["https://linear.app", "https://stripe.com"].map((site) => ({ title: `Like ${site}`, inspired_by: site, why: "w", prompt: prompt(site).trim() })));
    // the kept answer is the newest
    const kept = await lastAnswer(s.sql.api, me.account.id, await appKey(readDigest(DIGEST) as any));
    expect(kept).toMatchObject({ created: now().toISOString(), source: "model", ideas: pro.ideas, designs: pro.designs });
  });

  it("the model is asked with no failed checks when the app has a site or says what it is about; never with neither", async () => {
    const s = setup({ OPENAI_API_KEY: KEY });
    const me = await cliUser(s.env);
    const model = fakeModel(JSON.stringify({ items: [], ideas: [{ title: "Add a pricing page", why: "w", step: "s", prompt: "p" }], designs: [] }));
    const none = (await (await post(s.env, me.bearer, { app: { name: "bare" }, checks: [] }, model.fetch)).json()) as any;
    expect([none.source, none.total, none.ideas_locked]).toEqual(["checks", 0, 0]);
    expect(model.calls).toEqual([]);
    const about = "Polar Parts sells spare parts for snow machines. " + "x".repeat(400);
    for (const app of [{ name: "with-about", about }, { name: "with-site", site: "https://withsite.example" }]) {
      const j = (await (await post(s.env, me.bearer, { app, checks: [], passed: 20 }, model.fetch)).json()) as any;
      expect([j.source, j.total, j.items, j.locked, j.ideas, j.ideas_locked, j.upgrade_url], app.name).toEqual(["model", 0, [], 0, [], 1, "https://genclass.dev/account/billing?plan=pro&from=cli"]);
    }
    expect(model.calls).toHaveLength(2);
    // what the site says it is about goes to the model cut to 300 characters
    const sent = JSON.parse(model.calls[0]!.body.messages[1].content);
    expect(sent.app.about).toBe(about.slice(0, 300));
    expect(sent.failed).toEqual([]);
  });

  it("on a database without the table of migration 0019 nothing is kept: the answer comes all the same, from the model each time", async () => {
    const s = setup({ OPENAI_API_KEY: KEY });
    const me = await cliUser(s.env);
    s.sql.db.exec("DROP TABLE suggest_results");
    const model = fakeModel(answer(DIGEST.checks.map((c) => ({ id: c.id }))));
    for (const n of [1, 2]) {
      const j = (await (await post(s.env, me.bearer, DIGEST, model.fetch)).json()) as any;
      expect([j.source, j.cached_at, j.items.length, j.remaining_today], String(n)).toEqual(["model", null, 1, 3 - n]);
    }
    expect(model.calls).toHaveLength(2);
    // and a kept answer that cannot be read is no answer: the model is asked again
    const t = setup({ OPENAI_API_KEY: KEY });
    const you = await cliUser(t.env);
    t.sql.db.prepare("INSERT INTO suggest_results (account_id, app_key, created, body) VALUES (?, ?, ?, ?)").run(you.account.id, await appKey(readDigest(DIGEST) as any), now().toISOString(), "{not json");
    expect(await lastAnswer(t.sql.api, you.account.id, await appKey(readDigest(DIGEST) as any))).toBeNull();
    expect(((await (await post(t.env, you.bearer, DIGEST, model.fetch)).json()) as any).cached_at).toBeNull();
    expect(model.calls).toHaveLength(3);
    // keepAnswer on a database without the table changes nothing and throws nothing
    await expect(keepAnswer(s.sql.api, me.account.id, "k", { source: "model", items: [], ideas: [], designs: [] }, now())).resolves.toBeUndefined();
  });

  it("deleting the account deletes its kept answers and its counts, and no one else's", async () => {
    const s = setup({ OPENAI_API_KEY: KEY });
    const me = await cliUser(s.env);
    const eve = await cliUser(s.env, "eve@example.com");
    const model = fakeModel(answer(DIGEST.checks.map((c) => ({ id: c.id }))));
    for (const u of [me, eve]) expect((await post(s.env, u.bearer, DIGEST, model.fetch)).status).toBe(200);
    expect(s.sql.rows("SELECT COUNT(*) AS n FROM suggest_results")).toEqual([{ n: 2 }]);
    expect((await call(s.env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: me.cookie })).status).toBe(204);
    expect(s.sql.rows("SELECT account_id FROM suggest_results")).toEqual([{ account_id: eve.account.id }]);
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

describe("genclass command: GET /api/cli/app (src/cli.ts)", () => {
  it("a CLI session reads its own app's dashboard, cut by the plan like the browser's; one approved before the approval page said so signs in again", async () => {
    const { env, sql } = setup();
    setNow(new Date(Date.parse(CLI_DASHBOARD_FROM) + 3_600_000));
    const me = await cliUser(env);
    const app = await createApp(env, me.cookie, "Shop");
    await sendBatch(env, app.token, [{ t: "session", host: "shop.example", route: "/" }, ...detection("duplicate", "/checkout")]);
    const path = `/api/cli/app?id=${app.id}&range=7d`;
    expect((await call(env, "GET", path, { origin: null })).status).toBe(401);
    expect((await call(env, "POST", path, { bearer: me.bearer, origin: null })).status).toBe(405);
    const r = await call(env, "GET", path, { bearer: me.bearer, origin: null });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect([j.name, j.token, j.range]).toEqual(["Shop", app.token, "7d"]);
    expect(j.dashboard_url).toBe(`https://genclass.dev/account/apps/${app.id}`);
    // Free sees the totals only (src/dashboard.ts stripProblems, the browser's rule too): no problem lists, pages or
    // latest events, the chart's bars as one count, and the plan that shows them, its trial and the app's plan page
    expect(j.totals.detections).toBe(1);
    expect(j.breakdowns).toEqual({});
    expect(j.recent).toEqual([]);
    expect(j.typeSeries.every((b: any) => Object.keys(b.counts).join() === "problems")).toBe(true);
    expect(j.typeSeries.reduce((n: number, b: any) => n + b.counts.problems, 0)).toBe(1);
    expect(j.locked.problems).toEqual({ plan: "Pro", upgrade_url: `https://genclass.dev/account/billing?project=${app.id}`, trial_days: 3, price: "$15 / developer / month" });
    expect(JSON.stringify(j)).not.toContain("/checkout");
    // nothing a page typed, and no session of the account
    expect(JSON.stringify(j)).not.toContain("SECRET PAGE TEXT");
    expect(JSON.stringify(j)).not.toContain(me.bearer);
    // the Free plan has no visitor analytics: left out here as on the dashboard, with the plan that shows them
    expect(j.locked.analytics).toEqual({ plan: "Pro", upgrade_url: "https://genclass.dev/account/billing" });
    expect(j.visits).toEqual({ sessions: 0, pages: 0, bounces: 0, entry: [], exit: [] });
    // the app on Pro: the same request answers in full
    sql.db.prepare("UPDATE projects SET plan = 'team', stripe_mode = 'live', subscription_id = 'sub_p', subscription_status = 'active' WHERE id = ?").run(app.id);
    const full = (await (await call(env, "GET", path, { bearer: me.bearer, origin: null })).json()) as any;
    expect(full.locked).toBeUndefined();
    expect(full.breakdowns.detect_issue).toEqual([{ key: "duplicate\t/checkout", count: 1 }]);
    expect(full.recent.length).toBeGreaterThan(0);
    expect(full.recent.length).toBeLessThanOrEqual(50);
    expect(full.typeSeries.some((b: any) => b.counts.duplicate === 1)).toBe(true);
    expect(full.plan).toEqual({ id: "team", name: "Pro", source: "paid" });
    sql.db.prepare("UPDATE projects SET plan = NULL, stripe_mode = NULL, subscription_id = NULL, subscription_status = NULL WHERE id = ?").run(app.id);
    // a range the plan does not show is answered with one it does
    expect(((await (await call(env, "GET", `/api/cli/app?id=${app.id}&range=1y`, { bearer: me.bearer, origin: null })).json()) as any).range).not.toBe("1y");
    // the browser session of the account reads the same
    expect((await call(env, "GET", path, { cookie: me.cookie, origin: null })).status).toBe(200);
    // another account's command line gets nothing, and an id that is no app's is the same answer
    const other = await cliUser(env, "bob@example.com");
    expect((await call(env, "GET", path, { bearer: other.bearer, origin: null })).status).toBe(404);
    expect((await call(env, "GET", "/api/cli/app?id=nope", { bearer: me.bearer, origin: null })).status).toBe(404);
    // a session approved while the page still said "It cannot read your apps' stats" is told to sign in again
    sql.db.exec(`UPDATE auth_sessions SET created = '${new Date(Date.parse(CLI_DASHBOARD_FROM) - 1000).toISOString()}' WHERE kind = 'cli'`);
    const old = await call(env, "GET", path, { bearer: me.bearer, origin: null });
    expect(old.status).toBe(403);
    expect(await old.json()).toMatchObject({ ok: false, reauth: true });
    // and the route the dashboard page reads is still the browser's only
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { bearer: me.bearer, origin: null })).status).toBe(403);
  });
});

describe("genclass command: the digest and the model's answer (src/suggest.ts)", () => {
  it("readDigest keeps the fields it knows, cut and cleaned, and drops the rest", () => {
    const d = readDigest({
      app: { name: " Polar\u0007 Parts ", framework: 7, site: "https://x.example", payments: "stripe", hosting: null, about: ` Parts for\nsnow machines. ${"a".repeat(400)}`, more: "x" },
      checks: [{ id: "title", area: "launch", title: "t".repeat(300), weight: 99, evidence: ["a".repeat(500), 5, "b\nc", "d", "e"], extra: 1 }, { id: "x", weight: "nope" }],
      passed: 3.5,
      unknown: 9999,
    }) as any;
    // what the site says it is about (its title and description): one line of at most 300 characters
    expect(d.app).toEqual({ name: "Polar Parts", framework: null, site: "https://x.example", payments: "stripe", hosting: null, about: `Parts for snow machines. ${"a".repeat(400)}`.slice(0, 300) });
    expect((readDigest({ checks: [] }) as any).app.about).toBeNull();
    expect(d.checks[0]).toEqual({ id: "title", area: "launch", title: "t".repeat(100), weight: 5, evidence: ["a".repeat(160), "b c"] });
    expect(d.checks[1]).toEqual({ id: "x", area: "other", title: "x", weight: 1, evidence: [] });
    expect([d.passed, d.unknown]).toEqual([0, 500]);
    expect(byWeight(d.checks).map((c: any) => c.id)).toEqual(["title", "x"]);
  });

  it("a key without the configured model: the newest one it has of the same family and tier is asked instead, once found", async () => {
    const list = [
      { id: "gpt-6.1-terra", created: 50 }, { id: "gpt-6.1-sol", created: 49 }, { id: "gpt-6-sol", created: 40 }, { id: "gpt-5.6-sol", created: 30 },
      { id: "gpt-image-2.6-flare", created: 60 }, { id: "ft:gpt-6-sol:acme:x", created: 70 }, { id: "o3", created: 10 },
    ];
    // pure: same family, same tier word, newest; nothing is guessed for a name with no tier or no sibling
    expect(standIn("gpt-6.2-sol", list)).toBe("gpt-6.1-sol");
    expect(standIn("gpt-6.2-terra", list)).toBe("gpt-6.1-terra");
    expect(standIn("gpt-6.2-nova", list)).toBeNull();
    expect(standIn("gpt-6.2", list)).toBeNull();
    expect(standIn("o5-sol", list)).toBeNull();
    expect(standIn("gpt-6.1-sol", [{ id: "gpt-6.1-sol", created: 1 }])).toBeNull();

    const digest = readDigest(DIGEST) as any;
    const calls: { url: string; model?: string; auth: string | null }[] = [];
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    const fetch = async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers as HeadersInit).get("authorization");
      if (url === MODELS_URL) {
        calls.push({ url, auth });
        return new Response(JSON.stringify({ data: list }), { status: 200 });
      }
      const model = JSON.parse(String(init?.body)).model as string;
      calls.push({ url, model, auth });
      if (model === DEFAULT_MODEL) return new Response(JSON.stringify({ error: { code: "model_not_found", message: `The model \`${model}\` does not exist or you do not have access to it. key sk-proj-abc123` } }), { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: answer(DIGEST.checks.map((c) => ({ id: c.id }))) } }] }), { status: 200 });
    };
    try {
      const plan = await askModel({ OPENAI_API_KEY: KEY }, fetch, digest);
      expect(plan?.items.map((p) => p.id)).toEqual(DIGEST.checks.map((c) => c.id));
      expect(calls.map((c) => c.model ?? "list")).toEqual([DEFAULT_MODEL, "list", "gpt-6.1-sol"]);
      expect(calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
      // the next request asks the stand-in straight away: one call
      calls.length = 0;
      expect(await askModel({ OPENAI_API_KEY: KEY }, fetch, digest)).not.toBeNull();
      expect(calls.map((c) => c.model)).toEqual(["gpt-6.1-sol"]);
      // the log says what happened and names models, never the key, a quoted part of one or a fine-tuned id
      const said = logs.join("\n");
      expect(said).toContain("model_not_found");
      expect(said).toContain("asking gpt-6.1-sol in place of gpt-6.2-sol");
      expect(said).toContain("gpt-6.1-terra, gpt-6.1-sol");
      expect(said).not.toContain(KEY);
      expect(said).not.toContain("sk-proj-abc123");
      expect(said).not.toContain("ft:");
      // a key with no sibling at all: no second question, the checks' own order
      resetStandIns();
      calls.length = 0;
      const none = async (url: string, init?: RequestInit) => (url === MODELS_URL ? new Response(JSON.stringify({ data: [{ id: "o3", created: 1 }] }), { status: 200 }) : fetch(url, { ...init, body: JSON.stringify({ model: DEFAULT_MODEL }) }));
      expect(await askModel({ OPENAI_API_KEY: KEY }, none, digest)).toBeNull();
    } finally {
      console.log = log;
    }
  });

  it("planFromAnswer and askModel never let an id through that was not sent", async () => {
    const digest = readDigest(DIGEST) as any;
    expect(planFromAnswer(null, digest)).toBeNull();
    expect(planFromAnswer("x".repeat(200_001), digest)).toBeNull();
    const plan = planFromAnswer(answer([{ id: "llms-txt" }, { id: "__proto__" }, { id: "canonical" }, { id: "description" }]), digest)!;
    expect(plan.map((p) => p.id)).toEqual(["llms-txt", "canonical", "description", "text-without-js", "test-keys-live"]);
    // no key: no request at all
    const model = fakeModel(answer([]));
    expect(await askModel({}, model.fetch, digest)).toBeNull();
    expect(model.calls).toEqual([]);
    // nothing failed: the model is still asked, for its ideas and the designs (the route asks only when the app has a
    // site or says what it is about), and the answer has no items
    expect(await askModel({ OPENAI_API_KEY: KEY }, model.fetch, { ...digest, checks: [] })).toEqual({ source: "model", items: [], ideas: [], designs: [] });
    expect(model.calls).toHaveLength(1);
    // the ideas and designs never let an id into the checks: an answer whose items fail is no answer at all
    const bad = fakeModel(JSON.stringify({ items: [{ id: "invented" }], ideas: [{ title: "An idea" }], designs: [] }));
    expect(await askModel({ OPENAI_API_KEY: KEY }, bad.fetch, digest)).toBeNull();
  });

  it("the model's ideas: titled, cleaned and cut, at most 20; never measured, kept apart from the checks", () => {
    expect(MAX_IDEAS).toBe(20);
    const raw = [
      { title: " Add a\u0007 pricing page ", why: "w".repeat(600), step: "s".repeat(400), prompt: "p".repeat(1000) },
      { title: "", why: "no title" },
      { why: "no title either" },
      "not an object",
      null,
      ...Array.from({ length: 30 }, (_, i) => ({ title: `Idea ${i}` })),
    ];
    const ideas = ideasFromAnswer(JSON.stringify({ items: [], ideas: raw }));
    expect(ideas).toHaveLength(20);
    expect(ideas[0]).toEqual({ title: "Add a pricing page", why: "w".repeat(500), step: "s".repeat(300), prompt: "p".repeat(900) });
    expect(ideas[1]).toEqual({ title: "Idea 0", why: null, step: null, prompt: null });
    for (const bad of [null, 5, "not json", JSON.stringify({ ideas: "x" }), JSON.stringify(null), "x".repeat(400_001)]) expect(ideasFromAnswer(bad), String(bad).slice(0, 20)).toEqual([]);
  });

  it("the website designs: a real https site that answers, a full prompt, at most 4 and no site twice; anything else is dropped", async () => {
    expect(MAX_DESIGNS).toBe(4);
    // the site a design names: https, a public host name; the address as sent back without a trailing slash
    expect(siteAddress("https://Linear.app/")).toBe("https://linear.app");
    expect(siteAddress("https://www.stripe.com/payments")).toBe("https://www.stripe.com/payments");
    for (const bad of ["http://linear.app", "https://localhost", "https://127.0.0.1", "https://[::1]/", "https://intranet", "https://shop.local", "https://x.internal", "https://a.test", "https://example.com.example", "https://u:p@linear.app", "https://linear.app:8443", "ftp://linear.app", "linear.app", "", 5, null, `https://${"a".repeat(200)}.com`]) {
      expect(siteAddress(bad), String(bad)).toBeNull();
    }
    const long = "A complete prompt for a coding agent that redesigns the site with a wide grid and calm colours.";
    expect(long.length).toBeGreaterThanOrEqual(80);
    const designs = designsFromAnswer(
      JSON.stringify({
        designs: [
          { title: "Calm and wide", inspired_by: "https://linear.app/", why: "w", prompt: `  ${long}\u0007  and more  ` },
          { title: "Short prompt", inspired_by: "https://vercel.com", why: "w", prompt: "too short" },
          { title: "Not https", inspired_by: "http://vercel.com", why: "w", prompt: long },
          { title: "Same site again", inspired_by: "https://linear.app", why: "w", prompt: long },
          { title: "", inspired_by: "https://notion.so", why: "w", prompt: long },
          ...["https://a.example.org", "https://b.example.org", "https://c.example.org", "https://d.example.org"].map((site) => ({ title: site, inspired_by: site, why: null, prompt: long })),
        ],
      }),
    );
    expect(designs.map((d) => d.inspired_by)).toEqual(["https://linear.app", "https://a.example.org", "https://b.example.org", "https://c.example.org"]);
    expect(designs[0]).toEqual({ title: "Calm and wide", inspired_by: "https://linear.app", why: "w", prompt: `${long} and more` });
    expect(designs[1]!.why).toBeNull();
    // the server checks that each site answers: kept unless 404, 410, a server error or no answer (403 still exists)
    const answers: Record<string, number | "throw"> = { "https://linear.app": 200, "https://a.example.org": 403, "https://b.example.org": 404, "https://c.example.org": "throw" };
    const asked: { url: string; method?: string; redirect?: string }[] = [];
    const f = async (url: string, init?: RequestInit) => {
      asked.push({ url, method: init?.method, redirect: init?.redirect });
      const a = answers[url];
      if (a === "throw") throw new Error("no such host");
      return new Response("", { status: a ?? 500 });
    };
    expect((await liveDesigns(f, designs)).map((d) => d.inspired_by)).toEqual(["https://linear.app", "https://a.example.org"]);
    expect(asked).toEqual(designs.map((d) => ({ url: d.inspired_by, method: "GET", redirect: "follow" })));
    for (const status of [410, 500, 503]) {
      answers["https://linear.app"] = status;
      expect((await liveDesigns(f, designs.slice(0, 1))).length, String(status)).toBe(0);
    }
    // through askModel: a design whose site is gone is not in the answer
    const digest = readDigest(DIGEST) as any;
    answers["https://linear.app"] = 200;
    const both = async (url: string, init?: RequestInit) =>
      url === MODEL_URL
        ? new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: DIGEST.checks.map((c) => ({ id: c.id, why: "w", step: "s", prompt: "p" })), ideas: [], designs: [{ title: "Calm", inspired_by: "https://linear.app", why: "w", prompt: long }, { title: "Gone", inspired_by: "https://b.example.org", why: "w", prompt: long }] }) } }] }), { status: 200 })
        : f(url, init);
    const got = await askModel({ OPENAI_API_KEY: KEY }, both, digest);
    expect(got!.designs.map((d) => d.title)).toEqual(["Calm"]);
  });
});
