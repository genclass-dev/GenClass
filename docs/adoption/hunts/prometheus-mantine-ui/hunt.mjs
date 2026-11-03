// Race hunt harness for the Prometheus web UI, web/ui/mantine-ui (docs/adoption/hunts/prometheus-mantine-ui.md).
// Not part of CI; run by hand against a local Prometheus and the UI's production build served by `vite preview`.
//
//   node docs/adoption/hunts/prometheus-mantine-ui/hunt.mjs <scenario> [--slow 600] [--runs 6] [--seed 1]
//   node docs/adoption/hunts/prometheus-mantine-ui/hunt.mjs <scenario> --plain [--delay 900] [--runs 8]
//
// Scenarios: tree, table, graph, format, targets, sd, delete (section 4 of the report says what each does).
//
// GenClass is injected from outside: Prometheus' code is unchanged. A Playwright route rewrites each HTML document of
// the app so its <head> starts with the script-tag build (packages/runtime/dist/genclass.global.js, served from the
// virtual same-origin path /__genclass/), configured by an init script (observe, model off, telemetry off, discovery
// off), a mirror atom (rt.atom("prom", ...)) kept current from DOM mutations, and the agent link (dist/agent.js)
// connected to an MCP bridge started in this process with serve() from packages/mcp/dist. Each load is a fresh
// browser context with the local-network-access permission (Chromium otherwise blocks the page's requests to the
// loopback bridge).
//
// The mirror atom holds only what the scenarios can corrupt and what does not move with the clock: the tree view's
// nodes (operator text, result count, label cardinalities; never the per-node response time), the table's series
// labels and "Result series" count (never the sample values or the load time), the graph legend's series, the
// expression input's text, the targets pools with their "up" counts, the delete form's alert text.
//
// The oracle next to explore's verdict: after whenSettled, the harness reads the same regions itself and compares
// them with a reference load of the final state (a fresh page opened directly at the final URL, no GenClass, no
// delays) taken right after. --plain runs the same steps without GenClass and holds the superseded request(s) of each
// scenario for --delay ms with a Playwright route, so the newer response is delivered first; the same oracle.
//
// Environment: APP (default http://localhost:4173, `vite preview` of the mantine-ui build, /api proxied to :9090).

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const rtDist = resolve(repo, "packages/runtime/dist");
const TYPES = { ".js": "text/javascript", ".map": "application/json", ".wasm": "application/wasm", ".json": "application/json" };

const argv = process.argv.slice(2);
const scenarioName = argv.find((a) => !a.startsWith("--")) ?? "tree";
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const PLAIN = flag("plain");
const SLOW = Number(opt("slow", 600));
const RUNS = Number(opt("runs", PLAIN ? 8 : 6));
const SEED = Number(opt("seed", 1));
const DELAY = Number(opt("delay", 900));
// --block-sse: the notifications stream (/api/v1/notifications/live, a long-lived fetch) fails at once, to see which
// of explore's ran-out holds it causes (report section 9). Off for every scenario in the results table.
const BLOCK_SSE = flag("block-sse");
const OUT = resolve(opt("out", join(here, "results")));
const APP = (process.env.APP ?? "http://localhost:4173").replace(/\/$/, "");
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --------------------------------------------------------------------------- the MCP server, driven like an agent
let tool = async () => "";
let served = null;
let bridgeUrl = "";
if (!PLAIN) {
  const { serve } = await import(join(repo, "packages/mcp/dist/index.js"));
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  served = await serve({ cwd: here, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: null });
  let id = 0;
  const rpc = async (method, params = {}) => {
    const my = ++id;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
    for (let i = 0; i < 3000; i++) {
      const m = lines.find((x) => x.id === my);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no reply to ${method}`);
  };
  tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prometheus-hunt", version: "1" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  bridgeUrl = `http://127.0.0.1:${served.port}`;
}

// --------------------------------------------------------------------------- what the page reads (oracle and mirror)
// One function, run in the page: by the mirror atom (on every DOM mutation, coalesced per frame) and by the harness.
const readRegions = () => {
  const sq = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const out = {};
  const nodes = [...document.querySelectorAll('[class*="_nodeText_"]')];
  if (nodes.length) {
    out.tree = nodes.map((n) => {
      const info = n.nextElementSibling ? sq(n.nextElementSibling.textContent) : "";
      // "4 results – 20ms – job: 4" -> "4 results | job: 4" (the response time moves with the clock)
      return `${sq(n.textContent)} :: ${info.replace(/–\s*[\d.]+\s*m?s\s*–/g, "|").replace(/\s+/g, " ")}`;
    });
  }
  const tablePanel = document.querySelector('[role="tabpanel"][id$="-panel-table"]') || [...document.querySelectorAll('[role="tabpanel"]')].find((p) => /Load time|Evaluation time/.test(p.textContent || ""));
  if (tablePanel && tablePanel.offsetParent !== null) {
    const m = /Result series:\s*(\d+)/.exec(tablePanel.textContent || "");
    out.tableSeries = m ? Number(m[1]) : null;
    out.tableRows = [...tablePanel.querySelectorAll("tbody tr")].map((r) => sq(r.querySelector("td")?.textContent)).filter(Boolean).sort();
    const empty = /No data queried yet|Empty query result|no data/i.exec(tablePanel.textContent || "");
    if (empty) out.tableNote = empty[0];
  }
  const range = document.querySelector('input[aria-label="Range"]');
  if (range) {
    out.graphRange = range.value;
    const graphPanel = range.closest('[role="tabpanel"]');
    out.graphLegend = [...(graphPanel?.querySelectorAll("table tr") ?? [])].map((r) => sq(r.textContent)).filter(Boolean).sort();
  }
  const cm = document.querySelector(".cm-content");
  if (cm) out.input = sq(cm.textContent);
  const poolSelect = document.querySelector('input[placeholder="Select scrape pool"], input[aria-haspopup="listbox"]');
  if (location.pathname.endsWith("/targets") || location.pathname.endsWith("/service-discovery")) {
    out.pool = poolSelect ? poolSelect.value : null;
    out.pools = [...document.querySelectorAll("main .mantine-Accordion-control")].map((c) => sq(c.textContent).replace("Show config", "").replace(/\s+/g, " ").trim());
  }
  if (location.pathname.endsWith("/tsdb-status")) {
    out.alerts = [...document.querySelectorAll("main [role=alert]")].map((a) => sq(a.textContent)).filter((t) => !/^Warning/.test(t));
  }
  return out;
};

const mirrorSource = `
(() => {
  const rt = window.GenClass && window.GenClass.runtime;
  if (!rt) return;
  const atom = rt.atom("prom", {});
  const read = ${readRegions.toString()};
  let last = "";
  const sync = () => {
    try {
      const v = read();
      const k = JSON.stringify(v);
      if (k !== last) { last = k; atom.set(v); }
    } catch (e) { /* never break the page */ }
  };
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; sync(); }); };
  const start = () => { new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["value", "aria-selected"] }); document.addEventListener("input", schedule, true); schedule(); };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
`;
const connectSource = `import { connectAgent } from "/__genclass/agent.js";
window.__GENCLASS_CONN__ = connectAgent(window.GenClass && window.GenClass.runtime, { url: window.__GENCLASS_AGENT_URL__ });
`;
const initScript = ({ bridge }) => {
  window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, devtools: false, visual: false, analytics: false, report: "silent", autoState: false };
  window.__GENCLASS_AGENT_URL__ = bridge;
};

const browser = await chromium.launch();

async function newContext({ genclass, holds }) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, permissions: genclass ? ["local-network-access"] : [] });
  if (genclass) {
    await ctx.addInitScript(initScript, { bridge: bridgeUrl });
    await ctx.route((u) => u.pathname.startsWith("/__genclass/"), async (route) => {
      const u = new URL(route.request().url());
      const file = join(rtDist, u.pathname.slice("/__genclass/".length));
      if (!file.startsWith(rtDist) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    });
    await ctx.route(
      (u) => u.origin === APP && !u.pathname.startsWith("/api/") && !u.pathname.startsWith("/assets/") && !u.pathname.startsWith("/__genclass/"),
      async (route) => {
        if (route.request().resourceType() !== "document") return route.fallback();
        const res = await route.fetch();
        const ct = res.headers()["content-type"] ?? "";
        if (!ct.includes("text/html")) return route.fulfill({ response: res });
        const html = (await res.text()).replace(
          /<head([^>]*)>/i,
          (m) => `${m}\n<script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script>\n<script>${mirrorSource}</script>\n<script type="module">${connectSource}</script>`,
        );
        const { "content-encoding": _e, "content-length": _l, ...headers } = res.headers();
        return route.fulfill({ status: res.status(), headers, contentType: "text/html; charset=utf-8", body: html });
      },
    );
  }
  // --plain: hold the superseded request(s) so the newer response is delivered first (no GenClass on the page)
  const held = [];
  if (BLOCK_SSE) await ctx.route((u) => u.pathname.endsWith("/api/v1/notifications/live"), (route) => route.abort());
  if (holds) {
    await ctx.route(
      (u) => u.origin === APP && u.pathname.startsWith("/api/"),
      async (route) => {
        const req = route.request();
        const url = decodeURIComponent(req.url()).replace(/\+/g, " ");
        if (holds.test(url, req.method())) {
          held.push(url.replace(/^.*\/api\/v1/, ""));
          await new Promise((r) => setTimeout(r, DELAY));
        }
        return route.fallback();
      },
    );
  }
  return { ctx, held };
}

// --------------------------------------------------------------------------- scenarios
const q = (expr, extra = "") => `${APP}/query?g0.expr=${encodeURIComponent(expr)}${extra}`;
const EXPR = {
  treeA: "rate(process_cpu_seconds_total[1m]) * on(instance, job) group_left(version) prometheus_build_info",
  treeB: "sum by (job) (up) + count by (job) (go_goroutines)",
  table1: "count by (job) (up)",
  table2: "sum by (job) (up == 0)",
  graph1: "count by (job) (up)",
  formatA: "sum   by(job)(up)",
  formatB: "count by(  instance )( go_goroutines )",
};

async function ready(page) {
  if (PLAIN) return;
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
}
async function setExpr(page, expr) {
  const cm = page.locator(".cm-content").first();
  await cm.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(expr);
  await page.keyboard.press("Escape"); // close the autocomplete popup, if any
}
const execute = (page) => page.getByRole("button", { name: "Execute" }).first().click();
async function pickPool(page, name) {
  const select = page.locator('input[placeholder="Select scrape pool"], main input[aria-haspopup="listbox"]').first();
  await select.click();
  await page.getByRole("option", { name, exact: true }).click();
}

// Each scenario: the steps, the final URL the reference load opens, and (for --plain) which requests to hold.
const scenarios = {
  tree: {
    route: "/query",
    async steps(page) {
      await page.goto(q(EXPR.treeA, "&g0.show_tree=1&g0.tab=table"));
      await ready(page);
      await page.locator('[class*="_nodeText_"]').first().waitFor({ timeout: 20_000 });
      await setExpr(page, EXPR.treeB);
      await execute(page);
    },
    reference: () => q(EXPR.treeB, "&g0.show_tree=1&g0.tab=table"),
    holds: { test: (u) => /\/query\?query=/.test(u) && /process_cpu|prometheus_build_info|version/.test(u) },
    keys: ["tree", "tableSeries", "tableRows"],
  },
  table: {
    route: "/query",
    async steps(page) {
      await page.goto(q("up", "&g0.tab=table"));
      await ready(page);
      await page.locator('[role="tabpanel"] tbody tr').first().waitFor({ timeout: 20_000 });
      await setExpr(page, EXPR.table1);
      await execute(page);
      await setExpr(page, EXPR.table2);
      await execute(page);
    },
    reference: () => q(EXPR.table2, "&g0.tab=table"),
    holds: { test: (u) => /\/query\?query=count by \(job\) \(up\)&/.test(u) },
    keys: ["tableSeries", "tableRows"],
  },
  graph: {
    route: "/query",
    async steps(page) {
      await page.goto(q("up", "&g0.tab=graph&g0.range_input=1h"));
      await ready(page);
      await page.locator('input[aria-label="Range"]').waitFor({ timeout: 20_000 });
      await setExpr(page, EXPR.graph1);
      await execute(page);
      await page.getByRole("button", { name: "Decrease range" }).click();
    },
    reference: () => q(EXPR.graph1, "&g0.tab=graph&g0.range_input=30m"),
    holds: { test: (u) => /\/query_range\?/.test(u) && (/query=up&/.test(u) || /step=14&/.test(u)) },
    keys: ["graphRange", "graphLegend"],
  },
  format: {
    route: "/query",
    async steps(page) {
      await page.goto(q("up", "&g0.tab=table"));
      await ready(page);
      await page.locator(".cm-content").waitFor({ timeout: 20_000 });
      await setExpr(page, EXPR.formatA);
      await page.getByRole("button", { name: "Show query options" }).click();
      await page.getByRole("menuitem", { name: /Format expression/ }).click();
      await setExpr(page, EXPR.formatB);
      await page.getByRole("button", { name: "Show query options" }).click();
      await page.getByRole("menuitem", { name: /Format expression/ }).click();
    },
    reference: null, // the API's own /format_query of the second draft
    holds: { test: (u) => /\/format_query\?query=sum/.test(u) },
    keys: ["input"],
  },
  targets: {
    route: "/targets",
    async steps(page) {
      await page.goto(`${APP}/targets`);
      await ready(page);
      await page.locator("main .mantine-Accordion-control").first().waitFor({ timeout: 20_000 });
      await pickPool(page, "self-a");
      await pickPool(page, "self-b");
    },
    reference: () => `${APP}/targets?pool=self-b`,
    holds: { test: (u) => /\/targets\?.*scrapePool=self-a/.test(u) },
    keys: ["pool", "pools"],
  },
  sd: {
    route: "/service-discovery",
    async steps(page) {
      await page.goto(`${APP}/service-discovery`);
      await ready(page);
      await page.locator("main .mantine-Accordion-control").first().waitFor({ timeout: 20_000 });
      await pickPool(page, "self-a");
      await pickPool(page, "self-b");
    },
    reference: () => `${APP}/service-discovery?pool=self-b`,
    holds: { test: (u) => /\/targets\?.*scrapePool=self-a/.test(u) },
    keys: ["pool", "pools"],
  },
  delete: {
    route: "/tsdb-status",
    async steps(page, wire) {
      await page.goto(`${APP}/tsdb-status`);
      await ready(page);
      const box = page.getByRole("textbox", { name: "Series selector(s)" });
      await box.waitFor({ timeout: 20_000 });
      await box.fill('go_gc_duration_seconds{job="self-a"}');
      await page.getByRole("button", { name: "Delete series" }).dblclick();
    },
    reference: null, // one POST per user intent; the success alert
    holds: { test: (u, m) => m === "POST" && /delete_series/.test(u) },
    keys: ["alerts"],
  },
};

const sc = scenarios[scenarioName];
if (!sc) throw new Error(`unknown scenario ${scenarioName}; one of ${Object.keys(scenarios).join(", ")}`);

async function readPage(page) {
  return page.evaluate(readRegions);
}
async function referenceRead() {
  if (scenarioName === "format") {
    const r = await (await fetch(`${APP}/api/v1/format_query?query=${encodeURIComponent(EXPR.formatB)}`)).json();
    return { input: r.data };
  }
  if (scenarioName === "delete") return { alerts: ['SuccessSuccessfully deleted series matching: go_gc_duration_seconds{job="self-a"}'], posts: 1 };
  const { ctx } = await newContext({ genclass: false });
  const page = await ctx.newPage();
  await page.goto(sc.reference());
  // not "networkidle": the notifications stream (/api/v1/notifications/live) never goes idle
  await page.waitForTimeout(2500);
  const v = await readPage(page);
  await ctx.close();
  return v;
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? null]));

async function load(n) {
  const { ctx, held } = await newContext({ genclass: !PLAIN, holds: PLAIN ? sc.holds : null });
  const page = await ctx.newPage();
  const errors = [];
  const wire = [];
  page.on("pageerror", (e) => errors.push(String(e).split("\n")[0]));
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/")) wire.push(`${r.method()} ${decodeURIComponent(r.url().replace(/^.*\/api\/v1/, "")).replace(/\+/g, " ").slice(0, 140)}`);
  });
  page.on("requestfailed", (r) => {
    if (r.url().includes("/api/v1/")) wire.push(`ABORTED ${decodeURIComponent(r.url().replace(/^.*\/api\/v1/, "")).replace(/\+/g, " ").slice(0, 140)}`);
  });
  let agent = null;
  let error = null;
  try {
    if (!PLAIN) {
      await sc.steps(page, wire); // each scenario waits for the agent link's connection right after its page load
      await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(20_000));
      agent = await page.evaluate(() => ({ run: window.__GENCLASS_AGENT__?.run, schedule: window.__GENCLASS_AGENT__?.schedule, witnesses: window.__GENCLASS_AGENT__?.witnesses().length, errors: window.__GENCLASS_AGENT__?.errors().length, forced: window.__GENCLASS_AGENT__?.snapshot().forced }));
    } else {
      await sc.steps(page, wire);
      await page.waitForTimeout(DELAY + 1500);
    }
    await page.waitForTimeout(600);
  } catch (e) {
    error = String(e).split("\n")[0];
  }
  const shown = await readPage(page).catch(() => ({}));
  if (!PLAIN) await page.waitForTimeout(500); // the snapshot batch reaches the bridge
  await ctx.close();
  const ref = await referenceRead();
  const posts = wire.filter((w) => w.startsWith("POST ")).length;
  const got = pick(shown, sc.keys);
  const want = pick(ref, sc.keys);
  if (scenarioName === "delete") {
    got.posts = posts;
    want.posts = 1;
  }
  const same = JSON.stringify(got) === JSON.stringify(want);
  return { n, error, pageErrors: errors, same, got, want: same ? "(same)" : want, held, agent, wire };
}

const label = `${scenarioName}-${PLAIN ? `plain-delay${DELAY}` : `slow${SLOW}-seed${SEED}`}${BLOCK_SSE ? "-nosse" : ""}`;
const summary = { scenario: scenarioName, app: APP, plain: PLAIN, slow_ms: PLAIN ? null : SLOW, delay_ms: PLAIN ? DELAY : null, runs: RUNS, seed: SEED, loads: [] };
if (!PLAIN) {
  await tool("genclass_clear", { what: "all" });
  summary.exploreStart = await tool("genclass_explore", { action: "start", runs: RUNS, slow_ms: SLOW, seed: SEED, route: sc.route });
  log(summary.exploreStart.split("\n")[0]);
}
const total = PLAIN ? RUNS : RUNS + 2;
for (let i = 0; i < total; i++) {
  const r = await load(i + 1);
  summary.loads.push(r);
  log(`load ${i + 1}/${total} same=${r.same}${r.error ? ` error=${r.error}` : ""}${r.held.length ? ` held=${r.held.length}` : ""} agent=${JSON.stringify(r.agent)}`);
  if (!r.same) log("  got ", JSON.stringify(r.got).slice(0, 400), "\n  want", JSON.stringify(r.want).slice(0, 400));
}
if (!PLAIN) {
  summary.report = await tool("genclass_explore", { action: "report" });
  console.log(summary.report);
  const ids = [...summary.report.matchAll(/Race finding\(s\): ([^\n]+)/g)].flatMap((m) => m[1].split(/[,\s]+/).filter((x) => /^f\d+$/.test(x)));
  summary.findings = await tool("genclass_findings", {});
  summary.explains = {};
  for (const id of new Set(ids)) summary.explains[id] = await tool("genclass_explain", { id });
}
summary.oracle = `${summary.loads.filter((l) => l.same).length} of ${summary.loads.length} loads showed the reference state`;
log(summary.oracle);
writeFileSync(join(OUT, `${label}.json`), JSON.stringify(summary, null, 2));
log("written", join(OUT, `${label}.json`));
await browser.close();
if (served) await served.close();
process.exit(0);
