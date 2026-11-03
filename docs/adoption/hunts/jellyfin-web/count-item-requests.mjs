// #8277 check without GenClass: open one movie's details page in plain Playwright and count the requests that fetch
// that item. Run by hand against the seeded local server:
//   node docs/adoption/hunts/jellyfin-web/count-item-requests.mjs [--legacy]
import { chromium } from "@playwright/test";
const J = "http://127.0.0.1:8096";
const legacy = process.argv.includes("--legacy");
const b = await chromium.launch();
const ctx = await b.newContext();
const lp = await ctx.newPage();
await lp.goto(`${J}/web/`);
await lp.locator("#txtManualName").fill("hunt");
await lp.locator("#txtManualPassword").fill("hunt-local-pw");
await lp.locator("#txtManualPassword").press("Enter");
await lp.waitForURL(/#\/home/);
const creds = JSON.parse(await lp.evaluate(() => localStorage.getItem("jellyfin_credentials")));
const { AccessToken: token, UserId: uid } = creds.Servers[0];
const items = await (await fetch(`${J}/Items?userId=${uid}&IncludeItemTypes=Movie&Recursive=true&SortBy=SortName&Limit=1`, { headers: { Authorization: `MediaBrowser Token="${token}"` } })).json();
const id = items.Items[0].Id;
await lp.close();
const page = await ctx.newPage();
await page.addInitScript((l) => (l ? localStorage.setItem("layout", "desktop-legacy") : localStorage.removeItem("layout")), legacy);
const seen = [];
page.on("request", (r) => {
  const u = new URL(r.url());
  if (u.pathname.endsWith(`/Items/${id}`)) seen.push(`${r.method()} ${u.pathname.replace(uid, "{userId}").replace(id, "{itemId}")}${u.search.replace(uid, "{userId}")}`);
});
await page.goto(`${J}/web/#/details?id=${id}`);
await page.locator(".itemDetailPage:visible .itemName").first().waitFor();
await page.waitForLoadState("networkidle");
console.log(JSON.stringify({ layout: legacy ? "desktop-legacy" : "default", item: items.Items[0].Name, requests: seen }, null, 2));
await b.close();
