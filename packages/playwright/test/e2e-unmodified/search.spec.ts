// Two ordinary tests on the e2e search page (../e2e/server.mjs): the buggy page, where a slower older answer can land
// over the newer results, and the fixed page, which keeps only the latest answer. They import Playwright's own `test`
// and `expect` and know nothing of GenClass: each types a query, waits until every search request has been answered
// (however late the network makes it) and looks at the list, which passes on either page whatever order the answers
// came in. What ../e2e/unmodified.mjs checks is what genclass-playwright-run wrote for each seed while they ran: a
// witness on the buggy page when its chaos may reorder, none when it may not, none on the fixed page.
// (The page itself is the script-tag integration case, as in ../e2e: server.mjs maps the app's `@genclass/runtime`
// import to the runtime the command puts on the page, so this project is run through the command only.)
import { expect, test } from "@playwright/test";

async function search(page: import("@playwright/test").Page, path: string): Promise<void> {
  // nothing put on the page may leave a trace a suite would fail on: no console error, no failed request
  const noise: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") noise.push(`console.error: ${m.text()}`);
  });
  page.on("requestfailed", (r) => noise.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  page.on("pageerror", (e) => noise.push(`pageerror: ${e.message}`));
  let answered = 0;
  page.on("requestfinished", (r) => {
    if (new URL(r.url()).pathname === "/api/search") answered++;
  });
  await page.goto(path);
  await page.getByLabel("Search").pressSequentially("react", { delay: 80 });
  // one request per key; all five answered, then a moment for the page to apply the last one
  await expect.poll(() => answered, { timeout: 15_000 }).toBe(5);
  await page.waitForTimeout(300);
  await expect(page.locator("#results li")).toHaveCount(2);
  expect(noise).toEqual([]);
}

test.describe("search", () => {
  test("buggy page: results of the last query", async ({ page }) => {
    await search(page, "/");
  });

  test("fixed page: results of the last query", async ({ page }) => {
    await search(page, "/?fixed=1");
    await expect(page.locator("#for")).toHaveText("Results for react");
  });
});
