// What the fixture and the register entry share (src/session.ts): the plan of a run from the options, the one file
// per test, and how several pages or contexts of a test become one record. The names, the places and the location
// are tested through the fixture (fixture.test.ts), which re-exports them.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Collected } from "../src/install.js";
import { parseRaces } from "../src/schema.js";
import { resolveChaos } from "../src/chaos.js";
import { MAX_DEFAULT_WAIT_MS, MAX_WAIT_MS, WAIT_TIMEOUT_MARGIN_MS, mergeAgent, mergeCollected, planRun, racesFileOf, waitBudget, waitOf, writeRun } from "../src/session.js";
import { fakeTestInfo } from "./helpers.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-session-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const collected = (over: Partial<Collected> = {}): Collected => ({ records: [], witnesses: [], mode: "observe", model: { state: "off" }, agent: null, plans: [], serviceWorker: false, modeOverridden: null, ...over });

describe("session: the plan of a run", () => {
  it("no chaos: seed 1 plus the repeat index, the model skipped", () => {
    expect(planRun({}, fakeTestInfo(root))).toEqual({ chaos: null, seed: 1, model: "skip", waitMs: 1000 });
    expect(planRun({ chaos: false, model: "load" }, fakeTestInfo(root, { repeatEachIndex: 3 }))).toEqual({ chaos: null, seed: 4, model: "load", waitMs: 1000 });
  });

  it("chaos: its seed plus the repeat index is the run's seed", () => {
    expect(planRun({ chaos: true }, fakeTestInfo(root, { repeatEachIndex: 1 }))).toEqual({ chaos: { seed: 2, delayMs: [0, 600], reorder: true, match: undefined, mirror: true }, seed: 2, model: "skip", waitMs: 1600 });
    expect(planRun({ chaos: { seed: 40, reorder: false } }, fakeTestInfo(root, { repeatEachIndex: 2 }))).toMatchObject({ chaos: { seed: 42, reorder: false }, seed: 42 });
  });

  it("the end-of-test wait: 1000 ms more than the chaos delay's upper bound, at most 5000; a number given is taken, to 30000", () => {
    expect(waitOf({}, null)).toBe(1000);
    expect(waitOf({}, resolveChaos(true))).toBe(1600);
    expect(waitOf({}, resolveChaos({ delayMs: [0, 2500] }))).toBe(3500);
    expect(waitOf({}, resolveChaos({ delayMs: [0, 10_000] }))).toBe(MAX_DEFAULT_WAIT_MS);
    expect(waitOf({ waitForResponsesMs: 0 }, resolveChaos(true))).toBe(0);
    expect(waitOf({ waitForResponsesMs: 250.9 }, null)).toBe(250);
    expect(waitOf({ waitForResponsesMs: 99_999 }, null)).toBe(MAX_WAIT_MS);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "600" as unknown as number]) expect(waitOf({ waitForResponsesMs: bad }, resolveChaos(true))).toBe(1600);
    expect(planRun({ chaos: { delayMs: [0, 200] }, waitForResponsesMs: 300 }, fakeTestInfo(root)).waitMs).toBe(300);
  });

  it("the wait's budget: what the test has left of its timeout after a margin; none without a timeout; nothing for a test that timed out", () => {
    const at = 1_000_000;
    const info = (over: Record<string, unknown>) => fakeTestInfo(root, over);
    expect(waitBudget(info({ timeout: 30_000 }), at, at + 5_000)).toBe(30_000 - 5_000 - WAIT_TIMEOUT_MARGIN_MS);
    expect(waitBudget(info({ timeout: 30_000 }), at, at + 29_000)).toBe(0);
    expect(waitBudget(info({ timeout: 30_000 }), at, at + 60_000)).toBe(0);
    expect(waitBudget(info({ timeout: 0 }), at, at + 5_000)).toBeUndefined();
    expect(waitBudget(info({}), at, at + 5_000)).toBeUndefined();
    expect(waitBudget(info({ timeout: 30_000, status: "timedOut" }), at, at + 1_000)).toBe(0);
    expect(waitBudget(info({ timeout: 0, status: "interrupted" }), at, at + 1_000)).toBe(0);
    expect(waitBudget(info({ timeout: 30_000, status: "failed" }), at, at + 1_000)).toBe(27_000);
  });

  it("refuses a mode other than observe and a model it does not know", () => {
    expect(() => planRun({ mode: "heal" as unknown as "observe" }, fakeTestInfo(root))).toThrow(/must be "observe"/);
    expect(() => planRun({ model: "cdn" as unknown as "skip" }, fakeTestInfo(root))).toThrow(/must be "skip" or "load"/);
  });
});

describe("session: several pages or contexts of one test, as one", () => {
  it("detections, witnesses and chaos plans are kept in order; a service worker on any counts", () => {
    const a = collected({ records: [{ n: 1 }], witnesses: [{ kind: "overwrote-newer" }], plans: [{ key: "GET /api/a#1", delayMs: 10 }] });
    const b = collected({ records: [{ n: 2 }], witnesses: [{ kind: "identical-in-flight" }], plans: [{ key: "GET /api/a#1", delayMs: 10 }], serviceWorker: true, modeOverridden: "heal" });
    expect(mergeCollected([a, b])).toEqual({
      records: [{ n: 1 }, { n: 2 }],
      witnesses: [{ kind: "overwrote-newer" }, { kind: "identical-in-flight" }],
      mode: "observe",
      model: { state: "off" },
      agent: null,
      plans: [
        { key: "GET /api/a#1", delayMs: 10 },
        { key: "GET /api/a#1", delayMs: 10 },
      ],
      serviceWorker: true,
      modeOverridden: "heal",
    });
    // the parts are not changed
    expect(a.records).toEqual([{ n: 1 }]);
  });

  it("the agent state: connected only when every part whose runtime started connected", () => {
    expect(mergeAgent([])).toBe("not-loaded");
    expect(mergeAgent([null, null])).toBeNull();
    expect(mergeAgent([null, "not-loaded"])).toBe("not-loaded");
    expect(mergeAgent(["not-loaded", null, "Failed to fetch dynamically imported module", "no-connectAgent"])).toBe("Failed to fetch dynamically imported module");
    const never = collected({ mode: null, model: null, agent: "not-loaded" });
    expect(mergeCollected([])).toMatchObject({ mode: null, model: null, agent: "not-loaded", records: [], witnesses: [] });
    expect(mergeCollected([never])).toMatchObject({ mode: null, model: null, agent: "not-loaded" });
    // a context that opened no http page does not hide one that was checked
    expect(mergeCollected([never, collected()])).toMatchObject({ mode: "observe", model: { state: "off" }, agent: null });
    // one that was not checked is not hidden by one that was
    expect(mergeCollected([collected(), collected({ agent: "not-dev-host" })]).agent).toBe("not-dev-host");
    expect(mergeCollected([collected(), collected({ agent: "not-loaded" })]).agent).toBe("not-loaded");
  });
});

describe("session: the file of a test", () => {
  it("is the same for one page and for several merged into one record; a skipped test has none", () => {
    const info = fakeTestInfo(root, { line: undefined });
    const plan = planRun({ chaos: { seed: 3, delayMs: [10, 20] } }, info);
    const one = collected({ witnesses: [{ kind: "identical-in-flight", by: "POST /api/orders#2", over: "POST /api/orders#1", gapMs: 30 }], plans: [{ key: "POST /api/orders#1", delayMs: 12 }] });
    expect(racesFileOf(info, plan, one)).toEqual({
      schema: "genclass-races/1",
      test: "[chromium] checkout.spec.ts > checkout > places one order",
      seed: 3,
      signatures: [{ sig: "witness|identical-in-flight|POST /api/orders", trigger: "witness", diagnosis: "identical-in-flight", op: "POST /api/orders", confidence: 1, evidence: "POST /api/orders#2 was sent while the identical POST /api/orders#1 was still in flight (0.03s earlier), from a separate user action.", seeds: [3] }],
      mode: "observe",
      model: { state: "off" },
      chaos: { latencyMs: [10, 20], reorder: true, routes: ["same host /api* or Accept: json"] },
      fixture: { model: "skip", agent: null, chaosApplied: 1, serviceWorker: false },
    });
    const written = writeRun(info, join(root, "races"), plan, one);
    expect(written.path).toBe(join(root, "races", "chromium-checkout-spec-ts-checkout-places-one-order-a1b2c3-d4e5f6-s3.json"));
    const parsed = parseRaces(readFileSync(written.path!, "utf8"));
    expect(parsed.ok && parsed.file).toEqual(written.file);
    expect(writeRun(fakeTestInfo(root, { status: "skipped", testId: "skipped" }), join(root, "races"), plan, one)).toEqual({ file: null, path: null });
    expect(readdirSync(join(root, "races"))).toHaveLength(1);
  });
});
