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
import { DEFAULT_STEPS, DEFAULT_STEPS_BYTES, MAX_DEFAULT_WAIT_MS, MAX_STEPS_BYTES, MAX_WAIT_MS, WAIT_TIMEOUT_MARGIN_MS, mergeAgent, mergeCollected, planRun, racesFileOf, statusOf, stepsOf, waitBudget, waitOf, watchEnd, writeRun } from "../src/session.js";
import { END_GUARD_MS, decodeSteps } from "../src/steps.js";
import { fakeTestInfo } from "./helpers.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-session-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const collected = (over: Partial<Collected> = {}): Collected => ({ records: [], witnesses: [], mode: "observe", model: { state: "off" }, agent: null, plans: [], serviceWorker: false, modeOverridden: null, streams: [], stepsOver: 0, ...over });

describe("session: the plan of a run", () => {
  it("no chaos: seed 1 plus the repeat index, the model skipped", () => {
    expect(planRun({}, fakeTestInfo(root))).toEqual({ chaos: null, seed: 1, model: "skip", waitMs: 1000, steps: 300, stepsBytes: 5120 });
    expect(planRun({ chaos: false, model: "load" }, fakeTestInfo(root, { repeatEachIndex: 3 }))).toEqual({ chaos: null, seed: 4, model: "load", waitMs: 1000, steps: 300, stepsBytes: 5120 });
    // runs started one after the other, without chaos: `seed` names each one's file
    expect(planRun({ seed: 12 }, fakeTestInfo(root, { repeatEachIndex: 1 }))).toMatchObject({ chaos: null, seed: 13 });
    expect(planRun({ seed: -3 }, fakeTestInfo(root))).toMatchObject({ seed: 1 });
  });

  it("chaos: its seed plus the repeat index is the run's seed", () => {
    expect(planRun({ chaos: true }, fakeTestInfo(root, { repeatEachIndex: 1 }))).toEqual({ chaos: { seed: 2, delayMs: [0, 600], reorder: true, match: undefined, mirror: true }, seed: 2, model: "skip", waitMs: 1600, steps: 300, stepsBytes: 5120 });
    // with chaos the chaos seed is the run's seed, whatever `seed` says
    expect(planRun({ chaos: { seed: 5 }, seed: 99 }, fakeTestInfo(root))).toMatchObject({ seed: 5 });
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
      streams: [],
      stepsOver: 0,
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
      status: "passed",
    });
    const written = writeRun(info, join(root, "races"), plan, one);
    expect(written.path).toBe(join(root, "races", "chromium-checkout-spec-ts-checkout-places-one-order-a1b2c3-d4e5f6-s3.json"));
    const parsed = parseRaces(readFileSync(written.path!, "utf8"));
    expect(parsed.ok && parsed.file).toEqual(written.file);
    expect(writeRun(fakeTestInfo(root, { status: "skipped", testId: "skipped" }), join(root, "races"), plan, one)).toEqual({ file: null, path: null });
    expect(readdirSync(join(root, "races"))).toHaveLength(1);
  });
});

describe("session: the test's status, its steps, and the end of its own code", () => {
  it("the status is Playwright's when a file carries it; a skipped test, or none yet, gives none", () => {
    for (const status of ["passed", "failed", "timedOut", "interrupted"]) expect(statusOf(fakeTestInfo(root, { status }))).toBe(status);
    for (const status of ["skipped", "flaky", "", undefined]) expect(statusOf(fakeTestInfo(root, { status }))).toBeUndefined();
  });

  it("the steps option: 300 by default, false or 0 for none, never more than the format holds; their bytes follow", () => {
    expect([stepsOf({}), stepsOf({ steps: false }), stepsOf({ steps: 0 }), stepsOf({ steps: 1000.7 }), stepsOf({ steps: 99999 }), stepsOf({ steps: -1 }), stepsOf({ steps: NaN })]).toEqual([300, 0, 0, 1000, 2000, 300, 300]);
    expect([DEFAULT_STEPS, DEFAULT_STEPS_BYTES]).toEqual([300, 5120]);
    const plan = (steps: number | false) => planRun({ steps }, fakeTestInfo(root));
    expect([plan(false).steps, plan(false).stepsBytes]).toEqual([0, 5120]);
    expect(plan(100).stepsBytes).toBe(5120);
    expect(plan(1000).stepsBytes).toBe(18000);
    expect(plan(2000).stepsBytes).toBe(36000);
    expect(plan(2000).stepsBytes).toBeLessThanOrEqual(MAX_STEPS_BYTES);
  });

  it("watchEnd notes the moment Playwright sets the test's duration, and leaves the property as it found it", () => {
    const info = fakeTestInfo(root, { duration: 0 });
    const ended = watchEnd(info);
    expect(ended()).toBeUndefined();
    expect(info.duration).toBe(0);
    expect(Object.keys(info)).toContain("duration");
    const before = Date.now();
    info.duration = 1234;
    const at = ended()!;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(info.duration).toBe(1234);
    expect(Object.getOwnPropertyDescriptor(info, "duration")).toEqual({ value: 1234, writable: true, enumerable: true, configurable: true });
    // Playwright sets it once more after the hooks and the teardown: the end of the test's code is the first
    info.duration = 2000;
    expect(ended()).toBe(at);
    expect(info.duration).toBe(2000);
  });

  it("watchEnd touches nothing that is not the plain number Playwright made", () => {
    const none = fakeTestInfo(root);
    expect(watchEnd(none)()).toBeUndefined();
    expect("duration" in none).toBe(false);
    let reads = 0;
    const computed = Object.defineProperty(fakeTestInfo(root), "duration", { configurable: true, get: () => (reads++, 5) });
    const before = Object.getOwnPropertyDescriptor(computed, "duration");
    expect(watchEnd(computed)()).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(computed, "duration")).toEqual(before);
    expect(reads).toBe(0);
    const frozen = Object.freeze(fakeTestInfo(root, { duration: 0 }));
    expect(watchEnd(frozen)()).toBeUndefined();
    const text = fakeTestInfo(root, { duration: "0" as unknown as number });
    watchEnd(text);
    expect(Object.getOwnPropertyDescriptor(text, "duration")).toEqual({ value: "0", writable: true, enumerable: true, configurable: true });
    // a second watcher of the same test leaves the first one's in place and learns nothing
    const twice = fakeTestInfo(root, { duration: 0 });
    const first = watchEnd(twice);
    const second = watchEnd(twice);
    twice.duration = 7;
    expect(first()).toBeDefined();
    expect(second()).toBeUndefined();
    expect(twice.duration).toBe(7);
  });

  it("the file carries the test's status and its steps in order; what landed after the end of its code is late", () => {
    const info = fakeTestInfo(root, { status: "failed" });
    const streams = [
      {
        id: "load-1",
        steps: [
          { kind: "a" as const, at: 1000, name: 'click button "desk"' },
          { kind: "s" as const, at: 1001, name: "GET /api/items/:id#1" },
          { kind: "r" as const, at: 1040, name: "GET /api/items/:id#1" },
          { kind: "s" as const, at: 1045, name: "GET /api/poll#1" },
          { kind: "r" as const, at: 1300, name: "GET /api/poll#1" },
        ],
        body: 5,
      },
    ];
    const file = racesFileOf(info, planRun({}, info), collected({ streams, endedAt: 1100 }));
    expect(file.status).toBe("failed");
    expect(file.steps).toEqual({ labels: ['click button "desk"', "GET /api/items/:id", "GET /api/poll"], order: "a0.1+0 s1.1+1 r1.1+39 s2.1+5 r2.1+255", body: 4 });
    expect(decodeSteps(file.steps!).map((e) => !!e.late)).toEqual([false, false, false, false, true]);
    // a step within the guard before the end counts as late too: the test's last check was made a message earlier
    const guarded = racesFileOf(info, planRun({}, info), collected({ streams, endedAt: 1045 + END_GUARD_MS - 1 }));
    expect(guarded.steps!.body).toBe(3);
    // without a time for the end, each page load's own count says
    expect(racesFileOf(info, planRun({}, info), collected({ streams })).steps!.body).toBe(5);
    expect(racesFileOf(info, planRun({}, info), collected({ streams: [{ ...streams[0], body: 2 }] })).steps!.body).toBe(2);
    // steps off: none in the file, the status still is
    const off = racesFileOf(info, planRun({ steps: false }, info), collected({ streams }));
    expect("steps" in off).toBe(false);
    expect(off.status).toBe("failed");
    // more steps than were kept are counted as left out
    expect(racesFileOf(info, planRun({ steps: 2 }, info), collected({ streams, stepsOver: 10 })).steps).toMatchObject({ order: "a0.1+0 s1.1+1", cut: 13 });
  });

  it("several contexts of one test: their page loads in one sequence, and the earliest end any of them was told", () => {
    const a = collected({ streams: [{ id: "a", steps: [{ kind: "s", at: 100, name: "GET /api/a#1" }] }], stepsOver: 2, endedAt: 900 });
    const b = collected({ streams: [{ id: "b", steps: [{ kind: "s", at: 50, name: "GET /api/b#1" }] }], stepsOver: 1, endedAt: 800 });
    const c = collected();
    const merged = mergeCollected([a, b, c]);
    expect(merged.streams.map((x) => x.id)).toEqual(["a", "b"]);
    expect([merged.stepsOver, merged.endedAt]).toEqual([3, 800]);
    expect("endedAt" in mergeCollected([c])).toBe(false);
    const info = fakeTestInfo(root);
    expect(racesFileOf(info, planRun({}, info), merged).steps).toMatchObject({ labels: ["GET /api/b", "GET /api/a"], order: "s0.1+0 s1.1+50" });
  });
});
