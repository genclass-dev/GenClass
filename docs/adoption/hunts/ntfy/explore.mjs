// Race hunt harness for the ntfy web app (docs/adoption/hunts/ntfy.md). Not part of CI; run by hand against a local
// ntfy started with ntfy's own e2e server script:
//
//   (cd ~/targets/ntfy && node web/e2e/server.mjs build/ntfy-e2e build/e2e/server.yml 12586 e2e)   # prints the token
//   node docs/adoption/hunts/ntfy/explore.mjs --token tk_... --surface prefs --slow 300,600,900 [--runs 6] [--out <dir>]
//
// GenClass is injected from outside: ntfy's own code is unchanged. A Playwright route rewrites each app HTML page to
// load the script-tag build (packages/runtime/dist/genclass.global.js) from a virtual same-origin path
// (/__genclass/rt/), started with the model skipped (model: false) and telemetry off, then connects the coding-agent
// link (dist/agent.js) to the MCP bridge started in this process (packages/mcp/dist). Service workers are blocked so
// that the app's precache never serves the page past the route. ntfy keeps its state in IndexedDB (Dexie) and React
// component state; the page's visible text and form values are what the explore verdict compares, and the harness's
// own oracle reads the DOM, IndexedDB and the server (GET /v1/account) after the page settled.
//
// One user per run of this script (created with the admin token), reset through the API to the same account state
// before every page load, so every load starts from the same server state and runs the same steps. A fresh browser
// context per load (fresh IndexedDB), logged in by putting an API token in localStorage, which ntfy's Session reads.
//
// Surfaces (--surface):
//   prefs        settings page: Notification sound "No sound", then Minimum priority "Only max priority"
//   prefs-twice  settings page: Notification sound "No sound", then "Juntos" (a changed mind)
//   subscribe    app: subscribe to topic A, then to topic B, through the dialog
//   unsubscribe  app (A and B subscribed): unsubscribe A, then B
//   rename       app (A subscribed): display name "First name", then "Second name"
//   reserve      app (B subscribed): subscribe to topic A with "Reserve topic" on (one action: a reservation, then a
//                subscription; with no subscription at all the account JSON omits the list and sync() skips it:
//                HUNT_NO_OTHERS=1 runs it that way, the check that the removal is the cause)
// For each --slow value it runs one explore session: 2 fifo baselines + --runs seeded loads, the same steps each load.
// Each load's line ends with the delivery order of the account requests, as the agent link recorded it.
//
// Without GenClass (GENCLASS=0): the control, --runs loads with the network as it is; add --hold 1 for the plain
// reproduction: a Playwright route holds the first GET /v1/account sent after the page settled (the sync that the
// first change caused) until the next GET /v1/account was answered, or 3 s passed, as a slow network might. Nothing
// else is changed; the line says whether the held response was released after the newer one ("stale last").

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { parseArgs } from "node:util";
import { chromium, request as pwRequest } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const rtDist = join(root, "packages/runtime/dist");

const { values: arg } = parseArgs({
  options: {
    ntfy: { type: "string", default: "http://127.0.0.1:12586" },
    token: { type: "string", default: process.env.NTFY_E2E_ADMIN_TOKEN ?? "" },
    surface: { type: "string", default: "prefs" },
    slow: { type: "string", default: "300,600,900" },
    runs: { type: "string", default: "6" },
    out: { type: "string", default: "" },
    genclass: { type: "string", default: process.env.GENCLASS ?? "1" },
    hold: { type: "string", default: "0" },
  },
});
const N = arg.ntfy.replace(/\/+$/, "");
const withGenclass = arg.genclass !== "0";
const hold = arg.hold === "1";
if (hold && withGenclass) throw new Error("--hold 1 is the reproduction without GenClass: run it with GENCLASS=0");
const TYPES = { ".js": "text/javascript", ".map": "application/json" };
const PASSWORD = "secret12345";
// Topics are per run of this script (a deleted user's reservations outlive it for a grace period), letters only so
// that the page text holds no digit (explore blanks digit tokens; these stay comparable as they are).
const suffix = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const TOPIC_A = `alpha${suffix}`;
const TOPIC_B = `bravo${suffix}`;

// --------------------------------------------------------------------------- what the route injects into <head>
const INJECT = `<script src="/__genclass/rt/genclass.global.js" data-manual data-base="/__genclass/rt/"></script>
<script>window.__gcRt = window.GenClass.init({ model: false, telemetry: false, report: "silent" });</script>
<script type="module">
import { connectAgent } from "/__genclass/rt/agent.js";
connectAgent(window.__gcRt);
</script>
`;

async function route(page) {
  await page.route(`${N}/**`, async (r) => {
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
let tool = async () => "";
let served = null;
let bridgeUrl = "";
if (withGenclass) {
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
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ntfy-hunt", version: "1" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  bridgeUrl = `http://127.0.0.1:${served.port}`;
}

// --------------------------------------------------------------------------- the account, through ntfy's API
if (!arg.token) throw new Error("--token (the admin token server.mjs printed) is required");
const admin = await pwRequest.newContext({ baseURL: N, extraHTTPHeaders: { Authorization: `Bearer ${arg.token}` } });
const username = `hunt${Date.now().toString(36)}`;
{
  const r = await admin.post("/v1/users", { data: { username, password: PASSWORD, tier: "e2e" } }); // server.mjs's tier, for reservations
  if (!r.ok()) throw new Error(`creating ${username}: ${await r.text()}`);
}
const api = await pwRequest.newContext({ baseURL: N });
const userToken = await (async () => {
  const auth = Buffer.from(`${username}:${PASSWORD}`).toString("base64");
  const r = await api.post("/v1/account/token", { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok()) throw new Error(`token: ${await r.text()}`);
  return (await r.json()).token;
})();
const auth = { Authorization: `Bearer ${userToken}` };
const serverAccount = async () => (await api.get("/v1/account", { headers: auth })).json();

// Puts the account back to the surface's starting state (before every page load).
async function reset(surface) {
  await api.patch("/v1/account/settings", {
    headers: auth,
    data: { notification: { sound: "ding", min_priority: 1, delete_after: 2592000 } },
  });
  const want = { subscribe: [], prefs: [], "prefs-twice": [], unsubscribe: [TOPIC_A, TOPIC_B], rename: [TOPIC_A], reserve: process.env.HUNT_NO_OTHERS ? [] : [TOPIC_B] }[surface];
  const before = await serverAccount();
  for (const r of before.reservations ?? []) {
    await api.delete(`/v1/account/reservation/${r.topic}`, { headers: auth });
  }
  const have = before.subscriptions ?? [];
  for (const s of have) {
    await api.delete("/v1/account/subscription", { headers: { ...auth, "X-BaseURL": s.base_url, "X-Topic": s.topic } });
  }
  for (const topic of want) {
    await api.post("/v1/account/subscription", { headers: auth, data: { base_url: N, topic } });
  }
  if (surface === "reserve" && !published) {
    // messages already on the topic the user is about to subscribe to and reserve (once: the server keeps them)
    for (const m of ["first message", "second message"]) await api.post(`/${TOPIC_A}`, { data: m });
    published = true;
  }
}
let published = false;

// --------------------------------------------------------------------------- page helpers
const selectPref = async (page, title, option) => {
  await page.getByRole("row").filter({ has: page.getByRole("cell", { name: title }) }).getByRole("combobox").click();
  await page.getByRole("option", { name: option, exact: true }).click();
};
const openTopicMenu = async (page, name) => {
  const row = page.getByRole("button", { name, exact: true });
  await row.hover();
  await row.getByRole("button").click();
};
async function agentConnected(page) {
  if (withGenclass) await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
}
async function settle(page) {
  if (withGenclass) await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000));
  else await page.waitForLoadState("networkidle");
  // a sync event can still be on its way over the WebSocket: wait, then settle again
  await page.waitForTimeout(1500);
  if (withGenclass) await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000));
  else await page.waitForLoadState("networkidle");
}
// Resolves once the account's sync topic (st_...) WebSocket is open: sync events only arrive after that.
const syncSocketOpen = (page) =>
  new Promise((resolveOpen) => {
    page.on("websocket", (ws) => {
      if (/\/st_[^/]+\/ws/.test(new URL(ws.url()).pathname)) {
        ws.on("framereceived", (f) => {
          try {
            if (JSON.parse(f.payload).event === "open") resolveOpen();
          } catch {}
        });
      }
    });
  });

// What the page and the database hold at the end (the harness's own oracle).
async function readState(page) {
  return page.evaluate(async (user) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(`ntfy-${user}`);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = (store) =>
      new Promise((res) => {
        const r = db.transaction(store).objectStore(store).getAll();
        r.onsuccess = () => res(r.result);
      });
    const prefs = Object.fromEntries((await all("prefs")).map((p) => [p.key, p.value]));
    const notes = await all("notifications");
    const subs = (await all("subscriptions"))
      .filter((s) => !s.internal)
      .map((s) => {
        const n = notes.filter((x) => x.subscriptionId === s.id && !x.deleted).length;
        return `${s.topic}${s.displayName ? `=${s.displayName}` : ""}${s.reservation ? "+reserved" : ""}${n ? ` (${n} msg)` : ""}`;
      })
      .sort();
    db.close();
    return { prefs: { sound: prefs.sound, minPriority: prefs.minPriority }, subs };
  }, username);
}

// The plain reproduction's hold (--hold 1), armed once the page settled: the first account fetch after that waits for
// the next one to be answered (at most 3 s). Its response is fetched from the server at once (it holds the account as it
// was then) and only its delivery to the page waits.
let held = null;
async function arm(page) {
  if (!hold) return;
  const h = { fetches: 0, staleLast: false };
  let newerAnswered;
  const newer = new Promise((r) => (newerAnswered = r));
  h.released = new Promise((r) => (h.release = r));
  held = h;
  await page.route(/\/v1\/account$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const n = ++h.fetches;
    const response = await route.fetch();
    if (n === 1) {
      const won = await Promise.race([newer.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
      await route.fulfill({ response });
      h.staleLast = won;
      h.release();
    } else {
      await route.fulfill({ response });
      newerAnswered();
    }
  });
}

// --------------------------------------------------------------------------- the scenarios (what a person does)
const surfaces = {
  async prefs(page, open) {
    await page.goto(`${N}/settings`);
    await agentConnected(page);
    await open;
    await settle(page);
    await arm(page);
    await selectPref(page, "Notification sound", "No sound");
    await selectPref(page, "Minimum priority", "Only max priority");
  },
  async "prefs-twice"(page, open) {
    await page.goto(`${N}/settings`);
    await agentConnected(page);
    await open;
    await settle(page);
    await arm(page);
    await selectPref(page, "Notification sound", "No sound");
    await selectPref(page, "Notification sound", "Juntos");
  },
  async subscribe(page, open) {
    await page.goto(`${N}/app`);
    await agentConnected(page);
    await open;
    await settle(page);
    await arm(page);
    for (const topic of [TOPIC_A, TOPIC_B]) {
      await page.getByRole("button", { name: "Subscribe to topic" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel(/topic name/i).fill(topic);
      await dialog.getByRole("button", { name: "Subscribe", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
    }
  },
  async reserve(page, open) {
    await page.goto(`${N}/app`);
    await agentConnected(page);
    await open;
    await settle(page);
    await arm(page);
    await page.getByRole("button", { name: "Subscribe to topic" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/topic name/i).fill(TOPIC_A);
    await dialog.getByRole("switch", { name: /reserve topic/i }).check();
    await dialog.getByRole("button", { name: "Subscribe", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  },
  async unsubscribe(page, open) {
    await page.goto(`${N}/app`);
    await agentConnected(page);
    await open;
    await settle(page);
    await arm(page);
    for (const topic of [TOPIC_A, TOPIC_B]) {
      await openTopicMenu(page, topic);
      await page.getByRole("menuitem", { name: "Unsubscribe" }).click();
    }
  },
  async rename(page, open) {
    await page.goto(`${N}/app`);
    await agentConnected(page);
    await open;
    await settle(page);
    await arm(page);
    let shown = TOPIC_A;
    for (const name of ["First name", "Second name"]) {
      await openTopicMenu(page, shown);
      await page.getByRole("menuitem", { name: "Change display name" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Display name" }).fill(name);
      await dialog.getByRole("button", { name: "Save" }).click();
      await dialog.waitFor({ state: "hidden" });
      shown = name;
    }
  },
};

// What the server says the end state is, in the oracle's shape.
async function serverState() {
  const a = await serverAccount();
  const count = async (topic) => {
    const r = await api.get(`/${topic}/json?poll=1`, { headers: auth });
    return (await r.text()).split("\n").filter((l) => l.includes('"event":"message"')).length;
  };
  const counts = {};
  for (const s of a.subscriptions ?? []) counts[s.topic] = await count(s.topic);
  return {
    prefs: { sound: a.notification?.sound, minPriority: String(a.notification?.min_priority) },
    subs: (a.subscriptions ?? [])
      .map(
        (s) =>
          `${s.topic}${s.display_name ? `=${s.display_name}` : ""}${(a.reservations ?? []).some((r) => r.topic === s.topic) ? "+reserved" : ""}${counts[s.topic] ? ` (${counts[s.topic]} msg)` : ""}`,
      )
      .sort(),
  };
}

const browser = await chromium.launch();

async function scenario(fn) {
  await reset(arg.surface);
  const ctx = await browser.newContext({ permissions: ["local-network-access", "notifications"], serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (process.env.HUNT_DEBUG) {
    page.on("console", (m) => console.log("[page]", m.type(), m.text()));
    page.on("requestfailed", (r) => console.log("[failed]", r.url(), r.failure()?.errorText));
  }
  await page.addInitScript(
    ({ u, user, token, names }) => {
      if (u) window.__GENCLASS_AGENT_URL__ = u;
      localStorage.setItem("user", user);
      localStorage.setItem("token", token);
      // The sidebar's topic rows over time (the harness's oracle for a topic that vanishes and comes back)
      window.__huntHistory = [];
      const read = () => {
        const nav = document.querySelector("nav");
        if (!nav) return;
        const shown = [...new Set((nav.innerText || "").split("\n").map((l) => l.trim()).filter((l) => names.some((n) => l.startsWith(n))))].sort().join(",");
        const h = window.__huntHistory;
        if (h[h.length - 1] !== shown) h.push(shown);
      };
      document.addEventListener("DOMContentLoaded", () => new MutationObserver(read).observe(document.body, { childList: true, subtree: true, characterData: true }));
    },
    { u: bridgeUrl, user: username, token: userToken, names: [TOPIC_A, TOPIC_B, "First name", "Second name"] },
  );
  if (withGenclass) await route(page);
  const open = syncSocketOpen(page);
  let local;
  let remote;
  let history = "";
  let err = null;
  held = null;
  try {
    await fn(page, open);
    if (held) await Promise.race([held.released, page.waitForTimeout(5000)]);
    await settle(page);
    local = await readState(page);
    remote = await serverState();
    history = await page.evaluate(() => window.__huntHistory.map((x) => `[${x}]`).join(" > "));
  } catch (e) {
    err = String(e).split("\n")[0];
  }
  const order = withGenclass
    ? await page
        .evaluate(() =>
          window.__GENCLASS_AGENT__
            .recorded()
            .order.filter((k) => /\/v1\/account/.test(k))
            .map((k) => k.replace(/^.*?(GET|POST|PATCH|DELETE) /, "$1 ")),
        )
        .catch(() => [])
    : [];
  if (withGenclass) await page.waitForTimeout(500); // the snapshot batch reaches the bridge
  await ctx.close();
  const same = !err && JSON.stringify(local) === JSON.stringify(remote);
  return { local, remote, same, err, order, pageerror: errors[0] ?? null, history, staleLast: held ? held.staleLast : null };
}

const fmt = (r) =>
  r.err
    ? `ERROR ${r.err}`
    : `${r.same ? "same" : "DIFFERS"} local=${JSON.stringify(r.local)} server=${JSON.stringify(r.remote)}${r.history ? ` sidebar ${r.history}` : ""}${r.order.length ? ` [delivered ${r.order.join(" then ")}]` : ""}${r.staleLast === null ? "" : r.staleLast ? " [stale last]" : " [held response released first]"}${r.pageerror ? ` [pageerror: ${r.pageerror}]` : ""}`;

const fn = surfaces[arg.surface];
if (!fn) throw new Error(`unknown surface ${arg.surface}`);
const out = arg.out ? resolve(arg.out) : null;
if (out) mkdirSync(out, { recursive: true });
const summary = { surface: arg.surface, ntfy: N, genclass: withGenclass, runs: Number(arg.runs), sessions: [] };
if (withGenclass) {
  for (const slow of arg.slow.split(",").map(Number)) {
    await tool("genclass_clear", { what: "all" });
    const started = await tool("genclass_explore", { action: "start", runs: Number(arg.runs), slow_ms: slow });
    const loads = [];
    for (let i = 0; i < Number(arg.runs) + 2; i++) loads.push(await scenario(fn));
    const report = await tool("genclass_explore", { action: "report" });
    const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1];
    const explain = fid ? await tool("genclass_explain", { id: fid }) : null;
    const findings = await tool("genclass_findings");
    const verdict = /RACE: (\d+) of (\d+)/.exec(report);
    summary.sessions.push({
      slow_ms: slow,
      verdict: verdict ? `race in ${verdict[1]} of ${verdict[2]}` : "no race",
      finding: fid ?? null,
      oracleDiffers: loads.filter((l) => !l.same).length,
      loads: loads.map(fmt),
    });
    if (out) writeFileSync(join(out, `${arg.surface}-${slow}.txt`), [started, "", ...loads.map((l, i) => `load ${i + 1}: ${fmt(l)}`), "", report, "", findings, "", explain ?? ""].join("\n"));
    console.log(`--- ${arg.surface} slow_ms=${slow}\n${loads.map((l, i) => `load ${i + 1}: ${fmt(l)}`).join("\n")}\n${report}\n`);
  }
} else {
  // the control: the same steps, no GenClass, the network as it is
  const loads = [];
  for (let i = 0; i < Number(arg.runs); i++) loads.push(await scenario(fn));
  summary.sessions.push({ slow_ms: 0, oracleDiffers: loads.filter((l) => !l.same).length, loads: loads.map(fmt) });
  console.log(loads.map((l, i) => `load ${i + 1}: ${fmt(l)}`).join("\n"));
}
await browser.close();
if (served) await served.close();
await admin.delete("/v1/users", { data: { username } });
console.log(JSON.stringify(summary, null, 2));
if (out) writeFileSync(join(out, `${arg.surface}-summary.json`), JSON.stringify(summary, null, 2));
process.exit(0);
