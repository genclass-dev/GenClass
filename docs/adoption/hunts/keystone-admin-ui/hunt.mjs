// GenClass race hunt against Keystone's Admin UI (docs/adoption/hunts/keystone-admin-ui.md). Not part of any test suite.
//
// Drives the real Admin UI of keystonejs/keystone's examples/usecase-blog (a Next.js pages-router app with Apollo
// Client 4, production build served by `keystone start` on http://localhost:3000) in headless Chromium with
// @genclass/runtime injected at the page's edge (no change to Keystone's source) and the @genclass/mcp server
// in-process, the way packages/mcp/test/e2e/race.e2e.mjs drives the MCP tools:
//   1. explore start (2 fifo baselines + N seeded orders, up to --slow ms of extra latency per response);
//   2. one page load per armed run, the same user steps each time (the scenario);
//   3. explore report; explain any race finding.
// Oracles per load, labelled in the output: GenClass's explore verdict and witnesses; the GraphQL API's answer for
// what the screen should show (or hold) after the last step; the DOM read by the harness after whenSettled; and the
// GraphQL request bodies seen on the wire (Playwright's request event), counted by operation.
//
// Every request of the Admin UI is POST /api/graphql: GenClass's signature for all of them is the same; the wire
// counts here split them by operation (the operation name, or the first root field of an unnamed operation).
//
// Usage (from the GenClass-lib repo root, both packages built, Keystone running and seeded with seed.mjs):
//   node docs/adoption/hunts/keystone-admin-ui/hunt.mjs <scenario> [--slow 600] [--runs 6] [--seed 1] [--once] [--out dir]
// Scenarios: smoke, list-search, list-pages, rel-search, rel-more, item-save, create-enter, create-click.
// Environment: KEYSTONE_URL (default http://localhost:3000).

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { chromium } from "playwright";
import { serve } from "../../../../packages/mcp/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const rtDist = resolve(repo, "packages/runtime/dist");
const TYPES = { ".js": "text/javascript", ".map": "application/json", ".wasm": "application/wasm", ".json": "application/json" };

// --------------------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const scenarioName = argv.find((a) => !a.startsWith("--")) ?? "smoke";
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const SLOW = Number(opt("slow", 600));
const RUNS = Number(opt("runs", 6));
const SEED = Number(opt("seed", 1));
const OUT = resolve(opt("out", join(here, "results")));
const ONCE = flag("once");
// GENCLASS=0: the same scenario with nothing injected (the control run without GenClass).
const INJECT = process.env.GENCLASS !== "0";
const APP = (process.env.KEYSTONE_URL ?? "http://localhost:3000").replace(/\/$/, "");
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --------------------------------------------------------------------------- the MCP server, driven like an agent
const input = new PassThrough();
const output = new PassThrough();
const lines = [];
let buf = "";
output.setEncoding("utf8");
output.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (l.trim()) lines.push(JSON.parse(l));
  }
});
const served = await serve({ cwd: here, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: null });
let rpcId = 0;
async function rpc(method, params = {}) {
  const my = ++rpcId;
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
  for (let i = 0; i < 1000; i++) {
    const m = lines.find((x) => x.id === my);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no reply to ${method}`);
}
const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "keystone-hunt", version: "1" } });
input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const bridgeUrl = `http://127.0.0.1:${served.port}`;
log("bridge", bridgeUrl, "inject", INJECT);

// Chromium refuses a page on localhost a fetch to 127.0.0.1 (Local Network Access checks) without a permission prompt
// headless Chromium cannot answer; the bridge is loopback-only, so the check is turned off (ghost.md section 9, item 1).
const browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks"] });

// --------------------------------------------------------------------------- the API oracle
async function gql(query, variables) {
  const r = await fetch(`${APP}/api/graphql`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data;
}
const firstAuthor = (await gql(`{ authors(where: { email: { equals: "author01@example.com" } }) { id name } }`)).authors[0];
if (!firstAuthor) throw new Error("not seeded: run seed.mjs first");

// --------------------------------------------------------------------------- injection (nothing in Keystone changes)
const initScript = ({ bridge }) => {
  window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, devtools: false, visual: false, analytics: false, report: "silent", autoState: false };
  window.__GENCLASS_AGENT_URL__ = bridge;
};
// The mirror atom: what the screens under test show, registered as GenClass state so explore and the witnesses have
// app state to work with (Keystone's Apollo client is not reachable from outside in the production build). Event-driven:
// DOM mutations and input events, coalesced per animation frame, no polling.
const mirrorSource = `
(() => {
  const rt = window.GenClass && window.GenClass.runtime;
  if (!rt) return;
  const atom = rt.atom("keystone", { rows: "", stats: "", options: "" });
  const sq = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  const compute = () => ({
    rows: [...document.querySelectorAll('[role="grid"] [role="row"]')].map((r) => r.querySelector('[role="rowheader"]')).filter(Boolean).map((e) => sq(e.innerText)).join(" | ").slice(0, 2000),
    stats: sq(document.querySelector('nav[aria-label="Pagination"]')?.innerText).slice(0, 200),
    options: [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((e) => sq(e.innerText)).join(" | ").slice(0, 2000),
  });
  let last = "";
  const sync = () => { try { const v = compute(); const k = JSON.stringify(v); if (k !== last) { last = k; atom.set(v); } } catch (e) {} };
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; sync(); }); };
  const start = () => { new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, characterData: true }); document.addEventListener("input", schedule, true); schedule(); };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
`;
const connectSource = `import { connectAgent } from "/__genclass/agent.js";
window.__GENCLASS_CONN__ = connectAgent(window.GenClass && window.GenClass.runtime, { url: window.__GENCLASS_AGENT_URL__ });
`;

/** The GraphQL operation of a request body: its name, or the first root field of an unnamed operation. */
function opOf(body) {
  try {
    const j = JSON.parse(body);
    const q = String(j.query ?? "");
    const named = /^\s*(query|mutation)\s+([A-Za-z_]\w*)/.exec(q);
    if (named) return `${named[1]} ${named[2]}`;
    const kind = /^\s*mutation/.test(q) ? "mutation" : "query";
    const field = /\{\s*(?:\w+\s*:\s*)?([A-Za-z_]\w*)/.exec(q);
    return `${kind} {${field ? field[1] : "?"}}`;
  } catch {
    return "?";
  }
}

let lastPage = null;
async function newPage() {
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1400, height: 900 } });
  ctx.on("page", (p) => (lastPage = p));
  if (INJECT) {
    await ctx.addInitScript(initScript, { bridge: bridgeUrl });
    await ctx.route((u) => u.pathname.startsWith("/__genclass/"), async (route) => {
      const u = new URL(route.request().url());
      const file = join(rtDist, u.pathname.slice("/__genclass/".length));
      if (!file.startsWith(rtDist) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    });
    // every HTML document of the Admin UI gets GenClass as its first script, then the mirror and the agent link
    await ctx.route((u) => u.origin === APP && !u.pathname.startsWith("/api/") && !u.pathname.startsWith("/_next/"), async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const res = await route.fetch();
      const ct = res.headers()["content-type"] ?? "";
      if (!ct.includes("text/html")) return route.fulfill({ response: res });
      const html = (await res.text()).replace(
        /<head[^>]*>/,
        (m) => `${m}\n<script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script>\n<script>${mirrorSource}</script>\n<script type="module">${connectSource}</script>`,
      );
      const { "content-encoding": _enc, "content-length": _len, etag: _etag, ...headers } = res.headers();
      return route.fulfill({ status: res.status(), headers, contentType: "text/html; charset=utf-8", body: html });
    });
  }
  const page = await ctx.newPage();
  const wire = [];
  page.on("request", (r) => {
    if (r.url() === `${APP}/api/graphql` && r.method() === "POST") wire.push({ t: Date.now(), op: opOf(r.postData() ?? ""), vars: (() => { try { return JSON.parse(r.postData()).variables ?? null; } catch { return null; } })() });
  });
  page.on("pageerror", (e) => log("  pageerror:", e.message.slice(0, 200)));
  return { ctx, page, wire };
}

async function waitConnected(page) {
  if (!INJECT) return;
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
}
async function settled(page, ms = 20_000) {
  if (!INJECT) return page.waitForLoadState("networkidle").then(() => page.waitForTimeout(400));
  return page.evaluate((t) => window.__GENCLASS_AGENT__.whenSettled(t), ms);
}
const sq = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
async function domSnapshot(page) {
  return page.evaluate(() => {
    const sq = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
    return {
      path: location.pathname + location.search,
      rows: [...document.querySelectorAll('[role="grid"] [role="row"]')].map((r) => r.querySelector('[role="rowheader"]')).filter(Boolean).map((e) => sq(e.innerText)),
      stats: sq(document.querySelector('nav[aria-label="Pagination"]')?.innerText) || null,
      options: [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((e) => sq(e.innerText)),
      agent: window.__GENCLASS_AGENT__ ? { run: window.__GENCLASS_AGENT__.run, schedule: window.__GENCLASS_AGENT__.schedule, witnesses: window.__GENCLASS_AGENT__.witnesses().map((w) => `${w.kind} ${w.subject ?? ""} ${w.by ?? ""}`.slice(0, 160)), errors: window.__GENCLASS_AGENT__.errors().length, forced: window.__GENCLASS_AGENT__.snapshot().forced } : null,
    };
  });
}
async function finish(page, ctx, wire) {
  await settled(page);
  const dom = await domSnapshot(page);
  await page.waitForTimeout(500); // the snapshot batch reaches the bridge
  await ctx.close();
  const ops = {};
  for (const w of wire) ops[w.op] = (ops[w.op] ?? 0) + 1;
  return { dom, wire: ops };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --------------------------------------------------------------------------- scenarios
// Each returns { dom, wire, api, expect, ok }: `expect` is what the screen or the server should hold if the app is
// right, `ok` the harness's own oracle (DOM and API against `expect`).
let loadNo = 0;
const scenarios = {
  // Load the posts list. Checks injection, connection, the mirror atom and the oracles.
  async smoke() {
    const { ctx, page, wire } = await newPage();
    await page.goto(`${APP}/posts`);
    await waitConnected(page);
    await page.locator('[role="grid"] [role="rowheader"]').first().waitFor({ timeout: 20_000 });
    const r = await finish(page, ctx, wire);
    return { ...r, api: null, expect: null, ok: r.dom.rows.length > 0 };
  },

  // (1) The list's search: one query per keystroke (no debounce), typed as a prefix, a pause, then the rest.
  async "list-search"() {
    const { ctx, page, wire } = await newPage();
    await page.goto(`${APP}/posts`);
    await waitConnected(page);
    await page.locator('[role="grid"] [role="rowheader"]').first().waitFor({ timeout: 20_000 });
    const search = page.getByRole("searchbox", { name: "Search" });
    await search.click();
    await search.pressSequentially("gam", { delay: 80 });
    await page.waitForTimeout(150);
    await search.pressSequentially("ma 1", { delay: 80 });
    const r = await finish(page, ctx, wire);
    const api = await gql(`{ posts(where: { title: { contains: "gamma 1" } }) { title } postsCount(where: { title: { contains: "gamma 1" } }) }`);
    const expect = { rows: api.posts.map((p) => p.title).sort(), count: api.postsCount };
    return { ...r, api, expect, ok: same([...r.dom.rows].sort(), expect.rows) && r.dom.path.includes("search=gamma") };
  },

  // (1b) Paging: "Next page" twice in quick succession (each a new query with its own skip), then sort by title.
  async "list-pages"() {
    const { ctx, page, wire } = await newPage();
    await page.goto(`${APP}/posts`);
    await waitConnected(page);
    await page.locator('[role="grid"] [role="rowheader"]').first().waitFor({ timeout: 20_000 });
    const next = page.getByRole("button", { name: "Next page" });
    await next.click();
    await page.waitForTimeout(120);
    await next.click();
    await page.waitForTimeout(120);
    await page.getByRole("columnheader", { name: "Title" }).click();
    const r = await finish(page, ctx, wire);
    const api = await gql(`{ posts(take: 50, skip: 100, orderBy: [{ title: asc }]) { title } }`);
    const expect = { rows: api.posts.map((p) => p.title), path: "page=3" };
    // the table renders only the rows in view (virtualised), so the oracle compares that window with the API's page
    return { ...r, api: null, expect: { rows: expect.rows.slice(0, 12), path: expect.path }, ok: r.dom.rows.length > 0 && same(r.dom.rows, expect.rows.slice(0, r.dom.rows.length)) && r.dom.path.includes("page=3") };
  },

  // (2) The relationship combobox (Post.author: filtered to verified authors, sorted by name): a prefix, a pause past
  // the 200 ms debounce, the rest; the listbox must show the final term's authors.
  async "rel-search"() {
    const { ctx, page, wire } = await newPage();
    await page.goto(`${APP}/posts/create`);
    await waitConnected(page);
    const box = page.getByRole("combobox", { name: "Author" });
    await box.waitFor({ timeout: 20_000 });
    await box.click();
    await box.pressSequentially("a", { delay: 80 });
    await page.waitForTimeout(260);
    await box.pressSequentially("lpha author", { delay: 60 });
    await page.waitForTimeout(260);
    const r = await finish(page, ctx, wire);
    const api = await gql(`{ authors(where: { name: { contains: "alpha author" }, verified: { equals: true } }, orderBy: [{ name: asc }], take: 10) { name } }`);
    const expect = { options: api.authors.map((a) => a.name) };
    return { ...r, api: null, expect, ok: same(r.dom.options, expect.options) };
  },

  // (2b) Load more while the search changes: open Post.tags, scroll the listbox to its end (fetchMore, skip 10), and
  // type a search term while that page is still out.
  async "rel-more"() {
    const { ctx, page, wire } = await newPage();
    await page.goto(`${APP}/posts/create`);
    await waitConnected(page);
    const box = page.getByRole("combobox", { name: "Tags" });
    await box.waitFor({ timeout: 20_000 });
    // the comboboxes' first queries delivered first: react-aria does not open a combobox that has no items yet, so a
    // click on the chevron while they are held is lost (and the scenario's overlap is load more against search)
    await settled(page);
    await box.click();
    await page.getByRole("button", { name: /Show suggestions/i }).last().click().catch(() => {});
    const listbox = page.getByRole("listbox");
    await listbox.locator('[role="option"]').nth(9).waitFor({ timeout: 20_000 });
    await listbox.evaluate((el) => {
      const sc = el.scrollHeight > el.clientHeight ? el : el.closest("[data-overlay-container], [role=dialog]") ?? el;
      sc.scrollTop = sc.scrollHeight;
    });
    await page.waitForTimeout(60);
    await box.pressSequentially("zeta", { delay: 70 });
    await page.waitForTimeout(260);
    const r = await finish(page, ctx, wire);
    const api = await gql(`{ tags(where: { name: { contains: "zeta" } }, take: 10) { name } }`);
    const expect = { options: api.tags.map((t) => t.name) };
    return { ...r, api: null, expect, ok: same(r.dom.options, expect.options) };
  },

  // (3) Item save: edit an author's name, Save, keep typing while the update is out, Save again.
  async "item-save"() {
    const base = `beta author 01`;
    await gql(`mutation ($id: ID!, $n: String!) { updateAuthor(where: { id: $id }, data: { name: $n }) { id } }`, { id: firstAuthor.id, n: base });
    const { ctx, page, wire } = await newPage();
    await page.goto(`${APP}/authors/${firstAuthor.id}`);
    await waitConnected(page);
    const name = page.getByRole("textbox", { name: "Name" });
    await name.waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => [...document.querySelectorAll("input")].some((i) => i.value === "beta author 01"), null, { timeout: 20_000 });
    await name.click();
    await page.keyboard.press("End");
    await name.pressSequentially(" one", { delay: 70 });
    await page.getByRole("button", { name: "Save" }).click();
    // back into the field, caret at the end, while the update is out (a click on Save moved the focus)
    await name.click();
    await page.keyboard.press("End");
    await name.pressSequentially(" two", { delay: 70 });
    await page.locator('[role=alertdialog]:has-text("Saved changes")').first().waitFor({ timeout: 20_000 });
    await settled(page);
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Save" && (b.disabled || b.getAttribute("aria-disabled") === "true")), null, { timeout: 20_000 });
    const field = await name.inputValue();
    const r = await finish(page, ctx, wire);
    const api = await gql(`query ($id: ID!) { author(where: { id: $id }) { name } }`, { id: firstAuthor.id });
    const expect = { name: `${base} one two` };
    return { ...r, dom: { ...r.dom, field }, api, expect, ok: api.author.name === expect.name && field === expect.name };
  },

  // (4) Create with Enter: type a tag's name and press Enter, then Enter again 60 ms later (an impatient user).
  async "create-enter"() {
    const tagName = `hunt tag ${String(++loadNo).padStart(4, "0")} ${Date.now() % 100000}`;
    const { ctx, page, wire } = await newPage();
    await page.goto(`${APP}/tags/create`);
    await waitConnected(page);
    const nameBox = page.getByRole("textbox", { name: "Name" });
    await nameBox.waitFor({ timeout: 20_000 });
    await nameBox.click();
    await nameBox.pressSequentially(tagName, { delay: 30 });
    await nameBox.press("Enter");
    await page.waitForTimeout(60);
    await nameBox.press("Enter");
    await page.waitForURL((u) => /^\/tags\/[^/]+$/.test(u.pathname) && u.pathname !== "/tags/create", { timeout: 20_000 });
    const r = await finish(page, ctx, wire);
    const api = await gql(`query ($n: String!) { tags(where: { name: { equals: $n } }) { id } }`, { n: tagName });
    return { ...r, api: { tags: api.tags.length }, expect: { tags: 1 }, ok: api.tags.length === 1 };
  },

  // (4b) The control for (4): the same with a double click on the Create button.
  async "create-click"() {
    const tagName = `hunt tag ${String(++loadNo).padStart(4, "0")} ${Date.now() % 100000}`;
    const { ctx, page, wire } = await newPage();
    await page.goto(`${APP}/tags/create`);
    await waitConnected(page);
    const nameBox = page.getByRole("textbox", { name: "Name" });
    await nameBox.waitFor({ timeout: 20_000 });
    await nameBox.click();
    await nameBox.pressSequentially(tagName, { delay: 30 });
    await page.getByRole("button", { name: "Create" }).dblclick();
    await page.waitForURL((u) => /^\/tags\/[^/]+$/.test(u.pathname) && u.pathname !== "/tags/create", { timeout: 20_000 });
    const r = await finish(page, ctx, wire);
    const api = await gql(`query ($n: String!) { tags(where: { name: { equals: $n } }) { id } }`, { n: tagName });
    return { ...r, api: { tags: api.tags.length }, expect: { tags: 1 }, ok: api.tags.length === 1 };
  },
};

const scenario = scenarios[scenarioName];
if (!scenario) {
  console.error(`unknown scenario ${scenarioName}; one of ${Object.keys(scenarios).join(", ")}`);
  process.exit(2);
}

// --------------------------------------------------------------------------- the explore loop
const summary = { scenario: scenarioName, slow_ms: SLOW, runs: RUNS, seed: SEED, inject: INJECT, started: new Date().toISOString(), loads: [] };
const label = `${scenarioName}-slow${SLOW}-seed${SEED}${ONCE ? "-once" : ""}${INJECT ? "" : "-nogenclass"}`;
const save = () => writeFileSync(join(OUT, `${label}.json`), JSON.stringify(summary, null, 2));

async function oneLoad(n) {
  try {
    const r = await scenario();
    summary.loads.push({ n, ...r });
    log(`  ok ${r.ok} wire ${JSON.stringify(r.wire)} schedule ${JSON.stringify(r.dom.agent?.schedule)} witnesses ${r.dom.agent?.witnesses?.length} forced ${r.dom.agent?.forced}`);
    if (!r.ok) log(`  dom ${JSON.stringify({ rows: r.dom.rows?.slice(0, 6), options: r.dom.options?.slice(0, 12), path: r.dom.path, field: r.dom.field })} expect ${JSON.stringify(r.expect).slice(0, 300)} api ${JSON.stringify(r.api).slice(0, 200)}`);
  } catch (e) {
    log("  load failed:", e.message.split("\n")[0]);
    const shot = join(OUT, `failure-${label}-${n}.png`);
    await lastPage?.screenshot({ path: shot }).catch(() => {});
    await lastPage?.context().close().catch(() => {});
    summary.loads.push({ n, error: e.message.split("\n").slice(0, 3).join(" "), screenshot: shot });
  }
  save();
}

if (scenarioName === "smoke" || ONCE || !INJECT) {
  const n = !INJECT && !ONCE ? RUNS + 2 : 1;
  log(`${scenarioName}: ${n} natural load(s)`);
  for (let i = 0; i < n; i++) await oneLoad(i + 1);
  if (INJECT) summary.status = await tool("genclass_status");
  if (INJECT) summary.findings = await tool("genclass_findings", {});
  console.log(summary.findings ?? "");
  save();
} else {
  const started = await tool("genclass_explore", { action: "start", runs: RUNS, slow_ms: SLOW, seed: SEED });
  log(started.split("\n")[0]);
  summary.exploreStart = started;
  for (let i = 0; i < RUNS + 2; i++) {
    log(`load ${i + 1}/${RUNS + 2}`);
    await oneLoad(i + 1);
  }
  const report = await tool("genclass_explore", { action: "report" });
  console.log(report);
  summary.report = report;
  const ids = [...report.matchAll(/\bf\d+\b/g)].map((m) => m[0]);
  summary.findings = await tool("genclass_findings", {});
  console.log(summary.findings);
  summary.explains = {};
  for (const id of new Set([...ids, ...[...summary.findings.matchAll(/\bf\d+\b/g)].map((m) => m[0])])) {
    summary.explains[id] = await tool("genclass_explain", { id });
  }
  save();
}
log("written", join(OUT, `${label}.json`));
await browser.close();
await served.close();
process.exit(0);
