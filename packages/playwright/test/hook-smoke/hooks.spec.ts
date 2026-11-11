// The facts about Playwright that the register entry and the fixture stand on, held against the Playwright that is
// installed: two for the entry's rules for a browser context (src/wrap.ts), one for where a test's own code ends
// (src/session.ts). It imports only @playwright/test and opens no page.
//
//   1. While a beforeAll or afterAll hook runs, test.info() answers (the first test of the describe for beforeAll,
//      the last one for afterAll), and testInfo._currentHookType() says which hook it is. That method is not public
//      API: the entry reads it by shape, the way this spec does, and a Playwright without it fails this spec, which is
//      how a change there is noticed.
//   2. test.info() gives the test that is running, one at a time: a thing made for one test (here in a worker-scoped
//      fixture, which Playwright sets up with the first test current and no hook) and used again by the next is
//      told apart by the testId of the test running when it is used. This is public API, and enough on its own.
//   3. testInfo.duration is a plain number property of the test's own TestInfo, 0 while the test's function runs, and
//      Playwright assigns it the moment that function returns: before the afterEach hooks and before any fixture is
//      torn down. src/session.ts (watchEnd) watches for that one assignment to know when a test's own code ended, and
//      puts the property back as it was; it reads the property by shape, the way this spec does. A Playwright that
//      keeps the duration another way fails this spec, and the package then falls back to a later mark.
import { expect, test as base } from "@playwright/test";

/** The hook Playwright says is running, read the way src/wrap.ts reads it; "no such method" when there is none. */
function hookNow(): unknown {
  const info = base.info() as unknown as { _currentHookType?: unknown };
  return typeof info._currentHookType === "function" ? (info._currentHookType as (this: unknown) => unknown).call(info) : "no such method";
}

interface Made {
  hook: unknown;
  testId: string;
}

const test = base.extend<object, { shared: Made }>({
  shared: [
    async ({}, use) => {
      await use({ hook: hookNow(), testId: base.info().testId });
    },
    { scope: "worker" },
  ],
});

const seen: Record<string, unknown> = {};
const ids: string[] = [];

test.describe("a describe that shares things between its tests", () => {
  test.beforeAll(() => {
    seen.beforeAll = hookNow();
    seen.beforeAllTest = test.info().testId;
  });
  test.beforeEach(() => {
    seen.beforeEach = hookNow();
  });
  test.afterEach(() => {
    seen.afterEach = hookNow();
  });
  test.afterAll(() => {
    // the last test is the one running while afterAll runs
    expect(hookNow()).toBe("afterAll");
    expect(test.info().testId).toBe(ids[1]);
    expect(ids).toHaveLength(2);
  });

  test("the first test", async ({ shared }, testInfo) => {
    ids.push(testInfo.testId);
    // beforeAll ran with this test as the one running, and said it was a beforeAll hook
    expect(seen.beforeAll).toBe("beforeAll");
    expect(seen.beforeAllTest).toBe(testInfo.testId);
    expect(seen.beforeEach).toBe("beforeEach");
    // in a test's body no hook is running
    expect(hookNow()).toBeUndefined();
    expect(test.info()).toBe(testInfo);
    // the worker-scoped fixture was set up for this test: no hook, this test's id
    expect(shared).toEqual({ hook: undefined, testId: testInfo.testId });
  });

  test("the second test", async ({ shared }, testInfo) => {
    ids.push(testInfo.testId);
    expect(seen.afterEach).toBe("afterEach");
    expect(hookNow()).toBeUndefined();
    // the same fixture value, made while another test was the one running
    expect(shared.testId).toBe(ids[0]);
    expect(shared.testId).not.toBe(testInfo.testId);
    expect(test.info().testId).toBe(testInfo.testId);
  });
});

/**
 * Notes when testInfo.duration is next assigned, the way src/session.ts watchEnd does, and puts the property back.
 * Null when the property is not the plain writable number it expects.
 */
function watchDuration(info: object): (() => number | undefined) | null {
  const d = Object.getOwnPropertyDescriptor(info, "duration");
  if (!d || !d.configurable || !d.writable || typeof d.value !== "number" || d.get || d.set) return null;
  let at: number | undefined;
  let value: unknown = d.value;
  Object.defineProperty(info, "duration", {
    configurable: true,
    enumerable: d.enumerable,
    get: () => value,
    set: (v: unknown) => {
      value = v;
      at ??= Date.now();
      Object.defineProperty(info, "duration", { configurable: true, enumerable: d.enumerable, writable: true, value: v });
    },
  });
  return () => at;
}

base.describe("where a test's own code ends", () => {
  let ended: (() => number | undefined) | null = null;
  let returned = 0;

  base.afterEach(async ({}, testInfo) => {
    // by the time an afterEach hook runs, Playwright has assigned the duration: when the test's function returned
    expect(ended).not.toBeNull();
    const at = ended!();
    expect(at).toBeDefined();
    expect(at!).toBeGreaterThanOrEqual(returned);
    expect(at! - returned).toBeLessThan(2000);
    // and the property is a plain number again, with what Playwright set
    const d = Object.getOwnPropertyDescriptor(testInfo, "duration");
    expect(d?.get).toBeUndefined();
    expect(typeof d?.value).toBe("number");
    expect(d?.value).toBeGreaterThanOrEqual(25);
    expect(testInfo.duration).toBe(d?.value);
  });

  base("the duration is assigned when the test's function returns", async ({}, testInfo) => {
    expect(Object.getOwnPropertyDescriptor(testInfo, "duration")).toMatchObject({ value: 0, writable: true, configurable: true });
    ended = watchDuration(testInfo);
    await new Promise((done) => setTimeout(done, 40));
    // not yet: the function is still running
    expect(ended!()).toBeUndefined();
    expect(testInfo.duration).toBe(0);
    returned = Date.now();
  });
});
