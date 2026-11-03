// Reproduction WITHOUT GenClass of the Navidrome rating race (docs/adoption/hunts/navidrome.md, section 4).
// Not part of CI. Plain Playwright against a local `make dev` (http://localhost:4533, admin / password).
//
//   node docs/adoption/hunts/navidrome/repro.mjs [--runs 5] [--delay 800] [--mode stale|none|fast] [--url ...]
//
// What a person does: in the Songs list, rate a song 3 stars, then (a moment later, before the stars have changed)
// 5 stars. What the network does: the refresh the UI sends after the first rating (GET /api/song/:id) is answered by
// the server at once (rating 3, the second rating has not been sent yet) but reaches the page `--delay` ms late, as on
// a slow or congested link. Nothing else is touched: every other request and response passes unchanged.
//
// Modes:
//   stale  (default) the first GET /api/song/:id is fetched from the server immediately and fulfilled after --delay ms;
//          the second star is clicked once the server has answered that first refresh
//   none   control: the same clicks with the same wait between them, no delay on any response
//   fast   the two clicks back to back (no wait for the first refresh), the first refresh delayed as in `stale`
//
// The oracle, read after the page is quiet: the stars the row shows (the checked radio of the MUI Rating) and the
// rating the server has (GET /api/song/:id with the page's own token). "stale" = they differ.

import { chromium } from "@playwright/test";
import { parseArgs } from "node:util";

const { values: arg } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:4533" },
    runs: { type: "string", default: "5" },
    delay: { type: "string", default: "800" },
    mode: { type: "string", default: "stale" },
    user: { type: "string", default: "admin" },
    password: { type: "string", default: "password" },
    row: { type: "string", default: "0" },
    start: { type: "string", default: "1" },
  },
});
const APP = arg.url.replace(/\/+$/, "");
const DELAY = Number(arg.delay);
const START = Number(arg.start);

const browser = await chromium.launch();

async function login() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${APP}/`);
  await p.locator('input[name="username"]').fill(arg.user);
  await p.locator('input[name="password"]').fill(arg.password);
  await p.locator('button[type="submit"]').click();
  await p.waitForFunction(() => !!localStorage.getItem("token"));
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

/** The song's rating as the server has it, read with the page's own JWT. */
async function serverRating(page, id) {
  return page.evaluate(async (id) => {
    const r = await fetch(`/api/song/${id}`, { headers: { "x-nd-authorization": `Bearer ${localStorage.getItem("token")}` } });
    return (await r.json()).rating ?? 0;
  }, id);
}

/** The stars the row paints: the filled icons of its MUI Rating (blurred and with the mouse away, so neither the focus nor the hover preview shows). */
async function shownRating(page, id) {
  return page.evaluate((id) => {
    // a focused MUI Rating paints its focused star, not its value: blur first (as clicking elsewhere would)
    document.activeElement?.blur?.();
    const input = document.querySelector(`input[type="radio"][name="${id}"]`);
    const root = input?.closest(".MuiRating-root");
    return root ? root.querySelectorAll(".MuiRating-iconFilled").length : -1;
  }, id);
}

async function run(state, mode, i) {
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${APP}/#/song`);
  const row = page.locator("tbody tr").nth(Number(arg.row));
  await row.waitFor();
  const id = await row.locator('input[type="radio"]').first().getAttribute("name");
  // reset the song to 1 star through the Subsonic API the UI itself uses, outside the page. Not 0: the API omits
  // `rating` for an unrated song, so the MUI Rating mounts with value undefined, i.e. uncontrolled, and then paints its
  // own click state whatever the store says (a separate quirk, report section 5)
  await page.evaluate(async ([id, start]) => {
    const q = new URLSearchParams({ u: localStorage.getItem("username"), t: localStorage.getItem("subsonic-token"), s: localStorage.getItem("subsonic-salt"), v: "1.16.1", c: "repro", f: "json", id, rating: String(start) });
    await fetch(`/rest/setRating?${q}`);
  }, [id, START]);
  await page.reload();
  await row.waitFor();

  let refreshes = 0;
  let firstAnswered;
  const answered = new Promise((r) => (firstAnswered = r));
  await page.route(`**/api/song/${id}`, async (route) => {
    const n = ++refreshes;
    if (mode === "none" || n > 1) return route.fallback();
    const res = await route.fetch(); // the server answers now, with what it has now
    const body = await res.text();
    firstAnswered(JSON.parse(body).rating ?? 0);
    await new Promise((r) => setTimeout(r, DELAY)); // ...and the answer reaches the page late
    return route.fulfill({ response: res, body });
  });
  if (mode === "none") {
    page.on("response", (r) => {
      if (r.url().endsWith(`/api/song/${id}`)) r.json().then((j) => firstAnswered(j.rating ?? 0), () => firstAnswered(-1));
    });
  }

  const t0 = Date.now();
  if (process.env.REPRO_DEBUG) {
    const tag = (r) => `${r.method()} ${new URL(r.url()).pathname}${r.url().includes("rating=") ? "?rating=" + new URL(r.url()).searchParams.get("rating") : ""}`;
    page.on("request", (r) => /\/(api|rest)\//.test(r.url()) && console.log(`  +${Date.now() - t0}ms request ${tag(r)}`));
    page.on("requestfinished", (r) => /\/(api|rest)\//.test(r.url()) && console.log(`  +${Date.now() - t0}ms finished ${tag(r)}`));
  }
  await row.hover();
  await row.locator(`label[for="${id}-3"]`).click();
  const firstSaw = mode === "fast" ? null : await answered;
  await row.locator(`label[for="${id}-5"]`).click();
  await page.mouse.move(5, 5); // hover changes the stars a Rating paints, never its checked radio; move away anyway
  if (process.env.REPRO_DEBUG) {
    for (let k = 0; k < 20; k++) {
      console.log(`  +${Date.now() - t0}ms shown ${await shownRating(page, id)}`);
      await page.waitForTimeout(100);
    }
  }
  await page.waitForTimeout(DELAY + 1500);
  const shown = await shownRating(page, id);
  const server = await serverRating(page, id);
  await ctx.close();
  return { run: i + 1, mode, firstRefreshSaw: firstSaw, shown, server, stale: shown !== server };
}

const state = await login();
const results = [];
for (let i = 0; i < Number(arg.runs); i++) {
  const r = await run(state, arg.mode, i);
  results.push(r);
  console.log(JSON.stringify(r));
}
const stale = results.filter((r) => r.stale).length;
console.log(`mode=${arg.mode} delay=${DELAY}ms: the row showed a rating the server does not have in ${stale} of ${results.length} runs`);
await browser.close();
