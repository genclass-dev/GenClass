// Race hunt harness for the EverShop storefront cart (docs/adoption/hunts/evershop-admin-checkout.md). Not part of CI;
// run by hand against a local EverShop (`npm run build && npm run start` in its clone, http://localhost:3000).
//
//   node docs/adoption/hunts/evershop-admin-checkout/hunt.mjs --surface qty --slow 300,600,900 [--runs 6] [--out <dir>]
//
// GenClass is injected from outside, the Gitea harness pattern (../gitea-explore.mjs): EverShop's code is unchanged. A
// Playwright route rewrites each HTML document to load the script-tag build (packages/runtime/dist/genclass.global.js)
// from the virtual same-origin path /__genclass/rt/ at the top of <head> (before EverShop's bundle, so React state
// discovery installs first), with the model off and telemetry off, then connects the coding-agent link (dist/agent.js)
// to the MCP bridge started in this process (packages/mcp/dist, `serve()`), driven through JSON-RPC like an agent.
// Each load is a fresh browser context: one plain visit of / (before the route is installed) issues the session
// cookie, a guest cart is built over HTTP (POST /api/cart/mine/items through the context's own request client, which
// shares its cookie jar), so the only page load explore sees is /cart.
//
// Surfaces (--surface):
//   qty      two cart lines at qty 1: "+" on line 1, then --gap ms later "+" on line 2 (each line debounces 500 ms)
//   qty-one  one cart line: "+" twice --gap ms apart (one debounced PATCH): a control for the debounce itself
//   coupon   one line and coupon --coupon: type the code, double-click Apply (two clicks --gap ms apart)
//   remove   two lines: "+" on line 1, then --gap ms later Remove on line 2
//   requote  /checkout, one line: country United States, 1 s later Canada (two shipping quotes); oracle: the methods
//            listed against Canada's one method
// For each --slow value: one explore session of 2 fifo baselines + --runs seeded loads, the same steps each load. Each
// load's line in the output gives this harness's own oracle: what the page shows after GenClass's quiet point (the
// quantities, line prices, subtotal and item count) next to what a fresh, uninstrumented load of /cart in the same
// context shows (the server's cart), and the delivery order of the cart requests as the agent link recorded it.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const rtDist = join(root, "packages/runtime/dist");

const { values: arg } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:3000" },
    surface: { type: "string", default: "qty" },
    slow: { type: "string", default: "300,600,900" },
    runs: { type: "string", default: "6" },
    gap: { type: "string", default: "150" },
    coupon: { type: "string", default: "E2EHUNT10" },
    out: { type: "string", default: "" },
    genclass: { type: "string", default: "1" },
  },
});
const B = arg.base.replace(/\/+$/, "");
const TYPES = { ".js": "text/javascript", ".map": "application/json" };
const gap = Number(arg.gap);
const withGenClass = arg.genclass !== "0";

// --------------------------------------------------------------------------- what the route injects into <head>
const INJECT = `<script src="/__genclass/rt/genclass.global.js" data-manual data-base="/__genclass/rt/"></script>
<script>window.__gcRt = window.GenClass.init({ model: false, telemetry: false, report: "silent", mode: "observe", visual: false, devtools: false });</script>
<script type="module">
import { connectAgent } from "/__genclass/rt/agent.js";
connectAgent(window.__gcRt);
</script>
`;

async function route(ctx) {
  await ctx.route(`${B}/**`, async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith("/__genclass/rt/")) {
      const file = join(rtDist, url.pathname.slice("/__genclass/rt/".length));
      if (!file.startsWith(rtDist)) return r.fulfill({ status: 404 });
      try {
        return r.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
      } catch {
        return r.fulfill({ status: 404 });
      }
    }
    if (req.resourceType() !== "document" || req.headers()["x-hunt-truth"]) return r.fallback();
    const resp = await r.fetch();
    const type = resp.headers()["content-type"] ?? "";
    if (!type.includes("text/html")) return r.fulfill({ response: resp });
    const body = (await resp.text()).replace(/<head([^>]*)>/i, (m) => `${m}\n${INJECT}`);
    return r.fulfill({ response: resp, body });
  });
}

// --------------------------------------------------------------------------- the MCP server, driven like an agent
let tool = async () => "";
let served = null;
let bridgeUrl = "";
if (withGenClass) {
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
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "evershop-hunt", version: "1" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  bridgeUrl = `http://127.0.0.1:${served.port}`;
}

// --------------------------------------------------------------------------- the cart page: what it shows
async function readCart(page) {
  return page.evaluate(() => {
    const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
    const lines = [...document.querySelectorAll(".cart__item")].map((it) => {
      const sku = txt(it.querySelector(".text-xs")).replace(/^SKU /, "");
      const qty = txt(it.querySelector(".inline-flex.items-center.rounded-md span"));
      const price = txt(it.querySelector(".text-right.font-medium"));
      return `${sku}x${qty}@${price}`;
    });
    // the order summary as shown (subtotal, discount, shipping, total) and the coupon button's label
    const summary = txt(document.querySelector(".cart__total__summary")).replace(/Enter coupon code/g, "");
    const count = txt(document.querySelector(".shopping-cart-header p"));
    return `${lines.join(",")} | ${summary} | ${count}`;
  });
}

const plus = (page, i) => page.locator(".cart__item").nth(i).locator(".inline-flex.items-center.rounded-md button").nth(1);

// --------------------------------------------------------------------------- the scenarios (what a person does)
const surfaces = {
  qty: {
    skus: ["CUP-001-WHT", "PEN-002-BLK"],
    async steps(page) {
      await plus(page, 0).click();
      if (gap) await page.waitForTimeout(gap);
      await plus(page, 1).click();
    },
  },
  "qty-one": {
    skus: ["CUP-001-WHT"],
    async steps(page) {
      await plus(page, 0).click();
      if (gap) await page.waitForTimeout(gap);
      await plus(page, 0).click();
    },
  },
  coupon: {
    skus: ["CUP-001-WHT"],
    async steps(page) {
      await page.locator("#field-coupon").fill(arg.coupon);
      const apply = page.locator(".coupon-form button");
      await apply.click();
      if (gap) await page.waitForTimeout(gap);
      await apply.click({ force: true, timeout: 2000 }).catch(() => {});
    },
  },
  requote: {
    // /checkout: pick United States, wait past the 800 ms re-quote debounce (Shipment.tsx), pick Canada. The hunt's two
    // shipping zones (section 1 of the report) give each country one method; Canada's is the right answer.
    skus: ["CUP-001-WHT"],
    path: "/checkout",
    settleMs: 1300,
    ready: (page) => page.locator(".checkout__shipment button[role=combobox]").first().waitFor(),
    async steps(page) {
      const pick = async (name) => {
        await page.locator(".checkout__shipment button[role=combobox]").first().click();
        await page.getByRole("option", { name, exact: true }).click();
      };
      await pick("United States");
      await page.waitForTimeout(1000);
      await pick("Canada");
    },
    read: (page) =>
      page.evaluate(() => {
        const box = document.querySelector(".checkout__shipment");
        const country = (box?.querySelector("button[role=combobox]")?.textContent || "").replace(/[▼\s]+$/, "");
        const methods = (box?.innerText.match(/e2e-hunt [A-Za-z ]+/g) || []).map((m) => m.trim());
        return `country ${country} | methods ${methods.join(", ") || "none"}`;
      }),
    truth: "country Canada | methods e2e-hunt Canada Post",
  },
  remove: {
    skus: ["CUP-001-WHT", "PEN-002-BLK"],
    async steps(page) {
      await plus(page, 0).click();
      if (gap) await page.waitForTimeout(gap);
      await page.locator(".cart__item").nth(1).getByRole("button", { name: "Remove" }).click();
    },
  },
};

async function connected(page) {
  if (!withGenClass) return;
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
}
async function settle(page, ms = 800) {
  // the debounce timer (500 ms; 800 ms on /checkout) and the requests after it; then GenClass's quiet point
  await page.waitForTimeout(ms);
  if (withGenClass) await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000));
  else await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
}

const browser = await chromium.launch();

async function scenario(s) {
  const ctx = await browser.newContext({ permissions: ["local-network-access"] });
  // a plain visit issues the session cookie the cart binds to (tests/e2e cartShelf.spec.ts); routed only afterwards
  const warm = await ctx.newPage();
  await warm.goto(`${B}/`);
  await warm.close();
  for (const sku of s.skus) {
    const r = await ctx.request.post(`${B}/api/cart/mine/items`, { data: { sku, qty: 1 } });
    if (!r.ok()) throw new Error(`add ${sku}: HTTP ${r.status()}`);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const wire = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (/^\/api\/(cart|graphql)/.test(u.pathname)) wire.push(`${r.method()} ${u.pathname.replace(/[0-9a-f-]{36}/g, ":id")}`);
  });
  if (withGenClass) {
    await page.addInitScript((u) => (window.__GENCLASS_AGENT_URL__ = u), bridgeUrl);
    await route(ctx);
  }
  let shown;
  let truth = "";
  let order = [];
  try {
    await page.goto(`${B}${s.path ?? "/cart"}`);
    await (s.ready ? s.ready(page) : page.locator(".cart__item").nth(s.skus.length - 1).waitFor());
    await connected(page);
    wire.length = 0;
    await s.steps(page);
    await settle(page, s.settleMs);
    shown = await (s.read ?? readCart)(page);
    if (withGenClass) {
      order = await page
        .evaluate(() => window.__GENCLASS_AGENT__.recorded().order.filter((k) => /api\/(cart|graphql)/.test(k)).map((k) => k.replace(/[0-9a-f-]{36}/g, ":id")))
        .catch(() => []);
    }
    // the server's cart: a fresh load in the same context (same session cookie), never instrumented
    if (s.truth) truth = s.truth;
    else {
      const check = await ctx.newPage();
      await check.setExtraHTTPHeaders({ "x-hunt-truth": "1" });
      await check.goto(`${B}/cart`);
      await check.locator(".cart, .shopping-cart-empty, main").first().waitFor();
      truth = await readCart(check);
    }
  } catch (e) {
    shown = `ERROR ${String(e).split("\n")[0]}`;
  }
  if (withGenClass) await page.waitForTimeout(500); // the snapshot batch reaches the bridge
  await ctx.close();
  const differs = truth && shown !== truth;
  const line = `${differs ? "STALE " : "ok    "}shown: ${shown} || server: ${truth} [wire ${wire.join(" > ")}]${order.length ? ` [delivered ${order.join(" > ")}]` : ""}`;
  return { line: errors.length ? `${line} [pageerror: ${errors[0]}]` : line, differs };
}

const s = surfaces[arg.surface];
if (!s) throw new Error(`unknown surface ${arg.surface}`);
const out = arg.out ? resolve(arg.out) : null;
if (out) mkdirSync(out, { recursive: true });
const summary = { surface: arg.surface, base: B, runs: Number(arg.runs), gap, genclass: withGenClass, sessions: [] };
for (const slow of arg.slow.split(",").map(Number)) {
  if (!withGenClass) {
    const shown = [];
    for (let i = 0; i < Number(arg.runs); i++) shown.push(await scenario(s));
    const stale = shown.filter((x) => x.differs).length;
    summary.sessions.push({ slow_ms: null, stale: `${stale} of ${shown.length}`, shown: shown.map((x) => x.line) });
    console.log(`--- ${arg.surface} without GenClass: page differs from the server's cart in ${stale} of ${shown.length}`);
    shown.forEach((x, i) => console.log(`load ${i + 1}: ${x.line}`));
    break;
  }
  await tool("genclass_clear", { what: "all" });
  const started = await tool("genclass_explore", { action: "start", runs: Number(arg.runs), slow_ms: slow });
  const shown = [];
  for (let i = 0; i < Number(arg.runs) + 2; i++) shown.push(await scenario(s));
  const report = await tool("genclass_explore", { action: "report" });
  const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1];
  const explain = fid ? await tool("genclass_explain", { id: fid }) : null;
  const findings = await tool("genclass_findings");
  let replay = null;
  if (fid) {
    await tool("genclass_replay", { action: "arm", id: fid });
    const r = await scenario(s);
    replay = { load: r.line, result: await tool("genclass_replay", { action: "result", id: fid }) };
  }
  const verdict = /RACE: (\d+) of (\d+)/.exec(report);
  const stale = shown.filter((x) => x.differs).length;
  summary.sessions.push({
    slow_ms: slow,
    verdict: verdict ? `race in ${verdict[1]} of ${verdict[2]}` : (report.split("\n").find((l) => /No race|No verdict|Internal state|Along the way/.test(l)) ?? "see report"),
    oracle_stale: `${stale} of ${shown.length} (loads 1-2 fifo, 3-${shown.length} seeded)`,
    replay: replay ? replay.result.split("\n")[0] : null,
    shown: shown.map((x) => x.line),
  });
  if (out) {
    writeFileSync(
      join(out, `${arg.surface}-${slow}.txt`),
      [started, "", ...shown.map((x, i) => `load ${i + 1}: ${x.line}`), "", report, "", findings, "", explain ?? "", "", replay ? `REPLAY load: ${replay.load}\n${replay.result}` : ""].join("\n"),
    );
  }
  console.log(`--- ${arg.surface} slow_ms=${slow}\n${shown.map((x, i) => `load ${i + 1}: ${x.line}`).join("\n")}\n${report}\n${replay ? `REPLAY: ${replay.result}` : ""}\n`);
}
await browser.close();
if (served) await served.close();
console.log(JSON.stringify(summary, null, 2));
if (out) writeFileSync(join(out, `${arg.surface}-summary${withGenClass ? "" : "-nogenclass"}.json`), JSON.stringify(summary, null, 2));
process.exit(0);
