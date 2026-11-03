// Reproduction WITHOUT GenClass for the jellyfin-web hunt (docs/adoption/hunts/jellyfin-web.md): plain Playwright,
// nothing injected into the page. Legacy desktop layout, Movies tab, click letter B then letter C on the alphabet
// picker; the route holds the "B" list response (NameStartsWith=B) for --delay ms so it arrives after the "C" one, the
// way a slower first response does on a real network. Prints what the grid shows and the selected letter per run.
//
//   node docs/adoption/hunts/jellyfin-web/repro.mjs [--runs 10] [--delay 800] [--surface alpha|sort] [--layout legacy|modern]
//   --delay 0 is the control (no reordering).
// --surface sort: open Sort, pick Descending then Ascending; the route holds the Descending response.

import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: arg } = parseArgs({
  options: {
    jf: { type: "string", default: "http://127.0.0.1:8096" },
    runs: { type: "string", default: "10" },
    delay: { type: "string", default: "800" },
    surface: { type: "string", default: "alpha" },
    layout: { type: "string", default: "legacy" },
  },
});
const J = arg.jf;
const delay = Number(arg.delay);
const browser = await chromium.launch();
const login = await browser.newContext();
const lp = await login.newPage();
await lp.goto(`${J}/web/`);
await lp.locator("#txtManualName").fill("hunt");
await lp.locator("#txtManualPassword").fill("hunt-local-pw");
await lp.locator("#txtManualPassword").press("Enter");
await lp.waitForURL(/#\/home/);
const creds = JSON.parse(await lp.evaluate(() => localStorage.getItem("jellyfin_credentials")));
const { AccessToken: token } = creds.Servers[0];
const views = await (await fetch(`${J}/Library/VirtualFolders`, { headers: { Authorization: `MediaBrowser Token="${token}"` } })).json();
const library = views.find((v) => v.Name === "Movies").ItemId;
const storageState = await login.storageState();
await login.close();

const grid = (page) =>
  page.evaluate(() => {
    const vis = (el) => el && !el.closest(".hide") && el.offsetParent !== null;
    return [...document.querySelectorAll(".itemsContainer, .MuiGrid-container")].filter(vis)
      .map((g) => [...g.querySelectorAll(".cardText-first, .cardText:first-child")].map((t) => t.textContent.trim()).join(",")).join(" | ");
  });

const results = [];
for (let i = 0; i < Number(arg.runs); i++) {
  const ctx = await browser.newContext({ storageState, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript((legacy) => (legacy ? localStorage.setItem("layout", "desktop-legacy") : localStorage.removeItem("layout")), arg.layout === "legacy");
  const held = (u) => (arg.surface === "alpha" ? u.searchParams.get("NameStartsWith") === "B" : u.searchParams.get("SortOrder") === "Descending");
  await page.route(/\/Items\?/, async (route) => {
    const u = new URL(route.request().url());
    if (delay && held(u)) await new Promise((r) => setTimeout(r, delay));
    await route.continue();
  });
  await page.goto(`${J}/web/#/movies?topParentId=${library}&collectionType=movies`);
  await page.locator(".card:visible").first().waitFor();
  let shown;
  if (arg.surface === "alpha") {
    if (arg.layout === "legacy") {
      await page.locator('.alphaPickerButton[data-value="B"]:visible').click();
      await page.locator('.alphaPickerButton[data-value="C"]:visible').click();
    } else {
      const picker = page.locator(".alphaPicker-fixed-right");
      await picker.getByRole("button", { name: "B", exact: true }).click();
      await picker.getByRole("button", { name: "C", exact: true }).click();
    }
    await page.waitForTimeout(delay + 1500);
    const letter = (await page.locator(".alphaPickerButton-selected:visible, .alphaPicker-fixed-right .Mui-selected").allTextContents()).join("");
    const g = await grid(page);
    const ok = g.split(",").every((t) => t.startsWith(letter));
    shown = { letter, grid: g, matches: ok };
  } else {
    await page.locator(".btnSort:visible").click();
    await page.locator('.menuSortOrder[value="Descending"]').locator("..").click();
    await page.locator('.menuSortOrder[value="Ascending"]').locator("..").click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(delay + 1500);
    const t = (await grid(page)).split(",");
    shown = { order: "Ascending", first: t[0], last: t[t.length - 1], matches: t[0] <= t[t.length - 1] };
  }
  results.push(shown);
  console.log(`run ${i + 1}: ${JSON.stringify(shown)}`);
  await ctx.close();
}
await browser.close();
const bad = results.filter((r) => !r.matches).length;
console.log(`${arg.surface} ${arg.layout} delay=${delay}ms: grid disagrees with the selected control in ${bad} of ${results.length} runs`);
