// The page check's Pro (owner, 2026-11-15: the score is Pro's): GET /api/billing/pro, which the page check
// (genclass-scan, over a service binding) asks for each report with a browser's cookie or the genclass command's
// token; and the way back from Pro's checkout to the report (?next=/scan?url=..., billing.ts scanNext): the sign-in,
// the plan page, Stripe's success and cancel addresses, and the plan page once the payment shows.
import { beforeEach, describe, expect, it } from "vitest";
import { scanNext } from "../src/billing.js";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { resetStripeCache } from "../src/stripe.js";
import { call, cliToken, fakeStripe, GENCLASS_PORTAL, resetClock, setPlan, setup, signedIn, WEBHOOK_SECRET } from "./account-helpers.js";

const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL };
type E = Parameters<typeof call>[0];

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
});

async function user(env: E, email = "ada@example.com") {
  const me = await signedIn(env, email);
  return { ...me, bearer: await cliToken(env, me.cookie) };
}
/** A paid account on `plan` (Pro: id team) as the webhook leaves it; Pro holds one developer, Business the whole team. */
const team = (sql: ReturnType<typeof setup>["sql"], accountId: string, plan = "team") =>
  setPlan(sql, accountId, plan, { stripe_mode: "live", seats: null, subscription_id: "sub_t000000001", subscription_status: "active", current_period_end: "2026-12-13T12:00:00.000Z" });
const pro = async (env: E, o: { cookie?: string; bearer?: string }) => {
  const r = await call(env, "GET", "/api/billing/pro", { ...o, origin: null });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe("GET /api/billing/pro: whether a sign-in has Pro, for the page check", () => {
  it("answers for a browser session and the genclass command's token alike: Free with its trial, Pro, Business, a grant, a team's seat", async () => {
    const t = setup(LIVE);
    expect((await pro(t.env, {})).status).toBe(401);
    const me = await user(t.env);
    const FREE = { ok: true, pro: false, via: null, trial_days: 3 };
    expect(await pro(t.env, { cookie: me.cookie })).toEqual({ status: 200, body: FREE });
    expect(await pro(t.env, { bearer: me.bearer })).toEqual({ status: 200, body: FREE });
    team(t.sql, me.account.id);
    const PRO = { ok: true, pro: true, via: "plan", trial_days: null };
    expect(await pro(t.env, { cookie: me.cookie })).toEqual({ status: 200, body: PRO });
    expect(await pro(t.env, { bearer: me.bearer })).toEqual({ status: 200, body: PRO });
    // GenClass's grant
    const g = await user(t.env, "grace@example.com");
    setPlan(t.sql, g.account.id, "free", { comp_until: "9999-12-31T00:00:00.000Z", comp_plan: "team" });
    expect((await pro(t.env, { cookie: g.cookie })).body).toMatchObject({ pro: true, via: "plan" });
    // Business has everything Pro has
    team(t.sql, me.account.id, "business");
    expect(await pro(t.env, { cookie: me.cookie })).toEqual({ status: 200, body: PRO });
    expect(await pro(t.env, { bearer: me.bearer })).toEqual({ status: 200, body: PRO });
    // a seat on a paying owner's team (Business: the whole team)
    const bob = await user(t.env, "bob@example.com");
    expect((await pro(t.env, { bearer: bob.bearer })).body).toMatchObject({ pro: false });
    const inv = (await (await call(t.env, "POST", "/api/team/invites", { body: {}, cookie: me.cookie })).json()) as { url: string };
    expect((await call(t.env, "POST", "/api/team/join", { body: { code: inv.url.split("/").pop() }, cookie: bob.cookie })).status).toBe(200);
    expect((await pro(t.env, { bearer: bob.bearer })).body).toEqual({ ok: true, pro: true, via: "team", trial_days: null });
    expect((await call(t.env, "POST", "/api/billing/pro", { cookie: me.cookie })).status).toBe(405);
  });
  it("is open where nothing is sold (no Stripe key), as the genclass command is", async () => {
    const t = setup();
    const me = await user(t.env);
    expect((await pro(t.env, { cookie: me.cookie })).body).toEqual({ ok: true, pro: true, via: "open", trial_days: null });
  });
});

describe("back to the report after Pro's checkout (?next=)", () => {
  const NEXT = "/scan?url=" + encodeURIComponent("https://shop.example.com/");
  it("takes only the page check as a way back", () => {
    expect(scanNext(NEXT)).toBe(NEXT);
    expect(scanNext("/scan")).toBe("/scan");
    for (const bad of ["/account", "//evil.example", "https://evil.example", "/scanner", "/scan?url=a&next=//evil.example", null]) expect(scanNext(bad)).toBeNull();
  });
  it("keeps it through the sign-in, sends a Pro account straight back, and puts it on Stripe's success and cancel addresses", async () => {
    const t = setup(LIVE);
    const start = `/account/billing?plan=pro&start=1&next=${encodeURIComponent(NEXT)}`;
    const out = await call(t.env, "GET", start, { origin: null });
    expect(out.status).toBe(302);
    const login = new URL(out.headers.get("location")!, "https://genclass.dev");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("next")).toBe(start);
    const me = await signedIn(t.env);
    // Free: the plan page opens the checkout itself, and its script knows where to go after
    const page = await call(t.env, "GET", start, { cookie: me.cookie, origin: null });
    expect(page.status).toBe(200);
    const html = await page.text();
    const cfg = JSON.parse(/<script type="application\/json" id="cfg">([^<]*)<\/script>/.exec(html)![1]!.replace(/\\u003c/g, "<"));
    expect(cfg).toMatchObject({ go: true, next: NEXT, done: false });
    // a bad next is dropped
    const bad = await (await call(t.env, "GET", "/account/billing?plan=pro&start=1&next=%2F%2Fevil.example", { cookie: me.cookie, origin: null })).text();
    expect(bad).not.toContain("evil.example");
    // the checkout: Stripe comes back to the plan page with next, which waits for the payment; a cancel goes to the report
    const s = fakeStripe();
    const r = await call(t.env, "POST", "/api/billing/checkout", { body: { plan: "team", next: NEXT }, cookie: me.cookie, fetch: s.fetch });
    expect(r.status).toBe(200);
    const session = s.calls.find((x) => x.url.pathname === "/v1/checkout/sessions" && x.method === "POST")!;
    const f = Object.fromEntries(session.form!);
    expect(f.success_url).toBe(`https://genclass.dev/account/billing?done=1&next=${encodeURIComponent(NEXT)}`);
    expect(f.cancel_url).toBe(`https://genclass.dev${NEXT}`);
    expect(f["metadata[genclass_next]"]).toBe(NEXT);
    // a next that is not the page check is ignored
    const other = await signedIn(t.env, "eve@example.com");
    expect((await call(t.env, "POST", "/api/billing/checkout", { body: { plan: "team", next: "//evil.example" }, cookie: other.cookie, fetch: s.fetch })).status).toBe(200);
    const f2 = Object.fromEntries(s.calls.filter((x) => x.url.pathname === "/v1/checkout/sessions" && x.method === "POST").pop()!.form!);
    expect(f2.success_url).toBe("https://genclass.dev/account/billing?done=1");
    expect(f2.cancel_url).toBe("https://genclass.dev/account/billing");
    expect(f2["metadata[genclass_next]"]).toBeUndefined();
    // paid by the time Stripe sends the person back: straight to the report
    team(t.sql, me.account.id);
    const back = await call(t.env, "GET", `/account/billing?done=1&next=${encodeURIComponent(NEXT)}`, { cookie: me.cookie, origin: null });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(NEXT);
  });
});
