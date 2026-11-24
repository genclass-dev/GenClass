// Pro for the account again (billing/plans.json version 5, the owner's decision of 2026-11-13): Pro was US$15 a
// developer a month for up to 3 of the account's apps (oldest first), everyone on its team included; more apps are
// Enterprise's, by email. Since version 7 (2026-11-24) every plan is flat for the account: Pro US$25 a month for one
// developer and up to 3 apps, Business US$79 for the whole team and up to 10 apps; a Pro subscription bought per
// developer before keeps the seats it pays for. Free covers one app and 100 problems fixed live a month, after which the runtime is told to
// observe only. A subscription bought per project under version 4 still gives the account Pro (and its 3 apps), and
// GenClass's grants cover every app. Coverage, Checkout and its trial, the webhook, every app's plan page (Continue
// with Pro, the trial, Email us about Enterprise), the website's redirect to it, the live-fix limit at ingest, and
// what a project that is paid for cannot lose.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTokenCache } from "../src/dashboard.js";
import { ownerOf, resetOwnerCache } from "../src/paid.js";
import { accessIn, accountAccess, accountProjectsAccess, byQuantity, coverage, FREE, pitchLines, priceText, PLANS } from "../src/plans.js";
import { FREE_REASONS, trialFor } from "../src/billing.js";
import { FREE_REASONS_SHOWN } from "../src/billing-pages.js";
import { resetStripeCache, trialCancelled } from "../src/stripe.js";
import { monthOf, OBSERVE_HEADER, resetUsageCache } from "../src/usage.js";
import { esc, setupCommand } from "../src/pages.js";
import { call, cliToken, createApp, deliver, fakeStripe, GENCLASS_PORTAL, now, price, resetClock, sendBatch, setPlan, setup, signedIn, stripeEvent, subscription, WEBHOOK_SECRET } from "./account-helpers.js";

const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL };
const text = async (r: Promise<Response> | Response) => (await r).text();
const json = async (r: Promise<Response> | Response) => (await (await r).json()) as any;
type Sql = ReturnType<typeof setup>["sql"];

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
  resetUsageCache();
});

/** A version-4 subscription of one project as Stripe returns it: GenClass's Pro price, its metadata naming the project. */
const projectSub = (id: string, accountId: string, customer: string, projectId: string, status = "active") =>
  subscription(id, accountId, customer, "genclass_team_monthly", status, { metadata: { genclass: "1", genclass_account: accountId, genclass_project: projectId } });
/** The account's own Pro subscription with `seats` developers (more than 1 only when bought under version 5), as Stripe returns it. */
const accountSub = (id: string, accountId: string, customer: string, status = "active", seats = 1) =>
  subscription(id, accountId, customer, "genclass_team_monthly", status, { items: { data: [{ id: `si_${id.slice(4)}`, current_period_end: 1_792_000_000, quantity: seats, price: price("genclass_team_monthly") }] } });
/** The account on Pro, as the webhook leaves it (seats: only a subscription bought per developer under version 5 has them). */
const paidPro = (sql: Sql, accountId: string, seats: number | null = null) =>
  setPlan(sql, accountId, "team", { stripe_mode: "live", seats, subscription_id: "sub_acct000001", subscription_status: "active", current_period_end: "2026-11-13T12:00:00.000Z" });
/** One app paid for on its own, as the version-4 webhook left it. */
const projectPaid = (sql: Sql, projectId: string) =>
  sql.db.prepare("UPDATE projects SET plan = 'team', stripe_mode = 'live', subscription_id = ?, subscription_status = 'active' WHERE id = ?").run(`sub_${projectId.slice(0, 10)}`, projectId);
const chosenAt = (sql: Sql, id: string) => (sql.db.prepare("SELECT plan_chosen FROM projects WHERE id = ?").get(id) as { plan_chosen: string | null }).plan_chosen;
const sessionsOf = (s: ReturnType<typeof fakeStripe>) => s.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions").map((c) => c.form!);

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

/** An account on `LIVE` with apps of these names, oldest first. */
async function withApps(names: string[], over: Record<string, unknown> = {}) {
  const t = setup({ ...LIVE, ...over });
  const a = await signedIn(t.env);
  const apps = [];
  for (const n of names) apps.push(await createApp(t.env, a.cookie, n));
  return { ...t, ...a, apps };
}

describe("plans.json version 7: Pro and Business for the account, each flat; Pro up to 3 apps, Business up to 10", () => {
  it("Pro is $25 a month for one developer and up to 3 apps, Business $79 for the whole team and up to 10, neither sold by seats; Free covers one app and 100 live fixes a month", () => {
    const [free, team, business, enterprise] = PLANS;
    expect(priceText(team!)).toBe("$25 / month");
    expect(priceText(business!)).toBe("$79 / month");
    for (const p of [team!, business!]) {
      expect(p.per_project, p.id).toBeUndefined();
      expect(p.per_seat, p.id).toBe(false);
      expect(p.apps_per_unit, p.id).toBeUndefined();
      expect(byQuantity(p), p.id).toBe(false);
      expect(p.limits.live_fixes_per_month, p.id).toBeNull();
    }
    expect(team!.limits).toMatchObject({ apps: 3, seats: 1 });
    expect(business!.limits).toMatchObject({ apps: 10, seats: null });
    expect(free!.limits).toEqual({ apps: 1, history_days: 7, seats: 1, live_fixes_per_month: 100 });
    expect(enterprise!.limits).toMatchObject({ apps: null, live_fixes_per_month: null });
    expect(team!.features.map((f) => f.text)).toEqual(expect.arrayContaining(["Up to 3 apps", "Unlimited live fixes"]));
    expect(business!.features.map((f) => f.text)).toEqual(expect.arrayContaining(["Everything in Pro", "Up to 10 apps"]));
    expect(enterprise!.features.map((f) => f.text)).toContain("Any number of apps");
  });
});

describe("coverage: what the account's plan covers (src/plans.ts coverage, accessIn)", () => {
  const plansOf = async (t: { sql: Sql; env: any; account: { id: string } }) =>
    (await accountProjectsAccess(t.sql.api, t.account.id, t.env, now())).map((x) => x.access.locked ?? `${x.access.plan.id}${x.access.source ? `:${x.access.source}` : ""}`);

  it("Free covers the account's first app; the next waits for Pro", async () => {
    const t = await withApps(["Shop", "Blog", "Docs"]);
    expect(await plansOf(t)).toEqual(["free", "free_projects", "free_projects"]);
    const cov = await coverage(t.sql.api, t.account.id, "live", now());
    expect(cov.cap).toBe(1);
    expect(cov.access).toMatchObject({ source: null, apps: 1, plan: { id: "free" } });
    expect(cov.rows.map((r) => r.id)).toEqual(t.apps.map((a) => a.id));
    // a locked app has Free's plan and says how many the plan covers
    expect(accessIn(cov, { token: t.apps[1]!.token })).toMatchObject({ plan: { id: "free" }, source: null, locked: "free_projects", apps: 1 });
    // an app not in the list (none of the account's) gets the account's access, never a lock
    expect(accessIn(cov, { token: "gc_notthisaccountsapp0000" }).locked).toBeUndefined();
  });

  it("Pro covers the first 3 apps, oldest first, however many seats; a 4th is past it", async () => {
    const t = await withApps(["Shop", "Blog", "Docs", "Extra", "More"]);
    // one developer (version 7), or the developers a subscription bought under version 5 pays for
    for (const [seats, holds] of [[null, 1], [1, 1], [2, 2], [5, 5]] as const) {
      paidPro(t.sql, t.account.id, seats);
      expect(await plansOf(t), String(seats)).toEqual(["team:paid", "team:paid", "team:paid", "pro_apps", "pro_apps"]);
      const cov = await coverage(t.sql.api, t.account.id, "live", now());
      expect(cov.cap).toBe(3);
      expect(cov.access).toMatchObject({ source: "paid", seats: holds, apps: 3 });
    }
    // a locked app reads as Free, with the cap and the lock
    const cov = await coverage(t.sql.api, t.account.id, "live", now());
    expect(accessIn(cov, { id: t.apps[3]!.id })).toMatchObject({ plan: { id: "free" }, source: null, locked: "pro_apps", apps: 3 });
    // an app removed: the next one takes its place
    t.sql.db.prepare("DELETE FROM projects WHERE id = ?").run(t.apps[1]!.id);
    expect(await plansOf(t)).toEqual(["team:paid", "team:paid", "team:paid", "pro_apps"]);
    // bought in test mode: counts only under a test key
    setPlan(t.sql, t.account.id, "team", { stripe_mode: "test" });
    expect(await plansOf(t)).toEqual(["free", "free_projects", "free_projects", "free_projects"]);
  });

  it("Business covers the first 10 apps, oldest first, and the whole team; an 11th is past it", async () => {
    const t = await withApps(Array.from({ length: 11 }, (_, i) => `app${i}`));
    setPlan(t.sql, t.account.id, "business", { stripe_mode: "live", subscription_id: "sub_acct000001", subscription_status: "active", current_period_end: "2026-11-13T12:00:00.000Z" });
    expect(await plansOf(t)).toEqual([...Array(10).fill("business:paid"), "pro_apps"]);
    const cov = await coverage(t.sql.api, t.account.id, "live", now());
    expect(cov.cap).toBe(10);
    expect(cov.access).toMatchObject({ source: "paid", plan: { id: "business" }, seats: null, apps: 10 });
  });

  it("a version-4 subscription of one project gives the account Pro for 3 more apps: an app that pays for itself is not counted", async () => {
    const t = await withApps(["Shop", "Blog", "Docs", "Extra", "Fifth"]);
    projectPaid(t.sql, t.apps[1]!.id);
    // Blog pays for itself; Shop, Docs and Extra are Pro's 3 (under version 4 they were Free's 3: nothing is lost)
    expect(await plansOf(t)).toEqual(["team:paid", "team:paid", "team:paid", "team:paid", "pro_apps"]);
    expect((await coverage(t.sql.api, t.account.id, "live", now())).cap).toBe(3);
    projectPaid(t.sql, t.apps[2]!.id);
    expect((await coverage(t.sql.api, t.account.id, "live", now())).cap).toBe(3);
    expect(await plansOf(t)).toEqual(["team:paid", "team:paid", "team:paid", "team:paid", "team:paid"]);
    t.sql.db.prepare("UPDATE projects SET plan = NULL, subscription_id = NULL, subscription_status = NULL WHERE id = ?").run(t.apps[2]!.id);
    expect(await plansOf(t)).toEqual(["team:paid", "team:paid", "team:paid", "team:paid", "pro_apps"]);
    // an app that still pays for itself is never locked, wherever it is in the list: the 5th with its own subscription
    projectPaid(t.sql, t.apps[4]!.id);
    expect(await plansOf(t)).toEqual(["team:paid", "team:paid", "team:paid", "team:paid", "team:paid"]);
    t.sql.db.prepare("UPDATE projects SET plan = NULL, subscription_id = NULL, subscription_status = NULL WHERE id = ?").run(t.apps[4]!.id);
    // with the account's own subscription (bought under version 5) as well: still 3, Blog not counted
    paidPro(t.sql, t.account.id, 2);
    expect((await coverage(t.sql.api, t.account.id, "live", now())).cap).toBe(3);
    expect(await plansOf(t)).toEqual(["team:paid", "team:paid", "team:paid", "team:paid", "pro_apps"]);
    // a cancelled one is gone: the account is on Free again
    t.sql.db.prepare("UPDATE projects SET plan = NULL, subscription_status = 'canceled' WHERE account_id = ?").run(t.account.id);
    setPlan(t.sql, t.account.id, "free", { subscription_status: "canceled" });
    expect(await plansOf(t)).toEqual(["free", "free_projects", "free_projects", "free_projects", "free_projects"]);
  });

  it("GenClass's grant covers every app: the account's (Enterprise or Pro), or one copied onto an app", async () => {
    const t = await withApps(["a", "b", "c", "d", "e"]);
    const later = "9999-12-31T00:00:00.000Z";
    setPlan(t.sql, t.account.id, "free", { comp_until: later });
    expect(await plansOf(t)).toEqual(Array(5).fill("enterprise:comp"));
    expect((await coverage(t.sql.api, t.account.id, "live", now())).cap).toBeNull();
    setPlan(t.sql, t.account.id, "free", { comp_plan: "team" });
    expect(await plansOf(t)).toEqual(Array(5).fill("team:comp"));
    // over a paid Pro too: a grant of Enterprise is listed later, and has no cap
    paidPro(t.sql, t.account.id);
    setPlan(t.sql, t.account.id, "team", { comp_until: later, comp_plan: null });
    expect(await plansOf(t)).toEqual(Array(5).fill("enterprise:comp"));
    // a grant migration 0016 copied onto one app
    setPlan(t.sql, t.account.id, "free", { comp_until: null, comp_plan: null, stripe_mode: null, subscription_id: null, subscription_status: null });
    t.sql.db.prepare("UPDATE projects SET comp_until = ?, comp_plan = 'team' WHERE id = ?").run(later, t.apps[4]!.id);
    expect(await plansOf(t)).toEqual(Array(5).fill("team:comp"));
    // ended: Free again
    t.sql.db.prepare("UPDATE projects SET comp_until = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(t.apps[4]!.id);
    expect(await plansOf(t)).toEqual(["free", "free_projects", "free_projects", "free_projects", "free_projects"]);
  });

  it("PLAN_GATES open: every app has the grant plan, nothing locked", async () => {
    const t = await withApps(["a", "b", "c", "d"], { PLAN_GATES: "open" });
    expect(await plansOf(t)).toEqual(Array(4).fill("enterprise:open"));
  });

  it("ingest's owner (src/paid.ts ownerOf) has the account's plan for a covered app and Free's for an app past the cap", async () => {
    const t = await withApps(["Shop", "Blog", "Docs", "Extra"]);
    const planOf = async (i: number) => {
      resetOwnerCache();
      return (await ownerOf(t.sql.api, t.apps[i]!.token, now().getTime(), "live"))!.plan.id;
    };
    // Free: the first app's plan is Free, and so is every other's
    expect([await planOf(0), await planOf(1)]).toEqual(["free", "free"]);
    paidPro(t.sql, t.account.id);
    expect([await planOf(0), await planOf(1), await planOf(2), await planOf(3)]).toEqual(["team", "team", "team", "free"]);
    const owner = await ownerOf(t.sql.api, t.apps[3]!.token, now().getTime(), "live");
    expect(owner).toMatchObject({ projectId: t.apps[3]!.id, accountId: t.account.id, name: "Extra" });
    // the grant covers it
    setPlan(t.sql, t.account.id, "team", { comp_until: "9999-12-31T00:00:00.000Z" });
    expect(await planOf(3)).toBe("enterprise");
    // an app with no account is Free's
    const anon = (await (await call(t.env, "POST", "/api/projects", { body: { name: "anon" }, origin: null })).json()) as any;
    resetOwnerCache();
    expect((await ownerOf(t.sql.api, anon.token, now().getTime(), "live"))!.plan.id).toBe("free");
  });

  it("an app past the cap does not forward its batches: only the covered apps' destinations get them", async () => {
    const t = await withApps(["Shop", "Blog", "Docs", "Extra"], { INTEGRATIONS_KEY: Buffer.from(new Uint8Array(32).map((_, i) => i * 7 + 1)).toString("base64") });
    paidPro(t.sql, t.account.id);
    const slack = "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX";
    // a destination set up while the 4th app was covered (on Enterprise's grant), then the grant ended
    setPlan(t.sql, t.account.id, "team", { comp_until: "9999-12-31T00:00:00.000Z" });
    for (const i of [0, 3]) expect((await call(t.env, "PUT", `/api/account/projects/${t.apps[i]!.id}/integrations/slack`, { body: { url: slack }, cookie: t.cookie })).status, String(i)).toBe(200);
    setPlan(t.sql, t.account.id, "team", { comp_until: null });
    resetOwnerCache();
    const sent: string[] = [];
    const f = (async (url: string) => (sent.push(String(url)), new Response("ok"))) as never;
    const { detection } = await import("./account-helpers.js");
    await sendBatch(t.env, t.apps[0]!.token, [{ t: "session", host: "shop.example", route: "/" }, ...detection()], { sid: "aaaaaaaaaaaa", fetch: f });
    const covered = sent.length;
    expect(covered).toBeGreaterThan(0);
    await sendBatch(t.env, t.apps[3]!.token, [{ t: "session", host: "extra.example", route: "/" }, ...detection()], { sid: "bbbbbbbbbbbb", fetch: f });
    expect(sent.length).toBe(covered);
  });
});

describe("checkout for the account (POST /api/billing/checkout { plan, seats?, project_id? })", () => {
  it("Pro is bought for the account: one, flat (no quantity to adjust on Stripe); the session names no project", async () => {
    const b = await buyer();
    const r = await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch });
    expect(r.status).toBe(200);
    const [form] = sessionsOf(b.s);
    expect(Object.fromEntries(form!)).toMatchObject({
      mode: "subscription",
      customer: "cus_ada0000001",
      client_reference_id: b.account.id,
      "line_items[0][price]": "price_team000001",
      "line_items[0][quantity]": "1",
      allow_promotion_codes: "true",
      "metadata[genclass_plan]": "team",
      "subscription_data[metadata][genclass_account]": b.account.id,
      // no app's plan page asked: back to the account's billing page
      success_url: "https://genclass.dev/account/billing?done=1",
      cancel_url: "https://genclass.dev/account/billing",
    });
    // Pro is flat since version 7: nothing to adjust, no seats
    expect(form!.has("line_items[0][adjustable_quantity][enabled]")).toBe(false);
    expect(form!.has("metadata[genclass_seats]")).toBe(false);
    // an account subscription: the webhook writes the account, never one app
    expect(form!.has("metadata[genclass_project]")).toBe(false);
    expect(form!.has("subscription_data[metadata][genclass_project]")).toBe(false);
  });

  it("started from an app's plan page: Stripe returns there; a flat plan is one, whatever seats are sent; another account's app is no page to return to", async () => {
    const b = await buyer();
    const done = () => {
      for (const x of b.s.sessions.values()) x.status = "complete";
    };
    const r = await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: b.blog.id }, cookie: b.cookie, fetch: b.s.fetch });
    expect(r.status).toBe(200);
    expect(Object.fromEntries(sessionsOf(b.s)[0]!)).toMatchObject({
      success_url: `https://genclass.dev/account/billing?project=${b.blog.id}&done=1`,
      cancel_url: `https://genclass.dev/account/billing?project=${b.blog.id}`,
      "line_items[0][quantity]": "1",
    });
    // the page's project is where to come back to, not what is bought
    expect(sessionsOf(b.s)[0]!.has("metadata[genclass_project]")).toBe(false);
    done();
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: b.shop.id, seats: 4 }, cookie: b.cookie, fetch: b.s.fetch })).status).toBe(200);
    expect(Object.fromEntries(sessionsOf(b.s)[1]!)).toMatchObject({ "line_items[0][quantity]": "1", success_url: `https://genclass.dev/account/billing?project=${b.shop.id}&done=1` });
    expect(sessionsOf(b.s)[1]!.has("metadata[genclass_seats]")).toBe(false);
    done();
    const other = await signedIn(b.env, "bob@example.com");
    const theirs = await createApp(b.env, other.cookie, "Theirs");
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: theirs.id }, cookie: b.cookie, fetch: b.s.fetch })).status).toBe(200);
    expect(Object.fromEntries(sessionsOf(b.s)[2]!)).toMatchObject({ success_url: "https://genclass.dev/account/billing?done=1", cancel_url: "https://genclass.dev/account/billing" });
    expect(JSON.stringify([...sessionsOf(b.s)[2]!])).not.toContain(theirs.id);
    // a browser write only: a terminal and another origin are refused before Stripe is asked
    const before = b.s.calls.length;
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, origin: "https://evil.example", fetch: b.s.fetch })).status).toBe(403);
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, fetch: b.s.fetch })).status).toBe(401);
    expect(b.s.calls.length).toBe(before);
  });

  it("an account on Pro cannot buy it again, and moves to Business by a switch; a server that sells nothing sells nothing", async () => {
    const b = await buyer();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sub = accountSub("sub_ada0000001", b.account.id, "cus_ada0000001");
    b.s.subs.set(sub.id, sub);
    expect(await json(deliver(b.env, stripeEvent("customer.subscription.created", sub), b.s.fetch))).toEqual({ received: true, result: "applied" });
    // Pro is flat (version 7): no seat count is written
    expect(b.sql.rows("SELECT plan, seats, subscription_id FROM accounts")[0]).toEqual({ plan: "team", seats: null, subscription_id: "sub_ada0000001" });
    const again = await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: b.shop.id }, cookie: b.cookie, fetch: b.s.fetch });
    expect(again.status).toBe(409);
    expect((await again.json() as any).error).toBe("you are already on the Pro plan");
    expect(sessionsOf(b.s)).toEqual([]);
    // Business is a switch: a Checkout that replaces the Pro subscription once it is paid, with no days free
    const up = await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "business" }, cookie: b.cookie, fetch: b.s.fetch });
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//), switch: true });
    const [form] = sessionsOf(b.s);
    expect(Object.fromEntries(form!)).toMatchObject({
      "line_items[0][price]": "price_busi000001",
      "line_items[0][quantity]": "1",
      "metadata[genclass_plan]": "business",
      "metadata[genclass_switch_from]": "sub_ada0000001",
      success_url: "https://genclass.dev/account/billing?done=1&to=business",
    });
    expect(form!.has("subscription_data[trial_period_days]")).toBe(false);
    log.mockRestore();
    const none = setup();
    const a = await signedIn(none.env);
    expect((await call(none.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: a.cookie, fetch: b.s.fetch })).status).toBe(503);
  });
});

describe("the trial of Pro and Business: 7 days free at Checkout, once per account (src/billing.ts trialFor, the owner's decision of 2026-11-12)", () => {
  const checkout = (b: Awaited<ReturnType<typeof buyer>>, projectId: string, extra: Record<string, unknown> = {}) =>
    call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: projectId, ...extra }, cookie: b.cookie, fetch: b.s.fetch });

  it("the first purchase starts with 7 days free; once the account has had a subscription, no purchase does", async () => {
    const b = await buyer();
    const first = await checkout(b, b.shop.id);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//), trial_days: 7 });
    const [form] = sessionsOf(b.s);
    expect(form!.get("subscription_data[trial_period_days]")).toBe("7");
    expect(form!.get("metadata[genclass_trial_days]")).toBe("7");
    // the card is taken at Checkout, and the "Add promotion code" field is there
    expect(form!.get("payment_method_collection")).toBe("always");
    expect(form!.get("allow_promotion_codes")).toBe("true");
    // Checkout is completed (Stripe closes the page) and the account's subscription is written by the webhook, in
    // its trial: every app the plan covers goes on with Pro
    b.s.sessions.get("cs_test_000001")!.status = "complete";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // the card Checkout took (a trial without one is never written)
    const trialing = { ...accountSub("sub_ada0000001", b.account.id, "cus_ada0000001", "trialing"), default_payment_method: "pm_card00000001" };
    b.s.subs.set(trialing.id, trialing);
    expect(await json(deliver(b.env, stripeEvent("customer.subscription.created", trialing), b.s.fetch))).toEqual({ received: true, result: "applied" });
    expect(b.sql.rows("SELECT plan, subscription_status FROM accounts")[0]).toEqual({ plan: "team", subscription_status: "trialing" });
    expect(await text(call(b.env, "GET", `/account/billing?project=${b.blog.id}`, { cookie: b.cookie }))).toContain("<span>Continue with Pro</span>");
    // it is cancelled: the account is on Free again, and no purchase starts another trial
    const ended = accountSub("sub_ada0000001", b.account.id, "cus_ada0000001", "canceled");
    b.s.subs.set(ended.id, ended);
    expect((await json(deliver(b.env, stripeEvent("customer.subscription.deleted", ended), b.s.fetch))).result).toBe("applied");
    const again = await checkout(b, b.blog.id);
    expect(again.status).toBe(200);
    expect((await again.json() as any).trial_days).toBeNull();
    expect(sessionsOf(b.s)[1]!.has("subscription_data[trial_period_days]")).toBe(false);
    expect(sessionsOf(b.s)[1]!.get("allow_promotion_codes")).toBe("true");
    // nor does Business: the trial is the account's, whichever plan it was taken on
    const business = await checkout(b, b.blog.id, { plan: "business" });
    expect(business.status).toBe(200);
    expect((await business.json() as any).trial_days).toBeNull();
    expect(sessionsOf(b.s)[2]!.has("subscription_data[trial_period_days]")).toBe(false);
    // the plan page offers Pro, not a trial
    const page = await text(call(b.env, "GET", `/account/billing?project=${b.shop.id}`, { cookie: b.cookie }));
    expect(page).toContain('data-plan="team" data-pick><span>Start Pro</span>');
    expect(page).not.toContain("free trial");
    expect(page).not.toContain('class="trialnote"');
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
    expect((await fresh.json() as any).trial_days).toBe(7);
    expect(sessionsOf(s)[0]!.get("subscription_data[trial_period_days]")).toBe("7");
  });

  it("one trial per account: a second app's page while the first's Checkout is open gets that same page; another plan closes it for a new one", async () => {
    const b = await buyer();
    const first = await checkout(b, b.shop.id);
    expect((await first.json() as any).trial_days).toBe(7);
    // the shop's page is still open: the blog's plan page gets the same Stripe page, so there is one trial to take
    const second = await checkout(b, b.blog.id);
    expect(await second.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_000001", trial_days: 7 });
    expect(sessionsOf(b.s)).toHaveLength(1);
    // Pro is flat: seats sent change nothing, the same page again
    expect(await (await checkout(b, b.blog.id, { seats: 2 })).json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_000001", trial_days: 7 });
    // Business instead: the open page is closed and one new page opened, still the account's one trial
    const more = await checkout(b, b.blog.id, { plan: "business" });
    expect(await more.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_000002", trial_days: 7 });
    expect(b.s.sessions.get("cs_test_000001")!.status).toBe("expired");
    expect([...b.s.sessions.values()].filter((x) => x.status === "open").map((x) => x.id)).toEqual(["cs_test_000002"]);
  });

  it("trialFor: the plan's trial_days for an account with no subscription anywhere; 0 for a plan without one, a past subscription, or one on Stripe", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    const app = await createApp(t.env, a.cookie, "Shop");
    const pro = PLANS.find((p) => p.id === "team")!;
    expect(pro.trial_days).toBe(7);
    expect(await trialFor(t.sql.api, a.account.id, pro)).toBe(7);
    // subscriptions Stripe lists for the customer (any status)
    expect(await trialFor(t.sql.api, a.account.id, pro, 1)).toBe(0);
    // a plan with no trial, or a trial that is not a whole number of days
    expect(await trialFor(t.sql.api, a.account.id, FREE)).toBe(0);
    for (const trial_days of [0, -3, 1.5, undefined]) expect(await trialFor(t.sql.api, a.account.id, { ...pro, trial_days }), String(trial_days)).toBe(0);
    // a project's subscription (version 4), cancelled or not
    t.sql.db.prepare("UPDATE projects SET subscription_id = 'sub_p', subscription_status = 'canceled' WHERE id = ?").run(app.id);
    expect(await trialFor(t.sql.api, a.account.id, pro)).toBe(0);
    t.sql.db.prepare("UPDATE projects SET subscription_id = NULL, subscription_status = NULL WHERE id = ?").run(app.id);
    expect(await trialFor(t.sql.api, a.account.id, pro)).toBe(7);
    // the account's own subscription
    setPlan(t.sql, a.account.id, "free", { subscription_id: "sub_old", subscription_status: "canceled" });
    expect(await trialFor(t.sql.api, a.account.id, pro)).toBe(0);
    // another account's subscription is not this one's
    const b = await signedIn(t.env, "bob@example.com");
    expect(await trialFor(t.sql.api, b.account.id, pro)).toBe(7);
  });
});

describe("Pro's trial: a cancel during the 7 free days ends the trial and Pro at once (src/stripe.ts trialCancelled, the owner's call of 2026-11-15)", () => {
  /** The trial's end, which is also its first period's end: 29 h 46 min after T0. */
  const END = 1_792_000_000;
  const DAY_S = 86_400;
  /** Stripe as it cancels a subscription: status canceled, ended now. */
  const ending = (s: ReturnType<typeof fakeStripe>): typeof s.fetch => async (u, init = {}) => {
    const r = await s.fetch(u, init);
    const id = /\/v1\/subscriptions\/([^/?]+)$/.exec(new URL(u).pathname)?.[1];
    if (init.method === "DELETE" && id && s.subs.has(id)) s.subs.get(id)!.ended_at = Math.floor(now().getTime() / 1000);
    return r;
  };
  /** An account whose Pro subscription is in its trial (with the card Checkout took), as the webhook wrote it. */
  async function inTrial() {
    const b = await buyer();
    const fetch = ending(b.s);
    const sub: Record<string, any> = { ...accountSub("sub_ada0000001", b.account.id, "cus_ada0000001", "trialing"), default_payment_method: "pm_card00000001", trial_start: END - 7 * DAY_S, trial_end: END };
    b.s.subs.set(sub.id, sub);
    expect((await json(deliver(b.env, stripeEvent("customer.subscription.created", sub), fetch))).result).toBe("applied");
    const row = () => b.sql.rows("SELECT plan, subscription_id, subscription_status, cancel_at_period_end FROM accounts")[0];
    const cancels = () => b.s.calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname);
    const pro = async () => json(call(b.env, "GET", "/api/billing/pro", { cookie: b.cookie, origin: null }));
    const send = async (type: string, f = fetch) => {
      const r = await deliver(b.env, stripeEvent(type, b.s.subs.get("sub_ada0000001")!), f);
      return { status: r.status, body: await r.json() as any };
    };
    expect(row()).toEqual({ plan: "team", subscription_id: "sub_ada0000001", subscription_status: "trialing", cancel_at_period_end: 0 });
    return { ...b, fetch, sub, row, cancels, pro, send };
  }

  it("trialCancelled: a trialing subscription set to cancel by its trial's end; never one set to cancel later, or past its trial", () => {
    const trial = { status: "trialing", trial_end: END, cancel_at_period_end: false, cancel_at: null };
    expect(trialCancelled(trial)).toBe(false);
    // the portal with flexible billing: cancel_at at the period end, the trial's end
    expect(trialCancelled({ ...trial, cancel_at: END })).toBe(true);
    expect(trialCancelled({ ...trial, cancel_at: END - DAY_S })).toBe(true);
    // classic billing (or the API): cancel_at_period_end
    expect(trialCancelled({ ...trial, cancel_at_period_end: true })).toBe(true);
    // a cancel set after a paid month (by hand in the Stripe dashboard): left to Stripe
    expect(trialCancelled({ ...trial, cancel_at: END + 30 * DAY_S })).toBe(false);
    // no trial end to compare with
    expect(trialCancelled({ ...trial, trial_end: null, cancel_at: END })).toBe(false);
    // past the trial, a paid plan cancelled in the portal runs to the end of its paid month: never this
    for (const status of ["active", "past_due", "canceled", "incomplete", "unpaid"]) {
      expect(trialCancelled({ ...trial, status, cancel_at: END }), status).toBe(false);
      expect(trialCancelled({ ...trial, status, cancel_at_period_end: true }), status).toBe(false);
    }
  });

  it("the trial's plan page says that a cancel ends Pro at once and charges nothing", async () => {
    const t = await inTrial();
    const page = await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }));
    expect(page).toContain("in a trial until");
    expect(page).toContain("Cancel before then and nothing is charged; Pro then ends at once.");
  });

  it("cancelled in Stripe's portal (flexible billing: cancel_at at the trial's end): Stripe cancels it now, the account is on Free, and no second trial", async () => {
    const t = await inTrial();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await t.pro()).toMatchObject({ pro: true, via: "plan" });
    t.sub.cancel_at = END;
    expect(await t.send("customer.subscription.updated")).toEqual({ status: 200, body: { received: true, result: "applied" } });
    // cancelled at once (no proration, no final invoice: nothing was paid, so nothing is refunded), then read back
    expect(t.cancels()).toEqual(["/v1/subscriptions/sub_ada0000001"]);
    expect(new URLSearchParams(t.s.calls.find((c) => c.method === "DELETE")!.url.search).toString()).toBe("");
    expect(t.s.calls.slice(-2).map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["DELETE /v1/subscriptions/sub_ada0000001", "GET /v1/subscriptions/sub_ada0000001"]);
    expect(t.s.calls.some((c) => c.url.pathname.startsWith("/v1/refunds"))).toBe(false);
    // Pro is gone now, not at the trial's end
    expect(t.row()).toEqual({ plan: "free", subscription_id: "sub_ada0000001", subscription_status: "canceled", cancel_at_period_end: 0 });
    expect(t.sql.rows("SELECT current_period_end FROM accounts")[0]).toEqual({ current_period_end: new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString() });
    expect(await t.pro()).toEqual({ ok: true, pro: false, via: null, trial_days: null });
    expect(log.mock.calls.flat().join("\n")).toContain("subscription sub_ada0000001 was cancelled in its trial; ended it now");
    // the customer.subscription.deleted that follows writes the same, and cancels nothing again
    expect(await t.send("customer.subscription.deleted")).toEqual({ status: 200, body: { received: true, result: "applied" } });
    expect(t.cancels()).toHaveLength(1);
    expect(t.row()).toMatchObject({ plan: "free", subscription_status: "canceled" });
    // the plan page offers Pro without a trial: one trial per account
    const page = await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }));
    expect(page).toContain("You are on the <b>Free</b> plan.");
    expect(page).not.toContain("free trial");
    const again = await call(t.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: t.cookie, fetch: t.s.fetch });
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).trial_days).toBeNull();
    log.mockRestore();
  });

  it("cancelled with cancel_at_period_end (classic billing, or the API): the same, ended now", async () => {
    const t = await inTrial();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    t.sub.cancel_at_period_end = true;
    expect((await t.send("customer.subscription.updated")).body.result).toBe("applied");
    expect(t.cancels()).toEqual(["/v1/subscriptions/sub_ada0000001"]);
    expect(t.row()).toMatchObject({ plan: "free", subscription_status: "canceled", cancel_at_period_end: 0 });
    log.mockRestore();
  });

  it("whichever event brings it: an invoice.paid or a redelivery after the cancel finds it cancelled, and cancels nothing again", async () => {
    const t = await inTrial();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    t.sub.cancel_at = END;
    // the trial's $0 invoice paid, delivered after the cancel: the subscription as Stripe has it now is what counts
    const inv = { id: "in_trial000001", object: "invoice", customer: "cus_ada0000001", status: "paid", amount_due: 0, amount_paid: 0, parent: { subscription_details: { subscription: "sub_ada0000001", metadata: { genclass: "1" } } }, lines: { data: [] } };
    expect((await json(deliver(t.env, stripeEvent("invoice.paid", inv), t.fetch))).result).toBe("applied");
    expect(t.cancels()).toEqual(["/v1/subscriptions/sub_ada0000001"]);
    expect(t.row()).toMatchObject({ plan: "free", subscription_status: "canceled" });
    expect((await t.send("customer.subscription.updated")).body.result).toBe("applied");
    expect(t.cancels()).toHaveLength(1);
    log.mockRestore();
  });

  it("a cancel Stripe fails answers 500 and changes nothing; Stripe's retry ends the trial", async () => {
    const t = await inTrial();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = 1;
    const flaky: typeof t.fetch = async (u, init = {}) =>
      init.method === "DELETE" && fail-- > 0 ? new Response(JSON.stringify({ error: { message: "Stripe is having trouble" } }), { status: 500 }) : t.fetch(u, init);
    t.sub.cancel_at = END;
    const ev = stripeEvent("customer.subscription.updated", t.sub);
    expect((await deliver(t.env, ev, flaky)).status).toBe(500);
    expect(t.row()).toMatchObject({ plan: "team", subscription_status: "trialing", cancel_at_period_end: 0 });
    expect(t.s.subs.get("sub_ada0000001")!.status).toBe("trialing");
    // the same event again, as Stripe delivers it
    expect(await json(deliver(t.env, ev, flaky))).toEqual({ received: true, result: "applied" });
    expect(t.row()).toMatchObject({ plan: "free", subscription_status: "canceled" });
    log.mockRestore();
    err.mockRestore();
  });

  it("a trial set to cancel after a paid month (by hand in the Stripe dashboard) is left to Stripe", async () => {
    const t = await inTrial();
    t.sub.cancel_at = END + 30 * DAY_S;
    expect((await t.send("customer.subscription.updated")).body.result).toBe("applied");
    expect(t.cancels()).toEqual([]);
    expect(t.row()).toEqual({ plan: "team", subscription_id: "sub_ada0000001", subscription_status: "trialing", cancel_at_period_end: 1 });
  });

  it("unchanged for a paid plan: cancelled in the portal, Pro runs to the end of the paid month and nothing is cancelled now", async () => {
    const b = await buyer();
    // past its trial: active, its first month paid
    const sub: Record<string, any> = { ...accountSub("sub_ada0000001", b.account.id, "cus_ada0000001", "active"), trial_start: END - 37 * DAY_S, trial_end: END - 30 * DAY_S };
    b.s.subs.set(sub.id, sub);
    expect((await json(deliver(b.env, stripeEvent("customer.subscription.created", sub), b.s.fetch))).result).toBe("applied");
    const row = () => b.sql.rows("SELECT plan, subscription_status, current_period_end, cancel_at_period_end FROM accounts")[0];
    // the portal with flexible billing (cancel_at), then classic (cancel_at_period_end)
    for (const cancel of [{ cancel_at: END, cancel_at_period_end: false }, { cancel_at: null, cancel_at_period_end: true }]) {
      Object.assign(sub, cancel);
      expect((await json(deliver(b.env, stripeEvent("customer.subscription.updated", sub), b.s.fetch))).result).toBe("applied");
      expect(row()).toEqual({ plan: "team", subscription_status: "active", current_period_end: new Date(END * 1000).toISOString(), cancel_at_period_end: 1 });
    }
    expect(b.s.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(await json(call(b.env, "GET", "/api/billing/pro", { cookie: b.cookie, origin: null }))).toMatchObject({ pro: true, via: "plan" });
    expect(await text(call(b.env, "GET", "/account/billing", { cookie: b.cookie }))).toContain("It is cancelled and will not renew; you can resume it below before then.");
    // Stripe ends it at the period end: Free then
    sub.status = "canceled";
    expect((await json(deliver(b.env, stripeEvent("customer.subscription.deleted", sub), b.s.fetch))).result).toBe("applied");
    expect(row()).toMatchObject({ plan: "free", subscription_status: "canceled", cancel_at_period_end: 0 });
    expect(b.s.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("a version-4 project's subscription cancelled in its trial ends now too; the account row is not touched", async () => {
    const b = await buyer();
    const fetch = ending(b.s);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sub: Record<string, any> = { ...projectSub("sub_shop000001", b.account.id, "cus_ada0000001", b.shop.id!, "trialing"), default_payment_method: "pm_card00000001", trial_end: END };
    b.s.subs.set(sub.id, sub);
    expect((await json(deliver(b.env, stripeEvent("customer.subscription.created", sub), fetch))).result).toBe("applied");
    expect(b.sql.rows("SELECT plan, subscription_status FROM projects WHERE name = 'Shop'")[0]).toEqual({ plan: "team", subscription_status: "trialing" });
    sub.cancel_at = END;
    expect((await json(deliver(b.env, stripeEvent("customer.subscription.updated", sub), fetch))).result).toBe("applied");
    expect(b.s.calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname)).toEqual(["/v1/subscriptions/sub_shop000001"]);
    expect(b.sql.rows("SELECT plan, subscription_status, cancel_at_period_end FROM projects WHERE name = 'Shop'")[0]).toEqual({ plan: null, subscription_status: "canceled", cancel_at_period_end: 0 });
    expect(b.sql.rows("SELECT plan, subscription_id FROM accounts")[0]).toEqual({ plan: "free", subscription_id: null });
    log.mockRestore();
  });
});

describe("the webhook still writes a version-4 project's subscription to that project and touches nothing else", () => {
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
    // the account has Pro: 90 days of history, visitor analytics
    const st = await json(call(b.env, "GET", `/api/account/projects/${b.shop.id}/stats?range=90d`, { cookie: b.cookie }));
    expect(st.range).toBe("90d");
    expect(st.plan).toEqual({ id: "team", name: "Pro", source: "paid" });
    expect(st.locked).toBeUndefined();
    // one subscription ends: the other still gives the account Pro; both ended, Free again
    expect(await apply(projectSub("sub_shop000001", b.account.id, "cus_ada0000001", b.shop.id!, "canceled"), "customer.subscription.deleted")).toEqual({ received: true, result: "applied" });
    expect(b.sql.rows("SELECT plan, subscription_status FROM projects WHERE name = 'Shop'")[0]).toEqual({ plan: null, subscription_status: "canceled" });
    expect((await json(call(b.env, "GET", `/api/account/projects/${b.shop.id}/stats?range=90d`, { cookie: b.cookie }))).range).toBe("90d");
    expect(await apply(projectSub("sub_blog000001", b.account.id, "cus_ada0000001", b.blog.id!, "canceled"), "customer.subscription.deleted")).toEqual({ received: true, result: "applied" });
    resetOwnerCache();
    expect((await json(call(b.env, "GET", `/api/account/projects/${b.shop.id}/stats?range=90d`, { cookie: b.cookie }))).range).toBe("7d");
    log.mockRestore();
  });

  it("a second live subscription for a project that has one is not written and not cancelled; the owner is told", async () => {
    const b = await buyer();
    const told: string[] = [];
    const env = { ...b.env, NOTIFY_WEBHOOK: "https://hooks.example/notify" };
    const s = fakeStripe({ answer: (url, init) => (url.hostname === "hooks.example" ? (told.push(String(init.body)), new Response("ok")) : undefined) });
    s.genclassCustomer("cus_ada0000001", b.account.id);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
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

describe("an app past what the plan covers waits on its plan page (Free: one app; Pro: 3)", () => {
  it("a second app on Free is created, and its dashboard is locked with the way to its plan page; Pro opens it, and a 4th waits", async () => {
    const t = await withApps(["a", "b", "c", "d"]);
    const stats = (i: number) => call(t.env, "GET", `/api/account/projects/${t.apps[i]!.id}/stats?range=7d`, { cookie: t.cookie });
    expect((await stats(0)).status).toBe(200);
    const locked = await stats(1);
    expect(locked.status).toBe(402);
    expect(await locked.json()).toMatchObject({ locked: true, needs_plan: true, upgrade_url: `https://genclass.dev/account/billing?project=${t.apps[1]!.id}` });
    // the account on Pro: its first 3 apps open; the 4th is past them
    paidPro(t.sql, t.account.id);
    resetOwnerCache();
    expect([(await stats(1)).status, (await stats(2)).status]).toEqual([200, 200]);
    const past = await stats(3);
    expect(past.status).toBe(402);
    // past Pro's 3: the app's plan page, which says more apps are Enterprise's
    const pj = await past.json();
    expect(pj).toMatchObject({ ok: false, locked: true, needs_plan: true, upgrade_url: `https://genclass.dev/account/billing?project=${t.apps[3]!.id}` });
    expect(pj.error).toContain("your plan covers 3 apps, and this one is past them: more apps come with Business or Enterprise");
    // the page polling for a payment reads the lock
    expect(await json(call(t.env, "GET", `/api/billing?project=${t.apps[3]!.id}`, { cookie: t.cookie }))).toEqual({ project: { id: t.apps[3]!.id, plan: "free", source: null, locked: "pro_apps" } });
    expect(await json(call(t.env, "GET", `/api/billing?project=${t.apps[0]!.id}`, { cookie: t.cookie }))).toEqual({ project: { id: t.apps[0]!.id, plan: "team", source: "paid", locked: null } });
  });

  it("the billing page lists each app with its plan and sells Pro and Business for the account", async () => {
    const t = await withApps(["Shop", "Blog"]);
    const page = await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }));
    expect(page).toContain('<p class="price">$25 / month</p>');
    expect(page).toContain('data-plan="team"><span>Upgrade to Pro</span>');
    expect(page).toContain('<p class="price">$79 / month</p>');
    expect(page).toContain('data-plan="business"><span>Upgrade to Business</span>');
    expect(page).not.toContain("Choose a project");
    expect(page).toContain('id="projects"');
    expect(page).toContain("<tr><td>Shop</td><td>Free</td>");
    expect(page).toContain("<tr><td>Blog</td><td><span class=\"tag\" style=\"color:var(--warn);border-color:var(--warn)\">Needs a plan</span>");
    paidPro(t.sql, t.account.id);
    const paid = await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }));
    expect(paid).toContain("<tr><td>Blog</td><td><b>Pro</b></td>");
  });

  it("the plan page, Free and covered: Pro large with the trial, Free small with the reason popup", async () => {
    const t = await withApps(["Shop", "Blog"]);
    const one = await text(call(t.env, "GET", `/account/billing?project=${t.apps[0]!.id}&from=cli`, { cookie: t.cookie }));
    expect(one).toContain("<h1>Choose a plan for Shop</h1>");
    // a just-added app: one short line under the heading, no notice box and no "0 of 100" (the owner, 2026-11-13: less written)
    expect(one).toContain('<p class="status" id="status"><b>Shop</b> is in your account.</p>');
    expect(one).not.toContain("Choose its plan to go on");
    expect(one).not.toContain("Problems fixed live this month");
    // the card: the name, the price, the first 5 lines, the rest folded under "N more"; no summary repeating the price
    expect(one).toContain('<div class="plan pick big"><h3>Pro</h3><p class="price">$25 / month</p><ul><li>Up to 3 apps</li><li>The genclass command in your terminal</li>');
    const lines = pitchLines(PLANS[1]!);
    expect(one).toContain(`<details class="pmore"><summary>${lines.length - 5} more</summary><ul>${lines.slice(5).map((l) => `<li>${l.replace(/'/g, "&#39;")}</li>`).join("")}</ul></details>`);
    expect(one).not.toContain("<li>Everything in Free</li>");
    expect(one).not.toContain("<li>7 days free to start</li>");
    expect(one).not.toContain('<p class="sum">');
    // an account that has never had a subscription starts with Pro's 7 days free (billing.ts trialFor)
    expect(one).toContain('<button class="btn" type="button" data-plan="team" data-pick><span>Start your 7-day free trial</span></button>');
    expect(one).toContain('<p class="trialnote">7 days free, then $25 / month. Cancel before the trial ends and you pay nothing.</p>');
    expect(one).not.toContain('type="button" data-continue>');
    expect(one).not.toContain('<span class="tag">Your plan</span>');
    // Free is the small way on: a very small link under the big card, and a popup that asks why before it goes on
    expect(one).toContain('<p class="free"><a href="#why" class="linkish" id="free">Skip</a></p>');
    expect(one).toContain(".linkish{background:none;border:0;padding:0;font:inherit;font-size:11px");
    expect(one).toContain('<h2 id="whyh">What\'s stopping you from paying?</h2>');
    for (const [val, words] of FREE_REASONS) expect(one).toContain(`<label><input type="radio" name="why" value="${val}"> ${words.replace(/'/g, "&#39;")}</label>`);
    expect(one).toContain('<button class="btn ghost" type="submit" id="whygo" disabled><span>Continue with Free (limited)</span></button>');
    expect(one).toContain("<span>Start Pro instead</span>");
    // the Checkout is bought for the account, from this page (it comes back here)
    expect(one).toContain('gcPost("/api/billing/checkout", { plan: b.getAttribute("data-plan"), project_id: cfg.project })');
    // it never sends anyone back to a terminal: the choice is made here (Pro's card lists the command as a feature)
    expect(one).toContain("<li>The genclass command in your terminal</li>");
    expect(one.replace("<li>The genclass command in your terminal</li>", "").toLowerCase()).not.toContain("terminal");
    // ?start=1 (the genclass command) opens the trial's Checkout at once
    expect(await text(call(t.env, "GET", `/account/billing?project=${t.apps[0]!.id}&start=1`, { cookie: t.cookie }))).toContain('"go":true');
    // signed out: through the sign-in, back to the same page
    const out = await call(t.env, "GET", `/account/billing?project=${t.apps[0]!.id}&start=1&from=cli`, {});
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe(`/login?next=${encodeURIComponent(`/account/billing?project=${t.apps[0]!.id}&start=1&from=cli`)}`);
    // the page waits for its payment with this
    expect(await json(call(t.env, "GET", `/api/billing?project=${t.apps[0]!.id}`, { cookie: t.cookie }))).toEqual({ project: { id: t.apps[0]!.id, plan: "free", source: null, locked: null } });
  });

  it("the plan page, Free and locked (an app past Free's one): the trial, and no free way on", async () => {
    const t = await withApps(["Shop", "Blog"]);
    const page = await text(call(t.env, "GET", `/account/billing?project=${t.apps[1]!.id}`, { cookie: t.cookie }));
    expect(page).toContain("<h1>Choose a plan for Blog</h1>");
    // why it is locked: Free covered 3 apps before version 5 (the owner kept Free at one app)
    expect(page).toContain("Since 13 November 2026 Free covers one app, your oldest, and <b>Blog</b> is past it: it needs Pro.");
    expect(page).toContain('data-plan="team" data-pick><span>Start your 7-day free trial</span>');
    expect(page).not.toContain("Try for free");
    expect(page).not.toContain('id="why"');
    expect(page).not.toContain('type="button" data-continue>');
  });

  it("the plan page, covered by a paid plan or a grant: the big Pro card says Your plan, and Continue with Pro", async () => {
    const t = await withApps(["Shop", "Blog"]);
    paidPro(t.sql, t.account.id);
    const page = await text(call(t.env, "GET", `/account/billing?project=${t.apps[1]!.id}&new=1`, { cookie: t.cookie }));
    // every new app sees its plan page, a paying account's too
    expect(page).toContain("<h1>Choose a plan for Blog</h1>");
    expect(page).toContain("Your <b>Pro</b> plan covers <b>Blog</b>");
    expect(page).toContain('<div class="plan pick big"><h3>Pro <span class="tag">Your plan</span></h3>');
    expect(page).toContain('<button class="btn" type="button" data-continue><span>Continue with Pro</span></button>');
    expect(page).toContain('<a href="#" id="portal">Manage billing</a>');
    expect(page).not.toContain("data-pick");
    expect(page).not.toContain("free trial");
    expect(page).not.toContain("Try for free");
    // the button goes on with the plan, then to the app (its setup for a new one)
    expect(page).toContain('gcPost("/api/billing/projects/" + encodeURIComponent(cfg.project) + "/continue", {})');
    expect(page).toContain('"isNew":true');
    // ?start=1 never opens a Checkout for an app the plan covers
    expect(await text(call(t.env, "GET", `/account/billing?project=${t.apps[1]!.id}&start=1`, { cookie: t.cookie }))).toContain('"go":false');
    // a grant: the same, set up by GenClass, with no billing to manage
    const g = await withApps(["Docs"]);
    setPlan(g.sql, g.account.id, "free", { comp_until: "9999-12-31T00:00:00.000Z" });
    const granted = await text(call(g.env, "GET", `/account/billing?project=${g.apps[0]!.id}`, { cookie: g.cookie }));
    expect(granted).toContain("Your <b>Enterprise</b> plan, set up by GenClass, covers <b>Docs</b>.");
    expect(granted).toContain('<span class="tag">Your plan</span>');
    expect(granted).toContain("<span>Continue with Enterprise</span>");
    expect(granted).not.toContain('id="portal"');
    expect(granted).not.toContain("data-pick");
  });

  it("the plan page, an app past Pro's 3: Switch to Business (10 apps), or remove an app; nothing opens on its own", async () => {
    const t = await withApps(["Shop", "Blog", "Docs", "Extra"]);
    paidPro(t.sql, t.account.id);
    const page = await text(call(t.env, "GET", `/account/billing?project=${t.apps[3]!.id}&start=1`, { cookie: t.cookie }));
    expect(page).toContain("<h1>Choose a plan for Extra</h1>");
    expect(page).toContain("Your <b>Pro</b> plan covers up to 3 apps, and <b>Extra</b> is one more. <b>Business</b> covers up to 10 apps.");
    expect(page).toContain('<button class="btn" type="button" data-plan="business" data-pick><span>Switch to Business</span></button>');
    expect(page).toContain("Or remove an app you no longer use, and this one takes its place.");
    expect(page).not.toContain("Email us about Enterprise");
    expect(page).not.toContain('type="button" data-addapps>');
    expect(page).not.toContain('type="button" data-continue>');
    expect(page).not.toContain("Try for free");
    // nothing is bought until the button is pressed: the page neither opens a Checkout nor polls for one
    expect(page).toContain('"go":false,"wait":false');
  });

  it("the plan page, an app past Business's 10: Email us about Enterprise, nothing to buy", async () => {
    const names = Array.from({ length: 11 }, (_, i) => `App ${i + 1}`);
    const t = await withApps(names);
    setPlan(t.sql, t.account.id, "business", { stripe_mode: "live", seats: null, subscription_id: "sub_acct000001", subscription_status: "active", current_period_end: "2026-11-13T12:00:00.000Z" });
    const page = await text(call(t.env, "GET", `/account/billing?project=${t.apps[10]!.id}&start=1`, { cookie: t.cookie }));
    expect(page).toContain("Your <b>Business</b> plan covers up to 10 apps, and <b>App 11</b> is one more. More apps come with <b>Enterprise</b>, agreed by email.");
    expect(page).toContain(`<a class="btn" href="mailto:mehar@genclass.dev?subject=${encodeURIComponent("GenClass Enterprise: more than 10 apps")}"><span>Email us about Enterprise</span></a>`);
    expect(page).not.toContain("data-pick");
  });

  it("Try for free (limited) records the choice for that app only; an app past Free's one cannot, and it is a browser write", async () => {
    const t = await withApps(["Shop", "Blog", "Docs", "Extra"]);
    const apps = t.apps;
    expect(chosenAt(t.sql, apps[0]!.id)).toBeNull();
    // nobody goes on with Free without saying why: a reason from the list is needed
    expect((await call(t.env, "POST", `/api/billing/projects/${apps[0]!.id}/free`, { cookie: t.cookie, body: {} })).status).toBe(400);
    expect((await call(t.env, "POST", `/api/billing/projects/${apps[0]!.id}/free`, { cookie: t.cookie, body: { reason: "because" } })).status).toBe(400);
    expect(chosenAt(t.sql, apps[0]!.id)).toBeNull();
    const told: string[] = [];
    const hook = (async (u: string | URL | Request, init?: RequestInit) => (String(u).startsWith("https://hooks.example/") ? (told.push(String(init?.body)), new Response("ok")) : new Response("no", { status: 500 }))) as never;
    const env = { ...t.env, NOTIFY_WEBHOOK: "https://hooks.example/notify" };
    const r = await call(env, "POST", `/api/billing/projects/${apps[0]!.id}/free`, { cookie: t.cookie, body: { reason: "price", note: "  too much\u0007 for a side project  " }, fetch: hook });
    expect(r.status).toBe(200);
    expect(t.sql.rows("SELECT account_id, project_id, reason, note FROM plan_feedback")).toEqual([{ account_id: t.account.id, project_id: apps[0]!.id, reason: "price", note: "too much  for a side project" }]);
    expect(told).toHaveLength(1);
    expect(JSON.parse(told[0]!)).toMatchObject({ kind: "free_chosen", reason: "price", project: apps[0]!.id, text: 'Free chosen for "Shop" (ada@example.com): It costs too much. "too much  for a side project"' });
    expect(await r.json()).toEqual({ ok: true, plan: "free" });
    expect(chosenAt(t.sql, apps[0]!.id)).toMatch(/^20\d\d-\d\d-\d\dT/);
    expect(chosenAt(t.sql, apps[1]!.id)).toBeNull();
    // the others have only the paid plan
    for (const i of [1, 3]) expect((await call(t.env, "POST", `/api/billing/projects/${apps[i]!.id}/free`, { cookie: t.cookie, body: { reason: "trying" } })).status).toBe(409);
    expect(chosenAt(t.sql, apps[3]!.id)).toBeNull();
    // another account's app, and no app at all
    const b = await signedIn(t.env, "bob@example.com");
    expect((await call(t.env, "POST", `/api/billing/projects/${apps[1]!.id}/free`, { cookie: b.cookie, body: { reason: "trying" } })).status).toBe(404);
    expect(chosenAt(t.sql, apps[1]!.id)).toBeNull();
    // signed out, and a GET
    expect((await call(t.env, "POST", `/api/billing/projects/${apps[1]!.id}/free`, { body: { reason: "trying" } })).status).toBe(401);
    expect((await call(t.env, "GET", `/api/billing/projects/${apps[1]!.id}/free`, { cookie: t.cookie })).status).toBe(405);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM plan_feedback")).toEqual([{ n: 1 }]);
    // the popup lists exactly the reasons the route takes
    expect(FREE_REASONS_SHOWN).toEqual(FREE_REASONS);
  });

  it("a project that is paid for is not deleted while it bills", async () => {
    const t = await withApps(["Shop"]);
    const app = t.apps[0]!;
    t.sql.db.prepare("UPDATE projects SET plan = 'team', stripe_mode = 'live', subscription_id = 'sub_s', subscription_status = 'active' WHERE id = ?").run(app.id);
    const r = await call(t.env, "DELETE", `/api/account/projects/${app.id}`, { body: { confirm: "delete" }, cookie: t.cookie });
    expect(r.status).toBe(409);
    expect((await r.json() as any).error).toContain("cancel it on its plan page");
    t.sql.db.prepare("UPDATE projects SET subscription_status = 'canceled', plan = NULL WHERE id = ?").run(app.id);
    expect((await call(t.env, "DELETE", `/api/account/projects/${app.id}`, { body: { confirm: "delete" }, cookie: t.cookie })).status).toBe(204);
  });
});

describe("POST /api/billing/projects/<id>/continue: an app the account's plan covers goes on with it", () => {
  it("writes when the plan was chosen, once; answers with the plan", async () => {
    const t = await withApps(["Shop", "Blog"]);
    paidPro(t.sql, t.account.id);
    const r = await call(t.env, "POST", `/api/billing/projects/${t.apps[1]!.id}/continue`, { cookie: t.cookie, body: {} });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, plan: "team" });
    const at = chosenAt(t.sql, t.apps[1]!.id);
    expect(at).toBe(now().toISOString());
    expect(chosenAt(t.sql, t.apps[0]!.id)).toBeNull();
    // again, later: the first time stays
    const { advance } = await import("./account-helpers.js");
    advance(60_000);
    expect(await json(call(t.env, "POST", `/api/billing/projects/${t.apps[1]!.id}/continue`, { cookie: t.cookie, body: {} }))).toEqual({ ok: true, plan: "team" });
    expect(chosenAt(t.sql, t.apps[1]!.id)).toBe(at);
    // no feedback row and no notice: this is not Free chosen
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM plan_feedback")).toEqual([{ n: 0 }]);
  });

  it("a grant, a version-4 project subscription and PLAN_GATES open are plans that cover an app", async () => {
    const g = await withApps(["Shop"]);
    setPlan(g.sql, g.account.id, "free", { comp_until: "9999-12-31T00:00:00.000Z" });
    expect(await json(call(g.env, "POST", `/api/billing/projects/${g.apps[0]!.id}/continue`, { cookie: g.cookie, body: {} }))).toEqual({ ok: true, plan: "enterprise" });
    const v4 = await withApps(["Shop", "Blog"]);
    projectPaid(v4.sql, v4.apps[0]!.id);
    expect(await json(call(v4.env, "POST", `/api/billing/projects/${v4.apps[1]!.id}/continue`, { cookie: v4.cookie, body: {} }))).toEqual({ ok: true, plan: "team" });
    const open = await withApps(["Shop"], { PLAN_GATES: "open" });
    expect(await json(call(open.env, "POST", `/api/billing/projects/${open.apps[0]!.id}/continue`, { cookie: open.cookie, body: {} }))).toEqual({ ok: true, plan: "enterprise" });
  });

  it("409 for an app the plan does not cover (Free, or past Pro's 3); 404 for another account's; a browser write only", async () => {
    const t = await withApps(["Shop", "Blog", "Docs", "Extra"]);
    const go = (i: number, o: Record<string, unknown> = {}) => call(t.env, "POST", `/api/billing/projects/${t.apps[i]!.id}/continue`, { cookie: t.cookie, body: {}, ...o });
    // on Free nothing covers an app to go on with: Free is chosen with its reason (/free), or Pro is bought
    for (const i of [0, 1]) {
      const r = await go(i);
      expect(r.status, String(i)).toBe(409);
      expect((await r.json() as any).error).toBe(`${t.apps[i]!.name} needs a plan first`);
    }
    paidPro(t.sql, t.account.id);
    expect((await go(2)).status).toBe(200);
    expect((await go(3)).status).toBe(409);
    expect(chosenAt(t.sql, t.apps[3]!.id)).toBeNull();
    const bob = await signedIn(t.env, "bob@example.com");
    expect((await go(0, { cookie: bob.cookie })).status).toBe(404);
    expect((await call(t.env, "POST", "/api/billing/projects/0000000000000000/continue", { cookie: t.cookie, body: {} })).status).toBe(404);
    expect((await go(0, { cookie: undefined })).status).toBe(401);
    expect((await go(0, { origin: "https://evil.example" })).status).toBe(403);
    const { cliToken } = await import("./account-helpers.js");
    expect((await go(0, { cookie: undefined, bearer: await cliToken(t.env, t.cookie), origin: null })).status).toBe(403);
    expect((await call(t.env, "GET", `/api/billing/projects/${t.apps[0]!.id}/continue`, { cookie: t.cookie })).status).toBe(405);
    expect(chosenAt(t.sql, t.apps[0]!.id)).toBeNull();
  });
});

describe("the website: set up first, the trial last (the owner, 2026-11-24: \"set up your entire app first before letting you put your credit card in\")", () => {
  /** The JSON in /account's #acfg. */
  const acfg = (html: string) => JSON.parse(/<script type="application\/json" id="acfg">([^<]*)<\/script>/.exec(html)![1]!);

  it("an account with no app goes on to Get started (\"start\":true in #acfg), from sign-up's ?welcome=1 too; the trial-first screen is gone", async () => {
    const t = await withApps([]);
    const home = await call(t.env, "GET", "/account", { cookie: t.cookie });
    expect(home.status).toBe(200);
    const page = await home.text();
    expect(page).toContain('<script type="application/json" id="acfg">{"claim":false,"save":false,"start":true}</script>');
    // the page script goes on unless the address names a part of the page (#settings, #security...)
    expect(page).toContain('if (cfg.start && !location.hash) { location.replace("/account/get-started"); return; }');
    // no trial screen with a tiny Skip (2026-11-13): the empty grid offers the app first, and Get started
    expect(page).not.toContain('id="trial"');
    expect(page).not.toContain('id="starttrial"');
    expect(page).not.toContain('id="skiptrial"');
    expect(page).toContain("<h2>Create your first app</h2>");
    expect(page).toContain('<a class="btn ghost" href="/account/get-started">Get started</a>');
    // every sign-up lands on /account?welcome=1 (its notice stays on the page, which goes on all the same)
    const welcome = await text(call(t.env, "GET", "/account?welcome=1", { cookie: t.cookie }));
    expect(welcome).toContain("Your account is ready.");
    expect(acfg(welcome).start).toBe(true);
    // the trial (Get started's third step) still opens the account's checkout at once (the billing page, go); links
    // name the plan as every screen does (plans.ts planParam), and one sent before, with the plan's id, still works
    expect(await text(call(t.env, "GET", "/account/billing?plan=pro&start=1", { cookie: t.cookie }))).toContain('"go":true');
    expect(await text(call(t.env, "GET", "/account/billing?plan=team&start=1", { cookie: t.cookie }))).toContain('"go":true');
  });

  it("it stays on /account with an app, while a link is added (?claim, ?save) or for another notice; on Pro or where nothing is sold it goes on too", async () => {
    const withApp = await withApps(["Shop"]);
    const has = await text(call(withApp.env, "GET", "/account", { cookie: withApp.cookie }));
    expect(acfg(has).start).toBe(false);
    expect(has).toContain('<li class="pcard" data-name="shop">');
    const empty = await withApps([]);
    for (const q of ["?claim=1", "?save=1", "?deleted=project"]) expect(acfg(await text(call(empty.env, "GET", `/account${q}`, { cookie: empty.cookie }))).start, q).toBe(false);
    expect(acfg(await text(call(empty.env, "GET", "/account?claim=1", { cookie: empty.cookie }))).claim).toBe(true);
    const pro = await withApps([]);
    paidPro(pro.sql, pro.account.id);
    const p = await text(call(pro.env, "GET", "/account", { cookie: pro.cookie }));
    expect(acfg(p).start).toBe(true);
    expect(p).not.toContain('id="trial"');
    const none = setup();
    const n = await signedIn(none.env);
    const free = await text(call(none.env, "GET", "/account", { cookie: n.cookie }));
    expect(acfg(free).start).toBe(true);
    expect(free).toContain("<h2>Create your first app</h2>");
  });

  it("/account/get-started: one command for the whole setup, the genclass command's steps under it, and the ways without a terminal", async () => {
    const t = await withApps([]);
    const out = await call(t.env, "GET", "/account/get-started", {});
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("/login?next=%2Faccount%2Fget-started");
    expect((await call(t.env, "POST", "/account/get-started", { cookie: t.cookie, body: {} })).status).toBe(405);
    const rows = (html: string) => [...html.matchAll(/<li class="ob-row (\w+)" data-key="(\w+)"><span class="ob-g" aria-hidden="true">([^<]*)<\/span><span class="ob-t">([^<]+)<\/span>/g)].map((m) => [m[2], m[1], m[3], m[4]]);
    const page = async () => {
      const r = await call(t.env, "GET", "/account/get-started", { cookie: t.cookie });
      expect(r.status).toBe(200);
      return r.text();
    };
    // a new account: the command first, then the command's steps with its marks
    const fresh = await page();
    expect(fresh).toContain("<title>Get started | GenClass</title>");
    expect(fresh).toContain('<span class="gs-prog" id="gs-prog"><b>1</b> of 4 done</span>');
    expect(fresh).toContain('<button class="ob-go" type="button" id="ob-make"><span>Get my command</span></button>');
    expect(rows(fresh)).toEqual([
      ["account", "done", "✔", "Account"],
      ["runtime", "next", "●", "Runtime"],
      ["dashboard", "later", "○", "Dashboard"],
      ["workflow", "auto", "→", "Test workflow"],
      ["github", "auto", "→", "GitHub App"],
      ["agent", "auto", "→", "Coding agent"],
      ["plan", "later", "○", "Pro"],
      ["suggestions", "later", "○", "Suggestions"],
    ]);
    // the trial is in Pro's row, after the setup
    expect(fresh).toContain('<span class="ob-d">$25 / month, 7 days free, after the setup</span><a class="ob-a" href="/account/billing?plan=pro&#38;start=1">Start 7-day free trial</a>');
    // without a terminal: create the app here (the site script names it after a site this browser checked)
    expect(fresh).toContain('<details class="gs-other" open><summary>No terminal? Two other ways</summary>');
    expect(fresh).toMatch(/<a class="btn" id="gs-new" href="\/account\/new">.*<span>Create your app<\/span><\/a>/);
    // an app made here: by hand, its own connect command; the command still has to add GenClass to its code
    const shop = await createApp(t.env, t.cookie, "Shop");
    const made = await page();
    expect(rows(made).map((r) => r.slice(0, 2))).toContainEqual(["runtime", "next"]);
    expect(made).toContain("Shop is in your account: the command adds GenClass to its code");
    expect(made).toContain(`<code>${esc(setupCommand(shop.token))}</code>`);
    expect(made).toContain(`aria-label="Copy the command that connects Shop"`);
    expect(made).not.toContain('id="gs-new"');
    // the terminal signs in and the first page arrives: the runtime and the dashboard done, Pro next
    await cliToken(t.env, t.cookie);
    await sendBatch(t.env, shop.token, [{ t: "session", host: "shop.example", route: "/" }]);
    const live = await page();
    expect(rows(live).map((r) => r.slice(0, 2))).toEqual([["account", "done"], ["runtime", "done"], ["dashboard", "done"], ["workflow", "auto"], ["github", "auto"], ["agent", "auto"], ["plan", "next"], ["suggestions", "later"]]);
    expect(live).toContain("signed in, here and in your terminal");
    expect(live).toContain(`<a class="ob-a" href="/account/apps/${shop.id}">Open</a>`);
    // on Pro: four of four
    paidPro(t.sql, t.account.id);
    const pro = await page();
    expect(pro).toContain('<span class="gs-prog" id="gs-prog"><b>4</b> of 4 done</span>');
    expect(rows(pro).find((r) => r[0] === "plan")!.slice(1, 3)).toEqual(["done", "✔"]);
    // the script that draws the run the command reports
    expect(pro).toContain('fetch("/api/account/onboard"');
  });
});

describe("GET /api/account/glance: the sidebar's plan card and Get started's steps, in the server's words", () => {
  const glance = (env: ReturnType<typeof setup>["env"], cookie: string) => json(call(env, "GET", "/api/account/glance", { cookie }));

  it("a signed-in browser only: 401 signed out and from a terminal, 405 for a write; never cached", async () => {
    const t = await withApps([]);
    expect((await call(t.env, "GET", "/api/account/glance", {})).status).toBe(401);
    expect((await call(t.env, "GET", "/api/account/glance", { bearer: await cliToken(t.env, t.cookie), origin: null })).status).toBe(401);
    expect((await call(t.env, "POST", "/api/account/glance", { cookie: t.cookie, body: {} })).status).toBe(405);
    const r = await call(t.env, "GET", "/api/account/glance", { cookie: t.cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("a new account on Free: no step done, Start 7-day free trial to the start URL; the app and its first event mark theirs", async () => {
    const t = await withApps([]);
    const start = "/account/billing?plan=pro&start=1";
    expect(await glance(t.env, t.cookie)).toEqual({
      ok: true,
      plan: "Free",
      status: "plan",
      trial: false,
      apps: { used: 0, of: 1 },
      note: "0 of 1 app",
      action: { label: "Start 7-day free trial", href: start, primary: false },
      steps: [
        { key: "account", done: true },
        { key: "runtime", done: false },
        { key: "dashboard", done: false },
        { key: "plan", done: false },
      ],
      setup: expect.any(Array),
      first: null,
      sold: { name: "Pro", price: "$25 / month", days: 7, start },
    });
    // the genclass command's setup, as this server sees it (the test workflow and the coding agent are the command's)
    const states = (g: any) => g.setup.map((x: any) => [x.key, x.state]);
    expect(states(await glance(t.env, t.cookie))).toEqual([["account", "done"], ["runtime", "next"], ["dashboard", "later"], ["workflow", "auto"], ["github", "auto"], ["agent", "auto"], ["plan", "later"], ["suggestions", "later"]]);
    // the start URL opens the account's checkout at once
    expect(await text(call(t.env, "GET", start, { cookie: t.cookie }))).toContain('"go":true');
    const shop = await createApp(t.env, t.cookie, "Shop");
    const made = await glance(t.env, t.cookie);
    // an app made on the website, with no terminal signed in yet: the command still has to add GenClass to its code
    expect(made.steps).toEqual([{ key: "account", done: true }, { key: "runtime", done: false }, { key: "dashboard", done: false }, { key: "plan", done: false }]);
    expect(made.setup.find((x: any) => x.key === "runtime")).toMatchObject({ state: "next", detail: "Shop is in your account: the command adds GenClass to its code" });
    expect(made.first).toEqual({ id: shop.id, name: "Shop", token: shop.token, live: false });
    expect([made.apps, made.note, made.action.primary]).toEqual([{ used: 1, of: 1 }, "1 of 1 app", true]);
    // after the first event: connected
    await sendBatch(t.env, shop.token, [{ t: "session", host: "shop.example", route: "/" }]);
    const live = await glance(t.env, t.cookie);
    expect(live.steps).toEqual([{ key: "account", done: true }, { key: "runtime", done: true }, { key: "dashboard", done: true }, { key: "plan", done: false }]);
    expect(states(live)).toEqual([["account", "done"], ["runtime", "done"], ["dashboard", "done"], ["workflow", "auto"], ["github", "auto"], ["agent", "auto"], ["plan", "next"], ["suggestions", "later"]]);
    expect(live.setup.find((x: any) => x.key === "plan").link).toEqual({ label: "Start 7-day free trial", href: start });
    expect(live.first.live).toBe(true);
    expect(live.action).toEqual({ label: "Start 7-day free trial", href: start, primary: true });
  });

  it("the first app is the oldest (the one Free covers), not the first by name", async () => {
    const { advance } = await import("./account-helpers.js");
    const t = await withApps(["Shop"]);
    advance(60_000);
    const blog = await createApp(t.env, t.cookie, "Blog");
    const g = await glance(t.env, t.cookie);
    expect(g.first).toMatchObject({ id: t.apps[0]!.id, name: "Shop" });
    expect([g.apps, g.note]).toEqual([{ used: 2, of: 1 }, "2 apps, 1 covered"]);
    // Blog is past Free's one app: its page opens its plan page
    expect((await call(t.env, "GET", `/account/apps/${blog.id}`, { cookie: t.cookie })).headers.get("location")).toBe(`/account/billing?project=${blog.id}`);
    expect((await call(t.env, "GET", `/account/apps/${t.apps[0]!.id}`, { cookie: t.cookie })).status).toBe(200);
  });

  it("a member of a team on Business: the team's plan covers them, nothing is sold to them, and the team's app counts for their steps", async () => {
    const t = await withApps(["Shop"]);
    setPlan(t.sql, t.account.id, "business", { stripe_mode: "live", seats: null, subscription_id: "sub_acct000001", subscription_status: "active", current_period_end: "2026-11-13T12:00:00.000Z" });
    await sendBatch(t.env, t.apps[0]!.token, [{ t: "session", host: "shop.example", route: "/" }]);
    const bob = await signedIn(t.env, "bob@example.com");
    const inv = await json(call(t.env, "POST", "/api/team/invites", { body: {}, cookie: t.cookie }));
    expect((await call(t.env, "POST", "/api/team/join", { body: { code: inv.url.split("/").pop() }, cookie: bob.cookie })).status).toBe(200);
    const g = await glance(t.env, bob.cookie);
    expect(g).toMatchObject({ plan: "Business", status: "with your team", note: null, action: { label: "Plans and billing", href: "/account/billing", primary: false } });
    expect(g.steps).toEqual([{ key: "account", done: true }, { key: "runtime", done: true }, { key: "dashboard", done: true }, { key: "plan", done: true }]);
    expect(g.setup.find((x: any) => x.key === "plan")).toMatchObject({ state: "done", detail: "with your team", link: null });
    expect(g.first).toMatchObject({ id: t.apps[0]!.id, name: "Shop", live: true });
  });

  it("on Pro the trial step is done and the card offers Plans and billing; Pro's trial counts its days; GenClass's grant says so", async () => {
    const t = await withApps(["Shop"]);
    paidPro(t.sql, t.account.id);
    const pro = await glance(t.env, t.cookie);
    expect(pro).toMatchObject({ plan: "Pro", status: "plan", trial: false, apps: { used: 1, of: 3 }, note: "1 of 3 apps", action: { label: "Plans and billing", href: "/account/billing", primary: false } });
    expect(pro.steps).toEqual([{ key: "account", done: true }, { key: "runtime", done: false }, { key: "dashboard", done: false }, { key: "plan", done: true }]);
    setPlan(t.sql, t.account.id, "team", { subscription_status: "trialing", current_period_end: "2026-10-15T12:00:00.000Z" });
    expect(await glance(t.env, t.cookie)).toMatchObject({ plan: "Pro trial", status: "2 days left", trial: true });
    const g = await withApps(["Shop"]);
    setPlan(g.sql, g.account.id, "free", { comp_until: "9999-12-31T00:00:00.000Z" });
    const comp = await glance(g.env, g.cookie);
    expect(comp).toMatchObject({ status: "from GenClass", trial: false, action: { label: "Plans and billing", href: "/account/billing", primary: false } });
    expect(comp.steps.find((s: { key: string }) => s.key === "plan").done).toBe(true);
  });
});

describe("the website: an own app opens its dashboard at once (set up first, 2026-11-24); only one its plan does not cover opens its plan page", () => {
  it("an app on Free opens its dashboard with nothing chosen first; the plan page stays where it was, chosen or not", async () => {
    const t = await withApps(["Shop"]);
    const shop = t.apps[0]!;
    const r = await call(t.env, "GET", `/account/apps/${shop.id}`, { cookie: t.cookie });
    expect(r.status).toBe(200);
    expect(chosenAt(t.sql, shop.id)).toBeNull();
    expect((await call(t.env, "GET", `/account/billing?project=${shop.id}`, { cookie: t.cookie })).status).toBe(200);
    await call(t.env, "POST", `/api/billing/projects/${shop.id}/free`, { cookie: t.cookie, body: { reason: "unsure" } });
    expect((await call(t.env, "GET", `/account/apps/${shop.id}`, { cookie: t.cookie })).status).toBe(200);
    // where nothing is sold, the same
    const none = setup();
    const n = await signedIn(none.env);
    const app = await createApp(none.env, n.cookie, "Docs");
    expect((await call(none.env, "GET", `/account/apps/${app.id}`, { cookie: n.cookie })).status).toBe(200);
  });

  it("an app of a paying account, of a version-4 project subscription or on a grant opens its dashboard at once too", async () => {
    const t = await withApps(["Shop", "Blog"]);
    paidPro(t.sql, t.account.id);
    for (const app of t.apps) expect((await call(t.env, "GET", `/account/apps/${app.id}`, { cookie: t.cookie })).status).toBe(200);
    expect(t.apps.map((a) => chosenAt(t.sql, a.id))).toEqual([null, null]);
    // a version-4 project subscription
    const v4 = await withApps(["Shop"]);
    projectPaid(v4.sql, v4.apps[0]!.id);
    expect((await call(v4.env, "GET", `/account/apps/${v4.apps[0]!.id}`, { cookie: v4.cookie })).status).toBe(200);
    // GenClass's grant
    const g = await withApps(["Shop"]);
    setPlan(g.sql, g.account.id, "free", { comp_until: "9999-12-31T00:00:00.000Z" });
    expect((await call(g.env, "GET", `/account/apps/${g.apps[0]!.id}`, { cookie: g.cookie })).status).toBe(200);
  });

  it("a locked app opens its plan page even once a plan was chosen for it, until the plan covers it", async () => {
    const t = await withApps(["Shop", "Blog", "Docs", "Extra"]);
    for (const app of t.apps) t.sql.db.prepare("UPDATE projects SET plan_chosen = ? WHERE id = ?").run(now().toISOString(), app.id);
    const at = async (i: number) => (await call(t.env, "GET", `/account/apps/${t.apps[i]!.id}`, { cookie: t.cookie })).status;
    // Free: the first opens, the rest wait for Pro
    expect([await at(0), await at(1)]).toEqual([200, 302]);
    // Pro: 3 open, the 4th waits for Enterprise
    paidPro(t.sql, t.account.id);
    expect([await at(0), await at(1), await at(2), await at(3)]).toEqual([200, 200, 200, 302]);
    expect((await call(t.env, "GET", `/account/apps/${t.apps[3]!.id}`, { cookie: t.cookie })).headers.get("location")).toBe(`/account/billing?project=${t.apps[3]!.id}`);
    // one of the 3 removed: the 4th takes its place
    expect((await call(t.env, "DELETE", `/api/account/projects/${t.apps[1]!.id}`, { body: { confirm: "delete" }, cookie: t.cookie })).status).toBe(204);
    expect(await at(3)).toBe(200);
  });

  it("?plan=pro&start=1 (the pricing page, the genclass command's checkout_url) opens the account's billing page, which starts Pro's Checkout", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    // no app needed: Pro is the account's
    const none = await call(t.env, "GET", "/account/billing?plan=pro&start=1", { cookie: a.cookie });
    expect(none.status).toBe(200);
    const html = await none.text();
    expect(html).toContain('"go":true');
    expect(html).toContain('data-plan="team" data-pick><span>Upgrade to Pro</span>');
    await createApp(t.env, a.cookie, "Shop");
    expect((await call(t.env, "GET", "/account/billing?plan=pro&start=1", { cookie: a.cookie })).status).toBe(200);
    // a plain link shows the page, and starts nothing
    const plain = await text(call(t.env, "GET", "/account/billing?plan=pro", { cookie: a.cookie }));
    expect(plain).not.toContain('"go"');
    // signed out: the plan survives the sign-in
    expect((await call(t.env, "GET", "/account/billing?plan=pro&start=1", {})).headers.get("location")).toBe("/login?next=%2Faccount%2Fbilling%3Fplan%3Dpro%26start%3D1");
  });
});

describe("problems fixed live: 100 a month per project on Free, then observe only", () => {
  /** A page load in guard mode in which the runtime fixed `n` problems. */
  const fixes = (n: number) => Array.from({ length: n }, (_, i) => ({ t: "action", seq: i + 1, action: "coalesce", outcome: "applied" }));

  it("past the limit, ingest's reply tells the runtime to observe only; the batch is stored and counted the same; Pro lifts it", async () => {
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
    // the plan page says so, once there are fixes to count (a new app's "0 of 100" is left out)
    const planPage = await text(call(t.env, "GET", `/account/billing?project=${app.id}`, { cookie: a.cookie }));
    expect(planPage).toContain("<b>Observing only.</b> Problems fixed live this month: <b>120 of 100</b>.");
    // the account on Pro: no limit, no header
    paidPro(t.sql, a.account.id);
    resetOwnerCache();
    resetUsageCache();
    const paid = await sendBatch(t.env, app.token, [{ t: "session", host: "shop.example", route: "/" }], { sid: "dddddddddddd" });
    expect(paid.headers.get(OBSERVE_HEADER)).toBeNull();
    expect((await json(call(t.env, "GET", `/api/account/projects/${app.id}/stats?range=7d`, { cookie: a.cookie }))).usage).toMatchObject({ limit: null, observe_only: false });
  });

  it("the CLI's overview names each app's plan and its page, and which wait for one (Free's or Pro's)", async () => {
    const t = await withApps(["a", "b", "c", "d"]);
    const { cliToken } = await import("./account-helpers.js");
    const bearer = await cliToken(t.env, t.cookie);
    const overview = async () => (await json(call(t.env, "GET", "/api/cli/overview", { bearer, origin: null }))).projects.map((p: any) => [p.name, p.plan.id, p.plan.source, p.needs_plan]);
    expect(await overview()).toEqual([["a", "free", null, false], ["b", "free", null, true], ["c", "free", null, true], ["d", "free", null, true]]);
    const o = await json(call(t.env, "GET", "/api/cli/overview", { bearer, origin: null }));
    expect(o.projects[0].plan_url).toBe(`https://genclass.dev/account/billing?project=${o.projects[0].id}`);
    // Pro: the 4th is past its 3 apps
    paidPro(t.sql, t.account.id);
    expect(await overview()).toEqual([["a", "team", "paid", false], ["b", "team", "paid", false], ["c", "team", "paid", false], ["d", "free", null, true]]);
  });
});

it("FREE is the first plan", () => expect(FREE.id).toBe("free"));
it("price() still names Pro's price", () => expect(price("genclass_team_monthly").id).toBe("price_team000001"));

describe("Pro's 7-day trial (plans.json trial_days), on an account's first subscription only (from #227)", () => {
  it("a customer with no subscription gets 7 free days; one that has had any (even cancelled) gets none", async () => {
    const b = await buyer();
    expect(PLANS.find((p) => p.id === "team")!.trial_days).toBe(7);
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: b.shop.id }, cookie: b.cookie, fetch: b.s.fetch })).status).toBe(200);
    const first = b.s.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions").pop()!;
    expect(first.form!.get("subscription_data[trial_period_days]")).toBe("7");
    expect(first.form!.get("metadata[genclass_trial_days]")).toBe("7");
    // a card is still taken up front
    expect(first.form!.get("payment_method_collection")).toBe("always");
    // the same customer once had a subscription, since cancelled
    b.s.subs.set("sub_old0000001", accountSub("sub_old0000001", b.account.id, "cus_ada0000001", "canceled"));
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team", project_id: b.blog.id }, cookie: b.cookie, fetch: b.s.fetch })).status).toBe(200);
    const later = b.s.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions").pop()!;
    expect(later.form!.has("subscription_data[trial_period_days]")).toBe(false);
    expect(later.form!.has("metadata[genclass_trial_days]")).toBe(false);
  });
});

describe("what was bought before version 5 keeps what it covered, and a paying team keeps its members (the 0.3.7 report)", () => {
  const plansOf = async (t: { sql: Sql; env: any; account: { id: string } }) =>
    (await accountProjectsAccess(t.sql.api, t.account.id, t.env, now())).map((x) => x.access.locked ?? `${x.access.plan.id}:${x.access.source}`);
  const kept = (sql: Sql, id: string) => (sql.db.prepare("SELECT apps_kept FROM accounts WHERE id = ?").get(id) as { apps_kept: number | null }).apps_kept;

  it("a version-4 subscription of one app holds the whole team: no seat limit, so its members keep the dashboards and the command", async () => {
    const t = await withApps(["Shop"]);
    projectPaid(t.sql, t.apps[0]!.id);
    expect(await accountAccess(t.sql.api, t.account.id, t.env, now())).toMatchObject({ source: "paid", plan: { id: "team" }, seats: null });
    for (const email of ["bob@example.com", "cy@example.com"]) {
      const m = await signedIn(t.env, email);
      const inv = await json(call(t.env, "POST", "/api/team/invites", { body: {}, cookie: t.cookie }));
      expect((await call(t.env, "POST", "/api/team/join", { body: { code: inv.url.split("/").pop() }, cookie: m.cookie })).status).toBe(200);
      expect((await call(t.env, "GET", `/account/apps/${t.apps[0]!.id}`, { cookie: m.cookie })).status).toBe(200);
      // the genclass command works for the member, under the team's Pro (src/cli.ts cliVia, workingAccess)
      const bearer = await cliToken(t.env, m.cookie);
      const seen = await json(call(t.env, "GET", "/api/cli/overview", { bearer, origin: null }));
      expect(seen.cli).toEqual({ paid: true, via: "team" });
      expect(seen.plan).toEqual({ id: "team", name: "Pro", source: "paid", via: "team" });
    }
  });

  it("an account subscription from before version 5 keeps covering the apps the account had (accounts.apps_kept) while it lasts", async () => {
    const b = await buyer();
    for (const n of ["Docs", "Extra", "Fifth"]) await createApp(b.env, b.cookie, n);
    // a subscription of the whole account from version 3 (or bought per app), as migration 0021 leaves it
    paidPro(b.sql, b.account.id, 1);
    b.sql.db.prepare("UPDATE accounts SET apps_kept = 5 WHERE id = ?").run(b.account.id);
    expect(await plansOf(b)).toEqual(Array(5).fill("team:paid"));
    // an app added since is past them: Pro's 3, or the 5 kept, whichever is more
    await createApp(b.env, b.cookie, "Sixth");
    expect(await plansOf(b)).toEqual([...Array(5).fill("team:paid"), "pro_apps"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // the same subscription changes (a seat added in Manage billing): still kept
    const more = accountSub("sub_acct000001", b.account.id, "cus_ada0000001", "active", 2);
    b.s.subs.set(more.id, more);
    expect((await json(deliver(b.env, stripeEvent("customer.subscription.updated", more), b.s.fetch))).result).toBe("applied");
    expect(kept(b.sql, b.account.id)).toBe(5);
    // it ends: so do the kept apps, and a later subscription (version 5) covers 3
    const ended = accountSub("sub_acct000001", b.account.id, "cus_ada0000001", "canceled");
    b.s.subs.set(ended.id, ended);
    expect((await json(deliver(b.env, stripeEvent("customer.subscription.deleted", ended), b.s.fetch))).result).toBe("applied");
    expect(kept(b.sql, b.account.id)).toBeNull();
    paidPro(b.sql, b.account.id, 1);
    expect(await plansOf(b)).toEqual([...Array(3).fill("team:paid"), "pro_apps", "pro_apps", "pro_apps"]);
    log.mockRestore();
  });

  it("migration 0021: a paying or granted account's apps count as chosen, and an account subscription keeps its apps; Free's do not", async () => {
    const t = setup(LIVE);
    const ada = await signedIn(t.env);
    const bob = await signedIn(t.env, "bob@example.com");
    const cy = await signedIn(t.env, "cy@example.com");
    const adaApps = [await createApp(t.env, ada.cookie, "Shop"), await createApp(t.env, ada.cookie, "Blog")];
    const bobApps = [await createApp(t.env, bob.cookie, "Mine"), await createApp(t.env, bob.cookie, "Other")];
    const cyApps = [await createApp(t.env, cy.cookie, "Paid"), await createApp(t.env, cy.cookie, "Free one")];
    paidPro(t.sql, ada.account.id, 1);
    projectPaid(t.sql, cyApps[0]!.id);
    // the migration's own statements, run again on these rows (the tests' database ran it empty)
    const sqlText = readFileSync(new URL("../migrations/0021_plans_v5_kept.sql", import.meta.url), "utf8").split("\n").filter((l) => !l.startsWith("--")).join("\n");
    t.sql.db.exec(sqlText.replace(/ALTER TABLE accounts ADD COLUMN apps_kept INTEGER;/, ""));
    expect(kept(t.sql, ada.account.id)).toBe(2);
    expect(kept(t.sql, bob.account.id)).toBeNull();
    expect(kept(t.sql, cy.account.id)).toBeNull();
    for (const a of [...adaApps, ...cyApps]) expect(chosenAt(t.sql, a.id), a.name).not.toBeNull();
    for (const a of bobApps) expect(chosenAt(t.sql, a.id), a.name).toBeNull();
    // so an app Pro covered before opens its dashboard as it did, not "Choose a plan"
    const page = await call(t.env, "GET", `/account/apps/${adaApps[1]!.id}`, { cookie: ada.cookie });
    expect(page.status).toBe(200);
  });

  it("a paid Pro under GenClass's grant of Pro keeps the grant's room: every app, no seat limit", async () => {
    const t = await withApps(["Shop", "Blog", "Docs", "Extra", "Fifth"]);
    setPlan(t.sql, t.account.id, "free", { comp_until: "9999-12-31T00:00:00.000Z", comp_plan: "team" });
    paidPro(t.sql, t.account.id, 1);
    expect(await plansOf(t)).toEqual(Array(5).fill("team:paid"));
    expect(await accountAccess(t.sql.api, t.account.id, t.env, now())).toMatchObject({ source: "paid", seats: null });
  });

  it("from the genclass command, a plan choice goes on to the app's dashboard, never the website's setup with other modes ticked", async () => {
    const t = await withApps(["Shop"]);
    const page = await text(call(t.env, "GET", `/account/billing?project=${t.apps[0]!.id}&from=cli`, { cookie: t.cookie }));
    expect(page.split('(cfg.isNew && !cfg.cli ? "#connect" : "")').length).toBe(3);
    expect(page).not.toContain("cfg.isNew || cfg.cli");
  });

  it("the command's offer lists the trial's line only while the account still has the trial", async () => {
    const t = await withApps(["Shop"]);
    const bearer = await cliToken(t.env, t.cookie);
    const offer = async () => (await json(call(t.env, "GET", "/api/cli/overview", { bearer, origin: null }))).offer;
    expect((await offer()).trial_days).toBe(7);
    expect((await offer()).features).toContain("7 days free to start");
    setPlan(t.sql, t.account.id, "free", { subscription_id: "sub_old0000001", subscription_status: "canceled" });
    expect((await offer()).trial_days).toBeNull();
    expect((await offer()).features).not.toContain("7 days free to start");
    expect((await offer()).features).toContain("Up to 3 apps");
  });
});

describe("sign-in pages the genclass command opens (the 0.3.7 walk)", () => {
  it("the approval never says to go back to the terminal, and a command-line sign-in has no side door to an account-less dashboard", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    const device = await text(call(t.env, "GET", "/login/device", { cookie: a.cookie }));
    expect(device).toContain('finish("Approved", "Your terminal is signed in. You can close this tab.")');
    expect(device.toLowerCase()).not.toContain("back to your terminal");
    const fromCli = await text(call(t.env, "GET", "/signup?next=%2Flogin%2Fdevice%3Fcode%3DBCDF-GHJK", {}));
    expect(fromCli).not.toContain("Just trying it?");
    expect(await text(call(t.env, "GET", "/signup", {}))).toContain("Just trying it?");
  });
});
