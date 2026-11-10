// An existing Playwright project, as a repository has it before GenClass: this config and the spec next to it import
// only @playwright/test and name GenClass nowhere, and nothing in them is edited for the check. The end-to-end check
// (../e2e/run.mjs, through ../e2e/unmodified.mjs) runs it with genclass-playwright-run, which is the only place
// GenClass comes from: no fixture, no `use.genclass`, no reporter. The app is the search page of ../e2e/server.mjs.
// No repeatEach here: the command adds --repeat-each 2 on its own. One named project, Chromium, as most suites have:
// the project's name is part of every test's name in a race file ("[chromium] search.spec.ts > ..."), which also
// keeps this suite's tests apart from the tests of the same title in ../e2e wherever both sets of files are read
// together (playwright-reporter.yml uploads both). Every wait has a limit: the run as a whole (globalTimeout), each
// test, the web server's start.
import { defineConfig } from "@playwright/test";

const port = Number(process.env.GENCLASS_E2E_UNMODIFIED_PORT ?? 47432);

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  outputDir: "test-results",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  globalTimeout: 120_000,
  reporter: [["list"]],
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
