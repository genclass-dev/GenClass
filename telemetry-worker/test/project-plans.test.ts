// Plans per project (billing/plans.json version 4, the owner's decision of 2026-11-12): Team is $15 a month for one
// project, everyone on the account's team included; Free covers an account's first 3 projects and 100 problems fixed
// live a month per project, after which the runtime is told to observe only. Checkout, the webhook, the pages, the
// lock on a fourth free project, the live-fix limit at ingest, and what a project that is paid for cannot lose.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { accountWide, FREE, priceText, PLANS } from "../src/plans.js";
import { FREE_REASONS, trialFor } from "../src/billing.js";
import { FREE_REASONS_SHOWN } from "../src/billing-pages.js";
import { resetStripeCache } from "../src/stripe.js";
import { monthOf, OBSERVE_HEADER, resetUsageCache } from "../src/usage.js";
import { call, createApp, deliver, fakeStripe, GENCLASS_PORTAL, price, resetClock, sendBatch, setPlan, setup, signedIn, stripeEvent, subscription, WEBHOOK_SECRET } from "./account-helpers.js";

const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL };
const text = async (r: Promise<Response> | Response) => (await r).text();
const json = async (r: Promise<Response> | Response) => (await (await r).json()) as any;

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
  resetUsageCache();
});

/** A project's subscription as Stripe returns it: GenClass's Team price, its metadata naming the project. */
const projectSub = (id: string, accountId: string, customer: string, projectId: string, status = "active") =>
  subscription(id, accountId, customer, "genclass_team_monthly", status, { metadata: { genclass: "1", genclass_account: accountId, genclass_project: projectId } });

/** An account with a Stripe customer GenClass made, and two apps. */
async function buyer() {
  const t = setup(LIVE);
  const a = await signedIn(t.env);
  const s = fakeStripe();
  t.sql.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_ada0000001', stripe_mode = 'live' WHERE id = ?").run(a.account.id);
  s.genclassCustomer("cus_ada0000001", a.account.id);
  const shop = await createApp(t.env, a.cookie, "Shop");
  const blog = await createApp(t.env, a.cookie, "Blog");
  return { ...t, ...a, s, shop, blog };
}

describe("plans.json version 4: Team per project", () => {
  it("Team is $15 a project a month, not per seat; Free covers 3 projects and 100 live fixes a month each", () => {
    const [free, team, enterprise] = PLANS;
    expect(priceText(team!)).toBe("$15 / project / month");
    expect(team!.per_project).toBe(true);
    expect(team!.per_seat).toBe(false);
    expect(free!.limits).toEqual({ apps: 3, history_days: 7, seats: 1, live_fixes_per_month: 100 });
    expect(team!.limits.live_fixes_per_month).toBeNull();
    expect(enterprise!.limits.live_fixes_per_month).toBeNull();
    expect(free!.features.map((f) => f.text)).toContain("100 live fixes a month per project, then observe only");
    expect(team!.features.map((f) => f.text)).toContain("Unlimited live fixes");
  });

  it("an account's grant of Team covers only the apps it was copied to; an Enterprise grant and an old account subscription cover them all", () => {
    const at = new Date("2026-11-12T12:00:00Z");
    const later = "2027-02-01T00:00:00.000Z";
    expect(accountWide({ plan: "free", stripe_mode: null, comp_until: later, comp_plan: "team" }, "live", at).plan.id).toBe("free");
    expect(accountWide({ plan: "free", stripe_mode: null, comp_until: later, comp_plan: null }, "live", at).plan.id).toBe("enterprise");
    expect(accountWide({ plan: "team", stripe_mode: "live", comp_until: null }, "live", at)).toMatchObject({ source: "paid", plan: { id: "team" } });
  });
});

describe("checkout for one project (POST /api/billing/checkout { plan, project_id })", () => {
  it("Team is bought for a project of the account, once; nothing goes to Stripe otherwise", async () => {
    const b = await buyer();
    const none = await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch });
    expect(none.status).toBe(400);
    // the plan id stays team; its name is Pro since 2026-11-12
    expect((await none.json() as any).error).toBe("the Pro plan is bought for one project: send project_id");
    const other = await signedIn(b.env, "bob@example.com");
    const theirs = await createApp(b.env, other.cookie, "Theirs");
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: theirs.id }, cookie: b.cookie, fetch: b.s.fetch })).status).toBe(404);
    expect(b.s.calls.filter((c) => c.url.pathname === "/v1/checkout/sessions" && c.method === "POST")).toEqual([]);
  });

  it("the session: quantity 1, the project in its metadata and its subscription's, back to the project's page", async () => {
    const b = await buyer();
    const r = await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: b.shop.id }, cookie: b.cookie, fetch: b.s.fetch });
    expect(r.status).toBe(200);
    const session = b.s.calls.find((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions")!;
    const form = Object.fromEntries(session.form!);
    expect(form).toMatchObject({
      mode: "subscription",
      customer: "cus_ada0000001",
      "line_items[0][price]": "price_team000001",
      "line_items[0][quantity]": "1",
      // the "Add promotion code" field
      allow_promotion_codes: "true",
      "metadata[genclass_project]": b.shop.id,
      "metadata[genclass_plan]": "team",
      "subscription_data[metadata][genclass_project]": b.shop.id,
      "subscription_data[metadata][genclass_account]": b.account.id,
      success_url: `https://genclass.dev/account/billing?project=${b.shop.id}&done=1`,
      cancel_url: `https://genclass.dev/account/billing?project=${b.shop.id}`,
    });
    expect(session.form!.has("line_items[0][adjustable_quantity][enabled]")).toBe(false);
    // the other project's checkout is a session of its own
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: b.blog.id }, cookie: b.cookie, fetch: b.s.fetch })).status).toBe(200);
    const sessions = b.s.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions").map((c) => c.form!.get("metadata[genclass_project]"));
    expect(sessions).toEqual([b.shop.id, b.blog.id]);
  });
});

describe("Pro's trial: 3 days free at Checkout, once per account (src/billing.ts trialFor, the owner's decision of 2026-11-12)", () => {
  const sessionsOf = (s: ReturnType<typeof fakeStripe>) => s.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions").map((c) => c.form!);
  const checkout = (b: Awaited<ReturnType<typeof buyer>>, projectId: string) => call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: projectId }, cookie: b.cookie, fetch: b.s.fetch });

  it("the first purchase starts with 3 days free; once a project of the account has had a subscription, no purchase does", async () => {
    const b = await buyer();
    const first = await checkout(b, b.shop.id);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//), trial_days: 3 });
    const [form] = sessionsOf(b.s);
    expect(form!.get("subscription_data[trial_period_days]")).toBe("3");
    // the card is taken at Checkout, and the "Add promotion code" field is there
    expect(form!.get("payment_method_collection")).toBe("always");
    expect(form!.get("allow_promotion_codes")).toBe("true");
    // the shop's Checkout is completed (Stripe closes the page) and its subscription is written by the webhook: the
    // account has had one now
    b.s.sessions.get("cs_test_000001")!.status = "complete";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sub = projectSub("sub_shop000001", b.account.id, "cus_ada0000001", b.shop.id);
    b.s.subs.set(sub.id, sub);
    expect(await json(deliver(b.env, stripeEvent("customer.subscription.created", sub), b.s.fetch))).toEqual({ received: true, result: "applied" });
    const second = await checkout(b, b.blog.id);
    expect(second.status).toBe(200);
    expect((await second.json() as any).trial_days).toBeNull();
    expect(sessionsOf(b.s)[1]!.has("subscription_data[trial_period_days]")).toBe(false);
    expect(sessionsOf(b.s)[1]!.get("allow_promotion_codes")).toBe("true");
    // the blog's plan page offers Pro, not a trial
    const page = await text(call(b.env, "GET", `/account/billing?project=${b.blog.id}`, { cookie: b.cookie }));
    expect(page).toContain('data-plan="team" data-pick><span>Start Pro for Blog</span>');
    expect(page).not.toContain("free trial");
    expect(page).not.toContain('class="trialnote"');
    // a cancelled subscription does not start another trial: the project keeps its subscription id
    const ended = projectSub("sub_shop000001", b.account.id, "cus_ada0000001", b.shop.id, "canceled");
    b.s.subs.set(ended.id, ended);
    expect((await json(deliver(b.env, stripeEvent("customer.subscription.deleted", ended), b.s.fetch))).result).toBe("applied");
    const again = await json(checkout(b, b.shop.id));
    expect(again.trial_days).toBeNull();
    expect(sessionsOf(b.s)[2]!.has("subscription_data[trial_period_days]")).toBe(false);
    log.mockRestore();
  });

  it("a Stripe customer that has had any subscription gets no trial, though nothing of it is in the database; a new customer does", async () => {
    const b = await buyer();
    // a subscription the webhook never wrote here (a project since deleted, say), cancelled long ago
    const old = projectSub("sub_gone000001", b.account.id, "cus_ada0000001", "gone_project_01", "canceled");
    b.s.subs.set(old.id, old);
    expect(b.sql.rows("SELECT subscription_id FROM projects WHERE subscription_id IS NOT NULL")).toEqual([]);
    const r = await checkout(b, b.shop.id);
    expect(r.status).toBe(200);
    expect((await r.json() as any).trial_days).toBeNull();
    expect(sessionsOf(b.s)[0]!.has("subscription_data[trial_period_days]")).toBe(false);
    // an account without a Stripe customer yet: one is made, and its first purchase has the trial
    const t = setup(LIVE);
    const a = await signedIn(t.env, "new@example.com");
    const app = await createApp(t.env, a.cookie, "Fresh");
    const s = fakeStripe();
    const fresh = await call(t.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: app.id }, cookie: a.cookie, fetch: s.fetch });
    expect(fresh.status).toBe(200);
    expect((await fresh.json() as any).trial_days).toBe(3);
    expect(sessionsOf(s)[0]!.get("subscription_data[trial_period_days]")).toBe("3");
  });

  it("one trial per account: while one project's Checkout holds the trial, another project's starts without one; a page is reused only with the same trial", async () => {
    const b = await buyer();
    const first = await checkout(b, b.shop.id);
    expect((await first.json() as any).trial_days).toBe(3);
    expect(sessionsOf(b.s)[0]!.get("metadata[genclass_trial_days]")).toBe("3");
    // the shop's page is still open: the blog's starts without a trial
    const second = await checkout(b, b.blog.id);
    expect((await second.json() as any).trial_days).toBeNull();
    const blogForm = sessionsOf(b.s)[1]!;
    expect(blogForm.has("subscription_data[trial_period_days]")).toBe(false);
    expect(blogForm.has("metadata[genclass_trial_days]")).toBe(false);
    // the shop asked again: its open page, with the same trial, is the answer (no second session)
    const again = await checkout(b, b.shop.id);
    expect((await again.json() as any).trial_days).toBe(3);
    expect(sessionsOf(b.s)).toHaveLength(2);
  });

  it("trialFor: the plan's trial_days for an account with no subscription anywhere; 0 for a plan without one, a past subscription, or one on Stripe", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    const app = await createApp(t.env, a.cookie, "Shop");
    const pro = PLANS.find((p) => p.id === "team")!;
    expect(pro.trial_days).toBe(3);
    expect(await trialFor(t.sql.api, a.account.id, pro)).toBe(3);
    // subscriptions Stripe lists for the customer (any status)
    expect(await trialFor(t.sql.api, a.account.id, pro, 1)).toBe(0);
    // a plan with no trial, or a trial that is not a whole number of days
    expect(await trialFor(t.sql.api, a.account.id, FREE)).toBe(0);
    for (const trial_days of [0, -3, 1.5, undefined]) expect(await trialFor(t.sql.api, a.account.id, { ...pro, trial_days }), String(trial_days)).toBe(0);
    // a project's subscription, cancelled or not
    t.sql.db.prepare("UPDATE projects SET subscription_id = 'sub_p', subscription_status = 'canceled' WHERE id = ?").run(app.id);
    expect(await trialFor(t.sql.api, a.account.id, pro)).toBe(0);
    t.sql.db.prepare("UPDATE projects SET subscription_id = NULL, subscription_status = NULL WHERE id = ?").run(app.id);
    expect(await trialFor(t.sql.api, a.account.id, pro)).toBe(3);
    // the account's own subscription from before plans were per project
    setPlan(t.sql, a.account.id, "free", { subscription_id: "sub_old", subscription_status: "canceled" });
    expect(await trialFor(t.sql.api, a.account.id, pro)).toBe(0);
    // another account's subscription is not this one's
    const b = await signedIn(t.env, "bob@example.com");
    expect(await trialFor(t.sql.api, b.account.id, pro)).toBe(3);
  });
});

describe("the webhook writes a project's subscription to that project and touches nothing else", () => {
  it("two projects, two subscriptions: each project gets its plan, the account row stays, nothing is cancelled or refunded", async () => {
    const b = await buyer();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const apply = async (sub: Record<string, unknown>, type = "customer.subscription.created") => {
      b.s.subs.set(sub.id as string, sub);
      return json(deliver(b.env, stripeEvent(type, sub), b.s.fetch));
    };
    expect(await apply(projectSub("sub_shop000001", b.account.id, "cus_ada0000001", b.shop.id!))).toEqual({ received: true, result: "applied" });
    expect(await apply(projectSub("sub_blog000001", b.account.id, "cus_ada0000001", b.blog.id!))).toEqual({ received: true, result: "applied" });
    const rows = b.sql.rows("SELECT name, plan, subscription_id, subscription_status FROM projects ORDER BY name");
    expect(rows).toEqual([
      { name: "Blog", plan: "team", subscription_id: "sub_blog000001", subscription_status: "active" },
      { name: "Shop", plan: "team", subscription_id: "sub_shop000001", subscription_status: "active" },
    ]);
    // the account's own plan is not changed by a project's subscription
    expect(b.sql.rows("SELECT plan, subscription_id FROM accounts")[0]).toEqual({ plan: "free", subscription_id: null });
    // never a cancellation or a refund: each project is paid for on its own
    expect(b.s.calls.filter((c) => c.method === "DELETE" || c.url.pathname.startsWith("/v1/refunds") || /\/cancel$/.test(c.url.pathname))).toEqual([]);
    // the project's access is Team: 90 days of history, visitor analytics
    const st = await json(call(b.env, "GET", `/api/account/projects/${b.shop.id}/stats?range=90d`, { cookie: b.cookie }));
    expect(st.range).toBe("90d");
    expect(st.plan).toEqual({ id: "team", name: "Pro", source: "paid" });
    expect(st.locked).toBeUndefined();
    // the subscription ends: the project goes back to Free
    expect(await apply(projectSub("sub_shop000001", b.account.id, "cus_ada0000001", b.shop.id!, "canceled"), "customer.subscription.deleted")).toEqual({ received: true, result: "applied" });
    expect(b.sql.rows("SELECT plan, subscription_status FROM projects WHERE name = 'Shop'")[0]).toEqual({ plan: null, subscription_status: "canceled" });
    log.mockRestore();
  });

  it("a second live subscription for a project that has one is not written and not cancelled; the owner is told", async () => {
    const b = await buyer();
    const told: string[] = [];
    const env = { ...b.env, NOTIFY_WEBHOOK: "https://hooks.example/notify" };
    const s = fakeStripe({ answer: (url, init) => (url.hostname === "hooks.example" ? (told.push(String(init.body)), new Response("ok")) : undefined) });
    s.genclassCustomer("cus_ada0000001", b.account.id);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...x: unknown[]) => void lines.push(x.join(" ")));
    const apply = async (sub: Record<string, unknown>) => {
      s.subs.set(sub.id as string, sub);
      return json(deliver(env, stripeEvent("customer.subscription.created", sub), s.fetch));
    };
    expect(await apply(projectSub("sub_shop000001", b.account.id, "cus_ada0000001", b.shop.id!))).toEqual({ received: true, result: "applied" });
    const second = await apply(projectSub("sub_shop000002", b.account.id, "cus_ada0000001", b.shop.id!));
    expect(second.result).toBe("ignored");
    expect(b.sql.rows("SELECT subscription_id FROM projects WHERE name = 'Shop'")[0]).toEqual({ subscription_id: "sub_shop000001" });
    expect(told.join("")).toContain("project_second_subscription");
    expect(s.calls.filter((c) => c.method === "DELETE" || c.url.pathname.startsWith("/v1/refunds"))).toEqual([]);
    log.mockRestore();
  });

  it("a project of another account named in the metadata is ignored", async () => {
    const b = await buyer();
    const other = await signedIn(b.env, "bob@example.com");
    const theirs = await createApp(b.env, other.cookie, "Theirs");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sub = projectSub("sub_x000000001", b.account.id, "cus_ada0000001", theirs.id);
    b.s.subs.set(sub.id, sub);
    expect((await json(deliver(b.env, stripeEvent("customer.subscription.created", sub), b.s.fetch))).result).toBe("ignored");
    expect(b.sql.rows("SELECT plan FROM projects WHERE name = 'Theirs'")[0]).toEqual({ plan: null });
    log.mockRestore();
  });
});

describe("Free covers 3 projects; a fourth waits for a plan of its own", () => {
  it("a fourth project is created, and its dashboard is locked with the way to its plan page", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    const apps = [];
    for (const n of ["a", "b", "c", "d"]) apps.push(await createApp(t.env, a.cookie, n));
    expect((await call(t.env, "GET", `/api/account/projects/${apps[2]!.id}/stats?range=7d`, { cookie: a.cookie })).status).toBe(200);
    const locked = await call(t.env, "GET", `/api/account/projects/${apps[3]!.id}/stats?range=7d`, { cookie: a.cookie });
    expect(locked.status).toBe(402);
    expect(await locked.json()).toMatchObject({ locked: true, needs_plan: true, upgrade_url: `https://genclass.dev/account/billing?project=${apps[3]!.id}` });
    // once one of the first three is paid for, the fourth is one of the three on Free
    t.sql.db.prepare("UPDATE projects SET plan = 'team', stripe_mode = 'live', subscription_status = 'active' WHERE id = ?").run(apps[0]!.id);
    resetOwnerCache();
    expect((await call(t.env, "GET", `/api/account/projects/${apps[3]!.id}/stats?range=7d`, { cookie: a.cookie })).status).toBe(200);
  });

  it("the billing page lists each project with its plan; the project's page shows Team large and Free small", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    const apps = [];
    for (const n of ["Shop", "Blog", "Docs", "Extra"]) apps.push(await createApp(t.env, a.cookie, n));
    const page = await text(call(t.env, "GET", "/account/billing", { cookie: a.cookie }));
    expect(page).toContain('<p class="price">$15 / project / month</p>');
    expect(page).toContain('<a class="btn" href="#projects"><span>Choose a project</span></a>');
    expect(page).toContain('id="projects"');
    expect(page).toContain(`<tr><td>Shop</td><td>Free</td>`);
    expect(page).toContain("Needs a plan");
    const one = await text(call(t.env, "GET", `/account/billing?project=${apps[0]!.id}&from=cli`, { cookie: a.cookie }));
    expect(one).toContain("<h1>Choose a plan for Shop</h1>");
    expect(one).toContain("<b>Shop</b> is on <b>Free</b>.");
    expect(one).toContain('<div class="plan pick big"><h3>Pro</h3><p class="price">$15 / project / month</p>');
    // an account that has never had a subscription starts with Pro's 3 days free (billing.ts trialFor)
    expect(one).toContain('data-plan="team" data-pick><span>Start your 3-day free trial</span>');
    expect(one).toContain('<p class="trialnote">3 days free, then $15 / project / month for Shop. Cancel before the trial ends and you pay nothing.</p>');
    // Free is the small way on, a very small button under the big card
    // Free is the small way on: a very small link under the big card, and a popup that asks why before it goes on
    expect(one).toContain('<p class="free"><a href="#why" class="linkish" id="free">Try for free (limited)</a></p>');
    expect(one).toContain(".linkish{background:none;border:0;padding:0;font:inherit;font-size:11px");
    expect(one).toContain('<h2 id="whyh">What\'s stopping you from paying?</h2>');
    for (const [val, words] of FREE_REASONS) expect(one).toContain(`<label><input type="radio" name="why" value="${val}"> ${words.replace(/'/g, "&#39;")}</label>`);
    expect(one).toContain('<button class="btn ghost" type="submit" id="whygo" disabled><span>Continue with Free (limited)</span></button>');
    expect(one).toContain("<span>Start Pro instead</span>");
    // it never sends anyone back to a terminal: the choice is made here
    expect(one.toLowerCase()).not.toContain("terminal");
    expect(one).toContain("<b>Shop</b> is in your account. Choose its plan to go on.");
    // the fourth: no free way on
    const fourth = await text(call(t.env, "GET", `/account/billing?project=${apps[3]!.id}`, { cookie: a.cookie }));
    expect(fourth).toContain("needs a plan: Free covers 3 projects");
    expect(fourth).not.toContain("Try for free");
    // signed out: through the sign-in, back to the same page
    const out = await call(t.env, "GET", `/account/billing?project=${apps[0]!.id}&start=1&from=cli`, {});
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe(`/login?next=${encodeURIComponent(`/account/billing?project=${apps[0]!.id}&start=1&from=cli`)}`);
    // the page waits for its payment with this
    expect(await json(call(t.env, "GET", `/api/billing?project=${apps[0]!.id}`, { cookie: a.cookie }))).toEqual({ project: { id: apps[0]!.id, plan: "free", source: null, locked: null } });
  });

  it("Try for free (limited) records the choice for that app only; the fourth cannot, and it is a browser write", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    const apps = [];
    for (const n of ["Shop", "Blog", "Docs", "Extra"]) apps.push(await createApp(t.env, a.cookie, n));
    const chosen = (id: string) => t.sql.db.prepare("SELECT plan_chosen FROM projects WHERE id = ?").get(id) as { plan_chosen: string | null };
    expect(chosen(apps[0]!.id).plan_chosen).toBeNull();
    // nobody goes on with Free without saying why: a reason from the list is needed
    expect((await call(t.env, "POST", `/api/billing/projects/${apps[0]!.id}/free`, { cookie: a.cookie, body: {} })).status).toBe(400);
    expect((await call(t.env, "POST", `/api/billing/projects/${apps[0]!.id}/free`, { cookie: a.cookie, body: { reason: "because" } })).status).toBe(400);
    expect(chosen(apps[0]!.id).plan_chosen).toBeNull();
    const told: string[] = [];
    const hook = (async (u: string | URL | Request, init?: RequestInit) => (String(u).startsWith("https://hooks.example/") ? (told.push(String(init?.body)), new Response("ok")) : new Response("no", { status: 500 }))) as never;
    const env = { ...t.env, NOTIFY_WEBHOOK: "https://hooks.example/notify" };
    const r = await call(env, "POST", `/api/billing/projects/${apps[0]!.id}/free`, { cookie: a.cookie, body: { reason: "price", note: "  too much\u0007 for a side project  " }, fetch: hook });
    expect(r.status).toBe(200);
    expect(t.sql.rows("SELECT account_id, project_id, reason, note FROM plan_feedback")).toEqual([{ account_id: a.account.id, project_id: apps[0]!.id, reason: "price", note: "too much  for a side project" }]);
    expect(told).toHaveLength(1);
    expect(JSON.parse(told[0]!)).toMatchObject({ kind: "free_chosen", reason: "price", project: apps[0]!.id, text: 'Free chosen for "Shop" (ada@example.com): It costs too much. "too much  for a side project"' });
    expect(await r.json()).toEqual({ ok: true, plan: "free" });
    expect(chosen(apps[0]!.id).plan_chosen).toMatch(/^20\d\d-\d\d-\d\dT/);
    expect(chosen(apps[1]!.id).plan_chosen).toBeNull();
    // the fourth has only the paid plan
    expect((await call(t.env, "POST", `/api/billing/projects/${apps[3]!.id}/free`, { cookie: a.cookie, body: { reason: "trying" } })).status).toBe(409);
    expect(chosen(apps[3]!.id).plan_chosen).toBeNull();
    // another account's app, and no app at all
    const b = await signedIn(t.env, "bob@example.com");
    expect((await call(t.env, "POST", `/api/billing/projects/${apps[1]!.id}/free`, { cookie: b.cookie, body: { reason: "trying" } })).status).toBe(404);
    expect(chosen(apps[1]!.id).plan_chosen).toBeNull();
    // signed out, and a GET
    expect((await call(t.env, "POST", `/api/billing/projects/${apps[1]!.id}/free`, { body: { reason: "trying" } })).status).toBe(401);
    expect((await call(t.env, "GET", `/api/billing/projects/${apps[1]!.id}/free`, { cookie: a.cookie })).status).toBe(405);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM plan_feedback")).toEqual([{ n: 1 }]);
    // the popup lists exactly the reasons the route takes
    expect(FREE_REASONS_SHOWN).toEqual(FREE_REASONS);
  });

  it("the website: an app on Free that has not chosen opens its plan page instead of its dashboard, until it has", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    const shop = await createApp(t.env, a.cookie, "Shop");
    const r = await call(t.env, "GET", `/account/apps/${shop.id}`, { cookie: a.cookie });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/account/billing?project=${shop.id}`);
    await call(t.env, "POST", `/api/billing/projects/${shop.id}/free`, { cookie: a.cookie, body: { reason: "unsure" } });
    expect((await call(t.env, "GET", `/account/apps/${shop.id}`, { cookie: a.cookie })).status).toBe(200);
    // on Team: never sent there
    const blog = await createApp(t.env, a.cookie, "Blog");
    t.sql.db.prepare("UPDATE projects SET plan = 'team', stripe_mode = 'live', subscription_id = 'sub_b', subscription_status = 'active' WHERE id = ?").run(blog.id);
    expect((await call(t.env, "GET", `/account/apps/${blog.id}`, { cookie: a.cookie })).status).toBe(200);
    // where nothing is sold, nothing to choose
    const none = setup();
    const n = await signedIn(none.env);
    const app = await createApp(none.env, n.cookie, "Docs");
    expect((await call(none.env, "GET", `/account/apps/${app.id}`, { cookie: n.cookie })).status).toBe(200);
  });

  it("an older plan link (?plan=team&start=1, from the pricing page or an older genclass command) opens the first app on Free", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    // no app yet: the trial button goes to the new app form first (its plan page follows); a plain link shows the page
    const none = await call(t.env, "GET", "/account/billing?plan=team&start=1", { cookie: a.cookie });
    expect(none.status).toBe(302);
    expect(none.headers.get("location")).toBe("/account/new");
    const page = await call(t.env, "GET", "/account/billing?plan=team", { cookie: a.cookie });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Add a project first");
    const shop = await createApp(t.env, a.cookie, "Shop");
    const blog = await createApp(t.env, a.cookie, "Blog");
    const r = await call(t.env, "GET", "/account/billing?plan=team&start=1", { cookie: a.cookie });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/account/billing?project=${shop.id}&from=cli`);
    // Shop on Team: Blog is the one
    t.sql.db.prepare("UPDATE projects SET plan = 'team', stripe_mode = 'live', subscription_id = 'sub_s', subscription_status = 'active' WHERE id = ?").run(shop.id);
    expect((await call(t.env, "GET", "/account/billing?plan=team", { cookie: a.cookie })).headers.get("location")).toBe(`/account/billing?project=${blog.id}`);
  });

  it("a project that is paid for is not deleted while it bills", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    const app = await createApp(t.env, a.cookie, "Shop");
    t.sql.db.prepare("UPDATE projects SET plan = 'team', stripe_mode = 'live', subscription_id = 'sub_s', subscription_status = 'active' WHERE id = ?").run(app.id);
    const r = await call(t.env, "DELETE", `/api/account/projects/${app.id}`, { body: { confirm: "delete" }, cookie: a.cookie });
    expect(r.status).toBe(409);
    expect((await r.json() as any).error).toContain("cancel it in Manage billing");
    t.sql.db.prepare("UPDATE projects SET subscription_status = 'canceled', plan = NULL WHERE id = ?").run(app.id);
    expect((await call(t.env, "DELETE", `/api/account/projects/${app.id}`, { body: { confirm: "delete" }, cookie: a.cookie })).status).toBe(204);
  });
});

describe("problems fixed live: 100 a month per project on Free, then observe only", () => {
  /** A page load in guard mode in which the runtime fixed `n` problems. */
  const fixes = (n: number) => Array.from({ length: n }, (_, i) => ({ t: "action", seq: i + 1, action: "coalesce", outcome: "applied" }));

  it("past the limit, ingest's reply tells the runtime to observe only; the batch is stored and counted the same; Team lifts it", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    const app = await createApp(t.env, a.cookie, "Shop");
    const first = await sendBatch(t.env, app.token, [{ t: "session", host: "shop.example", route: "/" }, ...fixes(60)], { sid: "aaaaaaaaaaaa" });
    expect(first.headers.get(OBSERVE_HEADER)).toBeNull();
    expect(first.headers.get("access-control-expose-headers")).toBe(OBSERVE_HEADER);
    await sendBatch(t.env, app.token, [{ t: "session", host: "shop.example", route: "/" }, ...fixes(60)], { sid: "bbbbbbbbbbbb" });
    resetUsageCache();
    const past = await sendBatch(t.env, app.token, [{ t: "session", host: "shop.example", route: "/" }], { sid: "cccccccccccc" });
    expect(past.status).toBe(202);
    expect(past.headers.get(OBSERVE_HEADER)).toBe("live-fix-limit");
    // what the dashboard and the CLI read
    const st = await json(call(t.env, "GET", `/api/account/projects/${app.id}/stats?range=7d`, { cookie: a.cookie }));
    expect(st.usage).toEqual({ used: 120, limit: 100, observe_only: true, resets: monthOf(new Date(st.generated)).resets });
    expect(st.plan_url).toBe(`https://genclass.dev/account/billing?project=${app.id}`);
    // the project on Team: no limit, no header
    t.sql.db.prepare("UPDATE projects SET plan = 'team', stripe_mode = 'live', subscription_status = 'active' WHERE id = ?").run(app.id);
    resetOwnerCache();
    resetUsageCache();
    const paid = await sendBatch(t.env, app.token, [{ t: "session", host: "shop.example", route: "/" }], { sid: "dddddddddddd" });
    expect(paid.headers.get(OBSERVE_HEADER)).toBeNull();
    expect((await json(call(t.env, "GET", `/api/account/projects/${app.id}/stats?range=7d`, { cookie: a.cookie }))).usage).toMatchObject({ limit: null, observe_only: false });
  });

  it("the CLI's overview names each project's plan and its page; its stats carry the usage", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    for (const n of ["a", "b", "c", "d"]) await createApp(t.env, a.cookie, n);
    const { cliToken } = await import("./account-helpers.js");
    const bearer = await cliToken(t.env, a.cookie);
    const o = await json(call(t.env, "GET", "/api/cli/overview", { bearer, origin: null }));
    expect(o.projects.map((p: any) => [p.name, p.plan.id, p.needs_plan])).toEqual([["a", "free", false], ["b", "free", false], ["c", "free", false], ["d", "free", true]]);
    expect(o.projects[0].plan_url).toBe(`https://genclass.dev/account/billing?project=${o.projects[0].id}`);
  });
});

it("FREE is the first plan", () => expect(FREE.id).toBe("free"));
it("price() still names Team's price", () => expect(price("genclass_team_monthly").id).toBe("price_team000001"));
it("setPlan is available to the tests", () => expect(typeof setPlan).toBe("function"));

describe("Pro's 3-day trial (plans.json trial_days), on an account's first subscription only (from #227)", () => {
  it("a customer with no subscription gets 3 free days; one that has had any (even cancelled) gets none", async () => {
    const b = await buyer();
    expect(PLANS.find((p) => p.id === "team")!.trial_days).toBe(3);
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: b.shop.id }, cookie: b.cookie, fetch: b.s.fetch })).status).toBe(200);
    const first = b.s.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions").pop()!;
    expect(first.form!.get("subscription_data[trial_period_days]")).toBe("3");
    expect(first.form!.get("metadata[genclass_trial_days]")).toBe("3");
    // a card is still taken up front
    expect(first.form!.get("payment_method_collection")).toBe("always");
    // the same customer once had a subscription for the other project, since cancelled
    b.s.subs.set("sub_old0000001", projectSub("sub_old0000001", b.account.id, "cus_ada0000001", b.shop.id, "canceled"));
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: b.blog.id }, cookie: b.cookie, fetch: b.s.fetch })).status).toBe(200);
    const later = b.s.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions").pop()!;
    expect(later.form!.has("subscription_data[trial_period_days]")).toBe(false);
    expect(later.form!.has("metadata[genclass_trial_days]")).toBe(false);
  });
});
