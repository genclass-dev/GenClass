// The scripted reproduction quoted in linkwarden-issue.md, verbatim except for the two lines marked "harness" (the
// session file and the link id of this hunt's seed). Run from this directory against `yarn web:dev`, theme light:
//   node docs/adoption/hunts/linkwarden/issue-repro.mjs
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ args: ["--no-proxy-server"] }); // harness: the container's proxy must not see localhost
const ctx = await browser.newContext({ baseURL: "http://localhost:3000", storageState: new URL("storage-state.json", import.meta.url).pathname }); // harness
let seen = 0;
await ctx.route(/\/api\/v1\/users\/\d+\/preference$/, async (route) => {
  const res = await route.fetch(); // the server handles the request now
  if (++seen === 1) await new Promise((r) => setTimeout(r, 1500)); // only its answer is late
  await route.fulfill({ response: res });
});
const page = await ctx.newPage();
await page.goto("/preserved/120?format=3"); // harness: any link id
const toggle = page.locator("label:has(input.theme-controller)").first();
await page.waitForLoadState("networkidle");
await toggle.click(); // light → dark
await toggle.click(); // dark → light
await page.waitForTimeout(4500);
console.log("page:", await page.evaluate(() => document.documentElement.getAttribute("data-theme")));
const me = await (await ctx.request.get("/api/v1/auth/session")).json();
const user = await (await ctx.request.get(`/api/v1/users/${me.user.id}`)).json();
console.log("server:", user.response.theme);
await browser.close();
