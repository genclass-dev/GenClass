// The GenClass race hunt on Apache Superset's SQL Lab (docs/adoption/hunts/superset-sqllab.md). Not part of CI.
//
// Drives a locally running Superset (SUPERSET_URL, default http://localhost:8088, admin / general) in headless
// Chromium with the real @genclass/runtime script-tag build and the agent entry injected into each HTML page by a
// Playwright route (Superset's source is untouched), the real @genclass/mcp server in-process (its bridge on a free
// port), and the same tool calls a coding agent makes: genclass_explore start, one page load per armed run, report,
// genclass_explain of the first finding, genclass_replay arm + one load + result.
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp       # in GenClass-lib
//   node docs/adoption/hunts/superset-sqllab/hunt.mjs once <surface>             # one natural load, recording printed
//   node docs/adoption/hunts/superset-sqllab/hunt.mjs explore <surface> 300,600,900 [runs=6] [--replay]
//
// Surfaces (one page load each, the same steps every load):
//   autosave   type statement A, wait until EditorAutoSync's debounced PUT /tabstateview/<id> goes out, type B 150 ms
//              later, wait two more debounce windows. Oracle: the server's copy (GET /tabstateview/<id>, read through
//              Playwright's own request context, so neither the page nor GenClass sees it) and the PUT count.
//   format     type statement A, press Ctrl+Shift+F (SqlEditor's formatQuery hotkey, the same action as "Format SQL"
//              in the editor's "..." menu), type B 150 ms after the request went out. Oracle: the editor's text.
//   savequery  open a new tab, type a statement, run it, open Save, click the modal's Save twice 150 ms apart.
//              Oracle: POSTs to /api/v1/saved_query/.
// Besides the explore verdict, every load records its own oracle (secondary), and the summary compares the seeded
// loads' oracles with the baselines'. Output: <out>/<surface>-<slow>.txt (the tool texts) and <surface>-summary.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { chromium } from "@playwright/test";
import { formField, login } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const rtDist = join(repo, "packages/runtime/dist");
const { serve } = await import(join(repo, "packages/mcp/dist/index.js"));
const APP = (process.env.SUPERSET_URL ?? "http://localhost:8088").replace(/\/+$/, "");
const OUT = resolve(process.env.HUNT_OUT ?? join(process.env.HOME, "targets/out/hunt"));
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".map": "application/json", ".wasm": "application/wasm" };
mkdirSync(OUT, { recursive: true });

const [cmd = "once", surface = "autosave", slowArg = "300,600,900", runsArg = "6"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const doReplay = process.argv.includes("--replay");

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
const served = await serve({ cwd: OUT, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: join(OUT, "state") });
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
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "superset-hunt", version: "1" } });
input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const bridgeUrl = `http://127.0.0.1:${served.port}`;

// --------------------------------------------------------------------------- injection (Superset's files untouched)
function tags() {
  // observe mode, no model (explore needs none), no telemetry, no visual checks; the classic script runs before the
  // app's bundles, so automatic React and Redux state discovery installs first
  const cfg = { telemetry: false, mode: "observe", model: false, visual: false, devtools: false, report: "silent" };
  return (
    `<script>window.GENCLASS_CONFIG=${JSON.stringify(cfg)};window.__GENCLASS_AGENT_URL__=${JSON.stringify(bridgeUrl)};</script>` +
    `<script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script>` +
    `<script type="module">import{connectAgent}from"/__genclass/agent.js";connectAgent(window.GenClass.runtime,{url:${JSON.stringify(bridgeUrl)}});</script>`
  );
}
async function inject(ctx) {
  await ctx.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (r) => r.abort());
  await ctx.route("**/__genclass/**", (r) => {
    const file = resolve(rtDist, new URL(r.request().url()).pathname.replace(/^\/__genclass\//, ""));
    if (!file.startsWith(rtDist) || !existsSync(file)) return r.fulfill({ status: 404, body: "not found" });
    return r.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  await ctx.route(`${APP}/**`, async (r) => {
    const req = r.request();
    if (req.resourceType() !== "document") return r.fallback();
    const res = await r.fetch();
    if (!(res.headers()["content-type"] ?? "").includes("text/html")) return r.fulfill({ response: res });
    return r.fulfill({ response: res, body: (await res.text()).replace(/<head([^>]*)>/i, (m) => `${m}${tags()}`) });
  });
}

// --------------------------------------------------------------------------- the steps a person takes
const A = "SELECT 'alpha' AS v";
const B = " -- bravo";
const activeEditor = (page) => page.locator('[role="tabpanel"]:not([aria-hidden="true"]) .ace_editor:not(.ace_autocomplete)');
const editorText = (page) => activeEditor(page).evaluate((el) => window.ace.edit(el).getValue());

async function openSqlLab(page) {
  await page.goto(`${APP}/sqllab/`);
  await page.locator('[data-test="sql-editor-tabs"]').waitFor({ timeout: 60_000 });
  await activeEditor(page).waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 20_000 });
  await settle(page);
}
async function settle(page) {
  await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(30_000)).catch(() => {});
}
async function typeA(page) {
  await activeEditor(page).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(A, { delay: 20 });
  await page.keyboard.press("Escape");
}
async function waitFor(pred, ms, page) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await page.waitForTimeout(50)) if (pred()) return true;
  return false;
}

const surfaces = {
  async autosave(page, net) {
    await openSqlLab(page);
    net.puts.length = 0;
    await typeA(page);
    await waitFor(() => net.puts.length > 0, 10_000, page);
    const tabUrl = net.puts[0]?.url;
    await page.waitForTimeout(150);
    await page.keyboard.type(B, { delay: 20 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(12_000);
    await settle(page);
    const server = tabUrl ? await (await page.context().request.get(tabUrl)).json() : null;
    return { puts: net.puts.map((p) => p.sql), server: server?.sql ?? null, shown: await editorText(page), lost: server?.sql !== A + B };
  },
  async format(page, net) {
    await openSqlLab(page);
    await typeA(page);
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+Shift+F"); // SqlEditor's formatQuery hotkey (the "..." menu's Format SQL)
    await waitFor(() => net.formats > 0, 5_000, page);
    await page.waitForTimeout(150);
    await page.keyboard.press("Control+End");
    await page.keyboard.type(B, { delay: 20 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(2_000);
    await settle(page);
    const shown = await editorText(page);
    // the typed text belongs at the end of the statement: missing, or moved inside it, is the bug
    return { shown, formats: net.formats, lost: !shown.trimEnd().endsWith("-- bravo") };
  },
  async savequery(page, net) {
    await openSqlLab(page);
    // a new tab each load, so the modal offers "Save" (a tab holding a saved query offers "Save as new")
    await page.locator('[data-test="add-tab-icon"]:visible').first().click(); // two in the DOM, one shown
    await page.waitForTimeout(1_000);
    await activeEditor(page).waitFor();
    await typeA(page);
    // as the project's own spec does: run the query, then Save
    await page.keyboard.press("Control+Enter");
    await page.locator('[role="tabpanel"]:not([aria-hidden="true"]) [data-test="south-pane"] [role="grid"]').waitFor({ timeout: 60_000 });
    await settle(page);
    await page.locator('[role="tabpanel"]:not([aria-hidden="true"]) button[aria-label="Save"]').click();
    const modal = page.locator(".save-query-modal");
    await modal.waitFor();
    await modal.locator('input[type="text"]').first().fill("hunt double save");
    // two clicks 150 ms apart (a person's double click)
    const save = modal.getByRole("button", { name: "Save", exact: true });
    await save.click();
    await page.waitForTimeout(150);
    await save.click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    await settle(page);
    return { savedQueryPosts: net.saves, modalOpen: await modal.isVisible() };
  },
};

// --------------------------------------------------------------------------- runs
const browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers"] });
const storageState = await login(browser, APP);

async function load(fn) {
  const ctx = await browser.newContext({ storageState, bypassCSP: true, viewport: { width: 1400, height: 900 }, permissions: ["local-network-access"] });
  await inject(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).split("\n")[0]));
  const net = { puts: [], formats: 0, saves: 0 };
  page.on("request", (req) => {
    const u = req.url();
    if (req.method() === "PUT" && /\/tabstateview\/\d+$/.test(u)) net.puts.push({ url: u, sql: formField(req, "sql") });
    if (req.method() === "POST" && u.includes("/api/v1/sqllab/format_sql/")) net.formats++;
    if (req.method() === "POST" && /\/api\/v1\/saved_query\/?$/.test(u)) net.saves++;
  });
  let oracle;
  try {
    oracle = await fn(page, net);
  } catch (e) {
    oracle = { error: String(e).split("\n")[0] };
  }
  const order = await page
    .evaluate(() => window.__GENCLASS_AGENT__.recorded().order.filter((k) => /tabstateview|format_sql|saved_query/.test(k)))
    .catch(() => []);
  await page.waitForTimeout(800); // the last snapshot batch reaches the bridge
  await ctx.close();
  return { ...oracle, order, ...(errors.length ? { pageerrors: errors.slice(0, 3) } : {}) };
}

const fn = surfaces[surface];
if (!fn) throw new Error(`unknown surface ${surface}`);
const summary = { surface, app: APP, sessions: [] };
if (cmd === "once") {
  await tool("genclass_clear", { what: "all" });
  const r = await load(fn);
  console.log(JSON.stringify(r, null, 2));
  console.log(await tool("genclass_status"));
  console.log(await tool("genclass_findings"));
} else if (cmd === "explore") {
  for (const slow of slowArg.split(",").map(Number)) {
    await tool("genclass_clear", { what: "all" });
    const started = await tool("genclass_explore", { action: "start", runs: Number(runsArg), slow_ms: slow });
    const loads = [];
    for (let i = 0; i < Number(runsArg) + 2; i++) {
      loads.push(await load(fn));
      console.log(`${surface} slow ${slow} load ${i + 1}: ${JSON.stringify(loads.at(-1))}`);
    }
    const report = await tool("genclass_explore", { action: "report" });
    const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1];
    const explain = fid ? await tool("genclass_explain", { id: fid }) : "";
    let replay = "";
    if (fid && doReplay) {
      await tool("genclass_replay", { action: "arm", id: fid });
      const r = await load(fn);
      replay = `replay load: ${JSON.stringify(r)}\n${await tool("genclass_replay", { action: "result", id: fid })}`;
    }
    const findings = await tool("genclass_findings");
    const verdict = /RACE: (\d+) of (\d+)/.exec(report);
    const key = (o) => JSON.stringify(surface === "autosave" ? [o.puts?.length, o.server] : surface === "format" ? o.shown : o.savedQueryPosts);
    const base = new Set(loads.slice(0, 2).map(key));
    summary.sessions.push({
      slow_ms: slow,
      verdict: verdict ? `race in ${verdict[1]} of ${verdict[2]}` : /No race/.test(report) ? "no race" : "no verdict",
      finding: fid ?? null,
      oracleDiffering: `${loads.slice(2).filter((o) => !base.has(key(o))).length} of ${loads.length - 2}`,
      lostOrDuplicated: loads.map((o) => (surface === "savequery" ? o.savedQueryPosts : o.lost ? 1 : 0)),
      loads,
      replay: replay.split("\n").slice(-3).join(" ").slice(0, 400),
    });
    writeFileSync(join(OUT, `${surface}-${slow}.txt`), [started, "", ...loads.map((o, i) => `load ${i + 1}: ${JSON.stringify(o)}`), "", report, "", explain, "", replay, "", findings].join("\n"));
    console.log(`--- ${surface} slow_ms=${slow}\n${report}\n`);
  }
  writeFileSync(join(OUT, `${surface}-summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary.sessions.map(({ loads, ...s }) => s), null, 2));
}
await browser.close();
await served.close();
process.exit(0);
