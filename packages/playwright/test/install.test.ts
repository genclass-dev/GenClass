// The installer (src/install.ts) on a fake page: what it registers, what the init script carries, how the runtime's
// files are served (and what is refused), how chaos routes behave, and what finish() collects. No browser.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_URL, BINDING, MAX_KEPT_STEPS, MAX_STREAMS, PAGE_CLOCK_SLACK_MS, WAIT_GRACE_MS, WAIT_POLL_MS, initScriptContent, install, isAgentUrl, resolveRuntimeDir, runtimeFile, type PageLike, type RequestLike, type RouteLike, type Session } from "../src/install.js";
import { RUNTIME_PATH, resolveChaos } from "../src/chaos.js";
import { here } from "./helpers.js";

type Handler = (route: RouteLike, request: RequestLike) => Promise<void> | void;

class FakePage implements PageLike {
  routes: { pattern: string; handler: Handler }[] = [];
  initScripts: string[] = [];
  exposed = new Map<string, (item: unknown) => unknown>();
  evaluateResult: unknown = null;
  evaluated: string[] = [];
  closed = false;
  async route(pattern: string, handler: Handler): Promise<void> {
    this.routes.push({ pattern, handler });
  }
  async addInitScript(s: { content: string }): Promise<void> {
    this.initScripts.push(s.content);
  }
  async exposeFunction(name: string, fn: (item: unknown) => unknown): Promise<void> {
    this.exposed.set(name, fn);
  }
  async evaluate(expression: string): Promise<unknown> {
    this.evaluated.push(expression);
    return this.evaluateResult;
  }
  isClosed(): boolean {
    return this.closed;
  }
  handler(pattern: string): Handler {
    const r = this.routes.find((x) => x.pattern === pattern);
    if (!r) throw new Error(`no route ${pattern}`);
    return r.handler;
  }
  push(item: unknown): void {
    this.exposed.get(BINDING)!(item);
  }
}

class FakeRoute implements RouteLike {
  calls: string[] = [];
  fulfilled: Parameters<RouteLike["fulfill"]>[0] | null = null;
  at = -1;
  async fulfill(o: Parameters<RouteLike["fulfill"]>[0]): Promise<void> {
    this.calls.push("fulfill");
    this.fulfilled = o;
  }
  async fallback(): Promise<void> {
    this.calls.push("fallback");
    this.at = Date.now();
  }
  async abort(code?: string): Promise<void> {
    this.calls.push(`abort:${code ?? ""}`);
  }
}

const request = (url: string, o: { method?: string; resourceType?: string; frameUrl?: string; accept?: string; body?: string | null } = {}): RequestLike => ({
  url: () => url,
  method: () => o.method ?? "GET",
  resourceType: () => o.resourceType ?? "fetch",
  headers: () => (o.accept ? { accept: o.accept } : {}),
  frame: () => ({ url: () => o.frameUrl ?? "http://app.test/page" }),
  ...(o.body !== undefined ? { postData: () => o.body ?? null } : {}),
});

let runtimeDir = "";
beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "genclass-rt-"));
  writeFileSync(join(runtimeDir, "genclass.global.js"), "/* the script-tag build */ window.__fakeGlobalRan = true;\n");
  writeFileSync(join(runtimeDir, "agent.js"), "export function connectAgent() {}\n");
  mkdirSync(join(runtimeDir, "cdn"));
  writeFileSync(join(runtimeDir, "cdn", "worker.js"), "// worker\n");
});
afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

describe("install: the runtime directory", () => {
  it("takes a given dist/ and refuses one without the script-tag build", () => {
    expect(resolveRuntimeDir(runtimeDir)).toBe(runtimeDir);
    const empty = mkdtempSync(join(tmpdir(), "genclass-empty-"));
    expect(() => resolveRuntimeDir(empty)).toThrow(/no genclass\.global\.js/);
    rmSync(empty, { recursive: true, force: true });
  });

  const built = existsSync(join(here, "..", "..", "runtime", "dist", "genclass.global.js"));
  it.runIf(built)("by default finds the installed @genclass/runtime's dist/", () => {
    const dir = resolveRuntimeDir();
    expect(dir.endsWith(join("runtime", "dist"))).toBe(true);
    expect(existsSync(join(dir, "agent.js"))).toBe(true);
  });

  it("maps a request on the virtual path to a file inside dist/, and nothing else", () => {
    expect(runtimeFile(runtimeDir, `http://app.test${RUNTIME_PATH}genclass.global.js`)).toBe(join(runtimeDir, "genclass.global.js"));
    expect(runtimeFile(runtimeDir, `http://app.test${RUNTIME_PATH}cdn/worker.js?x=1`)).toBe(join(runtimeDir, "cdn", "worker.js"));
    expect(runtimeFile(runtimeDir, `http://app.test${RUNTIME_PATH}../package.json`)).toBeNull();
    expect(runtimeFile(runtimeDir, `http://app.test${RUNTIME_PATH}cdn/..%2F..%2Fetc/passwd`)).toBeNull();
    expect(runtimeFile(runtimeDir, `http://app.test${RUNTIME_PATH}`)).toBeNull();
    expect(runtimeFile(runtimeDir, `http://app.test${RUNTIME_PATH}a b.js`)).toBeNull();
    expect(runtimeFile(runtimeDir, "http://app.test/other/agent.js")).toBeNull();
    expect(runtimeFile(runtimeDir, "not a url")).toBeNull();
  });
});

describe("install: what goes on the page", () => {
  it("one exposed function, the runtime route, the agent abort route and one init script; no chaos route without chaos", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: null });
    expect([...page.exposed.keys()]).toEqual([BINDING]);
    expect(page.routes.map((r) => r.pattern)).toEqual([`**${RUNTIME_PATH}**`, `${AGENT_URL}/**`]);
    expect(page.initScripts).toHaveLength(1);
    const script = page.initScripts[0];
    expect(script).toContain("/* the script-tag build */");
    expect(script).toContain(`"base":"${RUNTIME_PATH}"`);
    expect(script).toContain('"model":false');
    expect(script).toContain(`"agentUrl":"${AGENT_URL}"`);
    expect(script).toContain(`"binding":"${BINDING}"`);
    expect(script).toContain("__GENCLASS_PLAYWRIGHT__");
    expect(script).toContain('telemetry: false');
    expect(script).toContain('mode: "observe"');
    expect(script).toContain("hold: false");
    // the agent link gets a stand-in fetch for its own URL (no request, no console error), and no sink is configured
    expect(script).toContain("standIn");
    expect(script).not.toContain("sinks:");
    expect(script).toContain('"decide"');
    expect(script).toContain('setMode');
  });

  it("isAgentUrl: the agent's address only, not an app on 127.0.0.1:9xxx", () => {
    expect(isAgentUrl(AGENT_URL)).toBe(true);
    expect(isAgentUrl(`${AGENT_URL}/v1/hello`)).toBe(true);
    expect(isAgentUrl("http://127.0.0.1:9000/api/search")).toBe(false);
    expect(isAgentUrl("http://127.0.0.1:9323/")).toBe(false);
  });

  it("the init script is the page function applied to its config and the build, as plain JavaScript", () => {
    const content = initScriptContent(runtimeDir, { base: RUNTIME_PATH, model: { baseUrl: "/models/" }, agentUrl: AGENT_URL, binding: BINDING });
    expect(content.startsWith("(function genclassPageScript(cfg, runGlobal)")).toBe(true);
    expect(content).toContain('"model":{"baseUrl":"/models/"}');
    // it parses as a script (no TypeScript left in it)
    expect(() => new Function(content)).not.toThrow();
  });

  it("model load without a URL passes an empty model options object", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "load", chaos: null });
    expect(page.initScripts[0]).toContain('"model":{}');
  });

  it("serves the runtime's files from disk with the right content type, and 404 for anything else", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: null });
    const serve = page.handler(`**${RUNTIME_PATH}**`);
    const ok = new FakeRoute();
    await serve(ok, request(`http://app.test${RUNTIME_PATH}genclass.global.js`, { resourceType: "script" }));
    expect(ok.calls).toEqual(["fulfill"]);
    expect(ok.fulfilled).toMatchObject({ status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
    expect(String(ok.fulfilled!.body)).toContain("the script-tag build");
    const worker = new FakeRoute();
    await serve(worker, request(`http://app.test${RUNTIME_PATH}cdn/worker.js`, { resourceType: "other" }));
    expect(worker.fulfilled).toMatchObject({ status: 200 });
    for (const u of [`http://app.test${RUNTIME_PATH}missing.js`, `http://app.test${RUNTIME_PATH}../package.json`]) {
      const r = new FakeRoute();
      await serve(r, request(u));
      expect(r.fulfilled, u).toMatchObject({ status: 404 });
    }
  });

  it("aborts the page's agent link so it never reaches a bridge", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: null });
    const r = new FakeRoute();
    await page.handler(`${AGENT_URL}/**`)(r, request(`${AGENT_URL}/v1/hello`, { method: "POST" }));
    expect(r.calls).toEqual(["abort:connectionrefused"]);
  });
});

describe("install: chaos routes", () => {
  it("registers the chaos route first, so the runtime's files and the agent URL are matched before it", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [0, 0] }) });
    expect(page.routes.map((r) => r.pattern)).toEqual(["**/*", `**${RUNTIME_PATH}**`, `${AGENT_URL}/**`]);
  });

  it("leaves alone what is outside the filter: documents, scripts, cross-origin requests, the runtime's files, the agent URL", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [0, 0] }) });
    const chaos = page.handler("**/*");
    for (const [url, o] of [
      ["http://app.test/page", { resourceType: "document" }],
      ["http://app.test/app.js", { resourceType: "script" }],
      ["https://api.other.test/api/x", {}],
      [`http://app.test${RUNTIME_PATH}agent.js`, {}],
      [`${AGENT_URL}/v1/hello`, { method: "POST" }],
    ] as const) {
      const r = new FakeRoute();
      await chaos(r, request(url, o));
      expect(r.calls, url).toEqual(["fallback"]);
    }
  });

  it("holds a matched request for its planned time, then passes it on with fallback (never fetches it); unmatched ones go at once", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [40, 40] }) });
    const chaos = page.handler("**/*");
    const t0 = Date.now();
    const api = new FakeRoute();
    await chaos(api, request("http://app.test/api/items?page=2", { resourceType: "xhr" }));
    expect(api.calls).toEqual(["fallback"]);
    expect(api.at - t0).toBeGreaterThanOrEqual(35);
    const json = new FakeRoute();
    await chaos(json, request("http://app.test/graphql", { method: "POST", accept: "application/json" }));
    expect(json.calls).toEqual(["fallback"]);
    const t1 = Date.now();
    const stream = new FakeRoute();
    await chaos(stream, request("http://app.test/events", { accept: "text/event-stream" }));
    expect(stream.calls).toEqual(["fallback"]);
    expect(stream.at - t1).toBeLessThan(30);
    const c = await session.finish();
    expect(c.plans.map((p) => p.key)).toEqual(["GET /api/items#1", "POST /graphql#1"]);
    expect(c.plans.every((p) => p.delayMs === 40)).toBe(true);
  });

  it("holds nothing while the page says it is offline, and holds again when it is back", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [40, 40] }) });
    const chaos = page.handler("**/*");
    const timed = async (): Promise<number> => {
      const t0 = Date.now();
      const route = new FakeRoute();
      await chaos(route, request("http://app.test/api/notes", { method: "POST", body: "{}" }));
      expect(route.calls).toEqual(["fallback"]);
      return route.at - t0;
    };
    expect(await timed()).toBeGreaterThanOrEqual(35);
    page.push({ t: "net", online: false });
    expect(await timed()).toBeLessThan(30);
    expect(await timed()).toBeLessThan(30);
    page.push({ t: "net", online: true });
    expect(await timed()).toBeGreaterThanOrEqual(35);
  });

  it("holds a request to the page's own host on another port, and leaves another host alone", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [30, 30] }) });
    const chaos = page.handler("**/*");
    const t0 = Date.now();
    const api = new FakeRoute();
    await chaos(api, request("http://localhost:8080/api/discussions", { frameUrl: "http://localhost:3000/app" }));
    expect(api.calls).toEqual(["fallback"]);
    expect(api.at - t0).toBeGreaterThanOrEqual(25);
    const t1 = Date.now();
    const other = new FakeRoute();
    await chaos(other, request("https://api.example.com/api/discussions", { frameUrl: "http://localhost:3000/app" }));
    expect(other.calls).toEqual(["fallback"]);
    expect(other.at - t1).toBeLessThan(25);
    // a cross-origin request is keyed by host name and path, without the port
    expect((await session.finish()).plans.map((p) => p.key)).toEqual(["GET localhost/api/discussions#1"]);
  });

  it("an identical read and a write to the same path leave in the order the page sent them; a read with another query does not wait", async () => {
    const page = new FakePage();
    // seed 1 gives these keys different delays; whatever they are, the twin sent second must not leave first
    await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [0, 120] }) });
    const chaos = page.handler("**/*");
    const order: string[] = [];
    const send = async (name: string, url: string, o: Parameters<typeof request>[1]): Promise<void> => {
      const route = new FakeRoute();
      await chaos(route, request(url, o));
      order.push(name);
    };
    for (let round = 0; round < 6; round++) {
      order.length = 0;
      await Promise.all([
        send("plus 1", "http://app.test/api/counter/increment", { method: "POST", body: "{}" }),
        send("plus 2", "http://app.test/api/counter/increment", { method: "POST", body: "{}" }),
        send("plus 3", "http://app.test/api/counter/increment", { method: "POST", body: "{}" }),
        send("poll 1", "http://app.test/api/notifications", {}),
        send("poll 2", "http://app.test/api/notifications", {}),
      ]);
      const at = (n: string): number => order.indexOf(n);
      expect(at("plus 1")).toBeLessThan(at("plus 2"));
      expect(at("plus 2")).toBeLessThan(at("plus 3"));
      expect(at("poll 1")).toBeLessThan(at("poll 2"));
    }
    // two writes to one path keep their order whatever their bodies; two different reads are not tied to each other:
    // over a few rounds the second leaves first at least once
    let swapped = 0;
    for (let round = 0; round < 8; round++) {
      order.length = 0;
      await Promise.all([
        send("a", "http://app.test/api/search?q=r", {}),
        send("b", "http://app.test/api/search?q=re", {}),
        send("c", "http://app.test/api/notes", { method: "POST", body: '{"text":"offline-1"}' }),
        send("d", "http://app.test/api/notes", { method: "POST", body: '{"text":"offline-2"}' }),
      ]);
      expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
      if (order.indexOf("a") > order.indexOf("b")) swapped++;
    }
    expect(swapped).toBeGreaterThan(0);
  });

  it("keys requests in the order the page sent them, whatever order they are released in", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 7, delayMs: [0, 80] }) });
    const chaos = page.handler("**/*");
    const urls = ["a", "b", "c", "d"].map((q) => `http://app.test/api/search?q=${q}`);
    await Promise.all(urls.map((u) => chaos(new FakeRoute(), request(u))));
    const c = await session.finish();
    expect(c.plans.map((p) => p.key)).toEqual(["GET /api/search#1", "GET /api/search#2", "GET /api/search#3", "GET /api/search#4"]);
  });

  it("a page that closes while a request is held is not an error", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [0, 0] }) });
    const chaos = page.handler("**/*");
    const gone = new FakeRoute();
    gone.fallback = async () => {
      throw new Error("Target page, context or browser has been closed");
    };
    await expect(chaos(gone, request("http://app.test/api/x"))).resolves.toBeUndefined();
  });
});

describe("install: collecting", () => {
  it("keeps what the page pushes through the binding and what collect() returns at the end", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    page.push({ t: "status", mode: "observe", model: { state: "off", name: "none" } });
    page.push({ t: "record", record: { kind: "detection", diagnosis: "stale" } });
    page.push({ t: "witness", witness: { kind: "overwrote-newer" } });
    page.push({ t: "agent", ok: true, reason: null });
    page.push({ t: "status", mode: "observe", model: { state: "off", name: "none" }, overridden: "heal" });
    page.push({ t: "nonsense" });
    page.push(null);
    page.evaluateResult = { mode: "observe", model: { state: "off", name: "none", version: "0" }, agent: null, serviceWorker: true };
    const c = await session.finish();
    expect(page.evaluated).toHaveLength(1);
    expect(c).toEqual({ records: [{ kind: "detection", diagnosis: "stale" }], witnesses: [{ kind: "overwrote-newer" }], mode: "observe", model: { state: "off", name: "none", version: "0" }, agent: null, plans: [], serviceWorker: true, modeOverridden: "heal", streams: [], stepsOver: 0 });
  });

  it("keeps a specific reason the page pushed over collect()'s generic not-loaded", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    page.push({ t: "agent", ok: false, reason: "Failed to fetch dynamically imported module" });
    page.evaluateResult = { mode: "observe", model: { state: "off" }, agent: "not-loaded" };
    expect((await session.finish()).agent).toBe("Failed to fetch dynamically imported module");
  });

  it("a page that never started GenClass, or that is closed, or whose agent failed", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    page.push({ t: "status", mode: null, model: null, error: "boom" });
    page.push({ t: "agent", ok: false, reason: "not-dev-host" });
    page.closed = true;
    const c = await session.finish();
    expect(page.evaluated).toEqual([]);
    expect(c).toMatchObject({ records: [], witnesses: [], mode: null, model: null, agent: "not-dev-host" });
    const failing = new FakePage();
    const s2 = await install(failing, { runtimeDir, model: "skip", chaos: null });
    failing.evaluate = async () => {
      throw new Error("Execution context was destroyed");
    };
    await expect(s2.finish()).resolves.toMatchObject({ agent: "not-loaded" });
  });
});

describe("install: waiting for responses at the end of a test", () => {
  /** A page whose open() answers are scripted, one per question; the last one repeats. */
  class OpenPage extends FakePage {
    opens: unknown[] = [];
    asked = 0;
    override async evaluate(expression: string): Promise<unknown> {
      this.evaluated.push(expression);
      if (expression.includes(".open()")) {
        const answer = this.opens.length ? this.opens[Math.min(this.asked, this.opens.length - 1)] : null;
        this.asked++;
        return answer;
      }
      return this.evaluateResult;
    }
    count(what: ".open()" | ".collect()"): number {
      return this.evaluated.filter((e) => e.includes(what)).length;
    }
  }
  const open = (keys: [string, number][], id = "load-1"): unknown => ({ id, open: keys });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** finish(), with the clock moved on in 10 ms steps until it answers: how long it took, in ms of that clock. */
  async function finishIn(session: Session, budgetMs?: number): Promise<number> {
    const t0 = Date.now();
    let done = false;
    const p = session.finish(budgetMs).then(() => void (done = true));
    for (let i = 0; i < 2000 && !done; i++) await vi.advanceTimersByTimeAsync(10);
    await p;
    return Date.now() - t0;
  }

  it("asks nothing when the wait is off, and collects at once when nothing is in flight", async () => {
    const off = new OpenPage();
    off.opens = [open([["GET /api/a#1", 10]])];
    expect(await finishIn(await install(off, { runtimeDir, model: "skip", chaos: null }))).toBeLessThan(WAIT_POLL_MS);
    expect(await finishIn(await install(off, { runtimeDir, model: "skip", chaos: null, waitForResponsesMs: 0 }))).toBeLessThan(WAIT_POLL_MS);
    expect(off.count(".open()")).toBe(0);
    expect(off.count(".collect()")).toBe(2);

    const quiet = new OpenPage();
    quiet.opens = [open([])];
    expect(await finishIn(await install(quiet, { runtimeDir, model: "skip", chaos: null, waitForResponsesMs: 1600 }))).toBeLessThan(WAIT_POLL_MS);
    expect(quiet.count(".open()")).toBe(1);
    expect(quiet.count(".collect()")).toBe(1);
  });

  it("waits until the requests in flight at the end are answered, then a moment for their handlers, then collects", async () => {
    const page = new OpenPage();
    page.opens = [open([["GET /api/items/lamp#1", 80], ["GET /api/items/desk#1", 40]]), open([["GET /api/items/lamp#1", 120]]), open([["GET /api/items/lamp#1", 160]]), open([])];
    const session = await install(page, { runtimeDir, model: "skip", chaos: resolveChaos(true), waitForResponsesMs: 1600 });
    page.evaluateResult = { mode: "observe", model: { state: "off" }, agent: null };
    const ms = await finishIn(session);
    // three more questions 40 ms apart, then the grace
    expect(page.count(".open()")).toBe(4);
    expect(ms).toBeGreaterThanOrEqual(3 * WAIT_POLL_MS + WAIT_GRACE_MS);
    expect(ms).toBeLessThan(3 * WAIT_POLL_MS + WAIT_GRACE_MS + 60);
    // collected once, after the wait
    expect(page.count(".collect()")).toBe(1);
    expect(page.evaluated[page.evaluated.length - 1]).toContain(".collect()");
  });

  it("does not wait for requests the page sends during the wait, nor for another page load's", async () => {
    const page = new OpenPage();
    // the awaited request is answered; a poll sent meanwhile is still open
    page.opens = [open([["GET /api/search#5", 30]]), open([["GET /api/notifications#9", 5]])];
    const ms = await finishIn(await install(page, { runtimeDir, model: "skip", chaos: null, waitForResponsesMs: 1000 }));
    expect(ms).toBeLessThan(WAIT_POLL_MS + WAIT_GRACE_MS + 60);

    const navigated = new OpenPage();
    // the page navigated: the same key in a new page load is not the request that was awaited
    navigated.opens = [open([["GET /api/search#1", 30]], "load-1"), open([["GET /api/search#1", 10]], "load-2")];
    expect(await finishIn(await install(navigated, { runtimeDir, model: "skip", chaos: null, waitForResponsesMs: 1000 }))).toBeLessThan(WAIT_POLL_MS + WAIT_GRACE_MS + 60);
  });

  it("does not wait for a request sent longer ago than the wait itself (a stream, a long poll)", async () => {
    const page = new OpenPage();
    page.opens = [open([["GET /api/events#1", 45_000], ["GET /api/long-poll#3", 1601]])];
    expect(await finishIn(await install(page, { runtimeDir, model: "skip", chaos: null, waitForResponsesMs: 1600 }))).toBeLessThan(WAIT_POLL_MS);
    expect(page.count(".open()")).toBe(1);
  });

  it("gives up at the limit, and at the test's budget when that is less; a spent budget means no wait at all", async () => {
    const stuck = (): OpenPage => {
      const page = new OpenPage();
      page.opens = [open([["POST /api/orders#1", 20]])];
      return page;
    };
    const a = stuck();
    const whole = await finishIn(await install(a, { runtimeDir, model: "skip", chaos: null, waitForResponsesMs: 600 }));
    expect(whole).toBeGreaterThanOrEqual(600);
    expect(whole).toBeLessThan(700);
    expect(a.count(".collect()")).toBe(1);

    const b = stuck();
    const capped = await finishIn(await install(b, { runtimeDir, model: "skip", chaos: null, waitForResponsesMs: 600 }), 200);
    expect(capped).toBeGreaterThanOrEqual(200);
    expect(capped).toBeLessThan(300);

    const c = stuck();
    expect(await finishIn(await install(c, { runtimeDir, model: "skip", chaos: null, waitForResponsesMs: 600 }), 0)).toBeLessThan(WAIT_POLL_MS);
    expect(c.count(".open()")).toBe(0);
    expect(c.count(".collect()")).toBe(1);
  });

  it("a page that does not answer, answers nonsense, or closes during the wait ends the wait without an error", async () => {
    const mute = new OpenPage();
    mute.opens = [null];
    expect(await finishIn(await install(mute, { runtimeDir, model: "skip", chaos: null, waitForResponsesMs: 1600 }))).toBeLessThan(WAIT_POLL_MS);

    const odd = new OpenPage();
    odd.opens = [{ id: 7, open: "yes" }];
    expect(await finishIn(await install(odd, { runtimeDir, model: "skip", chaos: null, waitForResponsesMs: 1600 }))).toBeLessThan(WAIT_POLL_MS);

    const closing = new OpenPage();
    closing.opens = [open([["GET /api/a#1", 10]])];
    const session = await install(closing, { runtimeDir, model: "skip", chaos: null, waitForResponsesMs: 1600 });
    let done = false;
    const p = session.finish().then(() => void (done = true));
    await vi.advanceTimersByTimeAsync(20);
    closing.closed = true;
    for (let i = 0; i < 20 && !done; i++) await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(done).toBe(true);
    // a closed page is not asked what it collected
    expect(closing.count(".collect()")).toBe(0);
  });

  it("a browser context is asked page by page", async () => {
    const page = new OpenPage();
    const answers: unknown[][] = [[open([["GET /api/a#1", 10]], "p1"), open([["GET /api/b#1", 10]], "p2"), null], [open([], "p1"), open([["GET /api/b#1", 50]], "p2"), null], [open([], "p1"), open([], "p2")]];
    let asked = 0;
    const context = Object.assign(page, {
      evaluateEach: async (expression: string): Promise<unknown[]> => {
        page.evaluated.push(expression);
        return answers[Math.min(asked++, answers.length - 1)];
      },
    });
    const ms = await finishIn(await install(context, { runtimeDir, model: "skip", chaos: null, waitForResponsesMs: 1600 }));
    expect(asked).toBe(3);
    expect(ms).toBeGreaterThanOrEqual(2 * WAIT_POLL_MS + WAIT_GRACE_MS);
    expect(ms).toBeLessThan(2 * WAIT_POLL_MS + WAIT_GRACE_MS + 60);
  });
});

describe("install: the order of things on the page", () => {
  const steps = (id: unknown, from: number, ...raw: unknown[]) => ({ t: "steps", id, from, steps: raw });

  it("keeps the steps the page hands over, each at its place in its page load, whatever order the batches arrive in", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    page.push(steps("load-1", 2, ["r", 1040, "GET /api/a#1"]));
    page.push(steps("load-1", 0, ["a", 1000, "click", 'button "Go"', ""], ["s", 1001, "GET /api/a#1"]));
    // handed over a second time: what is there stands
    page.push(steps("load-1", 0, ["a", 9, "click", "again", ""]));
    // another page load, with two things that are no steps
    page.push(steps("load-2", 0, ["s", 2000, "GET /api/b#1"], ["nonsense"], ["s", "soon", "GET /api/c#1"]));
    // no page load to file them under: counted, not kept
    page.push(steps(7, 0, ["s", 1, "GET /x#1"]));
    page.push(steps("load-1", -1, ["s", 1, "GET /x#1"], ["r", 2, "GET /x#1"]));
    page.push({ t: "steps", id: "load-1", from: 0, steps: "none" });
    page.push({ t: "body", id: "load-1", n: 3 });
    page.push({ t: "body", id: "load-1", n: 1 });
    page.push({ t: "body", id: "load-2", n: "all" });
    const c = await session.finish(undefined, 5000);
    expect(c.streams).toEqual([
      { id: "load-1", steps: [{ kind: "a", at: 1000, name: 'click button "Go"' }, { kind: "s", at: 1001, name: "GET /api/a#1" }, { kind: "r", at: 1040, name: "GET /api/a#1" }], body: 3 },
      { id: "load-2", steps: [{ kind: "s", at: 2000, name: "GET /api/b#1" }] },
    ]);
    expect(c.stepsOver).toBe(3);
    expect(c.endedAt).toBe(5000);
    // asking again changes nothing, and the end is the one first given
    expect((await session.finish(undefined, 9000)).endedAt).toBe(5000);
  });

  it("a batch that says steps were lost before it marks the page load, at the earliest such place", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    page.push(steps("load-1", 0, ["s", 1000, "GET /api/a#1"]));
    page.push({ ...steps("load-1", 3, ["r", 1300, "GET /api/c#1"]), gap: true });
    page.push({ ...steps("load-1", 1, ["s", 1100, "GET /api/b#1"], ["s", 1200, "GET /api/c#1"]), gap: true });
    page.push({ ...steps("load-1", 4), gap: "yes" });
    page.push(steps("load-2", 0, ["s", 2000, "GET /api/d#1"]));
    const c = await session.finish();
    expect(c.streams.map((x) => [x.id, x.gap, x.steps.length])).toEqual([
      ["load-1", 1, 4],
      ["load-2", undefined, 1],
    ]);
  });

  it("a page whose clock is not this side's: its steps are timed by when they arrived", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    const before = Date.now();
    // a test that set the page's clock to 2030: the page's times are years away from this side's
    const far = Date.UTC(2030, 0, 1);
    page.push({ ...steps("load-1", 0, ["a", far, "click", 'button "Go"', ""], ["s", far + 5, "GET /api/a#1"]), now: far + 6 });
    // a page on this side's clock, within the slack: its own times stand
    page.push({ ...steps("load-2", 0, ["s", before - 40, "GET /api/b#1"]), now: before - 30 });
    // no word about the page's clock (an older page script): its times stand
    page.push(steps("load-3", 0, ["s", 123, "GET /api/c#1"]));
    const c = await session.finish();
    const after = Date.now();
    expect(PAGE_CLOCK_SLACK_MS).toBe(2000);
    for (const step of c.streams[0].steps) {
      expect(step!.at).toBeGreaterThanOrEqual(before);
      expect(step!.at).toBeLessThanOrEqual(after);
    }
    expect(c.streams[1].steps[0]!.at).toBe(before - 40);
    expect(c.streams[2].steps[0]!.at).toBe(123);
  });

  it("without a time for the end of the test's code none is made up", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    page.push(steps("load-1", 0, ["s", 1, "GET /api/a#1"]));
    const c = await session.finish();
    expect("endedAt" in c).toBe(false);
    expect((await session.finish(undefined, NaN)).endedAt).toBeUndefined();
  });

  it("a page load first heard of once the test's code is over began after it, unless the page says otherwise", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    page.push(steps("before", 0, ["s", 1, "GET /api/a#1"]));
    const done = session.finish();
    page.push(steps("after", 0, ["s", 50, "GET /api/b#1"]));
    page.push(steps("quiet", 0, ["s", 2, "GET /api/c#1"], ["r", 60, "GET /api/c#1"]));
    page.push({ t: "body", id: "quiet", n: 1 });
    const c = await done;
    expect(c.streams.map((x) => [x.id, x.body])).toEqual([
      ["before", undefined],
      ["after", 0],
      ["quiet", 1],
    ]);
  });

  it("keeps a bounded number of steps and of page loads, and counts the rest", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    for (let from = 0; from < MAX_KEPT_STEPS + 100; from += 50) page.push(steps("load-1", from, ...Array.from({ length: 50 }, (_, i) => ["s", from + i, `GET /api/r#${from + i + 1}`])));
    for (let i = 0; i < MAX_STREAMS + 5; i++) page.push(steps(`extra-${i}`, 0, ["s", 1, "GET /api/a#1"]));
    const c = await session.finish();
    expect(c.streams).toHaveLength(MAX_STREAMS);
    expect(c.streams[0].steps).toHaveLength(MAX_KEPT_STEPS);
    // 100 past the limit in the first page load, every step of the others (the limit was reached), six page loads too many
    expect(c.stepsOver).toBe(100 + MAX_STREAMS + 5);
  });

  it("nothing is kept once the test is no longer the one running; a snapshot is a copy", async () => {
    let live = true;
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null, live: () => live });
    page.push(steps("load-1", 0, ["s", 1, "GET /api/a#1"]));
    const snap = session.snapshot();
    live = false;
    page.push(steps("load-1", 1, ["r", 2, "GET /api/a#1"]));
    page.push({ t: "body", id: "load-1", n: 2 });
    expect(session.snapshot().streams).toEqual([{ id: "load-1", steps: [{ kind: "s", at: 1, name: "GET /api/a#1" }] }]);
    snap.streams[0].steps.length = 0;
    expect(session.snapshot().streams[0].steps).toHaveLength(1);
  });
});
