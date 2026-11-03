// Seeds orders for the Medusa admin hunt (docs/adoption/hunts/medusa-admin.md). Not part of CI.
//
//   node docs/adoption/hunts/medusa-admin/seed.mjs [--orders 12] [--qty 20]
//
// Talks only to the local backend (http://localhost:9000, the dtc-starter seeded by `medusa db:migrate`) through its
// public HTTP API, as a storefront and an admin would: logs in as admin@test.com, reads the default publishable key,
// region, shipping option and two variants, then for each order creates a cart with two lines of --qty each, adds
// an address, a shipping method and a system-provider payment session, completes the cart, fulfils every line and
// marks the fulfilment delivered (returns, exchanges and claims only offer delivered quantities). Prints the order ids
// and display ids as JSON (also written to orders.json beside this file). --open leaves the orders unfulfilled (an
// order edit only lets a quantity above the fulfilled one be typed) and writes orders-open.json instead.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: arg } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:9000" },
    orders: { type: "string", default: "12" },
    qty: { type: "string", default: "20" },
    open: { type: "boolean", default: false },
  },
});
const B = arg.base;
const here = dirname(fileURLToPath(import.meta.url));

async function call(method, path, body, headers = {}) {
  const r = await fetch(`${B}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

const { token } = await call("POST", "/auth/user/emailpass", { email: "admin@test.com", password: "supersecret" });
const A = { authorization: `Bearer ${token}` };
const admin = (m, p, b) => call(m, `/admin${p}`, b, A);

const { api_keys } = await admin("GET", "/api-keys?type=publishable");
const S = { "x-publishable-api-key": api_keys[0].token };
const store = (m, p, b) => call(m, `/store${p}`, b, S);
const { regions } = await admin("GET", "/regions");
const region = regions.find((r) => r.currency_code === "eur") ?? regions[0];
const { products } = await admin("GET", "/products?fields=id,title,*variants&limit=10");
const variants = products.flatMap((p) => p.variants).slice(0, 2);
const { stock_locations } = await admin("GET", "/stock-locations");

const made = [];
for (let n = 0; n < Number(arg.orders); n++) {
  const { cart } = await store("POST", "/carts", {
    region_id: region.id,
    email: `hunt${n}@example.com`,
    items: variants.map((v) => ({ variant_id: v.id, quantity: Number(arg.qty) })),
  });
  const address = { first_name: "Hunt", last_name: `Buyer ${n}`, address_1: "1 Main St", city: "Copenhagen", country_code: "dk", postal_code: "1000" };
  await store("POST", `/carts/${cart.id}`, { shipping_address: address, billing_address: address });
  const { shipping_options } = await store("GET", `/shipping-options?cart_id=${cart.id}`);
  await store("POST", `/carts/${cart.id}/shipping-methods`, { option_id: shipping_options[0].id });
  const { payment_collection } = await store("POST", "/payment-collections", { cart_id: cart.id });
  await store("POST", `/payment-collections/${payment_collection.id}/payment-sessions`, { provider_id: "pp_system_default" });
  const done = await store("POST", `/carts/${cart.id}/complete`, {});
  if (done.type !== "order") throw new Error(`cart ${cart.id} did not complete: ${JSON.stringify(done).slice(0, 300)}`);
  const order = done.order;
  const { order: full } = await admin("GET", `/orders/${order.id}?fields=id,display_id,*items`);
  if (arg.open) {
    made.push({ id: order.id, display_id: full.display_id, items: full.items.map((i) => ({ id: i.id, title: i.title, quantity: i.quantity })) });
    continue;
  }
  await admin("POST", `/orders/${order.id}/fulfillments`, {
    items: full.items.map((i) => ({ id: i.id, quantity: i.quantity })),
    location_id: stock_locations[0].id,
  });
  const { order: ff } = await admin("GET", `/orders/${order.id}?fields=id,*fulfillments`);
  const fid = ff.fulfillments.at(-1).id;
  await admin("POST", `/orders/${order.id}/fulfillments/${fid}/mark-as-delivered`, {});
  made.push({ id: order.id, display_id: full.display_id, items: full.items.map((i) => ({ id: i.id, title: i.title, quantity: i.quantity })) });
}
writeFileSync(join(here, arg.open ? "orders-open.json" : "orders.json"), JSON.stringify(made, null, 2));
console.log(JSON.stringify(made.map((o) => `${o.display_id} ${o.id}`)));
