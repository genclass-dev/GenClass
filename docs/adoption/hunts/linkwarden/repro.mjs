// Reproduction of the Linkwarden preference race without GenClass (docs/adoption/hunts/linkwarden.md, section 4.2).
// Plain Playwright against a local Linkwarden (`yarn web:dev`), logged in with the session seed.mjs saved. Nothing is
// injected into the page; `page.route` only delays the response to the FIRST `PUT /api/v1/users/:id/preference` of
// each trial by --delay ms (the request reaches the server at once; only its answer is late, as on a slow network).
//
//   node docs/adoption/hunts/linkwarden/repro.mjs [--delay 1500] [--trials 3] [--case theme|font]
//
// theme       the reader view's light/dark switch (/preserved/:id?format=3), clicked twice: light → dark → light
// font        the reader view's text style menu, "+" on the font size three times: 20px → 22px → 24px → 26px
// Each trial resets the user to theme "light" and font size 20px (psql, PG_URL), then prints what the page shows
// after 3 s and what the server stored (GET /api/v1/users/:id with the same session).
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const { values: arg } = parseArgs({
  options: {
    base: { type: "string", default: process.env.LW_URL ?? "http://localhost:3000" },
    delay: { type: "string", default: "1500" },
    trials: { type: "string", default: "3" },
    case: { type: "string", default: "theme" },
    link: { type: "string", default: "120" },
  },
});
const PG_URL = process.env.PG_URL ?? "postgresql://linkwarden:linkwarden@localhost:5432/linkwarden";
const sql = (q) => execFileSync("psql", [PG_URL, "-At", "-c", q], { encoding: "utf8" }).trim();
const delay = Number(arg.delay);

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const results = [];
for (let t = 1; t <= Number(arg.trials); t++) {
  sql(`update "User" set theme = 'light', "readableFontSize" = '20px' where username = 'test';`);
  const ctx = await browser.newContext({ baseURL: arg.base, storageState: join(here, "storage-state.json"), viewport: { width: 1400, height: 900 } });
  await ctx.route((u) => !["localhost", "127.0.0.1"].includes(u.hostname), (r) => r.abort());
  let seen = 0;
  await ctx.route(/\/api\/v1\/users\/\d+\/preference$/, async (route) => {
    const n = ++seen;
    const res = await route.fetch(); // the server handles the request now
    if (n === 1 && delay > 0) await new Promise((r) => setTimeout(r, delay)); // only its answer is late
    await route.fulfill({ response: res });
  });
  const page = await ctx.newPage();
  let shown;
  if (arg.case === "theme") {
    await page.goto(`/preserved/${arg.link}?format=3`);
    const sw = page.locator("label:has(input.theme-controller)").first();
    await sw.waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle");
    await sw.click();
    await sw.click();
    await page.waitForTimeout(delay + 3000);
    shown = {
      dataTheme: await page.evaluate(() => document.documentElement.getAttribute("data-theme")),
      switchOnDark: await page.locator("input.theme-controller").first().isChecked(),
    };
  } else if (arg.case === "font") {
    await page.goto(`/preserved/${arg.link}?format=3`);
    const trigger = page.locator("button[aria-haspopup=menu]:has(i.bi-type)").first();
    await trigger.waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle");
    await trigger.click();
    const row = page.getByRole("menu").locator("div:has(> div > p)").filter({ hasText: /font size/i }).first();
    const plus = row.locator("button").nth(1);
    await plus.click();
    await plus.click();
    await plus.click();
    await page.waitForTimeout(delay + 3000);
    shown = { fontSizeShown: (await row.locator("p").last().textContent())?.trim() };
  } else throw new Error(`unknown --case ${arg.case}`);
  const [theme, fontSize] = sql(`select theme || '|' || "readableFontSize" from "User" where username = 'test';`).split("|");
  const line = { trial: t, delay, case: arg.case, shown, server: { theme, fontSize }, preferencePUTs: seen };
  results.push(line);
  console.log(JSON.stringify(line));
  await ctx.close();
}
await browser.close();
