// The reproduction without GenClass for the Grafana admin-list issue (docs/adoption/hunts/grafana-panel-refresh.md):
// plain Playwright against a local Grafana with more than 100 users (seed.mjs creates 160), admin/admin.
//
//   node docs/adoption/hunts/grafana-panel-refresh/repro.mjs [http://localhost:3000] [/admin/users|/org/serviceaccounts|/org/users]
//
// It opens the list, then clicks page 2 and page 3 in quick succession, three times with the page-2 response delayed by
// 1.5 s (a slower network for that one request) and three times without. With the bug, the delayed page-2 response
// lands after page 3's and the list shows page 2's rows while the page-3 button stays selected.

import { chromium } from "@playwright/test";

const G = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
const LIST = process.argv[3] ?? "/admin/users";
const SEARCH = { "/admin/users": "/api/users/search", "/org/serviceaccounts": "/api/serviceaccounts/search", "/org/users": "/api/org/users/search" }[LIST];

const browser = await chromium.launch();
const login = await browser.newContext();
await login.request.post(`${G}/login`, { data: { user: "admin", password: "admin" } });
const storageState = await login.storageState();
await login.close();

for (const delay of [0, 1500]) {
  for (let t = 0; t < 3; t++) {
    const ctx = await browser.newContext({ storageState, viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    let armed = false;
    await page.route(`**${SEARCH}?*`, async (route) => {
      if (armed && delay && new URL(route.request().url()).searchParams.get("page") === "2") {
        await new Promise((r) => setTimeout(r, delay));
      }
      return route.fallback();
    });
    await page.goto(G + LIST);
    // a Grafana admin lands on the "All users" tab of /org/users; the org list is the "Organization users" tab
    if (LIST === "/org/users") await page.getByRole("tab", { name: "Organization users" }).click();
    const pageButton = (n) => page.locator("ol li button").filter({ hasText: new RegExp(`^${n}$`) }).first();
    await pageButton(3).waitFor();
    await page.waitForLoadState("networkidle");
    // what page 3 really holds, from the API
    const expected = await page.evaluate(async (url) => (await (await fetch(url)).json()), `${SEARCH}?perpage=${LIST === "/org/users" ? 30 : 50}&page=3&query=`);
    const firstExpected = (expected.users ?? expected.serviceAccounts ?? expected.orgUsers)[0];
    armed = true;
    await pageButton(3).scrollIntoViewIfNeeded();
    const [b2, b3] = [await pageButton(2).boundingBox(), await pageButton(3).boundingBox()];
    await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.mouse.click(b3.x + b3.width / 2, b3.y + b3.height / 2);
    await page.waitForTimeout(delay + 1500);
    const firstRow = (await page.locator("table tbody tr").first().innerText()).replace(/\s+/g, " ").trim();
    const selected = await page.locator('ol li button[aria-current="page"]').innerText();
    const wanted = firstExpected.login ?? firstExpected.name;
    console.log(`page-2 response delayed ${delay} ms: selected page ${selected}, first row "${firstRow.slice(0, 50)}" -> ${firstRow.includes(wanted) ? "page 3 (correct)" : `NOT page 3 (page 3 starts with ${wanted})`}`);
    await ctx.close();
  }
}
await browser.close();
