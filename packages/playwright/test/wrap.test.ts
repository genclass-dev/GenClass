// The register entry's wrapper (src/wrap.ts) on fakes of Playwright's public objects (test/helpers.ts): what is
// wrapped and that it is wrapped once, that a wrapped call is the original call (result, receiver, arguments, error),
// that nothing happens outside a test, what a context gets inside one, that a test's contexts and pages end up in
// one "genclass-races/1" file written before the context closes, and that a context which is not one test's (made in
// a beforeAll hook, kept for later tests, left open) is left alone and puts nothing into another test's file. No
// browser, no Playwright.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_PATH } from "../src/chaos.js";
import { AGENT_URL, BINDING, CONTEXT_BINDING, install } from "../src/install.js";
import { parseRaces } from "../src/schema.js";
import { REGISTER_KEY, startGenClass, type GenClassOptions, type TestInfoLike } from "../src/session.js";
import { ATTACH_CAP_MS, hookOf, HOOK_NOTE, mergePageStates, OUTLIVED_NOTE, WRAPPED, Wrapper } from "../src/wrap.js";
import { fakePlaywright, fakeRuntimeDir, fakeTestInfo, PAGE_OK, type FakeContext, type FakePlaywright } from "./helpers.js";

/**
 * What a question to a page was: at the end of a test each page is asked which of its requests are still unanswered
 * (the end-of-test wait, src/install.ts) and then, once, what it collected.
 */
const question = (expression: string): string => (expression.includes(".open()") ? "open" : expression.includes(".collect()") ? "collect" : "other");

let root = "";
let runtimeDir = "";
let outDir = "";
let pw: FakePlaywright;
/** The test "running" now: null for none (test.info() throws). */
let current: TestInfoLike | null = null;
let notes: string[] = [];
let contexts: WeakSet<object>;
const workspace = process.env.GITHUB_WORKSPACE;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-wrap-"));
  runtimeDir = fakeRuntimeDir();
  outDir = join(root, "test-results", "genclass");
  pw = fakePlaywright();
  current = null;
  notes = [];
  contexts = new WeakSet<object>();
  // the file's location is relative to the checkout on GitHub Actions: here the checkout is `root`
  process.env.GITHUB_WORKSPACE = root;
});
afterEach(() => {
  if (workspace === undefined) delete process.env.GITHUB_WORKSPACE;
  else process.env.GITHUB_WORKSPACE = workspace;
  rmSync(root, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
});

function wrapper(options: GenClassOptions = {}): Wrapper {
  return new Wrapper({
    testInfo: () => {
      if (!current) throw new Error("test.info() can only be called while test is running");
      return current;
    },
    options: { runtimeDir, outDir, ...options },
    note: (line) => void notes.push(line),
    contexts,
  });
}

/** A wrapper on the fake Playwright, as worker.ts starts it. */
function start(options: GenClassOptions = {}): Wrapper {
  const w = wrapper(options);
  w.wrapBrowserType(pw.chromium);
  return w;
}

const files = (): string[] => (existsSync(outDir) ? readdirSync(outDir).sort() : []);
const read = (name: string): Record<string, unknown> => {
  const r = parseRaces(readFileSync(join(outDir, name), "utf8"));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.file as unknown as Record<string, unknown>;
};
const witness = (n: number): Record<string, unknown> => ({ kind: "overwrote-newer", subject: "search.results", by: `GET /api/search#${n}`, over: `GET /api/search#${n + 1}`, overKind: "request", gapMs: 120 });
const FILE = "chromium-checkout-spec-ts-checkout-places-one-order-a1b2c3-d4e5f6-s1.json";
const BT = ["BrowserType.launch", "BrowserType.launchPersistentContext", "BrowserType.connect", "BrowserType.connectOverCDP"];

describe("wrap: what is wrapped, and that it is wrapped once", () => {
  it("the four BrowserType methods, on the prototype chromium, firefox and webkit share; a second time wraps nothing", () => {
    const before = { ...Object.getOwnPropertyDescriptors(pw.protos.browserType) };
    const w = wrapper();
    expect(w.wrapBrowserType(pw.chromium)).toEqual(BT);
    for (const m of ["launch", "launchPersistentContext", "connect", "connectOverCDP"]) {
      const d = Object.getOwnPropertyDescriptor(pw.protos.browserType, m)!;
      const fn = d.value as { name: string; length: number } & Record<symbol, unknown>;
      expect(fn[WRAPPED], m).toBe(true);
      expect(fn, m).not.toBe(before[m].value);
      // the method keeps its name, its length and its place on the prototype
      expect(fn.name, m).toBe(m);
      expect(fn.length, m).toBe((before[m].value as { length: number }).length);
      expect({ writable: d.writable, enumerable: d.enumerable, configurable: d.configurable }, m).toEqual({ writable: before[m].writable, enumerable: before[m].enumerable, configurable: before[m].configurable });
    }
    // name() is not one of the four
    expect(Object.getOwnPropertyDescriptor(pw.protos.browserType, "name")!.value).toBe(before.name.value);
    const once = { ...Object.getOwnPropertyDescriptors(pw.protos.browserType) };
    expect(w.wrapBrowserType(pw.chromium)).toEqual([]);
    expect(w.wrapBrowserType(pw.firefox)).toEqual([]);
    expect(w.wrapBrowserType(pw.webkit)).toEqual([]);
    // another wrapper (a second copy of the module in the process) leaves them alone too
    expect(wrapper().wrapBrowserType(pw.chromium)).toEqual([]);
    for (const m of ["launch", "launchPersistentContext", "connect", "connectOverCDP"]) expect(Object.getOwnPropertyDescriptor(pw.protos.browserType, m)!.value, m).toBe(once[m].value);
  });

  it("the browser a launch returns gets newContext and close wrapped, the context it makes gets close wrapped: once each", async () => {
    start();
    const marked = (proto: Record<string, unknown>, m: string): boolean => (proto[m] as Record<symbol, unknown>)[WRAPPED] === true;
    expect(marked(pw.protos.browser, "newContext")).toBe(false);
    const browser = await pw.chromium.launch();
    expect(marked(pw.protos.browser, "newContext")).toBe(true);
    expect(marked(pw.protos.browser, "close")).toBe(true);
    expect(marked(pw.protos.browser, "newPage")).toBe(false);
    expect(marked(pw.protos.context, "close")).toBe(false);
    await browser.newContext();
    expect(marked(pw.protos.context, "close")).toBe(true);
    const wrapped = { newContext: pw.protos.browser.newContext, close: pw.protos.browser.close, contextClose: pw.protos.context.close };
    await (await pw.firefox.launch()).newContext();
    await pw.webkit.connect("ws://example.test");
    await pw.chromium.connectOverCDP("http://127.0.0.1:9222");
    expect({ newContext: pw.protos.browser.newContext, close: pw.protos.browser.close, contextClose: pw.protos.context.close }).toEqual(wrapped);
    expect(notes).toEqual([]);
  });

  it("things that are not Playwright's objects are left alone, without a throw", () => {
    const w = wrapper();
    for (const v of [null, undefined, 1, "chromium", {}, Object.create(null), { launch: async () => 1 }]) {
      expect(w.wrapBrowserType(v)).toEqual([]);
      expect(w.wrapBrowser(v)).toEqual([]);
      expect(w.wrapContext(v)).toEqual([]);
    }
    // a method that cannot be replaced is a note, not a throw; the others are still wrapped
    class Frozen {
      async launch(): Promise<number> {
        return 1;
      }
      async connect(): Promise<number> {
        return 2;
      }
    }
    Object.defineProperty(Frozen.prototype, "launch", { value: Frozen.prototype.launch, writable: false, configurable: false });
    expect(w.wrapBrowserType(new Frozen())).toEqual(["BrowserType.connect"]);
    class Getter {
      get launch(): () => Promise<number> {
        return async () => 1;
      }
    }
    expect(w.wrapBrowserType(new Getter())).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe("wrap: a wrapped call is the original call", () => {
  it("the same result, receiver and arguments", async () => {
    start();
    const options = { headless: true };
    const browser = await pw.chromium.launch(options);
    expect(browser).toBe(pw.chromium.launched[0]);
    expect(pw.chromium.calls).toEqual([{ method: "launch", self: pw.chromium, args: [options] }]);
    const other = await pw.firefox.connect("ws://example.test", { timeout: 5 });
    expect(other).toBe(pw.firefox.launched[0]);
    expect(pw.firefox.calls).toEqual([{ method: "connect", self: pw.firefox, args: ["ws://example.test", { timeout: 5 }] }]);
    const contextOptions = { locale: "de-DE" };
    const context = await browser.newContext(contextOptions);
    expect(context.options).toBe(contextOptions);
    expect(browser.contexts()).toEqual([context]);
    await context.close({ reason: "Test ended." });
    expect(context.closeCalls).toEqual([[{ reason: "Test ended." }]]);
    // a value the original resolves with comes back as it is
    expect(await browser.close({ reason: "bye" })).toBe('closed:[{"reason":"bye"}]');
    expect(notes).toEqual([]);
  });

  it("the same error: a rejection is the same object, a synchronous throw stays synchronous, a plain value stays a plain value", async () => {
    const boom = new Error("browserType.launch: Executable doesn't exist");
    const sync = new Error("thrown before any promise");
    pw.protos.browserType.connect = function (): never {
      throw sync;
    };
    pw.protos.browserType.connectOverCDP = function (): number {
      return 42;
    };
    start();
    pw.chromium.launchError = boom;
    await expect(pw.chromium.launch()).rejects.toBe(boom);
    let thrown: unknown = null;
    try {
      void pw.chromium.connect("ws://x");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(sync);
    expect(pw.chromium.connectOverCDP("http://x")).toBe(42);
    pw.chromium.launchError = null;
    const browser = await pw.chromium.launch();
    const refused = new Error("browser.newContext: storageState: no such file");
    browser.newContextError = refused;
    current = fakeTestInfo(root);
    await expect(browser.newContext()).rejects.toBe(refused);
    browser.newContextError = null;
    const context = await browser.newContext();
    const failed = new Error("browserContext.close: Target closed");
    context.closeError = failed;
    // the error of the original close reaches the caller, after the file was written
    await expect(context.close()).rejects.toBe(failed);
    expect(files()).toEqual([FILE]);
    expect(notes).toEqual([]);
  });
});

describe("wrap: outside a test", () => {
  it("a context created when test.info() throws is left exactly as Playwright made it, and nothing is written", async () => {
    start();
    const browser = await pw.chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    expect(context.instrumented()).toBe(false);
    expect(contexts.has(context)).toBe(false);
    await context.close({ reason: "done" });
    expect(page.evaluated).toEqual([]);
    expect(context.closeCalls).toEqual([[{ reason: "done" }]]);
    const persistent = await pw.chromium.launchPersistentContext("/tmp/profile");
    expect(persistent.instrumented()).toBe(false);
    await persistent.close();
    await browser.close();
    expect(pw.log.filter((l) => l === "page.evaluate")).toEqual([]);
    expect(files()).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("a test.info() that answers nonsense counts as no test", async () => {
    const w = new Wrapper({ testInfo: () => null as unknown as TestInfoLike, options: { runtimeDir, outDir }, note: (l) => void notes.push(l), contexts });
    w.wrapBrowserType(pw.chromium);
    const context = await (await pw.chromium.launch()).newContext();
    expect(context.instrumented()).toBe(false);
    await context.close();
    expect(files()).toEqual([]);
  });
});

describe("wrap: a context created while a test runs", () => {
  it("gets the binding, the runtime's route, the agent route and the init script before newContext returns; no chaos route without chaos", async () => {
    start();
    current = fakeTestInfo(root);
    const context = await (await pw.chromium.launch()).newContext();
    // the context's binding has a name of its own, which the page script is told
    expect([...context.exposed.keys()]).toEqual([CONTEXT_BINDING]);
    expect(CONTEXT_BINDING).not.toBe(BINDING);
    expect(context.routes.map((r) => r.pattern)).toEqual([`**${RUNTIME_PATH}**`, `${AGENT_URL}/**`]);
    expect(context.initScripts).toHaveLength(1);
    expect(context.initScripts[0]).toContain(`"binding":"${CONTEXT_BINDING}"`);
    expect(context.initScripts[0]).toContain("/* the script-tag build */");
    expect(context.initScripts[0]).toContain('mode: "observe"');
    expect(context.initScripts[0]).toContain("telemetry: false");
    expect(context.initScripts[0]).toContain('"model":false');
    expect(contexts.has(context)).toBe(true);
    expect(notes).toEqual([]);
  });

  it("with chaos: the chaos route is registered first, and the file carries the settings and the seed plus the repeat index", async () => {
    start({ chaos: { seed: 10, delayMs: [0, 0], reorder: false, match: ["/api", "https://api.example.test/"] } });
    current = fakeTestInfo(root, { repeatEachIndex: 1 });
    const context = await (await pw.chromium.launch()).newContext();
    expect(context.routes.map((r) => r.pattern)).toEqual(["**/*", `**${RUNTIME_PATH}**`, `${AGENT_URL}/**`]);
    // a matched request is planned (held for 0 ms here) and passed on
    const passed: string[] = [];
    const route = { fulfill: async () => undefined, fallback: async () => void passed.push("fallback"), abort: async () => undefined };
    const request = { url: () => "http://app.test/api/search?q=a", method: () => "GET", resourceType: () => "fetch", headers: () => ({}), frame: () => ({ url: () => "http://app.test/" }) };
    await context.routes[0].handler(route, request);
    expect(passed).toEqual(["fallback"]);
    await context.newPage();
    await context.close();
    const name = "chromium-checkout-spec-ts-checkout-places-one-order-a1b2c3-d4e5f6-s11.json";
    expect(files()).toEqual([name]);
    expect(read(name)).toMatchObject({ seed: 11, chaos: { latencyMs: [0, 0], reorder: false, routes: ["/api", "https://api.example.test/"] }, fixture: { model: "skip", agent: null, chaosApplied: 1 } });
  });

  it("chaos true means the defaults; the model option reaches the page", async () => {
    start({ chaos: true, model: "load", modelUrl: "/models/" });
    current = fakeTestInfo(root);
    const context = await (await pw.chromium.launch()).newContext();
    expect(context.initScripts[0]).toContain('"model":{"baseUrl":"/models/"}');
    await context.close();
    expect(read(FILE)).toMatchObject({ seed: 1, chaos: { latencyMs: [0, 600], reorder: true, routes: ["same host /api* or Accept: json"] }, fixture: { model: "load", chaosApplied: 0 } });
  });

  it("launchPersistentContext: the context it returns is instrumented, and its browser wrapped", async () => {
    start();
    current = fakeTestInfo(root);
    const context = await pw.chromium.launchPersistentContext("/tmp/profile", { locale: "fr-FR" });
    expect(pw.chromium.calls).toEqual([{ method: "launchPersistentContext", self: pw.chromium, args: ["/tmp/profile", { locale: "fr-FR" }] }]);
    expect(context.exposed.has(CONTEXT_BINDING)).toBe(true);
    expect((pw.protos.browser.newContext as Record<symbol, unknown>)[WRAPPED]).toBe(true);
    context.push({ t: "witness", witness: witness(1) });
    await context.close();
    expect(read(FILE).signatures).toHaveLength(1);
  });

  it("browser.newPage() goes through the wrapped newContext; closing that page closes, and collects from, its context", async () => {
    start();
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    const page = await browser.newPage();
    expect(page.context().exposed.has(CONTEXT_BINDING)).toBe(true);
    await page.close();
    expect(page.evaluated.map(question)).toEqual(["open", "collect"]);
    expect(files()).toEqual([FILE]);
  });
});

describe("wrap: one file per test, written before the context closes", () => {
  it("on close: every open page is asked, the file is written as the fixture writes it, then the original close runs with the caller's arguments", async () => {
    start();
    current = fakeTestInfo(root);
    const context = await (await pw.chromium.launch()).newContext();
    const page = await context.newPage();
    const popup = await context.newPage();
    popup.state = null; // about:blank: no collector
    context.push({ t: "status", mode: "observe", model: { state: "off", name: "none" } });
    context.push({ t: "agent", ok: true, reason: null });
    context.push({ t: "witness", witness: witness(1) });
    pw.log.length = 0;
    await context.close({ reason: "Test ended." });
    expect(pw.log).toEqual(["page.evaluate", "page.evaluate", "page.evaluate", "page.evaluate", "context.close"]);
    expect(page.evaluated[0]).toContain("__GENCLASS_PLAYWRIGHT__");
    expect(context.closeCalls).toEqual([[{ reason: "Test ended." }]]);
    expect(context.closed).toBe(true);
    expect(files()).toEqual([FILE]);
    expect(read(FILE)).toEqual({
      schema: "genclass-races/1",
      test: "[chromium] checkout.spec.ts > checkout > places one order",
      seed: 1,
      signatures: [
        {
          sig: "witness|overwrote-newer|GET /api/search",
          trigger: "witness",
          diagnosis: "overwrote-newer",
          op: "GET /api/search",
          confidence: 1,
          evidence: "The response of GET /api/search#1 wrote search.results over what newer GET /api/search#2, started 0.12s after GET /api/search#1, had written.",
          seeds: [1],
        },
      ],
      mode: "observe",
      model: { state: "off" },
      chaos: null,
      fixture: { model: "skip", agent: null, chaosApplied: null, serviceWorker: false },
      location: { file: "tests/checkout.spec.ts", line: 7 },
      status: "passed",
    });
    expect(notes).toEqual([]);
  });

  it("a test with two contexts and several pages gets one file: merged, rewritten as each context closes", async () => {
    start();
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    const a = await browser.newContext();
    const b = await browser.newContext();
    await a.newPage();
    await a.newPage();
    const pageB = await b.newPage();
    pageB.state = { ...PAGE_OK, serviceWorker: true };
    a.push({ t: "witness", witness: witness(1) });
    b.push({ t: "witness", witness: { kind: "identical-in-flight", by: "POST /api/orders#2", over: "POST /api/orders#1", gapMs: 30 } });
    b.push({ t: "record", record: { kind: "detection", trigger: "request", diagnosis: "duplicate", p: 0.97, detection: "likely", evidence: { message: "1 identical POST /api/orders request", subject: "POST /api/orders (#15)" } } });
    await a.close();
    expect(files()).toEqual([FILE]);
    // the context still open already counts with what its page handed over
    expect((read(FILE).signatures as { sig: string }[]).map((s) => s.sig)).toEqual(["request|duplicate|POST /api/orders", "witness|identical-in-flight|POST /api/orders", "witness|overwrote-newer|GET /api/search"]);
    expect(read(FILE).fixture).toMatchObject({ serviceWorker: false });
    await b.close();
    expect(files()).toEqual([FILE]);
    expect((read(FILE).signatures as { sig: string }[]).map((s) => s.sig)).toEqual(["request|duplicate|POST /api/orders", "witness|identical-in-flight|POST /api/orders", "witness|overwrote-newer|GET /api/search"]);
    expect(read(FILE).fixture).toEqual({ model: "skip", agent: null, chaosApplied: null, serviceWorker: true });
    expect(pw.log.filter((l) => l === "page.evaluate")).toHaveLength(6);
  });

  it("each test, each repeat and each retry has its own file; a test skipped in its body has none", async () => {
    start();
    const browser = await pw.chromium.launch();
    const run = async (over: Partial<TestInfoLike>): Promise<void> => {
      current = fakeTestInfo(root, over);
      const context = await browser.newContext();
      await context.newPage();
      await context.close();
    };
    await run({});
    await run({ repeatEachIndex: 1, testId: "a1b2c3-repeat" });
    await run({ retry: 1 });
    await run({ testId: "other-test", titlePath: ["checkout.spec.ts", "checkout", "another"] });
    await run({ testId: "skipped-test", status: "skipped" });
    expect(files()).toEqual([
      "chromium-checkout-spec-ts-checkout-another-other-test-s1.json",
      "chromium-checkout-spec-ts-checkout-places-one-order-a1b2c3-d4e5f6-s1-r1.json",
      FILE,
      "chromium-checkout-spec-ts-checkout-places-one-order-a1b2c3-repeat-s2.json",
    ]);
    expect(read("chromium-checkout-spec-ts-checkout-places-one-order-a1b2c3-repeat-s2.json").seed).toBe(2);
  });

  it("the pages of one context count as one: the agent state is the worst of those whose runtime started", () => {
    expect(mergePageStates([])).toBeNull();
    expect(mergePageStates([null, undefined, 3])).toBeNull();
    expect(mergePageStates([PAGE_OK, null])).toEqual({ mode: "observe", model: { state: "off" }, agent: null, serviceWorker: false });
    expect(mergePageStates([PAGE_OK, { ...PAGE_OK, agent: "Failed to fetch dynamically imported module", serviceWorker: true }])).toEqual({ mode: "observe", model: { state: "off" }, agent: "Failed to fetch dynamically imported module", serviceWorker: true });
    // a page whose runtime never started does not hide one that connected
    expect(mergePageStates([{ mode: null, model: null, agent: "not-loaded", serviceWorker: false }, PAGE_OK])).toMatchObject({ mode: "observe", agent: null });
    expect(mergePageStates([{ mode: null, model: null, agent: "not-loaded", serviceWorker: false }])).toEqual({ agent: "not-loaded", serviceWorker: false });
  });

  it("a context whose agent entry did not connect is in the file, even when another context's did", async () => {
    start();
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    const ok = await browser.newContext();
    const bad = await browser.newContext();
    const untouched = await browser.newContext(); // opened no http page: nothing started there
    await ok.newPage();
    (await bad.newPage()).state = { ...PAGE_OK, agent: "Failed to fetch dynamically imported module" };
    (await untouched.newPage()).state = null;
    await ok.close();
    await untouched.close();
    expect(read(FILE).fixture).toMatchObject({ agent: null });
    await bad.close();
    expect(read(FILE).fixture).toMatchObject({ agent: "Failed to fetch dynamically imported module" });
    expect(read(FILE).mode).toBe("observe");
  });

  it("a context is asked once: a close during the collection waits for the same one, a close after it goes straight to the original", async () => {
    start();
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    pw.log.length = 0;
    await Promise.all([context.close("first"), context.close("second")]);
    expect(page.evaluated.map(question)).toEqual(["open", "collect"]);
    // both waited for the one collection, and reached the original in the order they were made
    expect(pw.log).toEqual(["page.evaluate", "page.evaluate", "context.close", "context.close"]);
    expect(context.closeCalls).toEqual([["first"], ["second"]]);
    await context.close("third");
    await browser.close();
    expect(page.evaluated.map(question)).toEqual(["open", "collect"]);
    expect(context.closeCalls).toEqual([["first"], ["second"], ["third"]]);
    expect(files()).toEqual([FILE]);
  });

  it("a browser that closes while one of its contexts is being collected waits for that collection", async () => {
    start();
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    context.push({ t: "witness", witness: witness(1) });
    pw.log.length = 0;
    await Promise.all([context.close(), browser.close()]);
    expect(pw.log).toEqual(["page.evaluate", "page.evaluate", "context.close", "browser.close"]);
    expect(page.evaluated.map(question)).toEqual(["open", "collect"]);
    expect(read(FILE)).toMatchObject({ mode: "observe", fixture: { agent: null }, signatures: [{ sig: "witness|overwrote-newer|GET /api/search" }] });
  });

  it("browser.close() in the test collects from the contexts the test did not close, then closes", async () => {
    start();
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    const closedByTest = await browser.newContext();
    await closedByTest.newPage();
    await closedByTest.close();
    const left = await browser.newContext();
    const page = await left.newPage();
    left.push({ t: "witness", witness: witness(3) });
    pw.log.length = 0;
    expect(await browser.close({ reason: "Test ended." })).toBe('closed:[{"reason":"Test ended."}]');
    expect(pw.log).toEqual(["page.evaluate", "page.evaluate", "browser.close"]);
    expect(page.evaluated.map(question)).toEqual(["open", "collect"]);
    expect(left.closeCalls).toEqual([]);
    expect(read(FILE).signatures).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it("flush(), at the end of the process: a context still open gives what its pages handed over, without being asked", async () => {
    const w = start();
    current = fakeTestInfo(root);
    const context = await (await pw.chromium.launch()).newContext();
    const page = await context.newPage();
    context.push({ t: "status", mode: "observe", model: { state: "off" } });
    context.push({ t: "agent", ok: true, reason: null });
    context.push({ t: "witness", witness: witness(1) });
    expect(w.written()).toEqual([]);
    w.flush();
    expect(page.evaluated).toEqual([]);
    expect(w.written()).toEqual([join(outDir, FILE)]);
    expect(read(FILE)).toMatchObject({ mode: "observe", fixture: { agent: null }, signatures: [{ sig: "witness|overwrote-newer|GET /api/search" }] });
    // nothing is left to write a second time once every context was collected
    await context.close();
    rmSync(join(outDir, FILE));
    w.flush();
    expect(files()).toEqual([]);
  });
});

/** A witness on `path`: its signature is "witness|overwrote-newer|GET <path>", so each test's findings can be told apart. */
const witnessOn = (path: string): Record<string, unknown> => ({ kind: "overwrote-newer", subject: "cart.items", by: `GET ${path}#1`, over: `GET ${path}#2`, overKind: "request", gapMs: 50 });
const sigsOf = (name: string): string[] => (read(name).signatures as { sig: string }[]).map((s) => s.sig);
/** A test of a describe that shares things: its own id, title and line. */
const testOf = (id: string, over: Partial<TestInfoLike> = {}): TestInfoLike => fakeTestInfo(root, { testId: `test-${id}`, titlePath: ["checkout.spec.ts", "shared", id], line: 10 + id.charCodeAt(0), ...over });
const fileOf = (id: string): string => `chromium-checkout-spec-ts-shared-${id}-test-${id}-s1.json`;
/** The TestInfo with the method Playwright's own context fixture asks which hook is running (not public API). */
const inHook = (info: TestInfoLike, hook: unknown): TestInfoLike => Object.assign(info, { _currentHookType: typeof hook === "function" ? hook : () => hook });
/** A fetch the page sends through the context's chaos route: what became of it, and when the route let go of it. */
function send(context: FakeContext, path: string): { passed: string[]; done: Promise<void> } {
  const passed: string[] = [];
  const route = { fulfill: async () => void passed.push("fulfill"), fallback: async () => void passed.push("fallback"), abort: async () => void passed.push("abort") };
  const request = { url: () => `http://app.test${path}`, method: () => "GET", resourceType: () => "fetch", headers: () => ({}), frame: () => ({ url: () => "http://app.test/" }) };
  const chaos = context.routes.find((r) => r.pattern === "**/*");
  if (!chaos) throw new Error("the context has no chaos route");
  return { passed, done: Promise.resolve(chaos.handler(route, request)) };
}
/** Five seconds for every held request: a hold that is still there shows. */
const SLOW = { chaos: { delayMs: [5000, 5000] as const } };

describe("wrap: a context is one test's, or it is nobody's", () => {
  it("a context made while a beforeAll or afterAll hook runs is left exactly as Playwright made it; one made in a beforeEach or afterEach hook is the test's", async () => {
    start({ chaos: true });
    const browser = await pw.chromium.launch();
    for (const hook of ["beforeAll", "afterAll"]) {
      current = inHook(testOf("a"), hook);
      const context = await browser.newContext();
      const page = await context.newPage();
      const owned = await browser.newPage(); // browser.newPage() in the hook: the shared-page pattern
      const persistent = await pw.chromium.launchPersistentContext("/tmp/profile");
      for (const c of [context, owned.context(), persistent]) {
        expect(c.instrumented(), hook).toBe(false);
        expect(contexts.has(c), hook).toBe(false);
      }
      // the tests of the describe use them; whoever closes them, nothing is asked and nothing is written
      current = testOf("b");
      await context.close({ reason: "afterAll" });
      await owned.close();
      await persistent.close();
      expect(page.evaluated, hook).toEqual([]);
      expect(owned.evaluated, hook).toEqual([]);
      expect(context.closeCalls, hook).toEqual([[{ reason: "afterAll" }]]);
    }
    await browser.close();
    expect(pw.log.filter((l) => l === "page.evaluate")).toEqual([]);
    expect(files()).toEqual([]);
    // one line each time (worker.ts keeps one per worker)
    expect(new Set(notes)).toEqual(new Set([HOOK_NOTE]));
    expect(notes).toHaveLength(6);

    notes = [];
    const again = await pw.chromium.launch();
    for (const hook of ["beforeEach", "afterEach", undefined]) {
      current = inHook(testOf(String(hook).slice(0, 7).toLowerCase()), hook);
      const context = await again.newContext();
      expect(context.instrumented(), String(hook)).toBe(true);
      await context.newPage();
      await context.close();
    }
    expect(files()).toHaveLength(3);
    expect(notes).toEqual([]);
  });

  it("which hook is running is read by shape: a missing method, one that throws or one that answers something else means no hook", async () => {
    expect(hookOf(testOf("a"))).toBeUndefined();
    expect(hookOf(inHook(testOf("a"), "beforeAll"))).toBe("beforeAll");
    expect(hookOf(inHook(testOf("a"), undefined))).toBeUndefined();
    expect(hookOf(inHook(testOf("a"), 7))).toBeUndefined();
    expect(hookOf(inHook(testOf("a"), null))).toBeUndefined();
    expect(
      hookOf(
        inHook(testOf("a"), () => {
          throw new Error("renamed in a later Playwright");
        }),
      ),
    ).toBeUndefined();
    // a field of that name is not the method
    expect(hookOf(Object.assign(testOf("a"), { _currentHookType: "beforeAll" }))).toBeUndefined();
    // the method is called on the TestInfo, as Playwright's needs
    expect(hookOf(Object.assign(testOf("a"), { slot: "afterAll", _currentHookType(this: { slot: string }) { return this.slot; } }))).toBe("afterAll");
    // a throwing method does not stop the context from being the test's
    start();
    current = inHook(testOf("a"), () => {
      throw new Error("renamed in a later Playwright");
    });
    const context = await (await pw.chromium.launch()).newContext();
    expect(context.instrumented()).toBe(true);
    expect(notes).toEqual([]);
  });

  it("a context kept for later tests: what it hands over while another test runs is dropped, its holds are released, it is not asked at its close, and nothing is filed under another test", async () => {
    const w = start(SLOW);
    const browser = await pw.chromium.launch();
    current = testOf("a");
    const shared = await browser.newContext(); // a worker-scoped fixture, or a variable the next tests reuse
    const page = await shared.newPage();
    shared.push({ t: "status", mode: "observe", model: { state: "off" } });
    shared.push({ t: "agent", ok: true, reason: null });
    shared.push({ t: "witness", witness: witnessOn("/api/a") });
    const held = send(shared, "/api/a");
    await new Promise((r) => setTimeout(r, 20));
    expect(held.passed).toEqual([]); // test a's chaos holds test a's request
    expect(files()).toEqual([]);

    // test b runs; nobody closed the context, and b's page uses it
    current = testOf("b");
    shared.push({ t: "witness", witness: witnessOn("/api/b") });
    const t0 = Date.now();
    await held.done;
    expect(held.passed).toEqual(["fallback"]); // released, not dropped
    const later = send(shared, "/api/b");
    await later.done;
    expect(later.passed).toEqual(["fallback"]);
    expect(Date.now() - t0).toBeLessThan(1000);
    // the runtime's files are still served: the init script stays on the context, and the page asks for them
    const served: unknown[] = [];
    await shared.routes.find((r) => r.pattern === `**${RUNTIME_PATH}**`)!.handler(
      { fulfill: async (o) => void served.push(o.status), fallback: async () => void served.push("fallback"), abort: async () => void served.push("abort") },
      { url: () => `http://app.test${RUNTIME_PATH}agent.js`, method: () => "GET", resourceType: () => "script", headers: () => ({}), frame: () => ({ url: () => "http://app.test/" }) },
    );
    expect(served).toEqual([200]);

    // test a's file: what the context handed over while a ran, and the one request a's chaos held
    expect(files()).toEqual([fileOf("a")]);
    expect(read(fileOf("a"))).toMatchObject({ test: "[chromium] checkout.spec.ts > shared > a", mode: "observe", fixture: { agent: null, chaosApplied: 1 }, location: { file: "tests/checkout.spec.ts", line: 10 + "a".charCodeAt(0) } });
    expect(sigsOf(fileOf("a"))).toEqual(["witness|overwrote-newer|GET /api/a"]);
    const written = readFileSync(join(outDir, fileOf("a")), "utf8");

    // test c is the last: the afterAll hook closes the context while c is the test running
    current = testOf("c");
    shared.push({ t: "witness", witness: witnessOn("/api/c") });
    shared.push({ t: "agent", ok: false, reason: "a failure in test c's time" });
    pw.log.length = 0;
    await shared.close({ reason: "afterAll" });
    expect(pw.log).toEqual(["context.close"]);
    expect(page.evaluated).toEqual([]);
    expect(shared.closeCalls).toEqual([[{ reason: "afterAll" }]]);
    await browser.close();
    w.flush();
    // b and c have no file, and a's was not touched again
    expect(files()).toEqual([fileOf("a")]);
    expect(readFileSync(join(outDir, fileOf("a")), "utf8")).toBe(written);
    expect(notes).toEqual([OUTLIVED_NOTE]);
  });

  it("the first sign can be a request: one sent while another test runs is passed on at once and not counted", async () => {
    start(SLOW);
    const browser = await pw.chromium.launch();
    current = testOf("a");
    const shared = await browser.newContext();
    await shared.newPage();
    const held = send(shared, "/api/a");
    current = testOf("b");
    const t0 = Date.now();
    const later = send(shared, "/api/b");
    await Promise.all([held.done, later.done]);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect([held.passed, later.passed]).toEqual([["fallback"], ["fallback"]]);
    expect(read(fileOf("a")).fixture).toMatchObject({ chaosApplied: 1 });
    expect(notes).toEqual([OUTLIVED_NOTE]);
  });

  it("a test that also had a context of its own: its file is written when that one closes and is not rewritten with later findings", async () => {
    const w = start();
    const browser = await pw.chromium.launch();
    current = testOf("a");
    const shared = await browser.newContext();
    await shared.newPage();
    const own = await browser.newContext(); // Playwright's page fixture
    await own.newPage();
    shared.push({ t: "witness", witness: witnessOn("/api/shared-in-a") });
    own.push({ t: "witness", witness: witnessOn("/api/own-in-a") });
    await own.close(); // the end of test a
    expect(sigsOf(fileOf("a"))).toEqual(["witness|overwrote-newer|GET /api/own-in-a", "witness|overwrote-newer|GET /api/shared-in-a"]);
    const written = readFileSync(join(outDir, fileOf("a")), "utf8");

    current = null; // between the tests
    shared.push({ t: "witness", witness: witnessOn("/api/between") });
    current = testOf("b");
    const ownB = await browser.newContext();
    await ownB.newPage();
    shared.push({ t: "witness", witness: witnessOn("/api/shared-in-b") });
    ownB.push({ t: "witness", witness: witnessOn("/api/own-in-b") });
    await ownB.close();
    current = null;
    await browser.close(); // the worker's teardown
    w.flush();
    expect(files()).toEqual([fileOf("a"), fileOf("b")]);
    expect(readFileSync(join(outDir, fileOf("a")), "utf8")).toBe(written);
    expect(sigsOf(fileOf("b"))).toEqual(["witness|overwrote-newer|GET /api/own-in-b"]);
    expect(notes).toEqual([OUTLIVED_NOTE]);
  });

  it("a context its test did not close: the next test's first context releases it, and its test's file has what it handed over while that test ran", async () => {
    start(SLOW);
    const browser = await pw.chromium.launch();
    current = testOf("a");
    const left = await browser.newContext();
    const page = await left.newPage();
    left.push({ t: "status", mode: "observe", model: { state: "off" } });
    left.push({ t: "agent", ok: true, reason: null });
    left.push({ t: "witness", witness: witnessOn("/api/a") });
    const held = send(left, "/api/a");
    expect(files()).toEqual([]);
    current = testOf("b");
    const t0 = Date.now();
    const next = await browser.newContext();
    await held.done; // no test waits for it any more
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(page.evaluated).toEqual([]);
    expect(read(fileOf("a"))).toMatchObject({ mode: "observe", fixture: { agent: null, chaosApplied: 1 } });
    expect(sigsOf(fileOf("a"))).toEqual(["witness|overwrote-newer|GET /api/a"]);
    await next.newPage();
    await next.close();
    expect(files()).toEqual([fileOf("a"), fileOf("b")]);
    expect(sigsOf(fileOf("b"))).toEqual([]);
    expect(notes).toEqual([OUTLIVED_NOTE]);
  });

  it("the close can be the first sign: closed in an afterAll hook while another test is the one running, a context is not asked, and its own test's file is written", async () => {
    start(SLOW);
    const browser = await pw.chromium.launch();
    current = testOf("a");
    const kept = await browser.newContext();
    const page = await kept.newPage();
    kept.push({ t: "witness", witness: witnessOn("/api/a") });
    const held = send(kept, "/api/a");
    current = inHook(testOf("c"), "afterAll"); // nothing happened on it since test a
    pw.log.length = 0;
    const t0 = Date.now();
    await kept.close({ reason: "afterAll" });
    await held.done;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(pw.log).toEqual(["context.close"]);
    expect(page.evaluated).toEqual([]);
    expect(kept.closeCalls).toEqual([[{ reason: "afterAll" }]]);
    expect(files()).toEqual([fileOf("a")]);
    expect(sigsOf(fileOf("a"))).toEqual(["witness|overwrote-newer|GET /api/a"]);
    expect(notes).toEqual([OUTLIVED_NOTE]);
  });

  it("the worker closes its browser after the last test: a context left open is not asked, and what it handed over while its test ran is written", async () => {
    start();
    current = testOf("a");
    const browser = await pw.chromium.launch();
    const left = await browser.newContext();
    const page = await left.newPage();
    left.push({ t: "witness", witness: witnessOn("/api/a") });
    current = null; // no test is running
    pw.log.length = 0;
    expect(await browser.close({ reason: "Test ended." })).toBe('closed:[{"reason":"Test ended."}]');
    expect(pw.log).toEqual(["browser.close"]);
    expect(page.evaluated).toEqual([]);
    expect(files()).toEqual([fileOf("a")]);
    expect(sigsOf(fileOf("a"))).toEqual(["witness|overwrote-newer|GET /api/a"]);
    expect(notes).toEqual([OUTLIVED_NOTE]);
  });

  it("at the end of the process with no test running: a context left open is released, not asked, and its test's file has what it handed over while the test ran", async () => {
    const w = start(SLOW);
    const browser = await pw.chromium.launch();
    current = testOf("a");
    const left = await browser.newContext();
    const page = await left.newPage();
    left.push({ t: "witness", witness: witnessOn("/api/a") });
    const held = send(left, "/api/a");
    current = null;
    expect(files()).toEqual([]);
    const t0 = Date.now();
    w.flush();
    await held.done;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(page.evaluated).toEqual([]);
    expect(files()).toEqual([fileOf("a")]);
    expect(sigsOf(fileOf("a"))).toEqual(["witness|overwrote-newer|GET /api/a"]);
    expect(notes).toEqual([OUTLIVED_NOTE]);
    // nothing is left to write a second time, and a context made with no test running is left alone
    rmSync(join(outDir, fileOf("a")));
    w.flush();
    expect(files()).toEqual([]);
    expect((await browser.newContext()).instrumented()).toBe(false);
  });

  it("at the end of the process in the middle of a test: the running test's context gives what it has so far, an earlier test's only its own", async () => {
    const w = start();
    const browser = await pw.chromium.launch();
    current = testOf("a");
    const earlier = await browser.newContext();
    earlier.push({ t: "witness", witness: witnessOn("/api/a") });
    current = testOf("b");
    const running = await browser.newContext();
    const page = await running.newPage();
    earlier.push({ t: "witness", witness: witnessOn("/api/earlier-in-b") });
    running.push({ t: "witness", witness: witnessOn("/api/b") });
    w.flush();
    expect(page.evaluated).toEqual([]);
    expect(files()).toEqual([fileOf("a"), fileOf("b")]);
    expect(sigsOf(fileOf("a"))).toEqual(["witness|overwrote-newer|GET /api/a"]);
    expect(sigsOf(fileOf("b"))).toEqual(["witness|overwrote-newer|GET /api/b"]);
    expect(notes).toEqual([OUTLIVED_NOTE]);
  });

  it("without the hook method (another Playwright): a context made in beforeAll counts for the first test while that test runs, and for no other", async () => {
    start();
    const browser = await pw.chromium.launch();
    current = testOf("a"); // Playwright runs beforeAll with the first test current
    const shared = await browser.newContext();
    const page = await shared.newPage();
    shared.push({ t: "witness", witness: witnessOn("/api/a") });
    current = testOf("b");
    shared.push({ t: "witness", witness: witnessOn("/api/b") });
    current = testOf("c");
    shared.push({ t: "witness", witness: witnessOn("/api/c") });
    await page.close();
    await shared.close(); // afterAll, with the last test current
    expect(page.evaluated).toEqual([]);
    expect(files()).toEqual([fileOf("a")]);
    expect(sigsOf(fileOf("a"))).toEqual(["witness|overwrote-newer|GET /api/a"]);
    expect(read(fileOf("a")).location).toEqual({ file: "tests/checkout.spec.ts", line: 10 + "a".charCodeAt(0) });
  });

  it("a first test skipped in its body writes nothing, and takes nothing of the later tests with it", async () => {
    start();
    const browser = await pw.chromium.launch();
    const a = testOf("a");
    current = a;
    const shared = await browser.newContext();
    shared.push({ t: "witness", witness: witnessOn("/api/a") });
    a.status = "skipped"; // test.skip() in the body
    current = testOf("b");
    const own = await browser.newContext();
    shared.push({ t: "witness", witness: witnessOn("/api/shared-in-b") });
    own.push({ t: "witness", witness: witnessOn("/api/b") });
    await own.close();
    await shared.close();
    expect(files()).toEqual([fileOf("b")]);
    expect(sigsOf(fileOf("b"))).toEqual(["witness|overwrote-newer|GET /api/b"]);
  });

  it("a close that began while the test ran is finished as it began, and what arrives after the test is still dropped", async () => {
    start();
    current = testOf("a");
    const context = await (await pw.chromium.launch()).newContext();
    const page = await context.newPage();
    page.fail = "hang"; // the collection takes its 2 s
    context.push({ t: "witness", witness: witnessOn("/api/a") });
    const closing = context.close(); // not awaited by the test
    current = testOf("b");
    context.push({ t: "witness", witness: witnessOn("/api/b") });
    await closing;
    expect(context.closed).toBe(true);
    expect(files()).toEqual([fileOf("a")]);
    expect(sigsOf(fileOf("a"))).toEqual(["witness|overwrote-newer|GET /api/a"]);
    expect(notes).toEqual([]);
  });
});

describe("wrap: the pages of a context share one binding", () => {
  const name = (id: string): string => `chromium-checkout-spec-ts-checkout-places-one-order-${id}-s1.json`;

  it("a page whose agent entry did not connect is in the file even when it was closed before the context, and whichever page reported last", async () => {
    start();
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    const context = await browser.newContext();
    const main = await context.newPage();
    const popup = await context.newPage();
    context.push({ t: "status", mode: "observe", model: { state: "off" } }, main);
    context.push({ t: "status", mode: "observe", model: { state: "off" } }, popup);
    context.push({ t: "agent", ok: false, reason: "Failed to fetch dynamically imported module" }, popup); // a CSP, a catch-all route
    context.push({ t: "agent", ok: true, reason: null }, main); // the main page, later
    await popup.close();
    expect(context.pages()).toEqual([main]);
    await context.close(); // only the main page answers, with agent null
    expect(popup.evaluated).toEqual([]);
    expect(main.evaluated.map(question)).toEqual(["open", "collect"]);
    expect(read(FILE)).toMatchObject({ mode: "observe", fixture: { agent: "Failed to fetch dynamically imported module" } });

    // no page left to answer at the close: the same
    current = fakeTestInfo(root, { testId: "all-closed" });
    const second = await browser.newContext();
    const failed = await second.newPage();
    const fine = await second.newPage();
    second.push({ t: "status", mode: "observe", model: { state: "off" } }, failed);
    second.push({ t: "agent", ok: false, reason: "no-connectAgent" }, failed);
    second.push({ t: "agent", ok: true, reason: null }, fine);
    await failed.close();
    await fine.close();
    await second.close();
    expect(read(name("all-closed")).fixture).toMatchObject({ agent: "no-connectAgent" });

    // every page connected: connected
    current = fakeTestInfo(root, { testId: "all-connected" });
    const third = await browser.newContext();
    const one = await third.newPage();
    const two = await third.newPage();
    third.push({ t: "agent", ok: true, reason: null }, one);
    third.push({ t: "agent", ok: true, reason: null }, two);
    await two.close();
    await third.close();
    expect(read(name("all-connected")).fixture).toMatchObject({ agent: null });
    expect(notes).toEqual([]);
  });

  it("a page counts with what it reported last, as the fixture's one page does: a first document whose agent entry was blocked, then one that connected", async () => {
    const w = start();
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    // the same page: a sign-in page whose Content-Security-Policy blocks the agent entry, then the app
    const context = await browser.newContext();
    const page = await context.newPage();
    context.push({ t: "status", mode: "observe", model: { state: "off" } }, page);
    context.push({ t: "agent", ok: false, reason: "Failed to fetch dynamically imported module" }, page);
    context.push({ t: "agent", ok: true, reason: null }, page);
    await context.close();
    expect(read(FILE).fixture).toMatchObject({ agent: null });

    // the other way round: connected first, then a document where it did not; also for a page closed since
    current = fakeTestInfo(root, { testId: "ended-blocked" });
    const second = await browser.newContext();
    const ended = await second.newPage();
    const other = await second.newPage();
    second.push({ t: "agent", ok: true, reason: null }, ended);
    second.push({ t: "agent", ok: false, reason: "not-dev-host" }, ended);
    second.push({ t: "agent", ok: true, reason: null }, other);
    await ended.close();
    await second.close();
    expect(read(name("ended-blocked")).fixture).toMatchObject({ agent: "not-dev-host" });

    // the same without asking the pages (a context still open when the process ends)
    current = fakeTestInfo(root, { testId: "still-open" });
    const open = await browser.newContext();
    const a = await open.newPage();
    const b = await open.newPage();
    open.push({ t: "status", mode: "observe", model: { state: "off" } }, a);
    open.push({ t: "agent", ok: false, reason: "not-dev-host" }, a);
    open.push({ t: "agent", ok: true, reason: null }, b);
    w.flush();
    expect(read(name("still-open"))).toMatchObject({ mode: "observe", fixture: { agent: "not-dev-host" } });
    open.push({ t: "agent", ok: true, reason: null }, a); // page a went on to a document that connected
    w.flush();
    expect(read(name("still-open")).fixture).toMatchObject({ agent: null });

    // a caller whose page is not known is never taken back
    current = fakeTestInfo(root, { testId: "unknown-caller" });
    const fourth = await browser.newContext();
    const binding = fourth.exposed.get(CONTEXT_BINDING)!;
    binding({}, { t: "agent", ok: false, reason: "no-connectAgent" });
    binding(undefined, { t: "agent", ok: true, reason: null });
    await fourth.close();
    expect(read(name("unknown-caller")).fixture).toMatchObject({ agent: "no-connectAgent" });
  });

  it("a page whose runtime did not start does not take away the mode a started page reported; alone, it leaves the file without one", async () => {
    const w = start();
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    const context = await browser.newContext();
    const started = await context.newPage();
    const broken = await context.newPage();
    broken.state = null;
    context.push({ t: "status", mode: "observe", model: { state: "off", name: "none" } }, started);
    context.push({ t: "agent", ok: true, reason: null }, started);
    context.push({ t: "status", mode: null, model: null, error: "the build threw on this page" }, broken); // later
    await started.close(); // the started page is gone by the time the context closes
    await context.close();
    expect(read(FILE)).toMatchObject({ mode: "observe", model: { state: "off", name: "none" }, fixture: { agent: null } });

    // the same without asking the pages
    current = fakeTestInfo(root, { testId: "still-open" });
    const open = await browser.newContext();
    const one = await open.newPage();
    const two = await open.newPage();
    open.push({ t: "status", mode: "observe", model: { state: "off" } }, one);
    open.push({ t: "status", mode: null, model: null }, two);
    w.flush();
    expect(read(name("still-open")).mode).toBe("observe");

    // only a page whose runtime never started: no mode, as before
    current = fakeTestInfo(root, { testId: "never-started" });
    const never = await browser.newContext();
    const page = await never.newPage();
    page.state = null;
    never.push({ t: "status", mode: null, model: null, error: "boom" }, page);
    await never.close();
    const file = read(name("never-started"));
    expect(file.mode).toBeUndefined();
    expect(file.fixture).toMatchObject({ agent: "not-loaded" });
  });
});

describe("wrap: next to the fixture (a page-level install on a context the entry covers)", () => {
  const g = globalThis as unknown as Record<symbol, unknown>;

  it("the context's binding has its own name, so a page-level install does not collide with it: Playwright refuses a name the context already has", async () => {
    start();
    current = fakeTestInfo(root);
    const context = await (await pw.chromium.launch()).newContext();
    const page = await context.newPage();
    // what one shared name would do (Playwright's rule, as the fake page has it)
    await expect(page.exposeFunction(CONTEXT_BINDING, () => undefined)).rejects.toThrow(`Function "${CONTEXT_BINDING}" has been already registered in the browser context`);
    // a copy of the fixture that cannot see the entry installs on the page: it does not throw into the test
    const before = g[REGISTER_KEY];
    delete g[REGISTER_KEY];
    try {
      const run = await startGenClass(page, { runtimeDir, outDir: join(root, "fixture-races") }, fakeTestInfo(root));
      expect([...page.exposed.keys()]).toEqual([BINDING]);
      expect(page.initScripts).toHaveLength(1);
      // both init scripts stop at the other's collector, so the runtime starts once on the page
      for (const script of [page.initScripts[0], context.initScripts[0]]) expect(script).toContain("if (w.__GENCLASS_PLAYWRIGHT__) return;");
      expect(page.initScripts[0]).toContain(`"binding":"${BINDING}"`);
      expect(context.initScripts[0]).toContain(`"binding":"${CONTEXT_BINDING}"`);
      await expect(run.finish()).resolves.toMatchObject({ path: expect.stringContaining("fixture-races") });
    } finally {
      if (before === undefined) delete g[REGISTER_KEY];
      else g[REGISTER_KEY] = before;
    }
    // the installer itself, on a second page of the same context
    const other = await context.newPage();
    await expect(install(other, { runtimeDir, model: "skip", chaos: null })).resolves.toBeDefined();
    await context.close();
    expect(notes).toEqual([]);
  });

  it("the fixture of this package sees the entry and leaves the page to it: nothing is installed on the page", async () => {
    start();
    current = fakeTestInfo(root);
    const context = await (await pw.chromium.launch()).newContext();
    const page = await context.newPage();
    const before = g[REGISTER_KEY];
    const state = { contexts, fixturePages: 0 };
    g[REGISTER_KEY] = state;
    try {
      const run = await startGenClass(page, { runtimeDir, chaos: true }, fakeTestInfo(root));
      expect(page.exposed.size + page.routes.length + page.initScripts.length).toBe(0);
      expect(await run.finish()).toEqual({ collected: null, file: null, path: null });
      expect(state.fixturePages).toBe(1);
    } finally {
      if (before === undefined) delete g[REGISTER_KEY];
      else g[REGISTER_KEY] = before;
    }
    await context.close();
    expect(files()).toEqual([FILE]);
  });
});

describe("wrap: never into the test run", () => {
  it("a context that cannot be instrumented is handed back as it is, with one note; its close is the plain close", async () => {
    start();
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    const exposeBinding = pw.protos.context.exposeBinding as (...a: unknown[]) => Promise<void>;
    pw.protos.context.exposeBinding = async function (): Promise<void> {
      throw new Error("browserContext.exposeBinding: Target closed");
    };
    const context = await browser.newContext();
    pw.protos.context.exposeBinding = exposeBinding;
    expect(context).toBe(browser.contexts()[0]);
    expect(notes).toEqual(["could not put GenClass on a browser context: browserContext.exposeBinding: Target closed"]);
    const page = await context.newPage();
    await context.close("as usual");
    expect(page.evaluated).toEqual([]);
    expect(context.closeCalls).toEqual([["as usual"]]);
    expect(files()).toEqual([]);
    // the fixture must not install on that context's pages either
    expect(contexts.has(context)).toBe(true);
  });

  it("a runtime that is not there: every context is left alone, the note is remembered", async () => {
    start({ runtimeDir: join(root, "nowhere") });
    current = fakeTestInfo(root);
    const context = await (await pw.chromium.launch()).newContext();
    expect(context.instrumented()).toBe(false);
    await context.close();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^could not put GenClass on a browser context: .*has no genclass\.global\.js/);
    expect(files()).toEqual([]);
  });

  it("pages that throw, are closed or never answer do not stop the close (a page that never answers costs the 2 s limit)", async () => {
    start();
    current = fakeTestInfo(root);
    const context = await (await pw.chromium.launch()).newContext();
    (await context.newPage()).fail = new Error("Execution context was destroyed, most likely because of a navigation");
    (await context.newPage()).fail = "hang"; // a dialog is open
    const closed = await context.newPage();
    closed.closed = true;
    context.push({ t: "witness", witness: witness(1) });
    const t0 = Date.now();
    await context.close();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(context.closed).toBe(true);
    expect(closed.evaluated).toEqual([]);
    expect(read(FILE).signatures).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it("a file that cannot be written is a note; the close still happens and resolves", async () => {
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "a file where the directory should be");
    start({ outDir: join(blocked, "genclass") });
    current = fakeTestInfo(root);
    const context = await (await pw.chromium.launch()).newContext();
    await context.newPage();
    await expect(context.close()).resolves.toBeUndefined();
    expect(context.closed).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^could not write the race file: /);
  });

  it("options the entry cannot use are a note per context, not a throw", async () => {
    start({ model: "cdn" as unknown as "skip" });
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    const context = await browser.newContext();
    expect(context.instrumented()).toBe(false);
    await context.close();
    await browser.close();
    expect(notes).toEqual(['could not put GenClass on a browser context: @genclass/playwright: genclass.model must be "skip" or "load" (got "cdn")']);
  });

  it("a context whose instrumentation never finishes is handed back after the limit, with one note, and the test goes on", async () => {
    start();
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    const exposeBinding = pw.protos.context.exposeBinding as (...a: unknown[]) => Promise<void>;
    pw.protos.context.exposeBinding = function (): Promise<void> {
      return new Promise<void>(() => undefined); // the browser never answers
    };
    vi.useFakeTimers();
    try {
      let handed: FakeContext | null = null;
      const pending = browser.newContext().then((c) => void (handed = c));
      await vi.advanceTimersByTimeAsync(ATTACH_CAP_MS - 1);
      expect(handed).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(handed).toBe(browser.contexts()[0]);
    } finally {
      vi.useRealTimers();
      pw.protos.context.exposeBinding = exposeBinding;
    }
    expect(ATTACH_CAP_MS).toBe(15_000);
    expect(notes).toEqual(["putting GenClass on a browser context took more than 15s; the test went on without waiting"]);
    const context = browser.contexts()[0];
    // it is still the entry's (the fixture must not install over a half-installed context), and closes as usual
    expect(contexts.has(context)).toBe(true);
    await context.close("as usual");
    expect(context.closeCalls).toEqual([["as usual"]]);
    expect(files()).toEqual([]);
  });

  it("a note that throws is swallowed too", async () => {
    const w = new Wrapper({
      testInfo: () => fakeTestInfo(root),
      options: { runtimeDir: join(root, "nowhere"), outDir },
      note: () => {
        throw new Error("the notes file is gone");
      },
    });
    w.wrapBrowserType(pw.chromium);
    const context = await (await pw.chromium.launch()).newContext();
    await expect(context.close()).resolves.toBeUndefined();
    expect(() => w.flush()).not.toThrow();
  });
});

describe("wrap: the test's status and the order of steps in its file", () => {
  it("the steps a context's pages hand over are in the file, and what landed after the test's own code is marked", async () => {
    start();
    const info = fakeTestInfo(root, { duration: 0 });
    current = info;
    const context = await (await pw.chromium.launch()).newContext();
    await context.newPage();
    const t = Date.now();
    context.push({ t: "steps", id: "load", from: 0, steps: [["a", t - 600, "click", 'button "Go"', ""], ["s", t - 500, "GET /api/a#1"], ["r", t - 400, "GET /api/a#1"]] });
    // Playwright sets the duration the moment the test's function returns: the wrapper notes when
    info.duration = 321;
    expect(Object.getOwnPropertyDescriptor(info, "duration")).toEqual({ value: 321, writable: true, enumerable: true, configurable: true });
    context.push({ t: "steps", id: "load", from: 3, steps: [["s", Date.now() + 500, "GET /api/b#1"]] });
    await context.close();
    const file = read(FILE) as { status?: string; steps?: { labels: string[]; order: string; body?: number } };
    expect(file.status).toBe("passed");
    expect(file.steps!.labels).toEqual(['click button "Go"', "GET /api/a", "GET /api/b"]);
    expect(file.steps!.order).toMatch(/^a0\.1\+0 s1\.1\+100 r1\.1\+100 s2\.1\+\d+$/);
    expect(file.steps!.body).toBe(3);
    expect(notes).toEqual([]);
  });

  it("steps off (the option): the file has none", async () => {
    start({ steps: false });
    current = fakeTestInfo(root);
    const context = await (await pw.chromium.launch()).newContext();
    await context.newPage();
    context.push({ t: "steps", id: "load", from: 0, steps: [["s", 1, "GET /api/a#1"]] });
    await context.close();
    expect("steps" in read(FILE)).toBe(false);
  });

  it("a test that closes its context itself and fails afterwards: its file is written again with the status it ended with", async () => {
    const w = start();
    const info = fakeTestInfo(root);
    current = info;
    const context = await (await pw.chromium.launch()).newContext();
    await context.newPage();
    context.push({ t: "witness", witness: witness(1) });
    await context.close();
    // the test's function is still running: the file says what was true then
    expect(read(FILE).status).toBe("passed");
    info.status = "failed";
    current = null;
    w.flush();
    expect(read(FILE)).toMatchObject({ status: "failed", signatures: [{ sig: "witness|overwrote-newer|GET /api/search" }] });
    expect(files()).toEqual([FILE]);
  });

  it("the next test's first context does the same for the test before it, and leaves a file whose status stands alone", async () => {
    start();
    const first = fakeTestInfo(root);
    current = first;
    const browser = await pw.chromium.launch();
    await (await browser.newContext()).close();
    first.status = "timedOut";
    const untouched = readFileSync(join(outDir, FILE), "utf8");
    expect(JSON.parse(untouched).status).toBe("passed");
    current = fakeTestInfo(root, { testId: "next-one", titlePath: ["checkout.spec.ts", "checkout", "next"] });
    const context = await browser.newContext();
    expect(read(FILE).status).toBe("timedOut");
    await context.close();
    expect(files()).toHaveLength(2);
    // a test whose status did not change is not written twice
    const second = files().find((f) => f !== FILE)!;
    const text = readFileSync(join(outDir, second), "utf8");
    writeFileSync(join(outDir, second), `${text} `);
    current = fakeTestInfo(root, { testId: "third", titlePath: ["checkout.spec.ts", "checkout", "third"] });
    await (await browser.newContext()).close();
    expect(readFileSync(join(outDir, second), "utf8")).toBe(`${text} `);
  });
});
