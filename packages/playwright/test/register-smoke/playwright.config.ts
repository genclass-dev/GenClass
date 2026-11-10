// An ordinary Playwright project, as a repository has it before GenClass: this config imports only @playwright/test
// and names GenClass nowhere. test/run.test.ts runs the project, unedited, three ways (through
// genclass-playwright-run, with the register entry preloaded by NODE_OPTIONS, and with the off switch), and the spec
// next to it checks from inside the worker what each way did there. No page is opened, so no browser is needed.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  workers: 1,
  reporter: [["line"]],
  metadata: { config: "playwright.config.ts" },
});
