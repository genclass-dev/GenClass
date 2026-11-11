// The seeded chaos (src/chaos.ts): the same seed gives the same delays, another seed gives others; the filter
// decides what is touched (never anything outside it, never the runtime's own files); with reorder off nothing
// overtakes. The scheduler is driven with hand-cranked timers, so nothing here waits on the clock.

import { describe, expect, it } from "vitest";
import { ChaosScheduler, DEFAULT_DELAY_MS, FIFO_GAP_MS, MAX_DELAY_MS, RUNTIME_PATH, delayFor, describeMatch, hash32, isCandidate, isRuntimeUrl, mulberry32, resolveChaos, orderKey, sameRequest, stablePath, type ChaosRequest } from "../src/chaos.js";

function manualTimers() {
  const q: { at: number; fn: () => void; id: number }[] = [];
  let now = 0;
  let n = 0;
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++n;
        q.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (id: unknown) => {
        const i = q.findIndex((x) => x.id === id);
        if (i >= 0) q.splice(i, 1);
      },
    },
    /** Moves time forward 1 ms at a time, firing what is due and letting promise chains queue new timers. */
    async advance(ms: number): Promise<void> {
      for (let i = 0; i < ms; i++) {
        now += 1;
        for (const x of [...q].filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) {
          q.splice(q.indexOf(x), 1);
          x.fn();
        }
        for (let k = 0; k < 5; k++) await Promise.resolve();
      }
      await new Promise((r) => setTimeout(r, 0));
    },
    now: () => now,
    pending: () => q.length,
  };
}

const req = (p: Partial<ChaosRequest> = {}): ChaosRequest => ({ url: "http://app.test/api/items", method: "GET", resourceType: "fetch", sameOrigin: true, ...p });

describe("chaos: seeded values", () => {
  it("hash32 and mulberry32 are deterministic and spread", () => {
    expect(hash32("GET /api/search#1")).toBe(hash32("GET /api/search#1"));
    expect(hash32("GET /api/search#1")).not.toBe(hash32("GET /api/search#2"));
    const r = mulberry32(42);
    const a = [r(), r(), r()];
    const b = mulberry32(42);
    expect([b(), b(), b()]).toEqual(a);
    for (const x of a) expect(x >= 0 && x < 1).toBe(true);
  });

  it("delayFor: within [min, max], the same for the same seed and key, different across seeds for most keys", () => {
    const keys = Array.from({ length: 50 }, (_, i) => `GET /api/x#${i + 1}`);
    let differ = 0;
    for (const k of keys) {
      const d = delayFor(7, k, [100, 600]);
      expect(d).toBe(delayFor(7, k, [100, 600]));
      expect(d >= 100 && d <= 600).toBe(true);
      if (d !== delayFor(8, k, [100, 600])) differ++;
    }
    expect(differ).toBeGreaterThan(40);
    expect(delayFor(1, "k", [250, 250])).toBe(250);
    expect(delayFor(1, "k", [0, 0])).toBe(0);
  });

  it("an even seed is the mirror image of the odd seed before it; odd seeds, and every seed with mirror off, are their own", () => {
    const keys = Array.from({ length: 200 }, (_, i) => `GET /api/x#${i + 1}`);
    for (const k of keys) {
      for (const odd of [1, 3, 41]) {
        const d = delayFor(odd, k, [100, 600]);
        expect(delayFor(odd + 1, k, [100, 600])).toBe(100 + 600 - d);
        // the odd seed itself does not depend on the switch (seed 1 is what it was in 0.1.0)
        expect(delayFor(odd, k, [100, 600], false)).toBe(d);
      }
      const even = delayFor(2, k, [0, 600]);
      expect(even >= 0 && even <= 600).toBe(true);
    }
    // seed 0 has no seed before it; with mirror off an even seed has delays of its own
    expect(keys.some((k) => delayFor(0, k, [0, 600]) !== 600 - delayFor(1, k, [0, 600]))).toBe(true);
    expect(keys.filter((k) => delayFor(2, k, [0, 600], false) !== 600 - delayFor(1, k, [0, 600])).length).toBeGreaterThan(150);
    expect(delayFor(2, "k", [250, 250])).toBe(250);
  });

  it("two seeds in a row try a pair of requests in both orders more often than two unrelated seeds do", () => {
    // two requests sent 40 ms apart: the first lands after the second when it is held more than 40 ms longer
    const overtaken = (seed: number, mirror: boolean): boolean => delayFor(seed, "GET /api/items/a#1", [0, 600], mirror) > delayFor(seed, "GET /api/items/b#1", [0, 600], mirror) + 40;
    let mirrored = 0;
    let unrelated = 0;
    let both = 0;
    const pairs = 1000;
    for (let i = 0; i < pairs; i++) {
      const odd = 1 + 2 * i;
      if (overtaken(odd, true) || overtaken(odd + 1, true)) mirrored++;
      if (overtaken(odd, true) && overtaken(odd + 1, true)) both++;
      if (overtaken(odd, false) || overtaken(odd + 1, false)) unrelated++;
    }
    expect(mirrored / pairs).toBeGreaterThan(0.8);
    expect(unrelated / pairs).toBeLessThan(0.75);
    // the price: of a mirrored pair, at most one seed has the first request land last
    expect(both).toBe(0);
  });

  it("a path's ids are keyed as :id, so a record created during the test keeps its delay from run to run", () => {
    expect(stablePath("/api/discussions/kSJ8wfHy3aRuI2zEpB1cC")).toBe("/api/discussions/:id");
    expect(stablePath("/api/todos/42/comments/7")).toBe("/api/todos/:id/comments/:id");
    expect(stablePath("/api/users/3f2b8c1e-9d4a-4b6f-8a1c-2e5d7f9b0a3c")).toBe("/api/users/:id");
    expect(stablePath("/api/blobs/0123456789abcdef0123")).toBe("/api/blobs/:id");
    // words stay words: a route, a slug, a version
    for (const p of ["/api/search", "/api/documents/selection_data/", "/api/v2/items", "/api/reports/quarterly-summary", "/graphql", "/"]) expect(stablePath(p)).toBe(p);
    const a = new ChaosScheduler(resolveChaos({ seed: 1 }));
    const b = new ChaosScheduler(resolveChaos({ seed: 1 }));
    const two = new ChaosScheduler(resolveChaos({ seed: 2 }));
    const first = a.plan("GET", "http://app.test/api/discussions/kSJ8wfHy3aRuI2zEpB1cC");
    const again = b.plan("GET", "http://app.test/api/discussions/Zq4tT0mN8vYx2LwE6hRbA");
    expect(first.key).toBe("GET /api/discussions/:id#1");
    expect(again).toEqual(first);
    expect(two.plan("GET", "http://app.test/api/discussions/p9Kd3XcV7bNm1QwE5rTyU").delayMs).toBe(600 - first.delayMs);
    expect(a.plan("DELETE", "http://localhost:8080/api/comments/77", false).key).toBe("DELETE localhost/api/comments/:id#1");
  });

  it("the scheduler plans with the chaos's mirror switch", () => {
    const on = new ChaosScheduler(resolveChaos({ seed: 2 }));
    const off = new ChaosScheduler(resolveChaos({ seed: 2, mirror: false }));
    const one = new ChaosScheduler(resolveChaos({ seed: 1 }));
    const urls = Array.from({ length: 30 }, (_, i) => `http://app.test/api/x${i}`);
    const plan = (s: ChaosScheduler): number[] => urls.map((u) => s.plan("GET", u).delayMs);
    const [a, b, c] = [plan(on), plan(off), plan(one)];
    expect(a).toEqual(c.map((d) => 600 - d));
    expect(b).not.toEqual(a);
  });

  it("resolveChaos: defaults, bounds, the repeat offset, and bad values", () => {
    expect(resolveChaos(true)).toEqual({ seed: 1, delayMs: [...DEFAULT_DELAY_MS], reorder: true, match: undefined, mirror: true });
    expect(resolveChaos({ mirror: false }).mirror).toBe(false);
    expect(resolveChaos({})).toEqual(resolveChaos(true));
    expect(resolveChaos({ seed: 5 }, 2).seed).toBe(7);
    expect(resolveChaos({ delayMs: [50, 20] }).delayMs).toEqual([50, 50]);
    expect(resolveChaos({ delayMs: [0, 99999] }).delayMs).toEqual([0, MAX_DELAY_MS]);
    expect(resolveChaos({ reorder: false, match: "/api" })).toMatchObject({ reorder: false, match: "/api" });
    expect(() => resolveChaos({ delayMs: [1] as unknown as [number, number] })).toThrow(/delayMs/);
    expect(() => resolveChaos({ match: 5 as unknown as string })).toThrow(/match/);
  });
});

describe("chaos: the filter", () => {
  it("only fetch and XHR requests, never the runtime's own files", () => {
    expect(isCandidate(req(), undefined)).toBe(true);
    expect(isCandidate(req({ resourceType: "xhr" }), undefined)).toBe(true);
    for (const t of ["document", "script", "stylesheet", "image", "font", "websocket", "other"]) expect(isCandidate(req({ resourceType: t }), undefined), t).toBe(false);
    expect(isCandidate(req({ url: `http://app.test${RUNTIME_PATH}genclass.global.js` }), undefined)).toBe(false);
    expect(isCandidate(req({ url: `http://app.test${RUNTIME_PATH}agent.js` }), "/")).toBe(false);
    expect(isCandidate(req({ url: `http://app.test${RUNTIME_PATH}x.js` }), () => true)).toBe(false);
    expect(isRuntimeUrl("http://a/__genclass__/x")).toBe(true);
    expect(isRuntimeUrl("http://a/api/__genclass__/x")).toBe(false);
  });

  it("by default: same-origin requests with an /api path or an Accept header asking for JSON, decided from the request alone", () => {
    expect(isCandidate(req(), undefined)).toBe(true); // /api path
    expect(isCandidate(req({ sameOrigin: false }), undefined)).toBe(false);
    // the app's own back end on another port (the page on localhost:3000, the API on localhost:8080) is the page's host
    expect(isCandidate(req({ url: "http://localhost:8080/api/items", sameOrigin: false, sameHost: true }), undefined)).toBe(true);
    expect(isCandidate(req({ url: "http://localhost:8080/graphql", sameOrigin: false, sameHost: true, accept: "application/json" }), undefined)).toBe(true);
    expect(isCandidate(req({ url: "http://localhost:8080/assets/logo.svg", sameOrigin: false, sameHost: true }), undefined)).toBe(false);
    expect(isCandidate(req({ url: "https://api.example.com/api/items", sameOrigin: false, sameHost: false }), undefined)).toBe(false);
    expect(isCandidate(req({ url: "http://app.test/graphql", accept: "application/json, text/plain, */*" }), undefined)).toBe(true);
    expect(isCandidate(req({ url: "http://app.test/graphql", accept: "*/*" }), undefined)).toBe(false);
    // a stream or any other same-origin fetch outside the filter is never held
    expect(isCandidate(req({ url: "http://app.test/events", accept: "text/event-stream" }), undefined)).toBe(false);
    expect(isCandidate(req({ url: "http://app.test/fragment" }), undefined)).toBe(false);
  });

  it("with a match: a path prefix, a URL prefix, a RegExp, a function or a list", () => {
    expect(isCandidate(req({ url: "http://app.test/graphql" }), "/graphql")).toBe(true);
    expect(isCandidate(req({ url: "http://app.test/graphql" }), "/api")).toBe(false);
    expect(isCandidate(req({ url: "https://api.other.com/v1/x", sameOrigin: false }), "https://api.other.com/")).toBe(true);
    expect(isCandidate(req({ url: "https://api.other.com/v1/x", sameOrigin: false }), /\/v1\//)).toBe(true);
    expect(isCandidate(req({ url: "https://api.other.com/v2/x", sameOrigin: false }), /\/v1\//g)).toBe(false);
    expect(isCandidate(req({ method: "POST" }), (r) => r.method === "POST")).toBe(true);
    expect(isCandidate(req({ method: "GET" }), (r) => r.method === "POST")).toBe(false);
    expect(isCandidate(req({ url: "http://app.test/graphql" }), ["/api", "/graphql"])).toBe(true);
    expect(isCandidate(req({ url: "http://app.test/other" }), ["/api", "/graphql"])).toBe(false);
  });

  it("describeMatch for the race file", () => {
    expect(describeMatch(undefined)).toEqual(["same host /api* or Accept: json"]);
    expect(describeMatch(["/api", /x\/y/, () => true])).toEqual(["/api", "/x\\/y/", "function"]);
    expect(describeMatch("https://a/")).toEqual(["https://a/"]);
  });
});

describe("chaos: the scheduler", () => {
  it("keys requests by method, path and occurrence; the same seed plans the same delays, another seed others", () => {
    const a = new ChaosScheduler(resolveChaos({ seed: 3, delayMs: [0, 600] }));
    const b = new ChaosScheduler(resolveChaos({ seed: 3, delayMs: [0, 600] }));
    const c = new ChaosScheduler(resolveChaos({ seed: 4, delayMs: [0, 600] }));
    const urls = ["http://a/api/search?q=r", "http://a/api/search?q=re", "http://a/api/items/7", "http://a/api/search?q=rea"];
    const pa = urls.map((u) => a.plan("get", u));
    const pb = urls.map((u) => b.plan("GET", u));
    const pc = urls.map((u) => c.plan("GET", u));
    expect(pa.map((p) => p.key)).toEqual(["GET /api/search#1", "GET /api/search#2", "GET /api/items/:id#1", "GET /api/search#3"]);
    expect(pb).toEqual(pa);
    expect(pc.map((p) => p.key)).toEqual(pa.map((p) => p.key));
    expect(pc.map((p) => p.delayMs)).not.toEqual(pa.map((p) => p.delayMs));
    for (const p of pa) expect(p.delayMs >= 0 && p.delayMs <= 600).toBe(true);
    expect(a.plans).toEqual(pa);
    expect(a.plan("GET", "https://other.test/api/x", false).key).toBe("GET other.test/api/x#1");
    // a cross-origin backend on another random port keeps its key, so the seed gives it the same delay
    expect(b.plan("GET", "http://127.0.0.1:41234/api/x", false).key).toBe(c.plan("GET", "http://127.0.0.1:50999/api/x", false).key);
  });

  it("reorder on: each response waits for its own delay only, so a later one can overtake", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(resolveChaos({ seed: 1, delayMs: [0, 600] }), t.timers);
    const order: string[] = [];
    const first = s.hold({ key: "A", delayMs: 300 }).then(() => order.push("A"));
    const second = s.hold({ key: "B", delayMs: 50 }).then(() => order.push("B"));
    await t.advance(100);
    expect(order).toEqual(["B"]);
    await t.advance(300);
    await Promise.all([first, second]);
    expect(order).toEqual(["B", "A"]);
  });

  it("reorder off: requests leave in the order they were sent, at least FIFO_GAP_MS apart (latency only)", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(resolveChaos({ seed: 1, delayMs: [0, 600], reorder: false }), t.timers);
    const at: Record<string, number> = {};
    const a = s.hold({ key: "A", delayMs: 300 }).then(() => (at.A = t.now()));
    const b = s.hold({ key: "B", delayMs: 50 }).then(() => (at.B = t.now()));
    const c = s.hold({ key: "C", delayMs: 0 }).then(() => (at.C = t.now()));
    await t.advance(100);
    expect(at).toEqual({});
    await t.advance(400);
    await Promise.all([a, b, c]);
    expect(Object.keys(at).sort((x, y) => at[x] - at[y])).toEqual(["A", "B", "C"]);
    expect(at.A).toBe(300);
    expect(at.B - at.A).toBeGreaterThanOrEqual(FIFO_GAP_MS);
    expect(at.C - at.B).toBeGreaterThanOrEqual(FIFO_GAP_MS);
    // a request whose own delay is longer than the gap leaves on its own delay
    const late = new ChaosScheduler(resolveChaos({ seed: 1, reorder: false }), t.timers);
    const t0 = t.now();
    let first = 0;
    let second = 0;
    void late.hold({ key: "X", delayMs: 0 }).then(() => (first = t.now() - t0));
    void late.hold({ key: "Y", delayMs: 200 }).then(() => (second = t.now() - t0));
    await t.advance(250);
    expect(first).toBeLessThanOrEqual(1); // at once (seen at the next tick of the hand-cranked clock)
    expect(second).toBe(200);
  });

  it("a zero delay resolves at once; dispose releases every hold and clears the timers", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(resolveChaos({ seed: 1 }), t.timers);
    let now = false;
    void s.hold({ key: "Z", delayMs: 0 }).then(() => (now = true));
    await Promise.resolve();
    expect(now).toBe(true);
    const held = [s.hold({ key: "A", delayMs: 5000 }), s.hold({ key: "B", delayMs: 9000 })];
    expect(t.pending()).toBe(2);
    s.dispose();
    expect(t.pending()).toBe(0);
    await Promise.all(held);
    // after dispose nothing is held any more
    let late = false;
    void s.hold({ key: "C", delayMs: 5000 }).then(() => (late = true));
    await Promise.resolve();
    expect(late).toBe(true);
  });
});

describe("chaos: identical requests keep their order", () => {
  it("sameRequest: the method, the whole URL and the body; nothing of the body is kept", () => {
    const a = sameRequest("post", "http://app.test/api/cart", '{"sku":"lamp","qty":1}');
    expect(a).toBe(sameRequest("POST", "http://app.test/api/cart", '{"sku":"lamp","qty":1}'));
    expect(a).not.toBe(sameRequest("POST", "http://app.test/api/cart", '{"sku":"desk","qty":1}'));
    expect(a).not.toContain("lamp");
    expect(sameRequest("GET", "http://app.test/api/search?q=r", null)).not.toBe(sameRequest("GET", "http://app.test/api/search?q=re", null));
    expect(sameRequest("GET", "http://app.test/api/notifications", null)).toBe(sameRequest("GET", "http://app.test/api/notifications", undefined));
    expect(sameRequest("GET", "http://app.test/api/x", "")).toBe(sameRequest("GET", "http://app.test/api/x", null));
  });

  it("orderKey: a write is kept in order with every write to its path, a read only with the identical read", () => {
    const note = (text: string): string => orderKey("POST", "http://app.test/api/notes", JSON.stringify({ text }));
    expect(note("offline-1")).toBe(note("offline-2"));
    expect(orderKey("put", "http://app.test/api/profile?v=2", '{"name":"A"}')).toBe(orderKey("PUT", "http://app.test/api/profile", '{"name":"Ada"}'));
    expect(orderKey("PATCH", "http://app.test/api/todos/1", "{}")).not.toBe(orderKey("PATCH", "http://app.test/api/todos/2", "{}"));
    expect(orderKey("POST", "http://app.test/api/notes", "{}")).not.toBe(orderKey("DELETE", "http://app.test/api/notes", "{}"));
    expect(orderKey("POST", "http://app.test/api/notes", "{}")).not.toBe(orderKey("POST", "http://other.test/api/notes", "{}"));
    // reads: two different questions are two keys, the same question is one
    expect(orderKey("GET", "http://app.test/api/search?q=r", null)).not.toBe(orderKey("GET", "http://app.test/api/search?q=re", null));
    expect(orderKey("GET", "http://app.test/api/search?q=r", null)).toBe(sameRequest("GET", "http://app.test/api/search?q=r", null));
    expect(orderKey("HEAD", "http://app.test/api/x?a=1", null)).not.toBe(orderKey("HEAD", "http://app.test/api/x?a=2", null));
    expect(orderKey("POST", "not a url", "{}")).toBe("POST not a url");
  });

  it("a request never leaves before the identical one sent before it, whatever their delays; different requests still overtake", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(resolveChaos({ seed: 1, delayMs: [0, 600] }), t.timers);
    const left: string[] = [];
    const go = (name: string, delayMs: number, same?: string): void => void s.hold({ key: name, delayMs }, same).then(() => left.push(`${name}@${t.now()}`));
    const poll = sameRequest("GET", "http://app.test/api/notifications", null);
    // two polls: the first is held 500 ms, the second, sent 100 ms later, only 50 ms
    go("poll#1", 500, poll);
    await t.advance(100);
    go("poll#2", 50, poll);
    // two different questions sent together: the one held shorter leaves first
    go("search r", 400, sameRequest("GET", "http://app.test/api/search?q=r", null));
    go("search re", 100, sameRequest("GET", "http://app.test/api/search?q=re", null));
    await t.advance(700);
    expect(left).toEqual(["search re@200", "poll#1@500", "search r@500", `poll#2@${500 + FIFO_GAP_MS}`]);
  });

  it("an identical request that would leave later anyway is not held longer, and three in a row keep their order", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(resolveChaos({ seed: 1 }), t.timers);
    const left: string[] = [];
    const same = sameRequest("POST", "http://app.test/api/counter/increment", "{}");
    const go = (name: string, delayMs: number): void => void s.hold({ key: name, delayMs }, same).then(() => left.push(`${name}@${t.now()}`));
    go("a", 100);
    go("b", 400);
    go("c", 20);
    await t.advance(600);
    expect(left).toEqual(["a@100", "b@400", `c@${400 + FIFO_GAP_MS}`]);
  });

  it("without an identity a request is held for its own delay only, and dispose releases a request waiting for its twin", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(resolveChaos({ seed: 1 }), t.timers);
    const left: string[] = [];
    void s.hold({ key: "x#1", delayMs: 300 }).then(() => left.push("x#1"));
    void s.hold({ key: "x#2", delayMs: 10 }).then(() => left.push("x#2"));
    await t.advance(20);
    expect(left).toEqual(["x#2"]);
    const same = sameRequest("GET", "http://app.test/api/y", null);
    void s.hold({ key: "y#1", delayMs: 5000 }, same).then(() => left.push("y#1"));
    void s.hold({ key: "y#2", delayMs: 1 }, same).then(() => left.push("y#2"));
    await t.advance(5);
    s.dispose();
    await t.advance(1);
    expect(left).toEqual(["x#2", "x#1", "y#1", "y#2"]);
  });

  it("pause: what is held leaves at once and nothing is held until resume", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(resolveChaos({ seed: 1 }), t.timers);
    const left: string[] = [];
    const go = (name: string, delayMs: number, same?: string): void => void s.hold({ key: name, delayMs }, same).then(() => left.push(`${name}@${t.now()}`));
    const notes = orderKey("POST", "http://app.test/api/notes", "{}");
    go("held", 500);
    go("note 1", 400, notes);
    go("note 2", 10, notes);
    await t.advance(20);
    expect(left).toEqual([]);
    s.pause();
    await t.advance(1);
    // all three left, the two writes to one path still in the order they were sent
    expect(left.map((x) => x.split("@")[0])).toEqual(["held", "note 1", "note 2"]);
    go("sent offline", 300);
    await t.advance(1);
    expect(left).toHaveLength(4);
    expect(t.pending()).toBe(0);
    s.resume();
    go("back online", 100);
    await t.advance(50);
    expect(left).toHaveLength(4);
    await t.advance(60);
    expect(left[4]).toMatch(/^back online@/);
  });

  it("with reorder off the page's order holds as before, identical or not", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(resolveChaos({ seed: 1, reorder: false }), t.timers);
    const left: string[] = [];
    const same = sameRequest("GET", "http://app.test/api/z", null);
    void s.hold({ key: "z#1", delayMs: 200 }, same).then(() => left.push("z#1"));
    void s.hold({ key: "other", delayMs: 0 }).then(() => left.push("other"));
    void s.hold({ key: "z#2", delayMs: 0 }, same).then(() => left.push("z#2"));
    await t.advance(400);
    expect(left).toEqual(["z#1", "other", "z#2"]);
  });
});
