// An existing Playwright project with a test that fails in some runs: this config and the spec next to it import
// only @playwright/test and name GenClass nowhere. The end-to-end check (../e2e/run.mjs, through ../e2e/flaky.mjs)
// runs it with `genclass-playwright-run --explain-flaky`, which runs Playwright once per seed and then compares the
// order of steps in the failing and the passing runs. The app is the search page of ../e2e/server.mjs. Every wait has
// a limit: the run as a whole (globalTimeout), the test, its one assertion, the web server's start.
import { defineConfig } from "@playwright/test";

const port = Number(process.env.GENCLASS_E2E_FLAKY_PORT ?? 47434);

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  outputDir: "test-results",
  workers: 1,
  retries: 0,
  timeout: 20_000,
  globalTimeout: 60_000,
  reporter: [["line"]],
  projects: [{ name: "chromium" }],
  webServer: {
    command: `node ../e2e/server.mjs ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
  },
});
