// The GitHub App's pages and the link between a repository and a GenClass app: the public page, the page after
// installing, "Connect GitHub" (GitHub says who is asking and what they can reach) and the account's settings.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Like, D1Stmt } from "../src/dashboard.js";
import { advance, call, cliToken, createApp, now, resetClock, setPlan, signedIn } from "./account-helpers.js";
import { APP_ID, CLIENT_ID, deliver, fakeGithub, githubSetup, INSTALLATION, installationCreated, OWNER, pullRequest, REPO, result, SHA1, SHA2, signature, WEBHOOK_SECRET } from "./github-helpers.js";

beforeEach(() => {
  resetClock();
});

const cookieOf = (r: Response, name: string): string | null => {
  const c = r.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
  return c ? c.split(";")[0]! : null;
};

/** GitHub's view of the person: one installation of this app (two repositories, one they can push to) and another app's. */
function person(gh: ReturnType<typeof fakeGithub>) {
  gh.user.installations = [
    { id: INSTALLATION, app_id: Number(APP_ID), account: OWNER, repository_selection: "selected", suspended_at: null },
    { id: 5555, app_id: 999, account: { id: 9, login: "other", type: "User" }, repository_selection: "all" },
  ];
  gh.user.repositories.set(INSTALLATION, [
    { id: REPO.id, full_name: REPO.full_name, private: false, permissions: { admin: false, push: true, pull: true } },
    { id: 7003, full_name: "acme/docs", private: true, permissions: { admin: false, push: false, pull: true } },
  ]);
  gh.user.repositories.set(5555, [{ id: 1, full_name: "other/secret", private: true, permissions: { admin: true, push: true, pull: true } }]);
}

/** Connect GitHub for a session that is signed in: the start, then GitHub's answer through the callback. */
async function connect(env: Parameters<typeof call>[0], me: { cookie: string }, gh: ReturnType<typeof fakeGithub>) {
  const start = await call(env, "GET", "/github/connect", { cookie: me.cookie, origin: null });
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const oauth = cookieOf(start, "gc_oauth_ghapp")!;
  const back = await call(env, "GET", `/github/callback?code=good-code&state=${encodeURIComponent(state)}`, { cookie: `${me.cookie}; ${oauth}`, origin: null, fetch: gh.fetch });
  return { back, state, oauth };
}

/** Signed in, with GitHub connected: the session cookie, the account, and the fake GitHub. */
async function connected(email = "ada@example.com", s = githubSetup(), prepared?: ReturnType<typeof fakeGithub>) {
  const gh = prepared ?? fakeGithub();
  if (!prepared) person(gh);
  const me = await signedIn(s.env, email);
  return { ...s, gh, me, ...(await connect(s.env, me, gh)) };
}

/** GitHub's view of the person when the installation is on their own GitHub account (id 77, "ada"). */
function ownAccount(): ReturnType<typeof fakeGithub> {
  const gh = fakeGithub();
  person(gh);
  gh.user.installations[0].account = { id: 77, login: "ada", type: "User" };
  return gh;
}

/** A plan that includes private repositories: GenClass's own grant gives Enterprise. */
const withPrivatePlan = (sql: ReturnType<typeof githubSetup>["sql"], accountId: string): void => setPlan(sql, accountId, "free", { comp_until: new Date(now().getTime() + 86_400_000).toISOString() });

const managerOf = (sql: ReturnType<typeof githubSetup>["sql"]): unknown => sql.rows("SELECT owner FROM github_installations WHERE id = ?", INSTALLATION)[0]!.owner;

/** The same database, counting the statements run on it. */
function counting(db: D1Like) {
  let n = 0;
  const wrap = (s: D1Stmt): D1Stmt => ({
    bind: (...v: unknown[]) => wrap(s.bind(...v)),
    first: <T>() => (n++, s.first<T>()),
    all: <T>() => (n++, s.all<T>()),
    run: () => (n++, s.run()),
  });
  // a batch runs each of its statements through all(), which counts it
  const api: D1Like = { prepare: (sql) => wrap(db.prepare(sql)), batch: (stmts) => db.batch(stmts) };
  return { api, count: () => n };
}

describe("github app: its pages", () => {
  it("/github is public and may be indexed; it says what the app reads, writes and keeps, and where to install it", async () => {
    const { env } = githubSetup();
    const r = await call(env, "GET", "/github", { origin: null });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-robots-tag")).toBe("index, follow");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await r.text();
    expect(html).toContain('<meta name="robots" content="index, follow">');
    expect(html).toContain('href="/github/install"');
    expect(html).toContain("genclass-dev[bot] is GenClass's GitHub App.");
    expect(html).toContain("It reads the race files your workflow uploads, never your source code.");
    expect(html).toContain("Not asked for:</b> repository contents");
    expect(html).toContain("<b>Public repositories:</b> free");
    expect(html).toContain("with the Enterprise plan, by agreement");
    expect(html).toContain("name: genclass-races");
    // nothing else on this worker became indexable
    expect((await call(env, "GET", "/login", { origin: null })).headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const install = await call(env, "GET", "/github/install", { origin: null });
    expect(install.status).toBe(302);
    expect(install.headers.get("location")).toBe("https://github.com/apps/genclass-dev/installations/new");
    expect((await call(env, "POST", "/github", { body: {} })).status).toBe(405);
  });

  it("an app under another name is shown under that name, and an open server says private repositories are included", async () => {
    const { env } = githubSetup({ GITHUB_APP_SLUG: "acme-genclass", GITHUB_APP_PRIVATE_REPOS: "open" });
    const html = await (await call(env, "GET", "/github", { origin: null })).text();
    expect(html).toContain("acme-genclass[bot] is GenClass's GitHub App.");
    expect(html).toContain("@acme-genclass replay 1");
    expect(html).toContain("included while the app is in beta.");
    expect((await call(env, "GET", "/github/install", { origin: null })).headers.get("location")).toBe("https://github.com/apps/acme-genclass/installations/new");
  });

  it("/github/setup is the same page whatever its address claims: it shows nothing about any installation", async () => {
    const { env, sql } = githubSetup();
    const plain = await (await call(env, "GET", "/github/setup", { origin: null })).text();
    const claimed = await call(env, "GET", `/github/setup?installation_id=${INSTALLATION}&setup_action=install&state=x`, { origin: null });
    expect(claimed.status).toBe(200);
    expect(claimed.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const strip = (h: string) => h.replace(/nonce="[^"]+"/g, "");
    expect(strip(await claimed.text())).toBe(strip(plain));
    expect(plain).toContain("genclass-dev[bot] is installed");
    expect(plain).toContain("npm i -D @genclass/playwright @genclass/runtime@beta");
    expect(plain).not.toContain(String(INSTALLATION));
    expect(sql.rows("SELECT * FROM github_installations")).toEqual([]);
  });

  it("the account page links to GitHub only on a server that runs the app", async () => {
    const on = githubSetup();
    const me = await signedIn(on.env);
    expect(await (await call(on.env, "GET", "/account", { cookie: me.cookie, origin: null })).text()).toContain('href="/account/github" id="ghapp"');
    const off = githubSetup({ GITHUB_APP_ID: undefined });
    const you = await signedIn(off.env);
    expect(await (await call(off.env, "GET", "/account", { cookie: you.cookie, origin: null })).text()).not.toContain("/account/github");
  });
});

describe("github app: Connect GitHub", () => {
  it("signed out it goes to sign-in; signed in it sends the browser to GitHub with a state kept on the server", async () => {
    const { env, sql } = githubSetup();
    const out = await call(env, "GET", "/github/connect", { origin: null });
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("/login?next=%2Faccount%2Fgithub");
    const me = await signedIn(env);
    const r = await call(env, "GET", "/github/connect", { cookie: me.cookie, origin: null });
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(to.searchParams.get("redirect_uri")).toBe("https://genclass.dev/github/callback");
    // no scope is asked for: the app's own permissions are all it has
    expect(to.searchParams.has("scope")).toBe(false);
    const state = to.searchParams.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(40);
    const set = r.headers.getSetCookie().find((c) => c.startsWith("gc_oauth_ghapp="))!;
    expect(set).toMatch(/^gc_oauth_ghapp=[A-Za-z0-9]{22}; Path=\/github; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
    const rows = sql.rows("SELECT kind, challenge, account_id FROM challenges WHERE kind = 'oauth:ghapp'");
    expect(rows).toEqual([{ kind: "oauth:ghapp", challenge: state, account_id: me.account.id }]);
    // the cookie names the row; it does not carry the state
    expect(set).not.toContain(state);
  });

  it("a server without the app's client id says so instead of starting", async () => {
    const { env } = githubSetup({ GITHUB_APP_CLIENT_ID: undefined });
    const me = await signedIn(env);
    const r = await call(env, "GET", "/github/connect", { cookie: me.cookie, origin: null });
    expect(r.status).toBe(404);
    expect(await r.text()).toContain("Connecting GitHub is not set up");
  });

  it("GitHub's answer is kept for 30 minutes, the token is not kept at all, and only this app's installations count", async () => {
    const { env, sql, gh, me, back } = await connected();
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/account/github?connected=1");
    expect(cookieOf(back, "gc_oauth_ghapp")).toBe("gc_oauth_ghapp=");
    // the code was exchanged once, then GitHub was asked who this is, which installations, which repositories
    expect(gh.calls.map((c) => c.path)).toEqual(["/login/oauth/access_token", "/user", "/user/installations", `/user/installations/${INSTALLATION}/repositories`]);
    const grant = sql.rows("SELECT account_id, data, expires FROM challenges WHERE kind = 'ghapp:grant'");
    expect(grant).toHaveLength(1);
    expect(grant[0]!.account_id).toBe(me.account.id);
    expect(grant[0]!.expires).toBe(new Date(now().getTime() + 30 * 60_000).toISOString());
    expect(JSON.parse(String(grant[0]!.data))).toEqual({
      github: { id: 77, login: "ada" },
      repos: [
        { id: REPO.id, name: "acme/shop", private: false, installation: INSTALLATION, push: true },
        { id: 7003, name: "acme/docs", private: true, installation: INSTALLATION, push: false },
      ],
      more: false,
      expires: grant[0]!.expires,
    });
    // nothing in the database holds the token
    const dump = JSON.stringify([sql.rows("SELECT * FROM challenges"), sql.rows("SELECT * FROM github_installations"), sql.rows("SELECT * FROM accounts"), sql.rows("SELECT * FROM auth_sessions")]);
    expect(dump).not.toContain("ghu_usertoken");
    // the installation is recorded (its webhook may never have arrived). It is on an organization, so connecting gives
    // it no manager: that this person can push to one of its repositories says nothing about the organization
    expect(sql.rows("SELECT id, account_login, owner FROM github_installations")).toEqual([{ id: INSTALLATION, account_login: "acme", owner: null }]);
    expect(sql.rows("SELECT * FROM challenges WHERE kind = 'oauth:ghapp'")).toEqual([]);
  });

  it("the callback does nothing without the state this browser was given, in another session, or twice", async () => {
    const s = githubSetup();
    const gh = fakeGithub();
    person(gh);
    const me = await signedIn(s.env);
    const start = await call(s.env, "GET", "/github/connect", { cookie: me.cookie, origin: null });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const oauth = cookieOf(start, "gc_oauth_ghapp")!;
    const back = (q: string, cookie: string) => call(s.env, "GET", `/github/callback?${q}`, { cookie, origin: null, fetch: gh.fetch });
    // a visit GitHub started on its own (an install): no state of ours, nothing is exchanged, and the row waiting for
    // this browser's own start is left alone
    const fromGithub = await back(`code=good-code&installation_id=${INSTALLATION}&setup_action=install`, `${me.cookie}; ${oauth}`);
    expect(fromGithub.status).toBe(302);
    expect(fromGithub.headers.get("location")).toBe("/github/setup");
    expect(gh.calls).toEqual([]);
    expect(s.sql.rows("SELECT COUNT(*) AS n FROM challenges WHERE kind = 'oauth:ghapp'")[0]!.n).toBe(1);
    // starting again replaces the row: one start per account at a time
    const restart = await call(s.env, "GET", "/github/connect", { cookie: me.cookie, origin: null });
    expect(s.sql.rows("SELECT COUNT(*) AS n FROM challenges WHERE kind = 'oauth:ghapp'")[0]!.n).toBe(1);
    expect((await back(`code=good-code&state=${encodeURIComponent(state)}`, `${me.cookie}; ${oauth}`)).status).toBe(400);
    const state0 = new URL(restart.headers.get("location")!).searchParams.get("state")!;
    const oauth0 = cookieOf(restart, "gc_oauth_ghapp")!;
    // the wrong state uses the row up: the right one no longer works either
    expect((await back("code=good-code&state=wrong", `${me.cookie}; ${oauth0}`)).status).toBe(400);
    expect((await back(`code=good-code&state=${encodeURIComponent(state0)}`, `${me.cookie}; ${oauth0}`)).status).toBe(400);
    expect(gh.calls).toEqual([]);

    // a state started in one session cannot be finished in another
    const again = await call(s.env, "GET", "/github/connect", { cookie: me.cookie, origin: null });
    const state2 = new URL(again.headers.get("location")!).searchParams.get("state")!;
    const oauth2 = cookieOf(again, "gc_oauth_ghapp")!;
    const other = await signedIn(s.env, "eve@example.com");
    const stolen = await back(`code=good-code&state=${encodeURIComponent(state2)}`, `${other.cookie}; ${oauth2}`);
    expect(stolen.status).toBe(403);
    expect(await stolen.text()).toContain("Your session changed while you were away.");
    expect(gh.calls).toEqual([]);
    expect(s.sql.rows("SELECT * FROM challenges WHERE kind = 'ghapp:grant'")).toEqual([]);

    // GitHub refusing (the person pressed Cancel), and a code GitHub does not accept
    const third = await call(s.env, "GET", "/github/connect", { cookie: me.cookie, origin: null });
    const st3 = new URL(third.headers.get("location")!).searchParams.get("state")!;
    expect((await back(`error=access_denied&state=${encodeURIComponent(st3)}`, `${me.cookie}; ${cookieOf(third, "gc_oauth_ghapp")!}`)).status).toBe(400);
    const fourth = await call(s.env, "GET", "/github/connect", { cookie: me.cookie, origin: null });
    const st4 = new URL(fourth.headers.get("location")!).searchParams.get("state")!;
    const refused = await back(`code=bad-code&state=${encodeURIComponent(st4)}`, `${me.cookie}; ${cookieOf(fourth, "gc_oauth_ghapp")!}`);
    expect(refused.status).toBe(502);
    expect(s.sql.rows("SELECT * FROM challenges WHERE kind = 'ghapp:grant'")).toEqual([]);
  });

});

describe("github app: who manages an installation (src/github/http.ts header, src/github/entitlement.ts)", () => {
  const PRIVATE = { ...REPO, id: 7002, name: "vault", full_name: "acme/vault", private: true };
  const at = (sha: string) => ({ head: { sha, ref: "f", repo: { id: PRIVATE.id } }, base: { ref: "main", repo: { id: PRIVATE.id } } });

  it("being able to push to a repository, or to administer one, never makes an account the manager of its installation", async () => {
    const s = githubSetup();
    // acme is an organization: the person can push to acme/shop
    const first = await connected("ada@example.com", s);
    expect(first.back.status).toBe(302);
    expect(managerOf(s.sql)).toBeNull();
    // administering a repository is not administering the organization either
    const admin = fakeGithub();
    person(admin);
    admin.user.repositories.get(INSTALLATION)![0].permissions = { admin: true, push: true, pull: true };
    expect((await connected("bob@example.com", s, admin)).back.status).toBe(302);
    expect(managerOf(s.sql)).toBeNull();
    // nor is pushing to a repository of another person's account
    const theirs = fakeGithub();
    person(theirs);
    theirs.user.installations[0].account = { id: 78, login: "grace", type: "User" };
    expect((await connected("carol@example.com", s, theirs)).back.status).toBe(302);
    expect(s.sql.rows("SELECT owner, account_login, account_type FROM github_installations")).toEqual([{ owner: null, account_login: "grace", account_type: "User" }]);
    // GitHub was asked nothing new for any of this: who the person is, their installations, the repositories of each
    expect([...new Set(theirs.calls.map((c) => c.path))]).toEqual(["/login/oauth/access_token", "/user", "/user/installations", `/user/installations/${INSTALLATION}/repositories`]);
  });

  it("the installation on the person's own GitHub account is theirs to manage, from whichever GenClass account they connect", async () => {
    const s = githubSetup();
    const first = await connected("ada@example.com", s, ownAccount());
    expect(s.sql.rows("SELECT owner, account_login FROM github_installations")).toEqual([{ owner: first.me.account.id, account_login: "ada" }]);
    const api = (await (await call(s.env, "GET", "/api/account/github", { cookie: first.me.cookie, origin: null })).json()) as any;
    expect(api.installations).toEqual([{ id: INSTALLATION, login: "ada", type: "User", selection: "selected", suspended: false, managed: true, managedElsewhere: false }]);
    // connecting again changes nothing; the same person from another GenClass account takes it over
    await connect(s.env, first.me, ownAccount());
    expect(managerOf(s.sql)).toBe(first.me.account.id);
    const second = await connected("ada.second@example.com", s, ownAccount());
    expect(managerOf(s.sql)).toBe(second.me.account.id);
    const seen = (await (await call(s.env, "GET", "/api/account/github", { cookie: first.me.cookie, origin: null })).json()) as any;
    expect(seen.installations).toMatchObject([{ managed: false, managedElsewhere: true }]);
    expect(await (await call(s.env, "GET", "/account/github", { cookie: first.me.cookie, origin: null })).text()).toContain("managed by another GenClass account");
  });

  it("connecting never takes an installation from an account whose plan includes private repositories for one whose plan does not", async () => {
    const s = githubSetup();
    const paying = await connected("ada@example.com", s, ownAccount());
    withPrivatePlan(s.sql, paying.me.account.id);
    const free = await connected("ada.second@example.com", s, ownAccount());
    expect(managerOf(s.sql)).toBe(paying.me.account.id);
    // with such a plan of its own it takes over, as between two accounts without one
    withPrivatePlan(s.sql, free.me.account.id);
    await connect(s.env, free.me, ownAccount());
    expect(managerOf(s.sql)).toBe(free.me.account.id);
    // an account the operator set for it by hand is kept the same way
    const company = await signedIn(s.env, "billing@example.com");
    withPrivatePlan(s.sql, company.account.id);
    s.sql.db.prepare("UPDATE github_installations SET owner = ? WHERE id = ?").run(company.account.id, INSTALLATION);
    await connected("ada.third@example.com", s, ownAccount());
    expect(managerOf(s.sql)).toBe(company.account.id);
  });

  it("an organization's private repositories are not read under the plan of an account that can push to one of its repositories, and that account cannot keep them from the plan of the one set for the organization", async () => {
    const s = githubSetup();
    const gh = fakeGithub();
    person(gh);
    gh.repos.set(PRIVATE.full_name, PRIVATE.id);
    await deliver(s.env, "installation", installationCreated(), { fetch: gh.fetch });
    // an outside collaborator who can push to acme/shop, a public repository, connects first; their account has the plan
    const bob = await connected("bob@example.com", s, gh);
    withPrivatePlan(s.sql, bob.me.account.id);
    expect(managerOf(s.sql)).toBeNull();
    const before = gh.calls.length;
    expect(await result(await pullRequest(s.env, gh, "opened", 3, SHA1, at(SHA1), PRIVATE))).toBe("private repository without a plan");
    // nothing of the private repository was read: one neutral check says why
    expect(gh.calls.slice(before).filter((c) => c.path.startsWith("/repos/")).map((c) => `${c.method} ${c.path}`)).toEqual(["POST /repos/acme/vault/check-runs"]);
    // their page says so: the plan is theirs, the installation is not
    const page = await (await call(s.env, "GET", "/account/github", { cookie: bob.me.cookie, origin: null })).text();
    expect(page).toContain("managed by no GenClass account");
    expect(page).toContain("not reviewed: your plan counts for the installations this account manages, and it does not manage this one");
    expect(page).toContain("Being able to push to a repository does not make an account the manager of its installation.");
    const api = (await (await call(s.env, "GET", "/api/account/github", { cookie: bob.me.cookie, origin: null })).json()) as any;
    expect(api.privatePlan).toBe(true);
    expect(api.repos.map((x: any) => [x.name, x.needsPlan])).toEqual([["acme/docs", true], ["acme/shop", false]]);

    // the organization's own GenClass account has the plan and is set as the manager by the operator: its private
    // repositories are reviewed, whoever connected first
    const acme = await signedIn(s.env, "owner@acme.example");
    withPrivatePlan(s.sql, acme.account.id);
    s.sql.db.prepare("UPDATE github_installations SET owner = ? WHERE id = ?").run(acme.account.id, INSTALLATION);
    expect(await result(await pullRequest(s.env, gh, "synchronize", 3, SHA2, at(SHA2), PRIVATE))).toBe("no race files");
    // and the collaborator connecting again changes neither
    await connect(s.env, bob.me, gh);
    expect(managerOf(s.sql)).toBe(acme.account.id);
    const after = (await (await call(s.env, "GET", "/api/account/github", { cookie: bob.me.cookie, origin: null })).json()) as any;
    expect(after.installations).toMatchObject([{ managed: false, managedElsewhere: true }]);
    expect(after.repos.map((x: any) => [x.name, x.needsPlan])).toEqual([["acme/docs", false], ["acme/shop", false]]);
  });
});

describe("github app: the Marketplace listing's webhook sent as a form (src/github/http.ts header)", () => {
  const SECRET = "marketplace-secret-0123456789";
  const purchase = (name = "Team") => ({
    action: "purchased",
    effective_date: "2026-10-13T00:00:00Z",
    marketplace_purchase: { account: { id: OWNER.id, login: OWNER.login, type: "Organization" }, plan: { id: 31, name, monthly_price_in_cents: 2900 }, unit_count: 1, on_free_trial: false, free_trial_ends_on: null },
  });

  it("a purchase sent as application/x-www-form-urlencoded is stored like the JSON one, after the signature over the bytes received", async () => {
    const { env, sql } = githubSetup({ GITHUB_MARKETPLACE_WEBHOOK_SECRET: SECRET });
    const gh = fakeGithub();
    const o = { fetch: gh.fetch, path: "/api/github/marketplace", secret: SECRET, form: true };
    // the listing's first delivery
    expect((await deliver(env, "ping", { zen: "Keep it logically awesome.", hook_id: 1 }, o)).status).toBe(200);
    // no signature, one under another secret, and one that is right for the JSON inside but not for the bytes sent
    expect((await deliver(env, "marketplace_purchase", purchase(), { ...o, header: null })).status).toBe(401);
    expect((await deliver(env, "marketplace_purchase", purchase(), { ...o, secret: WEBHOOK_SECRET })).status).toBe(401);
    expect((await deliver(env, "marketplace_purchase", purchase(), { ...o, header: await signature(JSON.stringify(purchase()), SECRET) })).status).toBe(401);
    // a signed form without the field GitHub puts the JSON in
    expect((await deliver(env, "marketplace_purchase", purchase(), { ...o, form: "something=else" })).status).toBe(400);
    expect(sql.rows("SELECT * FROM github_marketplace")).toEqual([]);

    // the purchase, with a plan name that only survives a real form decoding
    const sent = await deliver(env, "marketplace_purchase", purchase("Team & Co + 1 = é"), { ...o, id: "00000000-0000-4000-8000-0000000f0002" });
    expect(sent.status).toBe(200);
    expect(await result(sent)).toBe("purchased");
    expect(sql.rows("SELECT account_id, plan_name, monthly_cents FROM github_marketplace")).toEqual([{ account_id: OWNER.id, plan_name: "Team & Co + 1 = é", monthly_cents: 2900 }]);
    // the same delivery again is not handled twice
    expect(await (await deliver(env, "marketplace_purchase", purchase("Other"), { ...o, id: "00000000-0000-4000-8000-0000000f0002" })).json()).toEqual({ ok: true, duplicate: true });
    // the app's own webhook still takes no plan event, in either form
    expect(await result(await deliver(env, "marketplace_purchase", purchase("Free"), { fetch: gh.fetch, form: true }))).toBe("ignored");
    expect(sql.rows("SELECT plan_name FROM github_marketplace")).toEqual([{ plan_name: "Team & Co + 1 = é" }]);
  });

  it("without a secret of its own the listing's form is checked against the app's, and a body over the cap is refused unread", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    const o = { fetch: gh.fetch, path: "/api/github/marketplace", form: true };
    expect((await deliver(env, "marketplace_purchase", purchase(), { ...o, secret: SECRET })).status).toBe(401);
    expect(await result(await deliver(env, "marketplace_purchase", purchase(), o))).toBe("purchased");
    expect(sql.rows("SELECT plan_name FROM github_marketplace")).toEqual([{ plan_name: "Team" }]);
    expect((await deliver(env, "marketplace_purchase", purchase(), { ...o, form: `payload=${"x".repeat(3 * 1024 * 1024)}` })).status).toBe(413);
  });
});

describe("github app: linking a repository to a GenClass app", () => {
  it("the page lists the repositories GitHub confirmed, with the account's apps to choose from", async () => {
    const { env, me } = await connected();
    const app = await createApp(env, me.cookie, "Shop <b>");
    const r = await call(env, "GET", "/account/github?connected=1", { cookie: me.cookie, origin: null });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("GitHub is connected.");
    expect(html).toContain("Connected as <b>ada</b>.");
    expect(html).toContain(`<select data-repo="${REPO.id}"`);
    expect(html).toContain(`<option value="${app.id}">Shop &#60;b&#62;</option>`);
    expect(html).not.toContain("<b>Shop");
    // the repository they cannot push to has no control, and its private status shows
    expect(html).not.toContain('data-repo="7003"');
    expect(html).toContain("you need write access on GitHub to change it");
    expect(html).toContain("not reviewed: private repositories need a plan");
    expect(html).not.toContain("other/secret");
    const api = (await (await call(env, "GET", "/api/account/github", { cookie: me.cookie, origin: null })).json()) as any;
    expect(api.repos.map((x: any) => [x.name, x.push, x.project])).toEqual([
      ["acme/docs", false, null],
      ["acme/shop", true, null],
    ]);
    // an organization's installation: nobody manages it because someone can push to its repositories
    expect(api.installations).toEqual([{ id: INSTALLATION, login: "acme", type: "Organization", selection: "selected", suspended: false, managed: false, managedElsewhere: false }]);
    expect(html).toContain("<b>acme</b> (organization, selected repositories), managed by no GenClass account");
    expect(api.linked).toEqual([]);
    // signed out: to sign-in, and the API says so
    expect((await call(env, "GET", "/account/github", { origin: null })).headers.get("location")).toBe("/login?next=%2Faccount%2Fgithub");
    expect((await call(env, "GET", "/api/account/github", { origin: null })).status).toBe(401);
    // a command line session is not a browser session
    expect((await call(env, "GET", "/api/account/github", { bearer: await cliToken(env, me.cookie), origin: null })).status).toBe(401);
  });

  it("before connecting, the page explains what Connect asks GitHub and shows no repository", async () => {
    const { env } = githubSetup();
    const me = await signedIn(env);
    const html = await (await call(env, "GET", "/account/github", { cookie: me.cookie, origin: null })).text();
    expect(html).toContain('href="/github/connect"');
    expect(html).toContain("Your GitHub token is used for that question and not kept.");
    expect(html).not.toContain("<table");
  });

  it("a link needs the browser, this server's Origin, GitHub's fresh word that the person can push, and an app of their own", async () => {
    const { env, sql, me, gh } = await connected();
    const app = await createApp(env, me.cookie, "Shop");
    const post = (id: number, body: unknown, o: Parameters<typeof call>[3] = {}) => call(env, "POST", `/api/account/github/repos/${id}`, { cookie: me.cookie, body, ...o });
    expect((await post(REPO.id, { project_id: app.id }, { cookie: undefined })).status).toBe(401);
    expect((await post(REPO.id, { project_id: app.id }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(REPO.id, { project_id: app.id }, { origin: null })).status).toBe(403);
    expect((await call(env, "POST", `/api/account/github/repos/${REPO.id}`, { cookie: me.cookie, body: "project_id=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
    expect((await post(REPO.id, { project_id: app.id }, { cookie: undefined, bearer: await cliToken(env, me.cookie) })).status).toBe(401);
    // a repository they cannot push to, one GitHub did not list, and another account's app
    expect((await post(7003, { project_id: app.id })).status).toBe(403);
    expect((await post(424242, { project_id: app.id })).status).toBe(403);
    const eve = await signedIn(env, "eve@example.com");
    const theirs = await createApp(env, eve.cookie, "Eve's");
    expect((await post(REPO.id, { project_id: theirs.id })).status).toBe(404);
    expect((await post(REPO.id, { project_id: "nope" })).status).toBe(404);
    expect(sql.rows("SELECT * FROM github_repos")).toEqual([]);

    const ok = await post(REPO.id, { project_id: app.id });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, repo: { id: REPO.id, project: app.id, paused: false } });
    expect(sql.rows("SELECT repo_id, installation_id, full_name, private, project_id, linked_by, paused FROM github_repos")).toEqual([
      { repo_id: REPO.id, installation_id: INSTALLATION, full_name: "acme/shop", private: 0, project_id: app.id, linked_by: me.account.id, paused: 0 },
    ]);
    // Eve, connected as the same GitHub person, sees that it is linked but never to what
    const eveConnected = await connected("frank@example.com", { env, sql, r2: undefined as never });
    const seen = (await (await call(env, "GET", "/api/account/github", { cookie: eveConnected.me.cookie, origin: null })).json()) as any;
    expect(seen.repos.find((x: any) => x.name === "acme/shop")).toMatchObject({ project: null, linkedElsewhere: true });
    expect(JSON.stringify(seen)).not.toContain(app.id);

    // pause, then reviews stop; resume and unlink
    expect(await (await post(REPO.id, { paused: true })).json()).toEqual({ ok: true, repo: { id: REPO.id, project: app.id, paused: true } });
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("paused");
    expect(await (await post(REPO.id, { paused: false, project_id: null })).json()).toEqual({ ok: true, repo: { id: REPO.id, project: null, paused: false } });
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");

    // GitHub's word is good for 30 minutes
    advance(31 * 60_000);
    const late = await post(REPO.id, { project_id: app.id });
    expect(late.status).toBe(403);
    expect(((await late.json()) as any).error).toContain("connect GitHub again");
  });

  it("the account that owns a linked app can take the link away after it lost write access to the repository, and nothing else", async () => {
    const s = githubSetup();
    const { env, sql, me, gh } = await connected("carol@example.com", s);
    const app = await createApp(env, me.cookie, "Shop");
    const post = (cookie: string, body: unknown, o: Parameters<typeof call>[3] = {}) => call(env, "POST", `/api/account/github/repos/${REPO.id}`, { cookie, body, ...o });
    expect((await post(me.cookie, { project_id: app.id, paused: true })).status).toBe(200);
    // her role on acme/shop is reduced to read: GitHub's next answer says so
    gh.user.repositories.get(INSTALLATION)![0].permissions = { admin: false, push: false, pull: true };
    expect((await connect(env, me, gh)).back.status).toBe(302);
    // what needs write access is refused as before, also together with the unlink: nothing is half done
    expect((await post(me.cookie, { paused: false })).status).toBe(403);
    expect((await post(me.cookie, { project_id: app.id })).status).toBe(403);
    expect((await post(me.cookie, { project_id: null, paused: false })).status).toBe(403);
    expect(sql.rows("SELECT project_id, paused FROM github_repos")).toEqual([{ project_id: app.id, paused: 1 }]);
    // the page shows the link with its one control
    const html = await (await call(env, "GET", "/account/github", { cookie: me.cookie, origin: null })).text();
    expect(html).toContain("Linked to Shop (you need write access on GitHub to change anything but this link)");
    expect(html).toContain(`data-unlink="${REPO.id}"`);
    expect(html).not.toContain(`data-pause="${REPO.id}"`);
    expect(html).not.toContain(`data-repo="${REPO.id}"`);
    // not from another site, and not by another account: one that cannot write there either, and one that can but asks without GitHub's answer
    expect((await post(me.cookie, { project_id: null }, { origin: "https://evil.example" })).status).toBe(403);
    const eve = await connected("eve@example.com", s, gh);
    expect((await post(eve.me.cookie, { project_id: null })).status).toBe(403);
    const frank = await signedIn(env, "frank@example.com");
    expect((await post(frank.cookie, { project_id: null })).status).toBe(403);
    expect(await (await call(env, "GET", "/account/github", { cookie: eve.me.cookie, origin: null })).text()).not.toContain('data-unlink="');
    expect(sql.rows("SELECT project_id FROM github_repos")).toEqual([{ project_id: app.id }]);

    // she takes it away: the link goes, the pause someone with write access set stays
    const done = await post(me.cookie, { project_id: null });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, repo: { id: REPO.id, project: null, paused: true } });
    expect(sql.rows("SELECT repo_id, full_name, project_id, linked_by, linked, paused FROM github_repos")).toEqual([{ repo_id: REPO.id, full_name: "acme/shop", project_id: null, linked_by: null, linked: null, paused: 1 }]);
    // there is no link of hers left to take
    expect((await post(me.cookie, { project_id: null })).status).toBe(403);
  });

  it("links to the account's apps on repositories GitHub no longer lists are shown and can be taken away; a private one is not named", async () => {
    const s = githubSetup();
    const gh = fakeGithub();
    person(gh);
    gh.user.repositories.get(INSTALLATION)![1].permissions = { admin: false, push: true, pull: true };
    const { env, sql, me } = await connected("carol@example.com", s, gh);
    const shop = await createApp(env, me.cookie, "Shop");
    const docs = await createApp(env, me.cookie, "Docs");
    const post = (id: number, body: unknown, cookie = me.cookie) => call(env, "POST", `/api/account/github/repos/${id}`, { cookie, body });
    expect((await post(REPO.id, { project_id: shop.id })).status).toBe(200);
    expect((await post(7003, { project_id: docs.id })).status).toBe(200);
    const view = async (cookie = me.cookie) => (await (await call(env, "GET", "/api/account/github", { cookie, origin: null })).json()) as any;
    // while GitHub lists them, they are in the list of repositories and nowhere else
    expect((await view()).linked).toEqual([]);

    // she is removed from the organization: GitHub lists no repository of the installation for her
    gh.user.repositories.set(INSTALLATION, []);
    await connect(env, me, gh);
    const after = await view();
    expect(after.repos).toEqual([]);
    expect(after.linked).toEqual([
      { id: 7003, name: null, private: true, project: docs.id },
      { id: REPO.id, name: "acme/shop", private: false, project: shop.id },
    ]);
    const html = await (await call(env, "GET", "/account/github", { cookie: me.cookie, origin: null })).text();
    expect(html).toContain("Linked, not in GitHub's answer");
    expect(html).toContain(`data-unlink="${REPO.id}"`);
    expect(html).toContain('data-unlink="7003"');
    expect(html).toContain("A private repository");
    expect(html).toContain("Linked to Docs");
    // a private repository's name may have changed since she could see it
    expect(html).not.toContain("acme/docs");
    expect(html).toContain('id="gherr"');
    // nobody else's page lists them
    const eve = await signedIn(env, "eve@example.com");
    expect((await view(eve.cookie)).linked).toEqual([]);
    expect((await post(7003, { project_id: null }, eve.cookie)).status).toBe(403);

    // with no answer from GitHub at all (it ran out), the links are still hers to take away
    advance(31 * 60_000);
    expect((await view()).connected).toBeNull();
    expect((await view()).linked).toHaveLength(2);
    expect((await post(REPO.id, { project_id: shop.id })).status).toBe(403);
    expect(await (await post(7003, { project_id: null })).json()).toEqual({ ok: true, repo: { id: 7003, project: null, paused: false } });
    expect(await (await post(REPO.id, { project_id: null })).json()).toEqual({ ok: true, repo: { id: REPO.id, project: null, paused: false } });
    expect(sql.rows("SELECT project_id, linked_by FROM github_repos ORDER BY repo_id")).toEqual([{ project_id: null, linked_by: null }, { project_id: null, linked_by: null }]);
    expect((await view()).linked).toEqual([]);
  });

  it("the account page asks the database a few times, however many repositories GitHub listed", async () => {
    const s = githubSetup();
    const { env, sql, me } = await connected("ada@example.com", s);
    const app = await createApp(env, me.cookie, "Shop");
    expect((await call(env, "POST", `/api/account/github/repos/${REPO.id}`, { cookie: me.cookie, body: { project_id: app.id } })).status).toBe(200);
    const view = async () => {
      const db = counting(sql.api);
      const r = await call({ ...env, DB: db.api }, "GET", "/api/account/github", { cookie: me.cookie, origin: null });
      expect(r.status).toBe(200);
      return { api: (await r.json()) as any, statements: db.count() };
    };
    const small = await view();
    expect(small.api.repos).toHaveLength(2);

    // GitHub's answer with 300 repositories of two installations (the most it keeps), one of them paused
    const row = sql.rows("SELECT id, data FROM challenges WHERE kind = 'ghapp:grant'")[0]!;
    const grant = JSON.parse(String(row.data));
    for (let i = 0; i < 298; i++) grant.repos.push({ id: 100_000 + i, name: `${i % 2 ? "acme" : "beta"}/r${String(i).padStart(3, "0")}`, private: i % 7 === 0, installation: i % 2 ? INSTALLATION : 9002, push: true });
    sql.db.prepare("UPDATE challenges SET data = ? WHERE id = ?").run(JSON.stringify(grant), row.id as string);
    sql.db.prepare("INSERT INTO github_installations (id, account_id, account_login, account_type, selection, created, updated) VALUES (9002, 502, 'beta', 'Organization', 'all', ?, ?)").run(now().toISOString(), now().toISOString());
    sql.db.prepare("INSERT INTO github_repos (repo_id, installation_id, full_name, private, paused, updated) VALUES (100297, ?, 'acme/r297', 0, 1, ?)").run(INSTALLATION, now().toISOString());
    const big = await view();
    expect(big.api.repos).toHaveLength(300);
    expect(big.api.installations.map((i: any) => i.login)).toEqual(["acme", "beta"]);
    // what is kept for a repository is still found for each one
    expect(big.api.repos.find((x: any) => x.id === REPO.id)).toMatchObject({ project: app.id, paused: false });
    expect(big.api.repos.find((x: any) => x.id === 100_297)).toMatchObject({ project: null, paused: true });
    expect(big.api.repos.filter((x: any) => x.project || x.paused)).toHaveLength(2);
    expect(big.api.repos.filter((x: any) => x.needsPlan)).toHaveLength(44);
    // 298 more repositories and one more installation cost a handful of statements, not one or two each
    expect(big.statements - small.statements).toBeLessThanOrEqual(6);
    expect(big.statements).toBeLessThanOrEqual(20);
  });
});

describe("github app: the worker still bundles for Workers", () => {
  it("with the app in it, the worker's bundle imports no Node module, and the app's pages carry no bundler helper in their scripts", async () => {
    // as Wrangler bundles it (test/bundle.test.ts): esm, keepNames, and no Node platform to fall back on
    const out = await build({ entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))], bundle: true, format: "esm", platform: "neutral", keepNames: true, write: false, logLevel: "silent", metafile: true });
    const code = out.outputFiles[0]!.text;
    expect(code).not.toMatch(/from "node:/);
    expect(code).not.toMatch(/\brequire\(/);
    const inputs = Object.keys(out.metafile.inputs);
    // the reporter's summariser is bundled from its source, not copied
    expect(inputs.some((i) => i.endsWith("packages/playwright/src/summarize.ts"))).toBe(true);
    for (const f of ["zip.ts", "yaml.ts", "handlers.ts", "review.ts"]) expect(inputs.some((i) => i.endsWith(`src/github/${f}`)), f).toBe(true);
    // nothing from the reporter that touches a file system or Playwright came with it
    expect(inputs.filter((i) => i.includes("packages/playwright/")).map((i) => i.split("/").pop()).sort()).toEqual(["schema.ts", "summarize.ts", "types.ts"]);
    const { env } = githubSetup();
    const me = await signedIn(env);
    for (const path of ["/github", "/github/setup", "/account/github"]) {
      const html = await (await call(env, "GET", path, { cookie: me.cookie, origin: null })).text();
      for (const m of html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)) expect(m[1], path).not.toContain("__name(");
    }
  });
});
