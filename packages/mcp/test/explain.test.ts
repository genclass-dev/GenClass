// genclass_explain and genclass_status on what the page reports (AGENT.md §4.2): one numbering for requests (the
// steps' keys, also in the model's text), no model block on an explore race, and the model state as it changes.
import { describe, expect, it } from "vitest";
import { makeApi } from "../src/api.js";
import { Store } from "../src/store.js";
import { callTool, quotedValues, withStepNames } from "../src/tools.js";
import { act, hello, snap } from "./helpers.js";

function setup() {
  const store = new Store({ now: () => 1_000_000 });
  const api = makeApi(store, { url: "http://127.0.0.1:47357", port: 47357 });
  const tool = (name: string, args: Record<string, unknown> = {}) => callTool(name, args, { api: async (m, p) => api(m, p), now: () => 1_000_000, cwd: process.cwd(), env: {} });
  const load = (route = "/search", body: Record<string, unknown> = {}) => {
    const h = store.hello({ ...hello(route), ...body }, "http://localhost:5173")!;
    return { ...h, send: (events: unknown[]) => store.events({ run: h.run, token: h.token, events }, "http://localhost:5173") };
  };
  return { store, tool, load };
}

const SITUATION = ["Trigger: delivery of GET /api/search?q=reac (#5, by #2)", "Timeline:", "+0.10s user type searchbox (2 keystrokes, #2–#4)", "+0.12s start GET /api/search?q=reac (#5, by #2)", "+0.14s start GET /api/search?q=react (#6, by #4)", "+0.30s start timer 300ms (#9, by #4)", 'Facts: the title "#5 seller" was shown'].join("\n");
const OPS: [number, string | number][] = [
  [2, 0],
  [4, 0],
  [5, "GET /api/search#1"],
  [6, "GET /api/search#2"],
];

describe("explain: one numbering (AGENT.md §4.2)", () => {
  it("withStepNames writes the model's operation numbers as the steps' names; numbers it does not know, and quoted text, stay", () => {
    const ops = Object.fromEntries(OPS.map(([k, v]) => [String(k), v]));
    const out = withStepNames(SITUATION, ops);
    expect(out).toContain("delivery of GET /api/search?q=reac (GET /api/search#1, by action 0)");
    expect(out).toContain("(2 keystrokes, action 0)");
    expect(out).toContain("(GET /api/search#2, by action 0)");
    expect(out).toContain("(#9, by action 0)"); // a timer has no step of its own
    expect(out).toContain('"#5 seller"');
    expect(withStepNames("User actions #2 and #7, 0.3 s apart", { "2": 0, "7": 1 })).toBe("User actions 0 and 1, 0.3 s apart");
    expect(withStepNames("a #3–#4 range", { "3": 0, "4": 1 })).toBe("a action 0–action 1 range");
    expect(withStepNames(SITUATION, undefined)).toBe(SITUATION);
  });

  it("a number inside a quoted page value is the page's data and stays, wherever it sits in the value (finding 68)", () => {
    const ops = { "3": "GET /api/orders#1", "4": 1, "7": 1, "5": "GET /api/search#1" };
    expect(withStepNames('+0.20s write order.title = "Order #3 shipped" (by #5)', ops)).toBe('+0.20s write order.title = "Order #3 shipped" (by GET /api/search#1)');
    expect(withStepNames('the user typed "ticket #7" and "pages #3–#4" (#4)', ops)).toBe('the user typed "ticket #7" and "pages #3–#4" (action 1)');
    expect(withStepNames('a value with a quote in it: "say \\"#3\\" twice" then #3', ops)).toBe('a value with a quote in it: "say \\"#3\\" twice" then GET /api/orders#1');
    // a value cut short before its closing quote does not swallow the next line
    expect(withStepNames('order.note = "Order is on its w…\n+0.30s start GET /x (#5) "done #3"', ops).split("\n")[1]).toBe('+0.30s start GET /x (GET /api/search#1) "done #3"');
  });

  it("a value the renderer cut short ends at its …, so the next quote on the line opens a value and the numbers between are renamed", () => {
    // the runtime's in-flight fact (situation/facts.ts: `#id ${truncate(detail, 30)} (started …)`), two POSTs with
    // different bodies: the first body cut short inside its quotes; round 1 paired its quote with the second body's
    const ops = { "4": "POST /api/todos#1", "6": "POST /api/todos#2", "8": "POST /api/todos#3", "3": "GET /api/orders#1", "5": "GET /api/search#1" };
    expect(withStepNames('#6 {title: "Buy milk and eggs f… (started 0.10s after #4); #8 {title: "x"} (started 0.10s after #4)', ops)).toBe(
      'POST /api/todos#2 {title: "Buy milk and eggs f… (started 0.10s after POST /api/todos#1); POST /api/todos#3 {title: "x"} (started 0.10s after POST /api/todos#1)',
    );
    // both bodies cut short: each value ends at its own …
    expect(withStepNames('#6 {title: "Buy milk and eggs f… (started 0.10s after #4); #8 {title: "Call the plumber a… (started 0.10s after #4)', ops)).toBe(
      'POST /api/todos#2 {title: "Buy milk and eggs f… (started 0.10s after POST /api/todos#1); POST /api/todos#3 {title: "Call the plumber a… (started 0.10s after POST /api/todos#1)',
    );
    expect(withStepNames('+0.20s write todos = 2 items [{title: "Buy milk and eggs from th… (by #6) "#3"', ops)).toBe('+0.20s write todos = 2 items [{title: "Buy milk and eggs from th… (by POST /api/todos#2) "#3"');
    // a … inside a closed value is the page's text, and the number after it stays: the line reads only one way
    expect(withStepNames('+0.20s write status = "Loading… order #3" (by #5)', ops)).toBe('+0.20s write status = "Loading… order #3" (by GET /api/search#1)');
    expect(withStepNames('a = "Loading… #3 left", b = "x", c = "y" (#5)', ops)).toBe('a = "Loading… #3 left", b = "x", c = "y" (GET /api/search#1)');
    expect(withStepNames('a = "Loading… #3 left", b = "Buy milk and eggs f… (by #5)', ops)).toBe('a = "Loading… #3 left", b = "Buy milk and eggs f… (by GET /api/search#1)');
    // a string the renderer shortened inside its quotes ("…" then the quote) is a closed value; a stray quote is text
    expect(withStepNames('#6 {t: "abc…"} (after #4) "x #3"', ops)).toBe('POST /api/todos#2 {t: "abc…"} (after POST /api/todos#1) "x #3"');
    expect(withStepNames('a stray " before #4', ops)).toBe('a stray " before POST /api/todos#1');
  });

  it("quotedValues reads a long line in one pass", () => {
    expect(quotedValues('"a" b "c… d "e"')).toEqual([
      [0, 3],
      [6, 9],
      [12, 15],
    ]);
    // a value of 50,000 escaped quotes closed by the first of 20,000 quotes; the other 19,999 pair up but the last, which
    // is text: a reading that scanned on from every quote would take minutes
    const line = '"' + '\\"'.repeat(50_000) + '" #4 '.repeat(20_000);
    const t = performance.now();
    expect(quotedValues(line).length).toBe(10_000);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it("a stale-write explanation shows the model's text in the steps' numbering, from the page's operation names", async () => {
    const { tool, load } = setup();
    const r = load();
    r.send([
      { t: "steps", steps: [act(0, "type", 'searchbox "Search"', "react"), { k: "send", t: 10, key: "GET /api/search#1", detail: "?q=reac", act: 0 }, { k: "send", t: 30, key: "GET /api/search#2", detail: "?q=react", act: 0 }], order: ["GET /api/search#2", "GET /api/search#1"], ops: OPS },
      { t: "witness", witness: { kind: "overwrote-newer", t: 900, subject: "search.results", by: "GET /api/search#1", over: "GET /api/search#2", overKind: "request", gapMs: 20 } },
      { t: "detection", at: 950, decision: { id: "d1", trigger: "delivery", subject: "the response to GET /api/search", diagnosis: "stale", diagnosisConfidence: 0.9, action: "discard", executed: false, detection: "likely", facts: ["the store changed since #5 started (by #6)"] }, explain: { situation: SITUATION } },
    ]);
    const ex = (await tool("genclass_explain", { id: "f1" })).text;
    expect(ex).toContain("## What the on-device model read last on this page");
    expect(ex).toContain("(its operation numbers written as the request keys and action numbers above)");
    expect(ex).toContain("+0.12s start GET /api/search?q=reac (GET /api/search#1, by action 0)");
    expect(ex).not.toMatch(/\(#5\b/);
    // the detection finding's facts too
    const det = (await tool("genclass_explain", { id: "f2" })).text;
    expect(det).toContain('fact: "the store changed since GET /api/search#1 started (by GET /api/search#2)"');
  });

  it("a page that sends no operation names (an older runtime) gets a line saying the two numberings differ", async () => {
    const { tool, load } = setup();
    load().send([{ t: "error", error: { t: 1, name: "TypeError", message: "boom", chain: [] } }, { t: "detection", decision: { id: "d1", trigger: "error", subject: "x", diagnosis: "bug", detection: "likely", facts: [] }, explain: { situation: "start GET /x (#3)" } }]);
    const ex = (await tool("genclass_explain", { id: "f1" })).text;
    expect(ex).toContain("(its #N number every operation of the page, clicks and requests together; they are not the numbers in the request keys above)");
    expect(ex).toContain("start GET /x (#3)");
  });

  it("an explore race's explanation leaves the model's text out: the comparison of whole runs is its evidence", async () => {
    const { store, tool, load } = setup();
    store.armExplore({ runs: 1, route: "/search" });
    const ends = ["react!", "react!", "reac!"];
    for (const v of ends) {
      const r = load();
      r.send([
        { t: "steps", steps: [act(0, "type", 'searchbox "Search"', "react")], order: [], ops: OPS },
        { t: "detection", decision: { id: "d1", trigger: "delivery", subject: "x", diagnosis: "stale", detection: "likely", facts: [] }, explain: { situation: SITUATION } },
        { t: "snapshot", snapshot: snap({ "search.results": v }, [`Results for ${v.slice(0, -1)}`]) },
      ]);
    }
    const rep = (await tool("genclass_explore", { action: "report" })).text;
    const id = /Race finding\(s\): (f\d+)/.exec(rep)![1];
    const ex = (await tool("genclass_explain", { id })).text;
    expect(ex).toContain("## Steps of run");
    expect(ex).not.toContain("What the on-device model read");
  });
});

describe("status: the model state as the page reports it (AGENT.md §4.1)", () => {
  it("a runtime event after hello updates the model state and mode genclass_status shows", async () => {
    const { tool, load } = setup();
    const r = load("/", { runtime: { mode: "observe", model: "off" } });
    expect((await tool("genclass_status")).text).toContain("model off, mode observe");
    expect(r.send([{ t: "runtime", runtime: { mode: "observe", model: "ready" } }])).toBe(1);
    expect((await tool("genclass_status")).text).toContain("model ready, mode observe");
    r.send([{ t: "runtime", runtime: { mode: "guard" } }]);
    expect((await tool("genclass_status")).text).toContain("model ready, mode guard");
    // nothing usable: not applied
    expect(r.send([{ t: "runtime", runtime: { model: 7 } }])).toBe(0);
  });

  it("operation names are validated and bounded", () => {
    const { store, load } = setup();
    const r = load();
    r.send([{ t: "steps", steps: [], order: [], ops: [[1, 0], [2, "GET /a#1"], ["x", 1], [3], [4, { evil: true }], [-1, 0], [5, ""]] }]);
    expect(store.runs.get(r.run)!.ops).toEqual({ "1": 0, "2": "GET /a#1" });
    r.send([{ t: "steps", steps: [], order: [], ops: Array.from({ length: 2000 }, (_, i) => [100 + i, i]) }]);
    r.send([{ t: "steps", steps: [], order: [], ops: Array.from({ length: 2000 }, (_, i) => [5000 + i, i]) }]);
    const ops = store.runs.get(r.run)!.ops!;
    expect(Object.keys(ops)).toHaveLength(3000);
    expect(ops["1"]).toBeUndefined(); // the oldest went first
    expect(ops["6999"]).toBe(1999);
  });
});
