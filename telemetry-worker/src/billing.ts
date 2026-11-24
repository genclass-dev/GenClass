// Routes for the paid plans. Checked before the account routes (src/auth.ts); null for any other path.
//
//   POST /api/billing/checkout {plan: "<id>", seats?, next?}  browser session + Origin; {url} of Stripe Checkout (with
//                                                       switch: true when it replaces the plan already paid); `seats`
//                                                       (1 to 200, default 1) for a plan sold per seat (Team); `next`
//                                                       (/scan?url=..., scanNext): Stripe and the plan page return there
//   GET  /api/billing/pro                              browser session or the genclass command's token; {pro, via,
//                                                       trial_days}: what the page check asks before showing a report
//   POST /api/billing/trial                            410: the trial of 2026-10 is gone; Pro's trial starts at Checkout
//   POST /api/billing/portal                           browser session + Origin; {url} of the Billing Portal
//   POST /api/billing/webhook                          Stripe only: signature, no session (src/stripe.ts)
//   GET  /api/billing/cancel[?project=<id>]            browser session; what cancelling means for the plan (the
//                                                       account's, or one app's own): {plan, trial, ends, offer}
//   POST /api/billing/cancel/offer {project_id?}       browser session + Origin; takes the offer to stay (15% off for
//                                                       6 months, once per customer; src/stripe.ts retentionOffer)
//   POST /api/billing/cancel {project_id?}             browser session + Origin; the plan ends that day, trial or
//                                                       paid; refunded within 3 days of a renewal
//   POST /api/billing/resume {project_id?}             browser session + Origin; a plan set to end goes on
//   GET  /api/billing                                  browser session; the plan and the subscription
//   GET  /account/billing                              the plan page (src/billing-pages.ts); ?next=/scan?url=... goes
//                                                       back to that report after the checkout (straight away with Pro)
//   GET  /account/trial                                to the account page (genclass.dev's pricing page linked
//                                                       here until 2026-10-19), through sign-up when signed out
//   GET|PUT|PATCH|DELETE /api/account/projects/<id>/integrations[/<kind>]   forwarding destinations (plans with
//                                                       forwarding: Team and Enterprise; else a 403 with upgrade_url)
//   POST /api/account/projects/<id>/integrations/<kind>/test               one test record to that destination
//   GET  /api/account/projects/<id>/events?from&to&format&cursor&limit      export (plans with export: Team and
//                                                       Enterprise; else a 403 with upgrade_url): an export key as a
//                                                       bearer token, or the browser session
//   GET|POST /api/account/export-keys, DELETE /api/account/export-keys/<id> export keys (browser session)
//
// A command line session (the CLI's bearer token) is refused on every route here: paying belongs to the browser, and
// what a terminal may read or change it does through its own routes (src/cli.ts), which check that the terminal was
// approved for it and then use the same code as these (integrationsFor, exportFor). The routes that call Stripe or send to another
// server (checkout, portal, Send test, new export keys) take AUTH_LIMIT's budget per account, and the export
// EXPORT_LIMIT's.

import { accountContext, accountProjects, authenticate, csrfFail, fail, originOk, ownedProject, page, readJson, redirect, safeNext, webSession, type Auth, type C } from "./auth.js";
import { billingPage, projectPlanPage } from "./billing-pages.js";
import { liveFixUsage } from "./usage.js";
import type { Env, HandleOptions, RateLimiterLike } from "./collector.js";
import { randomBase62, sha256Hex, type D1Like, type Project } from "./dashboard.js";
import { decodeCursor, exportResponse, PAGE_MAX, parseTime } from "./export.js";
import { checkConfig, claimTestSend, deliver, integrationRows, integrationsKey, isKind, maskConfig, openConfig, sealConfig, testRecord, type Kind } from "./forward.js";
import { json, readCapped } from "./http.js";
import { forgetOwner } from "./paid.js";
import {
  accountAccess,
  accountBilling,
  accountPlan,
  canBuy,
  cleanSeats,
  countryOf,
  entitled,
  MAX_SEATS,
  FREE,
  PAID_PLANS,
  PLANS,
  PLANS_FILE,
  planById,
  planFromParam,
  planParam,
  projectAccess,
  accountProjectsAccess,
  stripeMode,
  type Entitlement,
  type Plan,
} from "./plans.js";
import {
  applyRetention,
  cancelNow,
  cancelRefundDue,
  checkCustomer,
  checkoutSession,
  ensureCustomer,
  foreignInvoice,
  HOLDING_STATUSES,
  isGenClassSubscription,
  projectOf,
  managedPayments,
  missingCustomer,
  modeNote,
  notifyOwner,
  openTrialElsewhere,
  portalSession,
  refreshSubscription,
  money,
  refundOnCancel,
  resumeSubscription,
  retentionOffer,
  sharedCustomer,
  StripeError,
  stripeWebhook,
  subscriptionState,
} from "./stripe.js";
import { activeOwners, membershipsOf, teamOf } from "./team.js";
import { b64url } from "./webauthn.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const EXPORT_KEY_RE = /^gce_[A-Za-z0-9_-]{43}$/;
const MAX_EXPORT_KEYS = 10;
const DAY = 86_400_000;

const method = (): Response => fail(405, "method not allowed");

/** A `next` that Pro's checkout may come back to: the page check only (/scan, /scan?url=...), as safeNext allows it. */
export function scanNext(v: string | null | undefined): string | null {
  const n = safeNext(v);
  return n && /^\/scan(\?|$)/.test(n) ? n : null;
}

/**
 * How the account has Pro: "plan" (its own plan, its trial, GenClass's grant), "team" (an active place in a team that
 * has one), "open" (nothing is sold to it here: no paid plan, no Stripe key, a test key and an account not on its
 * list, PLAN_GATES open), or null (Free). The same answer as the genclass command's (cli.ts cliVia), for both kinds
 * of sign-in.
 */
export async function proVia(c: C, account: Auth["account"]): Promise<"plan" | "team" | "open" | null> {
  if (!PAID_PLANS.length || !canBuy(c.env, account)) return "open";
  const own = await accountAccess(c.db, account.id, c.env, c.now);
  if (own.source === "open") return "open";
  if (own.source !== null) return "plan";
  for (const owner of await activeOwners(c.db, c.env, account.id, c.now)) if ((await accountAccess(c.db, owner, c.env, c.now)).source !== null) return "team";
  return null;
}

/**
 * GET /api/billing/pro: whether the signed-in account has Pro (proVia), for a browser session or the genclass
 * command's token, and the days free its first Pro would start with (null with Pro or with none left). The page check
 * (genclass-scan, over its ACCOUNTS service binding) asks it for each report it shows, to decide what is locked.
 */
async function proAnswer(c: C): Promise<Response> {
  const a = await authenticate(c);
  if (!a) return fail(401, "not signed in");
  const via = await proVia(c, a.account);
  const plan = PAID_PLANS[0];
  return json(200, { ok: true, pro: via !== null, via, trial_days: via === null && plan ? (await trialFor(c.db, a.account.id, plan)) || null : null });
}
/** The 403 for something the account's plan leaves out, naming the plans that include it. */
const upgrade = (c: C, what: Entitlement): Response => {
  const plans = PLANS.filter((p) => entitled(p, what)).map((p) => p.name);
  // "Pro and Enterprise", "Pro, Business and Enterprise"
  const names = plans.length > 1 ? `${plans.slice(0, -1).join(", ")} and ${plans[plans.length - 1]}` : plans[0];
  const has = plans.length ? `is part of the ${names} plan${plans.length > 1 ? "s" : ""}` : "is not part of any plan";
  return json(403, { ok: false, error: `${what} ${has}; see ${c.cfg.origin}/account/billing`, upgrade_url: `${c.cfg.origin}/account/billing` });
};

function stripeFail(e: unknown): Response {
  if (e instanceof StripeError) return fail(e.status === 503 ? 503 : e.status === 409 ? 409 : 502, `Stripe: ${e.message}`);
  throw e;
}

/** True when this account is over its per-minute budget for `bucket` (keyed by a hash of bucket + account id). */
export async function overBudget(lim: RateLimiterLike | undefined, bucket: string, accountId: string): Promise<boolean> {
  if (!lim) return false;
  try {
    return !(await lim.limit({ key: (await sha256Hex(`billing:${bucket}:${accountId}`)).slice(0, 32) })).success;
  } catch {
    return false; // the limiter is best effort
  }
}
export const tooMany = (): Response => fail(429, "too many requests from this account; try again in a minute", { "retry-after": "60" });

/** The plan a link names (?plan=<id>, from the pricing page), if it is a paid plan. */
const pickedPlan = (v: string | null): Plan | null => planFromParam(v);

/** A browser-only write: a cookie session with our Origin. */
export async function browserWrite(c: C, what: string): Promise<Auth | Response> {
  const a = await authenticate(c);
  if (!a) return fail(401, "not signed in");
  if (a.via !== "cookie") return fail(403, `${what} only in the browser, on genclass.dev`);
  if (!originOk(c)) return csrfFail();
  return a;
}

export async function browserRead(c: C): Promise<Auth | Response> {
  const a = await authenticate(c);
  if (!a) return fail(401, "not signed in");
  if (a.via !== "cookie") return fail(403, "only in the browser, on genclass.dev");
  return a;
}

export async function routeBilling(request: Request, url: URL, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  const integ = /^\/api\/account\/projects\/([^/]+)\/integrations(?:\/([^/]+)(\/test)?)?$/.exec(path);
  const events = /^\/api\/account\/projects\/([^/]+)\/events$/.exec(path);
  const keys = /^\/api\/account\/export-keys(?:\/([^/]+))?$/.exec(path);
  const billing = path === "/api/billing" || path.startsWith("/api/billing/") || path === "/account/billing" || path === "/account/trial";
  if (!integ && !events && !keys && !billing) return null;
  const c = accountContext(request, url, env, opts);
  if (!c) return null; // the account routes answer "unavailable"
  const f: Fetch = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const m = request.method;
  const get = m === "GET" || m === "HEAD";

  switch (path) {
    case "/api/billing/webhook": {
      if (m !== "POST") return method();
      const raw = await readCapped(request, 512 * 1024);
      if (raw === null) return fail(413, "body too large");
      return stripeWebhook({ env, db: c.db, fetch: f, now: c.now }, raw, request.headers.get("stripe-signature"));
    }
    case "/api/billing/checkout":
      return m === "POST" ? checkout(c, f) : method();
    case "/api/billing/portal":
      return m === "POST" ? portal(c, f) : method();
    case "/api/billing/cancel":
      return get ? cancelInfo(c, f, url.searchParams.get("project")) : m === "POST" ? cancelPlan(c, f) : method();
    case "/api/billing/cancel/offer":
      return m === "POST" ? cancelOffer(c, f) : method();
    case "/api/billing/resume":
      return m === "POST" ? resumePlan(c, f) : method();
    case "/api/billing/pro":
      return get ? proAnswer(c) : method();
    case "/api/billing/trial":
      return m === "POST" ? fail(410, `a trial starts at Checkout, on an app's plan page: ${c.cfg.origin}/account/billing`) : method();
    case "/account/trial":
      // genclass.dev's pricing page linked here until 2026-10-19 (bookmarks, caches): the account page
      return get ? redirect((await webSession(c)) ? "/account" : `/signup?next=${encodeURIComponent("/account")}`) : method();
    case "/api/billing": {
      if (!get) return method();
      const a = await browserRead(c);
      if (a instanceof Response) return a;
      const b = await accountBilling(c.db, a.account.id, env);
      const access = await accountAccess(c.db, a.account.id, env, c.now);
      // one project's plan (?project=<id>): its page waits for its payment with this
      const pid = url.searchParams.get("project");
      if (pid) {
        const p = await ownedProject(c, a.account.id, pid);
        if (!p) return fail(404, "not found");
        const pa = await projectAccess(c.db, p, env, c.now);
        return json(200, { project: { id: p.id, plan: pa.plan.id, source: pa.source, locked: pa.locked ?? null } });
      }
      return json(200, {
        plan: planById(b.plan).id,
        subscription_status: b.subscription_status,
        current_period_end: b.current_period_end,
        cancel_at_period_end: !!b.cancel_at_period_end,
        on_sale: PAID_PLANS.length > 0 && canBuy(env, a.account),
        // why the account has its plan now: "paid", "comp" (GenClass's own grant), "open" (this server's PLAN_GATES), or null on Free
        access: access.source,
        // the people the account holds now, the owner included (null: no limit)
        seats: access.seats,
      });
    }
    case "/account/billing": {
      if (!get) return method();
      // one project's plan page (?project=<id>): what the genclass command opens when it adds a project
      const pid = url.searchParams.get("project");
      if (pid) {
        const start = url.searchParams.get("start") === "1";
        const fromCli = url.searchParams.get("from") === "cli";
        const isNew = url.searchParams.get("new") === "1";
        const a = await webSession(c);
        if (!a) return redirect(`/login?next=${encodeURIComponent(`/account/billing?project=${encodeURIComponent(pid)}${start ? "&start=1" : ""}${fromCli ? "&from=cli" : ""}${isNew ? "&new=1" : ""}`)}`);
        const p = await ownedProject(c, a.account.id, pid);
        if (!p || !p.id) return redirect("/account/billing#projects");
        const access = await projectAccess(c.db, p, env, c.now);
        const row = await c.db.prepare("SELECT subscription_status, current_period_end, cancel_at_period_end, plan_chosen FROM projects WHERE id = ?").bind(p.id).first<{ subscription_status: string | null; current_period_end: string | null; cancel_at_period_end: number | null; plan_chosen: string | null }>();
        const apps = (await accountProjects(c, a.account.id)).map((x) => ({ id: x.id!, name: x.name }));
        const usage = await liveFixUsage(c.db, p.token, access.plan, c.now).catch(() => null);
        const trialDays = PAID_PLANS[0] && access.source === null ? await trialFor(c.db, a.account.id, PAID_PLANS[0]) : 0;
        return page(200, (n) =>
          projectPlanPage(n, {
            account: { id: a.account.id, email: a.account.email, githubLogin: a.account.github_login },
            apps,
            project: { id: p.id!, name: p.name },
            access,
            sub: { status: row?.subscription_status ?? null, periodEnd: row?.current_period_end ?? null, cancels: !!row?.cancel_at_period_end },
            usage,
            trialDays,
            live: canBuy(env, a.account),
            testMode: stripeMode(env) === "test",
            country: countryOf(c.req),
            done: url.searchParams.get("done") === "1",
            go: start,
            fromCli,
            isNew,
            chosen: !!row?.plan_chosen,
            now: c.now,
          }),
        );
      }
      const picked = pickedPlan(url.searchParams.get("plan"));
      // ?start=1 with a plan: the person chose it a moment ago (in the genclass command's plan step), so the page
      // opens that plan's checkout itself instead of waiting for one more click
      const go = !!picked && url.searchParams.get("start") === "1";
      // ?next=/scan?url=...: started from a page check's "Start 3 days free"; Stripe and this page send the person back
      const next = scanNext(url.searchParams.get("next"));
      const a = await webSession(c);
      // the plan picked on the pricing page (and where to go after) survives the sign-in
      if (!a) return redirect(`/login?next=${encodeURIComponent(`/account/billing${picked ? `?plan=${planParam(picked)}${go ? "&start=1" : ""}${next ? `&next=${encodeURIComponent(next)}` : ""}` : ""}`)}`);
      // already on Pro (its own, a grant, a team's seat): no second checkout, straight back to the report
      if (next && (await proVia(c, a.account)) !== null) return redirect(next);
      // a plan sold per project, picked on the pricing page or started from an older genclass command: the plan page
      // of the account's first app still on Free, where it is bought for that app
      if (picked?.per_project === true) {
        const open = (await accountProjectsAccess(c.db, a.account.id, env, c.now)).find((x) => x.row.id && x.access.plan.id === FREE.id && x.access.source === null && !x.access.locked)
          ?? (await accountProjectsAccess(c.db, a.account.id, env, c.now)).find((x) => x.row.id && x.access.locked);
        if (open) return redirect(`/account/billing?project=${encodeURIComponent(open.row.id!)}${go ? "&from=cli" : ""}`);
        // no app yet (the pricing page's trial button, from a new account): make one first; its plan page follows
        if (go && !(await accountProjects(c, a.account.id)).some((x) => x.account_id === a.account.id)) return redirect("/account/new");
      }
      const access = await accountAccess(c.db, a.account.id, env, c.now);
      const apps = (await accountProjects(c, a.account.id)).map((p) => ({ id: p.id!, name: p.name }));
      const b = await accountBilling(c.db, a.account.id, env);
      const team = await teamOf(c.db, env, a.account.id, c.now);
      const memberships = await membershipsOf(c.db, env, a.account.id, c.now);
      const names = new Map((await accountProjects(c, a.account.id)).filter((x) => x.account_id === a.account.id).map((x) => [x.token, x.name]));
      const projects = (await accountProjectsAccess(c.db, a.account.id, env, c.now)).filter((x) => names.has(x.row.token)).map((x) => ({ id: x.row.id!, name: names.get(x.row.token)!, access: x.access }));
      return page(200, (n) =>
        billingPage(n, {
          projects,
          team,
          memberships,
          account: { id: a.account.id, email: a.account.email, githubLogin: a.account.github_login },
          apps,
          billing: b,
          access,
          live: canBuy(env, a.account),
          testMode: stripeMode(env) === "test",
            country: countryOf(c.req),
          done: url.searchParams.get("done") === "1",
          picked: picked?.id ?? null,
          go,
          next,
          switchTo: pickedPlan(url.searchParams.get("to"))?.id ?? null,
          managedPlans: PAID_PLANS.filter((p) => managedPayments(env, p)).map((p) => p.name),
          now: c.now,
        }),
      );
    }
  }
  const free = /^\/api\/billing\/projects\/([^/]+)\/free$/.exec(path);
  if (free) return m === "POST" ? chooseFree(c, f, free[1]!) : method();
  const keep = /^\/api\/billing\/projects\/([^/]+)\/continue$/.exec(path);
  if (keep) return m === "POST" ? continueWith(c, keep[1]!) : method();
  if (integ) return integrations(c, f, integ[1]!, integ[2] ?? null, !!integ[3]);
  if (events) return exportEvents(c, events[1]!);
  if (keys) return exportKeys(c, keys[1] ?? null);
  return fail(404, "not found");
}

// --------------------------------------------------------------------------------------------- Checkout, portal

/**
 * POST /api/billing/projects/<id>/continue: an app the account's plan covers goes on with it (the plan page's
 * "Continue with Pro", the owner's call 2026-11-13: every new app sees the paywall, a paying account clicks through).
 * It writes when (projects.plan_chosen), which the genclass command and the app's page wait for. 409 when the plan
 * does not cover the app (it needs Pro, or more apps on Pro).
 */
async function continueWith(c: C, id: string): Promise<Response> {
  const a = await browserWrite(c, "a plan is chosen");
  if (a instanceof Response) return a;
  const p = await ownedProject(c, a.account.id, id);
  if (!p || !p.id) return fail(404, "not found");
  const access = await projectAccess(c.db, p, c.env, c.now);
  if (!access.source || access.locked) return fail(409, `${p.name} needs a plan first`);
  await c.db.prepare("UPDATE projects SET plan_chosen = ? WHERE id = ? AND account_id = ? AND plan_chosen IS NULL").bind(c.now.toISOString(), p.id, a.account.id).run();
  return json(200, { ok: true, plan: access.plan.id });
}

/** What can stop someone from paying, as the plan page's popup lists them: [value, the words shown]. */
export const FREE_REASONS: readonly (readonly [string, string])[] = [
  ["price", "It costs too much"],
  ["trying", "I'm only trying GenClass out"],
  ["approval", "I need to ask my team or my boss"],
  ["feature", "It's missing something I need"],
  ["unsure", "I'm not sure it works for my app yet"],
  ["other", "Something else"],
];
const NOTE_MAX = 500;

/**
 * POST /api/billing/projects/<id>/free { reason, note? }: Free chosen for one app, on its plan page, with what is
 * stopping the person from paying (the popup behind "Try for free (limited)"; the owner's call, 2026-11-12: nobody
 * goes on with Free without saying why). The reason is one of FREE_REASONS; the note is optional, at most 500
 * characters. It keeps the answer (plan_feedback), writes when (projects.plan_chosen), which the genclass command's
 * plan step and the app's page wait for, and tells the owner (NOTIFY_WEBHOOK). The app is on Free either way. An app
 * past the ones Free covers has only the paid plan (409).
 */
async function chooseFree(c: C, f: Fetch, id: string): Promise<Response> {
  const a = await browserWrite(c, "a plan is chosen");
  if (a instanceof Response) return a;
  const body = await readJson(c, 4096);
  if (body instanceof Response) return body;
  const reason = FREE_REASONS.find(([v]) => v === body.reason);
  if (!reason) return fail(400, "choose what is stopping you from paying");
  const note = typeof body.note === "string" ? body.note.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, NOTE_MAX) : "";
  const p = await ownedProject(c, a.account.id, id);
  if (!p || !p.id) return fail(404, "not found");
  const access = await projectAccess(c.db, p, c.env, c.now);
  if (access.locked) return fail(409, access.locked === "pro_apps" ? "your plan covers no more apps: more apps come with Business or Enterprise" : `Free covers ${FREE.limits.apps === 1 ? "one app" : `${FREE.limits.apps ?? 1} apps`}, and this one is past it: it needs a paid plan`);
  const at = c.now.toISOString();
  await c.db.batch([
    c.db.prepare("INSERT INTO plan_feedback (account_id, project_id, reason, note, created) VALUES (?, ?, ?, ?, ?)").bind(a.account.id, p.id, reason[0], note || null, at),
    c.db.prepare("UPDATE projects SET plan_chosen = ? WHERE id = ? AND account_id = ?").bind(at, p.id, a.account.id),
  ]);
  await notifyOwner(
    { env: c.env, fetch: f, now: c.now },
    { kind: "free_chosen", account: a.account.id, project: p.id, reason: reason[0], text: `Free chosen for "${p.name}" (${a.account.email ?? a.account.github_login ?? a.account.id}): ${reason[1]}${note ? `. "${note}"` : ""}` },
  ).catch(() => false);
  return json(200, { ok: true, plan: access.plan.id });
}

/**
 * GenClass opens no Stripe page for, and starts no Checkout on, a stored customer that is not provably its own or that
 * holds anything else (src/stripe.ts checkCustomer, sharedCustomer, foreignInvoice): a defence kept from when the
 * Stripe account was shared with another business. The buyer gets a 409 with the contact address, nothing is opened,
 * and the owner gets a shared_customer notice with the ids (NOTIFY_WEBHOOK; worker logs are not kept).
 */
async function refuseShared(c: C, f: Fetch, accountId: string, customer: string, why: string): Promise<Response> {
  console.log(`billing: account ${accountId}: Stripe customer ${customer} ${why}; no Stripe page opened`);
  await notifyOwner(
    { env: c.env, fetch: f, now: c.now },
    {
      event: "shared_customer",
      text: `${modeNote(c.env)}GenClass account ${accountId}: its Stripe customer ${customer} ${why}, so GenClass opened no Stripe page for it. Move the other objects to a customer of their own (telemetry-worker/README.md, "Stripe object ownership").`,
      account_id: accountId,
      customer,
    },
  );
  return fail(409, `this account's Stripe billing record holds something that is not GenClass's, so GenClass does not open it; email ${PLANS_FILE.contact} and we will sort it out`);
}

const NOT_GENCLASS = "is not a customer GenClass made for this account";
const SHARED_SUBSCRIPTION = "also has a subscription that is not GenClass's";
const SHARED_INVOICE = "also has an invoice that is not for a GenClass subscription";

/**
 * POST /api/billing/checkout: a Stripe Checkout for a paid plan (one sold on the site; Enterprise is agreed by email).
 */
async function checkout(c: C, f: Fetch): Promise<Response> {
  const a = await browserWrite(c, "plans can be bought");
  if (a instanceof Response) return a;
  const body = await readJson(c, 1024);
  if (body instanceof Response) return body;
  if (!canBuy(c.env, a.account)) return fail(503, "paid plans are not on sale yet");
  const plan = PAID_PLANS.find((p) => p.id === body.plan);
  if (!plan) {
    if (!PAID_PLANS.length) return fail(400, `no plan is sold on genclass.dev: Free costs nothing, and Enterprise is agreed by email with ${PLANS_FILE.contact}`);
    return fail(400, `choose a plan: ${PAID_PLANS.map((p) => p.id).join(" or ")}`);
  }
  // a plan sold per project (billing/plans.json version 4) is bought for one of the account's apps
  if (plan.per_project === true) {
    if (typeof body.project_id !== "string" || !body.project_id) return fail(400, `the ${plan.name} plan is bought for one project: send project_id`);
    return checkoutProject(c, f, a, plan, body.project_id);
  }
  // a plan sold per seat (Pro since version 5): how many developers (the owner included); one when the page sends none
  let seats = 1;
  if (plan.per_seat === true && body.seats !== undefined) {
    const n = cleanSeats(body.seats);
    if (n === null) return fail(400, `seats is a whole number from 1 to ${MAX_SEATS}; for a larger team email ${PLANS_FILE.contact}`);
    seats = n;
  }
  // started from an app's plan page: Stripe returns there; from a page check (next): Stripe and the plan page return to it
  const backTo = typeof body.project_id === "string" && (await ownedProject(c, a.account.id, body.project_id))?.id ? body.project_id : undefined;
  const next = backTo ? null : scanNext(typeof body.next === "string" ? body.next : null);
  if (await overBudget(c.env.AUTH_LIMIT, "checkout", a.account.id)) return tooMany();
  // as stored: ensureCustomer decides what to do with a customer from the other Stripe mode
  const account = { id: a.account.id, email: a.account.email, ...(await accountBilling(c.db, a.account.id)) };
  try {
    let first = false;
    let customer = await ensureCustomer(c.env, f, c.db, account);
    if (!customer.fresh) {
      // the stored customer must be the account's own GenClass customer, holding nothing else; then what Stripe has
      // now (a webhook can lag behind a payment): an account that pays gets the same plan refused and the other plan as
      // a switch, never a second subscription of its own making
      const own = await checkCustomer(c.env, f, account.id, customer.id);
      if (own.state === "not_genclass") return refuseShared(c, f, account.id, customer.id, NOT_GENCLASS);
      if (own.state === "ok" && sharedCustomer(own.subs)) return refuseShared(c, f, account.id, customer.id, SHARED_SUBSCRIPTION);
      const subs = own.state === "ok" ? own.subs : [];
      first = own.state === "missing" || subs.length === 0;
      if (own.state === "missing") {
        customer = await ensureCustomer(c.env, f, c.db, { ...account, stripe_customer_id: customer.id, stripe_mode: stripeMode(c.env) }, customer.id);
      }
      const holding = subs.filter((s) => HOLDING_STATUSES.has(s.status) && isGenClassSubscription(s));
      const held = holding[0];
      if (held) {
        const st = subscriptionState(held);
        if (held.status === "past_due" || held.status === "unpaid") {
          // the plan may already be Free here (src/plans.ts PAST_DUE_GRACE_DAYS); paying the open invoice brings it back
          return fail(409, `the last payment for your ${planById(st.priced).name} plan did not go through; update your card in Manage billing to pay it, or email ${PLANS_FILE.contact}`);
        }
        if (st.priced === plan.id) {
          return fail(409, `you are already on the ${plan.name} plan${st.cancelAtPeriodEnd ? "; to keep it after this period, resume it on this page" : ""}`);
        }
        // a switch is paid on Checkout, never in the portal: a subscription sold through Managed Payments cannot take
        // another plan's price, and must not move onto another subscription outside it (src/stripe.ts header)
        if (holding.length > 1) return fail(409, `a plan change is already going through; reload this page in a minute, or email ${PLANS_FILE.contact}`);
        if (held.status !== "active" && held.status !== "trialing") return fail(409, `your ${planById(st.priced).name} plan is ${held.status}; email ${PLANS_FILE.contact} to change it`);
        // nothing but GenClass's billing on the customer, as before a portal session
        if (await foreignInvoice(c.env, f, customer.id, subs)) return refuseShared(c, f, account.id, customer.id, SHARED_INVOICE);
        // once the new subscription's first payment clears, the webhook refunds `held`'s unused time to its card and
        // cancels it; until then it stays
        const url = await checkoutSession(c.env, f, { account, customer: customer.id, plan, origin: c.cfg.origin, now: c.now, switchFrom: held.id, seats, country: countryOf(c.req) });
        return json(200, { url, switch: true });
      }
    }
    // the first subscription starts with the plan's trial (trialFor), once per account
    const trialDays = customer.fresh || first ? await trialFor(c.db, a.account.id, plan, 0) : 0;
    const url = await checkoutSession(c.env, f, { account, customer: customer.id, plan, origin: c.cfg.origin, now: c.now, fresh: customer.fresh, seats, trialDays, backTo, country: countryOf(c.req), ...(next ? { next } : {}) });
    return json(200, { url, trial_days: trialDays || null });
  } catch (e) {
    return stripeFail(e);
  }
}

async function portal(c: C, f: Fetch): Promise<Response> {
  const a = await browserWrite(c, "billing can be managed");
  if (a instanceof Response) return a;
  const body = await readJson(c, 1024);
  if (body instanceof Response) return body;
  if (!canBuy(c.env, a.account)) return fail(503, "paid plans are not on sale yet");
  const b = await accountBilling(c.db, a.account.id, c.env);
  if (!b.stripe_customer_id) return fail(409, "there is nothing to manage yet: this account has never bought a plan");
  if (await overBudget(c.env.AUTH_LIMIT, "portal", a.account.id)) return tooMany();
  const customer = b.stripe_customer_id;
  // Stripe no longer has this customer (deleted in Stripe): forget it, so the next purchase starts clean. Never for a
  // customer of the other mode (a live customer while the key is a test key is simply not visible to it)
  const forget = async (): Promise<Response | null> => {
    if ((b.stripe_mode ?? stripeMode(c.env)) !== stripeMode(c.env)) return null;
    await c.db
      .prepare(
        "UPDATE accounts SET stripe_customer_id = NULL, stripe_mode = NULL, plan = 'free', subscription_id = NULL, subscription_status = NULL, " +
          "current_period_end = NULL, cancel_at_period_end = 0 WHERE id = ? AND stripe_customer_id = ?",
      )
      .bind(a.account.id, customer)
      .run();
    return fail(409, "Stripe no longer has billing records for this account; buy a plan again on this page");
  };
  try {
    // the portal lets the buyer cancel any subscription on the customer, change the card that pays it and read every
    // invoice on it: only the account's own GenClass customer, holding nothing but GenClass's billing, gets one
    const own = await checkCustomer(c.env, f, a.account.id, customer);
    if (own.state === "missing") return (await forget()) ?? fail(502, "Stripe: this account's billing records are not visible with the current key");
    if (own.state === "not_genclass") return refuseShared(c, f, a.account.id, customer, NOT_GENCLASS);
    if (sharedCustomer(own.subs)) return refuseShared(c, f, a.account.id, customer, SHARED_SUBSCRIPTION);
    if (await foreignInvoice(c.env, f, customer, own.subs)) return refuseShared(c, f, a.account.id, customer, SHARED_INVOICE);
    return json(200, { url: await portalSession(c.env, f, { customer, origin: c.cfg.origin, now: c.now }) });
  } catch (e) {
    if (missingCustomer(e)) {
      const r = await forget();
      if (r) return r;
    }
    return stripeFail(e);
  }
}

// --------------------------------------------------------------------------------------------- cancel, offer, resume

// a Stripe subscription, read field by field
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sub = Record<string, any>;

interface CancelTarget {
  auth: Auth;
  sub: Sub;
  /** Every subscription of the account's customer, any status. */
  subs: Sub[];
  /** The plan's name as the pages say it ("Pro"; a plan GenClass no longer sells: "paid"). */
  name: string;
  /** The app whose own subscription this is, or null for the account's. */
  project: { id: string; name: string } | null;
}

/**
 * The subscription a cancel, its offer or a resume is about: the account's, or with `projectId` that app's own (a
 * plan bought per app under billing/plans.json version 4). Only the account that pays reaches it, and only a
 * subscription Stripe lists now on the account's own GenClass customer, provably GenClass's, naming this account (and
 * this app, or no app). Anything else is a 4xx and nothing is changed.
 */
async function cancelTarget(c: C, f: Fetch, a: Auth, projectId: string | null): Promise<CancelTarget | Response> {
  if (!canBuy(c.env, a.account)) return fail(503, "paid plans are not on sale yet");
  const b = await accountBilling(c.db, a.account.id, c.env);
  let project: CancelTarget["project"] = null;
  let subId = b.subscription_id;
  if (projectId !== null) {
    const p = await ownedProject(c, a.account.id, projectId);
    if (!p || !p.id) return fail(404, "not found");
    const row = await c.db.prepare("SELECT subscription_id FROM projects WHERE id = ? AND account_id = ?").bind(p.id, a.account.id).first<{ subscription_id: string | null }>();
    project = { id: p.id, name: p.name };
    subId = row?.subscription_id ?? null;
  }
  if (!b.stripe_customer_id || !subId) return fail(409, project ? `${project.name} has no paid plan of its own` : "this account has no paid plan");
  if (await overBudget(c.env.AUTH_LIMIT, "cancel", a.account.id)) return tooMany();
  const own = await checkCustomer(c.env, f, a.account.id, b.stripe_customer_id);
  if (own.state === "missing") return fail(409, `Stripe has no billing records for this account; email ${PLANS_FILE.contact}`);
  if (own.state === "not_genclass") return refuseShared(c, f, a.account.id, b.stripe_customer_id, NOT_GENCLASS);
  const sub = (own.subs as Sub[]).find((s) => s?.id === subId);
  const named = sub?.metadata?.genclass_account;
  if (!sub || !isGenClassSubscription(sub) || (named !== undefined && named !== null && named !== a.account.id) || projectOf(sub) !== (project?.id ?? null)) {
    return fail(409, `this plan cannot be changed here; email ${PLANS_FILE.contact} and we will do it for you`);
  }
  const priced = subscriptionState(sub).priced;
  return { auth: a, sub, subs: own.subs as Sub[], name: priced ? planById(priced).name : "paid", project };
}

/** The `project_id` of a cancel, offer or resume request's body: an app's id, or null for the account's plan. */
const projectIn = (body: Record<string, unknown>): string | null => (typeof body.project_id === "string" && body.project_id ? body.project_id : null);

/** A subscription with a discount on it (a promotion code's free months, the offer to stay): it ends with the plan. */
const discounted = (sub: Sub): boolean => (Array.isArray(sub?.discounts) && sub.discounts.length > 0) || !!sub?.discount;

/** Who and what, for the owner's notice: the account's email or login, and the app when the plan is one app's. */
const cancelWho = (t: CancelTarget): string =>
  `${t.auth.account.email ?? t.auth.account.github_login ?? t.auth.account.id}${t.project ? `, app "${t.project.name}"` : ""}`;

/**
 * GET /api/billing/cancel: what the cancel popups say before anything changes. The plan ends the day it is cancelled.
 * `trial`: it is in its free trial, so nothing was charged; else `ends` is the day the paid month would have run to
 * (the days up to it are lost). `refund`: the last payment, as text, when the cancel is within 3 days of a renewal and
 * gives it back (src/stripe.ts refundableOnCancel), else null. `discount`: the subscription has a discount (a promotion code's free
 * months, the offer to stay), which ends with it. `offer`: the discount for staying, when this subscription can have
 * it (a failure to read the coupon only hides the offer: cancelling never waits on it).
 */
async function cancelInfo(c: C, f: Fetch, projectId: string | null): Promise<Response> {
  const a = await browserRead(c);
  if (a instanceof Response) return a;
  try {
    const t = await cancelTarget(c, f, a, projectId || null);
    if (t instanceof Response) return t;
    const st = subscriptionState(t.sub);
    if (!HOLDING_STATUSES.has(st.status)) return fail(409, `your ${t.name} plan has already ended`);
    if (st.cancelAtPeriodEnd) return fail(409, `your ${t.name} plan is already cancelled and will not renew`);
    const offer = await retentionOffer(c.env, f, t.sub, t.subs).catch(() => null);
    const due = await cancelRefundDue({ env: c.env, db: c.db, fetch: f, now: c.now }, t.sub).catch(() => null);
    return json(200, { ok: true, plan: t.name, trial: st.status === "trialing", ends: st.periodEnd, refund: due ? money(due.amount, due.currency) : null, discount: discounted(t.sub), offer: offer ? { percent_off: offer.percent, months: offer.months } : null });
  } catch (e) {
    return stripeFail(e);
  }
}

/**
 * POST /api/billing/cancel/offer: the person stays, with the offer's coupon on the subscription from its next invoice.
 * 409 when this subscription cannot have it (retentionOffer). The owner is told.
 */
async function cancelOffer(c: C, f: Fetch): Promise<Response> {
  const a = await browserWrite(c, "a plan is changed");
  if (a instanceof Response) return a;
  const body = await readJson(c, 1024);
  if (body instanceof Response) return body;
  try {
    const t = await cancelTarget(c, f, a, projectIn(body));
    if (t instanceof Response) return t;
    const offer = await retentionOffer(c.env, f, t.sub, t.subs);
    if (!offer) return fail(409, "this offer is not available for your plan");
    await applyRetention(c.env, f, t.sub.id as string, c.now);
    await notifyOwner(
      { env: c.env, fetch: f, now: c.now },
      { event: "retention_offer_taken", text: `${modeNote(c.env)}Stayed instead of cancelling ${t.name}, with ${offer.percent}% off for ${offer.months} months: ${cancelWho(t)}.`, account_id: a.account.id, subscription_id: t.sub.id },
    ).catch(() => false);
    return json(200, { ok: true, percent_off: offer.percent, months: offer.months });
  } catch (e) {
    return stripeFail(e);
  }
}

/**
 * POST /api/billing/cancel: the last popup's button. The plan ends now, the day it is cancelled (the owner,
 * 2026-11-18), a trial and a paid plan alike: nothing more is charged, and a discount or free months on it end too. A
 * cancel within 3 days of a renewal first gives that payment back to the card (refundOnCancel); a refund that fails
 * never stops the cancel, and the owner's notice says to make it by hand. The database is written from the subscription as Stripe has it after (the webhook's own
 * write; if that read fails, Stripe's event does it a moment later). The owner is told.
 */
async function cancelPlan(c: C, f: Fetch): Promise<Response> {
  const a = await browserWrite(c, "a plan is cancelled");
  if (a instanceof Response) return a;
  const body = await readJson(c, 1024);
  if (body instanceof Response) return body;
  try {
    const t = await cancelTarget(c, f, a, projectIn(body));
    if (t instanceof Response) return t;
    const st = subscriptionState(t.sub);
    if (!HOLDING_STATUSES.has(st.status)) return fail(409, `your ${t.name} plan has already ended`);
    const trial = st.status === "trialing";
    const x = { env: c.env, db: c.db, fetch: f, now: c.now };
    // the refund first (a second try finds it made); its failure is the owner's to settle, never a reason to keep billing
    const back = trial ? null : await refundOnCancel(x, a.account, t.sub).catch((e) => ({ refund: null, amount: 0, currency: null, note: `the refund failed (${e instanceof Error ? e.message : String(e)}); refund by hand if one is due` }));
    const refunded = back?.refund ? money(back.amount, back.currency ?? "usd") : null;
    await cancelNow(c.env, f, t.sub.id as string);
    await refreshSubscription(x, t.sub.id as string).catch(() => null);
    await notifyOwner(
      { env: c.env, fetch: f, now: c.now },
      {
        event: "plan_cancelled",
        text: `${modeNote(c.env)}${t.name} cancelled ${trial ? "in its trial (ended at once, nothing charged)" : `(ended at once${st.periodEnd ? `; it was paid up to ${st.periodEnd.slice(0, 10)}` : ""}; ${refunded ? `refunded ${refunded} to the card, ${back!.refund}` : `not refunded: ${back?.note ?? "nothing was due"}`}${discounted(t.sub) ? "; its discount ended too" : ""})`}: ${cancelWho(t)}.`,
        account_id: a.account.id,
        subscription_id: t.sub.id,
      },
    ).catch(() => false);
    return json(200, { ok: true, ended: true, ends: null, refunded });
  } catch (e) {
    return stripeFail(e);
  }
}

/** POST /api/billing/resume: a plan set to end goes on as before (the same price; nothing is charged now). */
async function resumePlan(c: C, f: Fetch): Promise<Response> {
  const a = await browserWrite(c, "a plan is resumed");
  if (a instanceof Response) return a;
  const body = await readJson(c, 1024);
  if (body instanceof Response) return body;
  try {
    const t = await cancelTarget(c, f, a, projectIn(body));
    if (t instanceof Response) return t;
    const st = subscriptionState(t.sub);
    if (!LIVE_RESUME.has(st.status)) return fail(409, `your ${t.name} plan has ended; start it again on this page`);
    if (!st.cancelAtPeriodEnd) return json(200, { ok: true });
    await resumeSubscription(c.env, f, t.sub);
    await refreshSubscription({ env: c.env, db: c.db, fetch: f, now: c.now }, t.sub.id as string).catch(() => null);
    return json(200, { ok: true });
  } catch (e) {
    return stripeFail(e);
  }
}
/** The statuses a plan set to end can be resumed in. */
const LIVE_RESUME = new Set(["active", "trialing", "past_due"]);

/**
 * The days free a purchase of `plan` starts with: the plan's trial_days (Pro: 3) for an account that has never had a
 * subscription, none of its apps and not the account (D1), and none on its Stripe customer (`stripeSubs`, any
 * status, when the caller has asked Stripe); else 0. One trial per account: a cancelled trial does not start another.
 */
export async function trialFor(db: D1Like, accountId: string, plan: Plan, stripeSubs = 0): Promise<number> {
  const days = Number.isInteger(plan.trial_days) && plan.trial_days! > 0 ? plan.trial_days! : 0;
  if (!days || stripeSubs > 0) return 0;
  const r = await db
    .prepare("SELECT (SELECT COUNT(*) FROM projects WHERE account_id = ? AND subscription_id IS NOT NULL) + (SELECT COUNT(*) FROM accounts WHERE id = ? AND subscription_id IS NOT NULL) AS n")
    .bind(accountId, accountId)
    .first<{ n: number }>()
    .catch(() => ({ n: 1 }));
  return Number(r?.n ?? 1) ? 0 : days;
}

/**
 * Checkout for one project: the project must be the account's and not already on that plan; the Stripe customer is
 * the account's own (the same checks as the account's checkout: GenClass's, holding nothing else). One subscription
 * of quantity 1 per project, its metadata naming the project (src/stripe.ts checkoutSession, applyProjectSubscription);
 * the account's other subscriptions are never touched. The first one starts with the plan's trial (trialFor).
 */
async function checkoutProject(c: C, f: Fetch, a: Auth, plan: Plan, projectId: string): Promise<Response> {
  const p = await ownedProject(c, a.account.id, projectId);
  if (!p || !p.id) return fail(404, "not found");
  const access = await projectAccess(c.db, p, c.env, c.now);
  if (access.source === "paid" && access.plan.id === plan.id) return fail(409, `${p.name} is already on the ${plan.name} plan`);
  const row = await c.db.prepare("SELECT subscription_status FROM projects WHERE id = ?").bind(p.id).first<{ subscription_status: string | null }>();
  if (row?.subscription_status === "past_due" || row?.subscription_status === "unpaid") {
    return fail(409, `the last payment for ${p.name} did not go through; update your card in Manage billing to pay it, or email ${PLANS_FILE.contact}`);
  }
  if (await overBudget(c.env.AUTH_LIMIT, "checkout", a.account.id)) return tooMany();
  const account = { id: a.account.id, email: a.account.email, ...(await accountBilling(c.db, a.account.id)) };
  try {
    let customer = await ensureCustomer(c.env, f, c.db, account);
    // the plan's free days only for a customer that has never had a subscription
    let first = customer.fresh;
    if (!customer.fresh) {
      const own = await checkCustomer(c.env, f, account.id, customer.id);
      first = own.state === "missing" || (own.state === "ok" && own.subs.length === 0);
      if (own.state === "not_genclass") return refuseShared(c, f, account.id, customer.id, NOT_GENCLASS);
      if (own.state === "ok" && sharedCustomer(own.subs)) return refuseShared(c, f, account.id, customer.id, SHARED_SUBSCRIPTION);
      if (own.state === "missing") customer = await ensureCustomer(c.env, f, c.db, { ...account, stripe_customer_id: customer.id, stripe_mode: stripeMode(c.env) }, customer.id);
      // a payment for this project that the webhook has not written yet: never a second subscription
      const subs = own.state === "ok" ? own.subs : [];
      if (subs.some((s) => projectOf(s) === p.id && HOLDING_STATUSES.has(s.status))) return fail(409, `a plan for ${p.name} is already going through; reload this page in a minute`);
    }
    // one trial per account: none when the customer has had a subscription (first, above), GenClass's records say the
    // account has had one (trialFor), or another project's open Checkout already holds it
    const elsewhere = customer.fresh ? false : await openTrialElsewhere(c.env, f, customer.id, a.account.id, p.id).catch(() => true);
    const trialDays = elsewhere ? 0 : await trialFor(c.db, a.account.id, plan, first ? 0 : 1);
    const url = await checkoutSession(c.env, f, { account, customer: customer.id, plan, origin: c.cfg.origin, now: c.now, fresh: customer.fresh, project: { id: p.id }, trialDays, country: countryOf(c.req) });
    return json(200, { url, trial_days: trialDays || null });
  } catch (e) {
    return stripeFail(e);
  }
}

// --------------------------------------------------------------------------------------------- forwarding settings

async function integrations(c: C, f: Fetch, projectId: string, kindRaw: string | null, test: boolean): Promise<Response> {
  const m = c.req.method;
  const write = m !== "GET" && m !== "HEAD";
  const a = write ? await browserWrite(c, "forwarding can be changed") : await browserRead(c);
  if (a instanceof Response) return a;
  return integrationsFor(c, f, a.account.id, projectId, kindRaw, test);
}

/**
 * The forwarding settings of one app, for an account whose session the caller has already checked: this file's
 * browser routes, and the genclass command's (src/cli.ts, a terminal approved for it). Owner only, the plan's rules
 * and the limits are the same for both.
 */
export async function integrationsFor(c: C, f: Fetch, accountId: string, projectId: string, kindRaw: string | null, test: boolean): Promise<Response> {
  const m = c.req.method;
  const write = m !== "GET" && m !== "HEAD";
  const a = { account: { id: accountId } };
  const p = await ownedProject(c, a.account.id, projectId);
  if (!p || !p.id) return fail(404, "not found");
  // the project's own plan (a grant gives its plan's forwarding too: src/plans.ts projectAccess)
  const plan = (await projectAccess(c.db, p, c.env, c.now)).plan;

  if (kindRaw === null) {
    if (write) return method();
    const rows = await integrationRows(c.db, p.id);
    const out = [];
    for (const r of rows) out.push({ kind: r.kind, enabled: !!r.enabled, summary: maskConfig(r.kind, await openConfig(c.env, p.id, r.kind, r.config)), last_sent: r.last_sent, last_error: r.last_error });
    return json(200, { forwarding: entitled(plan, "forwarding"), integrations: out });
  }
  if (!isKind(kindRaw)) return fail(404, "not found");
  const kind: Kind = kindRaw;
  const row = (await integrationRows(c.db, p.id)).find((r) => r.kind === kind) ?? null;
  const done = (res: Response): Response => {
    forgetOwner(p.token);
    return res;
  };

  if (test) {
    if (m !== "POST") return method();
    if (!entitled(plan, "forwarding")) return upgrade(c, "forwarding");
    if (!row) return fail(404, `${kind} is not set up for this app`);
    if (await overBudget(c.env.AUTH_LIMIT, "test-send", a.account.id)) return tooMany();
    // a test record counts against the app's hourly forwarding cap like any other
    if (!(await claimTestSend(c.db, p.id, c.now))) return fail(429, "this app has sent its forwarding records for this hour; try again next hour", { "retry-after": "600" });
    const err = await deliver(c.env, c.db, p.id, row, testRecord(appOf(c, p), c.now), c.now, f);
    return err ? fail(502, err) : json(200, { ok: true });
  }
  if (m === "PUT") {
    if (!entitled(plan, "forwarding")) return upgrade(c, "forwarding");
    if (!(await integrationsKey(c.env))) return fail(503, "forwarding cannot be set up on this server yet: it has no encryption key for the settings");
    const body = await readJson(c, 4096);
    if (body instanceof Response) return body;
    const keep = row ? await openConfig(c.env, p.id, kind, row.config) : null;
    // never this server itself: a destination on genclass.dev would turn forwarding into requests to our own routes
    const own = [c.cfg.origin, c.env.DASHBOARD_ORIGIN, c.env.AUTH_ORIGIN].flatMap((o) => {
      try {
        return o ? [new URL(o).hostname] : [];
      } catch {
        return [];
      }
    });
    const checked = checkConfig(kind, body, keep, own);
    if ("error" in checked) return fail(400, checked.error);
    const sealed = await sealConfig(c.env, p.id, kind, checked.config);
    await c.db
      .prepare(
        "INSERT INTO integrations (project_id, kind, config, enabled, created) VALUES (?, ?, ?, 1, ?) " +
          "ON CONFLICT (project_id, kind) DO UPDATE SET config = excluded.config, enabled = 1, last_error = NULL",
      )
      .bind(p.id, kind, sealed, c.now.toISOString())
      .run();
    const fresh = kind === "webhook" && checked.config.secret !== keep?.secret;
    return done(json(200, { ok: true, kind, summary: maskConfig(kind, checked.config), ...(fresh ? { secret: checked.config.secret } : {}) }));
  }
  if (m === "PATCH") {
    const body = await readJson(c, 1024);
    if (body instanceof Response) return body;
    if (typeof body.enabled !== "boolean") return fail(400, 'send { "enabled": true } or { "enabled": false }');
    if (!row) return fail(404, `${kind} is not set up for this app`);
    if (body.enabled && !entitled(plan, "forwarding")) return upgrade(c, "forwarding");
    await c.db.prepare("UPDATE integrations SET enabled = ? WHERE project_id = ? AND kind = ?").bind(body.enabled ? 1 : 0, p.id, kind).run();
    return done(json(200, { ok: true, kind, enabled: body.enabled }));
  }
  if (m === "DELETE") {
    if (!row) return fail(404, `${kind} is not set up for this app`);
    await c.db.prepare("DELETE FROM integrations WHERE project_id = ? AND kind = ?").bind(p.id, kind).run();
    return done(new Response(null, { status: 204, headers: { "cache-control": "no-store" } }));
  }
  return method();
}

function appOf(c: C, p: Project): { id: string; name: string; dashboard: string } {
  return { id: p.id!, name: p.name, dashboard: `${c.cfg.origin}/account/apps/${p.id}` };
}

// --------------------------------------------------------------------------------------------- export

/** The account behind an export request: an export key (bearer) or the browser session. */
async function exportAuth(c: C): Promise<{ accountId: string } | Response> {
  const h = c.req.headers.get("authorization");
  if (h !== null) {
    const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
    if (m && EXPORT_KEY_RE.test(m[1]!)) {
      const row = await c.db
        .prepare("SELECT k.id, k.account_id, k.last_used FROM export_keys k JOIN accounts a ON a.id = k.account_id WHERE k.hash = ?")
        .bind(await sha256Hex(m[1]!))
        .first<{ id: string; account_id: string; last_used: string | null }>();
      if (!row) return fail(401, "this export key is not valid (revoked, or never created)");
      if (!row.last_used || Date.parse(row.last_used) < c.now.getTime() - 10 * 60_000) {
        await c.db.prepare("UPDATE export_keys SET last_used = ? WHERE id = ?").bind(c.now.toISOString(), row.id).run();
      }
      return { accountId: row.account_id };
    }
    if (m && m[1]!.startsWith("gcs_")) return fail(403, "a command line session cannot read the export; create an export key on the app's dashboard");
    return fail(401, "send an export key: Authorization: Bearer gce_...");
  }
  const a = await webSession(c);
  return a ? { accountId: a.account.id } : fail(401, "not signed in");
}

async function exportEvents(c: C, projectId: string): Promise<Response> {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD") return method();
  const who = await exportAuth(c);
  if (who instanceof Response) return who;
  return exportFor(c, who.accountId, projectId);
}

/**
 * One page of an app's stored events, for an account the caller has already identified: an export key or the
 * browser session (above), or the genclass command's session (src/cli.ts, a terminal approved for it). Owner only;
 * the plan's rule, its history and the per-minute limit are the same for all three.
 */
export async function exportFor(c: C, accountId: string, projectId: string): Promise<Response> {
  const who = { accountId };
  const p = await ownedProject(c, who.accountId, projectId);
  if (!p) return fail(404, "not found");
  const plan: Plan = (await projectAccess(c.db, p, c.env, c.now)).plan;
  if (!entitled(plan, "export")) return upgrade(c, "export");
  if (await overBudget(c.env.EXPORT_LIMIT, "export", who.accountId)) return tooMany();
  const q = c.url.searchParams;
  const earliest = new Date(c.now.getTime() - plan.limits.history_days * DAY);
  // by default up to now, the batch received this millisecond included
  const to = q.has("to") ? parseTime(q.get("to")) : new Date(c.now.getTime() + 1);
  let from = q.has("from") ? parseTime(q.get("from")) : new Date(c.now.getTime() - 7 * DAY);
  if (!to || !from) return fail(400, "from and to take a date (2026-10-01) or an ISO time");
  if (from < earliest) from = earliest; // the plan's history
  if (from >= to) return fail(400, "from must be before to");
  const format = q.get("format") ?? "jsonl";
  if (format !== "jsonl" && format !== "csv") return fail(400, "format is jsonl or csv");
  const limitRaw = q.get("limit");
  const limit = limitRaw === null ? PAGE_MAX : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) return fail(400, `limit is 1 to ${PAGE_MAX} batches`);
  const cursor = decodeCursor(q.get("cursor"));
  if (cursor === "bad") return fail(400, "this cursor is not valid; use the x-genclass-next-cursor header of the previous page");
  const base = new URL(c.url.toString());
  base.searchParams.delete("cursor");
  return exportResponse(c.db, c.env.BUCKET, {
    token: p.token,
    from,
    to,
    cursor,
    limit,
    format,
    filename: `genclass-${p.id}-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.${format}`,
    url: base,
  });
}

async function exportKeys(c: C, id: string | null): Promise<Response> {
  const m = c.req.method;
  if (id === null && (m === "GET" || m === "HEAD")) {
    const a = await browserRead(c);
    if (a instanceof Response) return a;
    const r = await c.db.prepare("SELECT id, label, created, last_used FROM export_keys WHERE account_id = ? ORDER BY created").bind(a.account.id).all();
    return json(200, { keys: r.results ?? [] });
  }
  if (id === null && m === "POST") {
    const a = await browserWrite(c, "export keys can be created");
    if (a instanceof Response) return a;
    const body = await readJson(c, 1024);
    if (body instanceof Response) return body;
    if (!entitled(await accountPlan(c.db, a.account.id, c.env, c.now), "export")) return upgrade(c, "export");
    if (await overBudget(c.env.AUTH_LIMIT, "export-key", a.account.id)) return tooMany();
    const n = await c.db.prepare("SELECT COUNT(*) AS n FROM export_keys WHERE account_id = ?").bind(a.account.id).first<{ n: number }>();
    if (Number(n?.n ?? 0) >= MAX_EXPORT_KEYS) return fail(409, `an account can have at most ${MAX_EXPORT_KEYS} export keys; revoke one first`);
    // eslint-disable-next-line no-control-regex
    const label = typeof body.label === "string" ? body.label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60) || null : null;
    const key = `gce_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const keyId = randomBase62(16);
    await c.db
      .prepare("INSERT INTO export_keys (id, hash, account_id, label, created) VALUES (?, ?, ?, ?, ?)")
      .bind(keyId, await sha256Hex(key), a.account.id, label, c.now.toISOString())
      .run();
    return json(201, { id: keyId, key, label, created: c.now.toISOString() });
  }
  if (id !== null && m === "DELETE") {
    const a = await browserWrite(c, "export keys can be revoked");
    if (a instanceof Response) return a;
    const r = await c.db.prepare("DELETE FROM export_keys WHERE id = ? AND account_id = ? RETURNING id").bind(id, a.account.id).first();
    return r ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : fail(404, "no such export key");
  }
  return method();
}
