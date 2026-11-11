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
// Requests that say the same thing keep their order. Holding a request back is not what a network does to an answer:
// it changes which of two requests the server answers first. For two requests with the same method, URL and body (two
// polls, two "+1" clicks) that would make the one sent first come back with the newer answer, and what the runtime then
// records, the older request's response written over the newer one's, would be newer data over older. So identical
// requests are delayed but never swapped: one leaves only after the identical one before it has left. The same holds
// for two writes to one path, whatever their bodies (orderKey): swapped on the way out, two notes are stored in the
// other order and an older save of a form is the one the server keeps, which is the test changing the server's data,
// not a slow answer. Reads that differ (another query, another id) are still free to overtake each other, which is
// the case a held request models faithfully: the answer to the older question arriving last.
//
// Seeds come in pairs (1 and 2, 3 and 4, ...): the even seed gives every key the mirror image of the odd seed's delay
// (min + max - delay). Of two requests, the one the odd seed holds longer is the one the even seed holds shorter, so
// two seeds in a row try each pair of requests in both orders unless their delays are closer than the time between
// them, where two unrelated seeds try the same order twice about half the time. `mirror: false` gives every seed
// delays of its own, as 0.1.0 did.

/** Where install.ts serves the runtime's dist/ on the page's origin. Chaos never applies to it. */
export const RUNTIME_PATH = "/__genclass__/";
/** The largest extra latency the fixture applies, in ms (a hold must stay bounded). */
export const MAX_DELAY_MS = 10_000;
/**
 * The longest end-of-test wait for responses that may be asked for, in ms (session.ts waitOf; here so that env.ts,
 * which reads it from the environment, imports nothing but this pure module).
 */
export const MAX_WAIT_MS = 30_000;
/** The default `delayMs` when `chaos` is given without one. */
export const DEFAULT_DELAY_MS: readonly [number, number] = [0, 600];
/** The default seed (the fixture adds Playwright's `repeatEachIndex` to it). */
export const DEFAULT_SEED = 1;
/**
 * With `reorder: false`: the least time between two releases, so the page has handled one request's response before
 * the next request leaves (the runtime's agent schedules use the same 30 ms, DEFAULT_GAP_MS).
 */
export const FIFO_GAP_MS = 30;

/** A request as the filter sees it, before its response is fetched. */
export interface ChaosRequest {
  url: string;
  method: string;
  /** Playwright's resource type; only "fetch" and "xhr" are ever candidates. */
  resourceType: string;
  /** Same origin as the document that sent it. */
  sameOrigin: boolean;
  /**
   * Same host name as the document that sent it, whatever the port or scheme: the app's own back end as it runs
   * beside a dev server or in CI (the page on localhost:3000, the API on localhost:8080). Unset counts as false.
   */
  sameHost?: boolean;
  /** The request's Accept header, when it has one. */
  accept?: string;
}

export type ChaosMatchFn = (r: ChaosRequest) => boolean;
/**
 * Which requests get chaos: a string (a path prefix such as "/api", or a URL prefix such as "https://api.example.com/"),
 * a RegExp tested against the full URL, a function, or a list of those (any match counts). Unset: requests to the
 * page's own host (any port) whose path starts with /api or whose Accept header asks for JSON.
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
  /** Which requests (see ChaosMatch). Default: the page's own host (any port), path /api* or an Accept header that asks for JSON. */
  match?: ChaosMatch;
  /**
   * true (default): an even seed gives each request the mirror image of the delay the odd seed before it gives
   * (min + max - delay), so seeds 1 and 2 try each pair of requests in both orders. false: every seed has delays of
   * its own (what 0.1.0 did).
   */
  mirror?: boolean;
}

export interface ResolvedChaos {
  seed: number;
  delayMs: [number, number];
  reorder: boolean;
  match: ChaosMatch | undefined;
  mirror: boolean;
}

/** One matched request: its key and the latency the seed gives it. */
export interface ChaosPlan {
  key: string;
  delayMs: number;
}

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

/**
 * The latency for one key under a seed: uniform in [min, max], the same for the same seed and key. With `mirror`
 * (the default), an even seed from 2 gives the mirror image of what the seed before it gives: min + max - that delay.
 */
export function delayFor(seed: number, key: string, delayMs: readonly [number, number], mirror = true): number {
  const [min, max] = delayMs;
  if (max <= min) return min;
  if (mirror && seed >= 2 && seed % 2 === 0) return min + max - delayFor(seed - 1, key, delayMs, false);
  const r = mulberry32(hash32(`${seed}|${key}`))();
  return Math.min(max, min + Math.floor(r * (max - min + 1)));
}

function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

/** Fills in the defaults and bounds the values. `true` means the defaults. Throws on a `match` of the wrong type. */
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
  return { seed: int(c.seed, DEFAULT_SEED) + Math.max(0, int(seedOffset, 0)), delayMs: [min, max], reorder: c.reorder !== false, match: c.match, mirror: c.mirror !== false };
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
 * the runtime's files. With a `match`, the filter decides; without one, requests to the page's own host (its origin,
 * or the same host name on another port) whose path starts with /api or whose Accept header asks for JSON. An API on
 * another host name needs a `match`.
 */
export function isCandidate(r: ChaosRequest, match: ChaosMatch | undefined): boolean {
  if (r.resourceType !== "fetch" && r.resourceType !== "xhr") return false;
  if (isRuntimeUrl(r.url)) return false;
  if (match === undefined) return (r.sameOrigin || r.sameHost === true) && (pathOf(r.url).startsWith("/api") || /json/i.test(r.accept ?? ""));
  const list = Array.isArray(match) ? (match as readonly (string | RegExp | ChaosMatchFn)[]) : [match as string | RegExp | ChaosMatchFn];
  return list.some((m) => matchesOne(m, r));
}

/** The filter as written to the race file's `chaos.routes` (functions as "function", RegExps as their source). */
export function describeMatch(match: ChaosMatch | undefined): unknown[] {
  if (match === undefined) return ["same host /api* or Accept: json"];
  const list = Array.isArray(match) ? (match as readonly (string | RegExp | ChaosMatchFn)[]) : [match as string | RegExp | ChaosMatchFn];
  return list.map((m) => (typeof m === "function" ? "function" : m instanceof RegExp ? String(m) : m));
}

/**
 * What makes two requests the same request sent twice: the method, the whole URL (query included) and the body. The
 * body goes in as a hash, so nothing of it is kept.
 */
export function sameRequest(method: string, url: string, body: string | null | undefined): string {
  return `${method.toUpperCase()} ${url} ${body ? hash32(body).toString(36) : "-"}`;
}

/**
 * The key under which requests keep the order the page sent them in (ChaosScheduler.hold). For a request that changes
 * something (any method but GET, HEAD and OPTIONS): its method and URL without the query, so that two writes to one
 * path reach the server in the order they were made, whatever their bodies (two notes posted one after the other, the
 * saves of one form). For a read: sameRequest, so only an identical read waits for the one before it and two different
 * questions (another query, another id) stay free to overtake each other.
 */
export function orderKey(method: string, url: string, body: string | null | undefined): string {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return sameRequest(m, url, body);
  let where = url;
  try {
    const u = new URL(url);
    where = `${u.origin}${u.pathname}`;
  } catch {
    /* not a URL: the text as it is */
  }
  return `${m} ${where}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path with the segments that are ids written as ":id": all digits, a UUID, a hex string of 16 characters or more,
 * or a token of 12 characters or more that mixes letters and digits (a generated id such as a nanoid). Ids a test
 * creates differ from run to run; keyed by them, the same request would get another delay in every run and the even
 * seed would not mirror the odd one. Only the key uses this: the request itself is never touched.
 */
export function stablePath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      if (seg === "") return seg;
      if (/^\d+$/.test(seg) || UUID.test(seg) || /^[0-9a-f]{16,}$/i.test(seg)) return ":id";
      if (seg.length >= 12 && /^[A-Za-z0-9_-]+$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return ":id";
      return seg;
    })
    .join("/");
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

/**
 * Assigns each matched request its key and latency when the page sends it, and holds it: for its own delay, and with
 * `reorder` off also until FIFO_GAP_MS after the earlier matched request was released, so requests leave in the
 * order they were sent. `dispose()` releases every hold at once (the page is gone). Never throws.
 */
export class ChaosScheduler {
  private readonly counts = new Map<string, number>();
  private last: Promise<void> = Promise.resolve();
  private readonly pending = new Map<unknown, () => void>();
  private disposed = false;
  private paused = false;
  private chained = 0;
  /** By order key (orderKey): when the last request with that key leaves. */
  private readonly lastSame = new Map<string, Promise<void>>();
  /** Every plan made so far, in request order (for the race file and tests). */
  readonly plans: ChaosPlan[] = [];

  constructor(
    readonly chaos: ResolvedChaos,
    private readonly timers: ChaosTimers = realTimers,
  ) {}

  /**
   * The key ("GET /api/search#3": method, path, occurrence in this test) and latency of a matched request. A
   * cross-origin request is keyed by host name and path, without the port, so a backend on a random port keeps its
   * delays under the same seed. A path segment that is an id (stablePath) is keyed as ":id", so a record the test
   * created a moment ago, with another id in every run, keeps its delay too ("GET /api/discussions/:id#1").
   */
  plan(method: string, url: string, sameOrigin = true): ChaosPlan {
    let where: string;
    try {
      const u = new URL(url);
      const path = stablePath(u.pathname);
      where = sameOrigin ? path : `${u.hostname}${path}`;
    } catch {
      where = url;
    }
    const sig = `${method.toUpperCase()} ${where}`;
    const n = (this.counts.get(sig) ?? 0) + 1;
    this.counts.set(sig, n);
    const key = `${sig}#${n}`;
    const p = { key, delayMs: delayFor(this.chaos.seed, key, this.chaos.delayMs, this.chaos.mirror) };
    this.plans.push(p);
    return p;
  }

  /**
   * Resolves when the request may leave. Call it in the order the page sent the requests (route handlers are).
   * `same` is the request's order key (orderKey: an identical read, or a write to the same path): a request never
   * leaves before the request with the same key sent before it has left, FIFO_GAP_MS after it, whatever their delays,
   * so the server gets them in the order the page sent them. Without `same` only the request's own delay (and
   * `reorder: false`) holds it.
   */
  hold(plan: ChaosPlan, same?: string): Promise<void> {
    const own = this.sleep(plan.delayMs);
    let mine = own;
    if (!this.chaos.reorder) {
      const first = this.chained === 0;
      this.chained++;
      const after = first ? this.last : this.last.then(() => this.sleep(FIFO_GAP_MS));
      mine = Promise.all([after, own]).then(() => undefined);
      this.last = mine;
    }
    if (same !== undefined) {
      const before = this.lastSame.get(same);
      if (before) mine = Promise.all([mine, before.then(() => this.sleep(FIFO_GAP_MS))]).then(() => undefined);
      this.lastSame.set(same, mine);
    }
    return mine;
  }

  /**
   * The page has no network: every held request leaves now and none is held until resume(). A request sent while
   * offline fails at once; held until the network is back it would be sent and answered, and the test would see its
   * requests arrive in an order the app never made.
   */
  pause(): void {
    this.paused = true;
    this.releaseAll();
  }

  /** The network is back: requests are held again. */
  resume(): void {
    this.paused = false;
  }

  /** Release every held request now and stop the timers. */
  dispose(): void {
    this.disposed = true;
    this.releaseAll();
  }

  private releaseAll(): void {
    for (const [id, release] of this.pending) {
      try {
        this.timers.clearTimeout(id);
      } catch {
        /* ignore */
      }
      release();
    }
    this.pending.clear();
  }

  private sleep(ms: number): Promise<void> {
    if (this.disposed || this.paused || ms <= 0) return Promise.resolve();
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
