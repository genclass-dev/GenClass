// The third part of the end-to-end check (../e2e/run.mjs, through ../e2e/early.mjs): tests that stop at their first
// matching assertion, as most tests do, on the search page of ../e2e/server.mjs, under the fixture's seeded chaos, six
// seeds per test (three mirrored pairs). What is checked is the fixture's wait at the end of a test: the older answers
// are still in flight when these tests end. GENCLASS_E2E_EARLY_WAIT=0 runs the same suite with the wait off, for the
// comparison early.mjs prints. Chromium only. Every wait has a limit.
import { defineConfig } from "@playwright/test";
import type { GenClassFixtures } from "@genclass/playwright/fixture";

const port = Number(process.env.GENCLASS_E2E_EARLY_PORT ?? 47433);
const noWait = process.env.GENCLASS_E2E_EARLY_WAIT === "0";

export default defineConfig<GenClassFixtures>({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  outputDir: "test-results",
  workers: 1,
  repeatEach: 6,
  retries: 0,
  timeout: 30_000,
  globalTimeout: 180_000,
  reporter: [["list"]],
  webServer: {
    command: `node ../e2e/server.mjs ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    genclass: {
      chaos: { seed: 1, delayMs: [0, 600], reorder: true },
      outDir: noWait ? "races-no-wait" : "test-results/genclass",
      ...(noWait ? { waitForResponsesMs: 0 } : {}),
    },
  },
});
