// The GenClass race hunt on Tandoor Recipes' Vue 3 frontend (docs/adoption/hunts/tandoor-recipes.md). Not part of CI.
//
// It drives a locally running Tandoor (Django runserver on TANDOOR_URL, default http://127.0.0.1:8000, serving the
// production `yarn build` of vue3/) in headless Chromium with the real @genclass/runtime script-tag build and the agent
// entry injected into Tandoor's HTML by a Playwright route (Tandoor's source is untouched), the real @genclass/mcp
// server in-process (its bridge on a free port), and the same tool calls a coding agent makes:
// genclass_explore start → one page load per armed run → report → genclass_explain → genclass_replay.
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp     # in GenClass-lib
//   node docs/adoption/hunts/tandoor-recipes/seed.mjs                        # once, after /setup/
//   node docs/adoption/hunts/tandoor-recipes/hunt.mjs probe <path> [ms] [selector]
//   node docs/adoption/hunts/tandoor-recipes/hunt.mjs once <scenario> [slow_ms]
//   node docs/adoption/hunts/tandoor-recipes/hunt.mjs explore <scenario> <slow_ms> [runs]
//
// Tandoor keeps its state in Pinia stores and component refs; GenClass discovers no store here, so the injected script
// registers one atom, "visible", that mirrors what the regions under test show (written from a MutationObserver). Next
// to the explore verdict, every load reads an oracle of its own after the page settled: the DOM against what the last
// user step asked for, and for the shopping list the server's entries and the number of bulk writes on the wire.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { chromium } from "@playwright/test";
import { serve } from "../../../../packages/mcp/dist/index.js";
import { BASE as APP, OUT, login } from "./seed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const rtDist = join(repo, "packages/runtime/dist");
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".map": "application/json", ".wasm": "application/wasm" };
mkdirSync(OUT, { recursive: true });
const fixture = () => JSON.parse(readFileSync(join(OUT, "fixture.json"), "utf8"));

// --------------------------------------------------------------------------- the MCP server, driven like an agent
let served = null;
let input;
let id = 0;
const lines = [];
async function startServer() {
  input = new PassThrough();
  const output = new PassThrough();
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
  served = await serve({ cwd: OUT, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: join(OUT, process.env.HUNT_STATE ?? "state") });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tandoor-hunt", version: "1" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return `http://127.0.0.1:${served.port}`;
}
async function rpc(method, params = {}) {
  const my = ++id;
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
  for (let i = 0; i < 3000; i++) {
    const m = lines.find((x) => x.id === my);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no reply to ${method}`);
}
const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;

// --------------------------------------------------------------------------- injection (Tandoor's files untouched)
// The atom mirrors what the regions under test show. It reads the DOM only.
function mirror() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
  return () => {
    const out = {};
    // an open picker's menu (VModelSelect → v-autocomplete, teleported into the overlay container)
    const menu = document.querySelector(".v-overlay-container .v-autocomplete__content, .v-overlay-container .v-menu > .v-overlay__content");
    if (menu) out.pickerItems = Array.from(menu.querySelectorAll(".v-list-item-title")).map(text).join(" | ");
    // the recipe search page: the result cards' names and the selected page
    const cards = document.querySelectorAll(".v-container .v-card .v-card-title, .v-container .v-card .recipe-card-title");
    if (location.pathname.startsWith("/advanced-search")) {
      out.results = Array.from(document.querySelectorAll("main p")).map(text).filter(Boolean).join(" | ");
      out.page = text(document.querySelector(".v-pagination__item--is-active"));
    }
    // generic model list: the table's rows and its footer
    if (location.pathname.startsWith("/list/")) {
      out.rows = Array.from(document.querySelectorAll(".v-data-table tbody tr")).map((tr) => text(tr.querySelector("td:nth-child(2)") ?? tr)).join(" | ");
      out.footer = text(document.querySelector(".v-data-table-footer__info"));
    }
    // the shopping list: each entry's food and whether the page shows it checked
    if (location.pathname.startsWith("/shopping")) {
      out.entries = Array.from(document.querySelectorAll("main [role=option]")).map((li) => `${text(li)}${li.className.includes("checked") || li.getAttribute("aria-selected") === "true" ? ":x" : ""}`).join(" | ");
    }
    void cards;
    return out;
  };
}

function tags(bridgeUrl) {
  // observe mode, no model (nothing to download; explore needs none), no telemetry, no visual checks
  const cfg = { telemetry: false, mode: "observe", model: false, visual: false, devtools: false, report: "silent" };
  const atom = `const read=(${mirror.toString()})();` +
    `const st=rt.atom("visible",{});let last="{}";` +
    `const sync=()=>{try{const v=read();const s=JSON.stringify(v);if(s!==last){last=s;st.set(v);}}catch(e){}};` +
    `new MutationObserver(sync).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["class","aria-checked"]});` +
    `document.addEventListener("change",sync,true);`;
  return (
    `<script>window.GENCLASS_CONFIG=${JSON.stringify(cfg)};window.__GENCLASS_AGENT_URL__=${JSON.stringify(bridgeUrl)};</script>` +
    `<script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script>` +
    `<script type="module">import{connectAgent}from"/__genclass/agent.js";const rt=window.GenClass.runtime;` +
    `window.__GENCLASS_CONN__=connectAgent(rt,{url:${JSON.stringify(bridgeUrl)}});${atom}</script>`
  );
}
async function inject(context, bridgeUrl) {
  // hermetic runs: nothing but the local Tandoor and the bridge is reachable
  await context.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => route.abort());
  await context.route("**/__genclass/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/__genclass\//, "");
    const file = resolve(rtDist, p);
    if (!file.startsWith(rtDist) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  await context.route(
    (url) => url.origin === new URL(APP).origin && !/^\/(api|static|media|_allauth|__genclass)\//.test(url.pathname),
    async (route) => {
      const req = route.request();
      if (req.resourceType() !== "document") return route.fallback();
      const res = await route.fetch();
      const ct = res.headers()["content-type"] ?? "";
      if (!ct.includes("text/html")) return route.fulfill({ response: res });
      const html = await res.text();
      return route.fulfill({ response: res, body: html.replace(/<head>/i, `<head>${bridgeUrl ? tags(bridgeUrl) : ""}`) });
    },
  );
}

async function newPage(browser, bridgeUrl) {
  const ctx = await browser.newContext({ storageState: join(OUT, "state.json"), viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await inject(ctx, bridgeUrl);
  const page = await ctx.newPage();
  const log = [];
  const wire = [];
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" || /genclass/i.test(m.text())) log.push(`${t}: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => log.push(`pageerror: ${String(e.message ?? e).slice(0, 300)}`));
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) wire.push(`${r.method()} ${u.pathname}${u.search}${r.method() === "POST" && u.pathname.endsWith("/bulk/") ? ` ${r.postData()}` : ""}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) log.push(`http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  return { ctx, page, log, wire };
}

const settle = (page, ms = 25_000) => page.evaluate((t) => window.__GENCLASS_AGENT__.whenSettled(t), ms);
const pickerItems = (page) => page.locator(".v-overlay-container .v-list-item-title").allTextContents().then((a) => a.map((s) => s.trim()));

// --------------------------------------------------------------------------- scenarios
// Each scenario: reset (server state before the load, outside the browser), path, ready (the page is usable), steps
// (as a user makes them), oracle (after the page settled: what the page shows against what the last step asked for).
let API = null;
const SCENARIOS = {
  // (1) VModelSelect.searchItems: the keyword picker in the recipe editor. Type "b" (the 300 ms debounce fires a search),
  // pause 450 ms, type the rest of "bread" (a second search). The menu must list only the matches for "bread".
  picker: {
    path: (fx) => `/edit/Recipe/${fx.recipes[0]}`,
    ready: async (page) => {
      await pickerInput(page).waitFor({ timeout: 30_000 });
    },
    steps: async (page) => {
      await pickerInput(page).click();
      await page.keyboard.type("b");
      await page.waitForTimeout(450);
      await page.keyboard.type("read", { delay: 40 });
    },
    oracle: async (page) => {
      const items = await pickerItems(page);
      const typed = await pickerInput(page).inputValue();
      const wrong = items.filter((t) => t && !t.toLowerCase().includes(typed.toLowerCase()));
      return { typed, items, wrong: wrong.length ? [`menu shows ${JSON.stringify(wrong)} for ${JSON.stringify(typed)}`] : [] };
    },
  },
  // (2) SearchPage.searchRecipes: two quick page changes on the recipe search (page 2, then page 1). The results must
  // be page 1's.
  "search-pages": {
    path: () => `/advanced-search`,
    ready: async (page) => {
      await page.getByRole("button", { name: "Go to page 2" }).first().waitFor({ timeout: 30_000 });
    },
    steps: async (page) => {
      await page.getByRole("button", { name: "Go to page 2" }).first().click();
      await page.getByRole("button", { name: "Go to page 1" }).first().click();
    },
    oracle: async (page) => {
      const shown = await page.locator("main p").allTextContents().then((a) => a.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean));
      const active = (await page.locator(".v-pagination__item--is-active").first().textContent())?.trim();
      const want = (await API("GET", `/api/recipe/?page=${active}&page_size=${SEARCH_PAGE_SIZE}`)).results.map((r) => r.name);
      const wrong = shown[0] !== want[0] ? [`page ${active} selected, results start with ${JSON.stringify(shown[0])} (page ${active} starts with ${JSON.stringify(want[0])})`] : [];
      return { active, first: shown[0], n: shown.length, wrong };
    },
  },
  // (3) ModelListPage.loadItems: the foods list, "next page" twice quickly. The rows must be page 3's.
  "list-pages": {
    path: () => `/list/Food`,
    ready: async (page) => {
      await page.locator(".v-data-table tbody tr").first().waitFor({ timeout: 30_000 });
      await page.locator(".v-data-table-footer__info").waitFor({ timeout: 30_000 });
    },
    steps: async (page) => {
      const next = page.locator(".v-data-table-footer").getByRole("button", { name: "Next page" });
      await next.click();
      await next.click();
    },
    oracle: async (page) => {
      const footer = (await page.locator(".v-data-table-footer__info").textContent())?.trim();
      const rows = await page.locator(".v-data-table tbody tr td:nth-child(2)").allTextContents().then((a) => a.map((s) => s.replace(/\s+/g, " ").trim()));
      const from = Number(/^(\d+)/.exec(footer ?? "")?.[1] ?? 1);
      const pageNo = Math.ceil(from / 10);
      const want = (await API("GET", `/api/food/?page=${pageNo}&page_size=10`)).results.map((r) => r.name);
      const wrong = rows[0] !== want[0] ? [`footer ${JSON.stringify(footer)}, rows start with ${JSON.stringify(rows[0])} (page ${pageNo} starts with ${JSON.stringify(want[0])})`] : [];
      return { footer, first: rows[0], n: rows.length, wrong };
    },
  },
  // (4) ShoppingStore.setEntriesCheckedState + _replaySyncQueue: check two entries within 100 ms (one queue run, two
  // bulk requests in flight). Server and page must both show the two checked, and each bulk request must be sent once.
  "shopping-check": {
    reset: async (fx) => {
      await API("POST", "/api/shopping-list-entry/bulk/", { ids: fx.shopping, checked: false });
    },
    path: () => `/shopping`,
    ready: async (page) => {
      await page.getByRole("option", { name: "carrot", exact: true }).waitFor({ timeout: 30_000 });
    },
    steps: async (page) => {
      await checkEntry(page, "carrot");
      await checkEntry(page, "garlic");
    },
    oracle: async (page, fx, wire) => {
      const server = (await API("GET", "/api/shopping-list-entry/?page_size=50")).results.filter((e) => fx.shopping.includes(e.id)).map((e) => `${e.food?.name}:${e.checked ? "x" : "-"}`).sort();
      const bulk = wire.filter((w) => w.startsWith("POST /api/shopping-list-entry/bulk/")).length;
      const sent = wire.filter((w) => w.startsWith("POST /api/shopping-list-entry/bulk/")).map((w) => w.slice(w.indexOf("{")));
      const wrong = [];
      for (const n of ["carrot", "garlic"]) if (!server.includes(`${n}:x`)) wrong.push(`server ${n} unchecked`);
      if (bulk !== 2) wrong.push(`${bulk} bulk POSTs for 2 checks`);
      return { server, bulk, sent, wrong };
    },
  },
  // (4') the same, then carrot unchecked again (a person correcting a mis-tap) while the first requests are in flight.
  // Server and page must end with carrot unchecked and garlic checked.
  "shopping-uncheck": {
    reset: async (fx) => {
      await API("POST", "/api/shopping-list-entry/bulk/", { ids: fx.shopping, checked: false });
    },
    // checked entries stay listed (the list's own "show checked" switch, a device setting in localStorage), so the
    // person can tap carrot again
    init: () => localStorage.setItem("TANDOOR_DEVICE_SETTINGS", JSON.stringify({ shopping_show_checked_entries: true })),
    path: () => `/shopping`,
    ready: async (page) => {
      await page.getByRole("option", { name: "carrot", exact: true }).waitFor({ timeout: 30_000 });
    },
    steps: async (page) => {
      await checkEntry(page, "carrot");
      await checkEntry(page, "garlic");
      await page.waitForTimeout(Number(process.env.UNCHECK_AFTER ?? 300));
      await checkEntry(page, "carrot"); // the same button toggles it back
    },
    oracle: async (page, fx, wire) => {
      const server = (await API("GET", "/api/shopping-list-entry/?page_size=50")).results.filter((e) => fx.shopping.includes(e.id)).map((e) => `${e.food?.name}:${e.checked ? "x" : "-"}`).sort();
      const sent = wire.filter((w) => w.startsWith("POST /api/shopping-list-entry/bulk/")).map((w) => w.slice(w.indexOf("{")));
      const ui = await page.getByRole("option", { name: "carrot", exact: true }).count(); // 1 when shown unchecked
      const wrong = [];
      if (!server.includes("carrot:-")) wrong.push("server carrot checked after the uncheck");
      if (!server.includes("garlic:x")) wrong.push("server garlic unchecked");
      return { server, sent, carrotOpenInUi: ui, wrong };
    },
  },
};
const SEARCH_PAGE_SIZE = Number(process.env.SEARCH_PAGE_SIZE ?? 50);
const pickerInput = (page) => page.locator(".v-autocomplete").filter({ hasText: "Keyword" }).locator("input").first();
async function checkEntry(page, food) {
  // the entry's own check button, as a person taps it
  // a checked entry's accessible name gains an icon glyph, so match the option by its text
  await page.getByRole("option").filter({ hasText: new RegExp(`^\\W*${food}\\s*$`) }).getByRole("button").first().click();
}

// --------------------------------------------------------------------------- one page load (one run)
async function load(browser, bridgeUrl, scenario, i) {
  const fx = fixture();
  if (scenario.reset) await scenario.reset(fx);
  const { ctx, page, log, wire } = await newPage(browser, bridgeUrl);
  if (scenario.init) await page.addInitScript(scenario.init);
  const t0 = Date.now();
  const out = { i, log };
  try {
    await page.goto(APP + scenario.path(fx));
    if (bridgeUrl) await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 60_000 });
    if (bridgeUrl) {
      out.schedule = await page.evaluate(() => window.__GENCLASS_AGENT__.schedule);
      out.run = await page.evaluate(() => window.__GENCLASS_AGENT__.run);
    }
    await scenario.ready(page);
    if (bridgeUrl) await settle(page, 30_000);
    else await page.waitForLoadState("networkidle");
    out.t = { ready: Date.now() - t0 };
    const w0 = wire.length;
    await scenario.steps(page, fx);
    out.t.steps = Date.now() - t0;
    if (bridgeUrl) out.settled = await settle(page);
    else await page.waitForTimeout(Number(process.env.PLAIN_WAIT ?? 4000));
    out.t.settled = Date.now() - t0;
    await page.waitForTimeout(300);
    out.wire = wire.slice(w0);
    out.oracle = await scenario.oracle(page, fx, out.wire);
    if (bridgeUrl) {
      out.snapshot = await page.evaluate(() => {
        const s = window.__GENCLASS_AGENT__.snapshot();
        const rec = window.__GENCLASS_AGENT__.recorded();
        return {
          visible: s.state.visible ?? Object.fromEntries(Object.entries(s.state).filter(([k]) => k.startsWith("visible"))),
          witnesses: window.__GENCLASS_AGENT__.witnesses().map((w) => `${w.kind} ${w.subject} by ${w.by}`),
          forced: s.forced,
          acts: rec.steps.filter((x) => x.k === "act").map((a) => `${a.kind} ${a.target ?? ""}${a.value !== undefined ? ` = ${a.value}` : ""}`),
          sends: rec.steps.filter((x) => x.k === "send").map((x) => x.key),
          order: rec.order,
        };
      });
      await page.waitForTimeout(600); // the last batch and the end reach the bridge
    }
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 1500);
  }
  out.ms = Date.now() - t0;
  await ctx.close();
  return out;
}
const summary = (l) =>
  `load ${l.i}: ${l.schedule ? `${l.schedule.order}${l.schedule.seed !== undefined ? ` seed ${l.schedule.seed}` : ""}` : "no schedule"} settled=${l.settled} witnesses=${l.snapshot?.witnesses?.length} forced=${l.snapshot?.forced} oracle=${l.oracle ? (l.oracle.wrong.length ? `WRONG ${l.oracle.wrong.join(", ")}` : "ok") : "?"} ${JSON.stringify(l.oracle ? { ...l.oracle, wrong: undefined } : null).slice(0, 260)} ${l.ms} ms${l.error ? ` ERROR ${l.error.slice(0, 300)}` : ""}${l.log?.length ? ` log=${JSON.stringify(l.log.slice(0, 3))}` : ""}`;

// --------------------------------------------------------------------------- commands
const cmd = process.argv[2];
// --no-proxy-server: the container's HTTPS proxy must not see localhost. The Local Network Access checks are off because
// a document Playwright fulfilled has no address space of its own, so Chromium would refuse the page's requests to the
// loopback bridge; a developer's own page, served from localhost, is not affected.
const browser = await chromium.launch({ args: ["--no-proxy-server", "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers"] });
({ api: API } = await login());

if (cmd === "probe") {
  const bridgeUrl = process.env.HUNT_NO_GENCLASS ? null : await startServer();
  const { ctx, page, log } = await newPage(browser, bridgeUrl);
  await page.goto(APP + (process.argv[3] ?? "/"));
  if (bridgeUrl) await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 60_000 }).catch((e) => console.log("not connected:", e.message));
  await page.waitForTimeout(Number(process.argv[4] ?? 5000));
  if (process.argv[5]) for (const html of await page.locator(process.argv[5]).evaluateAll((els) => els.map((e) => e.outerHTML.slice(0, 3000)))) console.log(html);
  else console.log((await page.locator("body").ariaSnapshot()).slice(0, 8000));
  console.log(page.url());
  if (bridgeUrl) console.log(await page.evaluate(() => JSON.stringify({ conn: window.__GENCLASS_AGENT__?.connected, visible: window.__GENCLASS_AGENT__?.snapshot().state.visible })));
  console.log(log.join("\n"));
  await page.screenshot({ path: join(OUT, "probe.png") });
  await ctx.close();
} else if (cmd === "once") {
  const scenario = SCENARIOS[process.argv[3]];
  if (!scenario) throw new Error(`unknown scenario; one of ${Object.keys(SCENARIOS).join(", ")}`);
  const bridgeUrl = process.env.HUNT_NO_GENCLASS ? null : await startServer();
  if (bridgeUrl && process.argv[4]) console.log(await tool("genclass_explore", { action: "start", runs: 1, slow_ms: Number(process.argv[4]) }));
  const l = await load(browser, bridgeUrl, scenario, 0);
  console.log(summary(l));
  console.log(JSON.stringify({ oracle: l.oracle, wire: l.wire, acts: l.snapshot?.acts, order: l.snapshot?.order, witnesses: l.snapshot?.witnesses, visible: l.snapshot?.visible, log: l.log, error: l.error }, null, 1));
} else if (cmd === "explore") {
  const name = process.argv[3];
  const slow = Number(process.argv[4] ?? 600);
  const runs = Number(process.argv[5] ?? 6);
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}; one of ${Object.keys(SCENARIOS).join(", ")}`);
  const bridgeUrl = await startServer();
  await tool("genclass_clear", { what: "all" });
  const result = { scenario: name, slow_ms: slow, runs, variant: process.env.HUNT_TAG ?? "unfixed", startedAt: new Date().toISOString(), loads: [] };
  result.start = await tool("genclass_explore", { action: "start", runs, slow_ms: slow });
  console.log(result.start.split("\n")[0]);
  for (let i = 0; i < runs + 2; i++) {
    const l = await load(browser, bridgeUrl, scenario, i);
    result.loads.push(l);
    console.log(summary(l));
  }
  result.report = await tool("genclass_explore", { action: "report" });
  console.log(result.report);
  const fids = [...new Set([...result.report.matchAll(/\b(f\d+)\b/g)].map((m) => m[1]))];
  if (/RACE:/.test(result.report) && fids.length) {
    result.explain = {};
    for (const fid of fids) result.explain[fid] = await tool("genclass_explain", { id: fid });
    console.log(result.explain[fids[0]]);
    const fid = fids[0];
    result.replay = { id: fid, arm: await tool("genclass_replay", { action: "arm", id: fid }) };
    result.replay.load = await load(browser, bridgeUrl, scenario, runs + 2);
    console.log(summary(result.replay.load));
    result.replay.result = await tool("genclass_replay", { action: "result", id: fid });
    console.log(result.replay.result);
  }
  const file = join(OUT, `${name}-${slow}${process.env.HUNT_TAG ? `-${process.env.HUNT_TAG}` : ""}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log("wrote", file);
} else {
  console.log("usage: hunt.mjs probe <path> [ms] [selector] | once <scenario> [slow_ms] | explore <scenario> <slow_ms> [runs]");
}
await browser.close();
if (served) await served.close();
process.exit(0);
