// Place-order probe without GenClass (docs/adoption/hunts/evershop-admin-checkout.md, scenario place-order). Not part of
// CI; run by hand against a local EverShop with COD enabled and the hunt's Canada shipping zone (report section 1).
//
//   node docs/adoption/hunts/evershop-admin-checkout/place-order.mjs [--trials 3] [--modes dbl12,dbl80,lost]
//
// Each trial: a guest cart with one line, /checkout filled in (Canada), the zone's method and Cash on Delivery picked,
// then "Place Order" pressed one of three ways:
//   dbl12  Playwright's dblclick (two clicks about 12 ms apart: synthetic input, faster than a person)
//   dbl80  two clicks 80 ms apart (a quick human double click)
//   lost   one click; the first checkout POST reaches the server and its response is then dropped (route.fetch, then
//          route.abort), so CheckoutContext's retry() sends the request again after 1 s
// It counts the orders the server created for the trial's e-mail address (psql against the hunt's database) and the
// checkout POSTs the page sent, and records where the page ended up.

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: arg } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:3000" },
    trials: { type: "string", default: "3" },
    modes: { type: "string", default: "dbl12,dbl80,lost" },
  },
});
const B = arg.base.replace(/\/+$/, "");
const orders = (email) =>
  Number(
    execFileSync("psql", ["-h", "localhost", "-U", "postgres", "evershop", "-tAc", `select count(*) from "order" where customer_email = '${email}'`], {
      env: { ...process.env, PGPASSWORD: "postgres" },
    })
      .toString()
      .trim(),
  );

const browser = await chromium.launch();
const results = [];
const stamp = Date.now().toString(36);
for (const mode of arg.modes.split(",")) {
  for (let t = 1; t <= Number(arg.trials); t++) {
    const email = `e2e-hunt-${stamp}-${mode}-${t}@example.com`;
    const ctx = await browser.newContext();
    const warm = await ctx.newPage();
    await warm.goto(`${B}/`);
    await warm.close();
    await ctx.request.post(`${B}/api/cart/mine/items`, { data: { sku: "CUP-001-WHT", qty: 1 } });
    const page = await ctx.newPage();
    const posts = [];
    const errors = [];
    const answers = [];
    page.on("response", async (res) => {
      if (res.request().method() === "POST" && /\/checkout$/.test(new URL(res.url()).pathname)) {
        const body = await res.json().catch(() => ({}));
        answers.push(`${res.status()} ${body.error?.message ?? ""}`.trim());
      }
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/checkout$/.test(new URL(r.url()).pathname)) posts.push(r.url());
    });
    await page.goto(`${B}/checkout`);
    await page.locator('input[name="contact.email"]').fill(email);
    await page.locator(".checkout__shipment button[role=combobox]").first().click();
    await page.getByRole("option", { name: "Canada", exact: true }).click();
    await page.locator('input[name="shippingAddress.recipient"]').fill("E2E Hunt");
    await page.locator('input[name="shippingAddress.telephone"]').fill("4165550100");
    await page.locator('input[name="shippingAddress.address_line_1"]').fill("1 Front St");
    await page.locator('input[name="shippingAddress.locality"]').fill("Toronto");
    const region = page.locator(".checkout__shipment button[role=combobox]").nth(1);
    if (await region.count()) {
      await region.click();
      await page.getByRole("option", { name: "Ontario", exact: true }).click();
    }
    const postal = page.locator('input[name="shippingAddress.postal_code"]');
    if (await postal.count()) await postal.fill("M5J 2N1");
    await page.getByText("e2e-hunt Canada Post").click({ timeout: 15_000 });
    await page.getByText("Cash on Delivery").click({ timeout: 15_000 });
    const button = page.getByRole("button", { name: "Place Order" });
    await button.waitFor();
    // the shipping method is saved on the cart (the summary shows its fee)
    await page.locator(".checkout-summary, main").getByText("$9.00").last().waitFor({ timeout: 15_000 }).catch(() => {});
    // let the shipping-method and payment-method saves land before the order is placed
    await page.waitForLoadState("networkidle");
    if (mode === "lost") {
      let first = true;
      await page.route(/\/checkout$/, async (route) => {
        if (route.request().method() !== "POST" || !first) return route.fallback();
        first = false;
        await route.fetch(); // the server handles it
        await route.abort("connectionreset"); // the response never reaches the page
      });
      await button.click();
    } else if (mode === "dbl12") {
      await button.dblclick();
    } else {
      await button.click();
      await page.waitForTimeout(80);
      await button.click({ force: true, timeout: 2000 }).catch(() => {});
    }
    await page.waitForURL(/success|order/, { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const toast = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
    const r = { mode, trial: t, orders: orders(email), checkoutPosts: posts.length, answers, url: new URL(page.url()).pathname, toast: toast.join(" / "), errors: errors.length };
    results.push(r);
    console.log(JSON.stringify(r));
    await ctx.close();
  }
}
await browser.close();
