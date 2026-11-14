// The consent gate (InitOptions.consent, Runtime.consent; CONTRACT section 17, TELEMETRY.md "Consent"): while a part
// waits for the visitor's choice it sends nothing, stores nothing and downloads nothing; a grant starts it from that
// point, a denial keeps it off (and withdraws it after a grant); every opt-out still wins; without the option nothing
// changes. Telemetry goes to a recording transport and the model to a counted fake worker: nothing reaches a network.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, GenClass } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import type { CreateOptions, TelemetryTransport } from "../src/types.js";
import { consentOf, consentState } from "../src/consent.js";
import { DEFAULT_CACHE_NAME, fetchFile } from "../src/model/loader.js";
import { fromDataset, fromPairs, parsePairs, readMetaConfig } from "../src/cdn/config.js";
import type { TelemetryClient } from "../src/telemetry/client.js";
import { VISIT_KEY } from "../src/analytics/index.js";
import { FakeClock, drain } from "./helpers.js";

const TOKEN = "gc_abcdefghijklmnopqrstuv";
const OFF = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false };

type Ev = Record<string, unknown>;
function recorder(): TelemetryTransport & { sent: Ev[][] } {
  const sent: Ev[][] = [];
  return {
    sent,
    send(_url, body) {
      sent.push((JSON.parse(body) as { events: Ev[] }).events);
      return Promise.resolve();
    },
  };
}

/**
 * A Storage that records every call, so "stores nothing" means no call at all. Its methods are on the prototype, as
 * a browser's are, so the storage observer (observe.storage, src/observe/storage.ts) can wrap them; `calls` can be
 * pointed at the next page load's list when one storage outlives a page (sessionStorage across a reload).
 */
class RecStorage implements Storage {
  private m = new Map<string, string>();
  constructor(
    private readonly name: string,
    public calls: string[],
  ) {}
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    this.calls.push(`${this.name}.getItem ${k}`);
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.calls.push(`${this.name}.setItem ${k}`);
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.calls.push(`${this.name}.removeItem ${k}`);
    this.m.delete(k);
  }
  clear() {
    this.calls.push(`${this.name}.clear`);
    this.m.clear();
  }
  /** The stored value, without recording a call. */
  peek(k: string) {
    return this.m.get(k) ?? null;
  }
  /** Store a value, without recording a call (what an earlier page load left). */
  seed(k: string, v: string) {
    this.m.set(k, v);
  }
}
function storage(name: string, calls: string[]): RecStorage {
  return new RecStorage(name, calls);
}

/** A model worker that never answers: counting how many were created (and ended) is enough to see a download start. */
function fakeWorker(created: { n: number }, ended?: { n: number }) {
  return () => {
    created.n++;
    return {
      postMessage() {},
      terminate() {
        if (ended) ended.n++;
      },
      addEventListener() {},
    };
  };
}

let rt: RuntimeImpl | null = null;

/** A runtime on a public host with every stored or sent part turned on, and the gate as `consent` says. */
function page(
  o: {
    consent?: CreateOptions["consent"];
    telemetry?: CreateOptions["telemetry"];
    gpc?: boolean;
    search?: string;
    analytics?: boolean;
    learn?: CreateOptions["learn"];
    preload?: "eager" | "idle" | "lazy";
    /** model.loadIf (default: always load). */
    loadIf?: () => unknown;
    /** model.unloadAfterIdleMs (default: unset, the host is never unloaded). */
    unloadAfterIdleMs?: number;
    /** The storages of an earlier page load in the same tab (they then record into this page's `calls`). */
    stores?: { local: RecStorage; session: RecStorage };
    /** The storage observer on, with a Storage class on the page. */
    observeStorage?: boolean;
    /** Just enough of a document and window for the analytics chunk to record. */
    dom?: boolean;
    transport?: TelemetryTransport;
  } = {},
) {
  const clock = new FakeClock();
  const transport = recorder();
  const calls: string[] = [];
  const created = { n: 0 };
  const ended = { n: 0 };
  const fetches: string[] = [];
  const cacheDeleted: string[] = [];
  const local = o.stores?.local ?? storage("local", calls);
  const session = o.stores?.session ?? storage("session", calls);
  local.calls = calls;
  session.calls = calls;
  const noop = () => undefined;
  const g: Record<string, unknown> = {
    location: { href: `https://shop.example/cart${o.search ?? ""}`, hostname: "shop.example", pathname: "/cart", search: o.search ?? "" },
    navigator: o.gpc ? { globalPrivacyControl: true } : {},
    crypto: globalThis.crypto,
    localStorage: local,
    sessionStorage: session,
    ...(o.observeStorage ? { Storage: RecStorage } : {}),
    ...(o.dom ? { addEventListener: noop, removeEventListener: noop, document: { addEventListener: noop, removeEventListener: noop, visibilityState: "visible", referrer: "" } } : {}),
    caches: {
      delete: (n: string) => {
        cacheDeleted.push(n);
        return Promise.resolve(true);
      },
    },
    fetch: (u: string) => {
      fetches.push(String(u));
      return Promise.reject(new Error("no network in tests"));
    },
    console: { info() {}, warn() {}, log() {}, error() {}, debug() {} },
  };
  rt = createRuntime({
    clock,
    global: g,
    report: "silent",
    observe: o.observeStorage ? { ...OFF, storage: true } : OFF,
    model: {
      preload: o.preload ?? "eager",
      loadIf: o.loadIf ?? (() => true),
      ...(o.unloadAfterIdleMs ? { unloadAfterIdleMs: o.unloadAfterIdleMs } : {}),
      workerFactory: fakeWorker(created, ended),
    } as never,
    telemetry: o.telemetry ?? { transport: o.transport ?? transport, flushMs: 1000 },
    token: TOKEN,
    analytics: o.analytics ?? true,
    // every stored part: learned state (profiles too), the act/observe bucket
    learn: o.learn ?? { persist: true },
    sample: 0.5,
    ...(o.consent !== undefined ? { consent: o.consent } : {}),
  }) as RuntimeImpl;
  const sent = () => transport.sent.flat();
  return { clock, g, transport, sent, calls, created, ended, fetches, cacheDeleted, rt, stores: { local, session } };
}

afterEach(() => {
  rt?.destroy();
  rt = null;
  GenClass.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('consent "pending" (CONTRACT section 17; TELEMETRY.md Consent): observes locally only', () => {
  it("sends nothing, stores nothing and creates no model worker, however long the page stays open", async () => {
    const p = page({ consent: "pending" });
    await drain();
    expect(p.rt.telemetry).toMatchObject({ enabled: false, reason: "consent" });
    expect(p.rt.analytics).toMatchObject({ enabled: false, reason: "consent" });
    expect(p.rt.status).toMatchObject({ state: "disabled", reason: "consent" });
    // the page's own life: timers, a hidden tab, page exit
    await p.clock.advance(120_000);
    await p.rt.ready; // resolves at once: it never starts a download while the model waits
    await p.clock.advance(10_000);
    expect(p.sent()).toEqual([]);
    expect(p.calls).toEqual([]);
    expect(p.created.n).toBe(0);
    expect(p.fetches).toEqual([]);
    expect(await p.rt.consent()).toEqual({ diagnostics: "pending", analytics: "pending", storage: "pending", model: "pending" });
    // reading the state changes nothing
    await p.clock.advance(60_000);
    expect(p.sent()).toEqual([]);
    expect(p.calls).toEqual([]);
  });

  it("an ask() waiting for the model is answered as without a model, and loads nothing", async () => {
    const p = page({ consent: "pending" });
    await expect(p.rt.ask({ type: "noul", instructions: "x" })).rejects.toThrow(/model/);
    expect(p.created.n).toBe(0);
  });

  it("the parts the option grants at start run; the rest wait (a self-hosted model granted, diagnostics pending)", async () => {
    const p = page({ consent: { model: true } });
    await vi.waitFor(() => expect(p.created.n).toBe(1));
    expect(await p.rt.consent()).toMatchObject({ model: "granted", diagnostics: "pending", storage: "pending" });
    await p.clock.advance(30_000);
    expect(p.sent()).toEqual([]);
    expect(p.calls).toEqual([]);
  });
});

describe("consent grants (CONTRACT section 17): each part starts from that point", () => {
  it("diagnostics: telemetry starts now, with a new session and nothing from before the grant", async () => {
    const p = page({ consent: "pending" });
    await p.clock.advance(5000);
    const state = await p.rt.consent({ diagnostics: true });
    expect(state).toMatchObject({ diagnostics: "granted", analytics: "pending" });
    expect(p.rt.telemetry?.enabled).toBe(true);
    await p.clock.advance(1500);
    const events = p.sent();
    expect(events[0]).toMatchObject({ t: "session", host: "shop.example", modelState: "disabled" });
    // `at` counts from the grant, not from the page load
    expect(events[0]!.at).toBe(0);
    // nothing stored (storage was not granted); the one read is the opt-out every telemetry start honours
    expect(p.calls).toEqual(["local.getItem genclass.telemetry"]);
  });

  it("analytics the app turned on start with their consent and diagnostics (they are sent as diagnostics)", async () => {
    const p = page({ consent: "pending" });
    await p.rt.consent({ analytics: true });
    expect(p.rt.analytics).toMatchObject({ enabled: false, reason: "telemetry-off" });
    await p.rt.consent({ diagnostics: true });
    expect(p.rt.analytics?.enabled).toBe(true);
  });

  it("analytics the app did not turn on stay off whatever the visitor grants", async () => {
    const p = page({ consent: "pending", analytics: false });
    await p.rt.consent(true);
    expect(p.rt.analytics).toMatchObject({ enabled: false, reason: "option" });
  });

  it("storage: learned state from earlier visits is read, and kept from now on", async () => {
    const p = page({ consent: "pending" });
    await p.clock.advance(10_000);
    expect(p.calls).toEqual([]);
    await p.rt.consent({ storage: true });
    expect(p.calls).toContain("local.getItem genclass:learn");
    await p.clock.advance(6000);
    expect(p.calls).toContain("local.setItem genclass:learn");
    expect(await p.rt.consent()).toMatchObject({ storage: "granted" });
  });

  it("the model: created only now, as its preload says (eager now; idle when the browser is idle)", async () => {
    const eager = page({ consent: "pending" });
    await eager.rt.consent({ model: true });
    expect(eager.created.n).toBe(1);
    expect(eager.rt.status.state).not.toBe("disabled");
    eager.rt.destroy();
    const idle = page({ consent: "pending", preload: "idle" });
    await idle.rt.consent({ model: true });
    expect(idle.created.n).toBe(0);
    await idle.clock.advance(1000); // no requestIdleCallback on this page: the runtime's clock stands in
    expect(idle.created.n).toBe(1);
    idle.rt.destroy();
    const lazy = page({ consent: "pending", preload: "lazy" });
    await lazy.rt.consent({ model: true });
    await lazy.clock.advance(5000);
    expect(lazy.created.n).toBe(0); // lazy: at the first salient situation, as without the gate
    void lazy.rt.ready; // what the first salient situation does (the fake worker never answers: not awaited)
    await drain();
    expect(lazy.created.n).toBe(1);
  });

  it("true grants every part at once; the state reads back as granted", async () => {
    const p = page({ consent: "pending" });
    expect(await p.rt.consent(true)).toEqual({ diagnostics: "granted", analytics: "granted", storage: "granted", model: "granted" });
    expect(p.rt.telemetry?.enabled).toBe(true);
    expect(p.rt.analytics?.enabled).toBe(true);
    expect(p.created.n).toBe(1);
  });
});

describe("consent denials (CONTRACT section 17): they keep each part off, and withdraw a grant", () => {
  it("a denial while pending keeps everything off for the page", async () => {
    const p = page({ consent: "pending" });
    expect(await p.rt.consent(false)).toEqual({ diagnostics: "denied", analytics: "denied", storage: "denied", model: "denied" });
    await p.clock.advance(120_000);
    expect(p.sent()).toEqual([]);
    expect(p.created.n).toBe(0);
    expect(p.calls.filter((c) => !c.includes(".removeItem "))).toEqual([]);
    expect(p.rt.telemetry?.reason).toBe("consent");
  });

  it('"denied" at start is a denial: GenClass\'s entries from earlier visits are removed, nothing is written', async () => {
    const p = page({ consent: "denied" });
    await drain();
    expect(await p.rt.consent()).toMatchObject({ storage: "denied", diagnostics: "denied" });
    expect(p.calls).toEqual(expect.arrayContaining(["local.removeItem genclass:learn", "session.removeItem genclass:bucket", "session.removeItem genclass:breaker"]));
    expect(p.calls.filter((c) => !c.includes(".removeItem "))).toEqual([]);
  });

  it("withdrawing diagnostics stops telemetry now and drops what it had queued", async () => {
    const p = page({ consent: "pending" });
    await p.rt.consent({ diagnostics: true, analytics: true });
    expect(p.rt.analytics?.enabled).toBe(true);
    await p.clock.advance(200); // the session event is queued, not sent yet (flushMs 1000)
    expect(p.sent()).toEqual([]);
    await p.rt.consent({ diagnostics: false });
    expect(p.rt.telemetry).toMatchObject({ enabled: false, reason: "consent" });
    expect(p.rt.analytics).toMatchObject({ enabled: false, reason: "consent" });
    await p.clock.advance(60_000);
    expect(p.sent()).toEqual([]);
    // granted again: a new telemetry session, and the analytics the app turned on with it
    await p.rt.consent({ diagnostics: true });
    expect(p.rt.telemetry?.enabled).toBe(true);
    expect(p.rt.analytics?.enabled).toBe(true);
  });

  it("withdrawing storage stops writing and removes GenClass's entries; withdrawing the model deletes its cached files", async () => {
    const p = page({ consent: "pending" });
    await p.rt.consent({ storage: true, model: true });
    expect(p.created.n).toBe(1);
    await p.clock.advance(6000);
    expect(p.calls).toContain("local.setItem genclass:learn");
    p.calls.length = 0;
    await p.rt.consent({ storage: false, model: false });
    expect(p.calls).toEqual(expect.arrayContaining(["local.removeItem genclass:learn", "session.removeItem genclass:learn:session"]));
    expect(p.cacheDeleted).toEqual([DEFAULT_CACHE_NAME]);
    expect(p.rt.status).toMatchObject({ state: "disabled", reason: "consent" });
    p.calls.length = 0;
    await p.clock.advance(60_000);
    expect(p.calls).toEqual([]);
  });
});

describe("every opt-out still wins over a grant (TELEMETRY.md Opting out)", () => {
  it("Global Privacy Control: a diagnostics grant sends nothing", async () => {
    const p = page({ consent: "pending", gpc: true });
    await p.rt.consent(true);
    expect(p.rt.telemetry).toMatchObject({ enabled: false, reason: "gpc" });
    expect(p.rt.analytics?.enabled).toBe(false);
    await p.clock.advance(60_000);
    expect(p.sent()).toEqual([]);
  });

  it("telemetry: false and ?genclass=no-telemetry keep their own reasons", async () => {
    const off = page({ consent: "pending", telemetry: false });
    expect(off.rt.telemetry).toMatchObject({ enabled: false, reason: "option" });
    await off.rt.consent(true);
    expect(off.rt.telemetry).toMatchObject({ enabled: false, reason: "option" });
    off.rt.destroy();
    const url = page({ consent: "pending", search: "?genclass=no-telemetry" });
    await url.rt.consent(true);
    expect(url.rt.telemetry).toMatchObject({ enabled: false, reason: "url" });
  });
});

describe("without the consent option nothing changes (CONTRACT section 17)", () => {
  it("telemetry, storage and the model run as before; every part reads granted", async () => {
    const p = page();
    expect(p.rt.telemetry?.enabled).toBe(true);
    expect(p.created.n).toBe(1);
    expect(p.calls).toContain("session.setItem genclass:bucket");
    expect(p.rt.analytics?.enabled).toBe(true);
    expect(p.rt.cs).toEqual({ diagnostics: true, analytics: true, storage: true, model: true });
    expect(await p.rt.consent()).toEqual({ diagnostics: "granted", analytics: "granted", storage: "granted", model: "granted" });
  });

  it("a denial still withdraws what runs: diagnostics stop, entries are removed, the model is not consulted", async () => {
    const p = page();
    await p.rt.consent(false);
    expect(p.rt.telemetry).toMatchObject({ enabled: false, reason: "consent" });
    expect(p.rt.status).toMatchObject({ state: "disabled", reason: "consent" });
    expect(p.calls).toContain("local.removeItem genclass:learn");
  });
});

describe("the flow layer waits for the storage choice (learn.expectations; CONTRACT section 17)", () => {
  it("not loaded while storage is pending; loaded with what earlier visits stored once granted, in memory once denied", async () => {
    const p = page({ consent: "pending", learn: { expectations: true } });
    await p.clock.advance(1000);
    await drain();
    expect(p.rt.flows).toBeNull();
    await p.rt.consent({ storage: true });
    await vi.waitFor(() => expect(p.rt.flows).not.toBeNull());
    expect(p.calls).toContain("local.getItem genclass:learn");
    p.rt.destroy();
    const d = page({ consent: "pending", learn: { expectations: true } });
    await d.rt.consent({ storage: false });
    await vi.waitFor(() => expect(d.rt.flows).not.toBeNull());
    expect(d.calls.filter((c) => !c.includes(".removeItem "))).toEqual([]);
  });
});

describe("parsing the choice (src/consent.ts; the page config, src/cdn/config.ts)", () => {
  it("consentOf: grants, denials, single parts; anything else changes nothing", () => {
    expect(consentOf(true)).toEqual({ diagnostics: true, analytics: true, storage: true, model: true });
    expect(consentOf("granted")).toEqual(consentOf(true));
    expect(consentOf(false)).toEqual({ diagnostics: false, analytics: false, storage: false, model: false });
    expect(consentOf("denied")).toEqual(consentOf(false));
    expect(consentOf({ model: true, diagnostics: "yes" })).toEqual({ model: true });
    for (const v of ["pending", "maybe", 1, null, undefined]) expect(consentOf(v)).toEqual({});
    expect(consentState({ model: true, storage: false })).toEqual({ diagnostics: "pending", analytics: "pending", storage: "denied", model: "granted" });
  });

  it("the meta tag and data-consent take pending and denied only (they can hold GenClass back, never grant)", () => {
    expect(fromPairs(parsePairs("consent=pending"))).toEqual({ consent: "pending" });
    expect(fromPairs(parsePairs("consent=denied, mode=observe"))).toEqual({ consent: "denied", mode: "observe" });
    // a grant is the visitor's, from the app's code: "granted" here waits as pending (fails closed)
    expect(fromPairs(parsePairs("consent=granted"))).toEqual({ consent: "pending" });
    expect(fromDataset({ consent: "pending" })).toEqual({ consent: "pending" });
    const doc = { head: { querySelectorAll: () => [{ getAttribute: () => "consent=pending" }] } };
    expect(readMetaConfig(doc as never)).toEqual({ consent: "pending" });
  });

  it("the consent code is a lazy chunk: the runtime's first load does not import it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import [^;]*from "\.\/consent\.js"/m);
    expect(src).toContain('import("./consent.js")');
    const chunk = readFileSync(new URL("../src/consent.ts", import.meta.url), "utf8");
    // types only: a value import would pull a first-load module into its own shared chunk
    for (const line of chunk.split("\n").filter((l) => l.startsWith("import "))) expect(line).toMatch(/^import type /);
  });
});

describe("GenClass.consent and GenClass.init with the option (CONTRACT section 17)", () => {
  const QUIET = { report: "silent" as const, observe: OFF };
  const at = (hostname: string) => ({ hostname, search: "", href: `https://${hostname}/`, pathname: "/" });

  async function browser() {
    vi.resetModules();
    const fetches: string[] = [];
    let workers = 0;
    vi.stubGlobal("fetch", vi.fn((u: string) => (fetches.push(String(u)), Promise.resolve(new Response(null, { status: 202 })))));
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    vi.stubGlobal("location", at("shop.example"));
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          workers++;
        }
        postMessage() {}
        terminate() {}
        addEventListener() {}
      },
    );
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const m = await import("../src/index.js");
    m.GenClass.destroy();
    return { m, fetches, workers: () => workers };
  }

  it('GenClass.init({ consent: "pending" }) with the default model from jsDelivr: no worker, no request, until the grant', async () => {
    const { m, fetches, workers } = await browser();
    const r = m.GenClass.init({ ...QUIET, consent: "pending", model: { preload: "eager", loadIf: () => true } });
    await drain();
    expect(r.telemetry).toMatchObject({ enabled: false, reason: "consent" });
    expect(workers()).toBe(0);
    expect(fetches).toEqual([]);
    expect(await m.GenClass.consent({ model: true })).toMatchObject({ model: "granted", diagnostics: "pending" });
    expect(workers()).toBe(1);
    expect(await m.GenClass.consent({ diagnostics: true })).toMatchObject({ diagnostics: "granted" });
    expect(m.GenClass.runtime?.telemetry?.enabled).toBe(true);
    m.GenClass.destroy();
  });

  it("GenClass.consent before GenClass starts resolves null; a consent option on a runtime started without one is said, once", async () => {
    const { m } = await browser();
    expect(await m.GenClass.consent(true)).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    m.GenClass.init({ ...QUIET, model: false });
    m.GenClass.init({ ...QUIET, model: false, consent: "pending" });
    m.GenClass.init({ ...QUIET, model: false, consent: "pending" });
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Already running"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Nothing waits for consent: set it in GENCLASS_CONFIG or data-consent.");
    m.GenClass.destroy();
    // started with the gate: a second init with the option says nothing about it
    warn.mockClear();
    m.GenClass.init({ ...QUIET, model: false, consent: "pending" });
    m.GenClass.init({ ...QUIET, model: false, consent: "pending" });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("Nothing waits for consent"))).toHaveLength(0);
    m.GenClass.destroy();
  });
});

describe("the URL opt-out the page started with outlives a route change (CONTRACT section 17; TELEMETRY.md Opting out)", () => {
  it("pending: ?genclass=no-telemetry, then the SPA drops the query, then a grant: still off for the page load", async () => {
    const p = page({ consent: "pending", search: "?genclass=no-telemetry" });
    expect(p.rt.telemetry).toMatchObject({ enabled: false, reason: "url" });
    (p.g.location as { search: string }).search = ""; // the router redirected to /home, or the visitor moved on
    await p.rt.consent(true);
    expect(p.rt.telemetry).toMatchObject({ enabled: false, reason: "url" });
    await p.clock.advance(60_000);
    expect(p.sent()).toEqual([]);
  });

  it("without the gate: a withdrawal and a new grant keep it off too", async () => {
    const p = page({ search: "?genclass=no-telemetry" });
    expect(p.rt.telemetry).toMatchObject({ enabled: false, reason: "url" });
    (p.g.location as { search: string }).search = "";
    await p.rt.consent(false);
    await p.rt.consent(true);
    expect(p.rt.telemetry).toMatchObject({ enabled: false, reason: "url" });
    await p.clock.advance(60_000);
    expect(p.sent()).toEqual([]);
  });
});

describe("a storage grant reads the session's bucket and breaker trip, as without the gate (OPTIONS-SPEC 4.2, 4.5; CONTRACT section 17)", () => {
  it("a trip stored earlier in the tab caps the mode once storage is granted; one on this page is stored", async () => {
    // page 1: storage granted, the breaker trips (two undos), the trip is stored for the session
    const p1 = page({ consent: "pending" });
    await p1.rt.consent({ storage: true });
    const b1 = p1.rt["breakerImpl"]!;
    b1.undo("d1");
    b1.undo("d2");
    expect(p1.rt.breaker.tripped).toBe(true);
    expect(p1.stores.session.peek("genclass:breaker")).not.toBeNull();
    p1.rt.destroy();
    // page 2, same tab: pending at start (nothing read), then the CMP grants storage
    const p2 = page({ consent: "pending", stores: p1.stores });
    expect(p2.rt.breaker.tripped).toBe(false);
    expect(p2.calls).toEqual([]);
    const seen: unknown[] = [];
    p2.rt.on("status", (s) => seen.push(s));
    await p2.rt.consent({ storage: true });
    expect(p2.rt.breaker.tripped).toBe(true);
    expect(p2.rt.status.breaker).toMatchObject({ tripped: true, reason: "undos" });
    expect(seen.length).toBeGreaterThan(0);
    p2.rt.destroy();
    // a trip while storage waits is kept in memory, and stored once it is granted
    const p3 = page({ consent: "pending" });
    p3.rt["breakerImpl"]!.undo("d1");
    p3.rt["breakerImpl"]!.undo("d2");
    expect(p3.calls).toEqual([]);
    await p3.rt.consent({ storage: true });
    expect(p3.stores.session.peek("genclass:breaker")).not.toBeNull();
  });

  it("a reset on this page before the grant stays a reset: the stored trip is removed, not read", async () => {
    const p = page({ consent: "pending" });
    p.stores.session.seed("genclass:breaker", JSON.stringify({ at: 1, reason: "undos", decisionIds: ["d1"] }));
    p.rt.breaker.reset();
    await p.rt.consent({ storage: true });
    expect(p.rt.breaker.tripped).toBe(false);
    expect(p.stores.session.peek("genclass:breaker")).toBeNull();
  });

  it("the act/observe bucket: the session's stored verdict is taken; without one, this page's is stored", async () => {
    const p = page({ consent: "pending" });
    const mine = p.rt.status.sampled;
    // what page 1 of this session drew and stored (the opposite of this page's draw)
    p.stores.session.seed("genclass:bucket", `${mine ? "observe" : "act"}@0.5`);
    await p.rt.consent({ storage: true });
    expect(p.rt.status.sampled).toBe(!mine);
    p.rt.destroy();
    const q = page({ consent: "pending" });
    expect(q.stores.session.peek("genclass:bucket")).toBeNull();
    await q.rt.consent({ storage: true });
    expect(q.stores.session.peek("genclass:bucket")).toBe(`${q.rt.status.sampled ? "act" : "observe"}@0.5`);
  });
});

describe("withdrawing analytics drops their queued events (CONTRACT section 17; TELEMETRY.md Consent)", () => {
  const ix = (evs: Ev[]) => evs.filter((e) => e.t === "interactions");

  it("an interactions event queued before the withdrawal is not sent after it; diagnostics go on", async () => {
    const p = page({ consent: "pending", dom: true });
    await p.rt.consent({ diagnostics: true, analytics: true });
    const client = p.rt.telemetry as unknown as TelemetryClient;
    await vi.waitFor(() => expect(client.pre).toBeTypeOf("function"));
    client.summary("periodic"); // the analytics chunk queues the view's event with it
    expect(ix(client["queue"] as Ev[])).toHaveLength(1);
    await p.rt.consent({ analytics: false });
    expect(p.rt.telemetry?.enabled).toBe(true);
    await p.clock.advance(1500);
    expect(p.sent().some((e) => e.t === "summary")).toBe(true);
    expect(ix(p.sent())).toEqual([]);
  });

  it("one in a request refused after the withdrawal (a back-off puts it back) is dropped too", async () => {
    const sent: Ev[][] = [];
    let refuse: ((e: unknown) => void) | null = null;
    let first = true;
    const transport: TelemetryTransport = {
      send(_u, body) {
        if (first) {
          first = false;
          return new Promise<void>((_r, j) => (refuse = j));
        }
        sent.push((JSON.parse(body) as { events: Ev[] }).events);
        return Promise.resolve();
      },
    };
    const p = page({ consent: "pending", dom: true, transport });
    await p.rt.consent({ diagnostics: true, analytics: true });
    const client = p.rt.telemetry as unknown as TelemetryClient;
    await vi.waitFor(() => expect(client.pre).toBeTypeOf("function"));
    client.summary("periodic");
    void client.flush(); // in flight, with the interactions event
    await p.rt.consent({ analytics: false });
    refuse!({ status: 429 });
    await drain();
    await p.clock.advance(31_000);
    await drain();
    expect(sent.flat().some((e) => e.t === "summary")).toBe(true);
    expect(ix(sent.flat())).toEqual([]);
  });

  it("analytics granted again before that request settles keep the new view's event (only those from before the withdrawal go)", async () => {
    const sent: Ev[][] = [];
    let settle: (() => void) | null = null;
    let first = true;
    const transport: TelemetryTransport = {
      send(_u, body) {
        const evs = (JSON.parse(body) as { events: Ev[] }).events;
        if (first) {
          first = false;
          return new Promise<void>((r) => (settle = () => (sent.push(evs), r())));
        }
        sent.push(evs);
        return Promise.resolve();
      },
    };
    const p = page({ consent: "pending", dom: true, transport });
    await p.rt.consent({ diagnostics: true, analytics: true });
    const client = p.rt.telemetry as unknown as TelemetryClient;
    await vi.waitFor(() => expect(client.pre).toBeTypeOf("function"));
    client.summary("periodic");
    void client.flush(); // in flight, with the first view's interactions event
    await p.rt.consent({ analytics: false });
    await p.rt.consent({ analytics: true });
    await vi.waitFor(() => expect(client.pre).toBeTypeOf("function"));
    client.summary("periodic"); // the analytics granted again queue their view's event
    expect(ix(client["queue"] as Ev[])).toHaveLength(1);
    settle!();
    await drain();
    expect(ix(client["queue"] as Ev[])).toHaveLength(1);
    await p.clock.advance(1500);
    await drain();
    // the first request had left before the withdrawal; the second carries the new view's event
    expect(sent.map((b) => ix(b).length)).toEqual([1, 1]);
  });
});

describe("withdrawing the model while it loads stops the load (CONTRACT section 17; TELEMETRY.md Consent)", () => {
  it("the worker ends at the withdrawal, the cached copy is deleted, and a later grant loads again", async () => {
    const p = page({ consent: "pending" });
    await p.rt.consent({ model: true });
    expect(p.created.n).toBe(1);
    expect(p.rt["decider"]!.status.state).toBe("loading");
    await p.rt.consent({ model: false });
    expect(p.ended.n).toBe(1); // no request and no Cache Storage write can follow
    await drain();
    expect(p.cacheDeleted).toEqual([DEFAULT_CACHE_NAME]);
    expect(p.rt.status).toMatchObject({ state: "disabled", reason: "consent" });
    await p.clock.advance(60_000);
    expect(p.created.n).toBe(1);
    await p.rt.consent({ model: true });
    expect(p.created.n).toBe(2);
  });

  // model.unloadAfterIdleMs (OPTIONS-SPEC's production example sets 300_000) puts the host in a wrapper (index.ts
  // IdleUnloadProvider): what waits for the load is on the host inside it, and the wrapper, disposed, reads as that host
  for (const gate of [true, false])
    for (const idle of [0, 600_000])
      it(`a ready awaited while it loads resolves at the withdrawal, as with no model; an ask() rejects as unavailable (${gate ? "pending at start" : "no gate"}${idle ? `, model.unloadAfterIdleMs ${idle}` : ""})`, async () => {
        const p = page({ ...(gate ? { consent: "pending" as const } : {}), ...(idle ? { unloadAfterIdleMs: idle } : {}) });
        if (gate) await p.rt.consent({ model: true });
        expect(p.rt["decider"]!.status.state).toBe("loading");
        const ready = p.rt.ready.then(
          () => "resolved",
          (e: Error) => `rejected: ${e.name}`,
        );
        const unavailable = (e: Error & { reason?: string }) => `${e.name} ${e.reason}: ${e.message}`;
        const asked = p.rt.ask({ type: "noul", instructions: "x" }).then(() => "answered", unavailable);
        const askedInTime = p.rt.ask({ type: "noul", instructions: "x" }, { timeoutMs: 5000 }).then(() => "answered", unavailable);
        await drain();
        await p.rt.consent({ model: false });
        await drain();
        expect(p.ended.n).toBe(1);
        expect(await ready).toBe("resolved");
        // the model did not fail to load: it is withdrawn, as when it waits for consent
        expect(await asked).toBe("GenClassUnavailableError error: the model is off");
        expect(await askedInTime).toBe("GenClassUnavailableError error: the model is off");
        await p.rt.ready;
        // nothing loads it while it is withdrawn, through idle unloads too
        await p.clock.advance(2 * (idle || 60_000));
        await drain();
        expect(p.created.n).toBe(1);
        // a later grant loads again, and a ready read then waits for that load
        await p.rt.consent({ model: true });
        expect(p.created.n).toBe(2);
        let again = false;
        // (destroying the runtime rejects it: caught)
        void p.rt.ready.then(
          () => (again = true),
          () => undefined,
        );
        await drain();
        expect(again).toBe(false);
      });

  it('the runtime hears the host put in place: its status reaches rt.on("status")', async () => {
    const p = page({ consent: "pending" });
    const states: string[] = [];
    p.rt.on("status", (s) => states.push(s.state));
    await p.rt.consent({ model: true });
    expect(states).toContain("loading");
  });

  it("the inline backend (no worker) stores nothing in Cache Storage once disposed during a download", async () => {
    let disposed = false;
    const puts: string[] = [];
    const cache = { match: () => Promise.resolve(undefined), put: (u: string) => (puts.push(u), Promise.resolve()), delete: () => Promise.resolve(true) };
    const env = {
      fetch: () => {
        disposed = true; // the withdrawal lands while the file downloads
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
      },
      get caches() {
        return disposed ? null : ({ open: () => Promise.resolve(cache) } as unknown as CacheStorage);
      },
      cacheName: DEFAULT_CACHE_NAME,
    };
    const out = await fetchFile(env as never, "https://cdn.example/model.onnx", { file: "model.onnx", bytes: 3 }, "tag");
    await out.stored;
    expect(out.bytes.byteLength).toBe(3);
    expect(puts).toEqual([]);
  });
});

describe("a storage grant: GenClass's own entries are not app activity (CONTRACT section 17: no consent state reaches a situation)", () => {
  it("the probe, the session ordinal and the bucket written at the grant are not recorded by the storage observer", async () => {
    const p = page({ consent: "pending", observeStorage: true, learn: { persist: true, expectations: true } });
    const storageEvents: string[] = [];
    p.rt.on("event", (e) => {
      if (e.kind === "storage") storageEvents.push(`${e.name} ${String(e.data?.key)}`);
    });
    await p.rt.consent({ storage: true });
    await p.clock.advance(6000); // the learned state's save too
    expect(p.calls).toEqual(expect.arrayContaining(["local.setItem genclass:learn:probe", "session.setItem genclass:learn:session", "session.setItem genclass:bucket"]));
    expect(storageEvents).toEqual([]);
    // the app's own writes still are
    (p.g.localStorage as Storage).setItem("cart", "1");
    expect(storageEvents).toEqual(["localStorage.setItem cart"]);
  });
});

describe("diagnostics granted late count the runtime from the grant (TELEMETRY.md Consent: nothing from before the grant)", () => {
  it("the summary's runtime block leaves out the decisions, holds, denials and errors before the grant", async () => {
    const p = page({ consent: "pending" });
    const sum = p.rt["sum"];
    // before the grant: a self-hosted model decided and held, a hold was denied, an error was seen
    sum.decision(40);
    sum.decision(60);
    sum.held(500);
    sum.inc(sum.s.denied, "limit:hold");
    sum.s.errors++;
    await p.clock.advance(5000);
    await p.rt.consent({ diagnostics: true });
    const client = p.rt.telemetry as unknown as TelemetryClient;
    client.summary("periodic");
    await p.clock.advance(1500);
    type Summary = { runtime: { model: Record<string, unknown>; heldMs: unknown; denied: unknown; errors: number } };
    const first = p.sent().find((e) => e.t === "summary") as unknown as Summary;
    expect(first.runtime.model).toMatchObject({ decisions: 0 });
    expect(first.runtime.model.p50Ms).toBeUndefined();
    expect(first.runtime.heldMs).toEqual({ total: 0, max: 0 });
    expect(first.runtime.denied).toEqual({});
    expect(first.runtime.errors).toBe(0);
    // after the grant: counted
    sum.decision(7);
    sum.held(30);
    client.summary("periodic");
    await p.clock.advance(1500);
    const last = p.sent().filter((e) => e.t === "summary").pop() as unknown as Summary;
    expect(last.runtime.model).toMatchObject({ decisions: 1, p50Ms: 7, p95Ms: 7 });
    expect(last.runtime.heldMs).toEqual({ total: 30, max: 30 });
    // the page-wide counts (Runtime.summary(), the app's sinks) are unchanged
    expect(p.rt.summary().model.decisions).toBe(3);
    expect(p.rt.summary().heldMs.max).toBe(500);
  });
});

describe("a model grant loads as model.preload and model.loadIf say (CONTRACT section 17)", () => {
  it('preload "idle" waits for the page\'s load event, as without the gate', async () => {
    let onLoad: (() => void) | null = null;
    vi.stubGlobal("document", { readyState: "loading" });
    vi.stubGlobal("addEventListener", (t: string, f: () => void) => {
      if (t === "load") onLoad = f;
    });
    vi.stubGlobal("removeEventListener", () => undefined);
    const p = page({ consent: "pending", preload: "idle" });
    await p.rt.consent({ model: true });
    await p.clock.advance(1500);
    expect(p.created.n).toBe(0); // the page is still loading
    onLoad!();
    await p.clock.advance(1000); // then idle time (the runtime's clock stands in for requestIdleCallback)
    expect(p.created.n).toBe(1);
  });

  it('model.loadIf "lazy" (Save-Data, a predicate) keeps a granted model lazy: it loads when first asked for', async () => {
    const p = page({ consent: "pending", preload: "eager", loadIf: () => "lazy" });
    await p.rt.consent({ model: true });
    await p.clock.advance(5000);
    expect(p.created.n).toBe(0);
    void p.rt.ready; // what the first salient situation does
    await drain();
    expect(p.created.n).toBe(1);
  });
});

describe("storage denied, then granted: the flow layer takes a stored layer's thresholds (learn.expectations; CONTRACT section 17)", () => {
  it("minSessions goes from 1 (in memory) to 3 (kept in localStorage)", async () => {
    const p = page({ consent: "pending", learn: { expectations: true } });
    await p.rt.consent({ storage: false });
    await vi.waitFor(() => expect(p.rt.flows).not.toBeNull());
    expect(p.rt.flows!.cfg.minSessions).toBe(1);
    await p.rt.consent({ storage: true });
    expect(p.rt.flows!.cfg.minSessions).toBe(3);
  });
});

describe("a denial removes the analytics visit entry an earlier visit left (TELEMETRY.md Consent: storage denied)", () => {
  it('a denial while pending, and "denied" at start, remove genclass.analytics.<token> though the chunk never ran', async () => {
    const key = VISIT_KEY + TOKEN;
    const p = page({ consent: "pending" });
    p.stores.local.seed(key, JSON.stringify({ v: "0123456789abcdef", t: 1, r: 1 }));
    await p.rt.consent(false);
    expect(p.calls).toContain(`local.removeItem ${key}`);
    expect(p.stores.local.peek(key)).toBeNull();
    p.rt.destroy();
    const local = storage("local", []);
    local.seed(key, JSON.stringify({ v: "0123456789abcdef", t: 1, r: 1 }));
    const q = page({ consent: "denied", stores: { local, session: storage("session", []) } });
    await drain();
    expect(q.calls).toContain(`local.removeItem ${key}`);
    expect(local.peek(key)).toBeNull();
    expect(q.calls.filter((c) => !c.includes(".removeItem "))).toEqual([]);
  });
});

describe("the page config's consent key fails closed (src/cdn/config.ts)", () => {
  it("a bare key, true, granted or a typo wait as pending; denied stays denied", () => {
    for (const v of ["", "true", "granted", "pendng", "yes", "off"]) expect(fromPairs({ consent: v })).toEqual({ consent: "pending" });
    expect(fromDataset({ consent: "" })).toEqual({ consent: "pending" });
    expect(fromPairs({ consent: "DENIED" })).toEqual({ consent: "denied" });
  });
});
