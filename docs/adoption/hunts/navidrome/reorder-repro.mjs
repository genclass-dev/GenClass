// The playlist drag-reorder scenario WITHOUT GenClass (docs/adoption/hunts/navidrome.md, section 3, reorder).
// Not part of CI. Plain Playwright against a local `make dev`; seed the playlist first (hunt.mjs seed).
//
//   node docs/adoption/hunts/navidrome/reorder-repro.mjs [--runs 3] [--delay 600] [--target put|tracks|all|none]
//
// Two drags in a row in the hunt playlist (row 1 onto row 4, twice), as hunt.mjs does. --target says which
// responses reach the page --delay ms late: put (PUT /api/playlist/:id/tracks/:pos), tracks (the GET refetch of the
// list), all (both), none. Counts the PUTs the page sent and compares the order shown with the server's.

import { chromium } from "@playwright/test";
import { parseArgs } from "node:util";

const { values: arg } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:4533" },
    runs: { type: "string", default: "3" },
    delay: { type: "string", default: "600" },
    target: { type: "string", default: "all" },
  },
});
const APP = arg.url.replace(/\/+$/, "");
const DELAY = Number(arg.delay);
const auth = await (await fetch(`${APP}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "password" }) })).json();
const api = async (p, init = {}) => {
  const r = await fetch(`${APP}/api/${p}`, { ...init, headers: { "content-type": "application/json", "x-nd-authorization": `Bearer ${auth.token}` } });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};
const pls = (await api("playlist?_start=0&_end=100")).find((p) => p.name === "GenClass hunt playlist");
if (!pls) throw new Error("no hunt playlist: run hunt.mjs seed first");
const short = (titles) => titles.slice(0, 4).map((t) => t.replace("Track 1 of album ", "a")).join(",");
async function reset() {
  const existing = await api(`playlist/${pls.id}/tracks?_start=0&_end=100&playlist_id=${pls.id}`);
  if (existing.length) await api(`playlist/${pls.id}/tracks?${existing.map((t) => `id=${t.id}`).join("&")}`, { method: "DELETE" });
  const songs = await api("song?_start=0&_end=8&_sort=title&_order=ASC");
  await api(`playlist/${pls.id}/tracks`, { method: "POST", body: JSON.stringify({ ids: songs.map((s) => s.id) }) });
}

const browser = await chromium.launch();
let differ = 0;
for (let i = 0; i < Number(arg.runs); i++) {
  await reset();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript((a) => {
    if (localStorage.getItem("token")) return;
    for (const [k, v] of Object.entries({ token: a.token, userId: a.id, name: a.name, username: a.username, role: "admin", "subsonic-salt": a.subsonicSalt, "subsonic-token": a.subsonicToken, "is-authenticated": "true" })) localStorage.setItem(k, v);
  }, auth);
  const page = await ctx.newPage();
  await page.goto(`${APP}/#/playlist/${pls.id}/show`);
  await page.locator("tbody tr td.column-title").nth(7).waitFor();
  await page.waitForTimeout(1500);
  let puts = 0;
  page.on("request", (r) => r.method() === "PUT" && /\/tracks\/\d+$/.test(r.url()) && puts++);
  await page.route(`**/api/playlist/${pls.id}/tracks**`, async (route) => {
    const isPut = route.request().method() === "PUT";
    const slow = arg.target === "all" || (arg.target === "put" && isPut) || (arg.target === "tracks" && !isPut);
    if (!slow) return route.fallback();
    const res = await route.fetch();
    await new Promise((r) => setTimeout(r, DELAY));
    return route.fulfill({ response: res });
  });
  const rows = page.locator("tbody tr");
  await rows.nth(0).dragTo(rows.nth(3));
  const shownBetween = await page.locator("tbody tr td.column-title").allTextContents();
  await rows.nth(0).dragTo(rows.nth(3));
  await page.waitForTimeout(DELAY * 3 + 1500);
  const shown = await page.locator("tbody tr td.column-title").allTextContents();
  const server = (await api(`playlist/${pls.id}/tracks?_start=0&_end=100&_sort=id&_order=ASC&playlist_id=${pls.id}`)).map((t) => t.title);
  const same = JSON.stringify(shown) === JSON.stringify(server);
  if (!same) differ++;
  console.log(JSON.stringify({ run: i + 1, target: arg.target, delay: DELAY, puts, shownBeforeSecondDrag: short(shownBetween), shown: short(shown), server: short(server), same }));
  await ctx.close();
}
console.log(`target=${arg.target} delay=${DELAY}ms: page differs from the server in ${differ} of ${arg.runs} runs`);
await browser.close();
