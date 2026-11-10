// `@genclass/playwright/fixture`: Playwright's `test` with GenClass on every page, and the `expect` that goes with it.
//
//   // playwright.config.ts
//   use: { genclass: { chaos: { seed: 1, delayMs: [0, 600] } } },
//   reporter: [["list"], ["@genclass/playwright/reporter"]],
//
//   // a spec
//   import { test, expect } from "@genclass/playwright/fixture";
//
// For each test it puts @genclass/runtime on the page before the app's first script (observe mode, telemetry off,
// the model skipped unless asked), applies the seeded chaos when one is given, and at the end writes one
// "genclass-races/1" file to `outDir` (default `genclass` in the project's outputDir, test-results/genclass) with what
// the runtime saw, the seed and chaos that produced it and what the fixture could not do, which the reporter turns
// into the pull-request comment. The runtime only observes: it never holds, delays or changes anything the app does.
// Chaos, when given, holds matched requests before they leave (that is its job), never changes what they say. A
// finding never changes a test's outcome. `enabled: false` makes the fixture inert: the page is Playwright's own and
// nothing is written.
//
// This module is the Playwright binding only: what a test run is (the options, the names, the file) lives in
// session.ts, which the register entry (`@genclass/playwright/register`, for suites that keep their own imports)
// shares. It is the one module of the package that imports Playwright.

import { test as base, expect, type Page, type PlaywrightTestArgs, type PlaywrightTestOptions, type PlaywrightWorkerArgs, type PlaywrightWorkerOptions, type TestType } from "@playwright/test";
import type { ChaosMatch, ChaosMatchFn, ChaosOptions } from "./chaos.js";
import type { Collected, PageLike } from "./install.js";
import { startGenClass as start, type GenClassOptions, type GenClassRun, type TestInfoLike } from "./session.js";
import type { RacesLocation } from "./types.js";

export interface GenClassFixtures {
  genclass: GenClassOptions;
}

/**
 * Starts the fixture on a page for one test: installs the runtime (and chaos), and returns what to call when the
 * test ends. Exported for tests and for custom fixtures; `test` below does this on its `page`.
 */
export async function startGenClass(page: Page | PageLike, options: GenClassOptions | undefined, info: TestInfoLike): Promise<{ finish(): Promise<GenClassRun> }> {
  return start(page as unknown as PageLike, options, info);
}

/**
 * Playwright's `test` with GenClass on its `page`. Options come from `use: { genclass: {...} }` in the config or
 * `test.use({ genclass: {...} })` in a spec. Pages opened another way (`context.newPage()`, popups) are not
 * instrumented.
 */
export const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & GenClassFixtures, PlaywrightWorkerArgs & PlaywrightWorkerOptions> = base.extend<GenClassFixtures>({
  genclass: [{}, { option: true }],
  page: async ({ page, genclass }, use, testInfo) => {
    const run = await startGenClass(page, genclass, testInfo);
    try {
      await use(page);
    } finally {
      try {
        await run.finish();
      } catch (e) {
        // a file that cannot be written is one line, never a failed test
        process.stderr.write(`[@genclass/playwright] could not write the race file: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  },
});

export { expect };
export { locationOf, outDirOf, testName } from "./session.js";
export type { ChaosMatch, ChaosMatchFn, ChaosOptions, Collected, GenClassOptions, GenClassRun, PageLike, RacesLocation, TestInfoLike };
export { RUNTIME_PATH } from "./chaos.js";
