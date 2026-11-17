import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { planForPrice } from "../src/plans.js";

// scripts/stripe-setup.mjs on the real billing/plans.json, whose Pro has a price by country (2026-11-16: US$50 a
// developer a month, US$15 in Canada). Each price is on its own product, both named GenClass Pro with metadata
// genclass_plan team (the Billing Portal's seat changes allow one monthly price a product): Canada's on the plan's
// main product genclass_team under the key it was sold under before, everyone else's on genclass_team_world, which
// plans.json names (stripe_product). A run against an account that already has them changes nothing.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any;
beforeAll(async () => {
  process.env.GENCLASS_PLANS_FILE = fileURLToPath(new URL("../../billing/plans.json", import.meta.url));
  setup = await import("../../scripts/stripe-setup.mjs");
});

type Obj = Record<string, any>;

function fields(body: string): Obj {
  const out: Obj = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const arr = /^([a-z_]+)\[\d+\]$/.exec(k);
    if (arr) (out[arr[1]!] ??= []).push(v);
    else out[k] = v;
  }
  return out;
}
const meta = (body: Obj): Obj => Object.fromEntries(Object.entries(body).filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));

/** A small fake Stripe account: products, prices, webhook endpoints and portal configurations, nothing else. */
function account() {
  const products = new Map<string, Obj>();
  const prices = new Map<string, Obj>();
  const endpoints = new Map<string, Obj>();
  const portal = new Map<string, Obj>([["bpc_default00001", { id: "bpc_default00001", is_default: true, active: true, metadata: {} }]]);
  const calls: { method: string; url: URL; body: Obj }[] = [];
  let n = 0;
  const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = method === "POST" ? fields(String(init.body ?? "")) : {};
    calls.push({ method, url, body });
    const p = url.pathname;
    const q = url.searchParams;
    let m: RegExpExecArray | null;
    if (method === "GET" && p === "/v1/products/search") {
      const want = /^metadata\['genclass_plan'\]:'([a-z]+)'$/.exec(q.get("query") ?? "")![1];
      return ok({ data: [...products.values()].filter((x) => x.metadata?.genclass_plan === want), has_more: false });
    }
    if ((m = /^\/v1\/products\/([^/]+)$/.exec(p))) {
      const x = products.get(m[1]!);
      if (!x) return ok({ error: { code: "resource_missing" } }, 404);
      if (method === "POST") Object.assign(x, { name: body.name ?? x.name, description: body.description ?? x.description, statement_descriptor: body.statement_descriptor ?? x.statement_descriptor, tax_code: body.tax_code ?? x.tax_code });
      return ok(x);
    }
    if (method === "POST" && p === "/v1/products") {
      const x = { id: body.id, object: "product", active: true, name: body.name, description: body.description, statement_descriptor: body.statement_descriptor, tax_code: body.tax_code, metadata: meta(body) };
      products.set(x.id, x);
      return ok(x);
    }
    if (method === "GET" && p === "/v1/prices") return ok({ data: [...prices.values()].filter((x) => x.lookup_key === q.get("lookup_keys[0]")).slice(0, 1), has_more: false });
    if (method === "POST" && p === "/v1/prices") {
      const x = { id: `price_gc${String(++n).padStart(6, "0")}`, object: "price", product: body.product, unit_amount: Number(body.unit_amount), currency: body.currency, recurring: { interval: body["recurring[interval]"] }, lookup_key: body.lookup_key, nickname: body.nickname, active: true, metadata: meta(body) };
      prices.set(x.id, x);
      return ok(x);
    }
    if (method === "GET" && p === "/v1/webhook_endpoints") return ok({ data: [...endpoints.values()], has_more: false });
    if (method === "POST" && p === "/v1/webhook_endpoints") {
      const x = { id: `we_gc${++n}`, url: body.url, description: body.description, enabled_events: body.enabled_events, api_version: body.api_version, status: "enabled", metadata: meta(body) };
      endpoints.set(x.id, x);
      return ok({ ...x, secret: "whsec_fresh" });
    }
    if (method === "GET" && p === "/v1/billing_portal/configurations") {
      const d = q.get("is_default");
      return ok({ data: [...portal.values()].filter((c) => d === null || String(c.is_default) === d), has_more: false });
    }
    if (method === "POST" && p === "/v1/billing_portal/configurations") {
      const x = { id: `bpc_gc${++n}`, is_default: false, active: true, metadata: meta(body), form: body };
      portal.set(x.id, x);
      return ok(x);
    }
    if (method === "POST" && (m = /^\/v1\/billing_portal\/configurations\/([^/]+)$/.exec(p))) {
      const x = portal.get(m[1]!)!;
      x.form = body;
      return ok(x);
    }
    return ok({ error: { message: `fake Stripe has no ${method} ${p}` } }, 404);
  };
  return { products, prices, portal, calls, fetch };
}

async function run(a: ReturnType<typeof account>) {
  const from = a.calls.length;
  await setup.main({ argv: [], env: { STRIPE_SECRET_KEY: "sk_test_fake" }, fetch: a.fetch, log: () => undefined, putSecret: async () => true });
  return a.calls.slice(from).filter((c) => c.method !== "GET");
}

describe("scripts/stripe-setup.mjs: prices by country (billing/plans.json country_prices)", () => {
  it("Pro: Canada's US$15 on genclass_team, everyone else's US$50 on genclass_team_world, both seat-changeable in the portal", async () => {
    const a = account();
    await run(a);
    expect([...a.products.values()].map((x) => [x.id, x.name, x.metadata.genclass_plan, x.tax_code])).toEqual([
      ["genclass_team_world", "GenClass Pro", "team", "txcd_10103001"],
      ["genclass_team", "GenClass Pro", "team", "txcd_10103001"],
    ]);
    const made = [...a.prices.values()].map((x) => [x.lookup_key, x.product, x.unit_amount, x.currency, x.recurring.interval, x.nickname]);
    expect(made).toEqual([
      ["genclass_team_world_monthly", "genclass_team_world", 5000, "usd", "month", "Pro monthly"],
      ["genclass_team_monthly", "genclass_team", 1500, "usd", "month", "Pro monthly (Canada)"],
    ]);
    // the worker reads both as Pro
    for (const x of a.prices.values()) expect(planForPrice({ ...x, product: a.products.get(x.product) })?.id).toBe("team");
    // the portal: one product per price, each its own price only
    const ours = [...a.portal.values()].find((c) => c.metadata.genclass === "1")!;
    const form = new URLSearchParams(Object.entries(ours.form as Obj).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])) as [string, string][]);
    const products = [...form.entries()].filter(([k]) => /^features\[subscription_update\]\[products\]\[\d+\]\[product\]$/.test(k)).map(([, v]) => v);
    expect(products).toEqual(["genclass_team_world", "genclass_team"]);
  });

  it("a second run changes no product or price", async () => {
    const a = account();
    await run(a);
    const again = await run(a);
    expect(again.filter((c) => c.url.pathname.startsWith("/v1/products") || c.url.pathname.startsWith("/v1/prices"))).toEqual([]);
  });

  it("a product the plans name is found by its id only: an earlier product of the plan is never taken for it", async () => {
    const a = account();
    // an earlier run's product of Pro with an id Stripe chose (found by the metadata search) holds Canada's price
    a.products.set("prod_earlier00001", { id: "prod_earlier00001", object: "product", active: true, name: "GenClass Pro", description: "Everything for up to 3 apps, per developer.", statement_descriptor: "GENCLASS", tax_code: "txcd_10103001", metadata: { genclass: "1", genclass_plan: "team" } });
    a.prices.set("price_earlier0001", { id: "price_earlier0001", object: "price", product: "prod_earlier00001", unit_amount: 1500, currency: "usd", recurring: { interval: "month" }, lookup_key: "genclass_team_monthly", active: true, metadata: { genclass: "1", genclass_plan: "team" } });
    await run(a);
    expect(a.products.has("genclass_team")).toBe(false);
    expect(a.products.get("genclass_team_world")?.metadata.genclass_plan).toBe("team");
    expect([...a.prices.values()].filter((x) => x.active).map((x) => [x.lookup_key, x.product])).toEqual([
      ["genclass_team_monthly", "prod_earlier00001"],
      ["genclass_team_world_monthly", "genclass_team_world"],
    ]);
  });
});
