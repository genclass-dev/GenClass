// @genclass/runtime/agent delivery orders for systematic explore (docs/runtime/AGENT.md section 3, CONTRACT §16):
// lifo, ranked, seeded reverse, delaySeed, the release order and the hold bound, and a held fetch the app aborts.
import { describe, expect, it } from "vitest";
import { connectAgent, hash32, parseSpec } from "../src/agent/index.js";
import { Scheduler, type Delivered, type ScheduleSpec } from "../src/agent/schedule.js";
import { FakeClock, setup as baseSetup, type Setup } from "./helpers.js";

const LOC = { href: "http://localhost:5173/search", pathname: "/search", hostname: "localhost", search: "" };
const setup = (o: Parameters<typeof baseSetup>[0] = {}): Setup => baseSetup({ ...o, extraGlobal: { location: LOC, ...(o?.extraGlobal ?? {}) } });

/** A request of a simulated burst: it starts at `start` (ms from t0) and its response reaches the gate `lat` ms later. */
interface Req {
  name: string;
  start: number;
  lat: number;
}

/**
 * Run a burst through a Scheduler on a FakeClock. `onLanded(key, start)` runs as each response reaches the app (a
 * handler that sends a follow-up calls `start`).
 */
async function run(spec: ScheduleSpec, reqs: Req[], onLanded?: (key: string, start: (r: Req) => void) => void) {
  const clock = new FakeClock();
  const t0 = clock.now();
  const got: Delivered[] = [];
  const sc = new Scheduler(clock, spec, (d) => got.push(d));
  let id = 0;
  const start = (r: Req): void => {
    const op = { id: ++id, name: r.name, start: clock.now() };
    sc.started(op);
    const arrive = () =>
      sc.gate(op, (landed) => {
        landed();
        onLanded?.(sc.slot(op.id)!.key, start);
      });
    clock.setTimeout(arrive, r.lat);
  };
  for (const r of reqs) clock.setTimeout(() => start(r), r.start);
  await clock.advance(20_000);
  const at = (key: string) => got.find((d) => d.key === key);
  const pos = (key: string) => got.findIndex((d) => d.key === key);
  return { got, t0, sc, clock, at, pos, keys: got.map((d) => d.key) };
}

/** A deterministic burst: `n` requests started in order a few ms apart, latencies hashed from the set. */
function burst(set: number): Req[] {
  const n = 4 + (hash32(`n|${set}`) % 6);
  return Array.from({ length: n }, (_, i) => ({ name: `GET /api/r${i}`, start: i * 7 + (hash32(`s|${set}|${i}`) % 5), lat: 20 + (hash32(`l|${set}|${i}`) % 400) }));
}

/** Pairs (a, b), a started first, that overlap: b started before a was ready (strictly), from the run's own timing. */
function overlapping(reqs: Req[], r: Awaited<ReturnType<typeof run>>): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < reqs.length; i++)
    for (let j = i + 1; j < reqs.length; j++) {
      const a = r.at(`${reqs[i].name}#1`)!;
      if (r.t0 + reqs[j].start < a.ready!) out.push([a.key, `${reqs[j].name}#1`]);
    }
  return out;
}

describe("agent: parseSpec, the new orders and fields (AGENT.md §3, CONTRACT §16)", () => {
  it("accepts lifo, ranked, reverse and delaySeed", () => {
    expect(parseSpec("lifo")).toEqual({ order: "lifo" });
    expect(parseSpec({ order: "lifo", delay: { minMs: 40, maxMs: 40 }, delaySeed: 3 })).toEqual({ order: "lifo", delay: { minMs: 40, maxMs: 40 }, delaySeed: 3 });
    expect(parseSpec({ order: "ranked", ranks: ["GET /b#1", "GET /a#1"] })).toEqual({ order: "ranked", ranks: ["GET /b#1", "GET /a#1"] });
    expect(parseSpec('{"order":"ranked","ranks":["GET /a#1"]}')).toEqual({ order: "ranked", ranks: ["GET /a#1"] });
    expect(parseSpec({ order: "seeded", seed: 4, reverse: true })).toEqual({ order: "seeded", seed: 4, reverse: true });
    expect(parseSpec({ order: "fifo", delaySeed: 7 })).toEqual({ order: "fifo", delaySeed: 7 });
  });

  it("ranked without ranks runs with an empty list; ranks are kept only for ranked, given only for given", () => {
    expect(parseSpec({ order: "ranked" })).toEqual({ order: "ranked", ranks: [] });
    expect(parseSpec({ order: "ranked", ranks: "GET /a#1" })).toEqual({ order: "ranked", ranks: [] });
    expect(parseSpec({ order: "fifo", ranks: ["GET /a#1"] })).toEqual({ order: "fifo" });
    expect(parseSpec({ order: "ranked", ranks: ["GET /a#1"], given: ["GET /a#1"] })).toEqual({ order: "ranked", ranks: ["GET /a#1"] });
  });

  it("caps ranks like given (strings of at most 300 characters, at most 2,000 of them)", () => {
    const long = `GET /${"x".repeat(300)}#1`;
    const many = Array.from({ length: 2500 }, (_, i) => `GET /a#${i + 1}`);
    const r = parseSpec({ order: "ranked", ranks: [long, 5, null, ...many] })!;
    expect(r.ranks).toHaveLength(2000);
    expect(r.ranks![0]).toBe("GET /a#1");
    expect(r.ranks!.includes(long)).toBe(false);
    expect(parseSpec({ order: "given", given: [long, ...many] })!.given).toEqual(r.ranks);
  });

  it("keeps reverse only when it is true (anything else is ignored, never rejected); delaySeed is an integer up to 2^31", () => {
    expect(parseSpec({ order: "seeded", seed: 2, reverse: "yes" })).toEqual({ order: "seeded", seed: 2 });
    expect(parseSpec({ order: "seeded", seed: 2, reverse: false })).toEqual({ order: "seeded", seed: 2 });
    expect(parseSpec({ order: "seeded", seed: 2, reverse: 1 })).toEqual({ order: "seeded", seed: 2 });
    expect(parseSpec({ order: "fifo", delaySeed: 3.9 })).toEqual({ order: "fifo", delaySeed: 3 });
    expect(parseSpec({ order: "fifo", delaySeed: 2 ** 40 })).toEqual({ order: "fifo", delaySeed: 2 ** 31 });
    expect(parseSpec({ order: "fifo", delaySeed: -1 })).toEqual({ order: "fifo" });
    expect(parseSpec({ order: "fifo", delaySeed: "7" })).toEqual({ order: "fifo" });
  });

  it("still rejects what it cannot run", () => {
    expect(parseSpec({ order: "zigzag" })).toBeNull();
    expect(parseSpec("lifo-ish")).toBeNull();
    expect(parseSpec({ order: "given" })).toBeNull();
  });
});

describe("agent: lifo (AGENT.md §3, CONTRACT §16)", () => {
  it("delivers the newest-started response first among overlapping requests", async () => {
    const r = await run({ order: "lifo" }, [
      { name: "GET /a", start: 0, lat: 100 },
      { name: "GET /b", start: 10, lat: 100 },
      { name: "GET /c", start: 20, lat: 100 },
    ]);
    expect(r.keys).toEqual(["GET /c#1", "GET /b#1", "GET /a#1"]);
    expect(r.sc.forced).toBe(0);
  });

  it("a request that starts after a response was ready does not hold it back", async () => {
    // a is ready at 50; b starts at 60, after it: no overlap, a goes at once
    const r = await run({ order: "lifo" }, [
      { name: "GET /a", start: 0, lat: 50 },
      { name: "GET /b", start: 60, lat: 10 },
    ]);
    expect(r.keys).toEqual(["GET /a#1", "GET /b#1"]);
    expect(r.at("GET /a#1")!.at - r.t0).toBe(50);
  });

  it("strict bound: a child sent by a released response's handler at the instant an older response is ready does not hold it", async () => {
    // b and c are ready at 100; c (newer) goes first and its handler sends d at 100: d did not start before b was ready
    const r = await run(
      { order: "lifo" },
      [
        { name: "GET /b", start: 0, lat: 100 },
        { name: "GET /c", start: 5, lat: 95 },
      ],
      (key, start) => {
        if (key === "GET /c#1") start({ name: "GET /d", start: 0, lat: 40 });
      },
    );
    expect(r.keys).toEqual(["GET /c#1", "GET /b#1", "GET /d#1"]);
    expect(r.at("GET /b#1")!.at - r.t0).toBe(130); // one gap after c, not after d
  });

  it("releases by ready time: A, ready at 100, waits for a gap until 120; P starts at 105 and is ready at 110: A goes first", async () => {
    const r = await run({ order: "lifo" }, [
      { name: "GET /a", start: 0, lat: 100 },
      { name: "GET /x", start: 1, lat: 89 }, // released at 90: the next release is not before 120
      { name: "GET /p", start: 105, lat: 5 },
    ]);
    expect(r.keys).toEqual(["GET /x#1", "GET /a#1", "GET /p#1"]);
    expect(r.at("GET /a#1")!.at - r.t0).toBe(120);
    expect(r.at("GET /p#1")!.at - r.t0).toBe(150);
  });

  it("fifo and lifo deliver every overlapping pair of a burst in both orders (eight bursts)", async () => {
    let pairs = 0;
    for (let set = 0; set < 8; set++) {
      const reqs = burst(set);
      const fifo = await run({ order: "fifo", maxHoldMs: 5000 }, reqs);
      const lifo = await run({ order: "lifo", maxHoldMs: 5000 }, reqs);
      expect(fifo.got).toHaveLength(reqs.length);
      expect(lifo.got).toHaveLength(reqs.length);
      expect(fifo.sc.forced + lifo.sc.forced).toBe(0);
      for (const [a, b] of overlapping(reqs, lifo)) {
        pairs++;
        expect(fifo.pos(a) < fifo.pos(b), `set ${set}: fifo ${a} before ${b}`).toBe(true);
        expect(lifo.pos(b) < lifo.pos(a), `set ${set}: lifo ${b} before ${a}`).toBe(true);
      }
    }
    expect(pairs).toBeGreaterThan(20);
  });

  it("a hedge never holds a response back (it answers the app on its own path)", async () => {
    const clock = new FakeClock();
    const got: string[] = [];
    const sc = new Scheduler(clock, { order: "lifo" }, (d) => got.push(d.key));
    const t = clock.now();
    const a = { id: 1, name: "GET /a", start: t };
    const b = { id: 2, name: "GET /b", start: t + 2 };
    const hedge = { id: 3, name: "GET /b", start: t + 5, cause: 2 }; // GenClass's hedge of b, still in flight
    sc.started(a);
    sc.started(b);
    expect(sc.started(hedge).key).toBe("GET /b#1~hedge");
    await clock.advance(20);
    sc.gate(a, (landed) => landed()); // b and its hedge are newer and in flight: a waits for b only
    await clock.advance(30);
    expect(got).toEqual([]);
    sc.gate(b, (landed) => landed());
    await clock.advance(100);
    expect(got).toEqual(["GET /b#1", "GET /a#1"]);
    expect(sc.forced).toBe(0);
  });

  it("a request of a response's own chain (its retry, or the request it retries) never holds it back", async () => {
    // lifo: a's retry is newer and in flight, but it is a's own chain
    const clock = new FakeClock();
    const got: string[] = [];
    const sc = new Scheduler(clock, { order: "lifo" }, (d) => got.push(d.key));
    const t = clock.now();
    const a = { id: 1, name: "GET /a", start: t };
    sc.started(a);
    expect(sc.started({ id: 2, name: "GET /a", start: t + 5, attempt: 2, cause: 1 }).key).toBe("GET /a#1~retry2");
    await clock.advance(20);
    sc.gate(a, (landed) => landed());
    await clock.advance(1);
    expect(got).toEqual(["GET /a#1"]);
    // ranked: the request a retry repeats ranks higher and is in flight, but it is the retry's own chain
    const clock2 = new FakeClock();
    const got2: string[] = [];
    const sc2 = new Scheduler(clock2, { order: "ranked", ranks: ["GET /a#1"] }, (d) => got2.push(d.key));
    const t2 = clock2.now();
    sc2.started({ id: 1, name: "GET /a", start: t2 });
    const retry = { id: 2, name: "GET /a", start: t2 + 5, attempt: 2, cause: 1 };
    sc2.started(retry);
    await clock2.advance(20);
    sc2.gate(retry, (landed) => landed());
    await clock2.advance(1);
    expect(got2).toEqual(["GET /a#1~retry2"]);
  });
});

describe("agent: seeded reverse and ranked (AGENT.md §3, CONTRACT §16)", () => {
  it("the same seed reversed delivers every overlapping pair the other way (eight bursts, four seeds)", async () => {
    let pairs = 0;
    for (let set = 0; set < 8; set++) {
      const reqs = burst(set);
      for (const seed of [1, 2, 3, 4]) {
        const fwd = await run({ order: "seeded", seed, maxHoldMs: 5000 }, reqs);
        const rev = await run({ order: "seeded", seed, reverse: true, maxHoldMs: 5000 }, reqs);
        expect(fwd.sc.forced + rev.sc.forced).toBe(0);
        for (const [a, b] of overlapping(reqs, fwd)) {
          pairs++;
          expect(fwd.pos(a) < fwd.pos(b), `set ${set} seed ${seed}: ${a} / ${b}`).toBe(rev.pos(b) < rev.pos(a));
        }
      }
    }
    expect(pairs).toBeGreaterThan(80);
  });

  it("ranked realises the rank order of overlapping keys", async () => {
    for (let set = 0; set < 8; set++) {
      const reqs = burst(set);
      // a rank order hashed from the set
      const ranks = reqs.map((q) => `${q.name}#1`).sort((x, y) => hash32(`${set}|${x}`) - hash32(`${set}|${y}`));
      const r = await run({ order: "ranked", ranks, maxHoldMs: 5000 }, reqs);
      expect(r.sc.forced).toBe(0);
      for (const [a, b] of overlapping(reqs, r)) expect(r.pos(a) < r.pos(b), `set ${set}: ${a} / ${b}`).toBe(ranks.indexOf(a) < ranks.indexOf(b));
    }
  });

  it("ranked never waits for a higher-ranked key that started after the response was ready", async () => {
    // ranks p, x, s: s is ready at 100 and waits for p (started at 50); x starts at 200, after s was ready
    const r = await run({ order: "ranked", ranks: ["GET /p#1", "GET /x#1", "GET /s#1"] }, [
      { name: "GET /s", start: 0, lat: 100 },
      { name: "GET /p", start: 50, lat: 250 },
      { name: "GET /x", start: 200, lat: 200 },
    ]);
    expect(r.keys).toEqual(["GET /p#1", "GET /s#1", "GET /x#1"]);
    expect(r.at("GET /s#1")!.at - r.t0).toBe(330);
    expect(r.sc.forced).toBe(0);
  });

  it("ranked with no ranks delivers in request order, like fifo", async () => {
    for (let set = 0; set < 4; set++) {
      const reqs = burst(set);
      const fifo = await run({ order: "fifo", maxHoldMs: 5000 }, reqs);
      const ranked = await run({ order: "ranked", ranks: [], maxHoldMs: 5000 }, reqs);
      expect(ranked.keys).toEqual(fifo.keys);
    }
  });

  it("delaySeed gives fifo the same per-key delays as seeded with that seed", async () => {
    const reqs = Array.from({ length: 6 }, (_, i) => ({ name: `GET /api/k${i}`, start: i * 1000, lat: 10 }));
    const delay = { minMs: 0, maxMs: 500 };
    const seeded = await run({ order: "seeded", seed: 7, delay }, reqs);
    const fifo = await run({ order: "fifo", delaySeed: 7, delay }, reqs);
    const plain = await run({ order: "fifo", delay }, reqs);
    const ready = (r: Awaited<ReturnType<typeof run>>) => r.got.map((d) => [d.key, d.ready! - r.t0]);
    expect(ready(fifo)).toEqual(ready(seeded));
    expect(ready(plain)).not.toEqual(ready(seeded)); // without it, fifo hashes seed 0
    // the delay is the emulated network: each response goes when it is ready (+1 ms: the wake-up's slack)
    for (const d of fifo.got) expect(d.at - d.ready!).toBeLessThanOrEqual(1);
  });
});

describe("agent: the hold bound and the release order (AGENT.md §3, CONTRACT §16)", () => {
  it("a forced response is released by its delay plus maxHoldMs while a newer response becomes ready every 20 ms", async () => {
    const delay = { minMs: 10, maxMs: 10 };
    const reqs: Req[] = [
      { name: "GET /a", start: 0, lat: 10 }, // ready at 20, deadline 520
      { name: "GET /b", start: 5, lat: 3000 }, // newer, started before a was ready: holds it back to its deadline
      // a newer response ready every 20 ms (30, 50, 70, ...), none overlapping the next: each may go, one per 30 ms gap,
      // so a gap is pending at a's deadline
      ...Array.from({ length: 60 }, (_, i) => ({ name: `GET /c${i}`, start: 15 + 20 * i, lat: 5 })),
    ];
    const r = await run({ order: "lifo", delay, maxHoldMs: 500 }, reqs);
    const a = r.at("GET /a#1")!;
    expect(a.forced).toBe(true);
    expect(a.at - r.t0).toBeLessThanOrEqual(10 + 10 + 500 + 1);
    expect(r.sc.forced).toBe(1); // the c responses only waited for the gap: released by their deadlines, not forced
    for (const d of r.got) expect(d.at - d.ready!, d.key).toBeLessThanOrEqual(500 + 1);
    expect(r.got).toHaveLength(reqs.length);
  });

  for (const order of ["fifo", "lifo", "seeded", "ranked", "given"] as const) {
    it(`${order}: 60 responses ready at once never exceed the bound, and are released in the schedule's order`, async () => {
      const reqs = Array.from({ length: 60 }, (_, i) => ({ name: `GET /api/i${i}`, start: i, lat: 100 - i }));
      const keys = reqs.map((q) => `${q.name}#1`);
      // a hold limit that is no whole number of gaps: a gap is pending when it runs out
      const hold = { maxHoldMs: 1000 };
      const spec: ScheduleSpec =
        order === "ranked"
          ? { order, ranks: [...keys].reverse(), ...hold }
          : order === "given"
            ? { order, given: [...keys].reverse(), ...hold }
            : order === "seeded"
              ? { order, seed: 5, ...hold }
              : { order, ...hold };
      const r = await run(spec, reqs);
      expect(r.got).toHaveLength(60);
      for (const d of r.got) expect(d.at - d.ready!, d.key).toBeLessThanOrEqual(1000 + 1);
      // the gap alone would have taken 59 x 30 ms; the last ones went together at the limit, none against the schedule
      expect(Math.max(...r.got.map((d) => d.at - r.t0))).toBeLessThanOrEqual(100 + 1000 + 1);
      expect(r.sc.forced).toBe(0);
      if (order === "fifo") expect(r.keys).toEqual(keys);
      if (order === "lifo" || order === "ranked" || order === "given") expect(r.keys).toEqual([...keys].reverse());
    });
  }

  it("a response that only waited for the gap past its deadline is released, not forced", async () => {
    const r = await run({ order: "fifo", maxHoldMs: 50, gapMs: 1000 }, [
      { name: "GET /a", start: 0, lat: 10 },
      { name: "GET /b", start: 1, lat: 9 },
    ]);
    expect(r.at("GET /a#1")!.at - r.t0).toBe(10);
    expect(r.at("GET /b#1")!.at - r.t0).toBeLessThanOrEqual(10 + 50 + 1);
    expect(r.sc.forced).toBe(0);
  });
});

describe("agent: a held fetch honours the app's abort (AGENT.md §3, CONTRACT §16)", () => {
  /** The fake bridge: hello answers; events are dropped. */
  function bridge(s: Setup) {
    s.server.on("POST", "/v1/hello", { body: { run: "r1", schedule: null }, latency: 1 });
    s.server.on("POST", "/v1/events", { body: { ok: true }, latency: 1 });
  }

  it("fifo with a delay: the app aborts while its response is held; the promise rejects with AbortError when it is released", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("GET", "/api/a", { body: { v: "a" }, latency: 20 });
    connectAgent(s.rt, { schedule: { order: "fifo", delay: { minMs: 200, maxMs: 200 } } });
    const ac = new AbortController();
    let got: unknown;
    let err: unknown;
    void s.fetch("/api/a", { signal: ac.signal }).then(
      (r) => (got = r),
      (e) => (err = e),
    );
    await s.clock.advance(100); // the response arrived at 20 and is held until 220
    expect(err).toBeUndefined();
    ac.abort();
    await s.clock.advance(400);
    expect(got).toBeUndefined();
    expect((err as Error).name).toBe("AbortError");
  });

  it("lifo: an older response held for a newer request rejects as aborted when the app aborted it; the newer one is delivered", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("GET", "/api/a", { body: { v: "a" }, latency: 30 });
    s.server.on("GET", "/api/b", { body: { v: "b" }, latency: 300 });
    const c = connectAgent(s.rt, { schedule: "lifo" });
    const ac = new AbortController();
    const seen: string[] = [];
    void s.fetch("/api/a", { signal: ac.signal }).then(
      async (r) => seen.push(((await r.json()) as { v: string }).v),
      (e: Error) => seen.push(e.name),
    );
    await s.clock.advance(10);
    void s.fetch("/api/b").then(async (r) => seen.push(((await r.json()) as { v: string }).v));
    await s.clock.advance(60); // a arrived at 30: held behind b, which is newer and in flight
    ac.abort(); // e.g. the app's own timeout
    await s.clock.advance(1000);
    expect(seen).toEqual(["b", "AbortError"]);
    expect(c.schedule).toEqual({ order: "lifo" });
  });

  it("natural: nothing is held, so an abort after the response arrived changes nothing", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("GET", "/api/a", { body: { v: "a" }, latency: 20 });
    connectAgent(s.rt, { schedule: "natural" });
    const ac = new AbortController();
    let got: Response | undefined;
    void s.fetch("/api/a", { signal: ac.signal }).then((r) => (got = r));
    await s.clock.advance(30);
    ac.abort();
    await s.clock.advance(100);
    expect(got?.status).toBe(200);
  });
});
