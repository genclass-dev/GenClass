// Race hunt harness for Grafana's admin lists (docs/adoption/hunts/grafana-panel-refresh.md). Not part of CI; run by
// hand against a local Grafana seeded with seed.mjs (admin/admin, http://localhost:3000).
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp          # in GenClass-lib, once
//   node docs/adoption/hunts/grafana-panel-refresh/hunt.mjs explore <scenario> [--slow 300,600,900] [--runs 6] [--out dir]
//   node docs/adoption/hunts/grafana-panel-refresh/hunt.mjs plain <scenario> [--n 5] [--delay 1500]
//   node docs/adoption/hunts/grafana-panel-refresh/hunt.mjs once <scenario>      # one natural load with GenClass
//
// explore: GenClass is injected from outside (Grafana's source is unchanged): a Playwright route rewrites each Grafana
// HTML page to load the script-tag build (packages/runtime/dist/genclass.global.js, observe mode, model off, telemetry
// off, visual checks off) from a virtual same-origin path, and the agent entry (dist/agent.js) connects to the MCP
// bridge started in this process with serve() from packages/mcp/dist. Grafana's Redux store (Redux Toolkit
// configureStore, devtools on in the dev build) is discovered through the Redux DevTools compose global. For each
// --slow value: genclass_explore start (2 fifo baselines + --runs seeded loads, each response delayed by a seeded
// 0..slow ms), the scenario once per armed load, then report, findings and explain. Each load also records an oracle
// of this script's own (what the list shows after whenSettled(), compared with what the last action asked for).
//
// plain: the reproduction without GenClass. No injection; page.route delays the response of the FIRST list request
// made by the scenario's actions by --delay ms (a slower network for one request), --n loads, then --n control loads
// without the delay. The oracle is the same.
//
// Scenarios (the actions after the page has loaded and settled):
//   admin-page     /admin/users: click page 2, then page 3 at once            (fetchUsers, immediate)
//   admin-search   /admin/users: type "lunar", pause 550 ms, type "-o"        (fetchUsers, debounce 500 ms)
//   sa-page        /org/serviceaccounts: click page 2, then page 3 at once    (fetchServiceAccounts, immediate)
//   sa-search      /org/serviceaccounts: type "lunar", pause 550 ms, type " o" (debounce 500 ms, leading)
//   org-page       /org/users, tab Organization users: click page 2, then page 3 at once              (loadUsers, immediate)
//   org-search     /org/users, tab Organization users: type "lunar", pause 350 ms, type " o"          (loadUsers, debounce 300 ms)
//   org-search-replace  as org-search, but the second burst replaces the text with "amber" (Ctrl+A, type)
//   panel-refresh  /d/hunt-refresh: click the dashboard refresh button twice   (negative control: PanelQueryRunner)
//   cp-save        contact point "hunt-email": edit, double-click Save          (negative control: ReceiverForm)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const rtDist = join(root, "packages/runtime/dist");

const { values: arg, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    grafana: { type: "string", default: "http://localhost:3000" },
    password: { type: "string", default: "admin" },
    slow: { type: "string", default: "300,600,900" },
    runs: { type: "string", default: "6" },
    n: { type: "string", default: "5" },
    delay: { type: "string", default: "1500" },
    out: { type: "string", default: join(here, "results") },
  },
});
const [mode, scenarioName] = positionals;
const G = arg.grafana.replace(/\/+$/, "");
const TYPES = { ".js": "text/javascript", ".map": "application/json" };
const basic = `Basic ${Buffer.from(`admin:${arg.password}`).toString("base64")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------- the scenarios
const LOGIN = /\b([a-z]+-(?:falcon|heron|otter|badger|lynx|marten|osprey|plover|raven|stoat))\b/g;
const SA = /\bsvc ([a-z]+) (falcon|heron|otter|badger|lynx|marten|osprey|plover|raven|stoat)\b/g;
const uniq = (xs) => [...new Set(xs)];

async function api(path) {
  const res = await fetch(`${G}${path}`, { headers: { authorization: basic, accept: "application/json" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function tableNames(page, re) {
  const text = await page.locator("table tbody").first().innerText().catch(() => "");
  return uniq([...text.matchAll(re)].map((m) => m[0]));
}
async function currentPage(page) {
  return page.locator('ol li button[aria-current="page"]').first().innerText().catch(() => "?");
}

/** list scenarios: what the last action asked for (expected) and what the list shows (shown) */
const list = {
  admin: {
    path: "/admin/users",
    re: LOGIN,
    search: 'input[placeholder="Search user by login, email, or name."]',
    expectPage: async (p) => (await api(`/api/users/search?perpage=50&page=${p}&query=&activeLast30Days=false`)).users.map((u) => u.login),
    expectQuery: async (q) => (await api(`/api/users/search?perpage=50&page=1&query=${encodeURIComponent(q)}&activeLast30Days=false`)).users.map((u) => u.login),
    req: /\/api\/users\/search/,
    pause: 550,
    second: "-o",
  },
  sa: {
    path: "/org/serviceaccounts",
    re: SA,
    search: 'input[placeholder="Search service account by name"]',
    expectPage: async (p) => (await api(`/api/serviceaccounts/search?perpage=50&page=${p}&query=`)).serviceAccounts.map((s) => s.name),
    expectQuery: async (q) => (await api(`/api/serviceaccounts/search?perpage=50&page=1&query=${encodeURIComponent(q)}`)).serviceAccounts.map((s) => s.name),
    req: /\/api\/serviceaccounts\/search/,
    pause: 550,
    second: " o",
  },
  org: {
    path: "/org/users",
    tab: "Organization users", // a Grafana admin lands on the "All users" tab (the server-admin list) of this route
    re: LOGIN,
    search: 'input[placeholder="Search user by login, email or name"]',
    expectPage: async (p) => (await api(`/api/org/users/search?perpage=30&page=${p}&query=`)).orgUsers.map((u) => u.login),
    expectQuery: async (q) => (await api(`/api/org/users/search?perpage=30&page=1&query=${encodeURIComponent(q)}`)).orgUsers.map((u) => u.login),
    req: /\/api\/org\/users\/search/,
    pause: 350,
    second: " o", // not "-o": the org list's FilterInput regex-escapes the query (lunar\\-o), which matches nobody
  },
};

function compare(expected, shown, extra = "") {
  const ok = expected.length === shown.length && expected.every((x, i) => x === shown[i]);
  return { ok, line: `${ok ? "OK   " : "WRONG"} shows ${shown.length} [${shown.slice(0, 3).join(", ")}${shown.length > 3 ? ", ..." : ""}] expected ${expected.length} [${expected.slice(0, 3).join(", ")}${expected.length > 3 ? ", ..." : ""}]${extra}` };
}

async function openTab(page, L) {
  if (L.tab) await page.getByRole("tab", { name: L.tab }).click();
}

function pageScenario(kind) {
  const L = list[kind];
  return {
    path: L.path,
    req: L.req,
    async ready(page) {
      await openTab(page, L);
      await page.locator("table tbody tr").first().waitFor({ timeout: 30_000 });
      await page.locator("ol li button").filter({ hasText: /^3$/ }).first().waitFor({ timeout: 30_000 });
    },
    async act(page) {
      // two fast clicks as a person makes them: raw mouse input at the buttons' positions, measured first (Playwright's
      // locator.click() waits for the page between the two, which no person does)
      const two = page.locator("ol li button").filter({ hasText: /^2$/ }).first();
      const three = page.locator("ol li button").filter({ hasText: /^3$/ }).first();
      await three.scrollIntoViewIfNeeded();
      const [b2, b3] = [await two.boundingBox(), await three.boundingBox()];
      await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 2);
      await page.mouse.click(b3.x + b3.width / 2, b3.y + b3.height / 2);
    },
    async oracle(page) {
      const shown = (await tableNames(page, L.re)).sort();
      const expected = (await L.expectPage(3)).filter((x) => new RegExp(L.re.source).test(x)).sort();
      return compare(expected, shown, ` (page button ${await currentPage(page)})`);
    },
  };
}
function searchScenario(kind, replace = null) {
  const L = list[kind];
  return {
    path: L.path,
    req: L.req,
    async ready(page) {
      await openTab(page, L);
      await page.locator(L.search).waitFor({ timeout: 30_000 });
      await page.locator("table tbody tr").first().waitFor({ timeout: 30_000 });
    },
    async act(page) {
      const box = page.locator(L.search);
      await box.click();
      await box.pressSequentially("lunar", { delay: 30 });
      await page.waitForTimeout(L.pause);
      if (replace) {
        // a new search rather than a refinement: select the text and type another word over it
        await box.press("Control+a");
        await box.pressSequentially(replace, { delay: 30 });
      } else {
        await box.pressSequentially(L.second, { delay: 30 });
      }
    },
    async oracle(page) {
      const q = await page.locator(L.search).inputValue();
      const shown = (await tableNames(page, L.re)).sort();
      const expected = (await L.expectQuery(q)).sort();
      return compare(expected, shown, ` (query "${q}")`);
    },
  };
}

const scenarios = {
  "admin-page": pageScenario("admin"),
  "admin-search": searchScenario("admin"),
  "sa-page": pageScenario("sa"),
  "sa-search": searchScenario("sa"),
  "org-page": pageScenario("org"),
  "org-search": searchScenario("org"),
  // the org list also filters the stored users by the current query on the client (users/state/selectors.ts), which
  // hides a stale response under a refinement ("lunar" -> "lunar o") but not under a new word
  "org-search-replace": searchScenario("org", "amber"),
  "panel-refresh": {
    path: "/d/hunt-refresh/hunt-refresh",
    req: /\/api\/ds\/query/,
    async ready(page) {
      await page.getByText("Alpha load").first().waitFor({ timeout: 30_000 });
      await page.getByText("Bravo load").first().waitFor({ timeout: 30_000 });
    },
    async act(page) {
      const run = page.getByTestId("data-testid RefreshPicker run button");
      await run.click();
      await run.click();
    },
    async oracle(page) {
      const text = (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
      const a = /Alpha load\s+(\d+)/.exec(text)?.[1];
      const b = /Bravo load\s+(\d+)/.exec(text)?.[1];
      const ok = a === "5" && b === "4" && !/error/i.test(text);
      return { ok, line: `${ok ? "OK   " : "WRONG"} Alpha load=${a} Bravo load=${b}${/error/i.test(text) ? " (error shown)" : ""}` };
    },
  },
  "cp-save": {
    // the edit page of the contact point (the receiver's name, base64url without padding, as the list's Edit link has it)
    path: `/alerting/notifications/receivers/${Buffer.from("hunt-email").toString("base64url")}/edit`,
    req: /receivers|contactpoints|alertmanager/,
    async ready(page) {
      await page.getByRole("button", { name: /save contact point/i }).waitFor({ timeout: 30_000 });
    },
    async act(page) {
      // a double click on Save, as raw mouse input (two clicks, no wait in between)
      const save = page.getByRole("button", { name: /save contact point/i });
      await save.scrollIntoViewIfNeeded();
      const b = await save.boundingBox();
      await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
    },
    async oracle(page) {
      await page.waitForTimeout(500);
      const cps = await api("/api/v1/provisioning/contact-points?name=hunt-email");
      const errors = await page.getByRole("alert").allInnerTexts().catch(() => []);
      const bad = errors.filter((t) => /error|fail|conflict/i.test(t));
      const ok = cps.length === 1 && bad.length === 0;
      return { ok, line: `${ok ? "OK   " : "WRONG"} hunt-email contact points: ${cps.length}; error alerts: ${bad.length ? bad.join(" | ").slice(0, 120) : "none"} (now on ${new URL(page.url()).pathname})` };
    },
  },
};

// --------------------------------------------------------------------------- login and injection
async function storageState(browser) {
  const ctx = await browser.newContext();
  const res = await ctx.request.post(`${G}/login`, { data: { user: "admin", password: arg.password } });
  if (res.status() !== 200) throw new Error(`login failed: HTTP ${res.status()} ${await res.text()}`);
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

function tags(bridgeUrl) {
  const cfg = { telemetry: false, mode: "observe", model: false, visual: false, devtools: false, report: "silent" };
  return (
    `<script>window.GENCLASS_CONFIG=${JSON.stringify(cfg)};window.__GENCLASS_AGENT_URL__=${JSON.stringify(bridgeUrl)};</script>` +
    `<script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script>` +
    `<script type="module">import{connectAgent}from"/__genclass/agent.js";connectAgent(window.GenClass.runtime,{url:${JSON.stringify(bridgeUrl)}});</script>`
  );
}

async function hermetic(ctx) {
  // only the local Grafana and the loopback bridge are reachable (Grafana's frontend asks grafana.com for news and plugins)
  await ctx.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => route.abort());
}

async function inject(ctx, bridgeUrl) {
  await ctx.route(`${G}/__genclass/**`, (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/__genclass\//, "");
    const file = resolve(rtDist, p);
    if (!file.startsWith(rtDist) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  await ctx.route(`${G}/**`, async (route) => {
    const req = route.request();
    if (req.resourceType() !== "document") return route.fallback();
    const res = await route.fetch();
    const type = res.headers()["content-type"] ?? "";
    if (!type.includes("text/html")) return route.fulfill({ response: res });
    const body = (await res.text()).replace(/<head([^>]*)>/i, (m) => `${m}${tags(bridgeUrl)}`);
    return route.fulfill({ response: res, body });
  });
}

async function connected(page) {
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 30_000 });
}
async function settle(page) {
  await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(20_000));
}

// --------------------------------------------------------------------------- the MCP server, driven like an agent
async function startMcp() {
  const { serve } = await import(join(root, "packages/mcp/dist/index.js"));
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
  const served = await serve({ cwd: here, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: null });
  let id = 0;
  async function rpc(method, params = {}) {
    const my = ++id;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
    for (let i = 0; i < 3000; i++) {
      const m = lines.find((x) => x.id === my);
      if (m) return m;
      await sleep(10);
    }
    throw new Error(`no reply to ${method}`);
  }
  const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grafana-hunt", version: "1" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { tool, bridgeUrl: `http://127.0.0.1:${served.port}`, close: () => served.close() };
}

// --------------------------------------------------------------------------- one load
async function load(browser, state, sc, { bridgeUrl = null, delayFirst = 0 } = {}) {
  const ctx = await browser.newContext({ storageState: state, permissions: bridgeUrl ? ["local-network-access"] : [], viewport: { width: 1400, height: 1000 } });
  await hermetic(ctx);
  if (bridgeUrl) await inject(ctx, bridgeUrl);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).split("\n")[0]));
  const sent = [];
  let armed = false;
  let delayed = 0;
  if (delayFirst) {
    // plain reproduction: only the first list request the actions make is slowed down
    await page.route((url) => sc.req.test(url.pathname), async (route) => {
      sent.push(new URL(route.request().url()).search);
      if (armed && delayed === 0) {
        delayed++;
        await sleep(delayFirst);
      }
      return route.fallback();
    });
  }
  let result;
  try {
    await page.goto(`${G}${sc.path}`);
    if (bridgeUrl) await connected(page);
    await sc.ready(page);
    if (bridgeUrl) await settle(page);
    else await page.waitForLoadState("networkidle");
    armed = true;
    await sc.act(page);
    if (bridgeUrl) await settle(page);
    else await page.waitForTimeout(delayFirst + 1500);
    result = await sc.oracle(page);
  } catch (e) {
    result = { ok: false, line: `ERROR ${String(e).split("\n")[0]}` };
  }
  let order = [];
  if (bridgeUrl) {
    order = await page
      .evaluate((src) => window.__GENCLASS_AGENT__.recorded().order.filter((k) => new RegExp(src).test(k)).map((k) => k.slice(k.indexOf("?") >= 0 ? k.indexOf("?") : 0)), sc.req.source)
      .catch(() => []);
    await page.waitForTimeout(500); // the last snapshot batch reaches the bridge
  }
  await ctx.close();
  return { ...result, order, errors, sent };
}

// --------------------------------------------------------------------------- modes
const sc = scenarios[scenarioName];
if (!sc || !["explore", "plain", "once"].includes(mode)) {
  console.error(`usage: hunt.mjs explore|plain|once <${Object.keys(scenarios).join("|")}>`);
  process.exit(2);
}
mkdirSync(arg.out, { recursive: true });
const browser = await chromium.launch();
const state = await storageState(browser);

if (mode === "plain") {
  const n = Number(arg.n);
  const delay = Number(arg.delay);
  const out = { scenario: scenarioName, delay_ms: delay, delayed: [], control: [] };
  for (let i = 0; i < n; i++) out.delayed.push(await load(browser, state, sc, { delayFirst: delay }));
  for (let i = 0; i < n; i++) out.control.push(await load(browser, state, sc, { delayFirst: 0 }));
  const count = (xs) => `${xs.filter((r) => !r.ok).length} of ${xs.length} wrong`;
  const summary = {
    scenario: scenarioName,
    delay_ms: delay,
    delayed: count(out.delayed),
    control: count(out.control),
    delayedLines: out.delayed.map((r) => r.line),
    controlLines: out.control.map((r) => r.line),
    requests: out.delayed[0]?.sent,
  };
  writeFileSync(join(arg.out, `plain-${scenarioName}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} else {
  const mcp = await startMcp();
  if (mode === "once") {
    const r = await load(browser, state, sc, { bridgeUrl: mcp.bridgeUrl });
    console.log(r);
    console.log(await mcp.tool("genclass_findings"));
  } else {
    const summary = { scenario: scenarioName, runs: Number(arg.runs), sessions: [] };
    for (const slow of arg.slow.split(",").map(Number)) {
      await mcp.tool("genclass_clear", { what: "all" });
      const started = await mcp.tool("genclass_explore", { action: "start", runs: Number(arg.runs), slow_ms: slow });
      const loads = [];
      for (let i = 0; i < Number(arg.runs) + 2; i++) loads.push(await load(browser, state, sc, { bridgeUrl: mcp.bridgeUrl }));
      const report = await mcp.tool("genclass_explore", { action: "report" });
      const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1];
      const explain = fid ? await mcp.tool("genclass_explain", { id: fid }) : "";
      const findings = await mcp.tool("genclass_findings");
      const verdict = /RACE: (\d+) of (\d+)/.exec(report);
      const session = {
        slow_ms: slow,
        verdict: verdict ? `RACE in ${verdict[1]} of ${verdict[2]}` : (/No race found|No verdict[^\n]*|Internal state only[^\n]*|Along the way only[^\n]*/.exec(report)?.[0] ?? "see report"),
        oracleWrong: `${loads.filter((r) => !r.ok).length} of ${loads.length}`,
        loads: loads.map((r, i) => `load ${i + 1}: ${r.line} [delivered ${r.order.join(" then ") || "none"}]${r.errors.length ? ` [pageerror ${r.errors[0]}]` : ""}`),
      };
      summary.sessions.push(session);
      writeFileSync(join(arg.out, `explore-${scenarioName}-${slow}.txt`), [started, "", ...session.loads, "", report, "", findings, "", explain].join("\n"));
      console.log(`--- ${scenarioName} slow_ms=${slow}: ${session.verdict}; oracle wrong in ${session.oracleWrong}`);
      for (const l of session.loads) console.log(`  ${l}`);
    }
    writeFileSync(join(arg.out, `explore-${scenarioName}.json`), JSON.stringify(summary, null, 2));
  }
  await mcp.close();
}
await browser.close();
process.exit(0);
