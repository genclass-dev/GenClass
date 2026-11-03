// Race hunt harness for the Gotify WebUI (docs/adoption/hunts/gotify.md). Not part of CI; run by hand against a local
// Gotify server (see the report's "Reproducing" section for the server's own commands).
//
//   node docs/adoption/hunts/gotify/hunt.mjs --gotify http://localhost:8080 --surface <name> --slow 300,600,900 \
//     [--runs 6] [--out docs/adoption/hunts/gotify/results] [--log ~/targets/run/server.log]
//
// GenClass is injected from outside, as in hunts/gitea-explore.mjs: a Playwright route rewrites Gotify's index.html to
// load the script-tag build (packages/runtime/dist/genclass.global.js) from a virtual same-origin path, started with
// the model skipped and telemetry off, and connects the coding-agent link (dist/agent.js) to the MCP bridge started in
// this process (packages/mcp/dist). Gotify's state lives in MobX stores, which GenClass does not discover, so the
// injected script mirrors what the page shows with rt.atom() from a MutationObserver: the heading, the message titles,
// whether the list is a spinner, the application navigation, and the applications and clients tables. Those mirrors,
// the page text and the form values are what the explore verdict compares.
//
// Surfaces (--surface), each the same steps every load:
//   push-during-load  open All Messages; once the browser has the GET /message?since=0 response (Playwright's
//                     requestfinished) but before the app has it (GenClass holds it for slow_ms), push a message with
//                     the REST API; the WebSocket delivers it while the first page is still in flight
//   nav-during-load   open All Messages and click the "Backup" application while the first page is in flight
//   refresh-twice     open All Messages, wait for the list, click Refresh twice (Playwright's pace)
//   refresh-once      the control: the same with one click
//   create-app-double open Applications, Create Application, type a name, click Create twice
//   create-client-double  the same on Clients
//   delete-then-leave delete a message, wait for the undo snackbar to close (5 s), leave the page while that DELETE is
//                     in flight (pagehide runs executePendingDeletes)
// Every load's line ends with an oracle of this harness's own, read after whenSettled() from the DOM and the REST API.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
    gotify: { type: "string", default: "http://localhost:8080" },
    surface: { type: "string", default: "push-during-load" },
    slow: { type: "string", default: "300,600,900" },
    runs: { type: "string", default: "6" },
    out: { type: "string", default: "" },
    log: { type: "string", default: "" },
  },
});
const G = arg.gotify.replace(/\/+$/, "");
const TYPES = { ".js": "text/javascript", ".map": "application/json" };
const BASIC = "Basic " + Buffer.from("admin:admin").toString("base64");

// --------------------------------------------------------------------------- the REST API (seed and oracle)
async function api(method, path, body) {
  const r = await fetch(G + path, {
    method,
    headers: { authorization: BASIC, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function appByName(name) {
  const apps = await api("GET", "/application");
  return apps.find((a) => a.name === name) ?? (await api("POST", "/application", { name }));
}
async function push(app, title) {
  const r = await fetch(`${G}/message`, {
    method: "POST",
    headers: { authorization: BASIC, "content-type": "application/json" },
    body: JSON.stringify({ appid: app.id, title, message: `body of ${title}`, priority: 1 }),
  });
  if (!r.ok) throw new Error(`push: HTTP ${r.status}`);
  return r.json();
}
const backup = await appByName("Backup");
const hunt = await appByName("Hunt");
const existing = (await api("GET", "/message?limit=200")).messages.length;
for (let i = existing; i < 20; i++) await push(i % 2 ? backup : hunt, `seed ${i}`);

// --------------------------------------------------------------------------- what the route injects into <head>
const INJECT = `<script src="/__genclass/rt/genclass.global.js" data-manual data-base="/__genclass/rt/"></script>
<script>window.__gcRt = window.GenClass.init({ model: false, telemetry: false, report: "silent" });</script>
<script type="module">
import { connectAgent } from "/__genclass/rt/agent.js";
const rt = window.__gcRt;
connectAgent(rt);
// Gotify keeps its state in MobX stores, which GenClass does not discover: register what the page shows.
const atoms = {
  heading: rt.atom("heading", { text: "" }),
  messages: rt.atom("messages", { spinner: false, titles: "" }),
  navigation: rt.atom("navigation", { apps: "" }),
  appTable: rt.atom("appTable", { names: "" }),
  clientTable: rt.atom("clientTable", { names: "" }),
};
const txt = (sel) => [...document.querySelectorAll(sel)].map((e) => (e.textContent || "").trim()).join(" | ");
const read = () => {
  const now = {
    heading: { text: txt("main h4") },
    messages: { spinner: !!document.querySelector("main .MuiCircularProgress-root"), titles: txt("#messages .message .title") },
    navigation: { apps: txt("#message-navigation .item") },
    appTable: { names: txt("#app-table tbody tr td:nth-child(2)") },
    clientTable: { names: txt("#client-table tbody tr td:nth-child(1)") },
  };
  for (const k of Object.keys(now)) if (JSON.stringify(atoms[k].get()) !== JSON.stringify(now[k])) atoms[k].set(now[k]);
};
new MutationObserver(read).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
</script>
`;

async function route(page) {
  await page.route(`${G}/**`, async (r) => {
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
  for (let i = 0; i < 1000; i++) {
    const m = lines.find((x) => x.id === my);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no reply to ${method}`);
}
const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gotify-hunt", version: "1" } });
input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const bridgeUrl = `http://127.0.0.1:${served.port}`;

// --------------------------------------------------------------------------- helpers
async function connected(page) {
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
}
async function settle(page) {
  await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000));
}
const shownTitles = (page) => page.locator("#messages .message .title").allTextContents();
const spinner = (page) => page.locator("main .MuiCircularProgress-root").count();
let seq = 0;
const tag = () => `${arg.surface}-${process.pid}-${++seq}`;
const serverLines = (re) => (arg.log && existsSync(arg.log) ? readFileSync(arg.log, "utf8").split("\n").filter((l) => re.test(l)).length : -1);

// --------------------------------------------------------------------------- the scenarios (what a person does)
const surfaces = {
  async "push-during-load"(page) {
    const title = `pushed ${tag()}`;
    let pushed = null;
    page.on("requestfinished", (req) => {
      if (!pushed && /\/message\?since=0$/.test(req.url())) pushed = push(hunt, title);
    });
    await page.goto(`${G}/#/`);
    await connected(page);
    await page.locator("#messages").waitFor({ timeout: 15_000 });
    if (pushed) await pushed;
    await settle(page);
    const titles = await shownTitles(page);
    const copies = titles.filter((t) => t === title).length;
    return `pushed message shown ${copies}x (${titles.length} rows; first "${titles[0]}")`;
  },
  async "nav-during-load"(page) {
    await page.goto(`${G}/#/`);
    await connected(page);
    const link = page.locator("#message-navigation .item", { hasText: "Backup" });
    await link.waitFor();
    const inFlight = (await page.locator("#messages").count()) === 0;
    await link.click();
    await settle(page);
    await page.waitForTimeout(300);
    const heading = (await page.locator("main h4").first().textContent())?.trim();
    const rows = (await shownTitles(page)).length;
    const want = (await api("GET", `/application/${backup.id}/message?limit=200`)).messages.length;
    return `clicked while first page ${inFlight ? "in flight" : "loaded"}; heading=${heading} spinner=${await spinner(page)} rows=${rows} of ${want}`;
  },
  async "refresh-twice"(page) {
    await page.goto(`${G}/#/`);
    await connected(page);
    await page.locator("#messages .message").first().waitFor();
    await page.locator("#refresh-all").click();
    await page.locator("#refresh-all").click();
    await settle(page);
    await page.waitForTimeout(300);
    return `spinner=${await spinner(page)} rows=${(await shownTitles(page)).length}`;
  },
  async "refresh-once"(page) {
    await page.goto(`${G}/#/`);
    await connected(page);
    await page.locator("#messages .message").first().waitFor();
    await page.locator("#refresh-all").click();
    await settle(page);
    await page.waitForTimeout(300);
    return `spinner=${await spinner(page)} rows=${(await shownTitles(page)).length}`;
  },
  async "create-app-double"(page) {
    const name = `app ${tag()}`;
    await page.goto(`${G}/#/applications`);
    await connected(page);
    await page.locator("#create-app").click();
    await page.locator("#app-dialog .name input").fill(name);
    const create = page.locator("#app-dialog button.create");
    await create.click();
    await create.click({ timeout: 2_000 }).catch(() => {});
    await settle(page);
    await page.waitForTimeout(300);
    const n = (await api("GET", "/application")).filter((a) => a.name === name).length;
    return `applications named like the form: ${n}`;
  },
  async "create-client-double"(page) {
    const name = `client ${tag()}`;
    await page.goto(`${G}/#/clients`);
    await connected(page);
    await page.locator("#create-client").click();
    await page.locator("#client-dialog .name input").fill(name);
    const create = page.locator("#client-dialog button.create");
    await create.click();
    await create.click({ timeout: 2_000 }).catch(() => {});
    await settle(page);
    await page.waitForTimeout(300);
    const n = (await api("GET", "/client")).filter((c) => c.name === name).length;
    return `clients named like the form: ${n}`;
  },
  async "delete-then-leave"(page) {
    const title = `to delete ${tag()}`;
    const msg = await push(hunt, title);
    const deletes = [];
    page.context().on("request", (req) => {
      if (req.method() === "DELETE" && req.url().endsWith(`/message/${msg.id}`)) deletes.push(req.url());
    });
    const before = serverLines(new RegExp(`method=DELETE path=/message/${msg.id} `));
    await page.goto(`${G}/#/`);
    await connected(page);
    const row = page.locator("#messages .message", { hasText: title });
    await row.locator(".delete").click();
    const sent = page.waitForRequest((r) => r.method() === "DELETE" && r.url().endsWith(`/message/${msg.id}`), { timeout: 10_000 });
    await sent;
    await page.goto("about:blank");
    await new Promise((r) => setTimeout(r, 1500));
    const after = serverLines(new RegExp(`method=DELETE path=/message/${msg.id} `));
    return `DELETE /message/${msg.id} seen by the browser ${deletes.length}x, by the server ${after < 0 ? "?" : after - before}x`;
  },
};

// --------------------------------------------------------------------------- runs
const browser = await chromium.launch();
const loginCtx = await browser.newContext();
const login = await loginCtx.request.post(`${G}/auth/local/login`, { headers: { authorization: BASIC }, data: { name: "gotify-hunt" } });
if (!login.ok()) throw new Error(`login failed: HTTP ${login.status()}`);
const storageState = await loginCtx.storageState();
await loginCtx.close();

async function scenario(fn) {
  const ctx = await browser.newContext({ storageState, permissions: ["local-network-access"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (process.env.HUNT_DEBUG) page.on("console", (m) => console.log("[page]", m.type(), m.text()));
  await page.addInitScript((u) => (window.__GENCLASS_AGENT_URL__ = u), bridgeUrl);
  await route(page);
  let shown;
  try {
    shown = await fn(page);
  } catch (e) {
    shown = `ERROR ${String(e).split("\n")[0]}`;
  }
  const order = await page
    .evaluate(() => window.__GENCLASS_AGENT__.recorded().order.map((k) => k.replace(/^.*?(GET|POST|DELETE|PUT) /, "$1 ").replace(/^https?:\/\/[^/]+/, "")))
    .catch(() => []);
  await page.waitForTimeout(500);
  await ctx.close();
  const line = `${shown} [delivered ${order.join(" then ") || "none"}]`;
  return errors.length ? `${line} [pageerror: ${errors[0]}]` : line;
}

const fn = surfaces[arg.surface];
if (!fn) throw new Error(`unknown surface ${arg.surface}`);
const out = arg.out ? resolve(arg.out) : null;
if (out) mkdirSync(out, { recursive: true });
const summary = { surface: arg.surface, gotify: G, runs: Number(arg.runs), sessions: [] };
for (const slow of arg.slow.split(",").map(Number)) {
  await tool("genclass_clear", { what: "all" });
  const started = await tool("genclass_explore", { action: "start", runs: Number(arg.runs), slow_ms: slow });
  const shown = [];
  for (let i = 0; i < Number(arg.runs) + 2; i++) shown.push(await scenario(fn));
  const report = await tool("genclass_explore", { action: "report" });
  const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1];
  const explain = fid ? await tool("genclass_explain", { id: fid }) : null;
  const findings = await tool("genclass_findings");
  const verdict = /RACE: (\d+) of (\d+)/.exec(report);
  summary.sessions.push({ slow_ms: slow, verdict: verdict ? `race in ${verdict[1]} of ${verdict[2]}` : "no race", shown, findings: findings.split("\n").slice(0, 12) });
  if (out) writeFileSync(join(out, `${arg.surface}-${slow}.txt`), [started, "", ...shown.map((s, i) => `load ${i + 1}: ${s}`), "", report, "", findings, "", explain ?? ""].join("\n"));
  console.log(`--- ${arg.surface} slow_ms=${slow}\n${shown.map((s, i) => `load ${i + 1}: ${s}`).join("\n")}\n${report}\n`);
}
await browser.close();
await served.close();
console.log(JSON.stringify(summary, null, 2));
if (out) writeFileSync(join(out, `${arg.surface}-summary.json`), JSON.stringify(summary, null, 2));
process.exit(0);
