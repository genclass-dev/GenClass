// Controls for the reproduction's claims, without GenClass and without any route: load the posts list of the
// reproduction app (payload-refresh/repro/) and count the relationship batch requests, either as served or under
// Chromium's network throttling with DevTools' "Slow 4G" values (562.5 ms latency, 180 000 B/s down, 84 375 B/s up).
//   HUNT_OUT=<dir with storageState.json from login.mjs> THROTTLE=1 node throttle-control.mjs   -> exit 1 on a repeat
import { chromium } from "@playwright/test";

const APP = process.env.PAYLOAD_URL ?? "http://localhost:3000";
const STATE = `${process.env.HUNT_OUT}/storageState.json`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();
if (process.env.THROTTLE) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 562.5,
    downloadThroughput: 180000,
    uploadThroughput: 84375,
  });
}
const batches = [];
page.on("request", (req) => {
  const u = new URL(req.url());
  if (u.searchParams.has("where[id][in]")) {
    batches.push({ slug: u.pathname.split("/").pop(), ids: u.searchParams.get("where[id][in]").split(","), t: Date.now() });
  }
});
await page.goto(`${APP}/admin/collections/posts`, { waitUntil: "load", timeout: 120000 });
await page.locator("table tbody tr").first().waitFor({ timeout: 120000 });
await page.waitForTimeout(5000);
const t0 = batches[0]?.t ?? 0;
for (const b of batches) console.log(`+${String(b.t - t0).padStart(5)} ms  GET /api/${b.slug}  where[id][in]=${b.ids.join(",")}`);
const seen = new Set();
const dup = new Set();
for (const b of batches) for (const id of b.ids) {
  const k = `${b.slug}:${id}`;
  if (seen.has(k)) dup.add(k);
  seen.add(k);
}
console.log(`throttle: ${process.env.THROTTLE ? "Slow 4G" : "off"}; batch requests: ${batches.length}; ids requested more than once: ${dup.size}`);
await browser.close();
process.exit(dup.size ? 1 : 0);
