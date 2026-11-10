// The same project through a config Playwright loads with require (a .cts file is CommonJS whatever the package
// says), named with --config. The command's generated config has to load this one the CommonJS way: `__dirname`,
// `require` and `module` below exist only there.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: __dirname,
  outputDir: "test-results",
  workers: 1,
  reporter: [["line"]],
  metadata: { config: "commonjs.config.cts", commonjs: typeof require === "function" && typeof module === "object" },
});
