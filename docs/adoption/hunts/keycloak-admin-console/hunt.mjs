// The GenClass race hunt on the Keycloak admin console (docs/adoption/hunts/keycloak-admin-console.md). Not part of CI.
//
// It drives a locally running Keycloak nightly (KEYCLOAK_URL, default http://localhost:8080; js/apps/keycloak-server,
// `pnpm start`) in headless Chromium with the real @genclass/runtime script-tag build and the agent entry injected
// into the console by Playwright's addInitScript (Keycloak's files are untouched), the real @genclass/mcp server
// in-process (its bridge on a free port), and the tool calls a coding agent makes: genclass_explore start, one page
// load per armed run, report, genclass_explain, genclass_replay.
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp       # in this repository
//   node docs/adoption/hunts/keycloak-admin-console/hunt.mjs setup             # the hunt realm, its users, a login
//   node docs/adoption/hunts/keycloak-admin-console/hunt.mjs explore <scenario> <slow_ms,...> [runs=6] [pause_ms=0]
//
// The console signs in through keycloak-js (`onLoad: "login-required"`): every page load is a document load of the
// console, a redirect to the login endpoint (answered at once from the saved SSO cookie) and a second document load of
// the console with the code in its URL. Only that second document gets the runtime and connects to the bridge, so each
// armed explore run is the page the steps run on (see "injection" below).
//
// Before every load the scenario's data is reset through the admin REST API, so every run starts from the same server
// state. Besides the explore verdict, every run records an oracle of its own, read after GenClass's quiet point: the
// realm or users as the server stores them (admin REST API) and what the page shows. It is this script's own check,
// labelled as such in the report.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { chromium, expect } from "@playwright/test";
import { KC, admin, createRealm, getRealm, login } from "./kc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const rtDist = join(repo, "packages/runtime/dist");
const { serve } = await import(join(repo, "packages/mcp/dist/index.js"));
const OUT = process.env.HUNT_OUT ?? "/root/targets/kc-hunt-out";
const STATE = join(OUT, "storageState.json");
const REALM = "genclass-hunt";
const ORIGINAL = "Original display name";
const EDITED = "Display name from the General tab";
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".map": "application/json", ".wasm": "application/wasm" };
mkdirSync(OUT, { recursive: true });

// --------------------------------------------------------------------------- the MCP server, driven like an agent
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
  const served = await serve({ cwd: OUT, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: join(OUT, "state") });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "keycloak-hunt", version: "1" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { served, url: `http://127.0.0.1:${served.port}` };
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

// --------------------------------------------------------------------------- injection (Keycloak's files untouched)
// The console document keycloak-js returns to with the code is the end of a redirect chain (login endpoint, 302), and
// Playwright does not route a document reached by a redirect, so the HTML cannot be rewritten as on Gitea or Strapi.
// The runtime goes in with addInitScript instead (as the target brief suggests): the script-tag build's own source,
// run before any of the document's scripts, only in the console document that carries the code (the first console
// document only redirects to the login endpoint and would take an armed run). The agent entry (an ES module) is
// imported from a virtual same-origin path served by a route.
function initScript(bridgeUrl) {
  // observe mode, no model (explore needs none), no telemetry, no visual checks
  const cfg = { telemetry: false, mode: "observe", model: false, visual: false, devtools: false, report: "silent" };
  const runtime = readFileSync(join(rtDist, "genclass.global.js"), "utf8");
  return `if (location.pathname.startsWith("/admin/master/console") && /[?#&]code=/.test(location.href)) {
window.GENCLASS_CONFIG = ${JSON.stringify(cfg)};
${runtime}
;import("/__genclass/agent.js").then((m) => { window.__GENCLASS_CONN__ = m.connectAgent(window.GenClass.runtime, { url: ${JSON.stringify(bridgeUrl)} }); });
}`;
}
async function inject(context, bridgeUrl) {
  await context.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => route.abort());
  await context.route("**/__genclass/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/__genclass\//, "");
    const file = resolve(rtDist, p);
    if (!file.startsWith(rtDist) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  if (bridgeUrl) await context.addInitScript(initScript(bridgeUrl));
}

// --------------------------------------------------------------------------- data, reset before every load
const USERS = [...Array(15)].map((_, i) => `alpha${i + 1}`).concat([...Array(15)].map((_, i) => `beta${i + 1}`));
async function setup(browser) {
  if (!(await getRealm(REALM))) await createRealm(REALM, { displayName: ORIGINAL });
  for (const u of USERS) {
    const found = await admin("GET", `/${REALM}/users?username=${u}&exact=true`);
    if (!found?.length) await admin("POST", `/${REALM}/users`, { username: u, enabled: true, firstName: u, lastName: "Hunt", email: `${u}@example.com` });
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);
  await ctx.storageState({ path: STATE });
  await ctx.close();
}
async function resetRealm() {
  const r = await getRealm(REALM);
  await admin("PUT", `/${REALM}`, { ...r, displayName: ORIGINAL, registrationAllowed: false, resetPasswordAllowed: false, rememberMe: false });
}

// --------------------------------------------------------------------------- the scenarios (what a person does)
const consoleUrl = (hash) => `${KC}/admin/master/console/#${hash}`;
const nap = (page, ms) => (ms ? page.waitForTimeout(ms) : Promise.resolve());

const SCENARIOS = {
  /** General tab: new display name, Save; then (after `pause`) Login tab: "User registration" on. */
  "realm-tabs": {
    reset: resetRealm,
    url: consoleUrl(`/${REALM}/realm-settings/general`),
    async steps(page, pause) {
      const alert = page.getByTestId("last-alert");
      const displayName = page.getByTestId("displayName");
      await displayName.waitFor();
      await settle(page);
      await displayName.fill(EDITED);
      await page.getByTestId("realmSettingsGeneralTab-save").click();
      await expect(alert).toContainText("Realm successfully updated", { timeout: 15_000 });
      await nap(page, pause);
      await page.getByTestId("rs-login-tab").click();
      const reg = page.getByTestId("user-reg-switch");
      await reg.waitFor({ state: "attached" });
      await reg.click({ force: true });
      await expect(alert).toContainText("changed successfully", { timeout: 15_000 });
    },
    async oracle(page) {
      const r = await getRealm(REALM);
      const title = (await page.locator("h1").first().innerText().catch(() => "")).trim();
      return { displayName: r.displayName ?? null, registrationAllowed: r.registrationAllowed, title };
    },
  },
  /** Login tab: "User registration" on, then (after `pause`) "Forgot password" on. */
  "login-switches": {
    reset: resetRealm,
    url: consoleUrl(`/${REALM}/realm-settings/login`),
    async steps(page, pause) {
      const reg = page.getByTestId("user-reg-switch");
      await reg.waitFor({ state: "attached" });
      await settle(page);
      await reg.click({ force: true });
      await nap(page, pause);
      await page.getByTestId("forgot-pw-switch").click({ force: true });
    },
    async oracle(page) {
      const r = await getRealm(REALM);
      const shown = {
        registration: await page.getByTestId("user-reg-switch").isChecked(),
        forgotPassword: await page.getByTestId("forgot-pw-switch").isChecked(),
      };
      return { registrationAllowed: r.registrationAllowed, resetPasswordAllowed: r.resetPasswordAllowed, shown };
    },
  },
  /** Add user: username "double-click-user", then a double click on Create (two clicks, `pause` apart). */
  "user-create-double": {
    reset: async () => {
      for (const u of (await admin("GET", `/${REALM}/users?username=double-click-user&exact=true`)) ?? []) await admin("DELETE", `/${REALM}/users/${u.id}`);
    },
    url: consoleUrl(`/${REALM}/users/add-user`),
    async steps(page, pause) {
      const username = page.getByTestId("username");
      await username.waitFor();
      await settle(page);
      await username.fill("double-click-user");
      const create = page.getByTestId("user-creation-save");
      if (pause) {
        await create.click();
        await nap(page, pause);
        await create.click().catch(() => {}); // the page may have moved on
      } else {
        await create.dblclick();
      }
    },
    async oracle(page) {
      const users = (await admin("GET", `/${REALM}/users?username=double-click-user&exact=true`)) ?? [];
      const alerts = await page.locator(".pf-v5-c-alert__title").allInnerTexts();
      const route = new URL(page.url()).hash.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, ":id");
      return { users: users.length, alerts: alerts.map((a) => a.replace(/^\w+ alert:/, "").trim()).sort(), route };
    },
  },
  /** Users list: search "alpha" (Enter), then (after `pause`) "beta" (Enter). */
  "user-search": {
    reset: async () => {},
    url: consoleUrl(`/${REALM}/users`),
    async steps(page, pause) {
      const search = page.getByTestId("table-search-input").locator("input");
      await search.waitFor();
      await settle(page);
      await search.fill("alpha");
      await search.press("Enter");
      await nap(page, pause);
      await search.fill("beta");
      await search.press("Enter");
    },
    async oracle(page) {
      const rows = await page.locator('table tbody tr td a[href*="/users/"]').allInnerTexts();
      return { rows: rows.map((t) => t.trim()).filter(Boolean).slice(0, 12) };
    },
  },
};

async function settle(page) {
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 20_000 });
  await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(20_000));
}

async function load(browser, bridgeUrl, sc, pause) {
  await sc.reset();
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1920, height: 1080 }, storageState: STATE, permissions: ["local-network-access"] });
  await inject(ctx, bridgeUrl);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).split("\n")[0]));
  if (process.env.HUNT_DEBUG) page.on("console", (m) => console.log("[page]", m.type(), m.text()));
  let oracle;
  let error = null;
  try {
    await page.goto(sc.url);
    await sc.steps(page, pause);
    await settle(page);
    oracle = await sc.oracle(page);
  } catch (e) {
    error = String(e).split("\n")[0];
    if (process.env.HUNT_DEBUG) await page.screenshot({ path: join(OUT, "debug.png") }).then(() => console.log("[debug] url", page.url()));
    if (process.env.HUNT_DEBUG) console.log("[debug]", errors, await page.evaluate(() => ({ gc: !!window.GenClass, conn: !!window.__GENCLASS_CONN__, agent: window.__GENCLASS_AGENT__ ? { c: window.__GENCLASS_AGENT__.connected } : null })).catch((e) => String(e)));
    oracle = await sc.oracle(page).catch(() => null);
  }
  const rec = await page
    .evaluate(() => {
      const r = window.__GENCLASS_AGENT__.recorded();
      return { order: r.order.filter((k) => /admin\/realms/.test(k)), schedule: r.schedule ?? null };
    })
    .catch(() => null);
  await page.waitForTimeout(600); // the last batch reaches the bridge
  await ctx.close();
  return { oracle, error, pageErrors: errors, delivered: rec?.order ?? [] };
}

// --------------------------------------------------------------------------- main
const [cmd, name, slowArg = "300,600,900", runsArg = "6", pauseArg = "0"] = process.argv.slice(2);
// HUNT_VARIANT labels the console under test in the file names and the summary (the nightly is "unfixed"; the Vite
// dev server on the patched checkout, with the server started by `pnpm start --admin-dev`, is "fixed")
const VARIANT = process.env.HUNT_VARIANT ?? "unfixed";
const TAG = VARIANT === "unfixed" ? "" : `-${VARIANT}`;
const browser = await chromium.launch();
if (cmd === "setup") {
  await setup(browser);
  console.log(`realm ${REALM} with ${USERS.length} users; session saved to ${STATE}`);
} else if (cmd === "explore") {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`unknown scenario ${name}; one of ${Object.keys(SCENARIOS).join(", ")}`);
  const { served, url } = await startServer();
  const runs = Number(runsArg);
  const pause = Number(pauseArg);
  const summary = [];
  for (const slow of slowArg.split(",").map(Number)) {
    await tool("genclass_clear", { what: "all" });
    const started = await tool("genclass_explore", { action: "start", runs, slow_ms: slow });
    const loads = [];
    for (let i = 0; i < runs + 2; i++) {
      const r = await load(browser, url, sc, pause);
      loads.push(r);
      console.log(`${name} slow=${slow} load ${i + 1}: ${JSON.stringify(r.oracle)}${r.error ? ` ERROR ${r.error}` : ""}`);
    }
    const report = await tool("genclass_explore", { action: "report" });
    const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1] ?? /\b(f\d+)\b/.exec(report)?.[1];
    const explain = fid ? await tool("genclass_explain", { id: fid }) : null;
    let replay = null;
    if (fid) {
      const armed = await tool("genclass_replay", { action: "arm", id: fid });
      const r = await load(browser, url, sc, pause);
      replay = { armed, oracle: r.oracle, result: await tool("genclass_replay", { action: "result", id: fid }) };
    }
    const findings = await tool("genclass_findings");
    const verdict = (/^(RACE: .*|No race.*|No verdict.*)$/m.exec(report) ?? [])[0] ?? report.split("\n")[0];
    const file = join(OUT, `${name}-p${pause}${TAG}-${slow}.txt`);
    writeFileSync(
      file,
      [started, "", ...loads.map((l, i) => `load ${i + 1}: ${JSON.stringify(l)}`), "", report, "", findings, "", explain ?? "", "", replay ? JSON.stringify(replay, null, 2) : ""].join("\n"),
    );
    summary.push({ scenario: name, variant: VARIANT, pause_ms: pause, slow_ms: slow, runs, verdict, finding: fid ?? null, replay: replay ? (/REPRODUCED|NOT REPRODUCED|not reproduced|reproduced|inconclusive/i.exec(replay.result)?.[0] ?? replay.result.split("\n")[0]) : null, oracles: loads.map((l) => l.oracle), errors: loads.filter((l) => l.error).map((l) => l.error), file });
    console.log(`--- ${name} pause=${pause} slow_ms=${slow}\n${report}\n`);
  }
  writeFileSync(join(OUT, `${name}-p${pause}${TAG}-summary.json`), JSON.stringify(summary, null, 2));
  await served.close();
} else {
  console.log("usage: hunt.mjs setup | explore <scenario> <slow_ms,...> [runs] [pause_ms]");
}
await browser.close();
process.exit(0);
