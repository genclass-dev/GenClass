// Race hunt harness for Jellyfin Web (docs/adoption/hunts/jellyfin-web.md). Not part of CI; run by hand against a
// local Jellyfin server seeded with seed.sh (admin "hunt", a Movies library of 30 local webm files).
//
//   node docs/adoption/hunts/jellyfin-web/explore.mjs --surface legacy-alpha --slow 300,600,900 [--runs 6] [--out <dir>]
//
// GenClass is injected from outside, the Gitea harness pattern (docs/adoption/hunts/gitea-explore.mjs): jellyfin-web's
// source is unchanged. A Playwright route rewrites the served /web/index.html to load the script-tag build
// (packages/runtime/dist/genclass.global.js) from a virtual same-origin path (/web/__genclass/rt/), started with the
// model skipped (model: false) and telemetry off, then connects the coding-agent link (dist/agent.js) to the MCP
// bridge started in this process (packages/mcp/dist). Most of the app is the legacy "Emby" DOM code, so the injected
// script mirrors what the page under test shows with rt.atom() from a MutationObserver: the card titles of the
// visible items grid, the selected alphabet letter, the details page's title and favourite state.
//
// Surfaces (--surface):
//   legacy-alpha    Movies tab, legacy desktop layout: click letter B, then letter C on the alphabet picker
//   legacy-sort     Movies tab, legacy layout: open Sort, pick Descending, then Ascending
//   modern-alpha    Movies, default (modern React) layout: click letter B, then letter C
//   details         legacy layout: open movie Aurora's details, then movie Bramble's right away
//   favorite        legacy layout: Bramble's details, double-click the heart (favourite) button
//   search          legacy layout: Search, type "Bra", pause 400 ms, then "mble" (debounced search-as-you-type)
// For each --slow value it runs one explore session: 2 fifo baselines + --runs seeded loads, the same steps each load.
// Each load's line ends with the delivery order of the item-list requests, as the agent link recorded it.

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
    jf: { type: "string", default: "http://127.0.0.1:8096" },
    user: { type: "string", default: "hunt" },
    password: { type: "string", default: "hunt-local-pw" },
    library: { type: "string", default: "" },
    surface: { type: "string", default: "legacy-alpha" },
    slow: { type: "string", default: "300,600,900" },
    runs: { type: "string", default: "6" },
    out: { type: "string", default: "" },
  },
});
const J = arg.jf.replace(/\/+$/, "");
const TYPES = { ".js": "text/javascript", ".map": "application/json" };
const RT = "/web/__genclass/rt/";

// --------------------------------------------------------------------------- what the route injects into <head>
const INJECT = `<script src="${RT}genclass.global.js" data-manual data-base="${RT}"></script>
<script>window.__gcRt = window.GenClass.init({ model: false, telemetry: false, report: "silent" });</script>
<script type="module">
import { connectAgent } from "${RT}agent.js";
const rt = window.__gcRt;
connectAgent(rt);
// The legacy views keep no client store: register what the page under test shows, so the verdict compares it.
const atoms = { grid: rt.atom("grid", { titles: "" }), letter: rt.atom("letter", { value: "" }), details: rt.atom("details", { title: "", favorite: "" }) };
const visible = (el) => el && !el.closest(".hide") && el.offsetParent !== null;
const read = () => {
  const grids = [...document.querySelectorAll(".itemsContainer, .MuiGrid-container, .searchResults")].filter(visible);
  const titles = grids.map((g) => [...g.querySelectorAll(".cardText-first, .cardText:first-child")].map((t) => t.textContent.trim()).join(",")).join(" | ");
  if (atoms.grid.get().titles !== titles) atoms.grid.set({ titles });
  const sel = [...document.querySelectorAll(".alphaPickerButton-selected, .alphaPicker-fixed-right .Mui-selected")].filter(visible).map((b) => b.textContent.trim()).join("");
  if (atoms.letter.get().value !== sel) atoms.letter.set({ value: sel });
  const page = [...document.querySelectorAll(".itemDetailPage")].find(visible);
  const title = page?.querySelector(".itemName.infoText, h1.itemName, .nameContainer .itemName")?.textContent.trim() ?? "";
  const fav = page?.querySelector("button.btnUserRating, .btnUserRating")?.classList.contains("ratingbutton-withrating") ? "yes" : (page ? "no" : "");
  const d = atoms.details.get();
  if (d.title !== title || d.favorite !== fav) atoms.details.set({ title, favorite: fav });
};
new MutationObserver(read).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
</script>
`;

async function route(page) {
  await page.route(`${J}/web/**`, async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith(RT)) {
      const file = join(rtDist, url.pathname.slice(RT.length));
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
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jellyfin-hunt", version: "1" } });
input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const bridgeUrl = `http://127.0.0.1:${served.port}`;

// --------------------------------------------------------------------------- server facts the steps need
const AUTH = 'MediaBrowser Client="hunt", Device="hunt", DeviceId="hunt-harness", Version="1.0.0"';
const auth = await (await fetch(`${J}/Users/AuthenticateByName`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: AUTH },
  body: JSON.stringify({ Username: arg.user, Pw: arg.password }),
})).json();
const api = async (path, init = {}) => {
  const r = await fetch(`${J}${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `${AUTH}, Token="${auth.AccessToken}"`, ...(init.headers ?? {}) } });
  return r.status === 204 ? null : r.json();
};
const userId = auth.User.Id;
const library = arg.library || (await api("/Library/VirtualFolders")).find((f) => f.Name === "Movies").ItemId;
const movies = (await api(`/Items?userId=${userId}&ParentId=${library}&IncludeItemTypes=Movie&Recursive=true&SortBy=SortName`)).Items;
const byName = Object.fromEntries(movies.map((m) => [m.Name.split(" ")[0], m.Id])); // "Aurora (1971)" -> Aurora

// --------------------------------------------------------------------------- the scenarios (what a person does)
const moviesUrl = `${J}/web/#/movies?topParentId=${library}&collectionType=movies`;
const gridTitles = (page) =>
  page.evaluate(() => {
    const vis = (el) => el && !el.closest(".hide") && el.offsetParent !== null;
    const g = [...document.querySelectorAll(".itemsContainer, .MuiGrid-container, .searchResults")].filter(vis);
    return g.map((x) => [...x.querySelectorAll(".cardText-first, .cardText:first-child")].map((t) => t.textContent.trim()).join(",")).join(" | ");
  });
const visibleOf = (page, sel) => page.locator(`${sel}:visible`).first();

const surfaces = {
  legacy: new Set(["legacy-alpha", "legacy-sort", "details", "favorite", "search"]),
  async "legacy-alpha"(page) {
    await page.goto(moviesUrl);
    await visibleOf(page, ".itemsContainer .card").waitFor();
    await connected(page);
    await visibleOf(page, '.alphaPickerButton[data-value="B"]').click();
    await visibleOf(page, '.alphaPickerButton[data-value="C"]').click();
    await settle(page);
    const letter = await page.locator(".alphaPickerButton-selected:visible").allTextContents();
    return `letter=${letter.join("")} grid=${await gridTitles(page)}`;
  },
  async "legacy-sort"(page) {
    await page.goto(moviesUrl);
    await visibleOf(page, ".itemsContainer .card").waitFor();
    await connected(page);
    await visibleOf(page, ".btnSort").click();
    await page.locator('.menuSortOrder[value="Descending"]').locator("..").click();
    await page.locator('.menuSortOrder[value="Ascending"]').locator("..").click();
    await page.keyboard.press("Escape");
    await settle(page);
    const t = (await gridTitles(page)).split(",");
    return `first=${t[0]} last=${t[t.length - 1]}`;
  },
  async "modern-alpha"(page) {
    await page.goto(moviesUrl);
    await visibleOf(page, ".card").waitFor();
    await connected(page);
    const picker = page.locator(".alphaPicker-fixed-right");
    await picker.getByRole("button", { name: "B", exact: true }).click();
    await picker.getByRole("button", { name: "C", exact: true }).click();
    await settle(page);
    const sel = await picker.locator(".Mui-selected").allTextContents();
    return `letter=${sel.join("")} grid=${await gridTitles(page)}`;
  },
  async details(page) {
    await page.goto(`${J}/web/#/details?id=${byName.Aurora}`);
    await connected(page);
    await page.waitForTimeout(50);
    await page.evaluate((id) => (location.hash = `#/details?id=${id}`), byName.Bramble);
    await settle(page);
    await page.waitForTimeout(300);
    const title = await page.locator(".itemDetailPage:visible .itemName").first().textContent().catch(() => "");
    return `title=${(title ?? "").trim()} url=${new URL(page.url()).hash}`;
  },
  async favorite(page) {
    await page.goto(`${J}/web/#/details?id=${byName.Bramble}`);
    const heart = visibleOf(page, ".itemDetailPage .btnUserRating");
    await heart.waitFor();
    await connected(page);
    await heart.dblclick();
    await settle(page);
    const shown = (await heart.getAttribute("class")).includes("ratingbutton-withrating") ? "favorite" : "not favorite";
    const server = (await api(`/Items/${byName.Bramble}?userId=${userId}`)).UserData.IsFavorite;
    // put the server back for the next load
    await api(`/UserFavoriteItems/${byName.Bramble}?userId=${userId}`, { method: "DELETE" });
    return `shown=${shown} server=${server ? "favorite" : "not favorite"}`;
  },
  async search(page) {
    await page.goto(`${J}/web/#/search`);
    const box = visibleOf(page, "input.searchfields-txtSearch, input[type=search]");
    await box.waitFor();
    await connected(page);
    await box.pressSequentially("Bra", { delay: 60 });
    await page.waitForTimeout(400);
    await box.pressSequentially("mble", { delay: 60 });
    await settle(page);
    await page.waitForTimeout(500);
    return `query=${await box.inputValue()} results=${await gridTitles(page)}`;
  },
};

async function connected(page) {
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 20_000 });
}
async function settle(page) {
  await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(20_000));
}

const browser = await chromium.launch();
// one login through the login form, reused by every page load (a fresh context per load: one explore run each)
const loginCtx = await browser.newContext();
const lp = await loginCtx.newPage();
await lp.goto(`${J}/web/`);
await lp.locator("#txtManualName").fill(arg.user);
await lp.locator("#txtManualPassword").fill(arg.password);
await lp.locator("#txtManualPassword").press("Enter");
await lp.waitForURL(/#\/home/, { timeout: 20_000 });
const storageState = await loginCtx.storageState();
await loginCtx.close();

async function scenario(fn, legacy) {
  const ctx = await browser.newContext({ storageState, permissions: ["local-network-access"], viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (process.env.HUNT_DEBUG) {
    page.on("console", (m) => console.log("[page]", m.type(), m.text()));
    page.on("requestfailed", (r) => console.log("[failed]", r.url(), r.failure()?.errorText));
  }
  await page.addInitScript(({ u, legacy }) => {
    window.__GENCLASS_AGENT_URL__ = u;
    if (legacy) localStorage.setItem("layout", "desktop-legacy");
    else localStorage.removeItem("layout");
  }, { u: bridgeUrl, legacy });
  await route(page);
  let shown;
  try {
    shown = await fn(page);
  } catch (e) {
    shown = `ERROR ${String(e).split("\n")[0]}`;
  }
  const order = await page
    .evaluate(() => window.__GENCLASS_AGENT__.recorded().order.filter((k) => /Items|Favorite|Search/i.test(k)).map((k) => k.replace(/^.*?(\/Users\/[^/]+|)\//, "/").slice(0, 90)))
    .catch(() => []);
  await page.waitForTimeout(500); // the snapshot batch reaches the bridge
  await ctx.close();
  const line = `${shown} [delivered ${order.join(" then ") || "none"}]`;
  return errors.length ? `${line} [pageerror: ${errors[0]}]` : line;
}

const fn = surfaces[arg.surface];
if (!fn) throw new Error(`unknown surface ${arg.surface}`);
const legacy = surfaces.legacy.has(arg.surface);
const out = arg.out ? resolve(arg.out) : null;
if (out) mkdirSync(out, { recursive: true });
const summary = { surface: arg.surface, jellyfin: J, runs: Number(arg.runs), sessions: [] };
for (const slow of arg.slow.split(",").map(Number)) {
  await tool("genclass_clear", { what: "all" });
  const started = await tool("genclass_explore", { action: "start", runs: Number(arg.runs), slow_ms: slow });
  const shown = [];
  for (let i = 0; i < Number(arg.runs) + 2; i++) shown.push(await scenario(fn, legacy));
  const report = await tool("genclass_explore", { action: "report" });
  const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1];
  const explain = fid ? await tool("genclass_explain", { id: fid }) : null;
  const findings = await tool("genclass_findings");
  const verdict = /RACE: (\d+) of (\d+)/.exec(report);
  summary.sessions.push({ slow_ms: slow, verdict: verdict ? `race in ${verdict[1]} of ${verdict[2]}` : "no race", finding: fid ?? null, shown });
  if (out) writeFileSync(join(out, `${arg.surface}-${slow}.txt`), [started, "", ...shown.map((s, i) => `load ${i + 1}: ${s}`), "", report, "", findings, "", explain ?? ""].join("\n"));
  console.log(`--- ${arg.surface} slow_ms=${slow}\n${shown.map((s, i) => `load ${i + 1}: ${s}`).join("\n")}\n${report}\n`);
}
await browser.close();
await served.close();
console.log(JSON.stringify(summary, null, 2));
if (out) writeFileSync(join(out, `${arg.surface}-summary.json`), JSON.stringify(summary, null, 2));
process.exit(0);
