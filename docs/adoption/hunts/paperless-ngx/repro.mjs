// Reproduction without GenClass for docs/adoption/hunts/paperless-ngx.md: plain Playwright against the project's own
// disposable instance (src-ui `pnpm e2e:backend` on :8001, `pnpm start:e2e` on :4200). Nothing from GenClass is loaded;
// a slow response is made with page.route (the response is fetched from the real backend, held, then delivered
// unchanged). Each case runs --n times in a fresh browser context and prints how many ended wrong.
//
//   node docs/adoption/hunts/paperless-ngx/repro.mjs [--n 5] [--case search,search-control,escape,...]
//
// Cases:
//   search          global search: "doc" answered 1.5 s late, "document 12" at once; type "doc", pause 450 ms (the
//                   400 ms debounce fires), type "ument 12"; wrong if the dropdown does not list exactly "document 12"
//   search-control  the same steps, no delay
//   escape          "doc" answered 1 s late; type "doc", pause 450 ms, press Escape (clears the box); wrong if the
//                   results dropdown is open under the empty box after the response
//   escape-control  the same steps, no delay
//   notes-double    Notes tab of document 1, POST answered 300 ms late; type a note, Ctrl+Enter twice 40 ms apart;
//                   wrong if the server holds the note twice
//   notes-single    the same with one Ctrl+Enter (control)
//   notes-order     two Ctrl+Enter, the first POST answered 1.2 s late, the second at once; wrong if the page lists
//                   fewer notes than the server holds
//   names           GET /api/users/ answered 2 s late; open the Notes tab; wrong if the notes show no author name
//   names-control   the same, no delay
// The notes cases delete the notes they add through the API after each run.

import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: arg } = parseArgs({
  options: {
    ui: { type: "string", default: "http://localhost:4200" },
    api: { type: "string", default: "http://localhost:8001" },
    n: { type: "string", default: "5" },
    case: { type: "string", default: "search,search-control,escape,escape-control,notes-double,notes-single,notes-order,names,names-control" },
  },
});
const UI = arg.ui;
const API = arg.api;
const H = { Referer: `${UI}/`, Accept: "application/json; version=10" };
const api = async (path, init = {}) => {
  const r = await fetch(`${API}/api/${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  return r.status === 204 ? null : r.json();
};
const NOTE = "repro note: checked the totals";
const cleanNotes = async () => {
  for (const n of (await api("documents/1/notes/")).filter((n) => n.note === NOTE)) await api(`documents/1/notes/?id=${n.id}`, { method: "DELETE" });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Holds matching responses: delay(request, nth) returns the extra ms for the nth matching request (0-based).
async function slow(page, pattern, delay) {
  let nth = 0;
  await page.route(pattern, async (route) => {
    const ms = delay(route.request(), nth++);
    const resp = await route.fetch();
    if (ms) await sleep(ms);
    await route.fulfill({ response: resp });
  });
}

const searchBox = (page) => page.locator("pngx-global-search input[name=query]");
const shownTitles = (page) =>
  page.locator("pngx-global-search .dropdown-menu .dropdown-item .text-truncate").evaluateAll((els) => els.map((e) => (e.firstChild?.textContent ?? e.textContent).trim()));

const cases = {
  async search(page, delayed = true) {
    if (delayed) await slow(page, "**/api/search/**", (req) => (new URL(req.url()).searchParams.get("query") === "doc" ? 1500 : 0));
    await page.goto(`${UI}/dashboard`);
    const box = searchBox(page);
    await box.waitFor();
    await page.waitForTimeout(1000);
    await box.click();
    await box.pressSequentially("doc", { delay: 60 });
    await page.waitForTimeout(450);
    await box.pressSequentially("ument 12", { delay: 30 });
    await page.waitForTimeout(2500);
    const shown = await shownTitles(page);
    const value = await box.inputValue();
    return { wrong: !(shown.length === 1 && shown[0] === "document 12"), text: `input "${value}", dropdown [${shown.join(", ")}]` };
  },
  "search-control": (page) => cases.search(page, false),
  async escape(page, delayed = true) {
    if (delayed) await slow(page, "**/api/search/**", () => 1000);
    await page.goto(`${UI}/dashboard`);
    const box = searchBox(page);
    await box.waitFor();
    await page.waitForTimeout(1000);
    await box.click();
    await box.pressSequentially("doc", { delay: 60 });
    await page.waitForTimeout(450);
    await box.press("Escape");
    const afterEscape = await box.inputValue();
    await page.waitForTimeout(1500);
    const open = await page.locator("pngx-global-search .dropdown-menu.show").count();
    const shown = await shownTitles(page);
    return {
      wrong: open > 0 && (await box.inputValue()) === "",
      text: `after Escape input "${afterEscape}"; then input "${await box.inputValue()}", dropdown ${open ? "open" : "closed"} [${shown.join(", ")}]`,
    };
  },
  "escape-control": (page) => cases.escape(page, false),
  async notesDouble(page, { presses, delay }) {
    await cleanNotes();
    await slow(page, "**/api/documents/1/notes/**", (req, nth) => (req.method() === "POST" ? delay(nth) : 0));
    await page.goto(`${UI}/documents/1/notes`);
    const area = page.locator("pngx-document-notes textarea");
    await area.waitFor();
    await page.waitForTimeout(1000);
    await area.fill(NOTE);
    for (let i = 0; i < presses; i++) {
      if (i) await page.waitForTimeout(40);
      await area.press("Control+Enter");
    }
    await page.waitForTimeout(2500);
    const all = await api("documents/1/notes/");
    const held = all.filter((n) => n.note === NOTE).length;
    const listedAll = await page.locator("pngx-document-notes .card-text").count();
    const tab = (await page.getByRole("tab", { name: /Notes/ }).innerText().catch(() => "?")).replace(/\s+/g, " ");
    await cleanNotes();
    return { held, listedAll, total: all.length, tab };
  },
  async "notes-double"(page) {
    const r = await cases.notesDouble(page, { presses: 2, delay: () => 300 });
    return { wrong: r.held !== 1, text: `server holds the note ${r.held}x; page lists ${r.listedAll} of ${r.total} notes; tab "${r.tab}"` };
  },
  async "notes-single"(page) {
    const r = await cases.notesDouble(page, { presses: 1, delay: () => 300 });
    return { wrong: r.held !== 1, text: `server holds the note ${r.held}x; page lists ${r.listedAll} of ${r.total} notes; tab "${r.tab}"` };
  },
  async "notes-order"(page) {
    const r = await cases.notesDouble(page, { presses: 2, delay: (nth) => (nth === 0 ? 1200 : 0) });
    return { wrong: r.listedAll !== r.total, text: `server holds ${r.total} notes (the new one ${r.held}x); page lists ${r.listedAll}; tab "${r.tab}"` };
  },
  async names(page, delayed = true) {
    if (delayed) await slow(page, "**/api/users/**", () => 2000);
    await page.goto(`${UI}/documents/1/notes`);
    await page.locator("pngx-document-notes .card-text").first().waitFor();
    await page.waitForTimeout(3500);
    const footers = await page.locator("pngx-document-notes .card-footer span").allInnerTexts();
    return { wrong: footers.some((f) => !/^\S.* - /.test(f)), text: `footers [${footers.join(" | ")}]` };
  },
  "names-control": (page) => cases.names(page, false),
};

const browser = await chromium.launch();
const totals = {};
for (const name of arg.case.split(",")) {
  const fn = cases[name];
  if (!fn) throw new Error(`unknown case ${name}`);
  let wrong = 0;
  for (let i = 0; i < Number(arg.n); i++) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    let r;
    try {
      r = await fn(page);
    } catch (e) {
      r = { wrong: null, text: `ERROR ${String(e).split("\n")[0]}` };
    }
    if (r.wrong) wrong++;
    console.log(`${name} #${i + 1}: ${r.wrong ? "WRONG" : r.wrong === false ? "ok" : "?"} ${r.text}`);
    await ctx.close();
  }
  totals[name] = `${wrong} of ${arg.n} wrong`;
}
await browser.close();
console.log(JSON.stringify(totals));
