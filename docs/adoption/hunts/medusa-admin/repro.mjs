// Reproduction without GenClass for docs/adoption/hunts/medusa-admin.md: plain Playwright and the admin API, nothing
// else. Meant to be copied into the public reproduction repository Medusa's bug template asks for.
//
//   node repro.mjs <order id> [exchange-dbl|exchange-reopen|claim-dbl|exchange-out-dbl] [trials=3] [gap ms=120]
//
// Against a fresh dtc-starter backend (http://localhost:9000, admin admin@test.com / supersecret) and an order whose
// items are delivered (seed.mjs makes such orders). Each trial cancels any open exchange or claim on the order,
// opens the exchange (or claim) page, opens "Add items" (inbound, or outbound for exchange-out-dbl), ticks the first
// item and then either double-clicks Save (two mouse presses `gap` ms apart, the second sent without waiting for the
// page, as a person's is) or presses Save once, reopens "Add items" and presses Save again without changing anything.
// It prints what the server recorded for the open change: one action per item is right, two is the bug. With FIXUP=1
// it then types 1 into the first quantity and leaves the field, as a merchant correcting the 2 would.

import { chromium } from "@playwright/test";

const B = process.env.BASE ?? "http://localhost:9000";
const [orderId, mode = "exchange-dbl", trialsArg = "3", gapArg = "120"] = process.argv.slice(2);
if (!orderId) throw new Error("usage: node repro.mjs <order id> [mode] [trials] [gap ms]");
const route = mode.startsWith("claim") ? "claims" : "exchanges";
const link = mode === "exchange-out-dbl" ? 1 : 0;

let token;
async function api(method, path) {
  if (!token) {
    const r = await fetch(`${B}/auth/user/emailpass`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@test.com", password: "supersecret" }) });
    token = (await r.json()).token;
  }
  const r = await fetch(`${B}/admin${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status}`);
  return r.json();
}
async function openChanges() {
  const { order_changes } = await api("GET", `/orders/${orderId}/changes`);
  return order_changes.filter((c) => ["pending", "requested"].includes(c.status));
}

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const login = await browser.newContext();
const lp = await login.newPage();
await lp.goto(`${B}/app/login`);
await lp.fill('input[name="email"]', "admin@test.com");
await lp.fill('input[name="password"]', "supersecret");
await lp.click('button[type="submit"]');
await lp.waitForURL(/\/app\/orders/);
const storageState = await login.storageState();
await login.close();

for (let t = 1; t <= Number(trialsArg); t++) {
  for (const c of await openChanges()) {
    if (c.exchange_id) await api("DELETE", `/exchanges/${c.exchange_id}/request`);
    else if (c.claim_id) await api("DELETE", `/claims/${c.claim_id}/request`);
  }
  const ctx = await browser.newContext({ storageState, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/(inbound|outbound)\/items$/.test(new URL(r.url()).pathname)) posts++;
  });
  await page.goto(`${B}/app/orders/${orderId}/${route}`);
  const open = page.locator('[role="dialog"]').getByText("Add items", { exact: true }).nth(link);
  await open.waitFor();
  await page.waitForLoadState("networkidle");
  await open.click();
  const box = page.locator('[role="dialog"] button[role="checkbox"]').nth(1);
  await box.waitFor();
  await box.click();
  const save = page.getByRole("button", { name: "Save" }).last();
  if (mode === "exchange-reopen") {
    await save.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    await open.click();
    await box.waitFor();
    await page.getByRole("button", { name: "Save" }).last().click();
  } else {
    const cdp = await ctx.newCDPSession(page);
    const b = await save.boundingBox();
    const at = { x: b.x + b.width / 2, y: b.y + b.height / 2, button: "left" };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
    const press = (clickCount) => [
      cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", clickCount, ...at }),
      cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", clickCount, ...at }),
    ];
    const first = press(1);
    await new Promise((r) => setTimeout(r, Number(gapArg)));
    await Promise.all([...first, ...press(2)]);
  }
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  if (process.env.FIXUP) {
    // what a merchant does on seeing the 2: types 1 into the quantity and leaves the field
    const q = page.locator('[role="dialog"] input[type="number"]').first();
    await q.fill("1");
    await q.press("Tab");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
  }
  const shown = await page.locator('[role="dialog"] input[type="number"]').evaluateAll((els) => els.map((e) => e.value));
  await ctx.close();
  const actions = (await openChanges()).flatMap((c) => (c.actions ?? []).map((a) => `${a.action} x${a.details?.quantity}`));
  const { order: preview } = await api("GET", `/orders/${orderId}/preview`);
  const requested = preview.items.map((i) => i.detail?.return_requested_quantity ?? 0).join(", ");
  console.log(`${mode} trial ${t}: ${posts} add request(s); the server's open change: ${actions.join(", ") || "none"}; return quantity requested per line (server): ${requested}; quantities shown: ${shown.join(", ")}`);
}
await browser.close();
