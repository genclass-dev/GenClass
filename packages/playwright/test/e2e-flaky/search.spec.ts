// One ordinary test on the buggy search page (../e2e/server.mjs): it types two letters, waits until both searches
// have been answered (however late the network makes them) and expects the results of the second. The page writes
// whatever answer lands last, so the test fails when the answer to the first letter lands after the answer to the
// second, and passes otherwise. The server answers in order, in 40 ms: on its own the test passes; under the
// command's seeded delays it fails under the seeds that hold the first request longer. It imports Playwright's own
// `test` and `expect` and knows nothing of GenClass. ../e2e/flaky.mjs checks what
// `genclass-playwright-run --explain-flaky` says about its failing and passing runs.
import { expect, test } from "@playwright/test";

test("buggy page: the results are the last query's", async ({ page }) => {
  let answered = 0;
  page.on("requestfinished", (r) => {
    if (new URL(r.url()).pathname === "/api/search") answered++;
  });
  await page.goto("/");
  await page.getByLabel("Search").pressSequentially("re", { delay: 80 });
  await expect.poll(() => answered, { timeout: 10_000 }).toBe(2);
  await expect(page.locator("#results li").first()).toHaveText("re one", { timeout: 1000 });
});
