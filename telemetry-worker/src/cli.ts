// The routes the `genclass` command asks (packages/cli/src/api.mjs is the client). Checked before the account routes.
//
//   GET  /api/cli/overview              the account, its plan, its apps, what suggestions it has left today
//   GET  /api/cli/github?repo=o/n       what genclass-dev[bot] is doing on one repository, from the account's own answer
//   POST /api/cli/suggest               the plan for the checks that failed on an app (src/suggest.ts)
//   GET  /api/cli/app?id=<app>&range=7d the app's dashboard as data: what the browser dashboard reads (`genclass dashboard`)
//
// Invariants:
// - Every route needs a signed-in account: the CLI's session (a bearer token from `genclass login`) or, for the two
//   GETs, the browser session. The POST takes the CLI's session only, so no page can make a signed-in browser spend
//   an account's runs.
// - /api/cli/github asks GitHub nothing. It reads the answer GitHub gave this account in the last 30 minutes
//   (Connect GitHub, or Continue with GitHub after installing: src/github/http.ts) and what the app keeps for a
//   repository that answer lists. Without such an answer it says `known: false` and where to continue. So an account
//   learns nothing about a repository GitHub did not just say it can reach.
// - /api/cli/app answers what the account's dashboard page reads (src/dashboard.ts stats), cut by the same plan rules
//   (the ranges a plan shows, visitor analytics left out without them), for an app the account owns or can read
//   through a team. A CLI session reads it only when it was approved after the approval page began to say so
//   (CLI_DASHBOARD_FROM): one approved under the older text ("It cannot read your apps' stats") is told to sign in
//   again, so nobody's terminal gained this without being asked. The other stats and export routes stay as they were.
// - /api/cli/suggest stores nothing of what it is sent or answers (src/suggest.ts). The plan's numbers decide two
//   things: how many model runs an account has a day, and how many items of the plan it is shown; the rest of the
//   items come back as ids only, in order, with where the plans are.

import { accountContext, accountJson, accountProjects, authenticate, fail, lockedJson, projectJson, readableProject, readJson, type C } from "./auth.js";
import type { Env, HandleOptions } from "./collector.js";
import { stats, stripAnalytics } from "./dashboard.js";
import { githubApp } from "./github/config.js";
import { repoStatusForAccount } from "./github/http.js";
import { json } from "./http.js";
import { accountAccess, firstPlanWith, hasAnalytics, hasDashboard, pickRange, projectAccess, viewRanges } from "./plans.js";
import { askModel, byWeight, claimRun, hasModel, MAX_SUGGEST_BYTES, readDigest, suggestionLimits, usedToday, type PlanItem } from "./suggest.js";

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
  });
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
/** How many of the most recent findings the terminal view gets (the browser dashboard reads 50). */
const APP_RECENT = 20;

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
  return fail(404, "not found");
}
