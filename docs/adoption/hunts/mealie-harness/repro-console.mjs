// Reproduces the stale search results the way a person can by hand, with no tool: the snippet below is pasted into
// the browser console on /g/home (here: page.evaluate after load, which is the same thing). It delays the *sending* of
// any recipe search for exactly "chi" by 2 s, so that request reaches the server after the one for "chicken". Nothing
// else is intercepted; the server answers both normally. Run N times: node repro-console.mjs [runs]
import { chromium } from "playwright";
import { expectedFor } from "./scenarios.mjs";

// The console snippet, verbatim (mealie-pr.md quotes it). Mealie's API client is axios, which uses XMLHttpRequest.
export const SNIPPET = `(() => {
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { this._url = String(url); return open.call(this, method, url, ...rest); };
  XMLHttpRequest.prototype.send = function (body) {
    if (/[?&]search=chi&/.test(this._url)) { setTimeout(() => send.call(this, body), 2000); return; }
    return send.call(this, body);
  };
})();`;

const runs = Number(process.argv[2] ?? 6);
const expected = await expectedFor("chicken");
const browser = await chromium.launch();
const results = [];
for (let i = 0; i < runs; i++) {
  const ctx = await browser.newContext({ storageState: "/home/user/hunt/harness/state.json", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const log = [];
  const t0 = Date.now();
  page.on("request", (r) => /search=chi(cken)?&/.test(r.url()) && log.push(`${/search=chicken&/.test(r.url()) ? "chicken" : "chi"} sent @${Date.now() - t0}`));
  page.on("response", (r) => /search=chi(cken)?&/.test(r.url()) && log.push(`${/search=chicken&/.test(r.url()) ? "chicken" : "chi"} answered @${Date.now() - t0}`));
  await page.goto("http://localhost:3000/g/home", { waitUntil: "load", timeout: 120_000 });
  await page.getByPlaceholder("Press '/'").waitFor();
  await page.evaluate(SNIPPET);
  await page.keyboard.press("/");
  const box = page.locator("#arrow-search");
  await box.pressSequentially("chi", { delay: 90 });
  await page.waitForTimeout(1100);
  await box.pressSequentially("cken", { delay: 90 });
  await page.waitForTimeout(3500); // past the debounce and the delayed request
  const shown = await page.locator(".v-dialog .arrow-nav").evaluateAll((els) => els.map((e) => e.innerText.split("\n")[0].trim()));
  const ok = shown.length === expected.length && shown.every((n, k) => n === expected[k]);
  const extra = shown.filter((n) => !expected.includes(n));
  results.push(ok);
  console.log(`run ${i + 1}: ${ok ? "OK" : "STALE"}: ${shown.length} shown (${expected.length} expected), not for "chicken": ${JSON.stringify(extra.slice(0, 3))}; ${log.join(", ")}`);
  await ctx.close();
}
console.log(JSON.stringify({ runs, stale: results.filter((x) => !x).length }));
await browser.close();
