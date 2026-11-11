// Two tests that end where an ordinary test ends: at the first assertion that holds. The first answer to land shows
// two results, so each test is over while the answers to the other keystrokes are still held or on their way. On the
// buggy page one of those can land over newer results after the test's last line; the fixture's wait at the end of a
// test is what still sees it. The tests pass either way: ../e2e/early.mjs checks what the fixture wrote.
import { expect, test } from "@genclass/playwright/fixture";

async function firstResults(page: import("@playwright/test").Page, path: string): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Search").pressSequentially("react", { delay: 80 });
  await expect(page.locator("#results li")).toHaveCount(2);
}

test.describe("ends early", () => {
  test("buggy page: stops at the first results", async ({ page }) => {
    await firstResults(page, "/");
  });

  test("fixed page: stops at the first results", async ({ page }) => {
    await firstResults(page, "/?fixed=1");
  });
});
