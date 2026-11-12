// Routes for the paid plans. Checked before the account routes (src/auth.ts); null for any other path.
//
//   POST /api/billing/checkout {plan: "<id>", seats?}   browser session + Origin; {url} of Stripe Checkout (with
//                                                       switch: true when it replaces the plan already paid); `seats`
//                                                       (1 to 200, default 1) for a plan sold per seat (Team)
//   POST /api/billing/trial                            410: GenClass has no trial any more (the dashboard is free)
//   POST /api/billing/portal                           browser session + Origin; {url} of the Billing Portal
//   POST /api/billing/webhook                          Stripe only: signature, no session (src/stripe.ts)
//   GET  /api/billing                                  browser session; the plan and the subscription
//   GET  /account/billing                              the plan page (src/billing-pages.ts)
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

import { accountContext, accountProjects, authenticate, csrfFail, fail, originOk, ownedProject, page, readJson, redirect, webSession, type Auth, type C } from "./auth.js";
import { billingPage, projectPlanPage } from "./billing-pages.js";
import { liveFixUsage } from "./usage.js";
import type { Env, HandleOptions, RateLimiterLike } from "./collector.js";
import { randomBase62, sha256Hex, type Project } from "./dashboard.js";
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
  entitled,
  MAX_SEATS,
  FREE,
  PAID_PLANS,
  PLANS,
  PLANS_FILE,
  planById,
  projectAccess,
  accountProjectsAccess,
  stripeMode,
  type Entitlement,
  type Plan,
} from "./plans.js";
import {
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
  portalSession,
  sharedCustomer,
  StripeError,
  stripeWebhook,
  subscriptionState,
} from "./stripe.js";
import { membershipsOf, teamOf } from "./team.js";
import { b64url } from "./webauthn.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const EXPORT_KEY_RE = /^gce_[A-Za-z0-9_-]{43}$/;
const MAX_EXPORT_KEYS = 10;
const DAY = 86_400_000;

const method = (): Response => fail(405, "method not allowed");
/** The 403 for something the account's plan leaves out, naming the plans that include it. */
const upgrade = (c: C, what: Entitlement): Response => {
  const plans = PLANS.filter((p) => entitled(p, what)).map((p) => p.name);
  const has = plans.length ? `is part of the ${plans.join(" and ")} plan${plans.length > 1 ? "s" : ""}` : "is not part of any plan";
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
const pickedPlan = (v: string | null): Plan | null => PAID_PLANS.find((p) => p.id === v) ?? null;

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
    case "/api/billing/trial":
      return m === "POST" ? fail(410, `GenClass has no trial any more: the dashboard is free; see ${c.cfg.origin}/account/billing`) : method();
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
        return page(200, (n) =>
          projectPlanPage(n, {
            account: { id: a.account.id, email: a.account.email, githubLogin: a.account.github_login },
            apps,
            project: { id: p.id!, name: p.name },
            access,
            sub: { status: row?.subscription_status ?? null, periodEnd: row?.current_period_end ?? null, cancels: !!row?.cancel_at_period_end },
            usage,
            live: canBuy(env, a.account),
            testMode: stripeMode(env) === "test",
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
      const a = await webSession(c);
      // the plan picked on the pricing page survives the sign-in
      if (!a) return redirect(`/login?next=${encodeURIComponent(`/account/billing${picked ? `?plan=${picked.id}${go ? "&start=1" : ""}` : ""}`)}`);
      // a plan sold per project, picked on the pricing page or started from an older genclass command: the plan page
      // of the account's first app still on Free, where it is bought for that app
      if (picked?.per_project === true) {
        const open = (await accountProjectsAccess(c.db, a.account.id, env, c.now)).find((x) => x.row.id && x.access.plan.id === FREE.id && x.access.source === null && !x.access.locked)
          ?? (await accountProjectsAccess(c.db, a.account.id, env, c.now)).find((x) => x.row.id && x.access.locked);
        if (open) return redirect(`/account/billing?project=${encodeURIComponent(open.row.id!)}${go ? "&from=cli" : ""}`);
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
          done: url.searchParams.get("done") === "1",
          picked: picked?.id ?? null,
          go,
          switchTo: pickedPlan(url.searchParams.get("to"))?.id ?? null,
          managedPlans: PAID_PLANS.filter((p) => managedPayments(env, p)).map((p) => p.name),
          now: c.now,
        }),
      );
    }
  }
  const free = /^\/api\/billing\/projects\/([^/]+)\/free$/.exec(path);
  if (free) return m === "POST" ? chooseFree(c, free[1]!) : method();
  if (integ) return integrations(c, f, integ[1]!, integ[2] ?? null, !!integ[3]);
  if (events) return exportEvents(c, events[1]!);
  if (keys) return exportKeys(c, keys[1] ?? null);
  return fail(404, "not found");
}

// --------------------------------------------------------------------------------------------- Checkout, portal

/**
 * POST /api/billing/projects/<id>/free: Free chosen for one app for now, on its plan page (the small "Try for free
 * (limited)"). It writes when (projects.plan_chosen), which the genclass command's plan step waits for, and changes
 * nothing else: the app is on Free either way. An app past the ones Free covers has only the paid plan (409).
 */
async function chooseFree(c: C, id: string): Promise<Response> {
  const a = await browserWrite(c, "a plan is chosen");
  if (a instanceof Response) return a;
  const p = await ownedProject(c, a.account.id, id);
  if (!p || !p.id) return fail(404, "not found");
  const access = await projectAccess(c.db, p, c.env, c.now);
  if (access.locked) return fail(409, `Free covers ${FREE.limits.apps ?? 3} projects, and this one is past them: it needs a paid plan`);
  await c.db.prepare("UPDATE projects SET plan_chosen = ? WHERE id = ? AND account_id = ?").bind(c.now.toISOString(), p.id, a.account.id).run();
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
  // a plan sold per seat: how many people (the owner included); one when the page sends none
  let seats = 1;
  if (plan.per_seat === true && body.seats !== undefined) {
    const n = cleanSeats(body.seats);
    if (n === null) return fail(400, `seats is a whole number from 1 to ${MAX_SEATS}; for a larger team email ${PLANS_FILE.contact}`);
    seats = n;
  }
  if (await overBudget(c.env.AUTH_LIMIT, "checkout", a.account.id)) return tooMany();
  // as stored: ensureCustomer decides what to do with a customer from the other Stripe mode
  const account = { id: a.account.id, email: a.account.email, ...(await accountBilling(c.db, a.account.id)) };
  try {
    let customer = await ensureCustomer(c.env, f, c.db, account);
    if (!customer.fresh) {
      // the stored customer must be the account's own GenClass customer, holding nothing else; then what Stripe has
      // now (a webhook can lag behind a payment): an account that pays gets the same plan refused and the other plan as
      // a switch, never a second subscription of its own making
      const own = await checkCustomer(c.env, f, account.id, customer.id);
      if (own.state === "not_genclass") return refuseShared(c, f, account.id, customer.id, NOT_GENCLASS);
      if (own.state === "ok" && sharedCustomer(own.subs)) return refuseShared(c, f, account.id, customer.id, SHARED_SUBSCRIPTION);
      const subs = own.state === "ok" ? own.subs : [];
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
          return fail(409, `you are already on the ${plan.name} plan${st.cancelAtPeriodEnd ? "; to keep it after this period, resume it in Manage billing" : ""}`);
        }
        // a switch is paid on Checkout, never in the portal: a subscription sold through Managed Payments cannot take
        // another plan's price, and must not move onto another subscription outside it (src/stripe.ts header)
        if (holding.length > 1) return fail(409, `a plan change is already going through; reload this page in a minute, or email ${PLANS_FILE.contact}`);
        if (held.status !== "active" && held.status !== "trialing") return fail(409, `your ${planById(st.priced).name} plan is ${held.status}; email ${PLANS_FILE.contact} to change it`);
        // nothing but GenClass's billing on the customer, as before a portal session
        if (await foreignInvoice(c.env, f, customer.id, subs)) return refuseShared(c, f, account.id, customer.id, SHARED_INVOICE);
        // once the new subscription's first payment clears, the webhook refunds `held`'s unused time to its card and
        // cancels it; until then it stays
        const url = await checkoutSession(c.env, f, { account, customer: customer.id, plan, origin: c.cfg.origin, now: c.now, switchFrom: held.id, seats });
        return json(200, { url, switch: true });
      }
    }
    const url = await checkoutSession(c.env, f, { account, customer: customer.id, plan, origin: c.cfg.origin, now: c.now, fresh: customer.fresh, seats });
    return json(200, { url });
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

/**
 * Checkout for one project: the project must be the account's and not already on that plan; the Stripe customer is
 * the account's own (the same checks as the account's checkout: GenClass's, holding nothing else). One subscription
 * of quantity 1 per project, its metadata naming the project (src/stripe.ts checkoutSession, applyProjectSubscription);
 * the account's other subscriptions are never touched.
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
    if (!customer.fresh) {
      const own = await checkCustomer(c.env, f, account.id, customer.id);
      if (own.state === "not_genclass") return refuseShared(c, f, account.id, customer.id, NOT_GENCLASS);
      if (own.state === "ok" && sharedCustomer(own.subs)) return refuseShared(c, f, account.id, customer.id, SHARED_SUBSCRIPTION);
      if (own.state === "missing") customer = await ensureCustomer(c.env, f, c.db, { ...account, stripe_customer_id: customer.id, stripe_mode: stripeMode(c.env) }, customer.id);
      // a payment for this project that the webhook has not written yet: never a second subscription
      const subs = own.state === "ok" ? own.subs : [];
      if (subs.some((s) => projectOf(s) === p.id && HOLDING_STATUSES.has(s.status))) return fail(409, `a plan for ${p.name} is already going through; reload this page in a minute`);
    }
    const url = await checkoutSession(c.env, f, { account, customer: customer.id, plan, origin: c.cfg.origin, now: c.now, fresh: customer.fresh, project: { id: p.id } });
    return json(200, { url });
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
