// genclass_explore {action:"wait"} (AGENT.md §4.2, §5.1): it blocks until every armed load of the session is in, with
// MCP progress, so an agent driving the loads with Playwright, or waiting for a person, never sleeps in a shell.
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { makeApi } from "../src/api.js";
import { serve, type Served } from "../src/server.js";
import { QUIET_MS, Store } from "../src/store.js";
import { callTool } from "../src/tools.js";
import { act, page, snap, tokenDir } from "./helpers.js";

/** A store on a fake clock, and the tool on it with a sleep that moves that clock. */
function setup() {
  let t = 1_000_000;
  const store = new Store({ now: () => t });
  const api = makeApi(store, { url: "http://127.0.0.1:47357", port: 47357 });
  const progress: [number, number | undefined, string | undefined][] = [];
  const slept: number[] = [];
  let onSleep: (() => void) | null = null;
  const tool = (args: Record<string, unknown>) =>
    callTool("genclass_explore", args, {
      api: async (m, p) => api(m, p),
      now: () => t,
      cwd: process.cwd(),
      env: {},
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
        onSleep?.();
      },
      progress: (p, total, message) => progress.push([p, total, message]),
    });
  const load = (route = "/search") => {
    const h = store.hello({ schema: "genclass-agent/1", page: { url: `http://localhost:5173${route}`, route } }, "http://localhost:5173")!;
    return { ...h, send: (events: unknown[]) => store.events({ run: h.run, token: h.token, events }, "http://localhost:5173") };
  };
  /** One load doing the scenario: a click, then a quiet point; `end`: the page went away (a fresh load next). */
  const scenario = (end = true) => {
    const l = load();
    l.send([{ t: "steps", steps: [act(0, "click", 'button "Go"')], order: [] }, { t: "snapshot", snapshot: snap({}, ["Done"]) }, ...(end ? [{ t: "end" }] : [])]);
    return l;
  };
  return { store, tool, load, scenario, progress, slept, tick: (ms: number) => (t += ms), onSleep: (f: () => void) => (onSleep = f) };
}

describe("explore wait: when a load is in (AGENT.md §5.1)", () => {
  it("returns at once when every armed load ended after its steps, and names the report", async () => {
    const s = setup();
    s.store.armExplore({ runs: 1 });
    for (let i = 0; i < 3; i++) s.scenario();
    const r = await s.tool({ action: "wait" });
    expect(r.text).toBe('Explore x1: all 3 loads in after 0 s. Next: genclass_explore {action:"report", id:"x1"}.');
    expect(s.slept).toEqual([]);
    expect(s.progress).toEqual([[3, 3, "3 of 3 loads in"]]);
  });

  it("waits for the loads still to come, with progress as they arrive", async () => {
    const s = setup();
    s.store.armExplore({ runs: 2 });
    s.scenario();
    let n = 1;
    // a load arrives every 2 s of the fake clock (one per 4 sleeps of 500 ms)
    s.onSleep(() => {
      if (s.slept.length % 4 === 0 && n < 4) {
        s.scenario();
        n++;
      }
    });
    const r = await s.tool({ action: "wait", timeout_s: 60 });
    expect(r.text).toContain("Explore x1: all 4 loads in after 6 s.");
    expect(s.progress.map((p) => p[2])).toEqual(["1 of 4 loads in", "2 of 4 loads in", "3 of 4 loads in", "4 of 4 loads in"]);
    expect(Math.max(...s.slept)).toBeLessThanOrEqual(500);
  });

  it("times out with what is missing: loads not started, and an open one still mid-scenario", async () => {
    const s = setup();
    s.store.armExplore({ runs: 2 });
    s.scenario();
    s.scenario();
    // the third load is open and has done none of the steps the others did: a person still typing
    s.load().send([{ t: "snapshot", snapshot: snap({}, ["Start"]) }]);
    const r = await s.tool({ action: "wait", timeout_s: 3 });
    expect(r.text).toContain("Explore x1: 2 of 4 loads in after 3 s (1 not started; r3 still open (steps or a quiet point to come)).");
    expect(r.text).toContain("then wait again, or genclass_explore {action:\"report\", id:\"x1\"} with what there is");
    expect(r.isError).toBeFalsy();
  });

  it("the last load still open counts once it did the steps the others did and stayed quiet", async () => {
    const s = setup();
    s.store.armExplore({ runs: 1 });
    s.scenario();
    s.scenario();
    s.scenario(false);
    expect(s.store.exploreProgress()!.in).toBe(2);
    s.tick(QUIET_MS);
    expect(s.store.exploreProgress()).toMatchObject({ in: 3, settled: 3, planned: 3 });
  });

  it("a load that unloaded before a quiet point is in (nothing more will come) and the answer says the report skips it", async () => {
    const s = setup();
    s.store.armExplore({ runs: 1 });
    s.scenario();
    s.scenario();
    s.load().send([{ t: "steps", steps: [act(0, "click", 'button "Go"')], order: [] }, { t: "end" }]);
    const r = await s.tool({ action: "wait" });
    expect(r.text).toContain("all 3 loads in after 0 s (2 reached a quiet point after their steps: the report compares those)");
  });

  it("a stopped or missing session, and the timeout's bounds", async () => {
    const s = setup();
    expect((await s.tool({ action: "wait" })).isError).toBe(true);
    s.store.armExplore({ runs: 1 });
    s.scenario();
    s.store.stopExplore();
    expect((await s.tool({ action: "wait" })).text).toContain("Explore x1 was stopped with 1 of 3 loads in");
    s.store.armExplore({ runs: 1 });
    const long = await s.tool({ action: "wait", timeout_s: 10_000 });
    expect(long.text).toContain("0 of 3 loads in after 300 s");
    const short = await s.tool({ action: "wait", timeout_s: 0 });
    expect(short.text).toContain("after 1 s");
  });

  it("an expired session says so instead of waiting", async () => {
    const s = setup();
    s.store.armExplore({ runs: 1 });
    s.tick(31 * 60_000);
    expect((await s.tool({ action: "wait" })).text).toContain("its armed loads expired (30 minutes after start)");
  });
});

/** A client on in-memory streams (the protocol, as mcp.test.ts drives it). */
function client() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, any>[] = [];
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    buf += c;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  const send = (m: Record<string, unknown>) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const wait = async (pred: (m: Record<string, any>) => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      const m = lines.find(pred);
      if (m) return m;
      if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(lines)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { input, output, lines, send, wait };
}

let served: Served | null = null;
afterEach(async () => {
  await served?.close();
  served = null;
});

describe("explore wait over MCP: progress and cancellation", () => {
  async function start() {
    const c = client();
    served = await serve({ cwd: process.cwd(), env: { GENCLASS_TOKEN_DIR: tokenDir() }, stdin: c.input, stdout: c.output, stderr: new PassThrough(), port: 0, stateDir: null });
    c.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await c.wait((m) => m.id === 1);
    c.send({ method: "notifications/initialized" });
    return { c, port: served.port };
  }

  it("a call with a progressToken gets notifications/progress as loads come in, then its answer", async () => {
    const { c, port } = await start();
    c.send({ id: 2, method: "tools/call", params: { name: "genclass_explore", arguments: { action: "start", runs: 1, route: "/w" } } });
    await c.wait((m) => m.id === 2);
    c.send({ id: 3, method: "tools/call", params: { name: "genclass_explore", arguments: { action: "wait", timeout_s: 20 }, _meta: { progressToken: "tok-1" } } });
    await c.wait((m) => m.method === "notifications/progress" && m.params.progress === 0);
    for (let i = 0; i < 3; i++) {
      const p = await page(port, "/w");
      await p.send([{ t: "steps", steps: [act(0, "click", 'button "Go"')], order: [] }, { t: "snapshot", snapshot: snap({}, ["ok"]) }, { t: "end" }]);
    }
    const done = await c.wait((m) => m.id === 3, 8000);
    expect(done.result.content[0].text).toContain("all 3 loads in");
    const prog = c.lines.filter((m) => m.method === "notifications/progress");
    expect(prog.every((m) => m.params.progressToken === "tok-1" && m.params.total === 3)).toBe(true);
    expect(prog.at(-1)!.params).toMatchObject({ progress: 3, message: "3 of 3 loads in" });
    const values = prog.map((m) => m.params.progress as number);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it("a cancelled wait stops and gets no answer; the server keeps answering", async () => {
    const { c } = await start();
    c.send({ id: 2, method: "tools/call", params: { name: "genclass_explore", arguments: { action: "start", runs: 1 } } });
    await c.wait((m) => m.id === 2);
    c.send({ id: 3, method: "tools/call", params: { name: "genclass_explore", arguments: { action: "wait", timeout_s: 60 } } });
    await new Promise((r) => setTimeout(r, 100));
    c.send({ method: "notifications/cancelled", params: { requestId: 3, reason: "user" } });
    c.send({ id: 4, method: "ping" });
    await c.wait((m) => m.id === 4);
    await new Promise((r) => setTimeout(r, 800));
    expect(c.lines.some((m) => m.id === 3)).toBe(false);
  });
});
