// The bench's Playwright project: an ordinary config, with nothing of GenClass in it. The command
// genclass-playwright-run puts GenClass on the pages (run.mjs), as it does for a suite nobody edited.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  outputDir: "./.work/pw-out",
  workers: Number(process.env.BENCH_WORKERS ?? 3),
  fullyParallel: true,
  reporter: [["dot"]],
  timeout: 90_000,
  use: { browserName: "chromium" },
});
