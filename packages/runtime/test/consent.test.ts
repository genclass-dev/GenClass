// The consent gate (InitOptions.consent, Runtime.consent; CONTRACT section 17, TELEMETRY.md "Consent"): while a part
// waits for the visitor's choice it sends nothing, stores nothing and downloads nothing; a grant starts it from that
// point, a denial keeps it off (and withdraws it after a grant); every opt-out still wins; without the option nothing
// changes. Telemetry goes to a recording transport and the model to a counted fake worker: nothing reaches a network.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, GenClass } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import type { CreateOptions, TelemetryTransport } from "../src/types.js";
import { consentOf, consentState } from "../src/consent.js";
import { DEFAULT_CACHE_NAME } from "../src/model/loader.js";
import { fromDataset, fromPairs, parsePairs, readMetaConfig } from "../src/cdn/config.js";
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

/** A Storage that records every call, so "stores nothing" means no call at all. */
function storage(name: string, calls: string[]): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem(k: string) {
      calls.push(`${name}.getItem ${k}`);
      return m.has(k) ? m.get(k)! : null;
    },
    setItem(k: string, v: string) {
      calls.push(`${name}.setItem ${k}`);
      m.set(k, String(v));
    },
    removeItem(k: string) {
      calls.push(`${name}.removeItem ${k}`);
      m.delete(k);
    },
    clear() {
      calls.push(`${name}.clear`);
      m.clear();
    },
  };
}

/** A model worker that never answers: counting how many were created is enough to see a download start. */
function fakeWorker(created: { n: number }) {
  return () => {
    created.n++;
    return { postMessage() {}, terminate() {}, addEventListener() {} };
  };
}

let rt: RuntimeImpl | null = null;

/** A runtime on a public host with every stored or sent part turned on, and the gate as `consent` says. */
function page(o: { consent?: CreateOptions["consent"]; telemetry?: CreateOptions["telemetry"]; gpc?: boolean; search?: string; analytics?: boolean; learn?: CreateOptions["learn"]; preload?: "eager" | "idle" | "lazy" } = {}) {
  const clock = new FakeClock();
  const transport = recorder();
  const calls: string[] = [];
  const created = { n: 0 };
  const fetches: string[] = [];
  const cacheDeleted: string[] = [];
  const g: Record<string, unknown> = {
    location: { href: `https://shop.example/cart${o.search ?? ""}`, hostname: "shop.example", pathname: "/cart", search: o.search ?? "" },
    navigator: o.gpc ? { globalPrivacyControl: true } : {},
    crypto: globalThis.crypto,
    localStorage: storage("local", calls),
    sessionStorage: storage("session", calls),
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
    observe: OFF,
    model: { preload: o.preload ?? "eager", loadIf: () => true, workerFactory: fakeWorker(created) } as never,
    telemetry: o.telemetry ?? { transport, flushMs: 1000 },
    token: TOKEN,
    analytics: o.analytics ?? true,
    // every stored part: learned state (profiles too), the act/observe bucket
    learn: o.learn ?? { persist: true },
    sample: 0.5,
    ...(o.consent !== undefined ? { consent: o.consent } : {}),
  }) as RuntimeImpl;
  const sent = () => transport.sent.flat();
  return { clock, g, transport, sent, calls, created, fetches, cacheDeleted, rt };
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
    expect(fromPairs(parsePairs("consent=granted"))).toEqual({});
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
