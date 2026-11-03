// Reproductions without GenClass (docs/adoption/hunts/tandoor-recipes.md section 4). Not part of CI.
//
//   node docs/adoption/hunts/tandoor-recipes/repro.mjs <case> [runs]      # case: shopping | search | list | picker | all
//
// Plain Playwright against a locally running Tandoor (TANDOOR_URL, default http://127.0.0.1:8000): nothing of GenClass
// is loaded. Each case slows exactly one response with page.route, the way a slow phone network does, then checks what
// the page shows (and for the shopping list, what the server keeps) against what the person's last step asked for.
//
//   shopping  tap carrot, tap garlic, then tap carrot again (unchecking it) while the first two bulk updates are still
//             in flight; their responses arrive right after the third tap (the route holds them until then). Expected:
//             the server keeps carrot unchecked, garlic checked; the third bulk request ({"ids":[carrot],"checked":
//             false}) is sent.
//   search    the recipe search: Go to page 2, then Go to page 1; page 2's response is 800 ms slower. Expected: page 1's
//             recipes under "page 1".
//   list      the foods list (/list/Food): Next page twice; page 2's response is 800 ms slower. Expected: page 3's rows.
//   picker    a recipe's Keyword picker: type "b", wait 450 ms, type "read"; the "b" search is 800 ms slower. Expected:
//             the menu lists only "bread".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { BASE, OUT, login } from "./seed.mjs";

const fx = JSON.parse(readFileSync(join(OUT, "fixture.json"), "utf8"));
const { api } = await login();
const slowFor = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = {
  async shopping(page) {
    await api("POST", "/api/shopping-list-entry/bulk/", { ids: fx.shopping, checked: false });
    await page.addInitScript(() => localStorage.setItem("TANDOOR_DEVICE_SETTINGS", JSON.stringify({ shopping_show_checked_entries: true })));
    let release;
    const gate = new Promise((r) => (release = r));
    const sent = [];
    // the first two taps' requests reach the server at once; their responses are delivered right after the third tap,
    // in request order (carrot's, then garlic's 30 ms later), the order a network usually keeps
    let firstDelivered;
    const first = new Promise((r) => (firstDelivered = r));
    await page.route("**/api/shopping-list-entry/bulk/", async (route) => {
      const n = sent.push(route.request().postData());
      if (n > 2) return route.continue();
      const response = await route.fetch();
      await gate;
      if (n === 2) await first.then(() => slowFor(30));
      await route.fulfill({ response });
      if (n === 1) firstDelivered();
    });
    await page.goto(`${BASE}/shopping`);
    const tap = (food) => page.getByRole("option").filter({ hasText: new RegExp(`^\\W*${food}\\s*$`) }).getByRole("button").first().click();
    await tap("carrot");
    await tap("garlic");
    for (let i = 0; i < 50 && sent.length < 2; i++) await slowFor(20);
    await tap("carrot"); // uncheck carrot again
    release();
    await slowFor(3000); // the store's retry (500 ms) and the auto-sync have run
    const server = (await api("GET", "/api/shopping-list-entry/?page_size=50")).results.filter((e) => fx.shopping.includes(e.id));
    const carrot = server.find((e) => e.food.name === "carrot");
    const garlic = server.find((e) => e.food.name === "garlic");
    const shownUnchecked = await page.getByRole("option", { name: "carrot", exact: true }).count();
    const ok = carrot.checked === false && garlic.checked === true;
    return { ok, detail: `server carrot=${carrot.checked ? "checked" : "unchecked"} garlic=${garlic.checked ? "checked" : "unchecked"}; page shows carrot ${shownUnchecked ? "unchecked" : "checked"}; bulk requests sent: ${sent.join(" ")}` };
  },
  async search(page) {
    await page.route("**/api/recipe/?*", async (route) => {
      if (new URL(route.request().url()).searchParams.get("page") === "2") await slowFor(800);
      return route.continue();
    });
    await page.goto(`${BASE}/advanced-search`);
    await page.getByRole("button", { name: "Go to page 2" }).click();
    await page.getByRole("button", { name: "Go to page 1" }).click();
    await slowFor(2000);
    const active = (await page.locator(".v-pagination__item--is-active").first().textContent())?.trim();
    const first = (await page.locator("main p").first().textContent())?.trim();
    const want = (await api("GET", `/api/recipe/?page=${active}&page_size=50`)).results[0].name;
    return { ok: first === want, detail: `pagination shows page ${active}; first result "${first}" (page ${active} starts with "${want}")` };
  },
  async list(page) {
    await page.route("**/api/food/?*", async (route) => {
      if (new URL(route.request().url()).searchParams.get("page") === "2") await slowFor(800);
      return route.continue();
    });
    await page.goto(`${BASE}/list/Food`);
    const next = page.locator(".v-data-table-footer").getByRole("button", { name: "Next page" });
    await page.locator(".v-data-table tbody tr").first().waitFor();
    await next.click();
    await next.click();
    await slowFor(2000);
    const footer = (await page.locator(".v-data-table-footer__info").textContent())?.trim();
    const first = (await page.locator(".v-data-table tbody tr td:nth-child(2)").first().textContent())?.trim();
    const want = (await api("GET", "/api/food/?page=3&page_size=10")).results[0].name;
    return { ok: first === want, detail: `footer "${footer}"; first row "${first}" (page 3 starts with "${want}")` };
  },
  async picker(page) {
    await page.route("**/api/keyword/?*", async (route) => {
      if (new URL(route.request().url()).searchParams.get("query") === "b") await slowFor(800);
      return route.continue();
    });
    await page.goto(`${BASE}/edit/Recipe/${fx.recipes[0]}`);
    const input = page.locator(".v-autocomplete").filter({ hasText: "Keyword" }).locator("input").first();
    await input.click();
    await page.keyboard.type("b");
    await slowFor(450);
    await page.keyboard.type("read", { delay: 40 });
    await slowFor(2000);
    const typed = await input.inputValue();
    const items = (await page.locator(".v-overlay-container .v-list-item-title").allTextContents()).map((s) => s.trim());
    return { ok: items.every((t) => t.includes(typed)), detail: `typed "${typed}"; menu lists ${JSON.stringify(items)}` };
  },
};

const which = process.argv[2] ?? "all";
const runs = Number(process.argv[3] ?? 5);
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const summary = {};
for (const name of which === "all" ? Object.keys(CASES) : [which]) {
  let wrong = 0;
  for (let i = 0; i < runs; i++) {
    const ctx = await browser.newContext({ storageState: join(OUT, "state.json"), serviceWorkers: "block", viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    let r;
    try {
      r = await CASES[name](page);
    } catch (e) {
      r = { ok: null, detail: `ERROR ${String(e.message ?? e).split("\n")[0]}` };
    }
    if (r.ok === false) wrong++;
    console.log(`${name} run ${i + 1}: ${r.ok === null ? "error" : r.ok ? "correct" : "WRONG"}: ${r.detail}`);
    await ctx.close();
  }
  summary[name] = `wrong in ${wrong} of ${runs}`;
  console.log(`${name}: ${summary[name]}`);
}
console.log(JSON.stringify(summary));
await browser.close();
