// One-off: after two quick page changes on /list/Food and /advanced-search with page 2 slowed, does the page show an
// error message for the aborted request? (fixed build; report section 5.3)
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { BASE, OUT } from "./seed.mjs";
const b = await chromium.launch({ args: ["--no-proxy-server"] });
for (const [path, api, steps] of [
  ["/list/Food", "**/api/food/?*", async (p) => { const n = p.locator(".v-data-table-footer").getByRole("button", { name: "Next page" }); await p.locator(".v-data-table tbody tr").first().waitFor(); await n.click(); await n.click(); }],
  ["/advanced-search", "**/api/recipe/?*", async (p) => { await p.getByRole("button", { name: "Go to page 2" }).click(); await p.getByRole("button", { name: "Go to page 1" }).click(); }],
]) {
  const ctx = await b.newContext({ storageState: join(OUT, "state.json"), serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  await page.route(api, async (r) => { if (new URL(r.request().url()).searchParams.get("page") === "2") await new Promise((x) => setTimeout(x, 800)); return r.continue(); });
  await page.goto(BASE + path);
  await steps(page);
  await page.waitForTimeout(2000);
  const snack = await page.locator(".v-snackbar .v-snackbar__content, .v-alert").allTextContents();
  console.log(path, JSON.stringify({ snackbars: snack.map((s) => s.trim()).filter(Boolean), consoleErrors: errors }));
  await ctx.close();
}
await b.close();
