// Seeded network chaos for the GenClass Playwright fixture: which responses to slow down, by how much, and whether
// they may overtake each other, every value derived from a seed so that a run repeats exactly. Pure: no Playwright,
// no I/O, no clock of its own (the scheduler takes its timers from the caller, so tests drive it by hand). The fixture
// (install.ts) applies the plan with page.route: it holds each matched request for the planned time, then lets it go on
// its way (route.fallback), the way a slow uplink would. The request still goes through the user's own routes, the
// browser's network stack and its cache, so nothing is dropped, changed, buffered or invented; requests outside the
// filter are never held, and the runtime's own files (served on RUNTIME_PATH) never are.
//
// Determinism: a matched request is keyed, when the page sends it, by its method, path and occurrence in the test
// ("GET /api/search#3"), and its delay is read from a small PRNG seeded by the chaos seed and that key. The same test
// under the same seed gives the same delays whatever the wall clock or the server does.
//
// Orders. By default (`order: "random"`) every repeat gets seeded delays. With `order: "systematic"` Playwright's
// repeat index picks the order instead: repeat 0 natural (nothing held: the baseline), repeat 1 reverse (matched
// requests are collected into bursts, held, and released newest first, 30 ms apart; a burst starts at a matched
// request and ends at `windowMs` or 100 ms after its latest request, whichever comes first; a burst of one leaves as
// soon as it ends; each request is held at most `windowMs` + 1000 ms), repeat 2 and later the seeded delays of the
// default. The reverse order depends on when the page sends its requests, not on the wall clock: the same request
// timing gives the same bursts and the same release order. Every hold is bounded and released by dispose().

import type { RaceBurst, RaceChaosOrder } from "./types.js";

/** Where install.ts serves the runtime's dist/ on the page's origin. Chaos never applies to it. */
export const RUNTIME_PATH = "/__genclass__/";
/** The largest extra latency the fixture applies, in ms (a hold must stay bounded). */
export const MAX_DELAY_MS = 10_000;
/** The default `delayMs` when `chaos` is given without one. */
export const DEFAULT_DELAY_MS: readonly [number, number] = [0, 600];
/** The default seed (the fixture adds Playwright's `repeatEachIndex` to it). */
export const DEFAULT_SEED = 1;
/**
 * With `reorder: false`: the least time between two releases, so the page has handled one request's response before
 * the next request leaves (the runtime's agent schedules use the same 30 ms, DEFAULT_GAP_MS). The reverse order
 * releases a burst with the same gap.
 */
export const FIFO_GAP_MS = 30;
/** The reverse order's default `windowMs`: the longest a burst of matched requests is collected before release. */
export const DEFAULT_WINDOW_MS = 600;
/** The reverse order: a burst also ends this long after its latest matched request. */
export const BURST_QUIET_MS = 100;
/** The reverse order: a request is held at most `windowMs` plus this. */
export const BURST_HOLD_SLACK_MS = 1000;

/** The order one repeat runs in with `order: "systematic"` (repeat 0 natural, 1 reverse, 2 and later seeded). */
export type ChaosOrder = RaceChaosOrder;

/** A request as the filter sees it, before its response is fetched. */
export interface ChaosRequest {
  url: string;
  method: string;
  /** Playwright's resource type; only "fetch" and "xhr" are ever candidates. */
  resourceType: string;
  /** Same origin as the document that sent it. */
  sameOrigin: boolean;
  /** The request's Accept header, when it has one. */
  accept?: string;
}

export type ChaosMatchFn = (r: ChaosRequest) => boolean;
/**
 * Which requests get chaos: a string (a path prefix such as "/api", or a URL prefix such as "https://api.example.com/"),
 * a RegExp tested against the full URL, a function, or a list of those (any match counts). Unset: same-origin
 * requests whose path starts with /api or whose Accept header asks for JSON.
 */
export type ChaosMatch = string | RegExp | ChaosMatchFn | readonly (string | RegExp | ChaosMatchFn)[];

export interface ChaosOptions {
  /** Every delay is derived from it. Default 1; with `repeatEach`, the fixture adds the repeat index. */
  seed?: number;
  /** Extra latency per matched response, uniform in [min, max] ms. Default [0, 600]; at most 10000. */
  delayMs?: readonly [number, number];
  /**
   * false: matched requests leave in the order the page sent them, at least 30 ms apart (latency only: with a server
   * that answers in order, nothing overtakes). Default true.
   */
  reorder?: boolean;
  /** Which requests (see ChaosMatch). Default: same-origin, path /api* or an Accept header that asks for JSON. */
  match?: ChaosMatch;
  /**
   * "random" (default): seeded delays in every repeat. "systematic": the repeat index picks the order: repeat 0
   * natural (nothing held), repeat 1 reverse (each burst of matched requests released newest first), repeat 2 and
   * later seeded delays as with "random". Needs `repeatEach` of 3 or more for all three; refused with `reorder: false`.
   */
  order?: "random" | "systematic";
  /**
   * The reverse order (`order: "systematic"`, repeat 1): a burst ends this long after its first matched request, or
   * 100 ms after its latest, whichever comes first; each request is held at most this plus 1000 ms. Default 600, at
   * most 10000.
   */
  windowMs?: number;
}

export interface ResolvedChaos {
  seed: number;
  delayMs: [number, number];
  reorder: boolean;
  match: ChaosMatch | undefined;
  /** Only with `order: "systematic"`: this repeat's order. Absent: seeded delays (the default). */
  order?: ChaosOrder;
  /** Only with `order: "systematic"`: the reverse order's burst window, ms. */
  windowMs?: number;
}

/** One matched request: its key and the latency the seed gives it (0 in the reverse order, where bursts decide). */
export interface ChaosPlan {
  key: string;
  delayMs: number;
}

/** One burst of the reverse order: its request keys in the order sent, then in the order released. */
export type ChaosBurst = RaceBurst;

/** 32-bit FNV-1a with a murmur3 finaliser (the same hash the runtime's agent schedules use). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The latency for one key under a seed: uniform in [min, max], the same for the same seed and key. */
export function delayFor(seed: number, key: string, delayMs: readonly [number, number]): number {
  const [min, max] = delayMs;
  if (max <= min) return min;
  const r = mulberry32(hash32(`${seed}|${key}`))();
  return Math.min(max, min + Math.floor(r * (max - min + 1)));
}

function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

/** The order a repeat runs in with `order: "systematic"`: 0 natural, 1 reverse, 2 and later seeded. */
export function systematicOrder(repeat: number): ChaosOrder {
  const r = Math.max(0, int(repeat, 0));
  return r === 0 ? "natural" : r === 1 ? "reverse" : "seeded";
}

/**
 * Fills in the defaults and bounds the values. `true` means the defaults. `seedOffset` is the repeat index (added to
 * the seed; with `order: "systematic"` it also picks the order). Throws on a `match` of the wrong type, an unknown
 * `order`, and `order: "systematic"` with `reorder: false`.
 */
export function resolveChaos(o: ChaosOptions | true | undefined | null, seedOffset = 0): ResolvedChaos {
  const c: ChaosOptions = o === true || !o ? {} : o;
  const d = c.delayMs;
  let min = DEFAULT_DELAY_MS[0];
  let max = DEFAULT_DELAY_MS[1];
  if (Array.isArray(d) && d.length === 2) {
    min = Math.min(MAX_DELAY_MS, int(d[0], 0));
    max = Math.min(MAX_DELAY_MS, Math.max(min, int(d[1], min)));
  } else if (d !== undefined) throw new TypeError(`@genclass/playwright: chaos.delayMs must be [min, max] in ms, got ${JSON.stringify(d)}`);
  if (c.match !== undefined && !isMatch(c.match)) throw new TypeError("@genclass/playwright: chaos.match must be a string, a RegExp, a function, or a list of those");
  if (c.order !== undefined && c.order !== "random" && c.order !== "systematic") throw new TypeError(`@genclass/playwright: chaos.order must be "random" or "systematic", got ${JSON.stringify(c.order)}`);
  const out: ResolvedChaos = { seed: int(c.seed, DEFAULT_SEED) + Math.max(0, int(seedOffset, 0)), delayMs: [min, max], reorder: c.reorder !== false, match: c.match };
  if (c.order === "systematic") {
    // the systematic orders reorder by design: latency only (reorder: false) would make them a contradiction
    if (c.reorder === false) throw new TypeError('@genclass/playwright: chaos.order "systematic" reorders by design and cannot be combined with reorder: false');
    out.order = systematicOrder(seedOffset);
    out.windowMs = Math.min(MAX_DELAY_MS, int(c.windowMs, DEFAULT_WINDOW_MS));
  }
  return out;
}

function isMatch(m: unknown): m is ChaosMatch {
  if (Array.isArray(m)) return m.every((x) => typeof x === "string" || x instanceof RegExp || typeof x === "function");
  return typeof m === "string" || m instanceof RegExp || typeof m === "function";
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** True for the runtime's own files (never chaos, whatever the filter says). */
export function isRuntimeUrl(url: string): boolean {
  return pathOf(url).startsWith(RUNTIME_PATH);
}

function matchesOne(m: string | RegExp | ChaosMatchFn, r: ChaosRequest): boolean {
  if (typeof m === "function") return m(r) === true;
  if (m instanceof RegExp) {
    m.lastIndex = 0;
    return m.test(r.url);
  }
  return m.startsWith("/") ? pathOf(r.url).startsWith(m) : r.url.startsWith(m);
}

/**
 * Whether a request gets chaos, decided from the request alone before it is sent. Only fetch and XHR requests, never
 * the runtime's files. With a `match`, the filter decides; without one, same-origin requests whose path starts with
 * /api or whose Accept header asks for JSON.
 */
export function isCandidate(r: ChaosRequest, match: ChaosMatch | undefined): boolean {
  if (r.resourceType !== "fetch" && r.resourceType !== "xhr") return false;
  if (isRuntimeUrl(r.url)) return false;
  if (match === undefined) return r.sameOrigin && (pathOf(r.url).startsWith("/api") || /json/i.test(r.accept ?? ""));
  const list = Array.isArray(match) ? (match as readonly (string | RegExp | ChaosMatchFn)[]) : [match as string | RegExp | ChaosMatchFn];
  return list.some((m) => matchesOne(m, r));
}

/** The filter as written to the race file's `chaos.routes` (functions as "function", RegExps as their source). */
export function describeMatch(match: ChaosMatch | undefined): unknown[] {
  if (match === undefined) return ["same-origin /api* or Accept: json"];
  const list = Array.isArray(match) ? (match as readonly (string | RegExp | ChaosMatchFn)[]) : [match as string | RegExp | ChaosMatchFn];
  return list.map((m) => (typeof m === "function" ? "function" : m instanceof RegExp ? String(m) : m));
}

/** The timers the scheduler holds with (the globals by default; a test passes its own). */
export interface ChaosTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realTimers: ChaosTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** A request the reverse order holds, and the burst it belongs to. */
interface BurstHold {
  key: string;
  released: boolean;
  resolve: () => void;
  cap: unknown;
  burst: OpenBurst;
}

/** A burst of the reverse order while its requests are held. */
interface OpenBurst {
  rec: ChaosBurst;
  held: BurstHold[];
  quiet: unknown;
  window: unknown;
  closed: boolean;
}

/**
 * Assigns each matched request its key and latency when the page sends it, and holds it: for its own delay, and with
 * `reorder` off also until FIFO_GAP_MS after the earlier matched request was released, so requests leave in the
 * order they were sent. In the reverse order it holds each request in its burst instead and releases the burst
 * newest first; in the natural order it holds nothing (`holding` is false). `dispose()` releases every hold at once
 * (the page is gone). Never throws.
 */
export class ChaosScheduler {
  private readonly counts = new Map<string, number>();
  private last: Promise<void> = Promise.resolve();
  private readonly pending = new Map<unknown, () => void>();
  private disposed = false;
  private chained = 0;
  /** Every plan made so far, in request order (for the race file and tests). */
  readonly plans: ChaosPlan[] = [];
  /** The reverse order: every burst so far, its keys in the order sent and in the order released. */
  readonly bursts: ChaosBurst[] = [];
  private open: OpenBurst | null = null;
  /** The reverse order: requests still held, in the order they arrived. */
  private readonly unreleased = new Set<BurstHold>();
  /** The reverse order: its timers (bursts, release steps, hold caps), cleared by dispose(). */
  private readonly burstTimers = new Set<unknown>();

  constructor(
    readonly chaos: ResolvedChaos,
    private readonly timers: ChaosTimers = realTimers,
  ) {}

  /** False in the natural order (`order: "systematic"`, repeat 0): no request is planned or held. */
  get holding(): boolean {
    return this.chaos.order !== "natural";
  }

  /**
   * The key ("GET /api/search#3": method, path, occurrence in this test) and latency of a matched request. A
   * cross-origin request is keyed by host name and path, without the port, so a backend on a random port keeps its
   * delays under the same seed.
   */
  plan(method: string, url: string, sameOrigin = true): ChaosPlan {
    let where: string;
    try {
      const u = new URL(url);
      where = sameOrigin ? u.pathname : `${u.hostname}${u.pathname}`;
    } catch {
      where = url;
    }
    const sig = `${method.toUpperCase()} ${where}`;
    const n = (this.counts.get(sig) ?? 0) + 1;
    this.counts.set(sig, n);
    const key = `${sig}#${n}`;
    const p = { key, delayMs: this.chaos.order === "reverse" ? 0 : delayFor(this.chaos.seed, key, this.chaos.delayMs) };
    this.plans.push(p);
    return p;
  }

  /** Resolves when the request may leave. Call it in the order the page sent the requests (route handlers are). */
  hold(plan: ChaosPlan): Promise<void> {
    if (this.chaos.order === "natural") return Promise.resolve();
    if (this.chaos.order === "reverse") return this.holdInBurst(plan);
    const own = this.sleep(plan.delayMs);
    if (this.chaos.reorder) return own;
    const first = this.chained === 0;
    this.chained++;
    const after = first ? this.last : this.last.then(() => this.sleep(FIFO_GAP_MS));
    const mine = Promise.all([after, own]).then(() => undefined);
    this.last = mine;
    return mine;
  }

  /** Release every held request now and stop the timers. */
  dispose(): void {
    this.disposed = true;
    for (const [id, release] of this.pending) {
      try {
        this.timers.clearTimeout(id);
      } catch {
        /* ignore */
      }
      release();
    }
    this.pending.clear();
    // the reverse order: what is still held leaves now, newest first
    for (const id of this.burstTimers) {
      try {
        this.timers.clearTimeout(id);
      } catch {
        /* ignore */
      }
    }
    this.burstTimers.clear();
    for (const h of [...this.unreleased].reverse()) this.release(h);
    this.open = null;
  }

  /**
   * The reverse order: the request joins the open burst (whose quiet time starts again) or opens one, and is held
   * until the burst is released, at most windowMs + BURST_HOLD_SLACK_MS.
   */
  private holdInBurst(plan: ChaosPlan): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const windowMs = this.chaos.windowMs ?? DEFAULT_WINDOW_MS;
    return new Promise<void>((resolve) => {
      let b = this.open;
      if (b) {
        this.clear(b.quiet);
        const open = b;
        b.quiet = this.after(BURST_QUIET_MS, () => this.close(open));
      } else {
        const rec: ChaosBurst = { keys: [], released: [] };
        this.bursts.push(rec);
        const open: OpenBurst = { rec, held: [], quiet: null, window: null, closed: false };
        this.open = b = open;
        open.quiet = this.after(BURST_QUIET_MS, () => this.close(open));
        open.window = this.after(windowMs, () => this.close(open));
      }
      const h: BurstHold = { key: plan.key, released: false, resolve, cap: null, burst: b };
      b.held.push(h);
      b.rec.keys.push(plan.key);
      this.unreleased.add(h);
      h.cap = this.after(windowMs + BURST_HOLD_SLACK_MS, () => this.release(h));
    });
  }

  /** A burst ends: a lone request leaves at once; more leave newest first, FIFO_GAP_MS apart. */
  private close(b: OpenBurst): void {
    if (b.closed) return;
    b.closed = true;
    if (this.open === b) this.open = null;
    this.clear(b.quiet);
    this.clear(b.window);
    const order = b.held.filter((h) => !h.released).reverse();
    if (order.length <= 1) {
      for (const h of order) this.release(h);
      return;
    }
    let i = 0;
    const step = (): void => {
      // a request whose hold ran out (or that dispose let go) has left already: skip it without a gap
      while (i < order.length && order[i].released) i++;
      if (i >= order.length) return;
      this.release(order[i++]);
      if (order.slice(i).some((h) => !h.released)) this.after(FIFO_GAP_MS, step);
    };
    step();
  }

  private release(h: BurstHold): void {
    if (h.released) return;
    h.released = true;
    this.clear(h.cap);
    this.unreleased.delete(h);
    h.burst.rec.released.push(h.key);
    try {
      h.resolve();
    } catch {
      /* ignore */
    }
  }

  /** A timer of the reverse order. If the timers refuse, the callback runs on the next microtask (nothing stays held). */
  private after(ms: number, fn: () => void): unknown {
    let id: unknown = null;
    const run = (): void => {
      this.burstTimers.delete(id);
      fn();
    };
    try {
      id = this.timers.setTimeout(run, Math.max(0, ms));
      this.burstTimers.add(id);
    } catch {
      void Promise.resolve().then(fn);
    }
    return id;
  }

  private clear(id: unknown): void {
    if (id === null || id === undefined) return;
    this.burstTimers.delete(id);
    try {
      this.timers.clearTimeout(id);
    } catch {
      /* ignore */
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.disposed || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let id: unknown = null;
      const release = () => {
        if (id !== null) this.pending.delete(id);
        resolve();
      };
      try {
        id = this.timers.setTimeout(release, ms);
        this.pending.set(id, release);
      } catch {
        resolve();
      }
    });
  }
}
