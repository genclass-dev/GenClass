// Reproductions WITHOUT GenClass of the two client-side surfaces the brief named (superset-sqllab.md, section 3):
// Format SQL with a late response, and a double click on the Save query modal's Save. Not part of CI.
//
//   node docs/adoption/hunts/superset-sqllab/repro-format-save.mjs format [--delay 0,300,900,1500] [--trials 3] [--user hunt2]
//   node docs/adoption/hunts/superset-sqllab/repro-format-save.mjs save   [--delay 0,300,900] [--trials 3] [--user hunt2]
//
// format: type statement A, press Ctrl+Shift+F (SqlEditor's formatQuery hotkey), and 150 ms after the POST
//   /api/v1/sqllab/format_sql/ went out append " -- bravo"; a context route holds only that response for --delay ms.
//   Oracle: does the editor still hold "bravo" 3 s later?
// save: type a statement, run it, open Save, click the modal's Save button twice 150 ms apart, with the POST /api/v1/saved_query/ response held --delay ms. Oracle: how many POSTs, how many saved queries
//   with that label (GET /api/v1/saved_query/).

import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { login } from "./lib.mjs";

const { values: arg, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "http://localhost:8088" },
    user: { type: "string", default: "hunt2" },
    password: { type: "string", default: "general" },
    delay: { type: "string", default: "0,300,900,1500" },
    trials: { type: "string", default: "3" },
  },
});
const what = positionals[0] ?? "format";
const APP = arg.url.replace(/\/+$/, "");
const A = "select 'alpha' as v from (select 1) t";
const B = " -- bravo";
const editorSel = '[role="tabpanel"]:not([aria-hidden="true"]) .ace_editor:not(.ace_autocomplete)';

async function openSqlLab(page) {
  await page.goto(`${APP}/sqllab/`);
  await page.locator('[data-test="sql-editor-tabs"]').waitFor({ timeout: 60_000 });
  if ((await page.locator(".ace_editor:not(.ace_autocomplete)").count()) === 0) await page.locator('[data-test="add-tab-icon"]').first().click();
  await page.locator(editorSel).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1_500);
}
async function typeA(page, text = A) {
  await page.locator(editorSel).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press("Escape");
}
const editorText = (page) => page.locator(editorSel).evaluate((el) => window.ace.edit(el).getValue());

async function holdRoute(ctx, pattern, delay, seen) {
  await ctx.route(pattern, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    seen.push(Date.now());
    const res = await route.fetch();
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return route.fulfill({ response: res });
  });
}

async function formatTrial(browser, storageState, delay) {
  const ctx = await browser.newContext({ storageState, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const seen = [];
  await holdRoute(ctx, /\/api\/v1\/sqllab\/format_sql\/?$/, delay, seen);
  await openSqlLab(page);
  await typeA(page);
  await page.keyboard.press("Control+Shift+F");
  for (const t0 = Date.now(); !seen.length && Date.now() - t0 < 5_000; ) await page.waitForTimeout(25);
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+End");
  await page.keyboard.type(B, { delay: 20 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(delay + 3_000);
  const shown = await editorText(page);
  await ctx.close();
  return { delay, posts: seen.length, shown, lost: !shown.includes("bravo") };
}

async function saveTrial(browser, storageState, delay, n) {
  const ctx = await browser.newContext({ storageState, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const seen = [];
  await holdRoute(ctx, /\/api\/v1\/saved_query\/?$/, delay, seen);
  await openSqlLab(page);
  const label = `hunt dbl ${Date.now()}-${n}`;
  await typeA(page, "SELECT 1 AS v");
  // as the project's own spec does ("saves a query and loads it from saved queries"): run the query, then Save
  await page.keyboard.press("Control+Enter");
  await page.locator('[role="tabpanel"]:not([aria-hidden="true"]) [data-test="south-pane"] [role="grid"]').waitFor({ timeout: 60_000 });
  await page.locator(`[role="tabpanel"]:not([aria-hidden="true"]) button[aria-label="Save"]`).click();
  const modal = page.locator(".save-query-modal");
  await modal.waitFor();
  await modal.locator('input[type="text"]').first().fill(label);
  // two clicks 150 ms apart (a person's double click; Playwright's dblclick puts them a few ms apart)
  const save = modal.getByRole("button", { name: /^Save( as new)?$/ }); // "Save as new" once the tab holds a saved query
  await save.click();
  await page.waitForTimeout(150);
  await save.click({ timeout: 2_000 }).catch(() => {}); // the modal may already be gone
  await page.waitForTimeout(delay + 3_000);
  const q = encodeURIComponent(JSON.stringify({ filters: [{ col: "label", opr: "eq", value: label }] }));
  const list = await (await ctx.request.get(`${APP}/api/v1/saved_query/?q=${q}`)).json();
  await ctx.close();
  return { delay, posts: seen.length, saved: list.count, duplicated: list.count > 1 };
}

const browser = await chromium.launch();
const storageState = await login(browser, APP, arg.user, arg.password);
const out = [];
for (const delay of arg.delay.split(",").map(Number)) {
  for (let i = 1; i <= Number(arg.trials); i++) {
    const r = what === "save" ? await saveTrial(browser, storageState, delay, i) : await formatTrial(browser, storageState, delay);
    out.push(r);
    console.log(
      what === "save"
        ? `save, delay ${delay} ms, trial ${i}: POSTs ${r.posts}, saved queries with the label ${r.saved} -> ${r.duplicated ? "DUPLICATED" : "one"}`
        : `format, delay ${delay} ms, trial ${i}: POSTs ${r.posts}, editor ${JSON.stringify(r.shown)} -> ${r.lost ? "TYPED TEXT LOST" : "kept"}`,
    );
  }
}
await browser.close();
console.log(JSON.stringify(out));
