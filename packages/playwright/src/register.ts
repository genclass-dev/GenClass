// `@genclass/playwright/register`: GenClass on an existing Playwright suite, with no change to its tests or its
// config. Importing this module is all there is to it:
//
//   npx genclass-playwright-run            the command: it runs your own Playwright with a generated config that
//                                          imports this module, then your playwright.config, unchanged
//   NODE_OPTIONS="--import /abs/path/to/@genclass/playwright/dist/register.js" npx playwright test
//                                          the same without the command, for a suite started by a script of its own
//
// In a Playwright worker process it wraps, through the prototypes of Playwright's public objects, BrowserType launch,
// launchPersistentContext, connect and connectOverCDP, Browser newContext and close, and BrowserContext close
// (wrap.ts), so that a browser context a test makes gets what the fixture gives a page: the runtime before the app's
// first script (observe mode, telemetry off), the seeded chaos when it is on, and one "genclass-races/1" file per
// test, seed and retry. A context that is not one test's (made in a beforeAll or afterAll hook, or still open after
// its test) is left alone from there on: nothing it sees is filed under another test. Options come from the
// environment (env.ts); GENCLASS_PLAYWRIGHT=off turns it off. Anywhere else (Playwright's runner process, a web
// server, a build tool, a helper a test forks) the import does nothing.
//
// It never loads a second copy of Playwright, never throws into the process that imported it and never changes a
// test's outcome (worker.ts has the details). This module is the side effect; its state is on globalThis under
// REGISTER_KEY for a test that wants to see what it did.

import { startRegister } from "./worker.js";

startRegister();

export { REGISTER_KEY } from "./session.js";
export { WRAPPED } from "./wrap.js";
export { registerState, type RegisterState } from "./worker.js";
