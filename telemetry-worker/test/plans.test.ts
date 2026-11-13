import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PLANS_JSON from "../../billing/plans.json";
import SEATS_JSON from "./fixtures/plans-v3-seats.json";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { accessOf, accountProjectsAccess, byAgreement, cleanSeats, firstPaidWith, firstPlanWith, FREE, GRANT_PLAN, hasAsk, hasProblems, ownedPrice, PAID_PLANS, PLANS, planByLookupKey, planForPrice, priceText, problemsLock, RETIRED_PLAN_IDS, seatsOf, viewRanges, type Plan } from "../src/plans.js";
import { isGenClassSubscription, resetStripeCache, retiredSubscription, subscriptionState } from "../src/stripe.js";
import {
  call,
  createApp,
  deliver,
  fakeStripe,
  GENCLASS_PORTAL,
  invoice,
  price,
  resetClock,
  sendBatch,
  detection,
  setPlan,
  setup,
  signedIn,
  stripeEvent,
  subscription,
  WEBHOOK_SECRET,
} from "./account-helpers.js";

// The real plans (billing/plans.json, version 5, 2026-11-13), with no fixture: Free, Pro (id team; named Team until
// 2026-11-12) and Enterprise. Free finds and fixes the problems and shows their totals (one app, 7 days shown, one
// suggestion); Pro is sold on Stripe Checkout for the account, per developer (US$15 a developer a month, up to 3
// apps, 3 days free once per account), and adds the problem lists, genclass ask, every suggestion, visitor analytics, forwarding, export, 90 days
// and the whole team (test/project-plans.test.ts); Enterprise is agreed by email and given by GenClass's own grant, with the
// classifier a person trains. The old trial (/account/trial, 2026-10) stays gone. Selling one paid plan that is not per seat (Individual, until 2026-10-22) is tested on
// test/fixtures/plans-individual.json (one-paid tests); the machinery that two paid plans or a locked dashboard reach
// on test/fixtures/plans-two-paid.json (billing, locked, dashboard, auth, export and forward tests).

// a live-mode key: what is sold would be on sale to everyone (fetch is always the fake Stripe)
const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL };

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
});

const text = async (r: Promise<Response> | Response) => (await r).text();
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!doctype html>/gi, "");

describe("billing/plans.json: the one source of plans", () => {
  it("has Free, Pro (id team) and Enterprise with the owner's prices, limits and entitlements (version 5, 2026-11-13: per developer, up to 3 apps)", () => {
    expect(PLANS.map((p) => p.id)).toEqual(["free", "team", "enterprise"]);
    // the paid plan keeps its id (Stripe's lookup key, the rows in D1) and is called Pro since 2026-11-12
    expect(PLANS.map((p) => p.name)).toEqual(["Free", "Pro", "Enterprise"]);
    const [free, team, enterprise] = PLANS;
    expect(free!.price_usd_cents).toEqual({ monthly: 0, yearly: null });
    // US$15 a developer a month, for up to 3 apps (the owner, 2026-11-13; a project a month the day before)
    expect(team!.price_usd_cents).toEqual({ monthly: 1500, yearly: null });
    expect(enterprise!.price_usd_cents).toEqual({ monthly: null, yearly: null });
    expect(PLANS.map((p) => p.stripe_lookup_keys)).toEqual([
      { monthly: null, yearly: null },
      { monthly: "genclass_team_monthly", yearly: null },
      { monthly: null, yearly: null },
    ]);
    // Free: finds and fixes the problems and shows their totals, for one person and one app (version 5); the problem
    // lists and genclass ask come with Pro (the owner's "limit free fully", 2026-11-12), and one suggestion is shown
    expect(free!.limits).toEqual({ apps: 1, history_days: 7, seats: 1, live_fixes_per_month: 100 });
    expect(free!.entitlements).toEqual({ dashboard: true, forwarding: false, export: false, analytics: false, custom_model: false, github_private: false, problems: false, ask: false });
    expect(free!.suggestions).toEqual({ per_day: 3, shown: 1 });
    expect(free!.summary).toMatch(/^One app\b/);
    // the owner's words for Free's list (2026-11-13): one app, a limited dashboard, the open-source basics, first
    expect(free!.features.slice(0, 2).map((x) => x.text)).toEqual(["One app", "Dashboard totals, last 7 days"]);
    expect(free!.features.map((x) => x.text)).toEqual(expect.arrayContaining(["Open-source runtime, every mode", "On-device model", "Coding-agent loop on your machine (@genclass/mcp)", "Self-host the collector"]));
    // Pro: sold for the account per developer (per_seat), not per project any more, for up to 3 apps (limits.apps);
    // everything a team uses but the classifier a person trains. More apps are Enterprise's
    expect(PLANS.map((p) => p.per_seat)).toEqual([false, true, false]);
    expect(PLANS.map((p) => p.per_project === true)).toEqual([false, false, false]);
    expect(PLANS.map((p) => p.apps_per_unit)).toEqual([undefined, undefined, undefined]);
    expect(team!.summary).toBe("Everything for up to 3 apps, per developer.");
    expect(team!.features.map((x) => x.text)).toEqual(expect.arrayContaining(["Up to 3 apps", "The genclass command in your terminal", "Your team on it, $15 a developer"]));
    expect(enterprise!.features.map((x) => x.text)).toContain("More than 3 apps");
    expect(team!.limits).toEqual({ apps: 3, history_days: 90, seats: null, live_fixes_per_month: null });
    expect(team!.entitlements).toEqual({ dashboard: true, forwarding: true, export: true, analytics: true, custom_model: false, github_private: true, problems: true, ask: true });
    expect(team!.suggestions).toEqual({ per_day: 30, shown: null });
    expect(team!.features[0]).toEqual({ text: "Everything in Free", available: true });
    // Pro starts with 3 days free (once per account: src/billing.ts trialFor); no other plan has a trial
    expect(PLANS.map((p) => p.trial_days)).toEqual([undefined, 3, undefined]);
    expect(team!.features.map((x) => x.text)).toContain("3 days free to start");
    expect(enterprise!.limits).toEqual({ apps: null, history_days: 365, seats: null, live_fixes_per_month: null });
    expect(enterprise!.entitlements).toEqual({ dashboard: true, forwarding: true, export: true, analytics: true, custom_model: true, github_private: true, problems: true, ask: true });
    expect(enterprise!.features[0]).toEqual({ text: "Everything in Pro", available: true });
    // the classifier a person from GenClass trains is in Enterprise only, in the entitlements and in the feature lines
    expect(PLANS.filter((p) => p.features.some((x) => /Your own classifier/.test(x.text))).map((p) => p.id)).toEqual(["enterprise"]);
    // every feature line is available: nothing is listed as coming next
    for (const p of PLANS) expect(p.features.filter((x) => !x.available), p.id).toEqual([]);
    // short lines (the owner, 2026-11-11: less text): a plan says each thing in a few words, and itself in one line
    for (const p of PLANS) {
      expect(p.summary.length, p.id).toBeLessThanOrEqual(70);
      for (const x of p.features) expect(x.text.length, x.text).toBeLessThanOrEqual(60);
    }
    expect(PLANS.map((p) => p.managed_payments)).toEqual([false, false, false]);
    expect(PLANS.map((p) => p.stripe_tax_code)).toEqual([null, "txcd_10103001", null]);
    // Team is the one plan sold on the site; Enterprise is agreed by email and is what GenClass's grant gives
    expect(PAID_PLANS.map((p) => p.id)).toEqual(["team"]);
    expect(PLANS.filter(byAgreement).map((p) => p.id)).toEqual(["enterprise"]);
    expect(GRANT_PLAN.id).toBe("enterprise");
    expect(FREE.id).toBe("free");
    expect(priceText(free!)).toBe("$0");
    expect(priceText(team!)).toBe("$15 / developer / month");
    expect(priceText(enterprise!)).toBe("By agreement");
    expect(planByLookupKey("genclass_team_monthly")?.id).toBe("team");
    // Individual (until 2026-10-22) and the plans before it name no plan any more
    for (const k of ["genclass_individual_monthly", "genclass_pro_monthly"]) expect(planByLookupKey(k), k).toBeNull();
    expect(viewRanges(free!)).toEqual(["24h", "7d"]);
    expect(viewRanges(team!)).toEqual(["24h", "7d", "30d", "90d"]);
    expect(viewRanges(enterprise!)).toEqual(["24h", "7d", "30d", "90d", "1y"]);
    expect((PLANS_JSON as any).version).toBe(5);
    expect((PLANS_JSON as any).footer).toBe("Questions about Pro, Enterprise, your own classifier, self-hosting or invoices? Email mehar@genclass.dev.");
    expect((PLANS_JSON as any).grant_plan).toBe("enterprise");
    expect(PLANS_JSON).not.toHaveProperty("trial_days");
  });

  it("feature text follows the voice rules: no em-dashes, no exclamation marks; Pro's trial is said as days free", () => {
    const text = JSON.stringify(PLANS_JSON);
    expect(text).not.toMatch(/—|!/);
    expect(JSON.stringify((PLANS_JSON as any).plans)).not.toMatch(/\btrial\b/i);
    // only Pro's lines speak of days free
    expect(PLANS.filter((p) => p.features.some((x) => /days free/.test(x.text))).map((p) => p.id)).toEqual(["team"]);
  });

  it("problems and ask: Free has neither, Pro and Enterprise both; a plan file without the keys gives them", () => {
    const of = (plan: Plan) => ({ plan, source: null, seats: null });
    expect(PLANS.map((p) => [p.id, hasProblems(of(p)), hasAsk(of(p))])).toEqual([["free", false, false], ["team", true, true], ["enterprise", true, true]]);
    // the plan an upgrade names: the first one on sale with it
    expect(firstPaidWith("problems")?.id).toBe("team");
    expect(firstPaidWith("ask")?.id).toBe("team");
    expect(problemsLock("https://genclass.dev/account/billing?project=p1")).toEqual({ plan: "Pro", upgrade_url: "https://genclass.dev/account/billing?project=p1", trial_days: 3, price: "$15 / developer / month" });
    // the per-seat plans of version 3 (test/fixtures/plans-v3-seats.json) say nothing of them: every plan gives them
    const v3 = (SEATS_JSON as any).plans as Plan[];
    expect(v3.every((p) => !("problems" in p.entitlements) && !("ask" in p.entitlements))).toBe(true);
    for (const p of v3) expect([p.id, hasProblems(of(p)), hasAsk(of(p))]).toEqual([p.id, true, true]);
    // an explicit true is the same as no key; only false takes them away
    expect(hasProblems(of({ ...FREE, entitlements: { ...FREE.entitlements, problems: true } }))).toBe(true);
    // analytics still names the first plan that has it (Pro), on sale or not
    expect(firstPlanWith("analytics")?.name).toBe("Pro");
  });

  it("accessOf: a paid plan or GenClass's grant, whichever plans.json lists later; Free otherwise; and the seats each holds", () => {
    const at = new Date("2026-10-19T12:00:00Z");
    const later = "2026-12-31T00:00:00.000Z";
    const row = (o: Record<string, unknown> = {}) => ({ plan: "free", stripe_mode: null, comp_until: null, ...o });
    const none = { plan: FREE, source: null, seats: 1 };
    expect(accessOf(null, null, at)).toEqual(none);
    expect(accessOf(row(), "live", at)).toEqual(none);
    expect(accessOf(row({ comp_until: later }), "live", at)).toMatchObject({ source: "comp", plan: { id: "enterprise" }, seats: null });
    expect(accessOf(row({ comp_until: "2026-10-01T00:00:00.000Z" }), "live", at)).toEqual(none);
    // the plans that ended (Pro and Custom on 2026-10-19, Individual on 2026-10-22) count as Free
    expect(accessOf(row({ plan: "individual", stripe_mode: "live" }), "live", at)).toEqual(none);
    expect(accessOf(row({ plan: "individual", comp_until: later }), "live", at)).toMatchObject({ source: "comp", plan: { id: "enterprise" } });
    expect(accessOf(row({ plan: "pro" }), "live", at)).toEqual(none);
    expect(accessOf(row({ plan: "custom", stripe_mode: "live" }), "live", at)).toEqual(none);
    // Pro, paid (per developer since version 5): the seats paid for, at least 1
    expect(accessOf(row({ plan: "team", stripe_mode: "live", seats: 4 }), "live", at)).toMatchObject({ source: "paid", plan: { id: "team" }, seats: 4 });
    expect(accessOf(row({ plan: "team", stripe_mode: "live" }), "live", at)).toMatchObject({ source: "paid", plan: { id: "team" }, seats: 1 });
    // bought in test mode: counts only under a test key
    expect(accessOf(row({ plan: "team", stripe_mode: "test", seats: 4 }), "live", at)).toEqual(none);
    expect(accessOf(row({ plan: "team", stripe_mode: "test", seats: 4 }), "test", at)).toMatchObject({ source: "paid", seats: 4 });
    // a grant names its plan (comp_plan); unknown, empty or free: plans.json grant_plan. A grant has no seat count
    expect(accessOf(row({ comp_until: later, comp_plan: "team" }), "live", at)).toMatchObject({ source: "comp", plan: { id: "team" }, seats: null });
    for (const comp_plan of [null, "", "free", "pro"]) expect(accessOf(row({ comp_until: later, comp_plan }), "live", at), String(comp_plan)).toMatchObject({ source: "comp", plan: { id: "enterprise" } });
    // both: the plan listed later applies (a Team grant does not lower a paid Team's seats; an Enterprise grant wins)
    expect(accessOf(row({ plan: "team", stripe_mode: "live", seats: 2, comp_until: later, comp_plan: "team" }), "live", at)).toMatchObject({ source: "paid", seats: 2 });
    expect(accessOf(row({ plan: "team", stripe_mode: "live", seats: 2, comp_until: later }), "live", at)).toMatchObject({ source: "comp", plan: { id: "enterprise" }, seats: null });
    // PLAN_GATES open (a self-hosted collector): everyone, an app without an account too, has the grant plan
    expect(accessOf(null, null, at, true)).toMatchObject({ source: "open", plan: { id: "enterprise" }, seats: null });
    expect(accessOf(row(), null, at, true)).toMatchObject({ source: "open", plan: { id: "enterprise" } });
  });

  it("seats: 1 to 200 whole seats; a paid per-seat plan holds what was paid for, any other plan its own limit", () => {
    for (const ok of [1, 2, 200]) expect(cleanSeats(ok)).toBe(ok);
    for (const bad of [0, -1, 201, 1.5, "3", null, undefined, NaN, Infinity]) expect(cleanSeats(bad), String(bad)).toBeNull();
    const [free, team, enterprise] = PLANS;
    expect(seatsOf(free!, null, null)).toBe(1);
    // Pro is per developer since version 5: paid, what was paid for (at least 1); granted, no seat count
    expect(seatsOf(team!, "paid", 5)).toBe(5);
    expect(seatsOf(team!, "paid", 0)).toBe(1);
    expect(seatsOf(team!, "comp", 5)).toBeNull();
    // a plan not sold per seat holds its own limit
    expect(seatsOf({ ...team!, per_seat: false }, "paid", 5)).toBeNull();
    expect(seatsOf(enterprise!, "comp", null)).toBeNull();
  });
});

describe("the dashboard is free: every app opens it, with an account or without", () => {
  it("a private link from /start (and the 0.3.0-beta.0 CLI's init) opens the dashboard and its stats", async () => {
    const { env } = setup();
    const j = (await (await call(env, "POST", "/api/projects", { body: { name: "shop-web" }, origin: null })).json()) as any;
    const path = new URL(j.dashboardUrl).pathname;
    const page = await call(env, "GET", path, { origin: null });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain("has no dashboard");
    expect(html).toContain("shop-web");
    expect((await call(env, "GET", `/api/projects/${path.split("/").pop()}?range=30d`, { origin: null })).status).toBe(200);
  });

  it("a new account on Free: 3 apps, their dashboards with the totals, 7 days shown; problems, analytics, export and forwarding answer with the plans", async () => {
    const { env } = setup(LIVE);
    const { cookie } = await signedIn(env);
    const apps = [];
    for (const n of ["a", "b", "c"]) apps.push(await createApp(env, cookie, n));
    // a fourth app is created and waits for a plan of its own (plans per project, version 4: test/project-plans.test.ts)
    const fourth = await call(env, "POST", "/api/account/projects", { body: { name: "d" }, cookie });
    expect(fourth.status).toBe(201);
    // Free chosen for it on its plan page first (until then the app's page opens that plan page)
    expect((await call(env, "GET", `/account/apps/${apps[0]!.id}`, { cookie })).headers.get("location")).toBe(`/account/billing?project=${apps[0]!.id}`);
    expect((await call(env, "POST", `/api/billing/projects/${apps[0]!.id}/free`, { cookie, body: { reason: "trying" } })).status).toBe(200);
    const page = await text(call(env, "GET", `/account/apps/${apps[0]!.id}`, { cookie }));
    expect(page).not.toContain("has no dashboard");
    // the sections are there and say which plans have them; no forms
    expect(page).toContain('<p class="intro">Included in Pro and Enterprise. <a href="/account/billing">See plans</a></p>');
    // the problem sections give way to one banner with the way to Pro, shown by the page script when the stats say so
    expect(page).toContain('<div class="prolock hidden" id="prolock">');
    expect(page).not.toContain('id="exf"');
    expect(page).not.toContain("data-kind=");
    // the Visitors view has its upgrade panel, shown by the page script when the stats say analytics are left out
    expect(page).toContain('<div id="ixlock" class="hidden">');
    const st = await call(env, "GET", `/api/account/projects/${apps[0]!.id}/stats?range=1y`, { cookie });
    expect(st.status).toBe(200);
    const stats = (await st.json()) as any;
    // a longer ask than Free's 7 days gets the longest it shows
    expect(stats.range).toBe("7d");
    // Free sees the totals: the problem lists, pages and latest events come with Pro, from the app's plan page
    expect(stats.locked).toEqual({
      analytics: { plan: "Pro", upgrade_url: "https://genclass.dev/account/billing" },
      problems: { plan: "Pro", upgrade_url: `https://genclass.dev/account/billing?project=${apps[0]!.id}`, trial_days: 3, price: "$15 / developer / month" },
    });
    expect([stats.breakdowns, stats.recent]).toEqual([{}, []]);
    const denied = async (r: Promise<Response>, what: string) => {
      const res = await r;
      expect(res.status, what).toBe(403);
      const j = (await res.json()) as any;
      expect(j.upgrade_url, what).toBe("https://genclass.dev/account/billing");
      expect(j.error, what).toContain("Pro and Enterprise");
    };
    await denied(call(env, "GET", `/api/account/projects/${apps[0]!.id}/events`, { cookie }), "export");
    await denied(call(env, "POST", "/api/account/export-keys", { body: {}, cookie }), "export key");
    await denied(call(env, "PUT", `/api/account/projects/${apps[0]!.id}/integrations/slack`, { body: { url: "https://hooks.slack.com/services/T0/B0/x" }, cookie }), "forwarding");
    // reading the forwarding settings says they are not in the plan
    expect(await (await call(env, "GET", `/api/account/projects/${apps[0]!.id}/integrations`, { cookie })).json()).toEqual({ forwarding: false, integrations: [] });
    const account = await text(call(env, "GET", "/account", { cookie }));
    expect(account).not.toContain("has no dashboard");
  });

  it("visitor analytics are counted on Free and left out of its stats; the same request answers in full on Team", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie, "shop");
    const view = { t: "interactions", seq: 1, at: 10, view: 1, route: "/pricing", start: true, visit: "0123456789abcdef", entry: true, device: "mobile", browser: "Safari", os: "iOS", returning: false };
    expect((await sendBatch(env, app.token, [view, ...detection()])).status).toBe(202);
    const read = async () => (await (await call(env, "GET", `/api/account/projects/${app.id}/stats?range=7d`, { cookie })).json()) as any;
    const free = await read();
    expect(free.locked.analytics.plan).toBe("Pro");
    expect(Object.keys(free.totals).filter((k) => k.startsWith("ix_"))).toEqual([]);
    expect(Object.keys(free.breakdowns).filter((k) => k.startsWith("ix_"))).toEqual([]);
    expect(free.visits).toEqual({ sessions: 0, pages: 0, bounces: 0, entry: [], exit: [] });
    expect(free.series.every((r: any) => r.ix_views === 0 && r.ix_sessions === 0)).toBe(true);
    // what GenClass found is counted: Free sees the totals (the lists come with Pro: locked.problems)
    expect(free.totals.detections).toBe(1);
    expect(free.locked.problems.plan).toBe("Pro");
    // the counters were written all the same
    expect(sql.rows("SELECT COUNT(*) AS n FROM daily WHERE metric = 'ix_views'")[0]!.n).toBeGreaterThan(0);
    setPlan(sql, account.id, "team", { stripe_mode: "live", seats: 1, subscription_id: "sub_t000000001", subscription_status: "active" });
    const team = await read();
    expect(team.locked).toBeUndefined();
    expect(team.totals.ix_views).toBe(1);
    expect(team.visits.sessions).toBe(1);
    expect(team.totals.detections).toBe(1);
    expect(team.breakdowns.detect_issue).toEqual([{ key: "duplicate\t/checkout", count: 1 }]);
    expect(team.recent.length).toBeGreaterThan(0);
  });

  it("a private link shows what Free shows (7 days, the totals, no visitor analytics); a server with PLAN_GATES open shows everything", async () => {
    for (const [over, range, locked] of [[{}, "7d", true], [{ PLAN_GATES: "open" }, "30d", false]] as const) {
      const { env } = setup(over);
      const j = (await (await call(env, "POST", "/api/projects", { body: { name: "shop-web" }, origin: null })).json()) as any;
      const secret = new URL(j.dashboardUrl).pathname.split("/").pop()!;
      await sendBatch(env, j.token, [{ t: "session", host: "shop.example", route: "/" }, ...detection("stale", "/search")]);
      const st = (await (await call(env, "GET", `/api/projects/${secret}?range=30d`, { origin: null })).json()) as any;
      expect(st.range, range).toBe(range);
      expect(!!st.locked?.analytics, range).toBe(locked);
      expect(st.totals.detections, range).toBe(1);
      if (locked) {
        // the app has no account: the way to Pro is the plans page
        expect(st.locked.problems).toEqual({ plan: "Pro", upgrade_url: "https://genclass.dev/account/billing", trial_days: 3, price: "$15 / developer / month" });
        expect([st.breakdowns, st.recent]).toEqual([{}, []]);
      } else {
        expect(st.locked).toBeUndefined();
        expect(st.breakdowns.detect_issue).toEqual([{ key: "stale\t/search", count: 1 }]);
      }
    }
    // the sample dashboard is shown whole
    const { env } = setup();
    const sample = (await (await call(env, "GET", "/api/projects/sample?range=7d", { origin: null })).json()) as any;
    expect(sample.locked?.problems).toBeUndefined();
    expect(Object.keys(sample.breakdowns).filter((k) => !k.startsWith("ix_")).length).toBeGreaterThan(0);
    expect(sample.recent.length).toBeGreaterThan(0);
  });
});

describe("the old trial stays gone; Pro's 3 days free are offered on the plan page, once per account", () => {
  it("POST /api/billing/trial is 410, GET /account/trial leads to /account through sign-up, and Stripe is never called", async () => {
    const { env } = setup(LIVE);
    const s = fakeStripe();
    expect((await call(env, "GET", "/account/trial", { fetch: s.fetch })).headers.get("location")).toBe("/signup?next=%2Faccount");
    const { cookie } = await signedIn(env);
    expect((await call(env, "GET", "/account/trial", { cookie, fetch: s.fetch })).headers.get("location")).toBe("/account");
    const r = await call(env, "POST", "/api/billing/trial", { body: {}, cookie, fetch: s.fetch });
    expect(r.status).toBe(410);
    expect(((await r.json()) as any).error).toBe("a trial starts at Checkout, on an app's plan page: https://genclass.dev/account/billing");
    expect(s.calls).toEqual([]);
    expect(await (await call(env, "GET", "/api/billing", { cookie })).json()).toEqual({
      plan: "free",
      subscription_status: null,
      current_period_end: null,
      cancel_at_period_end: false,
      // Team is on sale to everyone under a live key
      on_sale: true,
      access: null,
      // Free holds one person
      seats: 1,
    });
  });

  it("the public pages offer no trial and say the dashboard is free; no page links to the old trial; the plan page offers Pro's 3 days free only to an account that never had a subscription", async () => {
    const { env, sql } = setup(LIVE);
    const pages: [string, string][] = [];
    for (const p of ["/start", "/signup", "/login"]) pages.push([p, await text(call(env, "GET", p, {}))]);
    for (const [p, html] of pages) expect(visible(html), p).not.toMatch(/trial/i);
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie, "a");
    for (const p of ["/account", "/account/billing", `/account/apps/${app.id}`, `/account/billing?project=${app.id}`]) pages.push([p, await text(call(env, "GET", p, { cookie }))]);
    for (const [p, html] of pages) {
      expect(html, p).not.toContain("/api/billing/trial");
      expect(html, p).not.toContain("/account/trial");
    }
    expect(pages[0]![1]).toContain("Free. No sign-up.");
    expect(pages[1]![1]).toContain('<p class="opt">Just trying it? <a href="/start">Create a dashboard without an account</a>.</p>');
    expect(pages[2]![1]).toContain('<p class="opt">Just trying it? <a href="/start">Create a dashboard without an account</a>.</p>');
    // the app's plan page, for an account that has never had a subscription: the trial, and what follows it
    const eligible = pages.find(([p]) => p.startsWith("/account/billing?project="))![1];
    expect(eligible).toContain('data-plan="team" data-pick><span>Start your 3-day free trial</span>');
    expect(eligible).toContain('<p class="trialnote">3 days free, then $15 / developer / month. Cancel before the trial ends and you pay nothing.</p>');
    expect(visible(eligible)).not.toMatch(/—|!/);
    const planPage = () => text(call(env, "GET", `/account/billing?project=${app.id}`, { cookie }));
    const noTrial = (html: string, why: string) => {
      expect(html, why).toContain('data-plan="team" data-pick><span>Start Pro</span>');
      expect(html, why).not.toContain("free trial");
      expect(html, why).not.toContain('class="trialnote"');
    };
    // an account that had a subscription of its own, even one cancelled long ago
    setPlan(sql, account.id, "free", { subscription_id: "sub_old0000001", subscription_status: "canceled" });
    noTrial(await planPage(), "an account subscription");
    setPlan(sql, account.id, "free", { subscription_id: null, subscription_status: null });
    expect(await planPage()).toContain("Start your 3-day free trial");
    // one of its projects had a subscription (version 4)
    const other = await createApp(env, cookie, "b");
    sql.db.prepare("UPDATE projects SET subscription_id = 'sub_b000000001', subscription_status = 'canceled' WHERE id = ?").run(other.id);
    noTrial(await planPage(), "a project's subscription");
    // an app on GenClass's grant (which covers every app of the account since version 5) goes on with it: no trial
    sql.db.prepare("UPDATE projects SET subscription_id = NULL, subscription_status = NULL WHERE id = ?").run(other.id);
    sql.db.prepare("UPDATE projects SET comp_until = '9999-12-31T00:00:00.000Z', comp_plan = 'team' WHERE id = ?").run(app.id);
    const granted = await planPage();
    expect(granted).toContain("Your <b>Pro</b> plan, set up by GenClass, covers <b>a</b>.");
    expect(granted).toContain('<button class="btn" type="button" data-continue><span>Continue with Pro</span></button>');
    expect(granted).not.toContain("free trial");
    expect(granted).not.toContain("data-pick");
  });

  it("nothing in src/ asks Stripe for a trial but Checkout's plan trial_days, or writes the old trial's columns", () => {
    const dir = new URL("../src/", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const code = readFileSync(new URL(f, dir), "utf8");
      // the one trial (2026-11-12, owner): Team's trial_days on a first subscription, in Checkout only (src/stripe.ts)
      const rest = f === "stripe.ts" ? code.replace("...(trialDays ? { trial_period_days: trialDays } : {})", "") : code;
      expect(rest, f).not.toMatch(/trial_period_days|trial_settings|payment_intents|trial_started_at\s*=|trial_ends_at\s*=|trial_check_failures\s*=/);
      expect(code, f).not.toMatch(/INSERT INTO accounts[^;`]*\b(trial_ends_at|trial_started_at|comp_until)\b/);
      // the one place: the Checkout Session's subscription_data, from the caller's trialDays (src/billing.ts trialFor)
      const asks = code.match(/trial_period_days/g) ?? [];
      if (f === "stripe.ts") {
        expect(asks, f).toHaveLength(1);
        expect(code).toContain("...(trialDays ? { trial_period_days: trialDays } : {})");
      } else expect(asks, f).toEqual([]);
    }
    // TRIAL_DAYS is gone from the worker's configuration: the days are plans.json's trial_days
    expect(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8")).not.toMatch(/TRIAL_DAYS/);
  });

  it("the CLI says the dashboard is free, and never offers a trial", () => {
    for (const f of ["../../packages/runtime/bin/genclass-runtime.mjs", "../../packages/runtime/bin/lib/init.mjs"]) {
      const cli = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(cli, f).not.toMatch(/trial|needs Pro|\/account\/trial/i);
      expect(cli, f).toMatch(/dashboard is free/);
    }
  });
});

describe("Pro (id team) is the one plan sold on the site, for the account; Enterprise by email", () => {
  it("checkout sells Pro and nothing else, for the account, and never calls Stripe for another plan", async () => {
    const { env } = setup(LIVE);
    const { cookie } = await signedIn(env);
    const s = fakeStripe();
    for (const plan of ["individual", "enterprise", "free", "pro", "custom"]) {
      const r = await call(env, "POST", "/api/billing/checkout", { body: { plan }, cookie, fetch: s.fetch });
      expect(r.status, plan).toBe(400);
      expect(((await r.json()) as any).error).toBe("choose a plan: team");
    }
    expect(s.calls).toEqual([]);
    // seats that are not 1 to 200 whole developers are refused before Stripe is asked
    for (const seats of [0, 201, 1.5, "2"]) {
      const bad = await call(env, "POST", "/api/billing/checkout", { body: { plan: "team", seats }, cookie, fetch: s.fetch });
      expect(bad.status, String(seats)).toBe(400);
      expect(((await bad.json()) as any).error).toBe("seats is a whole number from 1 to 200; for a larger team email mehar@genclass.dev");
    }
    expect(s.calls).toEqual([]);
    // Pro is the account's, per developer (version 5): no project needed, the quantity is the seats asked for
    const r = await call(env, "POST", "/api/billing/checkout", { body: { plan: "team", seats: 3 }, cookie, fetch: s.fetch });
    expect(r.status).toBe(200);
    const session = s.calls.find((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions")!;
    expect(session.form!.get("line_items[0][quantity]")).toBe("3");
    expect(session.form!.get("metadata[genclass_seats]")).toBe("3");
    expect(session.form!.has("metadata[genclass_project]")).toBe(false);
  });

  it("the account's subscription: the webhook writes the account and its seats; it covers the account's first 3 apps, whatever the seats", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    const s = fakeStripe();
    t.sql.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_ada0000001', stripe_mode = 'live' WHERE id = ?").run(a.account.id);
    s.genclassCustomer("cus_ada0000001", a.account.id);
    const app = await createApp(t.env, a.cookie, "Shop");
    const sub = (status = "active") => subscription("sub_ada0000001", a.account.id, "cus_ada0000001", "genclass_team_monthly", status, { items: { data: [{ id: "si_ada0000001", current_period_end: 1_792_000_000, quantity: 4, price: price("genclass_team_monthly") }] } });
    // Pro is sold per developer (version 5): the quantity is the seats
    expect(subscriptionState(sub())).toMatchObject({ plan: "team", priced: "team", seats: 4 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const apply = async (o: Record<string, unknown>) => {
      s.subs.set("sub_ada0000001", o);
      expect(await (await deliver(t.env, stripeEvent("customer.subscription.updated", o), s.fetch)).json()).toEqual({ received: true, result: "applied" });
      return t.sql.rows("SELECT plan, seats FROM accounts")[0];
    };
    expect(await apply(sub())).toEqual({ plan: "team", seats: 4 });
    // the account holds the 4 people paid for
    expect(await (await call(t.env, "GET", "/api/billing", { cookie: a.cookie })).json()).toMatchObject({ plan: "team", access: "paid", seats: 4 });
    expect(((await (await call(t.env, "GET", `/api/account/projects/${app.id}/stats?range=90d`, { cookie: a.cookie })).json()) as any).range).toBe("90d");
    // up to 3 apps, oldest first, however many seats; a 4th is past Pro's (more apps are Enterprise's)
    for (const n of ["Blog", "Docs", "Extra"]) await createApp(t.env, a.cookie, n);
    const plans = await accountProjectsAccess(t.sql.api, a.account.id, t.env, new Date());
    expect(plans.map((x) => x.access.locked ?? x.access.plan.id)).toEqual(["team", "team", "team", "pro_apps"]);
    expect(plans.map((x) => x.access.apps)).toEqual([3, 3, 3, 3]);
    const after = await apply(sub("canceled"));
    expect(after!.plan).toBe("free");
    log.mockRestore();
  });

  it("the billing page: three plans; Pro for the account, per developer, with its seats and button; Talk to us for Enterprise", async () => {
    for (const keys of [{}, LIVE]) {
      const t = setup(keys);
      const a = await signedIn(t.env);
      await createApp(t.env, a.cookie, "Shop");
      const page = await text(call(t.env, "GET", "/account/billing", { cookie: a.cookie }));
      const live = "STRIPE_SECRET_KEY" in keys;
      expect(page).toContain(live ? "You are on the <b>Free</b> plan.</p>" : "You are on the <b>Free</b> plan. Paid plans are not on sale yet.</p>");
      expect(page).toContain("grid-template-columns:repeat(3,minmax(0,1fr))");
      expect(page).toContain('<p class="price">$15 / developer / month</p>');
      expect(page).toContain("<li>Your team on it, $15 a developer</li>");
      expect(page).toContain("<li>More than 3 apps</li>");
      expect(page.match(/<li>Your own classifier/g)).toHaveLength(1);
      // bought for the account here, with how many developers (no project to choose first)
      if (live) {
        expect(page).toContain('data-plan="team"><span>Upgrade to Pro</span>');
        expect(page).toContain('id="seats-team"');
      } else {
        expect(page).not.toContain("data-plan=");
        expect(page).not.toContain('id="seats-team"');
      }
      expect(page).not.toContain("Choose a project");
      expect(page).toContain("<tr><td>Shop</td><td>Free</td>");
      expect(page).toContain('<a class="btn ghost" href="mailto:mehar@genclass.dev?subject=GenClass%20Enterprise"><span>Talk to us</span></a>');
      expect(page).toContain('<p class="price">By agreement</p>');
      expect(visible(page)).not.toMatch(/—|!/);
    }
  });

  it("a paid Pro account: the status line says its seats and the price; a server with PLAN_GATES open says it sells nothing", async () => {
    const t = setup(LIVE);
    const a = await signedIn(t.env);
    setPlan(t.sql, a.account.id, "team", { stripe_customer_id: "cus_b000000001", stripe_mode: "live", seats: 3, subscription_id: "sub_b000000001", subscription_status: "active", current_period_end: "2026-11-13T12:00:00.000Z" });
    const page = await text(call(t.env, "GET", "/account/billing", { cookie: a.cookie }));
    expect(page).toContain('You are on the <b>Pro</b> plan with <b>3 seats</b>, $15 / developer / month ($45 a month). It renews on <time datetime="2026-11-13T12:00:00.000Z" data-f="date">2026-11-13</time>. Add or remove seats in Manage billing.');
    expect(page).toContain('<span class="tag">Your plan</span>');
    const open = setup({ PLAN_GATES: "open" });
    const b = await signedIn(open.env);
    const self = await text(call(open.env, "GET", "/account/billing", { cookie: b.cookie }));
    expect(self).toContain("This server gives every account everything in <b>Enterprise</b>: it sells no plans (PLAN_GATES is open).");
    expect(self).toContain('<span class="tag">This server</span>');
    expect(self).not.toContain("data-plan=");
  });

  it("an account still stored on Individual reads as Free; GenClass's grant gives Enterprise", async () => {
    const t = setup(LIVE);
    const b = await signedIn(t.env);
    setPlan(t.sql, b.account.id, "individual", { stripe_customer_id: "cus_b000000001", subscription_id: "sub_b000000001", subscription_status: "active", current_period_end: "2026-11-19T12:00:00.000Z" });
    expect(((await (await call(t.env, "GET", "/api/billing", { cookie: b.cookie })).json()) as any).plan).toBe("free");
    setPlan(t.sql, b.account.id, "free", { stripe_customer_id: null, subscription_id: null, subscription_status: null, current_period_end: null, comp_until: "9999-12-31T00:00:00.000Z" });
    const granted = await text(call(t.env, "GET", "/account/billing", { cookie: b.cookie }));
    expect(granted).toContain("You have <b>Enterprise</b>, set up by GenClass.");
    expect(granted).toContain('<span class="tag">Set up by GenClass</span>');
    // a grant that names team gives Pro (accounts.comp_plan)
    setPlan(t.sql, b.account.id, "free", { comp_plan: "team" });
    expect(await text(call(t.env, "GET", "/account/billing", { cookie: b.cookie }))).toContain("You have <b>Pro</b>, set up by GenClass.");
  });
});

describe("a retired plan's subscription (Individual until 2026-10-22): GenClass's, but Free", () => {
  // an Individual subscriber from before the plan ended, with the real plans
  const subscriber = async (status = "active") => {
    const t = setup({ ...LIVE, NOTIFY_WEBHOOK: "https://hooks.example.com/notify" });
    const a = await signedIn(t.env);
    const s = fakeStripe();
    setPlan(t.sql, a.account.id, "individual", { stripe_customer_id: "cus_ada0000001", subscription_id: "sub_ada0000001", subscription_status: status, current_period_end: "2026-11-19T12:00:00.000Z", stripe_mode: "live" });
    s.genclassCustomer("cus_ada0000001", a.account.id);
    s.subs.set("sub_ada0000001", subscription("sub_ada0000001", a.account.id, "cus_ada0000001", "genclass_individual_monthly", status, { latest_invoice: "in_ada0000001" }));
    s.invoices.set("in_ada0000001", invoice("in_ada0000001", "cus_ada0000001", "sub_ada0000001", [["price_indiv00001", 2900]]));
    return { ...t, ...a, s };
  };

  it("its price is GenClass's (ownership) but names no plan; another business's price is still not GenClass's", () => {
    expect(RETIRED_PLAN_IDS).toEqual(["pro", "custom", "individual"]);
    const indiv = price("genclass_individual_monthly");
    expect(planForPrice(indiv)).toBeNull();
    expect(ownedPrice(indiv)).toBe(true);
    // both halves still needed: a genclass_ lookup key and the product's genclass_plan
    expect(ownedPrice(price("other_tires_monthly", { plan: "individual" }))).toBe(false);
    expect(ownedPrice(price("genclass_individual_monthly", { plan: null }))).toBe(false);
    expect(ownedPrice(price("genclass_x_monthly", { plan: "someone_else" }))).toBe(false);
    const sub = subscription("sub_ada0000001", "A".repeat(22), "cus_ada0000001", "genclass_individual_monthly");
    expect(isGenClassSubscription(sub)).toBe(true);
    expect(retiredSubscription(sub)).toBe(true);
    expect(subscriptionState(sub)).toMatchObject({ plan: "free", priced: null, status: "active", lookupKey: "genclass_individual_monthly" });
  });

  it("deleting the account cancels it, so a deleted account is never charged again", async () => {
    const t = await subscriber();
    expect((await call(t.env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(204);
    expect(t.s.calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname)).toEqual(["/v1/subscriptions/sub_ada0000001"]);
  });

  it("Manage billing opens the portal for it, active or cancelled; the page says it still bills", async () => {
    for (const status of ["active", "canceled"]) {
      const t = await subscriber(status);
      const r = await call(t.env, "POST", "/api/billing/portal", { body: {}, cookie: t.cookie, fetch: t.s.fetch });
      expect(r.status, status).toBe(200);
      expect(t.s.other, status).toEqual([]);
      const page = await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }));
      expect(page).toContain('id="portal"');
      expect(page).not.toContain("within 1 business day");
      if (status === "active") expect(page).toContain("Your subscription to a plan GenClass no longer sells is still open in Stripe and can bill again: cancel it in Manage billing");
      else expect(page).not.toContain("no longer sells");
    }
  });

  it("the billing page never asks to pay it: past due or unpaid says cancel; cancelled at period end says when it ends", async () => {
    // as stored before the plan ended (accounts.plan still names it): every status that can bill
    for (const status of ["past_due", "unpaid", "trialing"]) {
      const t = await subscriber(status);
      const page = await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }));
      expect(page, status).toContain("Your subscription to a plan GenClass no longer sells is still open in Stripe and can bill again: cancel it in Manage billing");
      expect(page, status).not.toMatch(/get the plan back|Update your card/);
    }
    // as the webhook stores it now (plan free): a live subscription that gives no plan can only be a retired plan's.
    // An overdue one on a Free account is not told apart from Team's own lapsed payment, now that a plan is on sale
    for (const status of ["active", "trialing"]) {
      const t = await subscriber(status);
      setPlan(t.sql, t.account.id, "free", { subscription_status: status });
      const page = await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }));
      expect(page, status).toContain("Your subscription to a plan GenClass no longer sells is still open in Stripe and can bill again: cancel it in Manage billing");
      expect(page, status).not.toMatch(/get the plan back|Update your card/);
    }
    const t = await subscriber();
    setPlan(t.sql, t.account.id, "free", { cancel_at_period_end: 1, current_period_end: "2026-11-19T12:00:00.000Z" });
    const page = await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }));
    expect(page).toContain('Your subscription to a plan GenClass no longer sells is cancelled and ends on <time datetime="2026-11-19T12:00:00.000Z" data-f="date">2026-11-19</time>, without another charge.');
    expect(page).not.toContain("can bill again");
  });

  it("one that starts billing (a Checkout opened before the plan ended) is recorded as Free, and the owner hears once per payment", async () => {
    const t = setup({ ...LIVE, NOTIFY_WEBHOOK: "https://hooks.example.com/notify" });
    const a = await signedIn(t.env);
    const s = fakeStripe();
    t.sql.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_ada0000001', stripe_mode = 'live' WHERE id = ?").run(a.account.id);
    s.genclassCustomer("cus_ada0000001", a.account.id);
    const sub = subscription("sub_ada0000001", a.account.id, "cus_ada0000001", "genclass_individual_monthly", "active", { latest_invoice: "in_ada0000001" });
    s.subs.set("sub_ada0000001", sub);
    s.invoices.set("in_ada0000001", invoice("in_ada0000001", "cus_ada0000001", "sub_ada0000001", [["price_indiv00001", 2900]]));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // one start sends created, a status change and invoice.paid: the owner hears once, for the payment
    for (const ev of [
      stripeEvent("customer.subscription.created", sub),
      stripeEvent("customer.subscription.updated", sub, undefined, { data: { object: sub, previous_attributes: { status: "incomplete" } } }),
      stripeEvent("invoice.paid", s.invoices.get("in_ada0000001")!),
    ]) {
      expect(await (await deliver(t.env, ev, s.fetch)).json(), ev.type).toEqual({ received: true, result: "applied" });
    }
    log.mockRestore();
    expect(t.sql.rows("SELECT plan, subscription_id, subscription_status FROM accounts")).toEqual([{ plan: "free", subscription_id: "sub_ada0000001", subscription_status: "active" }]);
    // no custom_requests row: the classifier is free and asked for by email, not bought
    expect(t.sql.rows("SELECT id FROM custom_requests")).toEqual([]);
    expect(s.other).toHaveLength(1);
    const notice = JSON.parse(s.other[0]!.body);
    expect(notice).toMatchObject({ event: "retired_plan_billing", account_id: a.account.id, subscription_id: "sub_ada0000001", lookup_key: "genclass_individual_monthly", mode: "live" });
    expect(notice.text).toBe(
      `GenClass account ${a.account.id}: a payment of subscription sub_ada0000001 (genclass_individual_monthly) cleared, for a plan GenClass no longer sells; the account reads as Free. Cancel and refund it in Stripe.`,
    );
    expect(((await (await call(t.env, "GET", "/api/billing", { cookie: a.cookie })).json()) as any)).toMatchObject({ plan: "free", subscription_status: "active", on_sale: true, access: null });
  });
});
