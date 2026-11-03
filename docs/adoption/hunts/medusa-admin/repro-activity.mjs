// Reproduction without GenClass of the second finding in docs/adoption/hunts/medusa-admin.md: the order's activity
// timeline misses the exchange the exchange page just created when the timeline's first GET /admin/exchanges response
// lands after the exchange was created. Plain Playwright; the only change to the traffic is that the first
// GET /admin/exchanges response of each page load is handed to the page <delay> ms late (the server answers at once).
//
//   node repro-activity.mjs <order id with delivered items> <delay ms> [trials=3]
//
// Each trial cancels any open exchange on the order, opens /app/orders/<id>/exchanges (which creates one), waits,
// reads whether the activity behind the modal lists "Exchange #… requested", presses Escape, waits 2.5 s and reads
// the order page's activity again.
import { chromium } from "@playwright/test";
const B = "http://localhost:9000";
const id = process.argv[2], delay = Number(process.argv[3] ?? 1500), trials = Number(process.argv[4] ?? 3);
let token;
async function api(method, path) {
  if (!token) token = (await (await fetch(`${B}/auth/user/emailpass`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@test.com", password: "supersecret" }) })).json()).token;
  const r = await fetch(`${B}/admin${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  return r.json();
}
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const lc = await browser.newContext(); const lp = await lc.newPage();
await lp.goto(`${B}/app/login`); await lp.fill('input[name="email"]', "admin@test.com"); await lp.fill('input[name="password"]', "supersecret"); await lp.click('button[type="submit"]'); await lp.waitForURL(/\/app\/orders/);
const storageState = await lc.storageState(); await lc.close();
for (let t = 0; t < trials; t++) {
  const { order_changes } = await api("GET", `/orders/${id}/changes`);
  for (const c of order_changes.filter((x) => ["pending", "requested"].includes(x.status))) if (c.exchange_id) await api("DELETE", `/exchanges/${c.exchange_id}/request`);
  const ctx = await browser.newContext({ storageState, viewport: { width: 1400, height: 900 } });
  let first = true;
  await ctx.route((u) => u.pathname === "/admin/exchanges", async (r) => {
    if (r.request().method() === "GET" && first) { first = false; const res = await r.fetch(); await new Promise((x) => setTimeout(x, delay)); return r.fulfill({ response: res }); }
    return r.fallback();
  });
  const page = await ctx.newPage();
  let gets = 0; page.on("request", (r) => { if (r.method() === "GET" && new URL(r.url()).pathname === "/admin/exchanges") gets++; });
  await page.goto(`${B}/app/orders/${id}/exchanges`);
  await page.locator('[role="dialog"]').getByText("Add items", { exact: true }).first().waitFor();
  await page.waitForTimeout(delay + 2000);
  const behind = /Exchange #\w+ requested/.test(await page.locator("body").innerText());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2500);
  const after = (await page.locator("body").innerText()).match(/Exchange #\w+ requested/g);
  console.log(`delay ${delay}: GET /admin/exchanges sent ${gets}x; activity behind the modal has the exchange: ${behind}; after closing: ${JSON.stringify(after)} url=${page.url().replace(B, "")}`);
  await ctx.close();
}
await browser.close();
