// Delivery schedules for the local agent harness (docs/runtime/AGENT.md section 3). A schedule only chooses WHEN each
// response reaches the app, the way a slower or reordering network would: it never drops, changes or invents a
// response, never touches a request, and decides nothing about the app. Every response is delivered; a hold never
// outlasts the response's own `delay` plus `maxHoldMs` (then the run is marked forced).
//
// Orders:
//   natural  deliver as responses arrive (no hold; recording only)
//   fifo     deliver in the order the requests started: the serial baseline an explore run is compared with
//   lifo     among overlapping requests the newest-started response goes first: a response waits for every newer
//            request that started before it was ready, so fifo and lifo deliver every pair that overlaps in the lifo
//            run itself (and was not forced) in both orders
//   seeded   each request gets a priority hashed from the seed and its key; a response waits while a request with a
//            higher priority is in flight (probabilistic concurrency testing over the requests that overlap);
//            `reverse` inverts the priorities, so the same seed reversed delivers its overlapping pairs the other way
//   ranked   `ranks` lists keys from highest to lowest priority (unlisted keys below every listed one, among themselves
//            in request order); a response waits for a higher-ranked request that started before it was ready
//   given    a recorded delivery order (a run's `order`): each response waits for the keys listed before it
//
// Overlap, the one definition the MCP bridge shares: a response is ready at its arrival at the delivery gate plus its
// emulated delay; request a, started before b, overlaps b in a run iff b started before a was ready (strictly). lifo and
// ranked wait only for overlapping requests, never for a ~hedge (it answers the app on its own path) nor for a request
// of the waiting one's own chain (a retry or hedge of it, or the request it retries).
//
// Release order (every order): a held response whose deadline (arrival + delay + maxHoldMs) has come is released at
// once, earliest arrival first, without waiting for `gapMs` (marked forced only when the schedule still held it back);
// the others that may go are released one per `gapMs`: fifo in start order, given in list order, seeded by priority,
// lifo and ranked by ready time, then request id (two of those never overlap, so start order must not decide).
//
// Deterministic: priorities and delays are hashes of the seed and the request key (never Math.random); time comes from
// the injected Clock. A request's key is its signature and occurrence in this page load ("GET /api/search#3"), so the
// same scenario gives the same keys on every run, whatever the query values or timing. A retry (attempt > 1) or a hedge
// of a keyed request gets that request's key plus a suffix and does not shift the numbering. Each request also gets
// its start index `n` (its position among this page load's requests, in start order).
//
// A response counts as delivered when the app receives it (`landed`), not when it is handed to the runtime's own
// delivery path, which in guard or heal may hold it further: until then it still blocks later responses (bounded).

import type { Clock } from "../types.js";

export type ScheduleOrder = "natural" | "fifo" | "lifo" | "seeded" | "ranked" | "given";

/** How responses are delivered on this page (docs/runtime/AGENT.md section 3). */
export interface ScheduleSpec {
  order: ScheduleOrder;
  /** seeded: the seed (a non-negative integer). Also seeds `delay` when there is no `delaySeed`. */
  seed?: number;
  /** given: request keys in the order their responses are delivered. */
  given?: string[];
  /** ranked: request keys from highest to lowest priority; unlisted keys rank below every listed one. */
  ranks?: string[];
  /** seeded: invert the priorities (only `true` is kept), so each overlapping pair of the seed goes the other way. */
  reverse?: true;
  /** seeded: request signatures ("PUT /api/notes/:id") whose responses go after every other overlapping one. */
  focus?: string[];
  /** Extra latency per response, uniform in [minMs, maxMs], hashed from the seed and the key (a slow network). */
  delay?: { minMs: number; maxMs: number };
  /** Seeds `delay` in place of `seed`, so runs of different orders get the same per-key latencies. */
  delaySeed?: number;
  /** A response is never held longer than this; then it is delivered and the run is marked forced. Default 1500. */
  maxHoldMs?: number;
  /** Time between two releases, so one response's handlers run before the next arrives. Default 30. */
  gapMs?: number;
  /** Set by the MCP server: the explore session or finding this run belongs to. */
  id?: string;
  /** Free text for reports ("explore 3 of 6"). */
  label?: string;
}

export const DEFAULT_MAX_HOLD_MS = 1500;
export const DEFAULT_GAP_MS = 30;
/** A request older than this neither blocks a delivery nor waits for one (long polls, streams), as in Runtime.busy. */
export const LONG_RUNNING_MS = 10_000;
const ORDERS: readonly ScheduleOrder[] = ["natural", "fifo", "lifo", "seeded", "ranked", "given"];
/** Keys a `given` or `ranks` list keeps, and their length. */
const MAX_KEYS = 2000;
const MAX_KEY = 300;

/** 32-bit FNV-1a: the priority and delay hash. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // final avalanche (murmur3 fmix32), so neighbouring keys do not get neighbouring priorities
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** A schedule from untrusted input (URL, a page global, the bridge), or null when it is not one. */
export function parseSpec(v: unknown): ScheduleSpec | null {
  if (typeof v === "string") {
    // URL forms: "fifo", "lifo", "natural", "seeded:7", "explore:7" (alias), "given:<json array of keys>", or a JSON
    // object
    const s = v.trim();
    const m = /^(natural|fifo|lifo|seeded|explore)(?::(\d{1,9}))?$/.exec(s);
    if (m) return m[1] === "seeded" || m[1] === "explore" ? { order: "seeded", seed: Number(m[2] ?? 1) } : { order: m[1] as ScheduleOrder };
    if (s.startsWith("given:")) {
      try {
        return parseSpec({ order: "given", given: JSON.parse(s.slice(6)) as unknown });
      } catch {
        return null;
      }
    }
    if (s.startsWith("{")) {
      try {
        return parseSpec(JSON.parse(s));
      } catch {
        return null;
      }
    }
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const order = o.order as ScheduleOrder;
  if (!ORDERS.includes(order)) return null;
  const out: ScheduleSpec = { order };
  const int = (x: unknown, max: number): number | undefined => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.min(Math.floor(x), max) : undefined);
  const keys = (x: unknown[]): string[] => x.filter((k): k is string => typeof k === "string" && k.length <= MAX_KEY).slice(0, MAX_KEYS);
  const seed = int(o.seed, 2 ** 31);
  if (order === "seeded") out.seed = seed ?? 1;
  else if (seed !== undefined) out.seed = seed;
  if (order === "given") {
    if (!Array.isArray(o.given)) return null;
    out.given = keys(o.given);
  }
  // ranked without ranks: every key unlisted, so in request order (as fifo)
  if (order === "ranked") out.ranks = Array.isArray(o.ranks) ? keys(o.ranks) : [];
  if (o.reverse === true) out.reverse = true;
  if (Array.isArray(o.focus)) out.focus = o.focus.filter((k): k is string => typeof k === "string" && k.length <= MAX_KEY).slice(0, 20);
  const d = o.delay as Record<string, unknown> | undefined;
  if (d && typeof d === "object") {
    const lo = int(d.minMs, 10_000) ?? 0;
    const hi = Math.max(lo, int(d.maxMs, 10_000) ?? lo);
    if (hi > 0) out.delay = { minMs: lo, maxMs: hi };
  }
  const ds = int(o.delaySeed, 2 ** 31);
  if (ds !== undefined) out.delaySeed = ds;
  const mh = int(o.maxHoldMs, 30_000);
  if (mh !== undefined) out.maxHoldMs = Math.max(50, mh);
  const gap = int(o.gapMs, 1000);
  if (gap !== undefined) out.gapMs = gap;
  if (typeof o.id === "string" && o.id.length <= 100) out.id = o.id;
  if (typeof o.label === "string" && o.label.length <= 200) out.label = o.label;
  return out;
}

/** One key is the other followed by "~" (a retry or hedge of it): the same request's chain. */
function sameChain(a: string, b: string): boolean {
  return a.length < b.length ? b.charCodeAt(a.length) === 126 && b.startsWith(a) : a.length > b.length && a.charCodeAt(b.length) === 126 && a.startsWith(b);
}

/** The request being scheduled (an OpRec of kind fetch/xhr, as far as the scheduler reads it). */
export interface SchedOp {
  id: number;
  name: string;
  start: number;
  /** 1 for the first try; a GenClass retry is 2, 3, ... */
  attempt?: number;
  /** The op that was ambient when this one started (a hedge's is the request it hedges). */
  cause?: number;
}

/** One request this page load: its key and where its response is. */
export interface Slot {
  op: SchedOp;
  /** "GET /api/search#3": signature and occurrence (1-based) in this page load; retries and hedges add a suffix. */
  key: string;
  /** Start index: the request's 0-based position among this page load's requests, in start order. */
  n: number;
  /** Seeded or ranked priority (higher goes first). */
  prio: number;
  /** When the response reached the delivery gate. */
  arrived?: number;
  /** When the schedule let it go (handed to the runtime's delivery path). */
  released?: number;
  /** When the app received it. */
  delivered?: number;
  /** The request ended without a delivery to schedule (failed, aborted, or passed without the gate). */
  done?: boolean;
  /** Released because its hold ran out, not because the schedule allowed it. */
  forced?: boolean;
  /** Released at once without scheduling (pass(): a protected request, a route in mode "off"). */
  pass?: boolean;
  go?: (landed: () => void) => void;
}

/** What the scheduler reports for each delivery (recording). */
export interface Delivered {
  key: string;
  op: number;
  /** When the app received it. */
  at: number;
  /** How long the schedule held it (arrival to release). */
  heldMs: number;
  forced: boolean;
  /** When it was ready: its arrival at the gate plus its emulated delay (a passed response: its arrival). */
  ready?: number;
  /** Released at once without scheduling (a protected request, a route in mode "off"). */
  pass?: boolean;
}

/**
 * Holds response deliveries and releases them in the schedule's order. `gate(op, go)` is called at the runtime's
 * delivery gate; `go(landed)` hands the response to the runtime's own delivery path, which calls `landed` when the app
 * receives it. While `spec` is null the schedule is not known yet (the bridge has not answered): deliveries wait, at
 * most `pendingMs` from creation. Never throws into its caller.
 */
export class Scheduler {
  private readonly slots = new Map<number, Slot>();
  private readonly counts = new Map<string, number>();
  private readonly deliveredKeys = new Set<string>();
  private readonly doneKeys = new Set<string>();
  private rank = new Map<string, number>();
  private pendingUntil: number;
  private lastRelease = -Infinity;
  private gapTimer: unknown = null;
  private wakeTimer: unknown = null;
  private pumping = false;
  private again = false;
  private disposed = false;
  private nStarted = 0;
  forced = 0;

  constructor(
    private readonly clock: Clock,
    private spec: ScheduleSpec | null,
    private readonly onDeliver: (d: Delivered) => void,
    pendingMs = 600,
  ) {
    this.pendingUntil = clock.now() + pendingMs;
    if (spec) this.setSpec(spec);
    else this.clock.setTimeout(() => this.pump(), pendingMs + 1);
  }

  get current(): ScheduleSpec | null {
    return this.spec;
  }

  /** The schedule arrived (or changed). Held deliveries are re-evaluated at once. */
  setSpec(spec: ScheduleSpec): void {
    this.spec = spec;
    this.rank = new Map((spec.order === "given" ? spec.given : spec.order === "ranked" ? spec.ranks : undefined)?.map((k, i) => [k, i]) ?? []);
    for (const s of this.slots.values()) s.prio = this.prioOf(s.key, s.op.id);
    this.pump();
  }

  /** A request started (fetch/xhr): its key and start index are assigned now, in start order. */
  started(op: SchedOp): Slot {
    let s = this.slots.get(op.id);
    if (s) return s;
    let key: string;
    const parent = op.cause !== undefined ? this.slots.get(op.cause) : undefined;
    if (parent && parent.op.name === op.name) key = `${parent.key}~${(op.attempt ?? 1) > (parent.op.attempt ?? 1) ? `retry${op.attempt}` : "hedge"}`;
    else if ((op.attempt ?? 1) > 1) key = `${op.name}#${this.counts.get(op.name) ?? 0}~retry${op.attempt}`;
    else {
      const n = (this.counts.get(op.name) ?? 0) + 1;
      this.counts.set(op.name, n);
      key = `${op.name}#${n}`;
    }
    s = { op, key, n: this.nStarted++, prio: this.prioOf(key, op.id) };
    this.slots.set(op.id, s);
    if (this.slots.size > 4000) this.prune();
    return s;
  }

  slot(id: number | null | undefined): Slot | undefined {
    return id === undefined || id === null ? undefined : this.slots.get(id);
  }

  /** A response reached the delivery gate. `go(landed)` delivers it; called exactly once (now or later). */
  gate(op: SchedOp, go: (landed: () => void) => void): void {
    const s = this.started(op);
    if (s.go || s.released !== undefined) return this.call(go, () => undefined); // a second delivery of one op: pass
    s.arrived = this.clock.now();
    s.go = go;
    const spec = this.spec;
    if (spec && spec.order === "natural" && !spec.delay) return this.release(s, false);
    this.pump();
  }

  /** A response the schedule must not hold (a protected request): delivered at once, recorded like the others. */
  pass(op: SchedOp, go: (landed: () => void) => void): void {
    const s = this.started(op);
    if (s.go || s.released !== undefined) return this.call(go, () => undefined);
    s.arrived = this.clock.now();
    s.go = go;
    s.pass = true;
    this.release(s, false);
  }

  /** The app received a response the schedule released. */
  landed(id: number): void {
    const s = this.slots.get(id);
    if (!s || s.delivered !== undefined) return;
    const now = this.clock.now();
    s.delivered = now;
    this.deliveredKeys.add(s.key);
    try {
      const arrived = s.arrived ?? now;
      const d: Delivered = { key: s.key, op: s.op.id, at: now, heldMs: (s.released ?? now) - arrived, forced: !!s.forced, ready: s.pass ? arrived : this.readyOf(s) };
      if (s.pass) d.pass = true;
      this.onDeliver(d);
    } catch {
      /* recording never blocks a delivery */
    }
    this.pump();
  }

  /**
   * A request ended without a delivery to schedule (failed, aborted, answered elsewhere), or its held response was
   * dropped by the app (an XHR aborted while held): it stops blocking others and is never recorded as delivered.
   */
  ended(id: number): void {
    const s = this.slots.get(id);
    if (!s || s.delivered !== undefined || s.done) return;
    if (s.released !== undefined) return; // in the runtime's delivery path: it lands or not on its own
    s.done = true;
    this.doneKeys.add(s.key);
    const go = s.go;
    if (go) {
      // let the runtime finish its own bookkeeping for the dropped response (its release is a no-op by then)
      s.go = undefined;
      s.released = this.clock.now();
      this.call(go, () => undefined);
    }
    this.pump();
  }

  /** Responses waiting at the gate. */
  held(): Slot[] {
    return [...this.slots.values()].filter((s) => s.go && s.released === undefined);
  }

  /** Deliver everything now (disconnect, destroy). */
  dispose(): void {
    this.disposed = true;
    for (const t of [this.gapTimer, this.wakeTimer]) if (t !== null) this.clock.clearTimeout(t);
    this.gapTimer = this.wakeTimer = null;
    for (const s of this.held().sort((a, b) => a.op.id - b.op.id)) this.release(s, false);
  }

  private prioOf(key: string, id: number): number {
    const spec = this.spec;
    if (spec?.order === "ranked") {
      // listed keys above every unlisted one; unlisted ones in request order
      const r = this.rank.get(key);
      return r === undefined ? -id : 2 ** 34 - r;
    }
    if (!spec || spec.order !== "seeded") return -id;
    const base = key.slice(0, key.lastIndexOf("#"));
    const focus = spec.focus?.includes(base) ? 0 : 2 ** 32;
    const h = hash32(`${spec.seed ?? 1}|${key}`);
    return focus + (spec.reverse ? 0xffffffff - h : h);
  }

  private delayOf(key: string): number {
    const spec = this.spec;
    const d = spec?.delay;
    if (!d) return 0;
    const span = d.maxMs - d.minMs;
    return d.minMs + (span > 0 ? hash32(`${spec.delaySeed ?? spec.seed ?? 0}|delay|${key}`) % (span + 1) : 0);
  }

  private holdOf(): number {
    return this.spec?.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  }

  /** When a response is ready to deliver: its arrival at the gate plus its emulated delay. */
  private readyOf(s: Slot): number {
    return (s.arrived ?? this.clock.now()) + this.delayOf(s.key);
  }

  /** When a held response is released whatever the schedule says: when it was ready, plus maxHoldMs. */
  private deadlineOf(s: Slot): number {
    return this.readyOf(s) + this.holdOf();
  }

  /** Does `o` keep later responses waiting? Not once done, delivered, long-running, or stuck in the runtime's path. */
  private blocks(o: Slot, now: number): boolean {
    if (o.done || o.delivered !== undefined || now - o.op.start >= LONG_RUNNING_MS) return false;
    return o.released === undefined || now - o.released < this.holdOf();
  }

  /** May this held response be delivered now? `forced` when only the hold limit allows it. */
  private verdict(s: Slot, now: number): "go" | "wait" | "forced" {
    const spec = this.spec;
    if (this.disposed || now - s.op.start >= LONG_RUNNING_MS) return "go";
    const hold = this.holdOf();
    const arrived = s.arrived ?? now;
    if (!spec) return now >= this.pendingUntil ? "go" : now - arrived >= hold ? "forced" : "wait";
    // a response's own delay is the slow network it emulates: it never counts against the hold limit
    const d = this.delayOf(s.key);
    if (now - arrived < d) return "wait";
    const timedOut = now - arrived - d >= hold;
    const order = spec.order;
    let blocked = false;
    if (order === "fifo" || order === "seeded" || order === "lifo" || order === "ranked") {
      const ready = arrived + d;
      for (const o of this.slots.values()) {
        if (o === s || !this.blocks(o, now)) continue;
        let ahead: boolean;
        if (order === "fifo") ahead = o.op.start < s.op.start || (o.op.start === s.op.start && o.op.id < s.op.id);
        else if (order === "seeded") ahead = o.prio > s.prio;
        // lifo, ranked: only a request that started before this response was ready holds it back (strictly: one that a
        // released response's handler sent at that very instant does not); never a hedge, never its own chain
        else
          ahead =
            o.op.start < ready &&
            (order === "lifo" ? o.op.start > s.op.start || (o.op.start === s.op.start && o.op.id > s.op.id) : o.prio > s.prio) &&
            !o.key.includes("~hedge") &&
            !sameChain(o.key, s.key);
        if (ahead) {
          blocked = true;
          break;
        }
      }
    } else if (order === "given") {
      const r = this.rank.get(s.key);
      if (r !== undefined) {
        const given = spec.given ?? [];
        const byKey = new Map<string, Slot>();
        for (const o of this.slots.values()) byKey.set(o.key, o);
        for (let i = 0; i < r; i++) {
          const k = given[i];
          if (this.deliveredKeys.has(k) || this.doneKeys.has(k)) continue;
          const o = byKey.get(k);
          if (o && !this.blocks(o, now)) continue;
          blocked = true;
          break;
        }
      }
    }
    if (!blocked) return "go";
    return timedOut ? "forced" : "wait";
  }

  /** When should a held response be looked at again: its delay ends, else its deadline (pending: the hello's limit)? */
  private dueOf(s: Slot, now: number): number {
    const arrived = s.arrived ?? now;
    if (!this.spec) return Math.min(this.pendingUntil, arrived + this.holdOf());
    const d = this.delayOf(s.key);
    return arrived + d > now ? arrived + d : arrived + d + this.holdOf();
  }

  /** Which of two responses that may overlap the schedule delivers first. */
  private before(a: Slot, b: Slot): number {
    const order = this.spec?.order;
    if (order === "given") return (this.rank.get(a.key) ?? 1e9) - (this.rank.get(b.key) ?? 1e9) || a.op.id - b.op.id;
    if (order === "seeded" || order === "ranked") return b.prio - a.prio;
    if (order === "fifo") return a.op.start - b.op.start || a.op.id - b.op.id;
    if (order === "lifo") return b.op.start - a.op.start || b.op.id - a.op.id;
    return (a.arrived ?? 0) - (b.arrived ?? 0);
  }

  /** Release what may go: first whatever reached its deadline, then one at a time, `gapMs` apart; re-arm a wake-up. */
  private pump(): void {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        this.pumpOnce();
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }

  private pumpOnce(): void {
    const now = this.clock.now();
    // the hold limit binds: a response whose deadline has come goes now, without waiting for the gap, earliest arrival
    // first; forced only when the schedule still held it back (one that only waited for the gap followed it)
    const over = this.held().filter((s) => now >= this.deadlineOf(s));
    over.sort((a, b) => (a.arrived ?? 0) - (b.arrived ?? 0) || this.before(a, b));
    for (const s of over) if (s.go && s.released === undefined) this.release(s, this.verdict(s, now) === "forced");
    const held = this.held();
    // every held response has a wake-up of its own (the clock may fire a timer a little early by its measure)
    let due = Infinity;
    for (const s of held) due = Math.min(due, this.dueOf(s, now));
    if (this.wakeTimer !== null) this.clock.clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (due < Infinity)
      this.wakeTimer = this.clock.setTimeout(() => {
        this.wakeTimer = null;
        this.pump();
      }, Math.max(1, due - now + 1));
    if (this.gapTimer !== null) return;
    // past their deadlines none is left: these are "go" or "wait"
    const ready = held.filter((s) => this.verdict(s, now) !== "wait");
    if (!ready.length) return;
    const spec = this.spec;
    const order = spec?.order;
    // lifo and ranked: two responses that may both go do not overlap, so the one ready first goes first
    if (order === "lifo" || order === "ranked") ready.sort((a, b) => this.readyOf(a) - this.readyOf(b) || a.op.id - b.op.id);
    else ready.sort((a, b) => this.before(a, b));
    const gap = this.disposed || !spec || order === "natural" ? 0 : spec.gapMs ?? DEFAULT_GAP_MS;
    const wait = this.lastRelease + gap - now;
    if (gap > 0 && wait > 0) {
      this.gapTimer = this.clock.setTimeout(() => {
        this.gapTimer = null;
        this.pump();
      }, wait);
      return;
    }
    if (gap === 0) {
      for (const s of ready) if (s.released === undefined) this.release(s, false);
      return;
    }
    this.release(ready[0], false);
    if (this.held().length && this.gapTimer === null)
      this.gapTimer = this.clock.setTimeout(() => {
        this.gapTimer = null;
        this.pump();
      }, gap);
  }

  private release(s: Slot, forced: boolean): void {
    if (s.released !== undefined || !s.go) return;
    const now = this.clock.now();
    s.released = now;
    s.forced = forced;
    if (forced) this.forced++;
    this.lastRelease = now;
    const go = s.go;
    const id = s.op.id;
    this.call(go, () => this.landed(id));
  }

  /** Run the runtime's delivery; an app handler that throws is rethrown on its own task, never into the scheduler. */
  private call(go: (landed: () => void) => void, landed: () => void): void {
    try {
      go(landed);
    } catch (e) {
      this.clock.setTimeout(() => {
        throw e;
      }, 0);
    }
  }

  private prune(): void {
    for (const [id, s] of this.slots) {
      if (this.slots.size <= 3000) break;
      if (s.delivered !== undefined || s.done) this.slots.delete(id);
    }
  }
}
