// An ordinary project whose one test takes a minute. test/run.test.ts starts it through genclass-playwright-run and
// interrupts the command while the test runs: Playwright must stop the run itself, and the config the command
// generated next to this file must be gone afterwards. No page is opened, so no browser is needed.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  workers: 1,
  timeout: 120_000,
  reporter: [["line"]],
});
