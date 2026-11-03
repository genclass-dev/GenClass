// Race hunt harness for Paperless-ngx (docs/adoption/hunts/paperless-ngx.md). Not part of CI; run by hand against the
// project's own disposable instance (src-ui `pnpm e2e:backend` on :8001 and `pnpm start:e2e` on :4200).
//
//   node docs/adoption/hunts/paperless-ngx/hunt.mjs --surface search --slow 300,600,900 [--runs 6] [--out <dir>]
//
// GenClass is injected from outside; Paperless-ngx's code is unchanged. A Playwright route rewrites the Angular dev
// server's index.html to load the script-tag build (packages/runtime/dist/genclass.global.js) from a virtual
// same-origin path (/__genclass/rt/), started with the model skipped (model: false), telemetry off and observe mode,
// then connects the coding-agent link (dist/agent.js) to the MCP bridge started in this process (packages/mcp/dist).
// Angular keeps its state in components and signals, which GenClass does not discover, so the verdict compares the
// page text, the form values and the requests sent; no mirror atom is registered. In DEBUG the backend authenticates
// any API request whose Referer is http://localhost:4200/ as the first superuser (src/paperless/auth.py), so no login
// is needed.
//
// Surfaces (--surface), each with an oracle of its own read after the agent link reports a quiet point:
//   search  global search in the header: type "doc", pause 450 ms (the 400 ms debounce fires), type "ument 12";
//           oracle: the dropdown's document titles against the input's value (only "document 12" matches it)
//   list    the document list's Title & content filter (control: the list cancels its previous request):
//           type "test", pause 450 ms, type " document 1"; oracle: the "N documents" line and the first titles
//   notes   the Notes tab of document 1: type a note and press Ctrl+Enter twice, 40 ms apart; oracle: the notes the
//           API holds for document 1 after the run (seeded: 4) and the notes the page lists; the extra notes are
//           deleted through the API after each load
// For each --slow value it runs one explore session: 2 fifo baselines + --runs seeded loads. Each load's line ends
// with the delivery order of the requests under test as the agent link recorded it. Every browser context gets the
// local-network-access permission (Chromium otherwise blocks the page's requests to the loopback bridge).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const rtDist = join(root, "packages/runtime/dist");
const { serve } = await import(join(root, "packages/mcp/dist/index.js"));

const { values: arg } = parseArgs({
  options: {
    ui: { type: "string", default: "http://localhost:4200" },
    api: { type: "string", default: "http://localhost:8001" },
    surface: { type: "string", default: "search" },
    slow: { type: "string", default: "300,600,900" },
    runs: { type: "string", default: "6" },
    seed: { type: "string", default: "1" },
    out: { type: "string", default: "" },
  },
});
const UI = arg.ui.replace(/\/+$/, "");
const API = arg.api.replace(/\/+$/, "");
const TYPES = { ".js": "text/javascript", ".map": "application/json" };

// --------------------------------------------------------------------------- what the route injects into <head>
const INJECT = `<script src="/__genclass/rt/genclass.global.js" data-manual data-base="/__genclass/rt/"></script>
<script>window.__gcRt = window.GenClass.init({ model: false, telemetry: false, report: "silent", mode: "observe", devtools: false, visual: false, analytics: false });</script>
<script type="module">
import { connectAgent } from "/__genclass/rt/agent.js";
connectAgent(window.__gcRt);
</script>
`;

async function route(page) {
  await page.route(`${UI}/**`, async (r) => {
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
    if (req.resourceType() !== "document") return r.fallback();
    const resp = await r.fetch();
    const type = resp.headers()["content-type"] ?? "";
    if (!type.includes("text/html")) return r.fulfill({ response: resp });
    const body = (await resp.text()).replace(/<head([^>]*)>/i, (m) => `${m}\n${INJECT}`);
    return r.fulfill({ response: resp, body });
  });
}

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
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no reply to ${method}`);
}
const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "paperless-hunt", version: "1" } });
input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const bridgeUrl = `http://127.0.0.1:${served.port}`;

// --------------------------------------------------------------------------- API helpers (the DEBUG Referer login)
const H = { Referer: `${UI}/`, Accept: "application/json; version=10" };
async function api(path, init = {}) {
  const r = await fetch(`${API}/api/${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  return r.status === 204 ? null : r.json();
}
const NOTE = "hunt note: checked the totals";
async function cleanNotes() {
  const notes = await api("documents/1/notes/");
  for (const n of notes.filter((n) => n.note === NOTE)) await api(`documents/1/notes/?id=${n.id}`, { method: "DELETE" });
}

// --------------------------------------------------------------------------- the scenarios (what a person does)
const surfaces = {
  search: {
    path: "/dashboard",
    keys: /\/api\/search\//,
    async run(page) {
      const box = page.locator("pngx-global-search input[name=query]");
      await box.waitFor();
      await connected(page);
      await box.click();
      await box.pressSequentially("doc", { delay: 60 });
      await page.waitForTimeout(450);
      await box.pressSequentially("ument 12", { delay: 30 });
      await pastDebounce(page);
      await settle(page);
      const value = await box.inputValue();
      const shown = await page.locator("pngx-global-search .dropdown-menu .dropdown-item .text-truncate").evaluateAll((els) =>
        els.map((e) => (e.firstChild?.textContent ?? e.textContent).trim()),
      );
      const ok = shown.length === 1 && shown[0] === "document 12";
      return { ok, text: `input="${value}" dropdown=[${shown.join(", ")}]` };
    },
  },
  list: {
    path: "/documents",
    keys: /\/api\/documents\/#/,
    async run(page) {
      const box = page.getByRole("main").getByRole("combobox");
      await page.locator("pngx-document-list").getByText(/61 documents/).first().waitFor();
      await connected(page);
      await box.click();
      await box.pressSequentially("test", { delay: 60 });
      await page.waitForTimeout(450);
      await box.pressSequentially(" document 1", { delay: 30 });
      await pastDebounce(page);
      await settle(page);
      const count = (await page.locator("pngx-document-list").innerText()).match(/(\d+) documents?/)?.[0] ?? "?";
      return { ok: null, text: `filter="${await box.inputValue()}" ${count}` };
    },
  },
  notes: {
    path: "/documents/1/notes",
    keys: /\/notes\//,
    async run(page) {
      const area = page.locator("pngx-document-notes textarea");
      await area.waitFor();
      await connected(page);
      await area.fill(NOTE);
      await area.press("Control+Enter");
      await page.waitForTimeout(40);
      await area.press("Control+Enter");
      await settle(page);
      await page.waitForTimeout(300);
      const held = (await api("documents/1/notes/")).filter((n) => n.note === NOTE).length;
      const listed = await page.locator("pngx-document-notes .card-text").evaluateAll((els) => els.filter((e) => e.textContent.trim() === "hunt note: checked the totals").length);
      await cleanNotes();
      return { ok: held === 1, text: `api holds ${held} copy(ies), page lists ${listed}` };
    },
  },
};

async function connected(page) {
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
}
// Workaround for a GenClass gap (report section 9): the agent link counts pending setTimeout timers of at most 1 s as
// "not quiet", but rxjs 7's debounceTime schedules with setInterval, so whenSettled() can resolve before Angular's
// debounced request is sent. Waiting past the 400 ms debounce first makes the quiet point the one after the request.
async function pastDebounce(page) {
  await page.waitForTimeout(500);
}
async function settle(page) {
  await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000));
}

const browser = await chromium.launch();
async function load(s) {
  const ctx = await browser.newContext({ permissions: ["local-network-access"], viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (process.env.HUNT_DEBUG) page.on("console", (m) => console.log("[page]", m.type(), m.text()));
  await page.addInitScript((u) => (window.__GENCLASS_AGENT_URL__ = u), bridgeUrl);
  await route(page);
  let res;
  try {
    await page.goto(`${UI}${s.path}`);
    res = await s.run(page);
  } catch (e) {
    res = { ok: null, text: `ERROR ${String(e).split("\n")[0]}` };
  }
  const rec = await page.evaluate(() => window.__GENCLASS_AGENT__.recorded()).catch(() => null);
  const order = (rec?.order ?? [])
    .filter((k) => s.keys.test(k))
    .map((k) => `${k.split(" ")[0]} ${k.slice(k.lastIndexOf("#"))}`);
  await page.waitForTimeout(500); // the snapshot batch reaches the bridge
  await ctx.close();
  return { ...res, delivered: order, errors: errors.slice(0, 1) };
}

const s = surfaces[arg.surface];
if (!s) throw new Error(`unknown surface ${arg.surface}`);
if (arg.surface === "notes") await cleanNotes();
const out = arg.out ? resolve(arg.out) : null;
if (out) mkdirSync(out, { recursive: true });
const summary = { surface: arg.surface, ui: UI, runs: Number(arg.runs), seed: Number(arg.seed), sessions: [] };
for (const slow of arg.slow.split(",").map(Number)) {
  await tool("genclass_clear", { what: "all" });
  const started = await tool("genclass_explore", { action: "start", runs: Number(arg.runs), slow_ms: slow, seed: Number(arg.seed), route: s.path });
  const loads = [];
  for (let i = 0; i < Number(arg.runs) + 2; i++) {
    const r = await load(s);
    loads.push(r);
    console.log(`  load ${i + 1}${i < 2 ? " (fifo)" : ""}: ${r.ok === false ? "WRONG " : ""}${r.text} [delivered ${r.delivered.join(" then ") || "none"}]${r.errors.length ? ` [pageerror ${r.errors[0]}]` : ""}`);
  }
  const report = await tool("genclass_explore", { action: "report" });
  const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1];
  const explain = fid ? await tool("genclass_explain", { id: fid }) : null;
  const verdict = /RACE: (\d+) of (\d+)/.exec(report);
  const noRace = /No race found: none of the (\d+)/.exec(report);
  summary.sessions.push({
    slow_ms: slow,
    explore: verdict ? `RACE in ${verdict[1]} of ${verdict[2]}` : noRace ? `no race, 0 of ${noRace[1]}` : "no verdict",
    oracleWrong: loads.filter((l) => l.ok === false).length,
    loads: loads.map((l, i) => ({ load: i + 1, fifo: i < 2, ok: l.ok, shown: l.text, delivered: l.delivered })),
  });
  if (out) writeFileSync(join(out, `${arg.surface}-slow${slow}-seed${arg.seed}.txt`), [started, "", ...loads.map((l, i) => `load ${i + 1}: ${l.text} [delivered ${l.delivered.join(" then ")}]`), "", report, "", explain ?? ""].join("\n"));
  console.log(`--- ${arg.surface} slow_ms=${slow}\n${report}\n`);
}
await browser.close();
await served.close();
if (out) writeFileSync(join(out, `${arg.surface}-seed${arg.seed}-summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.sessions.map(({ loads, ...x }) => x)));
process.exit(0);
