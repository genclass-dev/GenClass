// End-to-end in Node, no browser: the systematic explore plan through the real page side and the real bridge
// (docs/runtime/AGENT.md sections 3-5). Not part of vitest or CI; run after building both packages:
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
//   node packages/mcp/test/e2e/systematic.node.mjs [--verbose] [--real-clock]
//
// What is real: @genclass/runtime (createRuntime, observe mode, no model, telemetry off) and its agent entry
// (connectAgent) from packages/runtime/dist; @genclass/mcp (serve(): the bridge on an ephemeral 127.0.0.1 port, the
// store and the MCP tools over in-process stdio) from packages/mcp/dist. The agent link really posts its hello and
// event batches to that port over HTTP, with the page's Origin, and the agent side drives the MCP tools as an agent
// would (genclass_explore, genclass_replay, genclass_explain), reading the structured results through the same API.
//
// What is simulated: the page. Each page load is a fresh runtime with a fake window: a virtual search server for its
// fetch (each answer 40 ms after its request, so in request order), a localhost location, a minimal document whose
// text is the app's results, and a scripted user typing "react" one key every 80 ms through rt.user() (the entry point
// the DOM observer uses). Each key sends GET /api/search?q=<prefix>; its response writes a store field (rt.atom) that
// the page text shows. The page waits for whenSettled(), then exits (pagehide: the agent's final steps, net log and end
// go out by sendBeacon). By default the runtime runs on a virtual clock (its injected Clock): every load is
// deterministic, and real HTTP to the bridge happens between virtual instants (virtual time stops until every request
// to the bridge has been answered, one at a time, in order), so the bridge sees each batch when the page sent it and
// its latency is zero in page time. --real-clock runs the page on the runtime's own clock (real timers) with the
// bridge's I/O beside it: not deterministic, slower (about 3.5 minutes).
//
// Three app variants: buggy (every response writes), fixed (only the answer to the latest query writes: a request
// counter) and abort (each key aborts the previous fetch and the app ignores AbortError: correct; a response the
// schedule holds after its fetch was aborted must reject with the abort, not deliver stale data). Each variant is
// explored with plan "systematic" (runs 6, slow_ms 600, slow_mode fixed), plan "seeded" (seeds 1..6, slow_ms 600) for
// comparison, and plan "systematic" with as many cover slots as five overlapping requests need (runs 9). For buggy:
// minimise, one load per probe, the result, a replay of the minimal reproduction, and the generated regression test,
// whose own page-set schedule and page-text assertions are then run on all three variants.
//
// Checks (exit code 1 when one fails): the wire (hello caps, the schedule at hello and in force, the net log, the
// delivery order, the steps, forced, the snapshot and the end event the bridge stored equal what the page recorded);
// each schedule realised as specified (fifo in start order, lifo every overlapping pair inverted, seeded by its hash
// priorities, a cover row's rank order on every overlapping pair); the hold bound (no delivery later than ready +
// maxHoldMs + 1 ms); the plan's positions; the cover rows handed out equal buildCover() of the settled baselines and
// the lifo load and list every key; coverage and each run's inversions equal an independent computation from the
// page-side logs, and the runs the coverage line names for the orderings still missing equal buildCover() of them;
// no race on fixed and abort, a race on buggy; on abort every older response was held when aborted,
// rejected with AbortError and never written; every probe ran; a minimal reproduction, its replay reproduced; the
// regression test fails on buggy and passes on fixed and abort. This is a simulation through the real code, not a
// browser measurement.

import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserClock, createRuntime } from "../../../runtime/dist/index.js";
import { connectAgent, hash32 } from "../../../runtime/dist/agent.js";
import { buildCover, makeApi, sequenceCover, serve } from "../../dist/index.js";

const VERBOSE = process.argv.includes("--verbose");
const REAL = process.argv.includes("--real-clock");
const PAGE_ORIGIN = "http://localhost:5173";
const TEXT = "react";
const KEY_MS = 80;
const SERVER_MS = 40;
const CAPS = ["lifo", "ranked", "reverse", "delaySeed", "net"];
const wall0 = Date.now();

// ------------------------------------------------------------------------------------------------ the bridge
const tokenDir = mkdtempSync(join(tmpdir(), "genclass-systematic-"));
const mcpIn = new PassThrough();
const mcpOut = new PassThrough();
const mcpErr = new PassThrough();
const errLines = [];
mcpErr.setEncoding("utf8");
mcpErr.on("data", (c) => errLines.push(c));
const replies = [];
let outBuf = "";
mcpOut.setEncoding("utf8");
mcpOut.on("data", (c) => {
  outBuf += c;
  let nl;
  while ((nl = outBuf.indexOf("\n")) >= 0) {
    replies.push(JSON.parse(outBuf.slice(0, nl)));
    outBuf = outBuf.slice(nl + 1);
  }
});
const served = await serve({ cwd: tokenDir, env: { GENCLASS_TOKEN_DIR: tokenDir }, stdin: mcpIn, stdout: mcpOut, stderr: mcpErr, port: 0, stateDir: null });
if (served.mode !== "local" || !served.store) throw new Error(`the bridge did not start: ${errLines.join("")}`);
const BRIDGE = `http://127.0.0.1:${served.port}`;
const store = served.store;
const api = makeApi(store, { url: BRIDGE, port: served.port });
let rpcId = 0;
async function rpc(method, params = {}) {
  const id = ++rpcId;
  mcpIn.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  for (let i = 0; i < 3000; i++) {
    const m = replies.find((x) => x.id === id);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no reply to ${method}`);
}
const tool = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r.result);
  if (VERBOSE) console.log(`\n>>> ${name} ${JSON.stringify(args)}\n${text}`);
  return text;
};
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "systematic.node", version: "1" } });
mcpIn.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

// ------------------------------------------------------------------- the page's network to the bridge (real HTTP)
// One request at a time, in the order the page sent them; virtual time waits until all are answered.
let ioChain = Promise.resolve();
let ioPending = 0;
const io = { posts: 0, failed: 0, statuses: new Map() };
function bridgePost(url, body, contentType) {
  ioPending++;
  io.posts++;
  const p = ioChain.then(async () => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": contentType ?? "text/plain;charset=UTF-8", origin: PAGE_ORIGIN }, body });
    const text = await r.text();
    io.statuses.set(r.status, (io.statuses.get(r.status) ?? 0) + 1);
    if (!r.ok) io.failed++;
    return { ok: r.ok, status: r.status, json: async () => JSON.parse(text) };
  });
  ioChain = p.then(
    () => undefined,
    () => undefined,
  );
  const done = () => void ioPending--;
  p.then(done, () => {
    io.failed++;
    done();
  });
  return p;
}
async function ioIdle() {
  while (ioPending > 0) await ioChain;
}
const drain = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

// --------------------------------------------------------------------------------------- the virtual clock
// The runtime's Clock: timers run in time order, each as its own task (microtasks, real I/O to the bridge, then
// afterTask hooks settle before the next one).
class VirtualClock {
  t = 1000;
  timers = [];
  nextId = 1;
  after = [];
  uncaught = [];
  now() {
    return this.t;
  }
  setTimeout(fn, ms) {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + Math.max(0, Number(ms) || 0), fn });
    return id;
  }
  clearTimeout(h) {
    const i = this.timers.findIndex((x) => x.id === h);
    if (i >= 0) this.timers.splice(i, 1);
  }
  afterTask(fn) {
    this.after.push(fn);
  }
  async flush() {
    for (let i = 0; i < 1000; i++) {
      await drain();
      if (ioPending) {
        await ioIdle();
        continue;
      }
      if (!this.after.length) return;
      const a = this.after;
      this.after = [];
      for (const f of a)
        try {
          f();
        } catch (e) {
          this.uncaught.push(e);
        }
    }
    throw new Error("the virtual clock did not settle");
  }
  async advance(ms) {
    const end = this.t + ms;
    await this.flush();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      try {
        next.fn();
      } catch (e) {
        this.uncaught.push(e);
      }
      await this.flush();
    }
    this.t = end;
    await this.flush();
  }
}

/**
 * --real-clock: the runtime's own clock (performance.now and real timers, src/clock.ts browserClock); the page waits
 * in real time and the bridge's I/O runs beside it, as in a browser. Not deterministic: timer jitter can move a
 * response's ready time across another request's send.
 */
class RealClock {
  uncaught = [];
  now() {
    return browserClock.now();
  }
  setTimeout(fn, ms) {
    return browserClock.setTimeout(() => {
      try {
        fn();
      } catch (e) {
        this.uncaught.push(e);
      }
    }, ms);
  }
  clearTimeout(h) {
    browserClock.clearTimeout(h);
  }
  afterTask(fn) {
    browserClock.afterTask(fn);
  }
  async flush() {
    await drain();
  }
  async advance(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }
}

// ------------------------------------------------------------------------------------------------ the page
const abortError = () => new DOMException("The operation was aborted.", "AbortError");

/** One page load of the search page: a fake window, a virtual server, the app (variant) and the runtime. */
function makePage(variant) {
  const clock = REAL ? new RealClock() : new VirtualClock();
  const sent = [];
  const search = (url, init) => {
    const q = url.searchParams.get("q") ?? "";
    const signal = init?.signal;
    sent.push({ q, t: clock.now() });
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? abortError());
      const onAbort = () => {
        clock.clearTimeout(timer);
        reject(signal.reason ?? abortError());
      };
      const timer = clock.setTimeout(() => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve(new Response(JSON.stringify({ items: [`${q} one`, `${q} two`] }), { status: 200, headers: { "content-type": "application/json" } }));
      }, SERVER_MS);
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  };
  const logs = [];
  const con = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((k) => [k, (...a) => logs.push(`${k}: ${a.map(String).join(" ")}`)]));
  const input = {
    tagName: "INPUT",
    type: "search",
    value: "",
    name: "q",
    id: "q",
    autocomplete: "off",
    labels: null,
    getAttribute: (n) => (n === "aria-label" ? "Search" : n === "autocomplete" ? "off" : null),
    closest: () => null,
  };
  let view = { heading: "", items: [] };
  const document = {
    title: "Search",
    body: {
      get innerText() {
        return [view.heading, ...view.items].filter(Boolean).join("\n");
      },
    },
    querySelectorAll: (sel) => (sel === "input,textarea,select" ? [input] : []),
    querySelector: () => null,
  };
  const g = new EventTarget();
  Object.assign(g, {
    fetch: (req, init) => {
      const url = new URL(typeof req === "string" ? req : req.url, g.location.href);
      if (url.origin === BRIDGE) return bridgePost(url.href, init?.body, init?.headers?.["content-type"]);
      if (url.pathname === "/api/search") return search(url, init);
      return Promise.resolve(new Response("{}", { status: 404 }));
    },
    location: { href: `${PAGE_ORIGIN}/`, origin: PAGE_ORIGIN, protocol: "http:", host: "localhost:5173", hostname: "localhost", port: "5173", pathname: "/", search: "", hash: "" },
    document,
    navigator: {
      userAgent: "systematic.node.mjs (Node simulation, no browser)",
      sendBeacon: (u, body) => {
        void bridgePost(u, body, "text/plain;charset=UTF-8");
        return true;
      },
    },
    console: con,
  });
  const rt = createRuntime({
    clock,
    global: g,
    mode: "observe",
    model: false,
    telemetry: false,
    report: "silent",
    visual: false,
    observe: { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false },
  });
  // the app: a search box whose results are written by the response (the e2e search page's logic)
  const st = rt.atom("search", { query: "", results: [] });
  st.subscribe((v) => (view = { heading: v.results.length ? `Results for ${v.results[0].split(" ")[0]}` : "", items: v.results.slice() }));
  const app = { aborts: 0, errors: [], writes: 0 };
  let latest = 0;
  let ctrl = null;
  app.onInput = async (q) => {
    const id = ++latest;
    let signal;
    if (variant === "abort") {
      ctrl?.abort();
      ctrl = new AbortController();
      signal = ctrl.signal;
    }
    st.set((v) => ({ ...v, query: q }));
    try {
      const res = await g.fetch(`/api/search?q=${encodeURIComponent(q)}`, signal ? { signal } : undefined);
      const data = await res.json();
      if (variant === "fixed" && id !== latest) return;
      app.writes++;
      st.set((v) => ({ ...v, results: data.items }));
    } catch (e) {
      if (variant === "abort" && e?.name === "AbortError") {
        app.aborts++;
        return;
      }
      app.errors.push(String(e?.stack ?? e));
    }
  };
  return { clock, g, rt, input, app, sent, logs, view: () => view };
}

let loadsTotal = 0;
/**
 * Load the page, connect the agent, type "react", wait for the quiet point, exit. Everything recorded both sides.
 * `pageSchedule`: set as the page global a regression test sets (window.__GENCLASS_SCHEDULE__) before connecting.
 */
async function pageLoad(variant, pageSchedule) {
  loadsTotal++;
  const p = makePage(variant);
  if (pageSchedule) globalThis.__GENCLASS_SCHEDULE__ = pageSchedule;
  const conn = connectAgent(p.rt, { url: BRIDGE });
  delete globalThis.__GENCLASS_SCHEDULE__;
  await p.clock.flush(); // the hello: answered before any virtual time passes
  // on the real clock the page waits for it (as the Chromium e2e waits for connected === true)
  for (let waited = 0; !conn.connected && waited < 2000; waited += 5) await p.clock.advance(5);
  const hello = { connected: conn.connected, run: conn.run, schedule: conn.schedule ? JSON.parse(JSON.stringify(conn.schedule)) : null };
  await p.clock.advance(100);
  const t0 = p.clock.now();
  for (let i = 1; i <= TEXT.length; i++) {
    const value = TEXT.slice(0, i);
    p.input.value = value;
    p.rt.user({ kind: "type", target: 'input "Search"', value, sensitive: false }, () => void p.app.onInput(value));
    await p.clock.flush();
    if (i < TEXT.length) await p.clock.advance(KEY_MS);
  }
  let settled = null;
  void conn.whenSettled(15_000).then((v) => (settled = v));
  while (settled === null) await p.clock.advance(10);
  const quietAt = p.clock.now() - t0;
  const snapshot = conn.snapshot();
  await p.clock.advance(400);
  p.g.dispatchEvent(new Event("pagehide"));
  await p.clock.flush();
  await ioIdle();
  const rec = conn.recorded();
  return { variant, conn, hello, settled, quietAt, snapshot, rec, page: p, view: p.view(), run: conn.run };
}

// --------------------------------------------------------------------- shared definitions, computed independently
// (docs/runtime/AGENT.md section 5; packages/runtime/src/agent/schedule.ts header): from the page's own recording
const isSched = (e) => !!e && e.d !== undefined && e.r !== undefined && !e.pass && !e.key.includes("~");
const startOrder = (net) => net.filter(isSched).sort((x, y) => x.n - y.n || x.s - y.s || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
/** [a, b] with n(a) < n(b) and s(b) < r(a), no shortcut (every pair looked at). */
function overlaps(net) {
  const es = startOrder(net);
  const out = [];
  for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) if (es[j].s < es[i].r) out.push([es[i].key, es[j].key]);
  return out;
}
const rankOf = (order) => new Map(order.map((k, i) => [k, i]));
const inversions = (rec) => {
  const at = rankOf(rec.order);
  return overlaps(rec.net).filter(([a, b]) => at.has(a) && at.has(b) && at.get(b) < at.get(a));
};

/** Coverage of a session's loads by the shared definitions: baselines are the fifo loads with the added latency. */
function coverageOf(loads) {
  const isFifo = (l) => l.schedule?.order === "fifo";
  const slow = (l) => (l.schedule?.delay?.maxMs ?? 0) > 0;
  const base = loads.filter((l) => isFifo(l) && (loads.some((x) => isFifo(x) && slow(x)) ? slow(l) : true));
  const pairs = new Map();
  for (const b of base) for (const [a, c] of overlaps(b.rec.net)) pairs.set(`${a}\n${c}`, [a, c]);
  const ranks = loads.map((l) => rankOf(l.rec.order));
  let bothWays = 0;
  for (const [a, b] of pairs.values()) {
    let ab = false;
    let ba = false;
    for (const r of ranks) {
      if (!r.has(a) || !r.has(b)) continue;
      if (r.get(a) < r.get(b)) ab = true;
      else ba = true;
    }
    if (ab && ba) bothWays++;
  }
  const keys = [...new Set([...pairs.values()].flat())];
  const has = (x, y) => pairs.has(`${x}\n${y}`) || pairs.has(`${y}\n${x}`);
  let triples = 0;
  let seen = 0;
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++)
      for (let k = j + 1; k < keys.length; k++) {
        const t = [keys[i], keys[j], keys[k]];
        if (!has(t[0], t[1]) || !has(t[0], t[2]) || !has(t[1], t[2])) continue;
        triples++;
        const orders = new Set();
        for (const r of ranks) if (t.every((x) => r.has(x))) orders.add([...t].sort((x, y) => r.get(x) - r.get(y)).join("|"));
        seen += orders.size;
      }
  return { pairs: pairs.size, bothWays, triples, orderings: 6 * triples, orderingsSeen: seen };
}

// ---------------------------------------------------------------------------------------------- the checks
const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail });
  if (!ok || VERBOSE) console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  return !!ok;
}
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const stripT = (s) => {
  if (!s) return s;
  const { t: _t, ...rest } = s;
  return rest;
};

/** The wire for one load: what the bridge stored equals what the page recorded. */
function wireCheck(l, where) {
  const run = store.runs.get(l.run);
  const bad = [];
  if (!l.hello.connected || !run) bad.push("not connected");
  else {
    if (canon(run.caps) !== canon(CAPS)) bad.push(`caps ${canon(run.caps)}`);
    if (canon(run.schedule) !== canon(l.rec.spec)) bad.push(`schedule bridge ${canon(run.schedule)} page ${canon(l.rec.spec)}`);
    if (canon(l.hello.schedule) !== canon(l.rec.spec)) bad.push(`schedule at hello ${canon(l.hello.schedule)}, in force ${canon(l.rec.spec)}`);
    const pageNet = Object.fromEntries(l.rec.net.map((e) => [e.key, e]));
    if (canon(run.net ?? null) !== canon(pageNet)) bad.push(`net bridge ${canon(run.net)} page ${canon(pageNet)}`);
    if ((run.netLost ?? 0) !== l.rec.netLost) bad.push(`netLost ${run.netLost} vs ${l.rec.netLost}`);
    if (canon(run.order) !== canon(l.rec.order)) bad.push(`order ${canon(run.order)} vs ${canon(l.rec.order)}`);
    if (canon(run.steps) !== canon(l.rec.steps)) bad.push(`steps differ (${run.steps.length} bridge, ${l.rec.steps.length} page)`);
    if (run.forced !== l.rec.forced) bad.push(`forced ${run.forced} vs ${l.rec.forced}`);
    if (canon(stripT(run.snapshot)) !== canon(stripT(l.snapshot))) bad.push(`snapshot bridge ${canon(stripT(run.snapshot))} page ${canon(stripT(l.snapshot))}`);
    if (!run.ended) bad.push("no end event");
    if (run.lost) bad.push(`lost ${run.lost} steps`);
  }
  if (l.page.clock.uncaught.length || l.page.app.errors.length) bad.push(`page errors: ${[...l.page.clock.uncaught, ...l.page.app.errors].map(String).join("; ").slice(0, 300)}`);
  return bad.length ? `${where}: ${bad.join("; ")}` : null;
}

/** Was the load's schedule realised as specified, and did every delivery keep the hold bound? */
function scheduleCheck(l) {
  const spec = l.rec.spec ?? { order: "natural" };
  const net = l.rec.net;
  const at = rankOf(l.rec.order);
  const ov = overlaps(net);
  const bad = [];
  const hold = spec.maxHoldMs ?? 1500;
  for (const e of net.filter(isSched)) if (e.d - e.r > hold + 1) bad.push(`${e.key} delivered ${e.d - e.r} ms after ready (bound ${hold})`);
  if (spec.order === "fifo") {
    const ks = startOrder(net).map((e) => e.key);
    const got = l.rec.order.filter((k) => ks.includes(k));
    if (canon(got) !== canon(ks)) bad.push(`fifo delivered ${got.join(", ")}`);
  } else if (spec.order === "lifo") {
    const notInverted = ov.filter(([a, b]) => !(at.get(b) < at.get(a)));
    if (notInverted.length) bad.push(`lifo left ${notInverted.length} overlapping pair(s) in request order`);
  } else if (spec.order === "seeded") {
    // priority hash32(seed|key), turned around with reverse: a higher-priority request started before b was delivered
    // is delivered before b (it blocks b while in flight or held)
    const prio = (k) => (spec.reverse ? 0xffffffff - hash32(`${spec.seed ?? 1}|${k}`) : hash32(`${spec.seed ?? 1}|${k}`));
    const es = net.filter(isSched);
    const wrong = [];
    for (const a of es) for (const b of es) if (a !== b && prio(a.key) > prio(b.key) && a.s < b.d && !(at.get(a.key) < at.get(b.key))) wrong.push(`${short(b.key)} before ${short(a.key)}`);
    if (wrong.length) bad.push(`seeded: ${wrong.length} pair(s) against the priorities (${wrong.join("; ")})`);
  } else if (spec.order === "ranked") {
    const r = new Map((spec.ranks ?? []).map((k, i) => [k, i]));
    const wrong = ov.filter(([a, b]) => r.has(a) && r.has(b) && r.get(a) < r.get(b) !== at.get(a) < at.get(b));
    if (wrong.length) bad.push(`ranked: ${wrong.length} overlapping pair(s) against the rank order (${wrong.map((p) => p.join(" / ")).join("; ")})`);
  }
  return bad;
}

// ----------------------------------------------------------------------------------------------- a session
const short = (k) => k.replace(/^GET \/api\/search#/, "#");
const fmtOrder = (keys) => keys.map(short).join(" ");

async function exploreSession(plan, variant, runs = 6) {
  await tool("genclass_clear", { what: "all" });
  const args = plan === "systematic" ? { action: "start", runs, slow_ms: 600, plan: "systematic", slow_mode: "fixed" } : { action: "start", runs, slow_ms: 600, plan: "seeded" };
  const tag = `${variant}/${plan}${runs !== 6 ? ` (runs ${runs})` : ""}`;
  const armed = await tool("genclass_explore", args);
  const x = store.latestExplore();
  const planned = x.plan.length;
  const said = Number(/the next (\d+) page loads/.exec(armed)?.[1]);
  check(`${tag}: explore start text names the ${planned} planned loads`, said === planned, armed.split("\n")[0]);
  const loads = [];
  for (let i = 0; i < planned; i++) {
    const l = await pageLoad(variant);
    l.label = store.runs.get(l.run)?.assignment?.label ?? "?";
    l.schedule = l.rec.spec;
    loads.push(l);
  }
  const rep = await tool("genclass_explore", { action: "report", id: x.id });
  const r = api("explore.report", { id: x.id });
  const g = r.groups.length === 1 ? r.groups[0] : null;
  check(`${tag}: one scenario group of ${planned} runs`, g && g.runs === planned, r.groups.map((y) => `${y.runs} runs`).join(", "));
  const s = { plan, variant, runs, tag, x, loads, report: r, reportText: rep, group: g, wire: [], sched: [] };
  for (const [i, l] of loads.entries()) {
    const w = wireCheck(l, `load ${i + 1} (${l.label})`);
    if (w) s.wire.push(w);
    for (const b of scheduleCheck(l)) s.sched.push(`load ${i + 1} (${l.label}): ${b}`);
  }
  check(`${tag}: wire (caps, schedule, net, order, steps, snapshot, end) equal on both sides for all ${planned} loads`, !s.wire.length, s.wire.slice(0, 3).join(" | "));
  check(`${tag}: every schedule realised as specified and every delivery within ready + maxHoldMs`, !s.sched.length, s.sched.slice(0, 4).join(" | "));
  // the plan as specified
  if (plan === "systematic") {
    const orders = x.plan.map((p) => p.order).join(",");
    const want = ["fifo", "fifo", "lifo", ...Array.from({ length: runs - 1 }, () => "ranked|seeded"), "fifo"];
    const okPlan = x.plan.length === runs + 3 && x.plan.every((p, i) => want[i].split("|").includes(p.order)) && x.plan.every((p) => p.delay?.minMs === 600 && p.delay?.maxMs === 600 && p.delaySeed === 1 && p.maxHoldMs === 2100);
    check(`${tag}: plan is fifo, fifo, lifo, ${runs - 1} cover slots, fifo, each +600 ms fixed, delaySeed 1, maxHoldMs 2100`, okPlan, orders);
    const ranked = loads.filter((l) => l.schedule?.order === "ranked");
    s.coverRows = ranked.length;
    // the rows handed out are the cover of the settled baselines and the lifo load (fixed from the first row handed out)
    const timed = (l) => ({ net: Object.fromEntries(l.rec.net.map((e) => [e.key, e])), order: l.rec.order });
    const cover = buildCover({ baselines: [timed(loads[0]), timed(loads[1])], lifo: timed(loads[2]), rows: runs - 1 });
    const keys = startOrder(loads[0].rec.net).map((e) => e.key);
    const given = loads.slice(3, runs + 2).map((l) => (l.schedule?.order === "ranked" ? l.schedule.ranks : null));
    check(
      `${tag}: the cover rows handed out are the baselines' cover, each listing every key`,
      cover && canon(given.filter(Boolean)) === canon(cover.rows) && given.slice(0, cover.rows.length).every((r) => r && canon([...r].sort()) === canon([...keys].sort())),
      cover ? `${cover.rows.length} row(s) over ${cover.keys} keys, ${cover.pairs} pairs, ${cover.components} component(s), ${cover.lifoRows} lifo row(s): ${cover.rows.map(fmtOrder).join(" | ")}` : "no cover",
    );
    s.cover = cover;
    s.standIns = loads.filter((l) => l.schedule?.order === "seeded").length;
  } else {
    const okPlan = x.plan.length === runs + 3 && x.plan.slice(0, 3).every((p) => p.order === "fifo") && x.plan.slice(3).every((p, i) => p.order === "seeded" && p.seed === i + 1);
    check(`${tag}: plan is 2 slow baselines, 1 without added delay, seeds 1..${runs}`, okPlan, x.plan.map((p) => `${p.order}${p.seed ?? ""}`).join(","));
  }
  // coverage: the bridge's against the shared definitions applied to the page-side logs
  const mine = coverageOf(loads);
  const c = g?.coverage;
  check(
    `${tag}: coverage equals the page-side computation`,
    c && c.pairs === mine.pairs && c.bothWays === mine.bothWays && c.triples === mine.triples && c.orderings === mine.orderings && c.orderingsSeen === mine.orderingsSeen,
    `bridge ${c ? `${c.bothWays}/${c.pairs} pairs, ${c.orderingsSeen}/${c.orderings} orderings of ${c.triples} triples` : "none"}; page ${mine.bothWays}/${mine.pairs}, ${mine.orderingsSeen}/${mine.orderings} of ${mine.triples}`,
  );
  // inversions per run, as the bridge computed them (RunDiff), against the page-side computation
  const invBad = [];
  for (const d of g?.diffs ?? []) {
    const l = loads.find((y) => y.run === d.run);
    if (l && inversions(l.rec).length !== d.inversions) invBad.push(`${d.run}: bridge ${d.inversions}, page ${inversions(l.rec).length}`);
  }
  check(`${tag}: inversions of every differing run equal the page-side computation`, !invBad.length, invBad.join("; "));
  // the report text the agent reads says the same
  const visible = (g?.diffs ?? []).filter((d) => d.tier === "visible").length;
  const reportSays = [
    `Compared: ${g?.compared ?? 0} of ${g?.compared ?? 0} reordered run(s) against two baselines.`,
    visible ? `RACE: ${visible} of ${g?.compared ?? 0} reordered run(s) ended in a different state than the baseline` : "No race found",
    c ? `Coverage: ${c.bothWays} of ${c.pairs} overlapping response pairs delivered both ways; ${c.orderingsSeen} of ${c.orderings} orderings of ${c.triples} overlapping triples` : "Coverage:",
  ];
  const missing = reportSays.filter((x) => !rep.includes(x));
  check(`${tag}: the report text says the compared runs, the verdict and the coverage`, !missing.length, missing.join(" | "));
  // orderings of triples still missing: the line names the runs whose cover rows deliver every one, buildCover of the slow
  // baselines and the lifo load, computed here from the page-side logs; nothing is named once every ordering was delivered
  s.runsAll = null;
  if (c && c.orderingsSeen < c.orderings) {
    const timedLoad = (l) => ({ net: Object.fromEntries(l.rec.net.map((e) => [e.key, e])), order: l.rec.order });
    const slowBase = loads.filter((l) => l.schedule?.order === "fifo" && (l.schedule?.delay?.maxMs ?? 0) > 0);
    const lifoLoad = loads.find((l) => l.schedule?.order === "lifo");
    const full = buildCover({ baselines: slowBase.map(timedLoad), ...(lifoLoad ? { lifo: timedLoad(lifoLoad) } : {}), rows: 50 });
    s.runsAll = full && full.rows.length < 50 ? full.rows.length + 1 : null;
    const had = plan === "systematic" && runs - 1 >= (s.runsAll ?? Infinity) - 1;
    const says = had ? `This session armed the ${s.runsAll - 1} cover rows every ordering of the overlapping triples takes` : `takes plan "systematic" with runs ${s.runsAll} (${s.runsAll - 1} cover rows from these baselines): genclass_explore {action:"start", plan:"systematic", runs:${s.runsAll}}.`;
    check(`${tag}: the coverage line names runs ${s.runsAll} for the orderings still missing (buildCover of the page-side logs)`, s.runsAll !== null && rep.includes(says), rep.split("\n").find((x) => x.startsWith("Every ordering") || x.startsWith("This session armed")) ?? "no line");
  } else check(`${tag}: no runs named once every ordering of the triples was delivered`, !rep.includes("Every ordering of the overlapping triples") && !rep.includes("This session armed"));
  s.races = (g?.diffs ?? []).filter((d) => d.tier === "visible");
  s.findings = r.findings;
  s.forced = loads.reduce((n, l) => n + l.rec.forced, 0);
  s.coverage = c;
  s.aborts = loads.reduce((n, l) => n + l.page.app.aborts, 0);
  s.writes = loads.map((l) => l.page.app.writes);
  // every page-side recording (net log, delivery order, steps, quiet-point snapshot): equal digests mean equal runs
  s.digest = createHash("sha256").update(canon(loads.map((l) => [l.rec.spec, l.rec.net, l.rec.order, l.rec.steps, l.snapshot, l.view]))).digest("hex").slice(0, 16);
  if (VERBOSE)
    for (const [i, l] of loads.entries()) {
      const d = g?.diffs.find((y) => y.run === l.run);
      console.log(`  ${tag} load ${i + 1} ${l.run} ${l.label}: delivered ${fmtOrder(l.rec.order)} · inversions ${inversions(l.rec).length} · forced ${l.rec.forced} · shows ${JSON.stringify(l.view.heading)} · ${d ? d.tier : "same as baseline"}${l.page.app.aborts ? ` · ${l.page.app.aborts} AbortError(s)` : ""}`);
    }
  return s;
}

/** Minimise a race finding: arm, one load per probe, the result; then replay the minimal reproduction once. */
async function minimise(s) {
  const f = s.findings[0];
  const out = { finding: f?.id ?? null };
  if (!f) return out;
  const armed = await tool("genclass_replay", { action: "minimize", id: f.id });
  const arm = store.minimizes.find((m) => m.finding === f.id);
  out.armedText = armed;
  if (!arm) {
    out.error = armed;
    return out;
  }
  out.probes = arm.probes.length;
  out.leftOut = arm.leftOut;
  out.loads = [];
  for (let i = 0; i < arm.probes.length; i++) {
    const l = await pageLoad(s.variant);
    l.label = store.runs.get(l.run)?.assignment?.label ?? "?";
    l.schedule = l.rec.spec;
    out.loads.push(l);
  }
  const wire = out.loads.map((l, i) => wireCheck(l, `probe load ${i + 1}`)).filter(Boolean);
  const sched = out.loads.flatMap((l, i) => scheduleCheck(l).map((b) => `probe load ${i + 1}: ${b}`));
  check(`${s.tag}: minimise probe loads: wire equal both sides`, !wire.length, wire.slice(0, 2).join(" | "));
  check(`${s.tag}: minimise probe loads: ranked order and hold bound`, !sched.length, sched.slice(0, 3).join(" | "));
  const unrun = arm.probes.filter((p) => !p.run);
  check(`${s.tag}: every armed probe got a page load`, !unrun.length, `${unrun.length} of ${arm.probes.length} without a run`);
  const res = api("replay.result", { id: f.id });
  out.resultText = await tool("genclass_replay", { action: "result", id: f.id });
  const m = res?.minimize;
  out.result = m;
  out.minimal = m?.minimal ?? null;
  // what the finding replays from now on (a later session's clear removes the finding)
  out.replaySpec = store.findings.get(f.id)?.replay ?? null;
  if (VERBOSE && m) for (const p of m.probes) console.log(`  probe ${p.index + 1} ${p.label}: ${p.state} ${p.reproduced} · ${p.note}`);
  if (out.minimal) {
    await tool("genclass_replay", { action: "arm", id: f.id });
    const l = await pageLoad(s.variant);
    l.label = store.runs.get(l.run)?.assignment?.label ?? "?";
    out.replayLoad = l;
    const w = wireCheck(l, "replay load");
    check(`${s.tag}: replay load: wire equal both sides`, !w, w ?? "");
    const rr = api("replay.result", { id: f.id });
    out.replayText = await tool("genclass_replay", { action: "result", id: f.id });
    out.replay = rr.results.at(-1) ?? null;
    const explain = await tool("genclass_explain", { id: f.id });
    out.test = /```ts\n([\s\S]*?)```/.exec(explain)?.[1] ?? null;
    if (out.test) {
      // the generated test's own schedule (a page global, no bridge assignment) and its assertions, on each variant
      const t = testParts(out.test);
      out.testParts = t;
      out.testOn = {};
      for (const v of ["buggy", "fixed", "abort"]) {
        const l = await pageLoad(v, t.schedule);
        const applied = l.conn.schedule;
        const scheduleOk = !!applied && Object.entries(t.applied ?? {}).every(([k, x]) => canon(applied[k]) === canon(x)) && applied.ranks?.length === t.ranks;
        const failed = t.text.filter(({ not, line }) => (l.snapshot.text ?? []).includes(line) === not);
        out.testOn[v] = { scheduleOk, passed: scheduleOk && !failed.length, failed: failed.map((x) => `${x.not ? "not " : ""}${x.line}`), shows: l.view.heading, unassigned: !store.runs.get(l.run)?.assignment };
      }
    }
  }
  return out;
}

/** The schedule, the applied-schedule check and the page-text assertions of a generated regression test. */
function testParts(test) {
  const str = '"(?:[^"\\\\]|\\\\.)*"';
  const schedule = JSON.parse(/const SCHEDULE = (\{.*\});\n/.exec(test)?.[1] ?? "null");
  const applied = JSON.parse(/\)\.toMatchObject\((\{.*\})\);\n/.exec(test)?.[1] ?? "null");
  const ranks = Number(/expect\(applied\?\.ranks\?\.length, .*\)\.toBe\((\d+)\);/.exec(test)?.[1] ?? NaN);
  const text = [...test.matchAll(new RegExp(`expect\\(snap\\.text, ${str}\\)\\.(not\\.)?toContain\\((${str})\\);`, "g"))].map((m) => ({ not: !!m[1], line: JSON.parse(m[2]) }));
  return { schedule, applied, ranks, text };
}

// --------------------------------------------------------------------------------------------------- run it
const sessions = [];
for (const plan of ["systematic", "seeded"])
  for (const variant of ["buggy", "fixed", "abort"]) {
    const s = await exploreSession(plan, variant);
    if (variant === "buggy") s.min = await minimise(s);
    sessions.push(s);
  }
// enough cover slots for five overlapping requests: sequenceCover(5) has 10 rows, fifo and lifo are two of them
const need = sequenceCover(5, 1000).rows.length - 2;
for (const variant of ["buggy", "fixed", "abort"]) sessions.push(await exploreSession("systematic", variant, need + 1));

// expectations across sessions
for (const s of sessions) {
  const tag = s.tag;
  if (s.variant === "buggy") check(`${tag}: a race is found`, s.races.length > 0 && s.findings.length > 0, `${s.races.length} visible difference(s), ${s.findings.length} finding(s)`);
  else check(`${tag}: no false race`, s.races.length === 0 && s.findings.length === 0, `${s.races.length} visible difference(s): ${s.races.map((d) => d.label).join(", ")}`);
  if (s.variant === "abort" && s.plan === "systematic")
    check(`${tag}: with every older response held when its fetch was aborted, each load wrote once (the newest) and ignored 4 AbortErrors`, s.loads.every((l) => l.page.app.writes === 1 && l.page.app.aborts === 4), `writes ${s.writes.join(",")}`);
  if (s.variant === "abort") check(`${tag}: held responses of aborted fetches rejected with AbortError (R0) and none wrote`, s.aborts > 0 && s.loads.every((l) => l.view.heading === "Results for react"), `${s.aborts} AbortError(s) the app ignored`);
}
for (const s of sessions.filter((x) => x.plan === "systematic"))
  check(`${s.tag}: fifo and lifo delivered every overlapping baseline pair both ways`, s.coverage && s.coverage.bothWays === s.coverage.pairs, s.coverage ? `${s.coverage.bothWays}/${s.coverage.pairs}` : "no coverage");
for (const s of sessions.filter((x) => x.min)) {
  const m = s.min;
  const tag = s.tag;
  check(`${tag}: minimise finds a minimal reproduction`, !!m.minimal, m.minimal ? m.minimal.label : (m.result ? `${m.result.probes.map((p) => `${p.index + 1}:${p.state}${p.reproduced === null ? "" : p.reproduced ? "+" : "-"}`).join(" ")}; left out ${m.result.leftOut}` : m.error ?? "not armed").slice(0, 400));
  if (m.minimal) {
    check(`${tag}: the replay of the minimal reproduction reproduced it`, m.replay?.reproduced === true, m.replay ? `${m.replay.reproduced} · ${m.replay.note}` : "no replay result");
    const t = m.testParts;
    check(`${tag}: the regression test sets the minimal order and asserts it in force`, !!t && canon(t.schedule?.ranks) === canon(m.replaySpec?.ranks) && t.applied?.order === "ranked" && t.ranks === t.schedule?.ranks?.length && t.text.length > 0, t ? `${canon(t.applied)}, ranks ${t.ranks}, ${t.text.length} text assertion(s)` : "no test");
    if (m.testOn) {
      const o = m.testOn;
      check(`${tag}: the regression test's assertions fail on buggy under its own schedule`, o.buggy.scheduleOk && !o.buggy.passed && o.buggy.unassigned, `shows ${JSON.stringify(o.buggy.shows)}; failed: ${o.buggy.failed.join(", ")}`);
      check(`${tag}: the regression test's assertions pass on fixed and abort under its own schedule`, o.fixed.passed && o.abort.passed && o.fixed.unassigned && o.abort.unassigned, `fixed ${o.fixed.passed ? "passed" : `failed ${o.fixed.failed.join(", ")}`}; abort ${o.abort.passed ? "passed" : `failed ${o.abort.failed.join(", ")}`}`);
    }
  }
}
check("the bridge answered every page request with 200", io.failed === 0 && [...io.statuses.keys()].every((k) => k === 200), `${io.posts} posts, statuses ${canon(Object.fromEntries(io.statuses))}`);

// ---------------------------------------------------------------------------------------------------- table
const rows = sessions.map((s) => {
  const c = s.coverage;
  const m = s.min;
  const fr = s.variant === "buggy" ? "-" : String(s.races.length);
  const pair = (x) => (x.variant === 2 ? `${short(x.b)} before ${short(x.a)}` : `${short(x.a)} after ${short(x.b)}`);
  const minimal = !m ? "-" : m.minimal ? `${m.minimal.exact ? "exact" : `not exact (${m.minimal.between} between)`}: ${pair(m.minimal)}${m.minimal.other ? " (other value)" : ""}` : `none (${m.result ? m.result.probes.filter((p) => p.conclusive).length : 0}/${m.probes ?? 0} probes conclusive)`;
  const replay = !m ? "-" : !m.minimal ? "-" : m.replay?.reproduced === true ? "reproduced" : m.replay?.reproduced === false ? "not reproduced" : "inconclusive";
  return [s.variant, s.runs !== 6 ? `${s.plan} (runs ${s.runs})` : s.plan, String(s.loads.length), String(s.group?.compared ?? 0), `${s.races.length} of ${s.group?.compared ?? 0}`, fr, c ? `${c.bothWays}/${c.pairs}` : "-", c ? `${c.orderingsSeen}/${c.orderings} (${c.triples} triples)` : "-", String(s.forced), minimal, replay];
});
const head = ["variant", "plan", "loads", "compared", "races (visible)", "false reports", "pairs both ways", "orderings seen", "forced", "minimal reproduction", "its replay"];
const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r) => `| ${r.map((c, i) => c.padEnd(width[i])).join(" | ")} |`;
console.log(`\nNode simulation through the real code (packages/runtime/dist, packages/mcp/dist; ${REAL ? "the runtime's own clock, real timers" : "virtual clock"}, virtual search server, no browser):\n`);
console.log(line(head));
console.log(`|${width.map((w) => "-".repeat(w + 2)).join("|")}|`);
for (const r of rows) console.log(line(r));
for (const s of sessions.filter((x) => x.plan === "systematic")) console.log(`${s.tag}: ${s.coverRows} cover row load(s), ${s.standIns} seeded stand-in(s); races under: ${s.races.map((d) => d.label).join(", ") || "none"}`);
for (const s of sessions.filter((x) => x.plan === "seeded")) console.log(`${s.tag}: races under: ${s.races.map((d) => d.label).join(", ") || "none"}`);
console.log(`sequenceCover(5) has ${need + 2} rows (fifo, lifo and ${need} cover rows): runs 6 gives 5 cover slots, runs ${need + 1} gives ${need}.`);
for (const s of sessions.filter((x) => x.runsAll !== null)) console.log(`${s.tag}: the coverage line names runs ${s.runsAll} for the orderings still missing`);
for (const s of sessions.filter((x) => x.min?.result))
  console.log(`${s.tag} minimise: ${s.min.probes} probe(s) armed, ${s.min.leftOut} left out; ${s.min.result.probes.map((p) => `${p.index + 1} ${p.state}${p.reproduced === true ? " reproduced" : p.reproduced === false ? " not reproduced" : ""}`).join("; ")}`);
const failed = checks.filter((c) => !c.ok);
for (const s of sessions) console.log(`${s.tag}: page-side recordings digest ${s.digest}`);
for (const s of sessions.filter((x) => x.min?.testOn))
  console.log(`${s.tag} regression test (its schedule and assertions, evaluated in Node): ${Object.entries(s.min.testOn).map(([v, o]) => `${v} ${o.passed ? "passes" : "fails"}`).join(", ")}`);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed; ${loadsTotal} page loads, ${io.posts} posts to the bridge, ${((Date.now() - wall0) / 1000).toFixed(1)} s wall time.`);
for (const c of failed) console.log(`FAIL ${c.name}: ${c.detail}`);

await served.close();
rmSync(tokenDir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
