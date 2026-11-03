// Shipping re-quote check without GenClass (docs/adoption/hunts/evershop-admin-checkout.md, scenario requote). Not part
// of CI; needs the hunt's two shipping zones (report section 1).
//
//   node docs/adoption/hunts/evershop-admin-checkout/requote-repro.mjs [--delay 0,2500] [--trials 3]
//
// /checkout with one cart line: country United States, 1 s later Canada (Shipment.tsx re-quotes 800 ms after each
// change). The only thing touched: the response to the United States quote (GetCartShippingMethods with country US),
// delivered --delay ms late, so that it lands after Canada's. Prints the methods the page lists at the end.

import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: arg } = parseArgs({
  options: { base: { type: "string", default: "http://localhost:3000" }, delay: { type: "string", default: "0,2500" }, trials: { type: "string", default: "3" } },
});
const B = arg.base.replace(/\/+$/, "");
const browser = await chromium.launch();
for (const delay of arg.delay.split(",").map(Number)) {
  for (let t = 1; t <= Number(arg.trials); t++) {
    const ctx = await browser.newContext();
    const warm = await ctx.newPage();
    await warm.goto(`${B}/`);
    await warm.close();
    await ctx.request.post(`${B}/api/cart/mine/items`, { data: { sku: "CUP-001-WHT", qty: 1 } });
    const page = await ctx.newPage();
    const quotes = [];
    await page.route(`${B}/api/graphql`, async (route) => {
      const body = route.request().postData() || "";
      if (!/GetCartShippingMethods/.test(body)) return route.fallback();
      const country = JSON.parse(body).variables?.country;
      const response = await route.fetch();
      const t0 = Date.now();
      if (country === "US" && delay) await new Promise((r) => setTimeout(r, delay));
      quotes.push(`${country}${country === "US" && delay ? `+${Date.now() - t0}ms` : ""}`);
      await route.fulfill({ response });
    });
    await page.goto(`${B}/checkout`);
    const combo = page.locator(".checkout__shipment button[role=combobox]").first();
    await combo.waitFor();
    const pick = async (name) => {
      await combo.click();
      await page.getByRole("option", { name, exact: true }).click();
    };
    await pick("United States");
    await page.waitForTimeout(1000);
    await pick("Canada");
    await page.waitForTimeout(800 + delay + 1500);
    const methods = await page.evaluate(() => (document.querySelector(".checkout__shipment")?.innerText.match(/e2e-hunt [A-Za-z ]+/g) || []).map((m) => m.trim()));
    console.log(`US quote delayed ${delay} ms, trial ${t}: country ${(await combo.innerText()).trim()} · methods ${methods.join(", ") || "none"} · quotes delivered ${quotes.join(" then ")}`);
    await ctx.close();
  }
}
await browser.close();
