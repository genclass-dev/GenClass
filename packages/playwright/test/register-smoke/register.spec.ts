// Checks, from inside a Playwright worker, what the register entry (@genclass/playwright/register) did there. It
// imports only @playwright/test, like any spec; how it was run comes from GENCLASS_SMOKE (test/run.test.ts sets it):
//   "command": through genclass-playwright-run, whose generated config imported the entry in this worker;
//   "preload": the entry was preloaded with NODE_OPTIONS=--import, and the config is the project's own;
//   "off": the off switch is set and Playwright ran as it is.
// No page is opened: no browser is needed.
import { basename } from "node:path";
import { chromium, expect, firefox, test, webkit } from "@playwright/test";

const mode = process.env.GENCLASS_SMOKE;
const expectedConfig = process.env.GENCLASS_SMOKE_CONFIG ?? "playwright.config.ts";
const KEY = Symbol.for("@genclass/playwright/register");
const WRAPPED = Symbol.for("@genclass/playwright/wrapped");
const METHODS = ["launch", "launchPersistentContext", "connect", "connectOverCDP"];

interface State {
  state: string;
  wrapped: string[];
  notes: string[];
  currentTestId(): string | null;
}

test("the register entry in this worker", async ({}, testInfo) => {
  expect(["command", "preload", "off"]).toContain(mode);
  const state = (globalThis as unknown as Record<symbol, State | undefined>)[KEY];
  const proto = Object.getPrototypeOf(chromium) as Record<string, Record<symbol, unknown>>;
  const config = basename(testInfo.config.configFile ?? "");
  // the user's own config is what Playwright runs on, whichever way it was loaded
  expect(testInfo.config.metadata.config).toBe(expectedConfig);
  if (expectedConfig.endsWith(".cts")) expect(testInfo.config.metadata.commonjs).toBe(true);

  if (mode === "off") {
    expect(state).toBeUndefined();
    for (const m of METHODS) expect(proto[m][WRAPPED], m).toBeUndefined();
    expect(config).toBe(expectedConfig);
    return;
  }

  // the marker the entry sets: it is active in this worker, with nothing to report
  expect(state?.state).toBe("active");
  expect(state?.wrapped).toEqual(METHODS.map((m) => `BrowserType.${m}`));
  expect(state?.notes).toEqual([]);
  // the prototype chromium, firefox and webkit share is patched here
  for (const m of METHODS) expect(proto[m][WRAPPED], m).toBe(true);
  expect(Object.getPrototypeOf(firefox)).toBe(proto);
  expect(Object.getPrototypeOf(webkit)).toBe(proto);
  // the test this worker is running, as the entry sees it: Playwright's own test.info(), not a second copy's
  expect(state?.currentTestId()).toBe(testInfo.testId);
  // through the command, Playwright's config file is the generated neighbour of the user's; preloaded, the user's own
  if (mode === "command") expect(config).toMatch(new RegExp(`^${expectedConfig.replace(/\./g, "\\.")}\\.genclass-\\d+\\.mjs$`));
  else expect(config).toBe(expectedConfig);

  // a wrapped call is still Playwright's call: nothing listens on port 9, so connect fails, with the error Playwright
  // gives under the name Playwright gives it (no browser is started for this)
  const error = await chromium.connect("ws://127.0.0.1:9/", { timeout: 10_000 }).then(
    () => null,
    (e: Error) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error?.message).toMatch(/^browserType\.connect: /);
});
