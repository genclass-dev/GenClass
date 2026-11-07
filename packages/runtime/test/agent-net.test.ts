// @genclass/runtime/agent: the net log (each request's timing, outside the step window), the hello's caps, the
// fallback when the bridge's schedule cannot run, and the warning for a page-set one (docs/runtime/AGENT.md
// sections 2-4, CONTRACT §16).
import { describe, expect, it, vi } from "vitest";
import { connectAgent, type NetEntry } from "../src/agent/index.js";
import { setup as baseSetup, type Setup } from "./helpers.js";

const LOC = { href: "http://localhost:5173/search", pathname: "/search", hostname: "localhost", search: "" };
const setup = (o: Parameters<typeof baseSetup>[0] = {}): Setup => baseSetup({ ...o, extraGlobal: { location: LOC, ...(o?.extraGlobal ?? {}) } });

/** A fake bridge on the fake server: hello answers with `schedule`; events are kept. */
function bridge(s: Setup, schedule: unknown = null, latency = 1) {
  const events: Record<string, unknown>[] = [];
  const hellos: Record<string, unknown>[] = [];
  s.server.on("POST", "/v1/hello", ({ body }) => {
    hellos.push(JSON.parse(body ?? "{}"));
    return { body: { run: `r${hellos.length}`, schedule }, latency };
  });
  s.server.on("POST", "/v1/events", ({ body }) => {
    const b = JSON.parse(body ?? "{}") as { events?: Record<string, unknown>[] };
    events.push(...(b.events ?? []));
    return { body: { ok: true }, latency };
  });
  /** The net log as the bridge merges it: the steps events' entries, by key. */
  const net = () => {
    const m = new Map<string, NetEntry>();
    for (const e of events) if (e.t === "steps") for (const x of (e.net as NetEntry[] | undefined) ?? []) m.set(x.key, x);
    return [...m.values()].sort((a, b) => a.n - b.n);
  };
  return { events, hellos, net };
}

const CAPS = ["lifo", "ranked", "reverse", "delaySeed", "net"];

describe("agent: the net log (AGENT.md §2, CONTRACT §16)", () => {
  it("records each request's start index, send, ready and delivery times, hold, pass, chain and end", async () => {
    const s = setup({ mode: undefined, requests: { protect: ["/api/pay"] } });
    const b = bridge(s);
    s.server.on("GET", "/api/a", { body: { v: "a" }, latency: 50 });
    s.server.on("POST", "/api/pay", { body: { ok: true }, latency: 20 });
    s.server.on("GET", "/api/e", { status: 500, body: {}, latency: 30 });
    s.server.on("GET", "/api/b", { body: { v: "b" }, latency: 50 });
    const c = connectAgent(s.rt, { schedule: { order: "fifo", delay: { minMs: 100, maxMs: 100 } } });
    // a's handler sends b; the payment is protected (never held); e fails
    void s.fetch("/api/a").then(async (r) => {
      await r.json();
      void s.fetch("/api/b");
    });
    await s.clock.advance(5);
    void s.fetch("/api/pay", { method: "POST", body: "{}" });
    await s.clock.advance(5);
    void s.fetch("/api/e").catch(() => undefined);
    await s.clock.advance(3000);
    // ready = arrival + the 100 ms delay; released at the wake-up 1 ms after it
    const want: NetEntry[] = [
      { key: "GET /api/a#1", n: 0, s: 0, r: 150, d: 151, held: 101 },
      { key: "POST /api/pay#1", n: 1, s: 5, r: 25, d: 25, pass: true },
      { key: "GET /api/e#1", n: 2, s: 10, end: "error" },
      { key: "GET /api/b#1", n: 3, s: 151, r: 301, d: 302, held: 101, via: "GET /api/a#1" },
    ];
    expect(c.recorded().net).toEqual(want);
    expect(c.recorded().netLost).toBe(0);
    // what the bridge received, merged by key, is the same log
    expect(b.net()).toEqual(want);
    const steps = b.events.filter((e) => e.t === "steps");
    expect(steps.length).toBeGreaterThan(0);
    for (const e of steps) expect(e.netLost).toBe(0);
    // recv steps carry the ready time and pass
    const recv = c.recorded().steps.filter((x) => x.k === "recv");
    expect(recv).toEqual([
      { k: "recv", t: 25, key: "POST /api/pay#1", ready: 25, pass: true },
      { k: "recv", t: 151, key: "GET /api/a#1", held: 101, ready: 150 },
      { k: "recv", t: 302, key: "GET /api/b#1", held: 101, ready: 301 },
    ]);
  });

  it("marks a response released only because its hold ran out as forced", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("GET", "/api/a", { body: { v: "a" }, latency: 20 });
    const c = connectAgent(s.rt, { schedule: { order: "given", given: ["GET /api/never#1", "GET /api/a#1"], maxHoldMs: 500 } });
    void s.fetch("/api/a");
    await s.clock.advance(2000);
    expect(c.recorded().net).toEqual([{ key: "GET /api/a#1", n: 0, s: 0, r: 20, d: 521, held: 501, forced: true }]);
  });

  it("an XHR the app aborts while its response is held ends 'aborted', never delivered", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("GET", "/api/a", { body: { v: "a" }, latency: 20 });
    const c = connectAgent(s.rt, { schedule: { order: "given", given: ["GET /api/never#1", "GET /api/a#1"], maxHoldMs: 5000 } });
    void s.fetch("/api/a");
    await s.clock.advance(100);
    // what the XHR observer reports when the app aborts a held XHR (src/observe/xhr.ts)
    const op = [...s.rt.ops.byId.values()].find((o) => o.kind === "fetch")!;
    s.rt.internals.events.push(s.clock.now(), "custom", "xhr.aborted-while-held", { op: op.id });
    await s.clock.advance(100);
    expect(c.recorded().net).toEqual([{ key: "GET /api/a#1", n: 0, s: 0, end: "aborted" }]);
    expect(c.recorded().steps.find((x) => x.k === "end")).toMatchObject({ key: "GET /api/a#1", status: "aborted" });
  });

  it("keeps every request's timing when the step window has dropped its steps", async () => {
    const s = setup({ mode: undefined });
    const b = bridge(s);
    s.server.on("GET", "/api/a", { body: { v: "a" }, latency: 20 });
    const c = connectAgent(s.rt, { schedule: "fifo", settleMs: 100 });
    const st = s.rt.atom("counter", { n: 0 });
    void s.fetch("/api/a");
    for (let i = 0; i < 700; i++) st.set({ n: i + 1 }); // 700 write steps before the first quiet point
    await s.clock.advance(2000);
    expect(c.recorded().truncated).toBe(true);
    expect(c.recorded().steps.some((x) => x.k === "send")).toBe(false); // the send step left the window
    expect(c.recorded().net.map((e) => e.key)).toEqual(["GET /api/a#1"]);
    expect(b.net().map((e) => [e.key, e.d])).toEqual([["GET /api/a#1", 20]]);
  });

  it("a request sent before connectAgent is logged from 0, in start order, and its later delivery is recorded", async () => {
    const s = setup({ mode: undefined });
    const b = bridge(s);
    s.server.on("GET", "/api/early", { body: {}, latency: 100 });
    s.server.on("GET", "/api/late", { body: {}, latency: 10 });
    void s.fetch("/api/early");
    await s.clock.advance(30);
    const c = connectAgent(s.rt, { schedule: "fifo" });
    void s.fetch("/api/late");
    await s.clock.advance(2000);
    // early arrived 70 ms after connectAgent; late (sent at 0, arrived at 10) waited for it in fifo
    expect(c.recorded().net).toEqual([
      { key: "GET /api/early#1", n: 0, s: 0, r: 70, d: 70 },
      { key: "GET /api/late#1", n: 1, s: 0, r: 10, d: 100, held: 90 },
    ]);
    expect(b.net()).toEqual(c.recorded().net);
  });

  it("keeps the first 2,000 requests of a page load and counts the rest in netLost", async () => {
    const s = setup({ mode: undefined });
    const b = bridge(s);
    s.server.on("GET", "/api/x", { body: {}, latency: 10 });
    const c = connectAgent(s.rt, { schedule: "natural" });
    for (let i = 0; i < 2005; i++) void s.fetch("/api/x");
    await s.clock.advance(3000);
    const r = c.recorded();
    expect(r.net).toHaveLength(2000);
    expect(r.net[1999]).toMatchObject({ key: "GET /api/x#2000", n: 1999 });
    expect(r.netLost).toBe(5);
    const last = b.events.filter((e) => e.t === "steps").pop()!;
    expect(last.netLost).toBe(5);
    expect(b.net()).toHaveLength(2000);
  }, 30_000);
});

describe("agent: hello caps and the schedule fallback (AGENT.md §4, CONTRACT §16)", () => {
  it("hello tells the bridge what this page can run", async () => {
    const s = setup({ mode: undefined });
    const b = bridge(s);
    connectAgent(s.rt);
    await s.clock.advance(100);
    expect(b.hellos[0].caps).toEqual(CAPS);
  });

  it("a reply schedule this runtime cannot run: the page runs natural and says so, once", async () => {
    const s = setup({ mode: undefined });
    const b = bridge(s, { order: "zigzag", seed: 3 });
    const c = connectAgent(s.rt);
    await s.clock.advance(1000);
    expect(c.schedule).toEqual({ order: "natural" });
    expect(b.events.filter((e) => e.t === "schedule")).toEqual([{ t: "schedule", spec: { order: "natural" }, fallback: true, rejected: "zigzag" }]);
  });

  it("the rejected order is sent as a string of at most 20 characters", async () => {
    const s = setup({ mode: undefined });
    const b = bridge(s, { order: "x".repeat(50) });
    connectAgent(s.rt);
    await s.clock.advance(1000);
    expect(b.events.find((e) => e.t === "schedule")!.rejected).toBe("x".repeat(20));
  });

  it("no fallback message for a schedule it can run, for no schedule, or when the page set its own", async () => {
    for (const [reply, local] of [
      [{ order: "lifo" }, undefined],
      [{ order: "ranked", ranks: ["GET /api/a#1"] }, undefined],
      [null, undefined],
      [{ order: "zigzag" }, "fifo"],
    ] as const) {
      const s = setup({ mode: undefined });
      const b = bridge(s, reply);
      const c = connectAgent(s.rt, local ? { schedule: local } : {});
      await s.clock.advance(1000);
      expect(b.events.filter((e) => e.t === "schedule"), JSON.stringify(reply)).toEqual([]);
      expect(c.schedule).toEqual(local ? { order: local } : reply ?? { order: "natural" });
    }
  });
});

describe("agent: a page-set schedule this runtime cannot run (AGENT.md §3, CONTRACT §16)", () => {
  const MSG = '[GenClass] agent: this @genclass/runtime cannot run the schedule "zigzag"; responses are delivered as they arrive';
  const warnings = (warn: ReturnType<typeof vi.fn>) => warn.mock.calls.filter((a) => String(a[0]).includes("cannot run the schedule"));

  it("warns once and delivers as responses arrive (the bridge is told natural, so it assigns none)", async () => {
    const warn = vi.fn();
    const s = setup({ mode: undefined, extraGlobal: { console: { warn, info: () => undefined, log: () => undefined, error: () => undefined } } });
    const b = bridge(s, { order: "fifo" });
    const c = connectAgent(s.rt, { schedule: { order: "zigzag" } as never });
    expect(warnings(warn)).toEqual([[MSG]]);
    expect(c.schedule).toEqual({ order: "natural" });
    expect(connectAgent(s.rt)).toBe(c); // the same connection: no second warning
    s.server.on("GET", "/api/a", { body: { v: "a" }, latency: 300 });
    s.server.on("GET", "/api/b", { body: { v: "b" }, latency: 50 });
    const seen: string[] = [];
    const get = (p: string) => void s.fetch(p).then(async (r) => seen.push(((await r.json()) as { v: string }).v));
    get("/api/a");
    await s.clock.advance(10);
    get("/api/b");
    await s.clock.advance(1000);
    expect(seen).toEqual(["b", "a"]);
    expect(b.hellos[0].schedule).toEqual({ order: "natural" });
    expect(c.schedule).toEqual({ order: "natural" });
    expect(warnings(warn)).toHaveLength(1);
  });

  it("an exotic page-set value never throws into the page", () => {
    const s = setup({ mode: undefined, extraGlobal: { console: { warn: () => undefined } } });
    bridge(s);
    const c = connectAgent(s.rt, { schedule: { order: Object.create(null) } as never });
    expect(c.schedule).toEqual({ order: "natural" });
  });

  it("the URL parameter form warns the same way; a schedule it can run does not warn", async () => {
    const warn = vi.fn();
    const quiet = { warn, info: () => undefined, log: () => undefined, error: () => undefined };
    const at = { ...LOC, href: "http://localhost:5173/search?genclass-schedule=zigzag", search: "?genclass-schedule=zigzag" };
    const s = setup({ mode: undefined, extraGlobal: { console: quiet, location: at } });
    bridge(s);
    const c = connectAgent(s.rt);
    expect(warnings(warn)).toEqual([[MSG]]);
    expect(c.schedule).toEqual({ order: "natural" });
    const warn2 = vi.fn();
    const s2 = setup({ mode: undefined, extraGlobal: { console: { ...quiet, warn: warn2 } } });
    bridge(s2);
    expect(connectAgent(s2.rt, { schedule: "lifo" }).schedule).toEqual({ order: "lifo" });
    expect(warnings(warn2)).toEqual([]);
  });
});
