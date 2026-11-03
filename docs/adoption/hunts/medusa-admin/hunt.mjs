// Race hunt harness for the Medusa admin dashboard (docs/adoption/hunts/medusa-admin.md). Not part of CI.
//
// Needs both GenClass packages built (npm run build -w @genclass/runtime && npm run build -w @genclass/mcp), the
// dtc-starter backend running at --base (pnpm dev in apps/backend: the admin is served at /app) and the orders that
// seed.mjs wrote to orders.json beside this file.
//
//   node docs/adoption/hunts/medusa-admin/hunt.mjs once <scenario>                # one load with GenClass, no schedule
//   node docs/adoption/hunts/medusa-admin/hunt.mjs explore <scenario> <slow_ms> [runs=6] [--out dir]
//   node docs/adoption/hunts/medusa-admin/hunt.mjs control <scenario> [trials=5]  # no GenClass at all
//
// GenClass is injected from outside; Medusa's files are unchanged. A context route rewrites every /app HTML document
// to set window.GENCLASS_CONFIG (observe, model off, telemetry off, no visual checks, no devtools), load the
// script-tag build from the virtual same-origin path /__genclass/ (packages/runtime/dist), and connect the agent link
// (dist/agent.js) to the MCP bridge that serve() (packages/mcp/dist) runs in this process. The tools are called over
// JSON-RPC exactly as a coding agent calls them. React state is discovered automatically (the classic script runs
// before the dashboard's modules); the regions under test are also mirrored into rt.atom() values from a
// MutationObserver (the quantity inputs and the item rows) so the verdict compares what the user sees.
//
// Each load gets a clean order: before it, the scenario cancels any open return, exchange, claim or order edit on its
// order through the admin API. After whenSettled() each load reads two oracles of its own: the DOM (input values, rows)
// and the server (the order's preview through the admin API, read by this process after the load). A seeded load
// "differs" when its oracle equals neither fifo baseline's. Double clicks are raw CDP mouse events (vendure-hunt.mjs).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const rtDist = join(root, "packages/runtime/dist");
const B = process.env.BASE ?? "http://localhost:9000";
const STATE = join(process.env.TMPDIR ?? "/tmp", "medusa-hunt-state.json");
const TYPES = { ".js": "text/javascript", ".map": "application/json", ".json": "application/json", ".wasm": "application/wasm" };
const ORDERS = JSON.parse(readFileSync(join(here, "orders.json"), "utf8"));
const OPEN = existsSync(join(here, "orders-open.json")) ? JSON.parse(readFileSync(join(here, "orders-open.json"), "utf8")) : [];
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const OUT = flag("out", "");
const GAP = Number(flag("gap", "40"));

// --------------------------------------------------------------------------- admin API (setup and server oracle)
let token;
async function api(method, path, body) {
  if (!token) {
    const r = await fetch(`${B}/auth/user/emailpass`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@test.com", password: "supersecret" }) });
    token = (await r.json()).token;
  }
  const r = await fetch(`${B}/admin${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
/** Cancels every open order change (return, exchange, claim, edit) on an order. */
async function cleanOrder(orderId) {
  const { order_changes } = await api("GET", `/orders/${orderId}/changes`);
  for (const c of order_changes.filter((x) => ["pending", "requested"].includes(x.status))) {
    if (c.return_id && c.change_type === "return_request") await api("DELETE", `/returns/${c.return_id}/request`);
    else if (c.exchange_id) await api("DELETE", `/exchanges/${c.exchange_id}/request`);
    else if (c.claim_id) await api("DELETE", `/claims/${c.claim_id}/request`);
    else if (c.change_type === "edit") await api("DELETE", `/order-edits/${orderId}`);
  }
}
/** The server's view after a load: the items of the order's preview with what the open change asks for. */
async function serverItems(orderId) {
  const { order } = await api("GET", `/orders/${orderId}/preview`);
  const { order_changes } = await api("GET", `/orders/${orderId}/changes`);
  const open = order_changes.filter((x) => ["pending", "requested"].includes(x.status));
  return {
    items: order.items.map((i) => ({
      title: i.variant_title ?? i.title,
      qty: i.quantity,
      returnRequested: i.detail?.return_requested_quantity ?? 0,
      actions: (i.actions ?? []).map((a) => `${a.action}:${a.details?.quantity}`).join(","),
    })),
    openChanges: open.map((c) => `${c.change_type}:${(c.actions ?? []).map((a) => `${a.action}:${a.details?.quantity}`).join(",")}`),
  };
}

// --------------------------------------------------------------------------- the MCP server, driven like an agent
let rpcLines = [];
let input;
let served;
async function startServer() {
  const { serve } = await import(join(root, "packages/mcp/dist/index.js"));
  input = new PassThrough();
  const output = new PassThrough();
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      rpcLines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  served = await serve({ cwd: here, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: null });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "medusa-hunt", version: "1" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return `http://127.0.0.1:${served.port}`;
}
let rid = 0;
async function rpc(method, params = {}) {
  const my = ++rid;
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
  for (let i = 0; i < 6000; i++) {
    const m = rpcLines.find((x) => x.id === my);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no reply to ${method}`);
}
const tool = async (name, args = {}) => {
  const m = await rpc("tools/call", { name, arguments: args });
  return m.result?.content?.[0]?.text ?? JSON.stringify(m.error ?? m);
};

// --------------------------------------------------------------------------- injection (Medusa's files untouched)
const MIRROR = `
const rt = window.GenClass.runtime;
const atoms = { qty: rt.atom("hunt.quantities", { v: "" }), rows: rt.atom("hunt.rows", { v: "" }) };
const read = () => {
  const dlg = document.querySelector('[role="dialog"]') ?? document;
  const qty = [...dlg.querySelectorAll('input[type="number"]')].map((i) => i.value).join(",");
  const rows = String(dlg.querySelectorAll('input[type="number"]').length);
  if (atoms.qty.get().v !== qty) atoms.qty.set({ v: qty });
  if (atoms.rows.get().v !== rows) atoms.rows.set({ v: rows });
};
new MutationObserver(read).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["value"] });
document.addEventListener("input", read, true);
`;
function tags(bridgeUrl) {
  const cfg = { telemetry: false, mode: "observe", model: false, visual: false, devtools: false, report: "silent" };
  return (
    `<script>window.GENCLASS_CONFIG=${JSON.stringify(cfg)};window.__GENCLASS_AGENT_URL__=${JSON.stringify(bridgeUrl)};</script>` +
    `<script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script>` +
    `<script type="module">import{connectAgent}from"/__genclass/agent.js";window.__GENCLASS_CONN__=connectAgent(window.GenClass.runtime,{url:${JSON.stringify(bridgeUrl)}});${MIRROR}</script>`
  );
}
async function inject(context, bridgeUrl) {
  await context.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => route.abort());
  if (!bridgeUrl) return;
  await context.route("**/__genclass/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/__genclass\//, "");
    const file = resolve(rtDist, p);
    if (!file.startsWith(rtDist) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  await context.route(
    (url) => url.pathname === "/app" || url.pathname.startsWith("/app/"),
    async (route) => {
      const req = route.request();
      if (req.resourceType() !== "document") return route.fallback();
      const res = await route.fetch();
      const ct = res.headers()["content-type"] ?? "";
      if (!ct.includes("text/html")) return route.fulfill({ response: res });
      const html = await res.text();
      return route.fulfill({ response: res, body: html.replace(/<head>/i, `<head>${tags(bridgeUrl)}`) });
    },
  );
}

async function login(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${B}/app/login`);
  await page.fill('input[name="email"]', "admin@test.com");
  await page.fill('input[name="password"]', "supersecret");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app\/orders/, { timeout: 60_000 });
  await ctx.storageState({ path: STATE });
  await ctx.close();
}

// --------------------------------------------------------------------------- helpers for the steps
const connected = (page, on) => (on ? page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 30_000 }) : null);
const settle = (page, on) =>
  on ? page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(30_000)) : page.waitForLoadState("networkidle").then(() => page.waitForTimeout(1500));
async function dblclick(page, locator, gap) {
  const cdp = await page.context().newCDPSession(page);
  const box = await locator.boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, button: "left" };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  const press = (clickCount) => [
    cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", clickCount, ...at }),
    cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", clickCount, ...at }),
  ];
  if (gap < 0) return Promise.all(press(1)); // --gap -1: one click (the single-click baseline)
  const first = press(1);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  await Promise.all([...first, ...press(2)]);
}
const dialogQty = (page) => page.locator('[role="dialog"] input[type="number"]').evaluateAll((els) => els.map((e) => e.value));

// --------------------------------------------------------------------------- scenarios
/** An "Add items" stacked modal: open it, tick one row, then press Save (double click, or once and again after reopening). */
function addItems({ order: id, route, link, row, clicks }) {
  return {
    order: id,
    async setup() {},
    async steps(page, on) {
      await page.goto(`${B}/app/orders/${id}/${route}`);
      const open = page.locator('[role="dialog"]').getByText("Add items", { exact: true }).nth(link);
      await open.waitFor({ timeout: 30_000 });
      await connected(page, on);
      await settle(page, on);
      await open.click();
      const box = page.locator('[role="dialog"] button[role="checkbox"]');
      await box.nth(row).waitFor();
      await box.nth(row).click();
      const save = page.getByRole("button", { name: "Save" }).last();
      if (clicks === "dbl") await dblclick(page, save, GAP);
      else {
        await save.click();
        await settle(page, on);
        await page.waitForTimeout(800);
        await open.click();
        await box.nth(row).waitFor();
        await page.getByRole("button", { name: "Save" }).last().click();
      }
      await settle(page, on);
      await page.waitForTimeout(500);
      return { qty: await dialogQty(page), toasts: await page.locator("[data-sonner-toast]").allInnerTexts() };
    },
  };
}
// order i of orders.json per scenario, so scenarios never share an order
const order = (i) => ORDERS[i].id;
const SCENARIOS = {
  // Surface 1: return request, the item quantity typed into the inbound items table (one request per keystroke).
  "return-qty": {
    order: order(0),
    async setup(id) {
      const { return: ret } = await api("POST", "/returns", { order_id: id });
      const { order: o } = await api("GET", `/orders/${id}?fields=id,*items`);
      await api("POST", `/returns/${ret.id}/request-items`, { items: [{ id: o.items[0].id, quantity: 1 }] });
    },
    async steps(page, on) {
      await page.goto(`${B}/app/orders/${this.order}/returns`);
      const q = page.locator('[role="dialog"] input[type="number"]').first();
      await q.waitFor({ timeout: 30_000 });
      await connected(page, on);
      await settle(page, on);
      await q.click();
      await q.press("End");
      await q.press("Backspace");
      await q.pressSequentially("12", { delay: Number(process.env.KEY_DELAY ?? 120) });
      await settle(page, on);
      await page.waitForTimeout(300);
      return { qty: await dialogQty(page) };
    },
  },
  // Surface 2: exchange create, "Add items" (inbound) stacked modal, Save double-clicked.
  "exchange-add-dbl": {
    order: order(1),
    async setup() {},
    async steps(page, on) {
      await page.goto(`${B}/app/orders/${this.order}/exchanges`);
      await page.getByText("Add items").first().waitFor({ timeout: 30_000 });
      await connected(page, on);
      await settle(page, on);
      await page.getByText("Add items").first().click();
      const box = page.locator('[role="dialog"] button[role="checkbox"]');
      await box.nth(1).waitFor();
      await box.nth(1).click();
      const save = page.getByRole("button", { name: "Save" }).last();
      await dblclick(page, save, GAP);
      await settle(page, on);
      await page.waitForTimeout(500);
      return { qty: await dialogQty(page), toasts: await page.locator("[data-sonner-toast]").allInnerTexts() };
    },
  },
  // Surface 2b: the same double click on the return's add-items Save (closes the modal before the request returns).
  "return-add-dbl": {
    order: order(2),
    async setup() {},
    async steps(page, on) {
      await page.goto(`${B}/app/orders/${this.order}/returns`);
      await page.getByText("Add items").first().waitFor({ timeout: 30_000 });
      await connected(page, on);
      await settle(page, on);
      await page.getByText("Add items").first().click();
      const box = page.locator('[role="dialog"] button[role="checkbox"]');
      await box.nth(1).waitFor();
      await box.nth(1).click();
      await dblclick(page, page.getByRole("button", { name: "Save" }).last(), GAP);
      await settle(page, on);
      await page.waitForTimeout(500);
      return { qty: await dialogQty(page), toasts: await page.locator("[data-sonner-toast]").allInnerTexts() };
    },
  },
  // Surface 2c: the claim's inbound "Add items" Save double-clicked (claim-create-form.tsx, same handler shape).
  "claim-add-dbl": addItems({ order: order(5), route: "claims", link: 0, row: 1, clicks: "dbl" }),
  // Surface 2d: the exchange's outbound "Add items" (new variants sent to the customer), Save double-clicked.
  "exchange-out-dbl": addItems({ order: order(6), route: "exchanges", link: 1, row: 1, clicks: "dbl" }),
  // Not a timing case: add one item with one click, reopen "Add items", press Save without changing the selection.
  "exchange-add-reopen": addItems({ order: order(7), route: "exchanges", link: 0, row: 1, clicks: "reopen" }),
  // Surface 3: order edit, two item quantities changed in a row, each saved on blur.
  "edit-qty": {
    order: OPEN[0]?.id,
    async setup() {},
    async steps(page, on) {
      await page.goto(`${B}/app/orders/${this.order}/edits`);
      const q = page.locator('[role="dialog"] input[type="number"]');
      await q.nth(1).waitFor({ timeout: 30_000 });
      await connected(page, on);
      await settle(page, on);
      await q.nth(0).fill("15");
      await q.nth(1).click(); // blur the first: its update is sent
      await q.nth(1).fill("17");
      await page.locator('[role="dialog"] h1, [role="dialog"] h2').first().click(); // blur the second
      await settle(page, on);
      await page.waitForTimeout(300);
      return { qty: await dialogQty(page) };
    },
  },
  // Surface 3b: order edit, one quantity typed, blurred, retyped and blurred again before the first answer.
  "edit-qty-twice": {
    order: OPEN[1]?.id,
    async setup() {},
    async steps(page, on) {
      await page.goto(`${B}/app/orders/${this.order}/edits`);
      const q = page.locator('[role="dialog"] input[type="number"]');
      await q.nth(1).waitFor({ timeout: 30_000 });
      await connected(page, on);
      await settle(page, on);
      await q.nth(0).fill("15");
      await q.nth(1).click();
      await q.nth(0).fill("18");
      await q.nth(1).click();
      await settle(page, on);
      await page.waitForTimeout(300);
      return { qty: await dialogQty(page) };
    },
  },
};

// --------------------------------------------------------------------------- one load
async function load(browser, bridgeUrl, sc, i) {
  await cleanOrder(sc.order);
  await sc.setup(sc.order);
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1400, height: 900 }, storageState: STATE });
  await inject(ctx, bridgeUrl);
  const page = await ctx.newPage();
  const on = !!bridgeUrl;
  const wire = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("request", (r) => {
    if (r.method() !== "GET" && new URL(r.url()).pathname.startsWith("/admin/")) wire.push(`${r.method()} ${new URL(r.url()).pathname.replace(/[a-z]+_[0-9A-Z]{26}/g, ":id")} ${r.postData() ?? ""}`);
  });
  const out = { i, t0: Date.now() };
  try {
    out.dom = await sc.steps(page, on);
    if (on) {
      out.gc = await page.evaluate(() => {
        const a = window.__GENCLASS_AGENT__;
        const rec = a.recorded();
        return {
          schedule: a.schedule ? { order: a.schedule.order, seed: a.schedule.seed } : null,
          acts: rec.steps.filter((x) => x.k === "act").map((s) => `${s.kind} ${s.target ?? ""}${s.value !== undefined ? ` = ${s.value}` : ""}${s.clicks > 1 ? ` x${s.clicks}` : ""}`),
          witnesses: a.witnesses().map((w) => `${w.kind} ${w.subject} by ${w.by}`),
          order: rec.order.filter((k) => !/GET \/(app|__genclass)/.test(k)).map((k) => k.replace(/[a-z]+_[0-9A-Z]{26}/g, ":id").replace(/\?.*?(#\d+)$/, "$1")),
          forced: a.snapshot().forced,
        };
      });
      await page.waitForTimeout(600);
    }
  } catch (e) {
    out.error = String(e?.message ?? e).split("\n")[0].slice(0, 300);
  }
  await ctx.close();
  out.server = await serverItems(sc.order).catch((e) => ({ error: String(e) }));
  out.wire = wire;
  out.errors = errors;
  out.ms = Date.now() - out.t0;
  delete out.t0;
  return out;
}
const oracle = (l) => JSON.stringify({ dom: l.dom?.qty, server: l.server });
const line = (l) =>
  `load ${l.i}: ${l.gc?.schedule ? `${l.gc.schedule.order}${l.gc.schedule.seed !== undefined ? ` seed ${l.gc.schedule.seed}` : ""}` : "-"} dom=${JSON.stringify(l.dom)} server=${JSON.stringify(l.server?.openChanges ?? l.server)} wire=${l.wire.length} witnesses=${l.gc?.witnesses?.length ?? "-"} forced=${l.gc?.forced ?? "-"} ${l.ms} ms${l.error ? ` ERROR ${l.error}` : ""}${l.errors.length ? ` pageerror=${l.errors[0]}` : ""}`;

// --------------------------------------------------------------------------- commands
const [cmd, name, a3, a4] = argv;
const sc = SCENARIOS[name];
if (!sc) throw new Error(`unknown scenario ${name}; one of ${Object.keys(SCENARIOS).join(", ")}`);
const browser = await chromium.launch({ args: ["--no-proxy-server", "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers"] });
await login(browser);
if (OUT) mkdirSync(OUT, { recursive: true });

if (cmd === "once") {
  const bridgeUrl = await startServer();
  const l = await load(browser, bridgeUrl, sc, 0);
  console.log(line(l));
  console.log(JSON.stringify(l, null, 1));
} else if (cmd === "control") {
  const trials = Number(a3 ?? 5);
  const res = [];
  for (let i = 0; i < trials; i++) {
    const l = await load(browser, null, sc, i);
    res.push(l);
    console.log(line(l));
  }
  if (OUT) writeFileSync(join(OUT, `${name}-control.json`), JSON.stringify(res, null, 1));
} else if (cmd === "explore") {
  const slow = Number(a3 ?? 600);
  const runs = Number(a4 ?? 6);
  const bridgeUrl = await startServer();
  const result = { scenario: name, slow_ms: slow, runs, gap: GAP, loads: [] };
  result.start = await tool("genclass_explore", { action: "start", runs, slow_ms: slow });
  console.log(result.start.split("\n")[0]);
  for (let i = 0; i < runs + 2; i++) {
    const l = await load(browser, bridgeUrl, sc, i);
    result.loads.push(l);
    console.log(line(l));
    if (i === 0) result.status = await tool("genclass_status");
  }
  result.report = await tool("genclass_explore", { action: "report" });
  console.log(result.report);
  const fifo = result.loads.filter((l) => l.gc?.schedule?.order === "fifo");
  const seeded = result.loads.filter((l) => l.gc?.schedule?.order === "seeded");
  const base = new Set(fifo.map(oracle));
  result.oracle = { baselinesAgree: base.size <= 1, seeded: seeded.length, seededDiffering: seeded.filter((l) => !base.has(oracle(l))).map((l) => `${l.i} (seed ${l.gc.schedule.seed})`) };
  console.log("own oracle:", JSON.stringify(result.oracle));
  const fid = /\b(f\d+)\b/.exec(result.report)?.[1];
  if (fid && /RACE/.test(result.report)) {
    result.explain = await tool("genclass_explain", { id: fid });
    console.log(result.explain);
  }
  result.findings = await tool("genclass_findings", { limit: 20 });
  const dup = /- (f\d+) \[duplicate-request\]/.exec(result.findings)?.[1];
  if (dup) result.explainDuplicate = await tool("genclass_explain", { id: dup });
  if (OUT) writeFileSync(join(OUT, `${name}-${slow}.json`), JSON.stringify(result, null, 1));
}
await browser.close();
if (served) await served.close();
process.exit(0);
