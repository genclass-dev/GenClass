import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { resetStripeCache, RETENTION_COUPON, RETENTION_MAX } from "../src/stripe.js";
import { call, cliToken, createApp, fakeStripe, GENCLASS_PORTAL, resetClock, setPlan, setup, signedIn, subscription, WEBHOOK_SECRET } from "./account-helpers.js";

// Cancelling on GenClass's own pages (src/billing.ts cancel routes, src/stripe.ts retentionOffer; the owner, 2026-11-18):
// what the popups are told, the one offer to stay (15% off for 6 months at most, once per customer, never on top of
// another discount), the cancel itself (the plan ends that day, trial or paid, with no refund), the resume, and who may
// do any of it. Stripe is the fake of test/account-helpers.ts. On the two-paid fixture, like test/billing.test.ts.
vi.mock("../../billing/plans.json", async () => ({ default: (await import("./fixtures/plans-two-paid.json")).default }));

const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL, NOTIFY_WEBHOOK: "https://hooks.example.com/notify" };
const CUS = "cus_ada0000001";
const SUB = "sub_ada0000001";
const END = 1_792_000_000;

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
});

/** An account on Pro with its subscription in the fake Stripe (`status`, and anything else `over` sets on it). */
async function paying(status = "active", over: Record<string, unknown> = {}) {
  const t = setup(LIVE);
  const a = await signedIn(t.env);
  const s = fakeStripe();
  s.genclassCustomer(CUS, a.account.id);
  const sub: Record<string, any> = subscription(SUB, a.account.id, CUS, "genclass_pro_monthly", status, { discounts: [], ...over });
  s.subs.set(SUB, sub);
  setPlan(t.sql, a.account.id, "pro", { stripe_customer_id: CUS, subscription_id: SUB, subscription_status: status, stripe_mode: "live", current_period_end: new Date(END * 1000).toISOString() });
  const row = () => t.sql.rows("SELECT plan, subscription_status, cancel_at_period_end FROM accounts")[0];
  const writes = () => s.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.pathname}`);
  const get = (path = "/api/billing/cancel") => call(t.env, "GET", path, { cookie: a.cookie, fetch: s.fetch });
  const post = (path: string, body: Record<string, unknown> = {}) => call(t.env, "POST", path, { body, cookie: a.cookie, fetch: s.fetch });
  const notices = () => s.other.filter((o) => o.url === LIVE.NOTIFY_WEBHOOK).map((o) => JSON.parse(o.body) as { event: string; text: string });
  return { ...t, ...a, s, sub, row, writes, get, post, notices };
}

describe("GET /api/billing/cancel: what the popups say, before anything changes", () => {
  it("a paid plan: its name, the day its paid month would have run to, and the offer to stay; nothing is written", async () => {
    const t = await paying();
    const r = await t.get();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, plan: "Pro", trial: false, ends: new Date(END * 1000).toISOString(), discount: false, offer: { percent_off: 15, months: 6 } });
    expect(t.writes()).toEqual([]);
    expect(t.row()).toEqual({ plan: "pro", subscription_status: "active", cancel_at_period_end: 0 });
  });

  it("a trial: it would end at once", async () => {
    const t = await paying("trialing", { trial_end: END });
    expect(await (await t.get()).json()).toMatchObject({ trial: true, offer: { percent_off: 15, months: 6 } });
  });

  it("no offer on top of another discount, a second time for the same customer, or for a plan whose payment is overdue", async () => {
    const promo = await paying("active", { discounts: ["di_6monthsfree01"] });
    // the popups are told about the discount (a promotion code's free months): it ends with the plan
    expect(await (await promo.get()).json()).toMatchObject({ ok: true, discount: true, offer: null });
    const again = await paying();
    again.s.subs.set("sub_ada0000000", subscription("sub_ada0000000", again.account.id, CUS, "genclass_pro_monthly", "canceled", { metadata: { genclass: "1", genclass_account: again.account.id, genclass_retention: "2026-10-01T00:00:00.000Z" } }));
    expect(await (await again.get()).json()).toMatchObject({ ok: true, offer: null });
    const late = await paying("past_due");
    expect(await (await late.get()).json()).toMatchObject({ ok: true, offer: null });
  });

  it(`never more than ${RETENTION_MAX.percent}% for ${RETENTION_MAX.months} months: a coupon beyond that, not GenClass's, used up or missing is not offered, and cancelling still works`, async () => {
    for (const edit of [
      (c: Record<string, any>) => (c.percent_off = 20),
      (c: Record<string, any>) => (c.duration_in_months = 12),
      (c: Record<string, any>) => (c.duration = "forever"),
      (c: Record<string, any>) => (c.metadata = {}),
      (c: Record<string, any>) => (c.valid = false),
      null,
    ]) {
      const t = await paying();
      if (edit) edit(t.s.coupons.get(RETENTION_COUPON)!);
      else t.s.coupons.delete(RETENTION_COUPON);
      expect(await (await t.get()).json()).toMatchObject({ ok: true, plan: "Pro", offer: null });
      expect((await t.post("/api/billing/cancel/offer")).status).toBe(409);
      expect(t.writes()).toEqual([]);
      expect((await t.post("/api/billing/cancel")).status).toBe(200);
    }
  });

  it("a plan already set to end, or one that has ended, has nothing to cancel", async () => {
    const set = await paying("active", { cancel_at_period_end: true });
    expect((await set.get()).status).toBe(409);
    const ended = await paying("canceled");
    expect((await ended.get()).status).toBe(409);
    expect((await ended.post("/api/billing/cancel")).status).toBe(409);
    expect(ended.writes()).toEqual([]);
  });
});

describe("POST /api/billing/cancel/offer: staying, for 15% less over 6 months", () => {
  it("puts GenClass's coupon on the subscription, marks it taken and tells the owner; the plan goes on", async () => {
    const t = await paying();
    const r = await t.post("/api/billing/cancel/offer");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, percent_off: 15, months: 6 });
    const w = t.s.calls.filter((c) => c.method === "POST");
    expect(w.map((c) => c.url.pathname)).toEqual([`/v1/subscriptions/${SUB}`]);
    expect(Object.fromEntries(w[0]!.form!)).toEqual({ "discounts[0][coupon]": RETENTION_COUPON, "metadata[genclass_retention]": expect.stringMatching(/^20\d\d-/) });
    expect(w[0]!.headers["idempotency-key"]).toBe(`genclass-retention-${SUB}`);
    expect(t.sub.cancel_at_period_end).toBe(false);
    expect(t.row()).toEqual({ plan: "pro", subscription_status: "active", cancel_at_period_end: 0 });
    expect(t.notices()).toEqual([expect.objectContaining({ event: "retention_offer_taken", text: expect.stringContaining("15% off for 6 months: ada@example.com") })]);
    // once: a second cancel sees no offer, and asking for it again is refused
    expect(await (await t.get()).json()).toMatchObject({ offer: null });
    expect((await t.post("/api/billing/cancel/offer")).status).toBe(409);
    expect(t.s.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("POST /api/billing/cancel and /api/billing/resume", () => {
  it("a paid plan ends the day it is cancelled: the subscription is cancelled now, nothing is refunded, the account is on Free, the owner is told", async () => {
    const t = await paying();
    const r = await t.post("/api/billing/cancel");
    expect(await r.json()).toEqual({ ok: true, ended: true, ends: null });
    // one write: the cancel itself. No refund, no credit note, no end set for later
    expect(t.writes()).toEqual([`DELETE /v1/subscriptions/${SUB}`]);
    expect(t.sub.status).toBe("canceled");
    expect(t.row()).toEqual({ plan: "free", subscription_status: "canceled", cancel_at_period_end: 0 });
    expect(t.notices()).toEqual([expect.objectContaining({ event: "plan_cancelled", text: expect.stringMatching(/Pro cancelled \(ended at once; it was paid up to 2026-\d\d-\d\d, nothing refunded\): ada@example\.com/) })]);
    // the page has nothing left to cancel or resume
    const page = await (await call(t.env, "GET", "/account/billing", { cookie: t.cookie })).text();
    expect(page).not.toContain('id="resumeplan"');
    expect(page).not.toContain('id="cancelplan"');
    // a second click finds the plan ended: no write, no second notice
    expect((await t.post("/api/billing/cancel")).status).toBe(409);
    expect(t.writes()).toHaveLength(1);
    expect(t.notices()).toHaveLength(1);
  });

  it("free months from a promotion code end with the plan, the same day", async () => {
    const t = await paying("active", { discounts: ["di_6monthsfree01"] });
    expect(await (await t.post("/api/billing/cancel")).json()).toEqual({ ok: true, ended: true, ends: null });
    expect(t.writes()).toEqual([`DELETE /v1/subscriptions/${SUB}`]);
    expect(t.row()).toEqual({ plan: "free", subscription_status: "canceled", cancel_at_period_end: 0 });
    expect(t.notices()[0]!.text).toContain("nothing refunded, its discount ended too");
  });

  it("a trial ends at once: the subscription is cancelled now and the account is on Free", async () => {
    const t = await paying("trialing", { trial_end: END });
    expect(await (await t.post("/api/billing/cancel")).json()).toEqual({ ok: true, ended: true, ends: null });
    expect(t.writes()).toEqual([`DELETE /v1/subscriptions/${SUB}`]);
    expect(t.row()).toEqual({ plan: "free", subscription_status: "canceled", cancel_at_period_end: 0 });
    expect(t.notices()[0]!.text).toContain("in its trial (ended at once, nothing charged)");
  });

  it("resume undoes an end set for later, however it was set (cancel_at_period_end, or the portal's cancel_at)", async () => {
    const t = await paying("active", { cancel_at_period_end: true });
    expect((await t.post("/api/billing/resume")).status).toBe(200);
    expect(Object.fromEntries(t.s.calls.find((c) => c.method === "POST")!.form!)).toEqual({ cancel_at_period_end: "false" });
    expect(t.row()).toEqual({ plan: "pro", subscription_status: "active", cancel_at_period_end: 0 });
    const old = await paying("active", { cancel_at: END });
    expect((await old.post("/api/billing/resume")).status).toBe(200);
    expect(Object.fromEntries(old.s.calls.find((c) => c.method === "POST")!.form!)).toEqual({ cancel_at: "" });
    expect(old.sub.cancel_at).toBe(null);
    // nothing to resume: no write
    const plain = await paying();
    expect((await plain.post("/api/billing/resume")).status).toBe(200);
    expect(plain.writes()).toEqual([]);
  });

  it("an app's own subscription (bought per app) is cancelled with project_id, and only that one", async () => {
    const t = await paying();
    const app = await createApp(t.env, t.cookie);
    const own = subscription("sub_app0000001", t.account.id, CUS, "genclass_pro_monthly", "active", { discounts: [], metadata: { genclass: "1", genclass_account: t.account.id, genclass_project: app.id } });
    t.s.subs.set(own.id, own);
    t.sql.db.prepare("UPDATE projects SET plan = 'pro', subscription_id = ?, subscription_status = 'active' WHERE id = ?").run(own.id, app.id);
    expect(await (await t.get(`/api/billing/cancel?project=${app.id}`)).json()).toMatchObject({ ok: true, plan: "Pro", trial: false });
    expect((await t.post("/api/billing/cancel", { project_id: app.id })).status).toBe(200);
    expect(t.writes()).toEqual(["DELETE /v1/subscriptions/sub_app0000001"]);
    expect(t.sql.rows("SELECT plan, subscription_status, cancel_at_period_end FROM projects WHERE id = ?", app.id)[0]).toEqual({ plan: null, subscription_status: "canceled", cancel_at_period_end: 0 });
    expect(t.row()).toEqual({ plan: "pro", subscription_status: "active", cancel_at_period_end: 0 });
    // the account's subscription is not an app's, and an app's is not the account's
    t.sql.db.prepare("UPDATE projects SET subscription_id = ? WHERE id = ?").run(SUB, app.id);
    expect((await t.post("/api/billing/cancel", { project_id: app.id })).status).toBe(409);
    expect((await t.post("/api/billing/cancel", { project_id: "nosuchproject0000" })).status).toBe(404);
  });
});

describe("who may cancel: the paying account, in the browser, and only GenClass's own subscription", () => {
  it("signed out, another site's request and the genclass command are refused before any Stripe call", async () => {
    const t = await paying();
    for (const path of ["/api/billing/cancel", "/api/billing/cancel/offer", "/api/billing/resume"]) {
      expect((await call(t.env, "POST", path, { body: {}, fetch: t.s.fetch })).status).toBe(401);
      expect((await call(t.env, "POST", path, { body: {}, cookie: t.cookie, origin: "https://evil.example", fetch: t.s.fetch })).status).toBe(403);
      expect((await call(t.env, "POST", path, { body: {}, bearer: await cliToken(t.env, t.cookie), origin: null, fetch: t.s.fetch })).status).toBe(403);
    }
    expect((await call(t.env, "GET", "/api/billing/cancel", { fetch: t.s.fetch })).status).toBe(401);
    expect((await call(t.env, "PUT", "/api/billing/cancel", { body: {}, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(405);
    expect(t.s.calls).toEqual([]);
  });

  it("an account with no plan, a customer that is not GenClass's, and a subscription that is not this account's change nothing", async () => {
    const free = setup(LIVE);
    const a = await signedIn(free.env);
    const s0 = fakeStripe();
    expect((await call(free.env, "POST", "/api/billing/cancel", { body: {}, cookie: a.cookie, fetch: s0.fetch })).status).toBe(409);
    expect(s0.calls).toEqual([]);

    const foreign = await paying();
    foreign.s.customers.set(CUS, { id: CUS, object: "customer", metadata: {} });
    expect((await foreign.post("/api/billing/cancel")).status).toBe(409);
    expect(foreign.writes()).toEqual([]);

    const other = await paying();
    other.sub.items.data[0].price = { id: "price_other00001", object: "price", lookup_key: null, product: { id: "prod_other00001", object: "product", metadata: {} } };
    for (const path of ["/api/billing/cancel", "/api/billing/cancel/offer", "/api/billing/resume"]) expect((await other.post(path)).status).toBe(409);
    expect(other.writes()).toEqual([]);

    const named = await paying("active", { metadata: { genclass: "1", genclass_account: "someone-else" } });
    expect((await named.post("/api/billing/cancel")).status).toBe(409);
    expect(named.writes()).toEqual([]);
  });
});

describe("the billing page: Cancel plan opens the popups", () => {
  it("a paying account gets the button and the three popups; a Free account gets neither", async () => {
    const t = await paying();
    const page = await (await call(t.env, "GET", "/account/billing", { cookie: t.cookie })).text();
    expect(page).toContain('<button class="btn ghost" type="button" id="cancelplan"><span>Cancel plan</span></button>');
    expect(page).toContain("If you continue, your subscription will end today");
    expect(page).toContain("If you cancel, it ends that day.");
    expect(page).toContain("Nothing is refunded for the days left.");
    for (const id of ["cx1", "cx2", "cx3"]) expect(page).toContain(`<dialog id="${id}" class="cx"`);
    expect(page).toContain('To go back to Free, <a href="#manage">cancel your plan</a>.');
    expect(page).not.toContain("cancel in Manage billing");
    const free = setup(LIVE);
    const a = await signedIn(free.env);
    const none = await (await call(free.env, "GET", "/account/billing", { cookie: a.cookie })).text();
    expect(none).not.toContain('id="cancelplan"');
    expect(none).not.toContain('<dialog id="cx1"');
  });
});
