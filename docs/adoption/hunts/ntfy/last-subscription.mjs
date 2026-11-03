// Second ntfy finding (docs/adoption/hunts/ntfy.md, finding 2), checked without GenClass: unsubscribing from the
// account's last topic in one browser never removes it in another browser of the same account, because the account
// JSON omits an empty "subscriptions" list and AccountApi.sync() only applies the list when it is there.
//
//   node docs/adoption/hunts/ntfy/last-subscription.mjs --token tk_... [--runs 3] [--keep 0|1]
//
// --keep 1 gives the account a second topic that stays subscribed (the control: the list is then never empty, and
// the other browser drops the unsubscribed topic). Prints one line per run: what browser 2 lists after the sync event,
// and after a reload.

import { parseArgs } from "node:util";
import { chromium, request as pwRequest } from "@playwright/test";

const { values: arg } = parseArgs({
  options: {
    ntfy: { type: "string", default: "http://127.0.0.1:12586" },
    token: { type: "string", default: process.env.NTFY_E2E_ADMIN_TOKEN ?? "" },
    runs: { type: "string", default: "3" },
    keep: { type: "string", default: "0" },
  },
});
const N = arg.ntfy.replace(/\/+$/, "");
const PASSWORD = "secret12345";
const letters = () => Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

const admin = await pwRequest.newContext({ baseURL: N, extraHTTPHeaders: { Authorization: `Bearer ${arg.token}` } });
const api = await pwRequest.newContext({ baseURL: N });
const browser = await chromium.launch();

for (let run = 1; run <= Number(arg.runs); run++) {
  const username = `last${letters()}`;
  const gone = `gone${letters()}`;
  const kept = `kept${letters()}`;
  await admin.post("/v1/users", { data: { username, password: PASSWORD, tier: "" } });
  const basic = Buffer.from(`${username}:${PASSWORD}`).toString("base64");
  const token = (await (await api.post("/v1/account/token", { headers: { Authorization: `Basic ${basic}` } })).json()).token;
  const auth = { Authorization: `Bearer ${token}` };
  for (const topic of arg.keep === "1" ? [gone, kept] : [gone]) {
    await api.post("/v1/account/subscription", { headers: auth, data: { base_url: N, topic } });
  }

  const open = async () => {
    const ctx = await browser.newContext({ serviceWorkers: "block", permissions: ["notifications"] });
    await ctx.addInitScript(
      ({ u, t }) => {
        localStorage.setItem("user", u);
        localStorage.setItem("token", t);
      },
      { u: username, t: token },
    );
    const page = await ctx.newPage();
    const live = new Promise((resolve) =>
      page.on("websocket", (ws) => {
        if (/\/st_[^/]+\/ws/.test(ws.url())) ws.on("framereceived", (f) => f.payload.includes('"open"') && resolve());
      }),
    );
    await page.goto(`${N}/app`);
    await page.getByRole("button", { name: gone, exact: true }).waitFor();
    await live;
    return { ctx, page };
  };
  const listed = async (page) => {
    const out = [];
    for (const t of [gone, kept]) if (await page.getByRole("button", { name: t, exact: true }).count()) out.push(t);
    return out;
  };

  const one = await open();
  const two = await open();
  const row = one.page.getByRole("button", { name: gone, exact: true });
  await row.hover();
  await row.getByRole("button").click();
  await one.page.getByRole("menuitem", { name: "Unsubscribe" }).click();
  await two.page.waitForTimeout(2000); // the sync event reaches browser 2, which fetches the account
  const afterSync = await listed(two.page);
  await two.page.reload();
  await two.page.waitForTimeout(2000);
  const afterReload = await listed(two.page);
  const server = ((await (await api.get("/v1/account", { headers: auth })).json()).subscriptions ?? []).map((s) => s.topic);
  console.log(
    `run ${run}: server [${server.map((t) => (t === gone ? "gone" : "kept")).join(",")}] · browser 1 [${(await listed(one.page)).map((t) => (t === gone ? "gone" : "kept")).join(",")}] · browser 2 after the sync event [${afterSync.map((t) => (t === gone ? "gone" : "kept")).join(",")}], after a reload [${afterReload.map((t) => (t === gone ? "gone" : "kept")).join(",")}]`,
  );
  await one.ctx.close();
  await two.ctx.close();
  await admin.delete("/v1/users", { data: { username } });
}
await browser.close();
process.exit(0);
