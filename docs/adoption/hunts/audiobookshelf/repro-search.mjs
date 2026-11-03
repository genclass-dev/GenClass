// Reproduction without GenClass of the global search's overlap problem (client/components/controls/GlobalSearch.vue
// runSearch): when a search is still in flight as the next one starts, the first response to arrive clears the shared
// isFetching flag and the second response is dropped as "canceled", whichever query it answers.
//
//   node docs/adoption/hunts/audiobookshelf/repro-search.mjs [--hold-har 1500] [--hold-harmony 1500] [--runs 3]
//
// Each run: library page, type "Har" in the global search, wait 800 ms (the box's debounce is 750 ms, so the "Har"
// search is sent), type "mony" (the "Harmony" search is sent 750 ms later), wait, read the menu.
// A Playwright route holds each search response for the given time (a slow server or network):
//   --hold-har 1500 --hold-harmony 1500   both slow: the two searches overlap and arrive in request order
//   --hold-har 3000 --hold-harmony 0      the "Har" response arrives after the "Harmony" one (reversed)
//   --hold-har 0 --hold-harmony 0         nothing held (control: the searches do not overlap)
// "STALE" = the menu lists a book without "Harmony" in its title while the box says "Harmony".

import { parseArgs } from "node:util";
import { WEB, api, chromium, loginState } from "./lib.mjs";

const { values: arg } = parseArgs({ options: { "hold-har": { type: "string", default: "1500" }, "hold-harmony": { type: "string", default: "1500" }, runs: { type: "string", default: "3" } } });
const hold = { Har: Number(arg["hold-har"]), Harmony: Number(arg["hold-harmony"]) };
const a = await api();
const lib = await a.library();
const browser = await chromium.launch();
const storageState = await loginState(browser);
const tally = { STALE: 0, ok: 0 };
for (let run = 1; run <= Number(arg.runs); run++) {
  const ctx = await browser.newContext({ storageState });
  const page = await ctx.newPage();
  const sent = [];
  await page.route("**/api/libraries/*/search?*", async (r) => {
    const q = new URL(r.request().url()).searchParams.get("q");
    sent.push(q);
    const resp = await r.fetch();
    if (hold[q]) await new Promise((res) => setTimeout(res, hold[q]));
    await r.fulfill({ response: resp });
  });
  await page.goto(`${WEB}/library/${lib.id}`);
  const box = page.locator('input[placeholder="Search.."]:visible').first();
  await box.click();
  await box.pressSequentially("Har", { delay: 40 });
  await page.waitForTimeout(800);
  await box.pressSequentially("mony", { delay: 40 });
  await page.waitForTimeout(800 + Math.max(hold.Har, hold.Harmony) + 1500);
  const shown = (await page.locator(".globalSearchMenu li[role=option]").allInnerTexts()).map((t) => t.split("\n")[0].trim()).filter(Boolean);
  const books = shown.filter((t) => !/^Author/.test(t));
  const stale = books.filter((t) => !/harmony/i.test(t));
  const verdict = stale.length ? "STALE" : "ok";
  tally[verdict]++;
  console.log(`run ${run} hold Har=${hold.Har}ms Harmony=${hold.Harmony}ms sent=[${sent.join(", ")}] box="${await box.inputValue()}" menu=[${books.join(" | ")}] -> ${verdict}`);
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify({ hold, ...tally }));
