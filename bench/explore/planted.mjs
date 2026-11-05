// The explore bench on small pages made of what the 2026-11-04 hunts met (docs/runtime/RESULTS.md, "explore's verdict on
// real apps"): each scenario has a correct variant and, where it has one, a planted bug, in headless Chromium with the
// real runtime (script-tag build, observe, no model) and the real MCP server, driven like bench/explore/apps.mjs. Every
// recorded session is scored with this checkout's comparison and, with --old, another build's, on the same runs (without
// the baseline with no added delay, which the older plan did not have). Each load's own check is `wrong`: what the page
// shows, or what the server received, against what it should be.
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
//   node bench/explore/planted.mjs <out dir> [--old <mcp dist>] [--slow 300,600,900] [--runs 6] [--only a,b] [--shard i/n] [--port 41700]
//   node bench/explore/planted.mjs <out dir> --score [--old <mcp dist>]     # the tables, from the sessions written
//
// The pages were written by the author of the rules they measure: they show the mechanism and what each rule costs, not
// an independent recall figure.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
const OUT = resolve(args[0] ?? join(here, "out-planted"));
const rtDist = resolve(opt("--rt", join(here, "../../packages/runtime/dist")));
const mcpDist = resolve(opt("--mcp", join(here, "../../packages/mcp/dist")));
const SLOW = opt("--slow", "300,600,900").split(",").map(Number);
const RUNS = Number(opt("--runs", "6"));
const ONLY = opt("--only", "") ? opt("--only", "").split(",") : null;
const [SHARD, SHARDS] = opt("--shard", "0/1").split("/").map(Number);
const PORT = Number(opt("--port", "41700"));
const cur = await import(pathToFileURL(join(mcpDist, "index.js")).href);
mkdirSync(OUT, { recursive: true });

// ----------------------------------------------------------------------------------------------- the pages' own scripts
const SEARCH = (extra = "") => `
<input id="q" aria-label="Search" autocomplete="off"><h2 id="for"></h2><ul id="results"></ul>${extra}
<script>
const BUG = location.search.includes("bug");
let token = 0;
document.getElementById("q").addEventListener("input", async (e) => {
  const q = e.target.value;
  const t = ++token;
  const d = await fetch("/api/search?q=" + encodeURIComponent(q)).then((r) => r.json());
  if (!BUG && t !== token) return; // the correct variant: only the latest question's answer
  document.getElementById("for").textContent = "Results for " + q;
  document.getElementById("results").innerHTML = d.items.map((i) => "<li>" + i + "</li>").join("");
});
window.__wrong = () => document.getElementById("for").textContent !== "Results for " + document.getElementById("q").value;
</script>`;
const typeReact = async (p) => p.getByLabel("Search").pressSequentially("react", { delay: 80 });
const saveBody = (variant) => `
<button id="save">Save order</button><p id="done"></p><ul id="rows"></ul>
<script>
const BUG = location.search.includes("bug");
const load = new URLSearchParams(location.search).get("load");
let saving = false, saved = false, sent = 0;
const post = (body) => fetch("/api/save?load=" + load, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
const shown = (d) => {
  document.getElementById("done").textContent = "Saved";
  ${variant === "shown" ? `document.getElementById("rows").innerHTML = d.rows.map((i) => "<li>Order " + i + " placed</li>").join("");` : ""}
};
document.getElementById("save").addEventListener("click", async () => {
  if (BUG ? saved : saving) return;
  saving = true; // the correct variant stops here; the planted one waits for the first answer
  ${
    {
      shown: `const d = await post({ item: "a" });`,
      silent: `const d = await post({ item: "a" });`,
      body: `const d = await post({ item: "a", at: performance.now() });`,
      chain: `await fetch("/api/token").then((r) => r.json()); const d = await post({ item: "a" });`,
      timer: `await new Promise((r) => setTimeout(r, 30)); const d = await post({ item: "a", at: performance.now() });`,
    }[variant]
  }
  saved = true;
  shown(d);
});
</script>`;
const twoClicks = async (p) => {
  await p.locator("#save").click();
  await p.waitForTimeout(120);
  await p.locator("#save").click();
};
const serverSaved = (n) => async (p) => {
  const load = new URL(p.url()).searchParams.get("load");
  return (await p.evaluate(async (l) => (await fetch("/api/saved?load=" + l)).json(), load)).n !== n;
};

/** Each scenario: the page's body, the user's steps (`i`: which load), its check, what a report should name when it has a bug. */
const SCENARIOS = {
  // a page full of relative times, on a clock that crosses a "minute" every 4 s: it never depends on the order
  times: {
    body: () => `<ul id="ages"></ul>${SEARCH()}<script>
const n = Math.floor(Date.now() / 4000) % 50 + 2;
document.getElementById("ages").innerHTML = ["Edited " + n + " minutes ago", "Updated " + n + "m ago", n % 2 ? "an hour ago" : "59 minutes ago", n % 3 ? "just now" : "a minute ago", n % 5 ? "yesterday" : "today", "Today at 3:" + (10 + n) + " PM", n + "m"].map((x) => "<li>" + x + "</li>").join("");
</script>`,
    steps: typeReact,
    names: /Results for|react/,
  },
  // read-only POSTs whose number depends on arrival order; the page shows the same
  counts: {
    bugless: true,
    body: () => `<p id="done"></p><button id="go">Go</button><script>
let a = false;
const counts = () => fetch("/api/counts", { method: "POST", body: JSON.stringify({ ids: [1, 2] }) });
fetch("/api/a").then((r) => r.json()).then(() => { a = true; counts(); document.getElementById("done").textContent = "Loaded"; });
fetch("/api/b").then((r) => r.json()).then(() => { if (!a) counts(); });
document.getElementById("go").addEventListener("click", () => fetch("/api/a").then((r) => r.json()).then(() => { if (!a) counts(); counts(); }));
</script>`,
    steps: async (p) => p.locator("#go").click(),
  },
  // double submits, each as far from the page as a real one can be
  "dbl-shown": { body: () => saveBody("shown"), steps: twoClicks, wrong: serverSaved(1), names: /Order|POST \/api\/save/, load: true },
  "dbl-silent": { body: () => saveBody("silent"), steps: twoClicks, wrong: serverSaved(1), names: /POST \/api\/save/, load: true },
  "dbl-body": { body: () => saveBody("body"), steps: twoClicks, wrong: serverSaved(1), names: /POST \/api\/save/, load: true },
  "dbl-chain": { body: () => saveBody("chain"), steps: twoClicks, wrong: serverSaved(1), names: /POST \/api\/save/, load: true },
  "dbl-timer": { body: () => saveBody("timer"), steps: twoClicks, wrong: serverSaved(1), names: /POST \/api\/save/, load: true },
  // fields named for this load only (no label), one filled from the answers in arrival order when the bug is planted
  fields: {
    body: () => `<input id="el-id-${Math.floor(Math.random() * 9000) + 1000}-32" value="unchecked"><textarea id="${randomUUID()}-input">a note</textarea>
<input id="el-id-${Math.floor(Math.random() * 9000) + 1000}-33" class="filled"><button id="go">Fill</button>
<script>
const BUG = location.search.includes("bug");
let token = 0;
const fill = async (n) => {
  const t = ++token;
  const d = await fetch("/api/defaults?n=" + n).then((r) => r.json());
  if (BUG || t === token) document.querySelector(".filled").value = d.value;
};
document.getElementById("go").addEventListener("click", () => { fill(1); fill(2); });
window.__wrong = () => document.querySelector(".filled").value !== "default two";
</script>`,
    steps: async (p) => p.locator("#go").click(),
    names: /\*|default/,
  },
  // needs only a slow response: an answer that lands while the next question is out is added to the list (Open WebUI's Notes)
  slowonly: {
    body: () => `<input id="q" aria-label="Search Notes" autocomplete="off"><ul id="results"></ul><script>
const BUG = location.search.includes("bug");
let out = 0, rows = [];
document.getElementById("q").addEventListener("input", async (e) => {
  const q = e.target.value;
  const had = out++;
  const d = await fetch("/api/notes?q=" + encodeURIComponent(q)).then((r) => r.json());
  out--;
  rows = BUG && had > 0 ? [...rows, ...d.items] : BUG ? d.items : q === document.getElementById("q").value ? d.items : rows;
  document.getElementById("results").innerHTML = [...new Set(rows)].map((i) => "<li>" + i + "</li>").join("");
});
window.__wrong = () => [...document.querySelectorAll("#results li")].some((l) => !l.textContent.startsWith(document.getElementById("q").value));
</script>`,
    steps: async (p) => p.getByLabel("Search Notes").pressSequentially("Mango", { delay: 80 }),
    names: /note/,
  },
  // needs only a slow response too: a refresh pressed while the first read is out is lost (OpenCode's file view); a bare
  // number that differs in every load sits beside it (the digit blanking used to take "version-1" with it)
  fileslow: {
    body: () => `<p id="counter">${Math.floor(Math.random() * 900) + 100}</p><button id="refresh">Refresh</button><pre id="file"></pre><script>
const BUG = location.search.includes("bug");
const load = new URLSearchParams(location.search).get("load");
let reading = 0, again = false;
const read = async () => {
  reading++;
  const d = await fetch("/api/file?load=" + load).then((r) => r.json());
  reading--;
  document.getElementById("file").textContent = d.text;
  if (again) { again = false; read(); }
};
read();
document.getElementById("refresh").addEventListener("click", () => {
  fetch("/api/bump?load=" + load, { method: "PUT" });
  if (reading) { if (!BUG) again = true; return; } // the planted bug: a refresh during a read is dropped
  read();
});
window.__wrong = () => document.getElementById("file").textContent !== "version-2";
</script>`,
    steps: async (p) => p.locator("#refresh").click(),
    settleFirst: false,
    names: /version-/,
    load: true,
  },
  // the older answer lands last, and a bare number differs between the baselines (it used to hide the version line)
  counter: {
    body: () => `<p id="counter">${Math.floor(Math.random() * 900) + 100}</p><input id="q" aria-label="Search" autocomplete="off"><pre id="file"></pre><script>
const BUG = location.search.includes("bug");
let token = 0;
document.getElementById("q").addEventListener("input", async (e) => {
  const t = ++token;
  const d = await fetch("/api/version?n=" + e.target.value.length).then((r) => r.json());
  if (BUG || t === token) document.getElementById("file").textContent = d.text;
});
window.__wrong = () => document.getElementById("file").textContent !== "version-" + document.getElementById("q").value.length;
</script>`,
    steps: async (p) => p.getByLabel("Search").pressSequentially("ab", { delay: 60 }),
    names: /version-/,
  },
  // a new path on every load (a fresh session, a new document)
  route: { body: () => SEARCH(), steps: typeReact, names: /Results for|react/, freshPath: true },
  // a dialog to dismiss in only some loads
  optional: {
    body: () => `<button id="dismiss">Dismiss</button>${SEARCH()}`,
    steps: async (p, i) => {
      if (i % 2) await p.locator("#dismiss").click();
      await typeReact(p);
    },
    names: /Results for|react/,
  },
};

// ------------------------------------------------------------------------------------------------------ the app server
const TYPES = { ".js": "text/javascript", ".map": "application/json", ".wasm": "application/wasm" };
const htmlOf = (name, bodies) => `<!doctype html><meta charset="utf-8"><title>${name}</title>
<script>window.GENCLASS_CONFIG=${JSON.stringify({ telemetry: false, mode: "observe", model: false, visual: false, devtools: false, report: "silent" })};</script>
<script src="/rt/genclass.global.js" data-base="/rt/"></script>
<script type="module">import { connectAgent } from "/rt/agent.js"; connectAgent(window.GenClass.runtime);</script>
${bodies}`;
const perLoad = new Map();
const json = (res, v, ms = 40) => setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v)), ms);
const app = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const load = url.searchParams.get("load") ?? "";
  const state = perLoad.get(load) ?? { saved: 0, version: 1 };
  perLoad.set(load, state);
  req.resume();
  switch (url.pathname) {
    case "/api/search":
      return json(res, { items: [`${url.searchParams.get("q")} one`, `${url.searchParams.get("q")} two`] });
    case "/api/notes":
      return json(res, { items: [`${url.searchParams.get("q")} note 1`, `${url.searchParams.get("q")} note 2`] });
    case "/api/a":
    case "/api/b":
    case "/api/token":
      return json(res, { ok: true });
    case "/api/counts":
      return json(res, { n: 3 });
    case "/api/save":
      state.saved++;
      return json(res, { rows: Array.from({ length: state.saved }, (_, i) => i + 1) });
    case "/api/saved":
      return json(res, { n: state.saved }, 0);
    case "/api/defaults":
      return json(res, { value: url.searchParams.get("n") === "1" ? "default one" : "default two" });
    case "/api/version":
      return json(res, { text: `version-${url.searchParams.get("n")}` });
    case "/api/file":
      return json(res, { text: `version-${state.version}` });
    case "/api/bump":
      state.version = 2;
      return json(res, { ok: true });
  }
  const m = /^\/p\/([a-z-]+)\//.exec(url.pathname);
  if (m && SCENARIOS[m[1]]) return res.writeHead(200, { "content-type": "text/html" }).end(htmlOf(m[1], SCENARIOS[m[1]].body()));
  if (url.pathname.startsWith("/rt/")) {
    const file = resolve(rtDist, url.pathname.slice(4));
    if (file.startsWith(rtDist) && existsSync(file)) return res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  }
  res.writeHead(404).end();
});

// ------------------------------------------------------------------------------------------------- one explore session
async function session(browser, base, name, bug, slow) {
  const sc = SCENARIOS[name];
  const tag = `${name}-${bug ? "bug" : "ok"}-${slow}`;
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
  const bridgePort = PORT + 10 + SHARD;
  const served = await cur.serve({ cwd: OUT, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: bridgePort, stateDir: join(OUT, `state-${tag}`) });
  let id = 0;
  const rpc = async (method, params = {}) => {
    const my = ++id;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
    for (let i = 0; i < 1000; i++) {
      const m = lines.find((x) => x.id === my);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no reply to ${method}`);
  };
  const tool = async (t, a = {}) => (await rpc("tools/call", { name: t, arguments: a })).result.content[0].text;
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "planted-bench", version: "1" } });
  const bridge = `http://127.0.0.1:${served.port}`;
  const load = async (i) => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.addInitScript((u) => (window.__GENCLASS_AGENT_URL__ = u), bridge);
    const out = { i };
    try {
      const path = sc.freshPath ? `/p/${name}/${randomUUID()}/` : `/p/${name}/`;
      const q = [bug ? "bug" : "", sc.load ? `load=${randomUUID()}` : ""].filter(Boolean).join("&");
      await p.goto(`${base}${path}${q ? `?${q}` : ""}`);
      await p.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
      out.run = await p.evaluate(() => window.__GENCLASS_AGENT__.run);
      out.schedule = await p.evaluate(() => window.__GENCLASS_AGENT__.schedule);
      if (sc.settleFirst === false) await p.waitForTimeout(150);
      else await p.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000));
      await sc.steps(p, i);
      out.settled = await p.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000));
      out.wrong = sc.wrong ? await sc.wrong(p) : await p.evaluate(() => (window.__wrong ? window.__wrong() : false));
      await p.waitForTimeout(400); // the last batch reaches the bridge
    } catch (e) {
      out.error = String(e?.message ?? e).slice(0, 300);
    }
    await ctx.close();
    return out;
  };
  const result = { scenario: name, bug, slow_ms: slow, runs: RUNS, loads: [] };
  result.start = await tool("genclass_explore", { action: "start", runs: RUNS, slow_ms: slow });
  const planned = Number(/next (\d+) page loads/.exec(result.start)?.[1] ?? RUNS + 3);
  for (let i = 0; i < planned; i++) result.loads.push(await load(i));
  result.report = await tool("genclass_explore", { action: "report" });
  writeFileSync(join(OUT, `${tag}.json`), JSON.stringify(result, null, 2));
  await served.close();
  const wrong = result.loads.map((l) => (l.error ? "E" : l.wrong ? "D" : "s")).join("");
  console.log(`${tag}: ${wrong} ${result.report.split("\n").filter((l) => /^(RACE|No race found|NO VERDICT|No verdict|Compared:)/.test(l)).map((l) => l.slice(0, 90)).join(" | ")}`);
}

// ------------------------------------------------------------------------------------------------------------ the score
async function score() {
  const old = opt("--old") ? await import(pathToFileURL(join(resolve(opt("--old")), "index.js")).href) : null;
  const rows = [];
  for (const f of readdirSync(OUT).filter((x) => /-(ok|bug)-\d+\.json$/.test(x)).sort()) {
    const d = JSON.parse(readFileSync(join(OUT, f), "utf8"));
    const tag = f.replace(/\.json$/, "");
    const st = JSON.parse(readFileSync(join(OUT, `state-${tag}`, "state.json"), "utf8"));
    const byId = new Map(st.runs.map((r) => [r.id, r]));
    const x = st.explores.find((e) => e.runs.length) ?? st.explores[0];
    const runs = x.runs.map((id) => byId.get(id)).filter(Boolean);
    const wrong = new Map(d.loads.filter((l) => l.run).map((l) => [l.run, !!l.wrong]));
    const plain = (r) => r.schedule?.order === "fifo" && !r.schedule?.delay;
    const tally = (reports, withDelay) => {
      const seeds = runs.filter((r) => r.schedule?.order === "seeded");
      const raced = new Set(reports.flatMap((g) => g.diffs.filter((y) => (y.tier ?? "visible") === "visible" && g.baselines.length >= 2).map((y) => y.run)));
      const delay = withDelay ? reports.find((g) => g.delay)?.delay : undefined;
      const compared = reports.reduce((n, g) => n + (g.compared ?? (g.baselines.length >= 2 ? g.runs - g.baselines.length : 0)), 0);
      return { apart: reports.some((g) => g.delayCounts?.length), compared, seeds: seeds.length, races: raced.size, tp: seeds.filter((r) => raced.has(r.id) && wrong.get(r.id)).length, fp: seeds.filter((r) => raced.has(r.id) && !wrong.get(r.id)).length, fn: seeds.filter((r) => !raced.has(r.id) && wrong.get(r.id)).length, delay: !!delay, verdict: raced.size > 0 || !!delay };
    };
    const after = tally(cur.compareRuns(runs), true);
    const before = old ? tally(old.compareRuns(runs.filter((r) => !plain(r))), false) : null;
    // what the report's headline names, by this checkout's comparison (the first group that has something to say)
    const told = cur.compareRuns(runs).flatMap((g) => [...(g.delay ? [g.delay] : []), ...cur.strongestFirst(g.diffs.filter((y) => y.tier === "visible"))]);
    const headline = told.length ? cur.nameDifference(told[0]) : "";
    const names = SCENARIOS[d.scenario]?.names;
    rows.push({ tag, scenario: d.scenario, bug: d.bug, slow: d.slow_ms, check: d.loads.map((l) => (l.error ? "E" : l.wrong ? "D" : "s")).join(""), before, after, named: !!(names && names.test(headline)), headline: headline.slice(0, 200), anyWrong: d.loads.some((l) => l.wrong) });
  }
  writeFileSync(join(OUT, "score.json"), JSON.stringify(rows, null, 2));
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.scenario}-${r.bug ? "bug" : "ok"}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const sum = (list, side, key) => list.reduce((n, r) => n + (r[side]?.[key] ?? 0), 0);
  const cell = (list, side) => `${list.filter((r) => r[side]?.verdict).length}/${list.length}; ${sum(list, side, "races")} of ${sum(list, side, "compared")} (true ${sum(list, side, "tp")}, false ${sum(list, side, "fp")}, missed ${sum(list, side, "fn")})`;
  console.log("| scenario | a load's own check wrong | before: sessions with a RACE; runs reported of compared | after: the same | after: sessions naming a slow response alone | after: headline names the line | after: POST count named apart |");
  console.log("|---|---|---|---|---|---|---|");
  for (const [k, list] of groups) console.log(`| ${k} | ${list.filter((r) => r.anyWrong).length}/${list.length} | ${old ? cell(list, "before") : ""} | ${cell(list, "after")} | ${list.filter((r) => r.after.delay).length} | ${list.filter((r) => r.named).length} | ${list.filter((r) => r.after.apart).length} |`);
  for (const bug of [false, true]) {
    const list = rows.filter((r) => r.bug === bug);
    console.log(`\n${bug ? "planted bug" : "correct"}: ${old ? `before ${cell(list, "before")}; ` : ""}after ${cell(list, "after")}`);
  }
}

if (args.includes("--score")) {
  await score();
  process.exit(0);
}
const { chromium } = await import("@playwright/test");
await new Promise((r) => app.listen(PORT + SHARD, "127.0.0.1", r));
const base = `http://localhost:${PORT + SHARD}`;
const browser = await chromium.launch();
const jobs = [];
for (const slow of SLOW) for (const name of Object.keys(SCENARIOS)) for (const bug of SCENARIOS[name].bugless ? [false] : [false, true]) if (!ONLY || ONLY.includes(name)) jobs.push([name, bug, slow]);
for (const [i, [name, bug, slow]] of jobs.entries()) {
  if (i % SHARDS !== SHARD) continue;
  if (existsSync(join(OUT, `${name}-${bug ? "bug" : "ok"}-${slow}.json`))) continue;
  await session(browser, base, name, bug, slow);
}
await browser.close();
app.close();
process.exit(0);
