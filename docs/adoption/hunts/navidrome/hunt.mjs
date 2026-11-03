// The GenClass race hunt on Navidrome's web UI (docs/adoption/hunts/navidrome.md). Not part of CI.
//
// It drives a locally running Navidrome (`make dev`: Vite on http://localhost:4533 proxying to the Go server) in
// headless Chromium with the real @genclass/runtime script-tag build and the agent entry injected into the UI's HTML by
// Playwright (Navidrome's source is untouched), the real @genclass/mcp server in-process (its bridge on a free port),
// and the same tool calls a coding agent makes: genclass_explore start -> one page load per armed run -> report ->
// genclass_explain -> genclass_replay.
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp       # in GenClass-lib
//   node docs/adoption/hunts/navidrome/hunt.mjs seed                           # once: the hunt playlist
//   node docs/adoption/hunts/navidrome/hunt.mjs once <scenario>                # one natural load, the recording printed
//   node docs/adoption/hunts/navidrome/hunt.mjs explore <scenario> <slow_ms> [runs]
//   node docs/adoption/hunts/navidrome/hunt.mjs replay <scenario> <finding id>
//
// Env: ND_URL (default http://localhost:4533), ND_USER / ND_PASSWORD (admin / password, DevAutoCreateAdminPassword),
// HUNT_OUT (raw output, default ~/targets/nd-hunt/out: outside this checkout), HUNT_STATE (bridge state dir name),
// HUNT_MIRROR=1 (the text mirror of the stars and hearts, below), HUNT_VARIANT (a label in the output file name, e.g. fixed).
//
// Every run resets what the scenario touches through the server's own APIs before its page load (the song's rating,
// its star, the playlist's order), so each run starts from the same data. Besides the explore verdict, each run records
// a DOM oracle of its own (what the rows show next to what the server has, read after the page settled): a secondary
// oracle, labelled as such in the report.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { chromium } from "@playwright/test";
import { serve } from "../../../../packages/mcp/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const rtDist = join(repo, "packages/runtime/dist");
const APP = (process.env.ND_URL ?? "http://localhost:4533").replace(/\/+$/, "");
const USER = process.env.ND_USER ?? "admin";
const PASSWORD = process.env.ND_PASSWORD ?? "password";
const OUT = process.env.HUNT_OUT ?? join(homedir(), "targets/nd-hunt/out");
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".map": "application/json", ".wasm": "application/wasm" };
const PLAYLIST = "GenClass hunt playlist";
mkdirSync(OUT, { recursive: true });

// --------------------------------------------------------------------------- the server's APIs (setup and oracles)
let auth = null;
async function login() {
  const r = await fetch(`${APP}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login: HTTP ${r.status}`);
  auth = await r.json();
  return auth;
}
async function api(path, init = {}) {
  const r = await fetch(`${APP}/api/${path}`, { ...init, headers: { "content-type": "application/json", "x-nd-authorization": `Bearer ${auth.token}`, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`/api/${path}: HTTP ${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function rest(view, params) {
  const q = new URLSearchParams({ u: auth.username, t: auth.subsonicToken, s: auth.subsonicSalt, v: "1.16.1", c: "genclass-hunt", f: "json", ...params });
  const r = await fetch(`${APP}/rest/${view}?${q}`);
  const j = await r.json();
  if (j["subsonic-response"]?.status !== "ok") throw new Error(`/rest/${view}: ${JSON.stringify(j).slice(0, 200)}`);
  return j["subsonic-response"];
}
/** The first song of the Songs list in its default order (title ascending), which every song scenario acts on. */
async function firstSong() {
  const list = await api("song?_start=0&_end=1&_sort=title&_order=ASC");
  return list[0];
}
async function playlistId() {
  const all = await api("playlist?_start=0&_end=100&_sort=name&_order=ASC");
  return all.find((p) => p.name === PLAYLIST)?.id;
}
async function playlistTitles(id) {
  const t = await api(`playlist/${id}/tracks?_start=0&_end=100&_sort=id&_order=ASC&playlist_id=${id}`);
  return t.map((x) => x.title);
}
async function seed() {
  await login();
  let id = await playlistId();
  if (!id) {
    const p = await api("playlist", { method: "POST", body: JSON.stringify({ name: PLAYLIST, public: false }) });
    id = p.id;
  }
  const songs = await api("song?_start=0&_end=8&_sort=title&_order=ASC");
  const existing = await api(`playlist/${id}/tracks?_start=0&_end=100&playlist_id=${id}`);
  if (existing.length) await api(`playlist/${id}/tracks?${existing.map((t) => `id=${t.id}`).join("&")}`, { method: "DELETE" });
  await api(`playlist/${id}/tracks`, { method: "POST", body: JSON.stringify({ ids: songs.map((s) => s.id) }) });
  return { id, titles: await playlistTitles(id) };
}

// --------------------------------------------------------------------------- the MCP server, driven like an agent
let served = null;
let input;
let rpcId = 0;
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
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "navidrome-hunt", version: "1" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return `http://127.0.0.1:${served.port}`;
}
async function rpc(method, params = {}) {
  const my = ++rpcId;
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
  for (let i = 0; i < 3000; i++) {
    const m = lines.find((x) => x.id === my);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no reply to ${method}`);
}
const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;

// --------------------------------------------------------------------------- injection (Navidrome's files untouched)
function tags(bridgeUrl) {
  // observe mode, no model (explore needs none), no telemetry, no visual checks; automatic state discovery (React,
  // Redux: react-admin's store) is on by default in the script-tag build and installs before react-dom evaluates
  const cfg = { telemetry: false, mode: "observe", model: false, visual: false, devtools: false, report: "console" };
  return (
    `<script>window.GENCLASS_CONFIG=${JSON.stringify(cfg)};window.__GENCLASS_AGENT_URL__=${JSON.stringify(bridgeUrl)};</script>` +
    `<script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script>` +
    `<script type="module">import{connectAgent}from"/__genclass/agent.js";window.__GENCLASS_CONN__=connectAgent(window.GenClass.runtime,{url:${JSON.stringify(bridgeUrl)}});</script>` +
    (MIRROR ? `<script>(${mirror.toString()})()</script>` : "")
  );
}
// HUNT_MIRROR=1: a text mirror of what the first rows paint (stars, hearts) in a small fixed line at the bottom of the
// page, so explore's page-text comparison can see icon-only state (report section 6, item 1). Words, not digits: the
// comparison blanks tokens holding a digit when baselines differ in them. A harness aid, never in Navidrome's code.
const MIRROR = process.env.HUNT_MIRROR === "1";
function mirror() {
  const words = ["zero", "one", "two", "three", "four", "five"];
  const m = document.createElement("div");
  m.id = "gc-mirror";
  m.setAttribute("style", "position:fixed;bottom:0;left:0;z-index:99999;font:10px sans-serif;background:#fff;color:#000");
  const read = () => {
    if (!m.isConnected && document.body) document.body.appendChild(m);
    const rows = [...document.querySelectorAll("tbody tr")].slice(0, 2);
    const t = rows
      .map((r) => {
        const stars = r.querySelector(".MuiRating-root")?.querySelectorAll(".MuiRating-iconFilled").length;
        const heart = r.querySelector('button[class*="NDLoveButton-love"] path[d^="M12 21.35"]') ? "loved" : "not loved";
        return `row stars ${words[stars] ?? "none"} ${heart}`;
      })
      .join(" / ");
    if (m.textContent !== t) m.textContent = t;
  };
  new MutationObserver(read).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "d"] });
}
async function newPage(browser, bridgeUrl) {
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1400, height: 900 }, permissions: ["local-network-access"] });
  // hermetic: nothing but the local server and the bridge
  await ctx.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => route.abort());
  await ctx.route("**/__genclass/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/__genclass\//, "");
    const file = resolve(rtDist, p);
    if (!file.startsWith(rtDist) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  if (bridgeUrl) {
    await ctx.route(`${APP}/`, async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const res = await route.fetch();
      const html = await res.text();
      return route.fulfill({ response: res, body: html.replace(/<head>/i, `<head>${tags(bridgeUrl)}`) });
    });
  }
  // the session the UI keeps in localStorage (authProvider.js), so every load starts logged in
  await ctx.addInitScript((a) => {
    if (localStorage.getItem("token")) return;
    localStorage.setItem("token", a.token);
    localStorage.setItem("userId", a.id);
    localStorage.setItem("name", a.name);
    localStorage.setItem("username", a.username);
    localStorage.setItem("role", a.isAdmin ? "admin" : "regular");
    localStorage.setItem("subsonic-salt", a.subsonicSalt);
    localStorage.setItem("subsonic-token", a.subsonicToken);
    localStorage.setItem("is-authenticated", "true");
  }, auth);
  const page = await ctx.newPage();
  const log = [];
  page.on("console", (m) => {
    const t = m.type();
    const text = m.text();
    if (t === "error" || /genclass/i.test(text)) log.push(`${t}: ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => log.push(`pageerror: ${String(e.message ?? e).slice(0, 300)}`));
  return { ctx, page, log };
}
const settle = (page, ms = 20_000) => page.evaluate((t) => window.__GENCLASS_AGENT__?.whenSettled(t) ?? null, ms);

// --------------------------------------------------------------------------- oracles (read after the page settled)
const HEART_FILLED = "M12 21.35"; // @material-ui/icons Favorite; FavoriteBorder starts "M16.5 3c-1.74"
/** The stars a song's Rating paints, blurred and with the mouse away (a focused MUI Rating paints its focused star). */
async function shownStars(page, id) {
  await page.mouse.move(2, 2);
  return page.evaluate((id) => {
    document.activeElement?.blur?.();
    const root = document.querySelector(`input[type="radio"][name="${id}"]`)?.closest(".MuiRating-root");
    return root ? root.querySelectorAll(".MuiRating-iconFilled").length : null;
  }, id);
}
const hearts = (page) =>
  page.evaluate((filled) => {
    const state = (b) => (b ? (b.querySelector(`path[d^="${filled}"]`) ? "loved" : "not loved") : "absent");
    const row = document.querySelector('tbody tr button[class*="NDLoveButton-love"]');
    const bar = document.querySelector('li.item button[class*="NDLoveButton-love"]'); // PlayerToolbar.jsx, desktop
    return { row: state(row), player: state(bar) };
  }, HEART_FILLED);
const titles = (page) => page.locator("tbody tr td.column-title").allTextContents();

// --------------------------------------------------------------------------- scenarios
// Each: reset() through the server's APIs (before the load), path, ready(page), steps(page), oracle(page) -> object.
// `ok(o)` says whether the oracle's page agrees with the server (the secondary oracle's verdict for one run).
const song = { id: null, title: null };
async function songRow(page) {
  const row = page.locator("tbody tr", { has: page.locator(`input[type="radio"][name="${song.id}"]`) });
  await row.waitFor({ timeout: 30_000 });
  return row;
}
/** The mouse leaves the stars and the focus leaves the radio (a focused MUI Rating paints its focused star). */
async function looseFocus(page) {
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.activeElement?.blur?.());
}
const SCENARIOS = {
  // (1) rate a song 3 stars, then 5 once the UI's refresh after the first rating has been answered (a person
  // correcting a rating on a link where that refresh is slow to arrive)
  rate: {
    async reset() {
      Object.assign(song, await firstSong());
      await rest("setRating", { id: song.id, rating: "1" }); // rated: the Rating is controlled (report section 5)
    },
    path: "/#/song",
    ready: songRow,
    async steps(page) {
      const row = await songRow(page);
      const refreshed = page.waitForResponse((r) => r.url().endsWith(`/api/song/${song.id}`), { timeout: 15_000 });
      await row.hover();
      await row.locator(`label[for="${song.id}-3"]`).click();
      await refreshed; // the server has answered the refresh (rating 3); the app may not have it yet
      await row.locator(`label[for="${song.id}-5"]`).click();
      await looseFocus(page);
    },
    async oracle(page) {
      return { shown: await shownStars(page, song.id), server: (await api(`song/${song.id}`)).rating ?? 0 };
    },
    ok: (o) => o.shown === o.server,
  },
  // (1') the same two ratings back to back
  "rate-fast": {
    reset: async () => SCENARIOS.rate.reset(),
    path: "/#/song",
    ready: songRow,
    async steps(page) {
      const row = await songRow(page);
      await row.hover();
      await row.locator(`label[for="${song.id}-3"]`).click();
      await row.locator(`label[for="${song.id}-5"]`).click();
      await looseFocus(page);
    },
    oracle: async (page) => SCENARIOS.rate.oracle(page),
    ok: (o) => o.shown === o.server,
  },
  // (3) love one song from the list row, then from the player bar while the first request is in flight
  love: {
    async reset() {
      Object.assign(song, await firstSong());
      await rest("unstar", { id: song.id });
    },
    path: "/#/song",
    async ready(page) {
      const row = await songRow(page);
      await row.locator("td.column-title").click(); // plays it: the player bar shows the same song
      await page.waitForFunction(() => [...document.querySelectorAll('button[class*="NDLoveButton-love"]')].some((b) => !b.closest("tr") && !b.disabled), null, { timeout: 30_000 });
    },
    async steps(page) {
      const row = await songRow(page);
      await row.hover();
      await row.locator('button[class*="NDLoveButton-love"]').click();
      // the player bar's heart, at once (its LoveButton has its own loading flag, so it is still enabled)
      await page.locator('li.item button[class*="NDLoveButton-love"]').click();
    },
    async oracle(page) {
      const h = await hearts(page);
      const s = await api(`song/${song.id}`);
      return { ...h, server: s.starred ? "loved" : "not loved" };
    },
    ok: (o) => o.row === o.server && (o.player === "absent" || o.player === o.server),
  },
  // (3, control) one click on the list row's heart while the song plays: does the player bar follow at all?
  "love-one": {
    reset: async () => SCENARIOS.love.reset(),
    path: "/#/song",
    ready: async (page) => SCENARIOS.love.ready(page),
    async steps(page) {
      const row = await songRow(page);
      await row.hover();
      await row.locator('button[class*="NDLoveButton-love"]').click();
    },
    oracle: async (page) => SCENARIOS.love.oracle(page),
    ok: (o) => SCENARIOS.love.ok(o),
  },
  // (2) drag-reorder the hunt playlist twice in a row (row 1 below row 3, then row 1 below row 3 again)
  reorder: {
    async reset() {
      await seed();
    },
    path: async () => `/#/playlist/${await playlistId()}/show`,
    async ready(page) {
      await page.locator("tbody tr td.column-title").nth(7).waitFor({ timeout: 30_000 });
    },
    async steps(page) {
      const rows = page.locator("tbody tr");
      await rows.nth(0).dragTo(rows.nth(3));
      await rows.nth(0).dragTo(rows.nth(3));
    },
    async oracle(page) {
      return { shown: await titles(page), server: await playlistTitles(await playlistId()) };
    },
    ok: (o) => JSON.stringify(o.shown) === JSON.stringify(o.server),
  },
  // (control) search-as-you-type in the Songs list: a prefix, a pause past react-admin's 500 ms filter debounce, the
  // full words; react-admin 3.19 keys list results by filter, so a late older response should not show
  search: {
    async reset() {},
    path: "/#/song",
    async ready(page) {
      await page.locator("tbody tr").first().waitFor({ timeout: 30_000 });
    },
    async steps(page) {
      const box = page.locator('input[name="title"]');
      await box.click();
      await box.pressSequentially("Track 1", { delay: 60 });
      await page.waitForTimeout(700);
      await box.pressSequentially(" of album 2", { delay: 60 });
    },
    async oracle(page) {
      await page.waitForTimeout(800); // the second debounce
      await settle(page);
      const shown = await titles(page);
      return { shown, query: await page.locator('input[name="title"]').inputValue() };
    },
    ok: (o) => o.shown.length > 0 && o.shown.every((t) => t.includes(o.query)),
  },
};

// --------------------------------------------------------------------------- one page load (one run)
async function load(browser, bridgeUrl, scenario, i) {
  await scenario.reset();
  const { ctx, page, log } = await newPage(browser, bridgeUrl);
  const t0 = Date.now();
  const out = { i, log };
  try {
    const path = typeof scenario.path === "function" ? await scenario.path() : scenario.path;
    await page.goto(APP + path);
    if (bridgeUrl) await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 60_000 });
    out.schedule = bridgeUrl ? await page.evaluate(() => window.__GENCLASS_AGENT__.schedule) : null;
    await scenario.ready(page);
    if (bridgeUrl) await settle(page); // the page's own start-up responses are done before the steps
    out.t = { ready: Date.now() - t0 };
    await scenario.steps(page, i);
    out.t.steps = Date.now() - t0;
    out.settled = bridgeUrl ? await settle(page) : (await page.waitForTimeout(3000), null);
    out.t.settled = Date.now() - t0;
    out.oracle = await scenario.oracle(page);
    out.ok = scenario.ok(out.oracle);
    if (bridgeUrl) {
      out.snapshot = await page.evaluate(() => {
        const a = window.__GENCLASS_AGENT__;
        const s = a.snapshot();
        const rec = a.recorded();
        return {
          stateFields: Object.keys(s.state).length,
          stores: [...new Set(Object.keys(s.state).map((k) => k.split(".")[0]))].slice(0, 60),
          redux: Object.keys(s.state).filter((k) => /^redux/.test(k)).length,
          songFields: Object.entries(s.state).filter(([k]) => /resources\.song/.test(k)).slice(0, 8),
          witnesses: a.witnesses().map((w) => `${w.kind} ${w.subject} by ${w.by}`),
          errors: s.errors,
          forced: s.forced,
          acts: rec.steps.filter((x) => x.k === "act").map((x) => `${x.kind} ${x.target ?? ""}${x.value !== undefined ? ` = ${x.value}` : ""}${x.clicks > 1 ? ` x${x.clicks}` : ""}`),
          order: rec.order.filter((k) => /\/(api|rest)\//.test(k) && !/getNowPlaying|keepalive/.test(k)).map((k) => k.replace(/^.*?\/(api|rest)\//, "/$1/").replace(/[?&](u|t|s|v|c|f)=[^&#]*/g, "")),
        };
      });
      await page.waitForTimeout(600); // the last batch reaches the bridge
    }
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 1500);
  }
  out.ms = Date.now() - t0;
  await ctx.close();
  return out;
}
const line = (l) =>
  `load ${l.i}: ${l.schedule ? `${l.schedule.order}${l.schedule.seed !== undefined ? ` seed ${l.schedule.seed}` : ""}` : "no schedule"} ok=${l.ok} oracle=${JSON.stringify(l.oracle)} settled=${l.settled} acts=${l.snapshot?.acts?.length} witnesses=${l.snapshot?.witnesses?.length} forced=${l.snapshot?.forced} ${l.ms} ms${l.error ? ` ERROR ${l.error.slice(0, 300)}` : ""}${l.log?.length ? ` log=${JSON.stringify(l.log.slice(0, 2))}` : ""}`;

// --------------------------------------------------------------------------- commands
const [cmd, name, a3, a4] = process.argv.slice(2);
await login();
if (cmd === "seed") {
  console.log(JSON.stringify(await seed(), null, 2));
  process.exit(0);
}
const scenario = SCENARIOS[name];
if (!scenario) throw new Error(`unknown scenario ${name}; one of ${Object.keys(SCENARIOS).join(", ")}`);
const browser = await chromium.launch();
const bridgeUrl = cmd === "plain" ? null : await startServer();

if (cmd === "plain") {
  // the scenario without GenClass (no injection, no bridge): the oracle only
  const n = Number(a3 ?? 3);
  for (let i = 0; i < n; i++) console.log(line(await load(browser, null, scenario, i + 1)));
} else if (cmd === "once") {
  const l = await load(browser, bridgeUrl, scenario, 1);
  console.log(line(l));
  console.log(JSON.stringify(l.snapshot, null, 2));
  console.log(await tool("genclass_status"));
} else if (cmd === "explore") {
  const slow = Number(a3 ?? 600);
  const runs = Number(a4 ?? 6);
  await tool("genclass_clear", { what: "all" });
  const started = await tool("genclass_explore", { action: "start", runs, slow_ms: slow });
  const loads = [];
  for (let i = 0; i < runs + 2; i++) {
    const l = await load(browser, bridgeUrl, scenario, i + 1);
    loads.push(l);
    console.log(line(l));
  }
  const report = await tool("genclass_explore", { action: "report" });
  const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1] ?? /\b(f\d+)\b/.exec(report)?.[1];
  const explain = fid ? await tool("genclass_explain", { id: fid }) : "";
  let replay = "";
  if (fid) {
    replay += `${await tool("genclass_replay", { action: "arm", id: fid })}\n`;
    const l = await load(browser, bridgeUrl, scenario, runs + 3);
    replay += `${line(l)}\n${await tool("genclass_replay", { action: "result", id: fid })}`;
  }
  const base = join(OUT, `${name}-${slow}${MIRROR ? "-mirror" : ""}${process.env.HUNT_VARIANT ? `-${process.env.HUNT_VARIANT}` : ""}`);
  writeFileSync(`${base}.txt`, [started, "", ...loads.map(line), "", report, "", explain, "", replay].join("\n"));
  writeFileSync(`${base}.json`, JSON.stringify({ scenario: name, slow_ms: slow, runs, loads, report, finding: fid ?? null, replay }, null, 2));
  console.log(`\n--- ${name} slow_ms=${slow}\n${report}\n\n${explain}\n\n${replay}`);
} else if (cmd === "replay") {
  console.log(await tool("genclass_replay", { action: "arm", id: a3 }));
  console.log(line(await load(browser, bridgeUrl, scenario, 1)));
  console.log(await tool("genclass_replay", { action: "result", id: a3 }));
} else {
  throw new Error(`unknown command ${cmd}`);
}
await browser.close();
if (served) await served.close();
process.exit(0);
