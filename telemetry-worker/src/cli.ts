// The routes the `genclass` command asks (packages/cli/src/api.mjs is the client). Checked before the account routes.
//
//   GET  /api/cli/overview              the account, its plan, its apps, what suggestions it has left today, and
//                                       for an account on Free the plan it can start (the command's plan step)
//   GET  /api/cli/github?repo=o/n       what genclass-dev[bot] is doing on one repository, from the account's own answer
//   POST /api/cli/suggest               the plan for the checks that failed on an app (src/suggest.ts)
//   GET  /api/cli/app?id=<app>&range=7d the app's dashboard as data: what the browser dashboard reads (`genclass dashboard`,
//                                       `analytics`, `problems`, `events`, `health`, `agent`, `report`, `fix`)
//
//   The rest is for a terminal approved from CLI_ACCOUNT_FROM on (the approval page lists each of them):
//   GET  /api/cli/account               the plan and its limits, the subscription's state, the team (`genclass plan`, `team`)
//   POST /api/cli/team/invite           a single-use invite link for the account's team, shown once
//   GET  /api/cli/connections?id=<app>  where the app's alerts are sent (forwarding), and whether it has a private link
//   PUT|PATCH|DELETE /api/cli/connections/<kind>?id=<app>      set up, turn on or off, remove one destination
//   POST /api/cli/connections/<kind>/test?id=<app>             one test record to it
//   GET  /api/cli/events?id=<app>&from&to&format&cursor&limit  the app's stored events (`genclass export`)
//   PUT  /api/cli/funnels?id=<app>      the app's funnels, whole (`genclass funnels`)
//   POST /api/cli/link?id=<app>         a new private dashboard link, for the coding agent's production numbers
//   POST /api/cli/ask                   a question about an app, answered by the model from its numbers (src/ask.ts)
//
// Invariants:
// - Every route needs a signed-in account: the CLI's session (a bearer token from `genclass login`) or, for the
//   first three GETs, the browser session. Every other route takes the CLI's session only, so no page can make a
//   signed-in browser spend an account's runs or change its settings through them.
// - /api/cli/github asks GitHub nothing. It reads the answer GitHub gave this account in the last 30 minutes
//   (Connect GitHub, or Continue with GitHub after installing: src/github/http.ts) and what the app keeps for a
//   repository that answer lists. Without such an answer it says `known: false` and where to continue. So an account
//   learns nothing about a repository GitHub did not just say it can reach.
// - /api/cli/app answers what the account's dashboard page reads (src/dashboard.ts stats), cut by the same plan rules
//   (the ranges a plan shows, visitor analytics left out without them), for an app the account owns or can read
//   through a team. A CLI session reads it only when it was approved after the approval page began to say so
//   (CLI_DASHBOARD_FROM): one approved under the older text ("It cannot read your apps' stats") is told to sign in
//   again, so nobody's terminal gained this without being asked.
// - The routes below the line work the same way with their own date (CLI_ACCOUNT_FROM): a terminal does them only
//   when the person approved it on a page that lists them (src/account-pages.ts, the scope list). Each one runs the
//   code the browser's own route runs (src/billing.ts integrationsFor and exportFor, src/auth.ts makeLinkFor,
//   src/dashboard.ts putFunnels, src/team.ts), so the owner check, the plan's rules and the limits are the same.
// - What a terminal never does, whatever it was approved for: change how the account signs in, pay or change the
//   plan, remove a member, turn a link's lock on or off, link a GitHub repository, or delete an app or the account.
// - /api/cli/suggest stores nothing of what it is sent or answers (src/suggest.ts), and neither does /api/cli/ask
//   (src/ask.ts). The plan's numbers decide how many model runs an account has a day (the two share them) and how
//   many items of a suggestions plan it is shown; the rest of the items come back as ids only, with where the plans are.

import { answer, appDigest, MAX_ASK_BYTES, readQuestion } from "./ask.js";
import { accountContext, accountJson, accountProjects, authenticate, fail, lockedJson, makeLinkFor, ownedProject, projectJson, readableProject, readJson, upgradeJson, type Auth, type C } from "./auth.js";
import { exportFor, integrationsFor, overBudget, tooMany } from "./billing.js";
import type { Env, HandleOptions } from "./collector.js";
import { putFunnels, stats, stripAnalytics } from "./dashboard.js";
import { isKind, KINDS } from "./forward.js";
import { githubApp } from "./github/config.js";
import { repoStatusForAccount } from "./github/http.js";
import { json } from "./http.js";
import { accountAccess, accountBilling, canBuy, entitled, firstPlanWith, FREE, hasAnalytics, hasDashboard, PAID_PLANS, pickRange, priceText, projectAccess, viewRanges, type Access } from "./plans.js";
import { askModel, byWeight, claimRun, hasModel, MAX_SUGGEST_BYTES, readDigest, suggestionLimits, usedToday, type PlanItem } from "./suggest.js";
import { createInvite, isTeamError, membershipsOf, teamOf } from "./team.js";

/** A repository's full name as GitHub writes one. */
const FULL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

async function overview(c: C): Promise<Response> {
  const a = await authenticate(c);
  if (!a) return fail(401, "not signed in");
  const access = await accountAccess(c.db, a.account.id, c.env, c.now);
  const lim = suggestionLimits(access.plan);
  const gh = githubApp(c.env);
  return json(200, {
    account: accountJson(a.account),
    plan: { id: access.plan.id, name: access.plan.name },
    suggestions: { per_day: lim.per_day, shown: lim.shown, used_today: await usedToday(c.db, a.account.id, c.now), model: hasModel(c.env) },
    projects: (await accountProjects(c, a.account.id)).map((p) => projectJson(c, p)),
    github: { app: gh !== null, install_url: gh ? `${c.cfg.origin}/github/install` : null, connect_url: gh?.clientId ? `${c.cfg.origin}/github/connect` : null },
    billing_url: `${c.cfg.origin}/account/billing`,
    offer: offerFor(c, a.account, access),
  });
}

/**
 * What an account on Free can start from the terminal (the genclass command's plan step): the first plan sold on
 * the site in its own words (billing/plans.json: name, price, the lines of its card), the address that opens its
 * checkout, and Free's limits in numbers. Null for an account that has a plan or a grant, on a server that sells
 * nothing, and for an account that cannot buy here (a test key and an account not on its list).
 */
function offerFor(c: C, account: { id: string; email: string | null }, access: Access): Record<string, unknown> | null {
  const plan = PAID_PLANS[0];
  if (!plan || access.plan.id !== FREE.id || access.source !== null || !canBuy(c.env, account)) return null;
  return {
    plan: { id: plan.id, name: plan.name },
    price: priceText(plan),
    summary: plan.summary,
    features: plan.features.filter((f) => f.available && !/^Everything in /i.test(f.text)).map((f) => f.text).slice(0, 12),
    checkout_url: `${c.cfg.origin}/account/billing?plan=${plan.id}&start=1`,
    free: { name: FREE.name, apps: FREE.limits.apps, history_days: FREE.limits.history_days, suggestions_shown: suggestionLimits(FREE).shown },
  };
}

async function github(c: C): Promise<Response> {
  const a = await authenticate(c);
  if (!a) return fail(401, "not signed in");
  const repo = c.url.searchParams.get("repo") ?? "";
  if (!FULL_NAME_RE.test(repo)) return fail(400, "repo must be owner/name");
  return json(200, await repoStatusForAccount(c, githubApp(c.env), a.account.id, repo));
}

/**
 * CLI sessions created from this time on were approved on a page that says the terminal can show the apps'
 * dashboards (account-pages.ts, the scope paragraph). The text went live with this route, before this time.
 */
export const CLI_DASHBOARD_FROM = "2026-11-12T10:00:00.000Z";
/** How many of the most recent findings the terminal gets: what the browser dashboard reads (`genclass events`). */
const APP_RECENT = 50;

async function app(c: C): Promise<Response> {
  const a = await authenticate(c);
  if (!a) return fail(401, "not signed in");
  if (a.via === "bearer") {
    const s = await c.db.prepare("SELECT created FROM auth_sessions WHERE id = ?").bind(a.sessionId).first<{ created: string }>();
    if (!s || s.created < CLI_DASHBOARD_FROM) return json(403, { ok: false, error: "this sign-in was approved before the command could show dashboards; sign in again: genclass login", reauth: true });
  }
  const p = await readableProject(c, a.account.id, c.url.searchParams.get("id") ?? "");
  if (!p) return fail(404, "not found");
  // the same plan rules as the dashboard page's own request (src/auth.ts, /api/account/projects/<id>/stats)
  const access = await projectAccess(c.db, p, c.env, c.now);
  if (!hasDashboard(access)) return lockedJson(c);
  const range = pickRange(c.url.searchParams.get("range"), viewRanges(access.plan));
  const s = await stats(c.db, p, range, c.now);
  const view = hasAnalytics(access) ? s : stripAnalytics(s, { plan: firstPlanWith("analytics")?.name ?? null, upgrade_url: `${c.cfg.origin}/account/billing` });
  return json(200, { ...view, recent: view.recent.slice(0, APP_RECENT), dashboard_url: projectJson(c, p).dashboard_url });
}

async function suggest(c: C): Promise<Response> {
  const a = await authenticate(c);
  if (!a) return fail(401, "not signed in");
  if (a.via !== "bearer") return fail(403, "this is for the genclass command: run genclass suggest");
  const body = await readJson(c, MAX_SUGGEST_BYTES);
  if (body instanceof Response) return body;
  const digest = readDigest(body);
  if (typeof digest === "string") return fail(400, digest);
  const access = await accountAccess(c.db, a.account.id, c.env, c.now);
  const lim = suggestionLimits(access.plan);

  // the model, when the server has one and the account has a run left today; the checks' own order otherwise
  let plan: PlanItem[] | null = null;
  let used: number | null = null;
  let limited = false;
  if (hasModel(c.env) && digest.checks.length) {
    used = await claimRun(c.db, a.account.id, c.now, lim.per_day);
    if (used === null) limited = (await usedToday(c.db, a.account.id, c.now)) >= lim.per_day;
    else plan = await askModel(c.env, c.opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i)), digest);
  }
  const source = plan ? "model" : "checks";
  const order: PlanItem[] = plan ?? byWeight(digest.checks).map((x) => ({ id: x.id, why: null, step: null, prompt: null }));
  const shown = lim.shown === null ? order.length : Math.min(order.length, lim.shown);
  const locked = order.slice(shown);
  return json(200, {
    ok: true,
    source,
    plan: { id: access.plan.id, name: access.plan.name },
    total: order.length,
    items: order.slice(0, shown),
    locked: locked.length,
    locked_ids: locked.map((x) => x.id),
    upgrade_url: locked.length || limited ? `${c.cfg.origin}/account/billing` : null,
    remaining_today: used === null ? Math.max(0, lim.per_day - (await usedToday(c.db, a.account.id, c.now))) : Math.max(0, lim.per_day - used),
    limited,
  });
}

// ------------------------------------------------------------------------- the routes a newer approval lists

/**
 * CLI sessions created from this time on were approved on a page that lists what the routes below do (the scope
 * list in src/account-pages.ts). That list went live at 2026-11-12T17:50:21Z (the deploy of 976a8744); this is a
 * few minutes after it. A route added later gets its own line on that page and its own time, set the same way:
 * deploy the page first, then a time that is not before that deploy, or a terminal approved under the older text
 * would gain the route.
 */
export const CLI_ACCOUNT_FROM = "2026-11-12T17:53:00.000Z";

const method = (): Response => fail(405, "method not allowed");

/** The CLI session behind a request to one of the newer routes, or the Response that says why not. */
async function terminal(c: C): Promise<Auth | Response> {
  const a = await authenticate(c);
  if (!a) return fail(401, "not signed in");
  if (a.via !== "bearer") return fail(403, "this is for the genclass command");
  const s = await c.db.prepare("SELECT created FROM auth_sessions WHERE id = ?").bind(a.sessionId).first<{ created: string }>();
  if (!s || s.created < CLI_ACCOUNT_FROM) return json(403, { ok: false, error: "this sign-in was approved before the command could do this; sign in again: genclass login", reauth: true });
  return a;
}

async function account(c: C): Promise<Response> {
  const a = await terminal(c);
  if (a instanceof Response) return a;
  const access = await accountAccess(c.db, a.account.id, c.env, c.now);
  const b = await accountBilling(c.db, a.account.id, c.env);
  const t = await teamOf(c.db, c.env, a.account.id, c.now);
  const memberships = await membershipsOf(c.db, c.env, a.account.id, c.now);
  const lim = suggestionLimits(access.plan);
  const apps = await accountProjects(c, a.account.id);
  return json(200, {
    account: accountJson(a.account),
    plan: { id: access.plan.id, name: access.plan.name, price: access.plan.id === FREE.id ? null : priceText(access.plan), summary: access.plan.summary },
    // why the account has its plan now: "paid", "comp" (GenClass's own grant), "open" (this server's PLAN_GATES), or null on Free
    access: access.source,
    limits: { apps: access.plan.limits.apps, history_days: access.plan.limits.history_days, seats: access.seats, suggestions_per_day: lim.per_day, suggestions_shown: lim.shown },
    used: { apps: apps.filter((p) => p.account_id === a.account.id).length, suggestions_today: await usedToday(c.db, a.account.id, c.now), seats: t.used },
    includes: { analytics: entitled(access.plan, "analytics"), forwarding: entitled(access.plan, "forwarding"), export: entitled(access.plan, "export"), private_repositories: entitled(access.plan, "github_private") },
    subscription: { status: b.subscription_status, current_period_end: b.current_period_end, cancel_at_period_end: !!b.cancel_at_period_end },
    team: {
      seats: t.seats,
      used: t.used,
      members: t.members.map((x) => ({ email: x.email, github_login: x.githubLogin, joined: x.joined, active: x.active })),
      invites: t.invites.map((x) => ({ created: x.created, expires: x.expires })),
      memberships: memberships.map((x) => ({ email: x.email, github_login: x.githubLogin, joined: x.joined, active: x.active })),
    },
    billing_url: `${c.cfg.origin}/account/billing`,
    offer: offerFor(c, a.account, access),
  });
}

async function invite(c: C): Promise<Response> {
  const a = await terminal(c);
  if (a instanceof Response) return a;
  if (await overBudget(c.env.AUTH_LIMIT, "team-invite", a.account.id)) return tooMany();
  const r = await createInvite(c.db, c.env, a.account.id, c.now);
  if (isTeamError(r)) {
    const url = `${c.cfg.origin}/account/billing`;
    return json(r.status, { ok: false, error: r.upgrade ? `${r.error}; see the plans at ${url}` : r.error, ...(r.upgrade ? { upgrade_url: url } : {}) });
  }
  return json(201, { ok: true, url: `${c.cfg.origin}/account/join/${r.code}`, expires: r.expires });
}

async function connections(c: C, f: Fetch, kind: string | null, test: boolean): Promise<Response> {
  const a = await terminal(c);
  if (a instanceof Response) return a;
  const id = c.url.searchParams.get("id") ?? "";
  if (kind !== null) return integrationsFor(c, f, a.account.id, id, kind, test);
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return method();
  const res = await integrationsFor(c, f, a.account.id, id, null, false);
  if (!res.ok) return res;
  const p = await ownedProject(c, a.account.id, id);
  const link = p ? await c.db.prepare("SELECT private_link FROM projects WHERE id = ?").bind(p.id).first<{ private_link: number | null }>() : null;
  return json(200, { ...((await res.json()) as Record<string, unknown>), kinds: KINDS, private_link: !!link?.private_link, upgrade_url: `${c.cfg.origin}/account/billing`, plan: firstPlanWith("forwarding")?.name ?? null });
}

async function events(c: C): Promise<Response> {
  const a = await terminal(c);
  if (a instanceof Response) return a;
  return exportFor(c, a.account.id, c.url.searchParams.get("id") ?? "");
}

async function funnels(c: C): Promise<Response> {
  const a = await terminal(c);
  if (a instanceof Response) return a;
  const p = await ownedProject(c, a.account.id, c.url.searchParams.get("id") ?? "");
  if (!p) return fail(404, "not found");
  // the same plan rules as the dashboard page's funnel editor (src/auth.ts)
  const access = await accountAccess(c.db, a.account.id, c.env, c.now);
  if (!hasDashboard(access)) return lockedJson(c);
  if (!hasAnalytics(access)) return upgradeJson(c, "funnels are part of visitor analytics", "analytics");
  return putFunnels(c.req, c.db, p.token);
}

async function link(c: C): Promise<Response> {
  const a = await terminal(c);
  if (a instanceof Response) return a;
  if (await overBudget(c.env.AUTH_LIMIT, "cli-link", a.account.id)) return tooMany();
  return makeLinkFor(c, a.account.id, c.url.searchParams.get("id") ?? "");
}

async function ask(c: C, f: Fetch): Promise<Response> {
  const a = await terminal(c);
  if (a instanceof Response) return a;
  const body = await readJson(c, MAX_ASK_BYTES);
  if (body instanceof Response) return body;
  const q = readQuestion(body);
  if (typeof q === "string") return fail(400, q);
  const p = await readableProject(c, a.account.id, typeof body.id === "string" ? body.id : "");
  if (!p) return fail(404, "not found");
  // the numbers the model gets are the ones this account's dashboard shows for the app: the same plan rules
  const access = await projectAccess(c.db, p, c.env, c.now);
  if (!hasDashboard(access)) return lockedJson(c);
  const mine = await accountAccess(c.db, a.account.id, c.env, c.now);
  const lim = suggestionLimits(mine.plan);
  const left = async (): Promise<number> => Math.max(0, lim.per_day - (await usedToday(c.db, a.account.id, c.now)));
  const none = async (why: "no-model" | "limit" | "failed"): Promise<Response> =>
    json(200, { ok: true, answer: null, why, remaining_today: await left(), per_day: lim.per_day, upgrade_url: why === "limit" ? `${c.cfg.origin}/account/billing` : null });
  if (!hasModel(c.env)) return none("no-model");
  const used = await claimRun(c.db, a.account.id, c.now, lim.per_day);
  if (used === null) return none((await usedToday(c.db, a.account.id, c.now)) >= lim.per_day ? "limit" : "no-model");
  const range = pickRange(typeof body.range === "string" ? body.range : null, viewRanges(access.plan));
  const s = await stats(c.db, p, range, c.now);
  const text = await answer(c.env, f, appDigest(s, hasAnalytics(access)), q);
  if (text === null) return none("failed");
  return json(200, { ok: true, answer: text, why: null, range: s.range, remaining_today: Math.max(0, lim.per_day - used), per_day: lim.per_day, upgrade_url: null });
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The `genclass` command's routes; null for any other path. */
export async function routeCli(request: Request, url: URL, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  if (!path.startsWith("/api/cli/")) return null;
  const c = accountContext(request, url, env, opts);
  if (!c) return fail(503, "accounts unavailable");
  const m = request.method;
  const get = m === "GET" || m === "HEAD";
  if (path === "/api/cli/overview") return get ? overview(c) : fail(405, "method not allowed");
  if (path === "/api/cli/github") return get ? github(c) : fail(405, "method not allowed");
  if (path === "/api/cli/suggest") return m === "POST" ? suggest(c) : fail(405, "method not allowed");
  if (path === "/api/cli/app") return get ? app(c) : fail(405, "method not allowed");
  const f: Fetch = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  if (path === "/api/cli/account") return get ? account(c) : method();
  if (path === "/api/cli/team/invite") return m === "POST" ? invite(c) : method();
  if (path === "/api/cli/connections") return connections(c, f, null, false);
  const conn = /^\/api\/cli\/connections\/([a-z]+)(\/test)?$/.exec(path);
  if (conn) return isKind(conn[1]!) ? connections(c, f, conn[1]!, !!conn[2]) : fail(404, "not found");
  if (path === "/api/cli/events") return get ? events(c) : method();
  if (path === "/api/cli/funnels") return m === "PUT" ? funnels(c) : method();
  if (path === "/api/cli/link") return m === "POST" ? link(c) : method();
  if (path === "/api/cli/ask") return m === "POST" ? ask(c, f) : method();
  return fail(404, "not found");
}
