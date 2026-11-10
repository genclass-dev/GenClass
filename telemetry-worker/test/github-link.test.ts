// The GitHub App's pages and the link between a repository and a GenClass app: the public page, the page after
// installing, "Connect GitHub" (GitHub says who is asking and what they can reach) and the account's settings.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { advance, call, cliToken, createApp, now, resetClock, signedIn } from "./account-helpers.js";
import { APP_ID, CLIENT_ID, deliver, fakeGithub, githubSetup, INSTALLATION, installationCreated, OWNER, pullRequest, REPO, result, SHA1 } from "./github-helpers.js";

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

/** Signed in, with GitHub connected: the session cookie, the account, and the fake GitHub. */
async function connected(email = "ada@example.com", s = githubSetup(), prepared?: ReturnType<typeof fakeGithub>) {
  const gh = prepared ?? fakeGithub();
  if (!prepared) person(gh);
  const me = await signedIn(s.env, email);
  const start = await call(s.env, "GET", "/github/connect", { cookie: me.cookie, origin: null });
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const oauth = cookieOf(start, "gc_oauth_ghapp")!;
  const back = await call(s.env, "GET", `/github/callback?code=good-code&state=${encodeURIComponent(state)}`, { cookie: `${me.cookie}; ${oauth}`, origin: null, fetch: gh.fetch });
  return { ...s, gh, me, back, state, oauth };
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
    // the installation is recorded (its webhook may never have arrived) and managed by this account, who can push there
    expect(sql.rows("SELECT id, account_login, owner FROM github_installations")).toEqual([{ id: INSTALLATION, account_login: "acme", owner: me.account.id }]);
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

  it("an installation someone else manages stays theirs, unless it is on the person's own GitHub account", async () => {
    const s = githubSetup();
    const first = await connected("ada@example.com", s);
    expect(s.sql.rows("SELECT owner FROM github_installations")[0]!.owner).toBe(first.me.account.id);
    const second = await connected("bob@example.com", s);
    expect(s.sql.rows("SELECT owner FROM github_installations")[0]!.owner).toBe(first.me.account.id);
    // the same installation, now on the GitHub account of the person connecting (id 77): theirs to manage
    const gh = fakeGithub();
    person(gh);
    gh.user.installations[0].account = { id: 77, login: "ada", type: "User" };
    await connected("carol@example.com", s, gh).then((third) => {
      expect(s.sql.rows("SELECT owner, account_login FROM github_installations")[0]).toEqual({ owner: third.me.account.id, account_login: "ada" });
    });
    expect(second.back.status).toBe(302);
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
    expect(api.installations).toEqual([{ id: INSTALLATION, login: "acme", type: "Organization", selection: "selected", suspended: false, managed: true }]);
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
