// The two facts about Playwright that the register entry's rules for a browser context stand on (src/wrap.ts), held
// against the Playwright that is installed. It imports only @playwright/test and opens no page.
//
//   1. While a beforeAll or afterAll hook runs, test.info() answers (the first test of the describe for beforeAll,
//      the last one for afterAll), and testInfo._currentHookType() says which hook it is. That method is not public
//      API: the entry reads it by shape, the way this spec does, and a Playwright without it fails this spec, which is
//      how a change there is noticed.
//   2. test.info() gives the test that is running, one at a time: a thing made for one test (here in a worker-scoped
//      fixture, which Playwright sets up with the first test current and no hook) and used again by the next is
//      told apart by the testId of the test running when it is used. This is public API, and enough on its own.
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
