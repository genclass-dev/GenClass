// Reproduction without GenClass (docs/adoption/hunts/evershop-admin-checkout.md section 4.2). Not part of CI.
//
//   node docs/adoption/hunts/evershop-admin-checkout/repro.mjs [--delay 0,800] [--trials 3] [--gap 150]
//
// Plain Playwright against a local EverShop (http://localhost:3000): a guest cart with two lines at qty 1, /cart, "+"
// on line 1, then --gap ms later "+" on line 2. The only thing touched is the response to the cart's GraphQL query
// (POST /api/graphql), delivered --delay ms late (a slow network, or a busy server, for that one request); the PATCH
// requests are left alone. After the requests settle it compares what the page shows with a fresh load of /cart in the
// same session (the server's cart), and counts the GraphQL requests the page sent for the two changes.

import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: arg } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:3000" },
    delay: { type: "string", default: "0,800" },
    trials: { type: "string", default: "3" },
    gap: { type: "string", default: "150" },
  },
});
const B = arg.base.replace(/\/+$/, "");

async function readCart(page) {
  return page.evaluate(() => {
    const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
    const lines = [...document.querySelectorAll(".cart__item")].map((it) => {
      const sku = txt(it.querySelector(".text-xs")).replace(/^SKU /, "");
      const qty = txt(it.querySelector(".inline-flex.items-center.rounded-md span"));
      const price = txt(it.querySelector(".text-right.font-medium"));
      return `${sku}x${qty}@${price}`;
    });
    const sub = [...document.querySelectorAll(".cart__total__summary div")].find((d) => /^Sub total/.test(txt(d)));
    return `${lines.join(",")} | ${txt(sub).replace("Sub total", "subtotal ")}`;
  });
}

const browser = await chromium.launch();
const results = [];
for (const delay of arg.delay.split(",").map(Number)) {
  for (let t = 1; t <= Number(arg.trials); t++) {
    const ctx = await browser.newContext();
    const warm = await ctx.newPage();
    await warm.goto(`${B}/`);
    await warm.close();
    for (const sku of ["CUP-001-WHT", "PEN-002-BLK"]) {
      const r = await ctx.request.post(`${B}/api/cart/mine/items`, { data: { sku, qty: 1 } });
      if (!r.ok()) throw new Error(`add ${sku}: HTTP ${r.status()}`);
    }
    const page = await ctx.newPage();
    await page.goto(`${B}/cart`);
    await page.locator(".cart__item").nth(1).waitFor();
    let graphql = 0;
    await page.route(`${B}/api/graphql`, async (route) => {
      graphql++;
      const response = await route.fetch();
      if (delay) await new Promise((r) => setTimeout(r, delay));
      await route.fulfill({ response });
    });
    const plus = (i) => page.locator(".cart__item").nth(i).locator(".inline-flex.items-center.rounded-md button").nth(1);
    await plus(0).click();
    await page.waitForTimeout(Number(arg.gap));
    await plus(1).click();
    // the 500 ms debounce, the two PATCHes and the delayed query(ies)
    await page.waitForTimeout(800 + 2 * delay + 1000);
    await page.waitForLoadState("networkidle");
    const shown = await readCart(page);
    const check = await ctx.newPage();
    await check.goto(`${B}/cart`);
    await check.locator(".cart__item").nth(1).waitFor();
    const server = await readCart(check);
    await ctx.close();
    const line = `delay ${delay} ms, trial ${t}: ${shown === server ? "matches the server" : "STALE"} · shown ${shown} · server ${server} · cart queries sent ${graphql}`;
    results.push({ delay, trial: t, stale: shown !== server, graphql });
    console.log(line);
  }
}
await browser.close();
console.log(JSON.stringify(results));
