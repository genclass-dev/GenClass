// Reproduction of advplyr/audiobookshelf#2231 without GenClass: an unsaved edit in the "Edit item" modal is wiped when
// an `item_updated` socket message for the same item arrives while the modal is open.
//
//   node docs/adoption/hunts/audiobookshelf/repro-2231.mjs [--trigger patch|watcher|none] [--runs 3] [--title "Harbor Road"]
//
// Each run: open /item/<id> in a fresh logged-in context, click Edit (the modal opens on Details), type a new title
// without saving, then cause one server-side update of the same item that does not touch the title:
//   patch    another client PATCHes /api/items/<id>/media with a new publisher (what a second tab, a phone app, a
//            Match from another session or a scan does: the server emits item_updated to every client)
//   watcher  write a new notes-<time>.txt into the item's folder on disk; the server's folder watcher rescans the item and emits
//            item_updated (the path the maintainer named in #2231 after a Match writes cover/metadata files)
//   none     control: nothing happens on the server
// then read the title field again. "WIPED" = the unsaved title was replaced by the stored one.
// Prints one line per run and a JSON summary. Needs the server from `npm run dev` and the seed (seed.sh).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WEB, api, chromium, loginState } from "./lib.mjs";

const { values: arg } = parseArgs({
  options: {
    trigger: { type: "string", default: "patch" },
    runs: { type: "string", default: "3" },
    title: { type: "string", default: "Harbor Road" },
    headed: { type: "boolean", default: false },
  },
});

const a = await api();
const lib = await a.library();
const item = await a.itemByTitle(lib.id, arg.title);
if (!item) throw new Error(`no item titled ${arg.title}`);
const original = arg.title;
const browser = await chromium.launch({ headless: !arg.headed });
const storageState = await loginState(browser);
const lines = [];
const tally = { WIPED: 0, KEPT: 0, OTHER: 0 };

for (let run = 1; run <= Number(arg.runs); run++) {
  const ctx = await browser.newContext({ storageState });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/item/${item.id}`);
  await page.locator('button[aria-label="Edit"]:visible').first().click();
  await page.getByRole("tab", { name: "Details" }).click(); // the modal opens on the tab of the button used
  const title = page.getByPlaceholder("Title", { exact: true });
  await title.waitFor();
  await page.waitForFunction((t) => document.querySelector('input[placeholder="Title"]')?.value === t, original);
  const typed = `${original} (my edit ${run})`;
  await title.fill(typed);
  await page.waitForTimeout(300);

  const before = await a.get(`/api/items/${item.id}`);
  const t0 = Date.now();
  if (arg.trigger === "patch") {
    await a.patch(`/api/items/${item.id}/media`, { metadata: { publisher: `Publisher ${run}-${t0}` } });
  } else if (arg.trigger === "watcher") {
    // a new file per run: the watcher reacts to added files (a second write to the same desc.txt was not picked up
    // within 60 s in this hunt)
    writeFileSync(join(before.path, `notes-${t0}.txt`), `Notes written on disk, run ${run} at ${t0}.`);
  }
  // until the server's copy changed (the watcher waits for the folder to settle), then give the socket 1.5 s
  let after = before;
  for (let i = 0; i < 120 && arg.trigger !== "none"; i++) {
    after = await a.get(`/api/items/${item.id}`);
    if (after.updatedAt !== before.updatedAt) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const changedAfterMs = after.updatedAt !== before.updatedAt ? Date.now() - t0 : null;
  await page.waitForTimeout(arg.trigger === "none" ? 3000 : 1500);
  const shown = await title.inputValue();
  const verdict = shown === typed ? "KEPT" : shown === original ? "WIPED" : "OTHER";
  tally[verdict]++;
  const line = `run ${run} trigger=${arg.trigger} server-updated=${changedAfterMs === null ? "no" : `${changedAfterMs}ms`} typed="${typed}" field-now="${shown}" -> ${verdict}`;
  lines.push(line);
  console.log(line);
  await ctx.close();
}
await browser.close();
const summary = { web: WEB, trigger: arg.trigger, item: original, runs: Number(arg.runs), ...tally };
console.log(JSON.stringify(summary));
