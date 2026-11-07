// The page script itself (src/page.ts, genclassPageScript), run against a fake window, runtime and agent entry: what
// it hands to Node for page errors and measured checks, how collect() waits for the quiet point and the checks' last
// pass, and that its own waits use the page's timer as it was before the runtime wrapped it. The function is
// serialised the way install.ts does it (toString); only its dynamic import is pointed at a fake agent module.

import { describe, expect, it } from "vitest";
import { genclassPageScript, type PageScriptConfig } from "../src/page.js";

interface Loaded {
  items: Record<string, unknown>[];
  win: Record<string, unknown>;
  timers: { fn: () => void; ms: number }[];
  fire(type: string, v: unknown): void;
  api(): { collect(settleMs?: number, checkMs?: number): Record<string, unknown> | Promise<Record<string, unknown>> };
  settleCalls: number[];
  checkNowCalls: number;
}

interface Options {
  visual?: boolean;
  reason?: string | null;
  settle?: (ms: number) => Promise<boolean>;
  checkNow?: () => Promise<unknown>;
  passes?: number;
  errors?: unknown[];
}

async function load(o: Options = {}): Promise<Loaded> {
  const items: Record<string, unknown>[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const listeners: Record<string, ((v: unknown) => void)[]> = {};
  const settleCalls: number[] = [];
  let checkNowCalls = 0;
  const rt = {
    mode: "observe",
    status: { state: "off" },
    on(type: string, fn: (v: unknown) => void) {
      (listeners[type] ??= []).push(fn);
      return () => undefined;
    },
    setMode() {},
    explain: () => null,
    summary: () => (o.passes ? { visual: { passes: o.passes } } : {}),
    checkNow: () => {
      checkNowCalls++;
      return o.checkNow ? o.checkNow() : Promise.resolve([]);
    },
  };
  const conn = {
    reason: o.reason === undefined ? null : o.reason,
    witnesses: () => [],
    errors: () => o.errors ?? [],
    whenSettled: (ms: number) => {
      settleCalls.push(ms);
      return o.settle ? o.settle(ms) : Promise.resolve(true);
    },
  };
  const win: Record<string, unknown> = {
    // the page's own timer before anything wraps it: the fixture's waits must go through this one
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    __genclassPlaywright: (item: Record<string, unknown>) => void items.push(item),
  };
  win.top = win;
  const location = { protocol: "http:", origin: "http://app.test" };
  const document = { createElement: () => ({ dataset: {} as Record<string, string> }) };
  const importAgent = () => Promise.resolve({ connectAgent: () => conn });
  // the page script as install.ts serialises it, with its dynamic import (however the test runner rewrote it) faked
  const src = genclassPageScript.toString().replace(/(^|[^\w$.])import\(/g, "$1__fakeImport(");
  const make = new Function("window", "location", "document", "navigator", "addEventListener", "__fakeImport", "__vite_ssr_dynamic_import__", `return (${src});`) as (...a: unknown[]) => typeof genclassPageScript;
  const pageScript = make(win, location, document, {}, () => undefined, importAgent, importAgent);
  const cfg: PageScriptConfig = { base: "/__genclass__/", model: false, agentUrl: "http://127.0.0.1:9", binding: "__genclassPlaywright", ...(o.visual ? { visual: true } : {}) };
  pageScript(cfg, () => {
    win.GenClass = { runtime: rt };
    // the runtime's observers wrap the page's timers when it starts: the fixture must not use this one
    win.setTimeout = () => {
      throw new Error("the fixture used the wrapped setTimeout");
    };
  });
  // the agent entry loads asynchronously
  await flush();
  return {
    items,
    win,
    timers,
    fire: (type, v) => {
      for (const fn of listeners[type] ?? []) fn(v);
    },
    api: () => win.__GENCLASS_PLAYWRIGHT__ as ReturnType<Loaded["api"]>,
    settleCalls,
    get checkNowCalls() {
      return checkNowCalls;
    },
  };
}

/** Lets every pending promise callback run (a macrotask turn). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const rec = { t: 1200, name: "TypeError", message: "Cannot read properties of undefined (reading 'items')", stack: "TypeError: x\n    at render (http://app.test/app.js:1:2)", chain: ["GET /api/search#3"], act: 2, source: "http://app.test/app.js" };

describe("page script: the configuration and the agent entry", () => {
  it("sets the checks off unless the fixture turned them on", async () => {
    expect(((await load()).win.GENCLASS_CONFIG as Record<string, unknown>).visual).toBe(false);
    expect(((await load({ visual: true })).win.GENCLASS_CONFIG as Record<string, unknown>).visual).toBe(true);
    const l = await load();
    expect(l.items.find((x) => x.t === "agent")).toEqual({ t: "agent", ok: true, reason: null });
  });
});

describe("page script: page errors", () => {
  it("hands each new error over once, with the page's origin, and only the fields races.ts reads", async () => {
    const errors: unknown[] = [rec];
    const l = await load({ errors });
    const first = l.items.filter((x) => x.t === "error");
    expect(first).toEqual([{ t: "error", error: { name: "TypeError", message: rec.message, stack: rec.stack, chain: ["GET /api/search#3"] }, pageOrigin: "http://app.test" }]);
    errors.push({ ...rec, name: "SyntaxError", stack: undefined });
    l.api().collect();
    l.api().collect();
    const all = l.items.filter((x) => x.t === "error");
    expect(all).toHaveLength(2);
    expect(all[1]).toEqual({ t: "error", error: { name: "SyntaxError", message: rec.message, stack: undefined, chain: ["GET /api/search#3"] }, pageOrigin: "http://app.test" });
  });
});

describe("page script: collect", () => {
  it("without arguments answers at once, as before", async () => {
    const l = await load();
    expect(l.api().collect()).toEqual({ mode: "observe", model: { state: "off" }, agent: null, serviceWorker: false });
    expect(l.settleCalls).toEqual([]);
  });

  it("with settleMs waits for the agent entry's quiet point and says whether it came", async () => {
    let release: (ok: boolean) => void = () => undefined;
    const l = await load({ settle: () => new Promise((r) => (release = r)) });
    let answer: Record<string, unknown> | null = null;
    void Promise.resolve(l.api().collect(2000, 0)).then((a) => (answer = a));
    await Promise.resolve();
    expect(answer).toBeNull();
    expect(l.settleCalls).toEqual([2000]);
    release(true);
    await flush();
    expect(answer).toEqual({ mode: "observe", model: { state: "off" }, agent: null, serviceWorker: false, settled: true });
    const failing = await load({ settle: () => Promise.reject(new Error("x")) });
    expect(await failing.api().collect(2000, 0)).toMatchObject({ settled: false });
  });

  it("an agent entry that did not connect has no quiet point to wait for: no settled", async () => {
    const l = await load({ reason: "not-dev-host" });
    expect(l.api().collect(2000, 0)).toEqual({ mode: "observe", model: { state: "off" }, agent: "not-dev-host", serviceWorker: false });
    expect(l.settleCalls).toEqual([]);
  });
});

describe("page script: measured checks", () => {
  it("hands over the kind, route, selector and numeric measurements only", async () => {
    const l = await load({ visual: true });
    l.fire("check", { id: "c1", source: "check", kind: "text-invisible", route: "/checkout", target: 'paragraph "Hello Jane"', selector: "main > p", message: "[GenClass] Check (measured): Hello Jane", details: ["Jane"], measured: { ratio: 1.04, fg: "#fff", ok: true, n: Number.NaN }, element: () => null });
    expect(l.items.filter((x) => x.t === "check")).toEqual([{ t: "check", check: { kind: "text-invisible", route: "/checkout", selector: "main > p", measured: { ratio: 1.04 } } }]);
    // with the checks off the event is not even listened to
    const off = await load();
    off.fire("check", { kind: "text-invisible" });
    expect(off.items.some((x) => x.t === "check")).toBe(false);
  });

  it("collect runs one more pass and says whether the checks ran", async () => {
    const ran = await load({ visual: true, passes: 2 });
    expect(await ran.api().collect(0, 2000)).toMatchObject({ visual: null });
    expect(ran.checkNowCalls).toBe(1);
    const none = await load({ visual: true });
    expect(await none.api().collect(0, 2000)).toMatchObject({ visual: "no pass ran" });
  });

  it("a pass that does not end is bounded by the page's own timer (never the wrapped one)", async () => {
    const l = await load({ visual: true, checkNow: () => new Promise(() => undefined) });
    let answer: Record<string, unknown> | null = null;
    void Promise.resolve(l.api().collect(0, 2000)).then((a) => (answer = a));
    await flush();
    expect(answer).toBeNull();
    const wait = l.timers.find((t) => t.ms === 2000);
    expect(wait).toBeDefined();
    wait!.fn();
    await flush();
    expect(answer).toMatchObject({ visual: "no pass ran" });
  });
});
