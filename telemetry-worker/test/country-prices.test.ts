// Prices by country (billing/plans.json country_prices, the owner's call of 2026-11-16): Pro is US$50 a developer a
// month everywhere but Canada, where it stays US$15 under the lookup key it was sold under before
// (genclass_team_monthly). Checkout sells the price of the country Cloudflare reports for the request (request.cf.country);
// a request with no country gets the plan's own price; every lookup key of the plan gives Pro; the screens show the
// visitor's price, and a message read later (an email) names both.
import { beforeEach, describe, expect, it } from "vitest";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { countryOf, planById, planByLookupKey, planForPrice, priceFor, priceText, problemsLock } from "../src/plans.js";
import { CLI_ACCOUNT_FROM } from "../src/cli.js";
import { resetStripeCache } from "../src/stripe.js";
import { call, cliToken, createApp, fakeStripe, GENCLASS_PORTAL, price, resetClock, setNow, setup, signedIn, WEBHOOK_SECRET } from "./account-helpers.js";

const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL };
const PRO = planById("team");

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
});

async function buyer() {
  const t = setup(LIVE);
  const a = await signedIn(t.env);
  const s = fakeStripe();
  t.sql.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_ada0000001', stripe_mode = 'live' WHERE id = ?").run(a.account.id);
  s.genclassCustomer("cus_ada0000001", a.account.id);
  await createApp(t.env, a.cookie, "Shop");
  return { ...t, ...a, s };
}
const sessionsOf = (s: ReturnType<typeof fakeStripe>) => s.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions").map((c) => Object.fromEntries(c.form!));

describe("prices by country (billing/plans.json country_prices)", () => {
  it("Pro is $50 a developer a month, $15 in Canada; both lookup keys give Pro", () => {
    expect(PRO.price_usd_cents.monthly).toBe(5000);
    expect(priceFor(PRO, "CA")).toMatchObject({ price_usd_cents: { monthly: 1500 }, stripe_lookup_keys: { monthly: "genclass_team_monthly" } });
    for (const c of ["US", "GB", "IN", "XX", "T1", null, undefined]) expect(priceFor(PRO, c).stripe_lookup_keys.monthly, String(c)).toBe("genclass_team_world_monthly");
    expect(priceFor(PRO, "ca").price_usd_cents.monthly).toBe(1500);
    expect(planByLookupKey("genclass_team_monthly")?.id).toBe("team");
    expect(planByLookupKey("genclass_team_world_monthly")?.id).toBe("team");
    // a price on either Pro product is GenClass's Pro
    expect(planForPrice(price("genclass_team_world_monthly", { product: "genclass_team_world" }))?.id).toBe("team");
    expect(planForPrice(price("genclass_team_monthly"))?.id).toBe("team");
  });

  it("the price text: the visitor's country's, the plan's own without one, both for a reader whose country is not known", () => {
    expect(priceText(PRO, "CA")).toBe("$15 / developer / month");
    expect(priceText(PRO, "US")).toBe("$50 / developer / month");
    expect(priceText(PRO, null)).toBe("$50 / developer / month");
    expect(priceText(PRO)).toBe("$50 / developer / month ($15 in Canada)");
    expect(priceText(planById("free"), "CA")).toBe("$0");
    expect(priceText(planById("enterprise"), "CA")).toBe("By agreement");
    expect(problemsLock("https://genclass.dev/account/billing", "CA").price).toBe("$15 / developer / month");
  });

  it("countryOf reads Cloudflare's request.cf.country, and nothing else", () => {
    const req = (cf?: unknown) => {
      const r = new Request("https://genclass.dev/");
      if (cf !== undefined) Object.defineProperty(r, "cf", { value: cf });
      return r;
    };
    expect(countryOf(req({ country: "CA" }))).toBe("CA");
    expect(countryOf(req({ country: "us" }))).toBe("US");
    expect(countryOf(req({ country: "T1" }))).toBe("T1");
    for (const cf of [undefined, null, {}, { country: "" }, { country: "Canada" }, { country: 1 }]) expect(countryOf(req(cf)), JSON.stringify(cf)).toBeNull();
    expect(countryOf(null)).toBeNull();
    // a header saying Canada is not Cloudflare's word
    expect(countryOf(new Request("https://genclass.dev/", { headers: { "cf-ipcountry": "CA" } }))).toBeNull();
  });

  it("Checkout from Canada sells the $15 price, from anywhere else the $50 one, and says which on the session", async () => {
    for (const [country, priceId, key] of [["CA", "price_team000001", "genclass_team_monthly"], ["US", "price_teamworld1", "genclass_team_world_monthly"], [undefined, "price_teamworld1", "genclass_team_world_monthly"]] as const) {
      resetStripeCache();
      const b = await buyer();
      const r = await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch, ...(country ? { country } : {}) });
      expect(r.status, String(country)).toBe(200);
      const [form] = sessionsOf(b.s);
      expect(form, String(country)).toMatchObject({ "line_items[0][price]": priceId, "metadata[genclass_plan]": "team", "metadata[genclass_price]": key, allow_promotion_codes: "true" });
      // Stripe was asked for that price by its lookup key only
      const asked = b.s.calls.filter((c) => c.method === "GET" && c.url.pathname === "/v1/prices").map((c) => c.url.searchParams.get("lookup_keys[0]"));
      expect(asked, String(country)).toEqual([key]);
    }
  });

  it("an open Checkout page for the other country's price, or one made before prices by country, is closed, not reused", async () => {
    const b = await buyer();
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch, country: "CA" })).status).toBe(200);
    const first = [...b.s.sessions.values()][0] as any;
    expect(first.metadata.genclass_price).toBe("genclass_team_monthly");
    // the same country again: the same page
    const again = (await (await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch, country: "CA" })).json()) as any;
    expect(again.url).toBe(first.url);
    // from elsewhere: the Canadian page is closed and a $50 one made
    const other = (await (await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch, country: "DE" })).json()) as any;
    expect(other.url).not.toBe(first.url);
    expect(b.s.calls.some((c) => c.method === "POST" && c.url.pathname === `/v1/checkout/sessions/${first.id}/expire`)).toBe(true);
    expect(sessionsOf(b.s).at(-1)).toMatchObject({ "line_items[0][price]": "price_teamworld1", "metadata[genclass_price]": "genclass_team_world_monthly" });
    // a page from before (no genclass_price) is closed too
    const old = [...b.s.sessions.values()].at(-1) as any;
    delete old.metadata.genclass_price;
    const after = (await (await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch, country: "DE" })).json()) as any;
    expect(after.url).not.toBe(old.url);
  });

  it("the billing page and the genclass command show the visitor's price", async () => {
    const b = await buyer();
    const ca = await (await call(b.env, "GET", "/account/billing", { cookie: b.cookie, country: "CA" })).text();
    expect(ca).toContain('<p class="price">$15 / developer / month</p>');
    expect(ca).not.toContain("$50");
    const us = await (await call(b.env, "GET", "/account/billing", { cookie: b.cookie, country: "US" })).text();
    expect(us).toContain('<p class="price">$50 / developer / month</p>');
    expect(us).not.toContain("$15 /");
    // the genclass command, on a new account approved after the approval page listed the account route
    setNow(new Date(Date.parse(CLI_ACCOUNT_FROM) + 3_600_000));
    const t = setup(LIVE);
    const me = await signedIn(t.env, "grace@example.com");
    const token = await cliToken(t.env, me.cookie);
    for (const [country, want] of [["CA", "$15 / developer / month"], ["FR", "$50 / developer / month"]] as const) {
      const res = await call(t.env, "GET", "/api/cli/account", { bearer: token, origin: null, country });
      const cli = (await res.json()) as any;
      expect(res.status, JSON.stringify(cli)).toBe(200);
      expect(cli.cli.price, country).toBe(want);
    }
  });
});
