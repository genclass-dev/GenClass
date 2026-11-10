// The GitHub App's routes on this worker. Checked before the account routes (src/auth.ts); null for any other path.
//
//   POST /api/github/webhook        GitHub only: the app's webhook (signature, then src/github/handlers.ts)
//   POST /api/github/marketplace    GitHub only: the Marketplace listing's webhook (plan purchases and changes)
//   GET  /github                    the app's public page: what it does, what it may read and write, install
//   GET  /github/install            to GitHub's install page for the app
//   GET  /github/setup              where GitHub sends someone after installing: the next steps (no account needed)
//   GET  /github/connect            signed in: ask GitHub who this is and which installations they can reach
//   GET  /github/callback           GitHub's answer to /github/connect
//   GET  /account/github            signed in: the installations and repositories, and which app each is linked to
//   GET  /api/account/github        the same as JSON
//   POST /api/account/github/repos/<repo id>   { project_id?: string | null, paused?: boolean }
//
// Invariants:
// - A webhook is acted on only when its X-Hub-Signature-256 is the HMAC-SHA256 of the exact bytes received under the
//   app's webhook secret (WebCrypto's verify, constant time). No signature, a wrong one, or an app that is not set up
//   on this server: nothing is parsed. A delivery id is handled once.
// - The webhook answers at once and works after the response (waitUntil), so GitHub's 10 seconds are never at risk; a
//   job that fails forgets its delivery id, so "Redeliver" on GitHub's side runs it again.
// - /github/setup trusts nothing in its address (GitHub's documentation warns that `installation_id` there can be
//   made up): it is a static page. Who may manage what is established only by /github/connect, where GitHub itself
//   answers which installations and repositories the signed-in person can reach.
// - The user access token from /github/callback is used for those few questions and dropped: never stored, never
//   logged. What is kept for 30 minutes is the answer (repository ids, names and whether the person can push).
// - A repository is linked to a GenClass app only by an account that owns the app AND can push to the repository
//   according to that answer, from the browser, with this server's Origin (CSRF).
// - The OAuth state is single use, kept server-side and named by a cookie that holds only its row id; the callback
//   must arrive in the session that started it.

import { accountContext, accountProjects, csrfFail, fail, getCookie, originOk, ownedProject, page, readJson, redirect, webSession, type C } from "../auth.js";
import { messagePage } from "../account-pages.js";
import type { Env, HandleOptions } from "../collector.js";
import { randomBase62 } from "../dashboard.js";
import { json, readCapped } from "../http.js";
import { securityHeaders } from "../pages.js";
import { accountAccess } from "../plans.js";
import { b64url, equalStrings } from "../webauthn.js";
import { GithubError, posInt, repoPath, userClient, type Fetch } from "./api.js";
import { githubApp, installUrl, type GithubAppConfig } from "./config.js";
import { handleEvent, type Ctx } from "./handlers.js";
import { AppKeyError } from "./jwt.js";
import { accountGithubPage, githubLandingPage, githubSetupPage, type GithubAccountView } from "./pages.js";
import { claimDelivery, forgetDelivery, installationById, installationsOf, linkRepo, pauseRepo, repoById, reposOfInstallation, setInstallationOwner, upsertInstallation } from "./store.js";

/** Largest webhook body read (an installation event lists every repository it covers). */
export const MAX_WEBHOOK_BYTES = 3 * 1024 * 1024;
const EVENTS = new Set(["ping", "installation", "installation_repositories", "pull_request", "workflow_run", "check_run", "issue_comment", "github_app_authorization", "marketplace_purchase"]);
const DELIVERY_RE = /^[0-9A-Fa-f-]{16,64}$/;
const OAUTH_COOKIE = "gc_oauth_ghapp";
const OAUTH_MS = 10 * 60_000;
/** How long GitHub's answer about a person's repositories is good for linking. */
export const GRANT_MS = 30 * 60_000;
const MAX_INSTALLATIONS = 20;
const MAX_GRANT_REPOS = 300;

// --------------------------------------------------------------------------------------------- webhook signature

/**
 * Whether `header` ("sha256=<hex>") is the HMAC-SHA256 of `body` under `secret`. The comparison is WebCrypto's
 * verify, which does not leak where two signatures differ.
 */
export async function verifyGithubSignature(body: Uint8Array, header: string | null, secret: string): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/.exec((header ?? "").trim());
  if (!m || !secret) return false;
  const sig = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sig[i] = parseInt(m[1]!.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig as BufferSource, body as BufferSource);
}

async function webhook(request: Request, env: Env, opts: HandleOptions, cfg: GithubAppConfig | null, which: "app" | "marketplace"): Promise<Response> {
  if (request.method !== "POST") return fail(405, "method not allowed");
  if (!cfg || !env.DB) return fail(503, "the GitHub App is not set up on this server");
  const raw = await readCapped(request, MAX_WEBHOOK_BYTES);
  if (raw === null) return fail(413, "body too large");
  // the listing's webhook has a secret of its own on GitHub's side; unset here, the app's is expected for both
  const secret = which === "marketplace" ? (env.GITHUB_MARKETPLACE_WEBHOOK_SECRET ?? "").trim() || cfg.webhookSecret : cfg.webhookSecret;
  if (!(await verifyGithubSignature(raw, request.headers.get("x-hub-signature-256"), secret))) return fail(401, "signature check failed");
  const event = (request.headers.get("x-github-event") ?? "").trim();
  const delivery = (request.headers.get("x-github-delivery") ?? "").trim();
  if (!DELIVERY_RE.test(delivery)) return fail(400, "no delivery id");
  // each endpoint takes its own events: the listing's webhook cannot start a review, the app's cannot set a plan
  const taken = which === "marketplace" ? event === "marketplace_purchase" || event === "ping" : EVENTS.has(event) && event !== "marketplace_purchase";
  if (!taken) return json(200, { ok: true, result: "ignored" });
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return fail(400, "invalid JSON");
  }
  const db = env.DB;
  const now = opts.now ?? (() => new Date());
  if (!(await claimDelivery(db, delivery, event, now()))) return json(200, { ok: true, duplicate: true });
  const ctx: Ctx = { env, db, cfg, f: opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i)), now };
  const job = handleEvent(ctx, event, payload).catch(async (e: unknown) => {
    // forgotten, so that a redelivery runs it; the reason is a word, never a payload
    await forgetDelivery(db, delivery).catch(() => undefined);
    const why = e instanceof GithubError ? e.kind : "error";
    // a key that cannot be used says why in words that hold no key material (jwt.ts), which is what setup needs to see
    console.log(`github webhook: ${event} failed: ${why}${e instanceof AppKeyError ? ` (${e.message})` : ""}`);
    return `failed: ${why}`;
  });
  if (opts.waitUntil) {
    opts.waitUntil(job);
    return json(202, { ok: true, queued: true });
  }
  const result = await job;
  return json(result.startsWith("failed") ? 502 : 200, { ok: !result.startsWith("failed"), result });
}

// --------------------------------------------------------------------------------------------- connect (OAuth)

interface GrantRepo {
  id: number;
  name: string;
  private: boolean;
  installation: number;
  push: boolean;
}
interface Grant {
  github: { id: number; login: string };
  repos: GrantRepo[];
  /** More repositories than MAX_GRANT_REPOS were reachable; the rest are not listed. */
  more: boolean;
  expires: string;
}

const cookie = (c: C, name: string, value: string, maxAgeS: number, path: string): string =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${c.cfg.secure ? "; Secure" : ""}`;

async function connectStart(c: C, cfg: GithubAppConfig): Promise<Response> {
  if (!cfg.clientId) return page(404, (n) => messagePage(n, { title: "Connecting GitHub is not set up", text: "This GenClass server has no client id and secret for its GitHub App, so it cannot ask GitHub who you are. Reviews work without it.", links: [["Your apps", "/account"]] }));
  const a = await webSession(c);
  if (!a) return redirect(`/login?next=${encodeURIComponent("/account/github")}`);
  const id = randomBase62(22);
  const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
  // one start at a time per account: a page that makes a signed-in browser load this address cannot pile up rows
  await c.db.batch([
    c.db.prepare("DELETE FROM challenges WHERE kind = 'oauth:ghapp' AND account_id = ?").bind(a.account.id),
    c.db
      .prepare("INSERT INTO challenges (id, kind, challenge, account_id, data, expires) VALUES (?, 'oauth:ghapp', ?, ?, ?, ?)")
      .bind(id, state, a.account.id, JSON.stringify({ sid: a.sessionId }), new Date(c.now.getTime() + OAUTH_MS).toISOString()),
  ]);
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: `${cfg.origin}/github/callback`, state });
  return redirect(`${cfg.web}/login/oauth/authorize?${q}`, [cookie(c, OAUTH_COOKIE, id, OAUTH_MS / 1000, "/github")]);
}

async function connectCallback(c: C, cfg: GithubAppConfig, f: Fetch): Promise<Response> {
  const clear = cookie(c, OAUTH_COOKIE, "", 0, "/github");
  const bad = (status: number, text: string): Response => {
    const r = page(status, (n) => messagePage(n, { title: "GitHub was not connected", text, links: [["Try again", "/account/github"]] }));
    r.headers.append("set-cookie", clear);
    return r;
  };
  if (!cfg.clientId || !cfg.clientSecret) return bad(404, "This GenClass server cannot ask GitHub who you are.");
  // GitHub sent someone here on its own, after an install (an app set to ask for authorization while installing):
  // there is no state of ours, so nothing is exchanged and they get the page every installer gets
  if (!c.url.searchParams.has("state") && c.url.searchParams.has("installation_id")) return redirect("/github/setup");
  const id = getCookie(c.req, OAUTH_COOKIE);
  const row =
    id && /^[A-Za-z0-9]{22}$/.test(id)
      ? await c.db.prepare("DELETE FROM challenges WHERE id = ? AND kind = 'oauth:ghapp' RETURNING challenge, account_id, data, expires").bind(id).first<{ challenge: string; account_id: string | null; data: string | null; expires: string }>()
      : null;
  if (c.url.searchParams.get("error")) return bad(400, "GitHub did not authorize this. Nothing was connected.");
  const state = c.url.searchParams.get("state");
  if (!row || Date.parse(row.expires) <= c.now.getTime() || !state || !equalStrings(state, row.challenge)) {
    // also what a visit that GitHub started (an install with no state of ours) gets: nothing is exchanged
    return bad(400, "This link expired or was opened in another browser. Start again from your account page.");
  }
  const a = await webSession(c);
  let sid: unknown = null;
  try {
    sid = (JSON.parse(row.data ?? "{}") as { sid?: unknown }).sid;
  } catch {
    /* no session recorded */
  }
  if (!a || a.account.id !== row.account_id || a.sessionId !== sid) return bad(403, "Your session changed while you were away. Sign in, then connect GitHub again.");
  const code = c.url.searchParams.get("code");
  if (!code || code.length > 2048) return bad(400, "GitHub did not send a code. Start again.");

  let grant: Grant;
  try {
    const r = await f(`${cfg.web}/login/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "genclass.dev" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: `${cfg.origin}/github/callback` }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (!r.ok || typeof tok.access_token !== "string" || !tok.access_token) throw new Error("no token");
    grant = await readGrant(c, cfg, f, tok.access_token, a.account.id);
  } catch (e) {
    console.log(`github connect: failed: ${e instanceof GithubError ? e.kind : "error"}`);
    return bad(502, "GitHub did not answer the questions this page asks it. Start again in a minute.");
  }
  // the newest answer replaces any earlier one of this account
  await c.db.batch([
    c.db.prepare("DELETE FROM challenges WHERE kind = 'ghapp:grant' AND account_id = ?").bind(a.account.id),
    c.db
      .prepare("INSERT INTO challenges (id, kind, challenge, account_id, data, expires) VALUES (?, 'ghapp:grant', ?, ?, ?, ?)")
      .bind(randomBase62(22), b64url(crypto.getRandomValues(new Uint8Array(16))), a.account.id, JSON.stringify(grant), grant.expires),
  ]);
  return redirect("/account/github?connected=1", [clear]);
}

/**
 * Ask GitHub, as the person, who they are and which installations of THIS app and which of their repositories they
 * can reach; record the installations they may manage. The token goes no further than this function.
 */
async function readGrant(c: C, cfg: GithubAppConfig, f: Fetch, token: string, accountId: string): Promise<Grant> {
  const gh = userClient(cfg, f, () => c.now, token, 4 + MAX_INSTALLATIONS * 3);
  const me = (await gh.get<Record<string, unknown>>("/user")) ?? {};
  const id = posInt(me.id);
  const login = typeof me.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(me.login) ? me.login : null;
  if (!id || !login) throw new GithubError("unexpected", 200, "GitHub did not say who this is");
  const installs = await gh.list<Record<string, unknown>>("/user/installations", { max: 100, key: "installations" });
  const repos: GrantRepo[] = [];
  let more = false;
  let seen = 0;
  for (const i of installs) {
    const iid = posInt(i.id);
    // only installations of this app count, whatever else the token can see
    if (!iid || String(i.app_id ?? "") !== cfg.appId) continue;
    if (++seen > MAX_INSTALLATIONS) {
      more = true;
      break;
    }
    const acct = (i.account ?? {}) as Record<string, unknown>;
    const acctId = posInt(acct.id);
    const acctLogin = typeof acct.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(acct.login) ? acct.login : null;
    if (!acctId || !acctLogin) continue;
    const mine = await gh.list<Record<string, unknown>>(`/user/installations/${iid}/repositories`, { max: MAX_GRANT_REPOS, key: "repositories" });
    let canPush = false;
    for (const r of mine) {
      const rid = posInt(r.id);
      const name = typeof r.full_name === "string" && repoPath(r.full_name) ? r.full_name : null;
      if (!rid || !name) continue;
      const perms = (r.permissions ?? {}) as Record<string, unknown>;
      const push = perms.push === true || perms.admin === true;
      canPush ||= push;
      if (repos.length >= MAX_GRANT_REPOS) {
        more = true;
        continue;
      }
      repos.push({ id: rid, name, private: r.private !== false, installation: iid, push });
    }
    // the installation is recorded (its webhook may have been missed), and managed by this account when nobody
    // manages it yet and the person can push to something in it, or when it is their own account's installation
    await upsertInstallation(c.db, { id: iid, accountId: acctId, login: acctLogin, type: String(acct.type ?? "User"), selection: String(i.repository_selection ?? "selected"), suspended: !!i.suspended_at }, c.now);
    const known = await installationById(c.db, iid);
    if (known && known.owner !== accountId && (acctId === id || (known.owner === null && canPush))) await setInstallationOwner(c.db, iid, accountId, c.now);
  }
  return { github: { id, login }, repos, more, expires: new Date(c.now.getTime() + GRANT_MS).toISOString() };
}

async function grantOf(c: C, accountId: string): Promise<Grant | null> {
  const row = await c.db
    .prepare("SELECT data FROM challenges WHERE kind = 'ghapp:grant' AND account_id = ? AND expires > ? ORDER BY expires DESC LIMIT 1")
    .bind(accountId, c.now.toISOString())
    .first<{ data: string | null }>();
  if (!row?.data) return null;
  try {
    const g = JSON.parse(row.data) as Grant;
    return g && Array.isArray(g.repos) && g.github ? g : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------------------------- the account's view

async function accountView(c: C, cfg: GithubAppConfig, accountId: string, who: string): Promise<GithubAccountView> {
  const grant = await grantOf(c, accountId);
  const managed = await installationsOf(c.db, accountId);
  const projects = (await accountProjects(c, accountId)).map((p) => ({ id: p.id!, name: p.name }));
  const access = await accountAccess(c.db, accountId, c.env, c.now);
  const byId = new Map(managed.map((i) => [i.id, { id: i.id, login: i.account_login, type: i.account_type, selection: i.selection, suspended: !!i.suspended, managed: true }]));
  const repos: GithubAccountView["repos"] = [];
  const stored = new Map<number, { project: string | null; paused: boolean }>();
  for (const i of managed) for (const r of await reposOfInstallation(c.db, i.id)) stored.set(r.repo_id, { project: r.project_id, paused: !!r.paused });
  for (const r of grant?.repos ?? []) {
    if (!byId.has(r.installation)) {
      const inst = await installationById(c.db, r.installation);
      if (inst) byId.set(inst.id, { id: inst.id, login: inst.account_login, type: inst.account_type, selection: inst.selection, suspended: !!inst.suspended, managed: inst.owner === accountId });
    }
    const s = stored.get(r.id) ?? (await repoById(c.db, r.id).then((x) => (x ? { project: x.project_id, paused: !!x.paused } : null)));
    // a link to another account's app is shown as linked, never by name
    const mine = s?.project && projects.some((p) => p.id === s.project) ? s.project : null;
    repos.push({ id: r.id, name: r.name, private: r.private, installation: r.installation, push: r.push, project: mine, linkedElsewhere: !!s?.project && !mine, paused: !!s?.paused });
  }
  return {
    who,
    plan: access.plan.name,
    slug: cfg.slug,
    canConnect: !!cfg.clientId,
    connected: grant ? { login: grant.github.login, expires: grant.expires, more: grant.more } : null,
    installations: [...byId.values()].sort((a, b) => a.login.localeCompare(b.login)),
    repos: repos.sort((a, b) => a.name.localeCompare(b.name)),
    projects,
    notice: c.url.searchParams.get("connected") === "1" ? "GitHub is connected. Link a repository to one of your apps below." : null,
    privatePlan: cfg.privateRepos === "open" || access.plan.entitlements.github_private === true,
  };
}

/** POST /api/account/github/repos/<id>: link a repository to one of the account's apps, unlink it, pause or resume it. */
async function updateRepo(c: C, repoId: number): Promise<Response> {
  const a = await webSession(c);
  if (!a) return fail(401, "not signed in");
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c, 1024);
  if (body instanceof Response) return body;
  const grant = await grantOf(c, a.account.id);
  const r = grant?.repos.find((x) => x.id === repoId);
  // GitHub's own answer, at most 30 minutes old, that this person can push to this repository
  if (!grant || !r) return fail(403, "connect GitHub again: this page only changes repositories GitHub just confirmed you can reach");
  if (!r.push) return fail(403, "you need write access to this repository on GitHub to change its GenClass settings");
  const inst = await installationById(c.db, r.installation);
  if (!inst) return fail(404, "the GitHub App is no longer installed there");
  const base = { repoId, installationId: r.installation, fullName: r.name, private: r.private };
  if ("project_id" in body) {
    let projectId: string | null = null;
    if (body.project_id !== null) {
      const p = typeof body.project_id === "string" ? await ownedProject(c, a.account.id, body.project_id) : null;
      if (!p?.id) return fail(404, "no such app in your account");
      projectId = p.id;
    }
    await linkRepo(c.db, { ...base, projectId, accountId: a.account.id }, c.now);
  }
  if (typeof body.paused === "boolean") await pauseRepo(c.db, { ...base, paused: body.paused }, c.now);
  const now = await repoById(c.db, repoId);
  return json(200, { ok: true, repo: { id: repoId, project: now?.project_id ?? null, paused: !!now?.paused } });
}

// --------------------------------------------------------------------------------------------- routes

const html = (status: number, body: string, nonce: string, extra: Record<string, string> = {}): Response => new Response(body, { status, headers: securityHeaders(nonce, extra) });

export async function routeGithub(request: Request, url: URL, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  const mine = path === "/github" || path.startsWith("/github/") || path === "/account/github" || path === "/api/account/github" || path.startsWith("/api/account/github/") || path.startsWith("/api/github/");
  if (!mine) return null;
  const cfg = githubApp(env);
  const m = request.method;
  const get = m === "GET" || m === "HEAD";
  if (path === "/api/github/webhook") return webhook(request, env, opts, cfg, "app");
  if (path === "/api/github/marketplace") return webhook(request, env, opts, cfg, "marketplace");
  if (path.startsWith("/api/github/")) return fail(404, "not found");

  // without the app's secrets this server has no GitHub App: its pages are not found (the site may answer them)
  if (!cfg) return path.startsWith("/api/") ? fail(404, "not found") : null;
  if (path === "/github") {
    if (!get) return fail(405, "method not allowed");
    const nonce = randomBase62(22);
    // the one page of this worker meant to be found: what the app is, before anyone installs it
    return html(200, githubLandingPage(nonce, { slug: cfg.slug, privateRepos: cfg.privateRepos }), nonce, { "x-robots-tag": "index, follow" });
  }
  if (path === "/github/install") return get ? redirect(installUrl(cfg)) : fail(405, "method not allowed");
  if (path === "/github/setup") {
    if (!get) return fail(405, "method not allowed");
    const nonce = randomBase62(22);
    return html(200, githubSetupPage(nonce, { slug: cfg.slug, canConnect: !!cfg.clientId }), nonce);
  }

  const c = accountContext(request, url, env, opts);
  if (!c) return path.startsWith("/api/") ? fail(503, "accounts unavailable") : null;
  const f: Fetch = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  if (path === "/github/connect") return get ? connectStart(c, cfg) : fail(405, "method not allowed");
  if (path === "/github/callback") return get ? connectCallback(c, cfg, f) : fail(405, "method not allowed");
  if (path === "/account/github" || path === "/api/account/github") {
    if (!get) return fail(405, "method not allowed");
    const a = await webSession(c);
    if (!a) return path.startsWith("/api/") ? fail(401, "not signed in") : redirect(`/login?next=${encodeURIComponent("/account/github")}`);
    const view = await accountView(c, cfg, a.account.id, a.account.email ?? (a.account.github_login ? `@${a.account.github_login}` : "Your account"));
    return path.startsWith("/api/") ? json(200, view) : page(200, (n) => accountGithubPage(n, view));
  }
  const repo = /^\/api\/account\/github\/repos\/(\d{1,15})$/.exec(path);
  if (repo) return m === "POST" ? updateRepo(c, Number(repo[1])) : fail(405, "method not allowed");
  if (path.startsWith("/api/")) return fail(404, "not found");
  return null;
}
