// Reproduction WITHOUT GenClass of the SQL Lab autosave lost edit (docs/adoption/hunts/superset-sqllab.md, section 4).
// Not part of CI; run by hand against a local Superset (8088, admin / general).
//
//   node docs/adoption/hunts/superset-sqllab/repro-autosave.mjs [--url http://localhost:8088] [--delay 1500] [--trials 3]
//
// Plain Playwright: log in, open SQL Lab, type statement A, wait out EditorAutoSync's 5 s debounce so the tab state is
// PUT to /tabstateview/<id>, then, while that PUT's response is still on its way (a context route holds ONLY that
// response for --delay ms; the request itself reaches the server at once), type a few more characters (B). Then wait
// two more debounce windows and read three things: how many PUTs were sent and with which sql, the server's copy
// (GET /tabstateview/<id>), and what the editor shows after a reload. --delay 0 is the control (no hold).

import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { formField, login } from "./lib.mjs";

const { values: arg } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8088" },
    user: { type: "string", default: "admin" },
    password: { type: "string", default: "general" },
    delay: { type: "string", default: "0,1500" },
    trials: { type: "string", default: "3" },
    headed: { type: "boolean", default: false },
  },
});
const APP = arg.url.replace(/\/+$/, "");
const A = "SELECT 'alpha' AS v";
const B = " -- bravo";

/** Waits for the SQL Lab editor of the active tab (adds a tab when SQL Lab is empty). */
async function openSqlLab(page) {
  await page.goto(`${APP}/sqllab/`);
  await page.locator('[data-test="sql-editor-tabs"]').waitFor({ timeout: 60_000 });
  const editor = page.locator('[role="tabpanel"]:not([aria-hidden="true"]) .ace_editor:not(.ace_autocomplete)');
  if ((await page.locator(".ace_editor:not(.ace_autocomplete)").count()) === 0) await page.locator('[data-test="add-tab-icon"]').first().click();
  await editor.waitFor({ timeout: 60_000 });
  return editor;
}

const editorText = (editor) => editor.evaluate((el) => window.ace.edit(el).getValue());

async function trial(browser, storageState, delay) {
  const ctx = await browser.newContext({ storageState, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const puts = [];
  await ctx.route(/\/tabstateview\/\d+$/, async (route) => {
    const req = route.request();
    if (req.method() !== "PUT") return route.fallback();
    const rec = { at: Date.now(), sql: formField(req, "sql"), url: req.url() };
    puts.push(rec);
    const res = await route.fetch(); // the server applies the PUT now
    if (delay) await new Promise((r) => setTimeout(r, delay)); // only its response is late
    rec.deliveredAt = Date.now();
    return route.fulfill({ response: res });
  });
  const editor = await openSqlLab(page);
  // make sure no PUT from the page load is pending, then start from a known server state
  await page.waitForTimeout(6_000);
  puts.length = 0;
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(A, { delay: 20 });
  await page.keyboard.press("Escape"); // close the autocomplete popup
  // EditorAutoSync's debounce (5 s after the last change) sends the PUT with A
  const t0 = Date.now();
  while (!puts.length && Date.now() - t0 < 10_000) await page.waitForTimeout(50);
  const firstPutAt = puts[0]?.at;
  await page.waitForTimeout(150); // the user resumes typing 150 ms after the save went out
  await page.keyboard.type(B, { delay: 20 });
  await page.keyboard.press("Escape");
  const typedBAt = Date.now();
  await page.waitForTimeout(Math.max(delay, 0) + 12_000); // two more debounce windows
  const tabUrl = puts[0]?.url;
  const server = tabUrl ? await (await page.request.get(tabUrl)).json() : null;
  const shownBeforeReload = await editorText(editor);
  await page.reload();
  const editor2 = await openSqlLab(page);
  // the editor mounts with the new-tab placeholder before the tab's stored state is applied: wait for the statement
  let shownAfterReload = "";
  for (const t0r = Date.now(); Date.now() - t0r < 20_000; await page.waitForTimeout(250)) {
    shownAfterReload = await editorText(editor2);
    if (shownAfterReload.includes("alpha")) break;
  }
  await page.waitForTimeout(1_000);
  shownAfterReload = await editorText(editor2);
  await ctx.close();
  return {
    delay,
    puts: puts.map((p) => ({ tab: p.url.split("/").pop(), sql: p.sql, sentMs: p.at - firstPutAt, deliveredMs: p.deliveredAt ? p.deliveredAt - firstPutAt : null })),
    typedBMs: typedBAt - firstPutAt,
    serverSql: server?.sql,
    shownBeforeReload,
    shownAfterReload,
    lost: server?.sql !== A + B, // the server's copy decides; the reload is shown beside it
  };
}

const browser = await chromium.launch({ headless: !arg.headed });
const storageState = await login(browser, APP, arg.user, arg.password);
const out = [];
for (const delay of arg.delay.split(",").map(Number)) {
  for (let i = 1; i <= Number(arg.trials); i++) {
    const r = await trial(browser, storageState, delay);
    out.push(r);
    console.log(
      `delay ${delay} ms, trial ${i}: PUTs ${r.puts.length} [${r.puts.map((p) => JSON.stringify(p.sql)).join(", ")}], ` +
        `tabs [${[...new Set(r.puts.map((p) => p.tab))].join(",")}], server ${JSON.stringify(r.serverSql)}, after reload ${JSON.stringify(r.shownAfterReload)} -> ${r.lost ? "EDIT LOST" : "kept"}`,
    );
  }
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
