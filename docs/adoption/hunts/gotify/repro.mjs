// Reproductions without GenClass for the Gotify hunt (docs/adoption/hunts/gotify.md). Plain Playwright against a local
// Gotify server, no injected script: latency comes from page.route waiting before it forwards a request (or, for the
// socket, page.routeWebSocket holding a frame), the rest is what a person does.
//
//   node docs/adoption/hunts/gotify/repro.mjs --gotify http://localhost:8080 --case <name> [--n 10] [--delay 600] \
//     [--log ~/targets/run/server.log]
//
// Cases:
//   nav-during-load   GET /message?since=0 forwarded after --delay ms; click "Backup" as soon as it is listed; read
//                     the page 3 s later (spinner? rows?)
//   refresh-twice     list loaded; every later GET /message?since=0 forwarded after --delay ms; click Refresh twice
//   push-during-load  GET /message?since=0 answered by the server at once, handed to the page --delay ms later; a
//                     message is pushed with the REST API in between (its /stream frame reaches the page first)
//   socket-late       #680's order: a message is pushed just before GET /message?since=0 is forwarded (so the page
//                     contains it) and its /stream frame is held --delay ms by page.routeWebSocket (an artificial
//                     socket delay: this case shows the code path, not a measured natural timing); with --delay 0
//                     the frame still passes through Playwright's relay, one extra hop like a reverse proxy
//   socket-direct     the same steps with no socket route at all (the control for the relay)
//   create-app-double POST /application forwarded after --delay ms (0 = localhost speed); Create clicked twice
//   delete-then-leave DELETE /message/:id forwarded after --delay ms; leave the page once it is sent (pagehide)
// --delay 0 is the control for every case. Each run uses a fresh browser context and its own message or name.

import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: arg } = parseArgs({
  options: {
    gotify: { type: "string", default: "http://localhost:8080" },
    case: { type: "string", default: "nav-during-load" },
    n: { type: "string", default: "10" },
    delay: { type: "string", default: "600" },
    log: { type: "string", default: "" },
  },
});
const G = arg.gotify.replace(/\/+$/, "");
const delay = Number(arg.delay);
const BASIC = "Basic " + Buffer.from("admin:admin").toString("base64");
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

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
const appByName = async (name) => (await api("GET", "/application")).find((a) => a.name === name) ?? (await api("POST", "/application", { name }));
const push = (app, title) => api("POST", "/message", { appid: app.id, title, message: `body of ${title}`, priority: 1 });
const backup = await appByName("Backup");
const hunt = await appByName("Hunt");
for (let i = (await api("GET", "/message?limit=200")).messages.length; i < 20; i++) await push(i % 2 ? backup : hunt, `seed ${i}`);
const serverLines = (re) => (arg.log && existsSync(arg.log) ? readFileSync(arg.log, "utf8").split("\n").filter((l) => re.test(l)).length : -1);

const browser = await chromium.launch();
const loginCtx = await browser.newContext();
const login = await loginCtx.request.post(`${G}/auth/local/login`, { headers: { authorization: BASIC }, data: { name: "gotify-repro" } });
if (!login.ok()) throw new Error(`login failed: HTTP ${login.status()}`);
const storageState = await loginCtx.storageState();
await loginCtx.close();

const isFirstPage = (url) => /\/message\?since=0$/.test(url);
const titles = (page) => page.locator("#messages .message .title").allTextContents();
const spinner = (page) => page.locator("main .MuiCircularProgress-root").count();
let seq = 0;
const tag = () => `${arg.case}-${process.pid}-${++seq}`;

const cases = {
  async "nav-during-load"(page) {
    await page.route(`${G}/message?since=0`, async (r) => (await nap(delay), r.fallback()));
    await page.goto(`${G}/#/`);
    const link = page.locator("#message-navigation .item", { hasText: "Backup" });
    await link.waitFor();
    const inFlight = (await page.locator("#messages").count()) === 0;
    await link.click();
    await page.waitForTimeout(delay + 3000);
    const want = (await api("GET", `/application/${backup.id}/message?limit=200`)).messages.length;
    const rows = (await titles(page)).length;
    const bad = (await spinner(page)) > 0 && rows === 0;
    return { bad, line: `clicked while first page ${inFlight ? "in flight" : "loaded"}; spinner=${await spinner(page)} rows=${rows} of ${want}` };
  },
  async "refresh-twice"(page) {
    await page.goto(`${G}/#/`);
    await page.locator("#messages .message").first().waitFor();
    await page.route(`${G}/message?since=0`, async (r) => (await nap(delay), r.fallback()));
    await page.locator("#refresh-all").click();
    await page.locator("#refresh-all").click();
    await page.waitForTimeout(delay + 3000);
    const rows = (await titles(page)).length;
    return { bad: rows === 0, line: `spinner=${await spinner(page)} rows=${rows}` };
  },
  async "push-during-load"(page) {
    const title = `pushed ${tag()}`;
    await page.route(`${G}/message?since=0`, async (r) => {
      const resp = await r.fetch();
      await push(hunt, title);
      await nap(delay);
      await r.fulfill({ response: resp });
    });
    await page.goto(`${G}/#/`);
    await page.locator("#messages").waitFor({ timeout: delay + 15_000 });
    await page.waitForTimeout(1000);
    const copies = (await titles(page)).filter((t) => t === title).length;
    return { bad: copies !== 1, line: `pushed message shown ${copies}x` };
  },
  async "socket-late"(page, relay = true) {
    const title = `pushed ${tag()}`;
    if (relay)
      await page.routeWebSocket(/\/stream$/, (ws) => {
        const server = ws.connectToServer();
        server.onMessage((m) => (delay ? setTimeout(() => ws.send(m), delay) : ws.send(m)));
      });
    let pushed = false;
    await page.route(`${G}/message?since=0`, async (r) => {
      if (!pushed) {
        pushed = true;
        await page.waitForTimeout(300); // the socket is open
        await push(hunt, title);
      }
      await r.fallback();
    });
    await page.goto(`${G}/#/`);
    await page.locator("#messages").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(delay + 1000);
    const copies = (await titles(page)).filter((t) => t === title).length;
    return { bad: copies !== 1, line: `pushed message shown ${copies}x` };
  },
  "socket-direct": (page) => cases["socket-late"](page, false),
  async "create-app-double"(page) {
    const name = `app ${tag()}`;
    await page.route(`${G}/application`, async (r) => (r.request().method() === "POST" && (await nap(delay)), r.fallback()));
    await page.goto(`${G}/#/applications`);
    await page.locator("#create-app").click();
    await page.locator("#app-dialog .name input").fill(name);
    const create = page.locator("#app-dialog button.create");
    await create.click();
    await create.click({ timeout: 1_000 }).catch(() => {});
    await page.waitForTimeout(delay + 1500);
    const n = (await api("GET", "/application")).filter((a) => a.name === name).length;
    return { bad: n !== 1, line: `applications created: ${n}` };
  },
  async "delete-then-leave"(page) {
    const msg = await push(hunt, `to delete ${tag()}`);
    const re = new RegExp(`method=DELETE path=/message/${msg.id} `);
    const before = serverLines(re);
    await page.route(`${G}/message/${msg.id}`, async (r) => (await nap(delay), r.fallback()));
    await page.goto(`${G}/#/`);
    await page.locator("#messages .message", { hasText: msg.title }).locator(".delete").click();
    await page.waitForRequest((r) => r.method() === "DELETE" && r.url().endsWith(`/message/${msg.id}`), { timeout: 10_000 });
    await page.goto("about:blank");
    await nap(delay + 1500);
    const n = serverLines(re) - before;
    return { bad: n !== 1, line: `DELETE /message/${msg.id} reached the server ${n}x` };
  },
};

const fn = cases[arg.case];
if (!fn) throw new Error(`unknown case ${arg.case}`);
let bad = 0;
const n = Number(arg.n);
for (let i = 0; i < n; i++) {
  const ctx = await browser.newContext({ storageState });
  const page = await ctx.newPage();
  let r;
  try {
    r = await fn(page);
  } catch (e) {
    r = { bad: false, line: `ERROR ${String(e).split("\n")[0]}` };
  }
  await ctx.close();
  if (r.bad) bad++;
  console.log(`run ${i + 1}: ${r.line}${r.bad ? "  <- bug" : ""}`);
}
console.log(`${arg.case} delay=${delay}ms ${G}: bug in ${bad} of ${n}`);
await browser.close();
process.exit(0);
