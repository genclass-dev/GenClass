// The GenClass race hunt on Linkwarden's web app (docs/adoption/hunts/linkwarden.md). Not part of CI.
//
// It drives a locally running Linkwarden (LW_URL, default http://localhost:3000, `yarn web:dev`) in headless Chromium
// with the real @genclass/runtime script-tag build and the agent entry injected into every HTML document by Playwright
// (Linkwarden's source is untouched), the real @genclass/mcp server in-process (its bridge on a free port), and the same
// tool calls a coding agent makes: genclass_explore start → one page load per armed run → report → genclass_explain →
// genclass_replay. Modelled on docs/adoption/hunts/strapi/hunt.mjs.
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp     # in GenClass-lib
//   node docs/adoption/hunts/linkwarden/seed.mjs                            # once: user test/password, 120 links
//   node docs/adoption/hunts/linkwarden/hunt.mjs probe /links                # what the page shows (aria snapshot)
//   node docs/adoption/hunts/linkwarden/hunt.mjs once <scenario>             # one natural load, the recording printed
//   node docs/adoption/hunts/linkwarden/hunt.mjs explore <scenario> <slow_ms> [runs]   # HUNT_SEED=7: first seed 7
//   node docs/adoption/hunts/linkwarden/hunt.mjs replay <scenario> <finding id>
//
// Every load starts from the same database state: before each load the harness resets, with psql on the local
// database (PG_URL), the fields its scenario changes (the link's name and pin, the user's reader preferences and
// theme), so the same steps send the same requests with the same bodies on every run. Besides the explore verdict,
// every run records a DOM oracle of its own (read after the page settled) and the server's state after the run (read
// with psql), compared across the fifo and seeded runs by this script: a secondary oracle, labelled as such.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { chromium } from "@playwright/test";
import { serve } from "../../../../packages/mcp/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const rtDist = join(repo, "packages/runtime/dist");
const APP = (process.env.LW_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const OUT = process.env.HUNT_OUT ?? "/root/targets/lw-hunt-out";
const STATE = join(here, "storage-state.json"); // written by seed.mjs (a session cookie for the local instance only)
const PG_URL = process.env.PG_URL ?? "postgresql://linkwarden:linkwarden@localhost:5432/linkwarden";
const LINK = Number(process.env.LW_LINK ?? 120); // the newest seeded link: first in the list, preservation pending
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".map": "application/json", ".wasm": "application/wasm" };
mkdirSync(OUT, { recursive: true });

// --------------------------------------------------------------------------- the database (reset and read back)
const sql = (q) => execFileSync("psql", [PG_URL, "-At", "-F", "|", "-c", q], { encoding: "utf8" }).trim();
function reset() {
  sql(`update "Link" set name = 'hotel article 119', "lastPreserved" = null, color = null, icon = null where id = ${LINK};`);
  sql(`delete from "_PinnedLinks" where "A" = ${LINK};`);
  sql(`update "User" set theme = 'light', "readableFontSize" = '20px', "readableLineHeight" = '1.8' where username = 'test';`);
}
const serverState = () => {
  const [name, pinned] = sql(`select name, (select count(*) from "_PinnedLinks" where "A" = ${LINK}) from "Link" where id = ${LINK};`).split("|");
  const [theme, fontSize, lineHeight] = sql(`select theme, "readableFontSize", "readableLineHeight" from "User" where username = 'test';`).split("|");
  return { name, pinned: Number(pinned), theme, fontSize, lineHeight };
};

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
  // the bridge's state (runs, findings) persists in this directory, so a later invocation can replay a finding
  served = await serve({ cwd: OUT, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: join(OUT, process.env.HUNT_STATE ?? "state") });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "linkwarden-hunt", version: "1" } });
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

// --------------------------------------------------------------------------- injection (Linkwarden's files untouched)
function tags(bridgeUrl) {
  // the runtime: observe mode, no model (explore needs none), no telemetry, no visual checks; automatic state
  // discovery (React component state) is on by default in the script-tag build and installs before react-dom evaluates
  const cfg = { telemetry: false, mode: "observe", model: false, visual: false, devtools: false, report: "console" };
  return (
    `<script>window.GENCLASS_CONFIG=${JSON.stringify(cfg)};window.__GENCLASS_AGENT_URL__=${JSON.stringify(bridgeUrl)};</script>` +
    `<script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script>` +
    `<script type="module">import{connectAgent}from"/__genclass/agent.js";window.__GENCLASS_CONN__=connectAgent(window.GenClass.runtime,{url:${JSON.stringify(bridgeUrl)}});</script>`
  );
}
async function inject(context, bridgeUrl) {
  // hermetic runs: nothing but the local server and the bridge is reachable
  await context.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => route.abort());
  await context.route("**/__genclass/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/__genclass\//, "");
    const file = resolve(rtDist, p);
    if (!file.startsWith(rtDist) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  if (!bridgeUrl) return;
  await context.route(
    (url) => url.origin === APP && !url.pathname.startsWith("/_next/") && !url.pathname.startsWith("/api/"),
    async (route) => {
      const req = route.request();
      if (req.resourceType() !== "document") return route.fallback();
      const res = await route.fetch();
      const ct = res.headers()["content-type"] ?? "";
      if (!ct.includes("text/html")) return route.fulfill({ response: res });
      const html = await res.text();
      return route.fulfill({ response: res, body: html.replace(/<head([^>]*)>/i, (m) => `${m}${tags(bridgeUrl)}`) });
    },
  );
}

async function newPage(browser, bridgeUrl) {
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1400, height: 900 }, storageState: STATE });
  await inject(ctx, bridgeUrl);
  const page = await ctx.newPage();
  const log = [];
  page.on("console", (m) => {
    const t = m.type();
    const text = m.text();
    if (/Download the React DevTools|\[HMR\]|\[Fast Refresh\]|images.localPatterns|Failed to load resource/.test(text)) return;
    if (t === "error" || t === "warning" || /genclass/i.test(text)) log.push(`${t}: ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => log.push(`pageerror: ${String(e.message ?? e).slice(0, 300)}`));
  return { ctx, page, log };
}

const settle = (page, ms = 25_000) => page.evaluate((t) => window.__GENCLASS_AGENT__.whenSettled(t), ms);
const card = (page) => page.locator(`[data-link-id="${LINK}"], [data-id="${LINK}"]`).first();
/** The first card of the list: the newest link. */
const firstCard = (page) => page.getByText("hotel article 119", { exact: false }).first();
const nextPoll = (page) => page.waitForRequest((r) => r.method() === "GET" && /\/api\/v1\/search\?cursor=/.test(r.url()), { timeout: 12_000 });

// --------------------------------------------------------------------------- scenarios
const SCENARIOS = {
  // (1) edit a link's name in its modal while the list's preservation poll is in flight: open the card's menu, "Edit
  // link", type the new name, wait until the list's next 5 s poll is sent, then "Save changes" at once
  "edit-name": {
    path: "/links",
    ready: async (page) => firstCard(page).waitFor({ timeout: 60_000 }),
    steps: async (page) => {
      await openCardMenu(page);
      await page.getByRole("menuitem", { name: /edit link/i }).click();
      const name = page.getByPlaceholder(/example/i).first();
      await name.fill("renamed during a poll");
      await nextPoll(page);
      await page.getByRole("button", { name: /save changes/i }).click();
    },
    oracle: async (page) => ({ cards: await cardTitles(page) }),
  },
  // (2) pin, then unpin, from the card's menu, the second before the first response lands
  "pin-unpin": {
    path: "/links",
    ready: async (page) => firstCard(page).waitFor({ timeout: 60_000 }),
    steps: async (page) => {
      await openCardMenu(page);
      await page.getByRole("menuitem", { name: /pin to dashboard/i }).click();
      await openCardMenu(page);
      await page.getByRole("menuitem", { name: /unpin/i }).click();
    },
    oracle: async (page) => {
      await openCardMenu(page);
      const items = await page.getByRole("menuitem").allTextContents();
      await page.keyboard.press("Escape");
      return { menu: items.map((s) => s.trim()).filter((s) => /pin/i.test(s)) };
    },
  },
  // (3) the reader view's text style menu: "+" on the font size three times in a row (the menu stays open)
  "font-size": {
    path: `/preserved/${LINK}?format=3`,
    ready: async (page) => textStyleTrigger(page).waitFor({ timeout: 60_000 }),
    steps: async (page) => {
      await textStyleTrigger(page).click();
      const plus = fontRow(page).locator("button").nth(1);
      await plus.click();
      await plus.click();
      await plus.click();
    },
    oracle: async (page) => ({ fontSize: (await fontRow(page).locator("p").last().textContent({ timeout: 2000 }).catch(() => null))?.trim() ?? null }),
  },
  // (4) the reader view's light/dark switch, clicked twice (light → dark → light)
  "theme-twice": {
    path: `/preserved/${LINK}?format=3`,
    ready: async (page) => page.locator("input.theme-controller").first().waitFor({ state: "attached", timeout: 60_000 }),
    steps: async (page) => {
      const sw = page.locator("label:has(input.theme-controller)").first();
      await sw.click();
      await sw.click();
    },
    oracle: async (page) => ({
      dataTheme: await page.evaluate(() => document.documentElement.getAttribute("data-theme")),
      switchChecked: await page.locator("input.theme-controller").first().isChecked(),
    }),
  },
};

async function openCardMenu(page) {
  // the "More" (three dots) button of the first card. A menu that is still closing (Radix animates it out after an
  // item is picked) takes the next click without opening a new one, so wait until it is gone, and click again if the
  // menu did not open (the first pin-unpin sweep timed out here on 22 of 24 loads before this wait existed)
  const menu = page.getByRole("menu").first();
  await menu.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  const more = page.locator("i[title=More]").first();
  for (let attempt = 0; attempt < 3; attempt++) {
    await more.click();
    if (await menu.waitFor({ timeout: 3_000 }).then(() => true, () => false)) return;
  }
  throw new Error("the card menu did not open");
}
async function cardTitles(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length) continue;
      const t = (el.textContent ?? "").trim();
      if (/^(hotel article 119|renamed during a poll|golf article 118)$/.test(t)) out.push(t);
    }
    return out.slice(0, 6);
  });
}
/** The reader view's text style menu trigger (the "T" icon in its navbar). */
const textStyleTrigger = (page) => page.locator("button[aria-haspopup=menu]:has(i.bi-type)").first();
/** The menu's font size row: its label, the size shown, and the "-" and "+" buttons. */
const fontRow = (page) => page.getByRole("menu").locator("div:has(> div > p)").filter({ hasText: /font size/i }).first();

// --------------------------------------------------------------------------- one page load (one run)
async function load(browser, bridgeUrl, scenario, i) {
  reset();
  const { ctx, page, log } = await newPage(browser, bridgeUrl);
  const t0 = Date.now();
  const out = { i, log };
  try {
    await page.goto(APP + scenario.path);
    await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 60_000 });
    out.schedule = await page.evaluate(() => window.__GENCLASS_AGENT__.schedule);
    out.run = await page.evaluate(() => window.__GENCLASS_AGENT__.run);
    out.t = { connected: Date.now() - t0 };
    await scenario.ready(page);
    await settle(page, 30_000);
    out.t.ready = Date.now() - t0;
    await scenario.steps(page, i);
    out.t.steps = Date.now() - t0;
    out.settled = await settle(page);
    out.t.settled = Date.now() - t0;
    out.oracle = await scenario.oracle(page);
    out.server = serverState();
    out.snapshot = await page.evaluate(() => {
      const s = window.__GENCLASS_AGENT__.snapshot();
      const rec = window.__GENCLASS_AGENT__.recorded();
      return {
        stateFields: Object.keys(s.state).length,
        stores: [...new Set(Object.keys(s.state).map((k) => k.split(".")[0]))].slice(0, 60),
        requests: s.requests,
        witnesses: window.__GENCLASS_AGENT__.witnesses().map((w) => `${w.kind} ${w.subject} by ${w.by}`),
        errors: s.errors,
        forced: s.forced,
        acts: rec.steps.filter((x) => x.k === "act").map((a) => `${a.kind} ${a.target ?? ""}${a.value !== undefined ? ` = ${a.value}` : ""}${a.clicks > 1 ? ` x${a.clicks}` : ""}`),
        sends: rec.steps.filter((x) => x.k === "send").length,
        order: rec.order,
      };
    });
    await page.waitForTimeout(600); // the last batch and the end reach the bridge
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 2000);
  }
  out.ms = Date.now() - t0;
  await ctx.close();
  return out;
}
const summary = (l) =>
  `load ${l.i}: ${l.schedule ? `${l.schedule.order}${l.schedule.seed !== undefined ? ` seed ${l.schedule.seed}` : ""}` : "no schedule"} settled=${l.settled} acts=${l.snapshot?.acts?.length} sends=${l.snapshot?.sends} witnesses=${l.snapshot?.witnesses?.length} forced=${l.snapshot?.forced} state=${l.snapshot?.stateFields} oracle=${JSON.stringify(l.oracle)} server=${JSON.stringify(l.server)} ${l.ms} ms${l.error ? ` ERROR ${l.error.slice(0, 300)}` : ""}${l.log?.length ? ` log=${JSON.stringify(l.log.slice(0, 3))}` : ""}`;

// --------------------------------------------------------------------------- the DOM and server oracle (secondary)
function compareOracles(loads) {
  const key = (l) => JSON.stringify({ oracle: l.oracle ?? null, server: l.server ?? null });
  const fifo = loads.filter((l) => l.schedule?.order === "fifo");
  const seeded = loads.filter((l) => l.schedule?.order === "seeded");
  const baseKeys = new Set(fifo.map(key));
  return {
    baselines: fifo.length,
    baselinesAgree: baseKeys.size <= 1,
    seeded: seeded.length,
    seededDiffering: seeded.filter((l) => !baseKeys.has(key(l))).map((l) => ({ i: l.i, seed: l.schedule?.seed, oracle: l.oracle, server: l.server })),
  };
}

// --------------------------------------------------------------------------- commands
const cmd = process.argv[2];
// --no-proxy-server: the container's HTTPS proxy must not see localhost. The Local Network Access checks are off
// because a document Playwright fulfilled has no address space of its own, so Chromium would refuse the page's
// requests to the loopback bridge (the Strapi hunt hit it; a developer's own page, served from localhost, is not).
const browser = await chromium.launch({ args: ["--no-proxy-server", "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers"] });

if (cmd === "probe") {
  const bridgeUrl = await startServer();
  reset();
  const { ctx, page, log } = await newPage(browser, bridgeUrl);
  await page.goto(APP + (process.argv[3] ?? "/links"));
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 90_000 }).catch((e) => console.log("not connected:", e.message));
  await page.waitForTimeout(Number(process.argv[4] ?? 4000));
  if (process.argv[5]) for (const html of await page.locator(process.argv[5]).evaluateAll((els) => els.map((e) => e.outerHTML.slice(0, 3000)))) console.log(html);
  else console.log(await page.locator("body").ariaSnapshot());
  console.log(await page.evaluate(() => JSON.stringify({ conn: window.__GENCLASS_AGENT__?.connected, run: window.__GENCLASS_AGENT__?.run, schedule: window.__GENCLASS_AGENT__?.schedule, stores: [...new Set(Object.keys(window.__GENCLASS_AGENT__?.snapshot().state ?? {}).map((k) => k.split(".").slice(0, 2).join(".")))].slice(0, 80) })));
  console.log(await tool("genclass_status"));
  console.log(log.join("\n"));
  await ctx.close();
} else if (cmd === "once") {
  const scenario = SCENARIOS[process.argv[3]];
  if (!scenario) throw new Error(`unknown scenario; one of ${Object.keys(SCENARIOS).join(", ")}`);
  const bridgeUrl = await startServer();
  const l = await load(browser, bridgeUrl, scenario, 0);
  console.log(summary(l));
  console.log(JSON.stringify({ oracle: l.oracle, server: l.server, acts: l.snapshot?.acts, requests: l.snapshot?.requests, order: l.snapshot?.order, witnesses: l.snapshot?.witnesses, stores: l.snapshot?.stores, log: l.log, error: l.error }, null, 1));
} else if (cmd === "explore") {
  const name = process.argv[3];
  const slow = Number(process.argv[4] ?? 600);
  const runs = Number(process.argv[5] ?? 6);
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}; one of ${Object.keys(SCENARIOS).join(", ")}`);
  const bridgeUrl = await startServer();
  await tool("genclass_clear", { what: "all" }).catch(() => {});
  const result = { scenario: name, slow_ms: slow, runs, variant: process.env.HUNT_TAG ?? "unfixed", startedAt: new Date().toISOString(), loads: [] };
  const seed = Number(process.env.HUNT_SEED ?? 1);
  result.seed = seed;
  result.start = await tool("genclass_explore", { action: "start", runs, slow_ms: slow, seed });
  console.log(result.start.split("\n")[0]);
  for (let i = 0; i < runs + 2; i++) {
    const l = await load(browser, bridgeUrl, scenario, i);
    result.loads.push(l);
    console.log(summary(l));
    if (i === 0) result.status = await tool("genclass_status");
  }
  result.report = await tool("genclass_explore", { action: "report" });
  console.log(result.report);
  result.oracle = compareOracles(result.loads);
  console.log("DOM+server oracle (secondary):", JSON.stringify({ ...result.oracle, seededDiffering: result.oracle.seededDiffering.map((d) => `${d.i} (seed ${d.seed})`) }));
  const fids = [...new Set([...result.report.matchAll(/\b(f\d+)\b/g)].map((m) => m[1]))];
  result.findings = await tool("genclass_findings", { limit: 20 });
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
  const file = join(OUT, `${name}-${slow}${seed !== 1 ? `-s${seed}` : ""}${process.env.HUNT_TAG ? `-${process.env.HUNT_TAG}` : ""}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log("wrote", file);
} else if (cmd === "replay") {
  const scenario = SCENARIOS[process.argv[3]];
  const fid = process.argv[4];
  const bridgeUrl = await startServer();
  console.log(await tool("genclass_replay", { action: "arm", id: fid }));
  const l = await load(browser, bridgeUrl, scenario, 99);
  console.log(summary(l));
  console.log(await tool("genclass_replay", { action: "result", id: fid }));
} else if (cmd === "explain") {
  await startServer();
  console.log(await tool("genclass_explain", { id: process.argv[3] }));
} else {
  console.log("usage: hunt.mjs probe <path> | once <scenario> | explore <scenario> <slow_ms> [runs] | replay <scenario> <id> | explain <id>");
}
await browser.close();
if (served) await served.close();
process.exit(0);
