// chaos.order "systematic" (src/chaos.ts, install.ts, fixture.ts, schema.ts, summarize.ts): repeat 0 natural (nothing
// held), repeat 1 reverse (bursts released newest first, 30 ms apart, each request held at most windowMs + 1000),
// repeat 2 and later the seeded delays of the default; each file records its order and its bursts, and the report shows
// the order next to each seed and counts only the reordering seeds toward reproducible. The default ("random") files
// and reports are byte for byte what they were. The scheduler runs on hand-cranked timers: nothing waits on the clock.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BURST_HOLD_SLACK_MS, BURST_QUIET_MS, ChaosScheduler, DEFAULT_WINDOW_MS, FIFO_GAP_MS, MAX_DELAY_MS, delayFor, resolveChaos, systematicOrder, type ChaosTimers } from "../src/chaos.js";
import { startGenClass, type TestInfoLike } from "../src/fixture.js";
import { install, type PageLike, type RequestLike, type RouteLike } from "../src/install.js";
import { normalizePath } from "../../runtime/src/util.js";
import { MAX_BURST_KEYS, MAX_FILE_BURSTS, fileBursts, idlessPath } from "../src/races.js";
import { validateRaces } from "../src/schema.js";
import { buildSummary, summarize } from "../src/summarize.js";
import type { GenClassRacesFile, RaceSignature } from "../src/types.js";

/** Timers moved by hand, 1 ms at a time, with promise chains let run after each step. */
function manualTimers() {
  const q: { at: number; fn: () => void; id: number }[] = [];
  let now = 0;
  let n = 0;
  const timers: ChaosTimers = {
    setTimeout: (fn, ms) => {
      const id = ++n;
      q.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = q.findIndex((x) => x.id === id);
      if (i >= 0) q.splice(i, 1);
    },
  };
  return {
    timers,
    async advance(ms: number): Promise<void> {
      for (let i = 0; i < ms; i++) {
        now += 1;
        for (const x of [...q].filter((x) => x.at <= now).sort((a, b) => a.at - b.at || a.id - b.id)) {
          const k = q.indexOf(x);
          if (k < 0) continue;
          q.splice(k, 1);
          x.fn();
        }
        for (let k = 0; k < 5; k++) await Promise.resolve();
      }
    },
    now: () => now,
    pending: () => q.length,
  };
}

const reverse = (o: { windowMs?: number } = {}) => resolveChaos({ seed: 1, order: "systematic", ...o }, 1);

/** Sends one matched request through the scheduler now; records when it may leave. */
function send(s: ChaosScheduler, t: { now(): number }, path: string, out: Record<string, number>, sent: Record<string, number>): void {
  const p = s.plan("GET", `http://app.test${path}`);
  sent[p.key] = t.now();
  void s.hold(p).then(() => (out[p.key] = t.now()));
}

describe("chaos: the systematic option", () => {
  it("repeat 0 natural, 1 reverse, 2 and later seeded; the seed still adds the repeat index", () => {
    expect([0, 1, 2, 3, 7].map(systematicOrder)).toEqual(["natural", "reverse", "seeded", "seeded", "seeded"]);
    expect(resolveChaos({ seed: 10, order: "systematic" }, 0)).toEqual({ seed: 10, delayMs: [0, 600], reorder: true, match: undefined, order: "natural", windowMs: DEFAULT_WINDOW_MS });
    expect(resolveChaos({ seed: 10, order: "systematic" }, 1)).toMatchObject({ seed: 11, order: "reverse" });
    expect(resolveChaos({ seed: 10, order: "systematic" }, 2)).toMatchObject({ seed: 12, order: "seeded" });
    expect(resolveChaos({ order: "systematic", windowMs: 250 }, 1).windowMs).toBe(250);
    expect(resolveChaos({ order: "systematic", windowMs: 99999 }, 1).windowMs).toBe(MAX_DELAY_MS);
  });

  it("the default (random, or order unset) resolves exactly as before: no order, no window", () => {
    expect(resolveChaos({ seed: 3 }, 2)).toEqual({ seed: 5, delayMs: [0, 600], reorder: true, match: undefined });
    expect(resolveChaos({ seed: 3, order: "random" }, 2)).toEqual(resolveChaos({ seed: 3 }, 2));
    expect("order" in resolveChaos(true)).toBe(false);
  });

  it("refuses reorder: false with the systematic order, and an unknown order", () => {
    expect(() => resolveChaos({ order: "systematic", reorder: false })).toThrow(/reorders by design/);
    expect(() => resolveChaos({ order: "sorted" as unknown as "random" })).toThrow(/chaos\.order must be "random" or "systematic"/);
    expect(resolveChaos({ order: "systematic", reorder: true }, 1).order).toBe("reverse");
  });

  it("a seeded repeat gets the same delays as the default for that repeat", () => {
    const seeded = new ChaosScheduler(resolveChaos({ seed: 1, order: "systematic" }, 2));
    const random = new ChaosScheduler(resolveChaos({ seed: 1 }, 2));
    const urls = ["http://a/api/search?q=r", "http://a/api/search?q=re", "http://a/api/items/7"];
    expect(urls.map((u) => seeded.plan("GET", u))).toEqual(urls.map((u) => random.plan("GET", u)));
    expect(seeded.plans[0].delayMs).toBe(delayFor(3, "GET /api/search#1", [0, 600]));
  });
});

describe("chaos: the natural order", () => {
  it("holds nothing: holding is false and a hold resolves at once", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(resolveChaos({ order: "systematic" }, 0), t.timers);
    expect(s.holding).toBe(false);
    let left = false;
    void s.hold({ key: "GET /api/x#1", delayMs: 500 }).then(() => (left = true));
    await Promise.resolve();
    expect(left).toBe(true);
    expect(t.pending()).toBe(0);
    expect(new ChaosScheduler(resolveChaos({ seed: 1 })).holding).toBe(true);
    expect(new ChaosScheduler(reverse()).holding).toBe(true);
  });
});

describe("chaos: the reverse order", () => {
  it("a burst is released newest first, FIFO_GAP_MS apart, once 100 ms pass without a new request", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(reverse(), t.timers);
    const at: Record<string, number> = {};
    const sent: Record<string, number> = {};
    send(s, t, "/api/a", at, sent);
    await t.advance(20);
    send(s, t, "/api/b", at, sent);
    await t.advance(20);
    send(s, t, "/api/c", at, sent);
    await t.advance(BURST_QUIET_MS - 1);
    expect(at).toEqual({});
    await t.advance(1 + 2 * FIFO_GAP_MS + 1);
    expect(at).toEqual({ "GET /api/c#1": 140, "GET /api/b#1": 170, "GET /api/a#1": 200 });
    expect(s.bursts).toEqual([{ keys: ["GET /api/a#1", "GET /api/b#1", "GET /api/c#1"], released: ["GET /api/c#1", "GET /api/b#1", "GET /api/a#1"] }]);
    expect(s.plans.every((p) => p.delayMs === 0)).toBe(true);
    expect(t.pending()).toBe(0);
  });

  it("a burst of one leaves as soon as its burst ends, with no gap", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(reverse(), t.timers);
    const at: Record<string, number> = {};
    send(s, t, "/api/only", at, {});
    await t.advance(BURST_QUIET_MS);
    expect(at).toEqual({ "GET /api/only#1": BURST_QUIET_MS });
    expect(s.bursts).toEqual([{ keys: ["GET /api/only#1"], released: ["GET /api/only#1"] }]);
  });

  it("a burst ends at windowMs even while requests keep coming; later ones start the next burst", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(reverse({ windowMs: 200 }), t.timers);
    const at: Record<string, number> = {};
    const sent: Record<string, number> = {};
    // one request every 50 ms: the quiet time never passes, so the window ends the burst
    for (let i = 0; i < 6; i++) {
      send(s, t, "/api/poll", at, sent);
      await t.advance(50);
    }
    await t.advance(600);
    expect(s.bursts.map((b) => b.keys.length)).toEqual([4, 2]);
    expect(s.bursts[0].released).toEqual(["GET /api/poll#4", "GET /api/poll#3", "GET /api/poll#2", "GET /api/poll#1"]);
    // the first burst closed at its window (200 ms after its first request)
    expect(at["GET /api/poll#4"]).toBe(200);
    expect(s.bursts[1]).toEqual({ keys: ["GET /api/poll#5", "GET /api/poll#6"], released: ["GET /api/poll#6", "GET /api/poll#5"] });
  });

  it("no request is held longer than windowMs + 1000 ms, however many are in its burst", async () => {
    const t = manualTimers();
    const windowMs = 200;
    const s = new ChaosScheduler(reverse({ windowMs }), t.timers);
    const at: Record<string, number> = {};
    const sent: Record<string, number> = {};
    for (let i = 0; i < 50; i++) {
      send(s, t, "/api/many", at, sent);
      await t.advance(1);
    }
    await t.advance(3000);
    const keys = Object.keys(sent);
    expect(Object.keys(at).sort()).toEqual(keys.sort());
    for (const k of keys) expect(at[k] - sent[k], k).toBeLessThanOrEqual(windowMs + BURST_HOLD_SLACK_MS);
    // the newest left first, and the oldest ones on their bound, before their turn came
    expect(s.bursts).toHaveLength(1);
    expect(s.bursts[0].released[0]).toBe("GET /api/many#50");
    expect(at["GET /api/many#1"] - sent["GET /api/many#1"]).toBe(windowMs + BURST_HOLD_SLACK_MS);
    expect(s.bursts[0].released.slice(-1)[0]).not.toBe("GET /api/many#1");
  });

  it("the same request timing gives the same bursts and release order", async () => {
    const run = async () => {
      const t = manualTimers();
      const s = new ChaosScheduler(reverse(), t.timers);
      const at: Record<string, number> = {};
      for (const gap of [0, 30, 10, 150, 20, 400, 5]) {
        await t.advance(gap);
        send(s, t, "/api/search", at, {});
      }
      await t.advance(2000);
      return { bursts: s.bursts, at };
    };
    const a = await run();
    expect(await run()).toEqual(a);
    expect(a.bursts.map((b) => b.keys.length)).toEqual([3, 2, 2]);
  });

  it("dispose lets every held request go at once, newest first, and stops the timers", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(reverse(), t.timers);
    const at: Record<string, number> = {};
    send(s, t, "/api/x", at, {});
    send(s, t, "/api/y", at, {});
    await t.advance(10);
    s.dispose();
    await t.advance(1);
    expect(Object.keys(at).sort()).toEqual(["GET /api/x#1", "GET /api/y#1"]);
    expect(s.bursts[0].released).toEqual(["GET /api/y#1", "GET /api/x#1"]);
    expect(t.pending()).toBe(0);
    // after dispose nothing is held
    let late = false;
    void s.hold(s.plan("GET", "http://app.test/api/z")).then(() => (late = true));
    await Promise.resolve();
    expect(late).toBe(true);
  });
});

describe("chaos: the file's bursts", () => {
  it("fileBursts caps the bursts and the keys of each, and counts what it left out", () => {
    const big = Array.from({ length: MAX_FILE_BURSTS + 5 }, (_, i) => ({ keys: [`GET /a#${i + 1}`], released: [`GET /a#${i + 1}`] }));
    const r = fileBursts(big);
    expect(r.bursts).toHaveLength(MAX_FILE_BURSTS);
    expect(r.burstsLeftOut).toBe(5);
    const keys = Array.from({ length: MAX_BURST_KEYS + 3 }, (_, i) => `GET /b#${i + 1}`);
    const one = fileBursts([{ keys, released: [...keys].reverse() }]);
    expect(one).toEqual({ bursts: [{ keys: keys.slice(0, MAX_BURST_KEYS), released: [...keys].reverse().slice(0, MAX_BURST_KEYS), more: 3 }] });
    expect(fileBursts([])).toEqual({ bursts: [] });
  });

  it("names a burst's requests as the runtime's operation names do: ids in a path as :id, numbered by that name in send order", () => {
    const raw = [
      "GET /api/password-reset/9f8e7d6c5b4a3f2e1d0c9b8a#1",
      "GET /api/users/3/orders/48213#1",
      "GET api.partner.example/v1/sessions/eyJhbGciOiJIUzI1NiJ9#1",
      "GET /api/users/4/orders/48214#1",
      "GET /api/items#1",
      "GET /api/items#2",
    ];
    const r = fileBursts([
      { keys: raw.slice(0, 3), released: raw.slice(0, 3).reverse() },
      { keys: raw.slice(3), released: raw.slice(3).reverse() },
    ]);
    const first = ["GET /api/password-reset/:id#1", "GET /api/users/:id/orders/:id#1", "GET api.partner.example/v1/sessions/:id#1"];
    const second = ["GET /api/users/:id/orders/:id#2", "GET /api/items#1", "GET /api/items#2"];
    expect(r).toEqual({ bursts: [{ keys: first, released: [...first].reverse() }, { keys: second, released: [...second].reverse() }] });
    for (const secret of ["9f8e7d6c5b4a3f2e1d0c9b8a", "48213", "eyJhbGciOiJIUzI1NiJ9"]) expect(JSON.stringify(r)).not.toContain(secret);
  });

  it("the id rule is @genclass/runtime's (packages/runtime/src/util.ts normalizePath)", () => {
    const corpus = ["/api/users/123", "/api/x/550e8400-e29b-41d4-a716-446655440000", "/a/deadbeef12", "/a/sha256", "/a/oauth2", "/a/v2beta1", "/a/tasks-1cam", "/a/PPBqWA9", "/a/x7k2p", "/a/item42", "/a/ab12cd", "/a/%E2%9C%93", "/a/%zz", "/~alice/search", "/a/b/", "", "/a/jane.doe%40example.com", "/a/eyJhbGciOiJIUzI1NiJ9", "api.example.com/v1/k8s"];
    for (const p of corpus) expect(idlessPath(p), p).toBe(normalizePath(p));
  });

  it("the validator keeps a valid order and bursts and drops invalid ones (chaos fields are lenient)", () => {
    const base = { schema: "genclass-races/1", test: "t", seed: 1, signatures: [] };
    const ok = validateRaces({ ...base, chaos: { latencyMs: [0, 600], reorder: true, order: "reverse", bursts: [{ keys: ["GET /a#1", "GET /a#2"], released: ["GET /a#2", "GET /a#1"], more: 2 }], burstsLeftOut: 4 } });
    expect(ok.ok && ok.file.chaos).toEqual({ latencyMs: [0, 600], reorder: true, order: "reverse", bursts: [{ keys: ["GET /a#1", "GET /a#2"], released: ["GET /a#2", "GET /a#1"], more: 2 }], burstsLeftOut: 4 });
    const odd = validateRaces({ ...base, chaos: { order: "sideways", bursts: [{ keys: [1] }, { keys: ["k"], released: ["k"] }, "x"], burstsLeftOut: -1 } });
    expect(odd.ok && odd.file.chaos).toEqual({ bursts: [{ keys: ["k"], released: ["k"] }] });
  });
});

type Handler = (route: RouteLike, request: RequestLike) => Promise<void> | void;

class FakePage implements PageLike {
  routes: { pattern: string; handler: Handler }[] = [];
  initScripts: string[] = [];
  evaluateResult: unknown = null;
  async route(pattern: string, handler: Handler): Promise<void> {
    this.routes.push({ pattern, handler });
  }
  async addInitScript(s: { content: string }): Promise<void> {
    this.initScripts.push(s.content);
  }
  async exposeFunction(): Promise<void> {}
  async evaluate(): Promise<unknown> {
    return this.evaluateResult;
  }
  isClosed(): boolean {
    return false;
  }
  chaos(): Handler {
    return this.routes.find((r) => r.pattern === "**/*")!.handler;
  }
}

const request = (url: string): RequestLike => ({ url: () => url, method: () => "GET", resourceType: () => "fetch", headers: () => ({}), frame: () => ({ url: () => "http://app.test/page" }) });
const route = (): RouteLike => ({ fulfill: async () => undefined, fallback: async () => undefined, abort: async () => undefined });

let root = "";
let runtimeDir = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-systematic-"));
  runtimeDir = join(root, "rt");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "genclass.global.js"), "/* build */\n");
  writeFileSync(join(runtimeDir, "agent.js"), "export function connectAgent() {}\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function info(repeatEachIndex: number): TestInfoLike {
  return {
    titlePath: ["", "chromium", "search.spec.ts", "search", "last query wins"],
    file: join(root, "tests", "search.spec.ts"),
    testId: "id1",
    repeatEachIndex,
    project: { name: "chromium", testDir: join(root, "tests"), outputDir: join(root, "test-results") },
    config: { configFile: join(root, "playwright.config.ts"), rootDir: join(root, "tests") },
  };
}

describe("install and fixture: the systematic orders on a page", () => {
  it("the natural order plans and holds nothing: matched requests go at once and chaosApplied is 0", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ order: "systematic" }, 0) });
    await page.chaos()(route(), request("http://app.test/api/items"));
    const c = await session.finish();
    expect(c.plans).toEqual([]);
    expect(c.bursts).toBeUndefined();
  });

  it("the reverse order passes its bursts to the file", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ order: "systematic", windowMs: 50 }, 1) });
    const handler = page.chaos();
    await Promise.all([handler(route(), request("http://app.test/api/a")), handler(route(), request("http://app.test/api/b"))]);
    const c = await session.finish();
    expect(c.plans.map((p) => p.key)).toEqual(["GET /api/a#1", "GET /api/b#1"]);
    expect(c.bursts).toEqual([{ keys: ["GET /api/a#1", "GET /api/b#1"], released: ["GET /api/b#1", "GET /api/a#1"] }]);
  });

  it("each file records its order (and the reverse one its bursts); a default file records neither", async () => {
    const files: GenClassRacesFile[] = [];
    for (const repeat of [0, 1, 2]) {
      const page = new FakePage();
      page.evaluateResult = { mode: "observe", model: { state: "off" }, agent: null };
      const run = await startGenClass(page, { runtimeDir, chaos: { seed: 1, order: "systematic" } }, info(repeat));
      files.push((await run.finish()).file!);
    }
    expect(files.map((f) => [f.seed, f.chaos?.order])).toEqual([
      [1, "natural"],
      [2, "reverse"],
      [3, "seeded"],
    ]);
    expect(files[1].chaos).toEqual({ latencyMs: [0, 600], reorder: true, routes: ["same-origin /api* or Accept: json"], order: "reverse", bursts: [] });
    expect(files[0].fixture?.chaosApplied).toBe(0);
    for (const f of files) expect(validateRaces(JSON.parse(JSON.stringify(f))).ok).toBe(true);
    const plain = await startGenClass(new FakePage(), { runtimeDir, chaos: { seed: 1 } }, info(0));
    expect((await plain.finish()).file?.chaos).toEqual({ latencyMs: [0, 600], reorder: true, routes: ["same-origin /api* or Accept: json"] });
  });

  it("reorder: false with the systematic order stops the fixture before it touches the page", async () => {
    const page = new FakePage();
    await expect(startGenClass(page, { runtimeDir, chaos: { order: "systematic", reorder: false } }, info(0))).rejects.toThrow(/reorders by design/);
    expect(page.routes).toEqual([]);
  });
});

const fixture = { model: "skip" as const, agent: null, chaosApplied: 3, serviceWorker: false };
const witness = (seed: number, op = "GET /api/search"): RaceSignature => ({ sig: `witness|overwrote-newer|${op}`, trigger: "witness", diagnosis: "overwrote-newer", op, confidence: 1, evidence: `The response of ${op}#1 wrote results over newer data.`, seeds: [seed] });
const sysFile = (seed: number, order: "natural" | "reverse" | "seeded", signatures: RaceSignature[], extra: Partial<GenClassRacesFile> = {}): GenClassRacesFile => ({
  schema: "genclass-races/1",
  test: "search.spec.ts > search",
  seed,
  signatures,
  mode: "observe",
  model: { state: "off" },
  chaos: { latencyMs: [0, 600], reorder: true, order },
  fixture: { ...fixture, chaosApplied: order === "natural" ? 0 : 3 },
  ...extra,
});

describe("report: the systematic orders", () => {
  it("shows each seed's order, counts only reordering seeds toward reproducible, and says why", () => {
    const md = summarize([
      { name: "s1.json", content: sysFile(1, "natural", [witness(1)]) },
      { name: "s2.json", content: sysFile(2, "reverse", [witness(2), witness(2, "GET /api/items")]) },
      { name: "s3.json", content: sysFile(3, "seeded", []) },
    ]);
    expect(md).toContain("**2 signatures** in 1 test, **0 reproducible** (flagged in 2 or more reordered seeds of the same test)");
    expect(md).toContain("3 seeds (1 (natural), 2 (reverse), 3 (seeded)) · 2 signatures · chaos: latency 0–600 ms, reorder\n");
    // seen in 2 seeds, but one of them is the natural baseline: not reproducible
    expect(md).toContain("- 2 of 3 seeds (1 (natural), 2 (reverse)) · `GET /api/search` · `witness:overwrote-newer`\n");
    expect(md).not.toContain("**Reproducible**");
    expect(md).toContain('A seed marked (natural), (reverse) or (seeded) ran with chaos order "systematic": natural held nothing (the baseline, not counted toward Reproducible)');
    // the natural file held nothing by design: no chaos-idle note
    expect(md).not.toContain("held no request");
    const s = buildSummary([
      { name: "s1.json", content: sysFile(1, "natural", [witness(1)]) },
      { name: "s2.json", content: sysFile(2, "reverse", [witness(2)]) },
      { name: "s3.json", content: sysFile(3, "seeded", [witness(3)]) },
    ]);
    expect(s.tests[0].seedOrders).toEqual({ "1": "natural", "2": "reverse", "3": "seeded" });
    expect(s.tests[0].signatures[0]).toMatchObject({ seeds: [1, 2, 3], reproducible: true });
    expect(s.tests[0].chaosIdle).toBe(0);
  });

  it("a natural seed does not count even with minSeeds 1; the rule says reordered seeds", () => {
    const md = summarize([{ name: "s1.json", content: sysFile(1, "natural", [witness(1)]) }], { minSeeds: 1 });
    expect(md).toContain("**0 reproducible** (flagged in at least 1 reordered seed of the same test)");
    expect(md).toContain("Reproducible: seen in at least 1 reordered seed of the same test.");
  });

  it("a quiet systematic test lists its seeds with their orders", () => {
    const md = summarize([
      { name: "s1.json", content: sysFile(1, "natural", []) },
      { name: "s2.json", content: sysFile(2, "reverse", []) },
    ]);
    expect(md).toContain("- search.spec.ts > search (2 seeds: 1 (natural), 2 (reverse))\n");
    expect(md).not.toContain("held no request");
  });

  it("files without an order are reported as before (no labels, every seed counts)", () => {
    const plain = (seed: number): GenClassRacesFile => ({ ...sysFile(seed, "seeded", [witness(seed)]), chaos: { latencyMs: [0, 600], reorder: true } });
    const md = summarize([
      { name: "a.json", content: plain(1) },
      { name: "b.json", content: plain(2) },
    ]);
    expect(md).toContain("**1 signature** in 1 test, **1 reproducible** (flagged in 2 or more seeds of the same test)");
    expect(md).toContain("2 seeds (1, 2) · 1 signature");
    expect(md).not.toContain("(seeded)");
    expect(md).not.toContain("systematic");
  });
});
