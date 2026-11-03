// ntfy hunt (docs/adoption/hunts/ntfy.md, section 4.2), without GenClass: what the page shows after a reserved subscribe
// that lost its messages, and whether they come back. Natural order, a local ntfy e2e server (tier "e2e").
//
//   node docs/adoption/hunts/ntfy/reserve-reload.mjs http://127.0.0.1:12586 tk_...   # the admin token server.mjs printed
//
// Per run: a fresh user with one other subscription, two messages on topic A, then "Subscribe to topic" A with
// "Reserve topic" on; prints the notifications shown right after, 10 s later, and after a reload.
import { chromium, request as pwRequest } from "@playwright/test";
const [N, adminToken] = process.argv.slice(2);
const L = () => Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const admin = await pwRequest.newContext({ baseURL: N, extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` } });
const api = await pwRequest.newContext({ baseURL: N });
const browser = await chromium.launch();
for (let run = 0; run < 3; run++) {
  const u = `rl${L()}`, A = `alpha${L()}`, B = `bravo${L()}`;
  await admin.post("/v1/users", { data: { username: u, password: "secret12345", tier: "e2e" } });
  const tok = (await (await api.post("/v1/account/token", { headers: { Authorization: "Basic " + Buffer.from(`${u}:secret12345`).toString("base64") } })).json()).token;
  await api.post("/v1/account/subscription", { headers: { Authorization: `Bearer ${tok}` }, data: { base_url: N, topic: B } });
  for (const m of ["one", "two"]) await api.post(`/${A}`, { data: m });
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await ctx.addInitScript(({ u, tok }) => { localStorage.setItem("user", u); localStorage.setItem("token", tok); }, { u, tok });
  const page = await ctx.newPage();
  const live = new Promise((r) => page.on("websocket", (ws) => /\/st_/.test(ws.url()) && ws.on("framereceived", (f) => f.payload.includes('"open"') && r())));
  await page.goto(`${N}/app`);
  await live;
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Subscribe to topic" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel(/topic name/i).fill(A);
  await d.getByRole("switch", { name: /reserve topic/i }).check();
  await d.getByRole("button", { name: "Subscribe", exact: true }).click();
  await page.waitForTimeout(4000);
  const shown = async () => page.getByRole("listitem", { name: "Notification" }).count();
  const empty = async () => (await page.getByText("You haven't received any notifications for this topic yet.").count()) > 0;
  const before = `${await shown()} shown, empty-state ${await empty()}`;
  await page.waitForTimeout(10000);
  const later = `${await shown()} shown`;
  await page.reload();
  await page.waitForTimeout(5000);
  console.log(`run ${run}: on ${new URL(page.url()).pathname === "/" + A ? "A's page" : page.url()} · after subscribing: ${before} · 10 s later: ${later} · after a reload: ${await shown()} shown`);
  await ctx.close();
}
await browser.close();
process.exit(0);
