// Reproduction without GenClass of the lost sort click (docs/adoption/hunts/keystone-admin-ui.md section 6). Not part of
// any test suite. Plain Playwright: page 2's posts query is held DELAY ms with page.route, the Title header is clicked
// WAIT ms after Next page; prints whether the URL got sortBy.
// Usage: node docs/adoption/hunts/keystone-admin-ui/sort-probe.mjs [delayMs=800] [trials=5] [waitMs=100]
import { chromium } from "playwright";
const APP = "http://localhost:3000";
const DELAY = Number(process.argv[2] ?? 800), N = Number(process.argv[3] ?? 5), WAIT = Number(process.argv[4] ?? 100);
const browser = await chromium.launch();
let lost = 0;
for (let t = 0; t < N; t++) {
  const page = await browser.newPage();
  await page.goto(`${APP}/posts`);
  await page.locator('[role="grid"] [role="rowheader"]').first().waitFor();
  await page.route("**/api/graphql", async (r) => { if ((r.request().postData() ?? "").includes('"skip":50')) await new Promise((x) => setTimeout(x, DELAY)); return r.fallback(); });
  await page.getByRole("button", { name: "Next page" }).click();
  await page.waitForTimeout(WAIT);
  const sortable = await page.getByRole("columnheader", { name: "Title" }).getAttribute("aria-sort");
  await page.getByRole("columnheader", { name: "Title" }).click();
  await page.waitForTimeout(DELAY + 800);
  const url = new URL(page.url());
  const sorted = url.searchParams.get("sortBy");
  if (!sorted) lost++;
  console.log(`delay ${DELAY} trial ${t}: aria-sort at click ${sortable}, url ${url.search}`);
  await page.close();
}
console.log(`sort click lost in ${lost} of ${N}`);
await browser.close();
