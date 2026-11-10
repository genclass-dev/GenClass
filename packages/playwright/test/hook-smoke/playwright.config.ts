// What the register entry relies on in Playwright to tell whose a browser context is (src/wrap.ts), checked on the
// installed Playwright itself: test/worker.test.ts runs this project (no page is opened, so no browser is needed)
// and the spec next to this file holds the facts. One worker, the tests in order: the facts are about a describe
// that shares things between its tests.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  globalTimeout: 60_000,
  reporter: [["line"]],
});
