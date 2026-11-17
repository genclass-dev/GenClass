// Private prices (the Worker secret PLANS_PRIVATE, src/plans.ts usePrivatePlans): a plan can have other prices for some
// countries, never written in this repository. Checkout sells the price for the country Cloudflare reports for the
// request (request.cf.country); a request with no country, or no secret, gets plans.json's price; every lookup key of
// the plan gives it; the screens show the visitor's price, and a message read later shows plans.json's. The values here
// are made up ("ZZ" is no country).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_ACCOUNT_FROM } from "../src/cli.js";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { countryOf, planById, planByLookupKey, planForPrice, priceFor, priceText, problemsLock, usePrivatePlans } from "../src/plans.js";
import { resetStripeCache } from "../src/stripe.js";
import { call, cliToken, createApp, fakeStripe, GENCLASS_PORTAL, price, resetClock, setNow, setup, signedIn, WEBHOOK_SECRET } from "./account-helpers.js";

const PRIVATE = JSON.stringify({
  plans: {
    team: {
      stripe_product: "genclass_team_alt",
      country_prices: [{ countries: ["ZZ"], name: "Zedland", price_usd_cents: { monthly: 2000, yearly: null }, stripe_lookup_keys: { monthly: "genclass_team_zz_monthly", yearly: null } }],
    },
  },
});
const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL, PLANS_PRIVATE: PRIVATE };
const PRO = planById("team");

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
});
afterEach(() => usePrivatePlans(undefined));

async function buyer(over: Record<string, string | undefined> = {}) {
  const t = setup({ ...LIVE, ...over });
  const a = await signedIn(t.env);
  const s = fakeStripe();
  t.sql.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_ada0000001', stripe_mode = 'live' WHERE id = ?").run(a.account.id);
  s.genclassCustomer("cus_ada0000001", a.account.id);
  await createApp(t.env, a.cookie, "Shop");
  return { ...t, ...a, s };
}
const sessionsOf = (s: ReturnType<typeof fakeStripe>) => s.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions").map((c) => Object.fromEntries(c.form!));

describe("private prices (PLANS_PRIVATE)", () => {
  it("plans.json has one price for Pro; the secret adds one for its countries, and both lookup keys give Pro", () => {
    expect(PRO.price_usd_cents.monthly).toBe(5000);
    usePrivatePlans(undefined);
    expect(priceFor(PRO, "ZZ").stripe_lookup_keys.monthly).toBe("genclass_team_monthly");
    expect(planByLookupKey("genclass_team_zz_monthly")).toBeNull();
    usePrivatePlans(PRIVATE);
    expect(priceFor(PRO, "ZZ")).toMatchObject({ price_usd_cents: { monthly: 2000 }, stripe_lookup_keys: { monthly: "genclass_team_zz_monthly" } });
    expect(priceFor(PRO, "zz").price_usd_cents.monthly).toBe(2000);
    for (const c of ["US", "GB", "XX", "T1", null, undefined]) expect(priceFor(PRO, c).stripe_lookup_keys.monthly, String(c)).toBe("genclass_team_monthly");
    expect(planByLookupKey("genclass_team_monthly")?.id).toBe("team");
    expect(planByLookupKey("genclass_team_zz_monthly")?.id).toBe("team");
    // a price on either Pro product is GenClass's Pro
    expect(planForPrice(price("genclass_team_zz_monthly", { product: "genclass_team_alt" }))?.id).toBe("team");
  });

  it("a secret that does not parse, or a price without countries, cents or a genclass_ key, gives no private price", () => {
    const one = (x: unknown) => JSON.stringify({ plans: { team: { country_prices: [x] } } });
    for (const raw of ["{", "[]", JSON.stringify({ plans: { nope: { country_prices: [] } } }), one({ countries: [], price_usd_cents: { monthly: 2000 }, stripe_lookup_keys: { monthly: "genclass_x" } }), one({ countries: ["ZZ"], price_usd_cents: { monthly: 0 }, stripe_lookup_keys: { monthly: "genclass_x" } }), one({ countries: ["ZZ"], price_usd_cents: { monthly: 2000 }, stripe_lookup_keys: { monthly: "other_x" } }), one({ countries: ["Zedland"], price_usd_cents: { monthly: 2000 }, stripe_lookup_keys: { monthly: "genclass_x" } })]) {
      usePrivatePlans(raw);
      expect(priceFor(PRO, "ZZ").stripe_lookup_keys.monthly, raw).toBe("genclass_team_monthly");
    }
  });

  it("the price text: the visitor's country's, else plans.json's, and never the other prices", () => {
    usePrivatePlans(PRIVATE);
    expect(priceText(PRO, "ZZ")).toBe("$20 / developer / month");
    expect(priceText(PRO, "US")).toBe("$50 / developer / month");
    expect(priceText(PRO, null)).toBe("$50 / developer / month");
    expect(priceText(PRO)).toBe("$50 / developer / month");
    expect(priceText(planById("free"), "ZZ")).toBe("$0");
    expect(priceText(planById("enterprise"), "ZZ")).toBe("By agreement");
    expect(problemsLock("https://genclass.dev/account/billing", "ZZ").price).toBe("$20 / developer / month");
    expect(problemsLock("https://genclass.dev/account/billing").price).toBe("$50 / developer / month");
  });

  it("countryOf reads Cloudflare's request.cf.country, and nothing else", () => {
    const req = (cf?: unknown) => {
      const r = new Request("https://genclass.dev/");
      if (cf !== undefined) Object.defineProperty(r, "cf", { value: cf });
      return r;
    };
    expect(countryOf(req({ country: "ZZ" }))).toBe("ZZ");
    expect(countryOf(req({ country: "us" }))).toBe("US");
    expect(countryOf(req({ country: "T1" }))).toBe("T1");
    for (const cf of [undefined, null, {}, { country: "" }, { country: "Zedland" }, { country: 1 }]) expect(countryOf(req(cf)), JSON.stringify(cf)).toBeNull();
    expect(countryOf(null)).toBeNull();
    // a header is not Cloudflare's word
    expect(countryOf(new Request("https://genclass.dev/", { headers: { "cf-ipcountry": "ZZ" } }))).toBeNull();
  });

  it("Checkout from a country with a private price sells it, from anywhere else plans.json's, and says which on the session", async () => {
    for (const [country, priceId, key] of [["ZZ", "price_teamzz00001", "genclass_team_zz_monthly"], ["US", "price_team000001", "genclass_team_monthly"], [undefined, "price_team000001", "genclass_team_monthly"]] as const) {
      resetStripeCache();
      const b = await buyer();
      const r = await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch, ...(country ? { country } : {}) });
      expect(r.status, String(country)).toBe(200);
      const [form] = sessionsOf(b.s);
      expect(form, String(country)).toMatchObject({ "line_items[0][price]": priceId, "metadata[genclass_plan]": "team", "metadata[genclass_price]": key, allow_promotion_codes: "true" });
      const asked = b.s.calls.filter((c) => c.method === "GET" && c.url.pathname === "/v1/prices").map((c) => c.url.searchParams.get("lookup_keys[0]"));
      expect(asked, String(country)).toEqual([key]);
    }
    // without the secret, that country gets plans.json's price too
    resetStripeCache();
    const b = await buyer({ PLANS_PRIVATE: undefined });
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch, country: "ZZ" })).status).toBe(200);
    expect(sessionsOf(b.s)[0]).toMatchObject({ "line_items[0][price]": "price_team000001", "metadata[genclass_price]": "genclass_team_monthly" });
  });

  it("an open Checkout page for another price, or one made before the session named its price, is closed, not reused", async () => {
    const b = await buyer();
    expect((await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch, country: "ZZ" })).status).toBe(200);
    const first = [...b.s.sessions.values()][0] as any;
    expect(first.metadata.genclass_price).toBe("genclass_team_zz_monthly");
    const again = (await (await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch, country: "ZZ" })).json()) as any;
    expect(again.url).toBe(first.url);
    const other = (await (await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch, country: "DE" })).json()) as any;
    expect(other.url).not.toBe(first.url);
    expect(b.s.calls.some((c) => c.method === "POST" && c.url.pathname === `/v1/checkout/sessions/${first.id}/expire`)).toBe(true);
    expect(sessionsOf(b.s).at(-1)).toMatchObject({ "line_items[0][price]": "price_team000001", "metadata[genclass_price]": "genclass_team_monthly" });
    const old = [...b.s.sessions.values()].at(-1) as any;
    delete old.metadata.genclass_price;
    const after = (await (await call(b.env, "POST", "/api/billing/checkout", { body: { plan: "team" }, cookie: b.cookie, fetch: b.s.fetch, country: "DE" })).json()) as any;
    expect(after.url).not.toBe(old.url);
  });

  it("the billing page and the genclass command show the visitor's price, and nothing about other prices", async () => {
    const b = await buyer();
    const zz = await (await call(b.env, "GET", "/account/billing", { cookie: b.cookie, country: "ZZ" })).text();
    expect(zz).toContain('<p class="price">$20 / developer / month</p>');
    expect(zz).not.toContain("$50");
    const us = await (await call(b.env, "GET", "/account/billing", { cookie: b.cookie, country: "US" })).text();
    expect(us).toContain('<p class="price">$50 / developer / month</p>');
    expect(us).not.toContain("$20");
    expect(us).not.toContain("Zedland");
    setNow(new Date(Date.parse(CLI_ACCOUNT_FROM) + 3_600_000));
    const t = setup(LIVE);
    const me = await signedIn(t.env, "grace@example.com");
    const token = await cliToken(t.env, me.cookie);
    for (const [country, want] of [["ZZ", "$20 / developer / month"], ["FR", "$50 / developer / month"]] as const) {
      const res = await call(t.env, "GET", "/api/cli/account", { bearer: token, origin: null, country });
      const cli = (await res.json()) as any;
      expect(res.status, JSON.stringify(cli)).toBe(200);
      expect(cli.cli.price, country).toBe(want);
    }
  });
});
