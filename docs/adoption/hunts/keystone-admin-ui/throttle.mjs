// Reproduction without GenClass (docs/adoption/hunts/keystone-admin-ui.md section 4.2). Not part of any test suite.
//
// Plain Playwright against the running Admin UI, nothing injected: Chromium's own network throttling (CDP
// Network.emulateNetworkConditions, the DevTools "throttling" switch) adds latency to every request; on a create page
// the user types a name and presses Enter twice, GAP ms apart. Counted per trial: create mutations on the wire and rows
// with that name in the database (through the GraphQL API, after every request has settled). The `click` mode is the
// control: a double click on the Create button.
//
// Usage: node docs/adoption/hunts/keystone-admin-ui/throttle.mjs [--list tags|authors] [--mode enter|click]
//          [--latency 400] [--gap 60] [--trials 10]
// KEYSTONE_URL (default http://localhost:3000).

import { chromium } from "playwright";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const APP = (process.env.KEYSTONE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const LIST = opt("list", "tags");
const MODE = opt("mode", "enter");
const LATENCY = Number(opt("latency", 400));
const GAP = Number(opt("gap", 60));
const TRIALS = Number(opt("trials", 10));
const singular = { tags: "Tag", authors: "Author" }[LIST];
const mutation = `create${singular}`;

async function gql(query, variables) {
  const r = await fetch(`${APP}/api/graphql`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  return (await r.json()).data;
}

const browser = await chromium.launch();
const results = [];
for (let t = 0; t < TRIALS; t++) {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
  const creates = [];
  page.on("request", (r) => {
    if (r.url() === `${APP}/api/graphql` && (r.postData() ?? "").includes(mutation)) creates.push(r.response().catch(() => null));
  });
  await page.goto(`${APP}/${LIST}/create`);
  const stamp = `${Date.now() % 1e7}`;
  const name = `throttle ${MODE} ${stamp}`;
  const nameBox = page.getByRole("textbox", { name: "Name" });
  await nameBox.waitFor({ timeout: 30_000 });
  await nameBox.fill(name);
  if (LIST === "authors") await page.getByRole("textbox", { name: "Email" }).fill(`throttle${stamp}@example.com`);
  if (MODE === "enter") {
    await nameBox.press("Enter");
    await page.waitForTimeout(GAP);
    await nameBox.press("Enter");
  } else {
    await page.getByRole("button", { name: "Create" }).dblclick();
  }
  await page.waitForURL((u) => u.pathname.startsWith(`/${LIST}/`) && u.pathname !== `/${LIST}/create`, { timeout: 30_000 });
  await Promise.all(creates);
  const toastFail = await page.getByText(`Unable to create ${singular.toLowerCase()}`).count();
  const where = { name: { equals: name } };
  const n = (await gql(`query ($w: ${singular}WhereInput!) { c: ${LIST}Count(where: $w) }`, { w: where })).c;
  results.push({ trial: t, creates: creates.length, rows: n, failToast: toastFail > 0 });
  console.log(`${LIST} ${MODE} latency ${LATENCY} gap ${GAP} trial ${t}: ${creates.length} ${mutation} request(s), ${n} row(s)${toastFail ? ', "Unable to create" toast' : ""}`);
  await page.close();
}
await browser.close();
const twice = results.filter((r) => r.creates > 1).length;
const dup = results.filter((r) => r.rows > 1).length;
console.log(JSON.stringify({ list: LIST, mode: MODE, latency: LATENCY, gap: GAP, trials: TRIALS, twoCreates: twice, duplicateRows: dup, failToasts: results.filter((r) => r.failToast).length }));
