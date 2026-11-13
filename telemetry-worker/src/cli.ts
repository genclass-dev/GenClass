// The routes the `genclass` command asks (packages/cli/src/api.mjs is the client). Checked before the account routes.
//
//   GET  /api/cli/overview              the account, its plan, its apps, what suggestions it has left today, and
//                                       for an account on Free the plan it can start (the command's plan step);
//                                       `cli`: whether the command works for it (it is Pro's) and where Pro starts
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
// - The genclass command is Pro's (the owner's call, 2026-11-13): a CLI session of an account with neither a plan
//   (paid, in its trial, or GenClass's grant) nor an active place in a team that has one gets 402 `needs_pro` from
//   every route but the overview and the account (cliPaid). Nothing is locked where nothing is sold to the account,
//   with PLAN_GATES open, or for a browser session: the website keeps Free.
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
import { exportFor, integrationsFor, overBudget, tooMany, trialFor } from "./billing.js";
import type { Env, HandleOptions } from "./collector.js";
import { putFunnels, stats, stripAnalytics, stripProblems } from "./dashboard.js";
import { isKind, KINDS } from "./forward.js";
import { githubApp } from "./github/config.js";
import { repoStatusForAccount } from "./github/http.js";
import { json } from "./http.js";
import { accountAccess, accountBilling, accountProjectsAccess, appsCovered, better, planParam, canBuy, entitled, firstPaidWith, firstPlanWith, FREE, hasAnalytics, hasAsk, hasDashboard, hasProblems, PAID_PLANS, pickRange, priceText, problemsLock, projectAccess, viewRanges, type Access } from "./plans.js";
import { liveFixUsage } from "./usage.js";
import { appKey, askModel, byWeight, claimRun, hasModel, keepAnswer, lastAnswer, MAX_SUGGEST_BYTES, readDigest, suggestionLimits, usedToday, type PlanItem, type SuggestAnswer } from "./suggest.js";
import { activeOwners, createInvite, isTeamError, membershipsOf, teamOf } from "./team.js";

/** A repository's full name as GitHub writes one. */
const FULL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

// ------------------------------------------------------------------------- the genclass command is Pro's

/**
 * The plan an account works under: the best of its own (paid, its trial, GenClass's grant) and those of the teams it
 * has an active place in. A member uses its team's plan for what the command gives it (suggestions a day and shown,
 * genclass ask, the plan it names), so a paying team's member is never told to buy Pro again. `team`: the plan is a
 * team's, not the account's own.
 */
export async function workingAccess(c: C, accountId: string): Promise<{ access: Access; team: boolean }> {
  const own = await accountAccess(c.db, accountId, c.env, c.now);
  let best = own;
  for (const owner of await activeOwners(c.db, c.env, accountId, c.now)) {
    const a = await accountAccess(c.db, owner, c.env, c.now);
    if (a.source !== null && better(best, a) === a && a !== best) best = a;
  }
  return { access: best, team: best !== own };
}

/**
 * Why the genclass command works for this session, or null when it does not (the owner's call, 2026-11-13: "let's
 * make the entire CLI paid"): "plan", the account's own plan (paid, in its trial, GenClass's grant); "team", an
 * active place in a team that has one; "open", nothing is sold to this session here (a browser session, no plan on
 * sale, no Stripe key, a test key and an account not on its list, PLAN_GATES open).
 */
async function cliVia(c: C, a: Auth): Promise<"plan" | "team" | "open" | null> {
  if (a.via !== "bearer" || !PAID_PLANS.length || !canBuy(c.env, a.account)) return "open";
  const w = await workingAccess(c, a.account.id);
  return w.access.source === null ? null : w.access.source === "open" ? "open" : w.team ? "team" : "plan";
}

/** The genclass command works for this session (cliVia). */
export async function cliPaid(c: C, a: Auth): Promise<boolean> {
  return (await cliVia(c, a)) !== null;
}

/**
 * What the command says about itself (`cli` in the overview and the account): `paid` with `via` (cliVia), and for
 * an account without Pro the plan, its price, the trial it has left and the page that opens its checkout at once (the
 * account's, so a new account with no app goes straight to Stripe).
 */
async function cliJson(c: C, a: Auth): Promise<{ paid: true; via: "plan" | "team" | "open" } | { paid: false; plan: string; price: string; trial_days: number | null; checkout_url: string }> {
  const via = await cliVia(c, a);
  if (via !== null) return { paid: true, via };
  const plan = PAID_PLANS[0]!;
  return { paid: false, plan: plan.name, price: priceText(plan), trial_days: (await trialFor(c.db, a.account.id, plan)) || null, checkout_url: `${c.cfg.origin}/account/billing?plan=${planParam(plan)}&start=1` };
}

/** The routes that are Pro's for a CLI session: all but the overview and the account. */
const PRO_ROUTE_RE = /^\/api\/cli\/(?:github|suggest|app|team\/invite|connections(?:\/[a-z]+(?:\/test)?)?|events|funnels|link|ask)$/;

async function overview(c: C): Promise<Response> {
  const a = await authenticate(c);
  if (!a) return fail(401, "not signed in");
  // a team's member works under the team's plan (workingAccess): its limits, its name, no offer of a second Pro
  const { access, team } = await workingAccess(c, a.account.id);
  const lim = suggestionLimits(access.plan);
  const gh = githubApp(c.env);
  return json(200, {
    account: accountJson(a.account),
    plan: { id: access.plan.id, name: access.plan.name, ...(team ? { via: "team" } : {}) },
    suggestions: { per_day: lim.per_day, shown: lim.shown, used_today: await usedToday(c.db, a.account.id, c.now), model: hasModel(c.env) },
    projects: await withPlans(c, a.account.id),
    github: { app: gh !== null, install_url: gh ? `${c.cfg.origin}/github/install` : null, connect_url: gh?.clientId ? `${c.cfg.origin}/github/connect` : null },
    billing_url: `${c.cfg.origin}/account/billing`,
    offer: await offerFor(c, a.account, access, await accountProjectsAccess(c.db, a.account.id, c.env, c.now)),
    cli: await cliJson(c, a),
  });
}

/**
 * The account's apps (its own and its teams'), each with its plan and the page where it is chosen (plans are per
 * project since billing/plans.json version 4): `plan` { id, name, source }, `needs_plan` for one past the projects
 * Free covers, `plan_url`. An app of a team the account is in carries no plan: its owner chooses it.
 */
async function withPlans(c: C, accountId: string): Promise<Record<string, unknown>[]> {
  const access = new Map((await accountProjectsAccess(c.db, accountId, c.env, c.now)).map((x) => [x.row.token, x.access]));
  const chosen = new Set(((await c.db.prepare("SELECT token FROM projects WHERE account_id = ? AND plan_chosen IS NOT NULL").bind(accountId).all<{ token: string }>()).results ?? []).map((r) => r.token));
  return (await accountProjects(c, accountId)).map((p) => {
    const j: Record<string, unknown> = { ...projectJson(c, p) };
    const a = p.account_id === accountId ? access.get(p.token) : undefined;
    if (a) Object.assign(j, { plan: { id: a.plan.id, name: a.plan.name, source: a.source }, needs_plan: !!a.locked, plan_chosen: chosen.has(p.token), plan_url: `${c.cfg.origin}/account/billing?project=${encodeURIComponent(p.id ?? "")}` });
    return j;
  });
}

/**
 * What an account on Free can start from the terminal (the genclass command's plan step): the first plan sold on
 * the site in its own words (billing/plans.json: name, price, the lines of its card), the address that opens its
 * checkout, and Free's limits in numbers. Null for an account that has a plan or a grant, on a server that sells
 * nothing, and for an account that cannot buy here (a test key and an account not on its list).
 */
async function offerFor(c: C, account: { id: string; email: string | null }, access: Access, projects?: { row: { id?: string | null }; access: Access }[]): Promise<Record<string, unknown> | null> {
  const plan = PAID_PLANS[0];
  if (!plan || !canBuy(c.env, account)) return null;
  // a plan sold per project is offered while one of the account's apps is on Free, and only once it has one (the
  // command asks right after the app is in the account); one sold for the whole account, while the account is on Free
  const open = (projects ?? []).filter((x) => x.row.id && x.access.plan.id === FREE.id && x.access.source === null);
  if (plan.per_project === true && projects ? !open.length : access.plan.id !== FREE.id || access.source !== null) return null;
  // the page of the account's first app with no plan: Pro is bought there, for the account (version 5)
  const one = open.length ? open[0]!.row.id! : null;
  const trialDays = (await trialFor(c.db, account.id, plan)) || null;
  return {
    plan: { id: plan.id, name: plan.name },
    price: priceText(plan),
    summary: plan.summary,
    // the plan's own "N days free" line only while the account still has the trial
    features: plan.features.filter((f) => f.available && !/^Everything in /i.test(f.text) && (trialDays || !/days free/i.test(f.text))).map((f) => f.text).slice(0, 12),
    checkout_url: one ? `${c.cfg.origin}/account/billing?project=${encodeURIComponent(one)}&from=cli` : `${c.cfg.origin}/account/billing?plan=${planParam(plan)}&start=1`,
    trial_days: trialDays,
    // a plan sold by units of apps (a design never sold): always null, kept because the genclass command reads it
    apps_per_unit: null,
    free: { name: FREE.name, apps: FREE.limits.apps, history_days: FREE.limits.history_days, suggestions_shown: suggestionLimits(FREE).shown, live_fixes: FREE.limits.live_fixes_per_month ?? null },
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
  if (!hasDashboard(access)) return lockedJson(c, access, p.id);
  const range = pickRange(c.url.searchParams.get("range"), viewRanges(access.plan));
  const s = await stats(c.db, p, range, c.now);
  const planUrl = `${c.cfg.origin}/account/billing?project=${encodeURIComponent(p.id ?? "")}`;
  const seen = hasAnalytics(access) ? s : stripAnalytics(s, { plan: firstPlanWith("analytics")?.name ?? null, upgrade_url: `${c.cfg.origin}/account/billing` });
  // Free sees the totals only: the problems, pages, activity and fix prompts come with Pro (the browser's rule too)
  const view = hasProblems(access) ? seen : stripProblems(seen, problemsLock(planUrl));
  const usage = await liveFixUsage(c.db, p.token, access.plan, c.now).catch(() => null);
  return json(200, { ...view, recent: view.recent.slice(0, APP_RECENT), dashboard_url: projectJson(c, p).dashboard_url, usage, plan: { id: access.plan.id, name: access.plan.name, source: access.source }, plan_url: `${c.cfg.origin}/account/billing?project=${encodeURIComponent(p.id ?? "")}` });
}

async function suggest(c: C): Promise<Response> {
  const a = await authenticate(c);
  if (!a) return fail(401, "not signed in");
  if (a.via !== "bearer") return fail(403, "this is for the genclass command: run genclass suggest");
  const body = await readJson(c, MAX_SUGGEST_BYTES);
  if (body instanceof Response) return body;
  const digest = readDigest(body);
  if (typeof digest === "string") return fail(400, digest);
  // a team's member gets its team's plan (workingAccess)
  const { access } = await workingAccess(c, a.account.id);
  const lim = suggestionLimits(access.plan);
  // Free (a plan that shows part of the answer) is shown the answer it got the first time for this app, again, until
  // the account pays (the owner's call, 2026-11-12): no new model run, the same first item and the same counts
  const partial = lim.shown !== null;
  const key = await appKey(digest);
  const kept = partial ? await lastAnswer(c.db, a.account.id, key) : null;

  let answer: (SuggestAnswer & { created?: string }) | null = kept;
  let created: string | null = kept?.created ?? null;
  let used: number | null = null;
  let limited = false;
  if (!answer && hasModel(c.env) && (digest.checks.length || digest.app.site || digest.app.about)) {
    used = await claimRun(c.db, a.account.id, c.now, lim.per_day);
    if (used === null) {
      limited = (await usedToday(c.db, a.account.id, c.now)) >= lim.per_day;
      // the day's runs are used up: the last answer kept for this app, if there is one
      answer = await lastAnswer(c.db, a.account.id, key);
      created = answer?.created ?? null;
    } else {
      answer = await askModel(c.env, c.opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i)), digest);
      if (answer) await keepAnswer(c.db, a.account.id, key, answer, c.now);
    }
  }
  const source = answer?.source ?? "checks";
  const order: PlanItem[] = answer?.items.length ? answer.items : byWeight(digest.checks).map((x) => ({ id: x.id, why: null, step: null, prompt: null }));
  const ideas = answer?.ideas ?? [];
  const designs = answer?.designs ?? [];
  const shown = lim.shown === null ? order.length : Math.min(order.length, lim.shown);
  const locked = order.slice(shown);
  // what Free does not see is counted, never sent: the ideas and designs come back as numbers only
  const hidden = partial ? ideas.length + designs.length : 0;
  const pro = firstPaidWith("problems");
  return json(200, {
    ok: true,
    source,
    plan: { id: access.plan.id, name: access.plan.name },
    total: order.length,
    items: order.slice(0, shown),
    locked: locked.length,
    locked_ids: locked.map((x) => x.id),
    ideas: partial ? [] : ideas,
    designs: partial ? [] : designs,
    ideas_locked: partial ? ideas.length : 0,
    designs_locked: partial ? designs.length : 0,
    // the answer was kept from an earlier run (Free sees it again; a plan out of runs for the day sees its last)
    cached_at: created,
    upgrade_url: locked.length || hidden || limited ? `${c.cfg.origin}/account/billing?plan=${planParam(pro ?? PAID_PLANS[0]!)}&from=cli` : null,
    upgrade_plan: pro ? { name: pro.name, price: priceText(pro), trial_days: pro.trial_days ?? null } : null,
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
  // `plan` is the account's own (what it pays for); a member works under its team's (team_plan), suggestions included
  const work = await workingAccess(c, a.account.id);
  const lim = suggestionLimits(work.access.plan);
  const apps = await accountProjects(c, a.account.id);
  return json(200, {
    account: accountJson(a.account),
    plan: { id: access.plan.id, name: access.plan.name, price: access.plan.id === FREE.id ? null : priceText(access.plan), summary: access.plan.summary },
    // why the account has its plan now: "paid", "comp" (GenClass's own grant), "open" (this server's PLAN_GATES), or null on Free
    access: access.source,
    // the plan the account works under through a team when it is better than its own (workingAccess), else null
    team_plan: work.team ? { id: work.access.plan.id, name: work.access.plan.name } : null,
    // the apps the account's plan covers (coverage): no limit for a grant, Pro's 3 or the apps kept from before version 5
    limits: { apps: await appsCovered(c.db, a.account.id, c.env, c.now), history_days: access.plan.limits.history_days, seats: access.seats, suggestions_per_day: lim.per_day, suggestions_shown: lim.shown },
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
    offer: await offerFor(c, a.account, work.access, await accountProjectsAccess(c.db, a.account.id, c.env, c.now)),
    cli: await cliJson(c, a),
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
  const access = await projectAccess(c.db, p, c.env, c.now);
  if (!hasDashboard(access)) return lockedJson(c, access, p.id);
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
  if (!hasDashboard(access)) return lockedJson(c, access, p.id);
  // asking about the app comes with Pro (plans.json entitlement `ask`): Free is told which plan, and where
  if (!hasAsk(access)) {
    const lock = problemsLock(`${c.cfg.origin}/account/billing?project=${encodeURIComponent(p.id ?? "")}`);
    return json(403, { ok: false, error: `asking about your app comes with ${lock.plan ?? "a paid plan"}`, locked: true, needs_plan: true, plan: lock.plan, upgrade_url: lock.upgrade_url, trial_days: lock.trial_days, price: lock.price });
  }
  // the runs a day are the asker's, under the plan it works under (its team's for a member: workingAccess)
  const mine = (await workingAccess(c, a.account.id)).access;
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
  // every other route is Pro's for a CLI session (cliPaid); the account's stays open, to say where Pro starts
  if (PRO_ROUTE_RE.test(path)) {
    const who = await authenticate(c);
    if (who) {
      const cli = await cliJson(c, who);
      if (!cli.paid) return json(402, { ok: false, error: `the genclass command comes with ${cli.plan}${cli.trial_days ? `, ${cli.trial_days} days free` : ""}: ${cli.checkout_url}`, needs_pro: true, ...cli });
    }
  }
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
