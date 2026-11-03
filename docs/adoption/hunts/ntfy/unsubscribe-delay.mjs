// ntfy hunt (docs/adoption/hunts/ntfy.md, section 4.6), without GenClass: two unsubscribes in a row with every
// /v1/account* response delayed by the same amount (order kept), logging the app's sync messages and the final page.
// Used on the fixed build to check explore's remaining "unsubscribe" race against a plain slow network.
//
//   node docs/adoption/hunts/ntfy/unsubscribe-delay.mjs http://127.0.0.1:12587 tk_... 800
import { chromium, request as pwRequest } from "@playwright/test";
const [N, adminToken, delay] = process.argv.slice(2);
const L = () => Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const admin = await pwRequest.newContext({ baseURL: N, extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` } });
const api = await pwRequest.newContext({ baseURL: N });
const browser = await chromium.launch();
for (let run = 0; run < 3; run++) {
  const u = `dl${L()}`, A = `alpha${L()}`, B = `bravo${L()}`;
  await admin.post("/v1/users", { data: { username: u, password: "secret12345", tier: "" } });
  const tok = (await (await api.post("/v1/account/token", { headers: { Authorization: "Basic " + Buffer.from(`${u}:secret12345`).toString("base64") } })).json()).token;
  for (const t of [A, B]) await api.post("/v1/account/subscription", { headers: { Authorization: `Bearer ${tok}` }, data: { base_url: N, topic: t } });
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await ctx.addInitScript(({ u, tok }) => { localStorage.setItem("user", u); localStorage.setItem("token", tok); }, { u, tok });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => { const t = m.text(); if (/Account changed|Syncing subscriptions|Unsubscribing|Fetching user account/.test(t)) logs.push(t.slice(0, 80)); });
  const live = new Promise((r) => page.on("websocket", (ws) => /\/st_/.test(ws.url()) && ws.on("framereceived", (f) => f.payload.includes('"open"') && r())));
  await page.goto(`${N}/app`);
  await live;
  await page.waitForTimeout(1500);
  await page.route(/\/v1\/account/, async (route) => { const resp = await route.fetch(); await new Promise((r) => setTimeout(r, Number(delay))); await route.fulfill({ response: resp }); });
  for (const t of [A, B]) {
    const row = page.getByRole("button", { name: t, exact: true });
    await row.hover();
    await row.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Unsubscribe" }).click();
    logs.push(`-- clicked unsubscribe ${t === A ? "A" : "B"}`);
  }
  await page.waitForTimeout(4000);
  const text = (await page.locator("body").innerText()).split("\n").filter((l) => /Loading notifications|any subscriptions yet/.test(l));
  console.log(`run ${run}: url ${new URL(page.url()).pathname.replace(B, "/B").replace(A, "/A")} page ${JSON.stringify(text)}\n  ${logs.map((l) => l.replace(A, "A").replace(B, "B")).join("\n  ")}`);
  await ctx.close();
}
await browser.close();
process.exit(0);
