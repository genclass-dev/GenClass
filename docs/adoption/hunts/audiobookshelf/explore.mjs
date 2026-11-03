// Race hunt harness for Audiobookshelf (docs/adoption/hunts/audiobookshelf.md). Not part of CI; run by hand against a
// local Audiobookshelf (`npm run dev`, seeded with seed.sh and a root user; see the report).
//
//   node docs/adoption/hunts/audiobookshelf/explore.mjs --surface search|sort|edit [--slow 300,600,900] [--runs 6] [--out <dir>]
//
// GenClass is injected from outside, the Gitea harness pattern (../gitea-explore.mjs): a Playwright route rewrites the
// web client's HTML document to load the script-tag build (packages/runtime/dist/genclass.global.js) from a virtual
// same-origin path, started with the model skipped and telemetry off, then connects the coding-agent link
// (dist/agent.js) to the MCP bridge started in this process (packages/mcp/dist). Audiobookshelf's client is Nuxt 2 /
// Vue 2 with a Vuex store GenClass does not discover, so the injected script mirrors the regions under test with
// rt.atom() from a MutationObserver: the global search menu's text, the first 24 bookshelf cards' titles (read from the
// cards' Vue instances), and the edit modal's title and subtitle fields.
//
// Surfaces (--surface), each the same steps every load:
//   search  library home page; type "Har" in the global search, wait 800 ms (the search box's debounce is 750 ms), type
//           "Harmony"; oracle: every book in the menu has "Harmony" in its title
//   sort    bookshelf page; open the sort menu and pick "Title", then at once open it again and pick "Author (Last, First)"
//           (each pick re-fetches the bookshelf: GET /api/libraries/:id/items?sort=...); oracle: the shown cards are
//           in the order the API gives for the final sort
//   edit    an item page; Edit, Details tab, type a title, click Save (PATCH), type a subtitle at once, read both fields
//           after settling (the save's own item_updated socket message re-initialises the form: the #2231 path)
// For each --slow value it runs one explore session: 2 fifo baselines + --runs seeded loads.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { parseArgs } from "node:util";
import { ABS, WEB, api, chromium, loginState } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const rtDist = join(root, "packages/runtime/dist");
const { serve } = await import(join(root, "packages/mcp/dist/index.js"));

const { values: arg } = parseArgs({
  options: {
    surface: { type: "string", default: "search" },
    slow: { type: "string", default: "300,600,900" },
    runs: { type: "string", default: "6" },
    out: { type: "string", default: "" },
    genclass: { type: "string", default: process.env.GENCLASS ?? "1" },
  },
});
const withGenClass = arg.genclass !== "0";
const TYPES = { ".js": "text/javascript", ".map": "application/json" };

// --------------------------------------------------------------------------- what the route injects into <head>
const INJECT = `<script src="/__genclass/rt/genclass.global.js" data-manual data-base="/__genclass/rt/"></script>
<script>window.__gcRt = window.GenClass.init({ model: false, telemetry: false, report: "silent" });</script>
<script type="module">
import { connectAgent } from "/__genclass/rt/agent.js";
const rt = window.__gcRt;
connectAgent(rt);
// Audiobookshelf's Vuex store is not discovered: mirror what the regions under test show.
const atoms = { search: rt.atom("search", { text: "" }), shelf: rt.atom("shelf", { titles: "" }), edit: rt.atom("edit", { title: "", subtitle: "" }) };
const read = () => {
  const menu = document.querySelector(".globalSearchMenu");
  const text = menu && menu.offsetParent !== null ? (menu.textContent || "").replace(/\\s+/g, " ").trim() : "";
  if (atoms.search.get().text !== text) atoms.search.set({ text });
  const titles = [];
  for (let i = 0; i < 24; i++) {
    const el = document.getElementById("book-card-" + i);
    const t = el && el.__vue__ && el.__vue__.libraryItem && el.__vue__.libraryItem.media && el.__vue__.libraryItem.media.metadata ? el.__vue__.libraryItem.media.metadata.title : null;
    titles.push(t || "-");
  }
  const joined = titles.join("|");
  if (atoms.shelf.get().titles !== joined) atoms.shelf.set({ titles: joined });
  const ti = document.querySelector('input[placeholder="Title"]');
  const st = document.querySelector('input[placeholder="Subtitle"]');
  const e = { title: ti ? ti.value : "", subtitle: st ? st.value : "" };
  const cur = atoms.edit.get();
  if (cur.title !== e.title || cur.subtitle !== e.subtitle) atoms.edit.set(e);
};
new MutationObserver(read).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
document.addEventListener("input", read, true);
</script>
`;

async function route(page) {
  await page.route(`${ABS}/**`, async (r) => {
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
const served = withGenClass ? await serve({ cwd: here, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: null }) : null;
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
if (withGenClass) {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "abs-hunt", version: "1" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
}
const bridgeUrl = served ? `http://127.0.0.1:${served.port}` : null;

// --------------------------------------------------------------------------- data for the oracles
const a = await api();
const lib = await a.library();
const editItem = await a.itemByTitle(lib.id, "Silver Gate");
const authorSorted = await a.get(`/api/libraries/${lib.id}/items?sort=media.metadata.authorNameLF&desc=0&limit=24&page=0&minified=1`);
const expectedShelf = authorSorted.results.map((i) => i.media.metadata.title);

// --------------------------------------------------------------------------- the scenarios (what a person does)
const surfaces = {
  async search(page) {
    await page.goto(`${WEB}/library/${lib.id}`);
    await ready(page);
    const box = page.locator('input[placeholder="Search.."]:visible').first();
    await box.click();
    await box.pressSequentially("Har", { delay: 40 });
    await page.waitForTimeout(800);
    await box.pressSequentially("mony", { delay: 40 });
    await page.waitForTimeout(800); // the debounce fires the second search
    await settle(page);
    const books = await page.locator(".globalSearchMenu li[role=option]").allInnerTexts();
    const shown = books.map((t) => t.split("\n")[0].trim()).filter(Boolean);
    const stale = shown.filter((t) => !/harmony/i.test(t) && !/^Author/.test(t));
    return { shown: shown.join(" | "), oracle: stale.length ? `STALE (${stale.join(", ")})` : "ok" };
  },
  async sort(page) {
    await page.goto(`${WEB}/library/${lib.id}/bookshelf`);
    await ready(page);
    await page.locator("#book-card-0").waitFor();
    const toggle = page.locator("div:has(> ul.librarySortMenu) > button");
    await toggle.click();
    await page.locator("ul.librarySortMenu li[role=menuitem]", { hasText: /^\s*Title\s*$/ }).click();
    await toggle.click();
    await page.locator("ul.librarySortMenu li[role=menuitem]", { hasText: "Author (Last, First)" }).click();
    await page.waitForTimeout(300);
    await settle(page);
    await page.waitForTimeout(300);
    const titles = await page.evaluate(() => {
      const out = [];
      for (let i = 0; i < 24; i++) {
        const el = document.getElementById("book-card-" + i);
        const li = el && el.__vue__ && el.__vue__.libraryItem;
        if (li) out.push(li.media.metadata.title);
      }
      return out;
    });
    const n = titles.length;
    const ok = n > 0 && titles.every((t, i) => t === expectedShelf[i]);
    return { shown: `${n} cards: ${titles.slice(0, 4).join(" | ")}...`, oracle: ok ? "ok" : `WRONG ORDER (expected ${expectedShelf.slice(0, 4).join(" | ")}...)` };
  },
  async edit(page) {
    // the same steps every load: the server copy is reset to the seed's title and an empty subtitle first
    await a.patch(`/api/items/${editItem.id}/media`, { metadata: { title: "Silver Gate", subtitle: null } });
    await page.goto(`${WEB}/item/${editItem.id}`);
    await ready(page);
    await page.locator('button[aria-label="Edit"]:visible').first().click();
    await page.getByRole("tab", { name: "Details" }).click();
    const title = page.locator('input[placeholder="Title"]');
    const subtitle = page.locator('input[placeholder="Subtitle"]');
    await title.waitFor();
    const t = "Silver Gate Revised";
    const s = "a subtitle typed after saving";
    await title.fill(t);
    await page.getByRole("button", { name: "Save", exact: true }).first().click();
    await subtitle.fill(s);
    await page.waitForTimeout(1500);
    await settle(page);
    const tv = await title.inputValue();
    const sv = await subtitle.inputValue();
    return { shown: `title="${tv}" subtitle="${sv}"`, oracle: sv === s && tv === t ? "ok" : "SUBTITLE WIPED" };
  },
};

async function ready(page) {
  if (withGenClass) await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
  else await page.waitForTimeout(500);
}
async function settle(page) {
  if (withGenClass) await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000));
  else await page.waitForLoadState("networkidle");
}

const browser = await chromium.launch();
const storageState = await loginState(browser);

async function scenario(fn) {
  const ctx = await browser.newContext({ storageState, permissions: ["local-network-access"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (withGenClass) {
    await page.addInitScript((u) => (window.__GENCLASS_AGENT_URL__ = u), bridgeUrl);
    await route(page);
  }
  let res;
  try {
    res = await fn(page);
  } catch (e) {
    res = { shown: `ERROR ${String(e).split("\n")[0]}`, oracle: "error" };
  }
  const order = withGenClass
    ? await page
        .evaluate(() => window.__GENCLASS_AGENT__.recorded().order.filter((k) => /search|items\?|\/media/.test(k)).map((k) => k.replace(/^.*\/api\//, "").slice(0, 60)))
        .catch(() => [])
    : [];
  await page.waitForTimeout(500);
  await ctx.close();
  const line = `${res.shown} [oracle ${res.oracle}]${withGenClass ? ` [delivered ${order.join(" then ") || "none"}]` : ""}`;
  return { line: errors.length ? `${line} [pageerror: ${errors[0]}]` : line, oracle: res.oracle };
}

const fn = surfaces[arg.surface];
if (!fn) throw new Error(`unknown surface ${arg.surface}`);
const out = arg.out ? resolve(arg.out) : null;
if (out) mkdirSync(out, { recursive: true });
const summary = { surface: arg.surface, genclass: withGenClass, runs: Number(arg.runs), sessions: [] };
for (const slow of arg.slow.split(",").map(Number)) {
  let started = "";
  if (withGenClass) {
    await tool("genclass_clear", { what: "all" });
    started = await tool("genclass_explore", { action: "start", runs: Number(arg.runs), slow_ms: slow });
  }
  const shown = [];
  for (let i = 0; i < Number(arg.runs) + 2; i++) shown.push(await scenario(fn));
  let report = "(no GenClass)";
  let explain = null;
  let findings = "";
  if (withGenClass) {
    report = await tool("genclass_explore", { action: "report" });
    const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1];
    explain = fid ? await tool("genclass_explain", { id: fid }) : null;
    findings = await tool("genclass_findings");
  }
  const verdict = /RACE: (\d+) of (\d+)/.exec(report);
  const bad = shown.filter((s) => s.oracle !== "ok").length;
  summary.sessions.push({ slow_ms: slow, verdict: withGenClass ? (verdict ? `race in ${verdict[1]} of ${verdict[2]}` : "no race") : "n/a", oracleNotOk: `${bad} of ${shown.length}`, shown: shown.map((s) => s.line) });
  if (out) writeFileSync(join(out, `${arg.surface}-${slow}${withGenClass ? "" : "-nogc"}.txt`), [started, "", ...shown.map((s, i) => `load ${i + 1}: ${s.line}`), "", report, "", findings, "", explain ?? ""].join("\n"));
  console.log(`--- ${arg.surface} slow_ms=${slow}\n${shown.map((s, i) => `load ${i + 1}: ${s.line}`).join("\n")}\n${report}\n`);
}
await browser.close();
if (served) await served.close();
console.log(JSON.stringify(summary, null, 2));
if (out) writeFileSync(join(out, `${arg.surface}-summary${withGenClass ? "" : "-nogc"}.json`), JSON.stringify(summary, null, 2));
process.exit(0);
