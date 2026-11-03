// The two races without GenClass: plain Playwright, nothing injected into the page. Not part of any test suite.
//
//   node docs/adoption/hunts/memos/repro.mjs --surface pin|reaction [--memos http://localhost:3001] [--trials 10]
//     [--delay 1500] [--later 30000] [--memo memos/<uid>] [--out file]
//
// Both run on the memo detail page and let every request reach the server at once; a Playwright route holds only one
// reply for --delay ms, as a slow connection or a busy server would. --delay 0 holds nothing (the control).
//
//   pin       More > Pin, then More > Unpin. Held: the reply to the first UpdateMemo (pinned: true). The server saves
//             pin, then unpin, and ends unpinned. Read: the pinned corner mark (the icon with aria-label "Pinned").
//   reaction  Add reaction > 👍, then Add reaction > ❤️ (the picker opened again). Held: the reply to the GetMemo that
//             the 👍 click sends after its upsert (it was answered with 👍 only). The server ends with both. Read: the
//             reaction pills.
//
// Each trial starts from a fresh sign-in and the memo reset (unpinned, no reactions). The page is read 3 s after the
// held reply was delivered and again --later ms after that, next to GetMemo from the server; the script prints how
// many trials showed something other than what the server held.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: arg } = parseArgs({
  options: {
    surface: { type: "string", default: "pin" },
    memos: { type: "string", default: "http://localhost:3001" },
    user: { type: "string", default: "hunter" },
    password: { type: "string", default: "hunt-pass-1" },
    seeds: { type: "string", default: `${process.env.HOME}/targets/memos-state-memos.json` },
    trials: { type: "string", default: "10" },
    delay: { type: "string", default: "1500" },
    later: { type: "string", default: "30000" },
    memo: { type: "string", default: "" },
    out: { type: "string", default: "" },
  },
});
const M = arg.memos.replace(/\/+$/, "");
const target = arg.memo || JSON.parse(readFileSync(arg.seeds, "utf8")).target; // --memo memos/<uid>: another memo
const delay = Number(arg.delay);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const surfaces = {
  pin: {
    held: "UpdateMemo",
    // hold the first UpdateMemo reply
    hold: (method, state) => method === "UpdateMemo" && state.updates++ === 0,
    async steps(page) {
      const more = page.getByRole("button", { name: "More" }).first();
      await more.click();
      await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
      await more.click();
      await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
    },
    shown: async (page) => `pinned=${(await page.locator('main [role="img"][aria-label="Pinned"]').count()) > 0}`,
    server: (memo) => `pinned=${memo.pinned === true}`,
  },
  reaction: {
    held: "GetMemo after the first upsert",
    // hold the first GetMemo sent after the first reaction's upsert was answered
    hold: (method, state) => {
      if (method === "UpsertMemoReaction") state.upserts++;
      if (method === "GetMemo" && state.upserts === 1 && !state.taken) return (state.taken = true);
      return false;
    },
    async steps(page) {
      const card = page.locator("main article, main .group\\/memo").first();
      const open = async () => {
        await page.keyboard.press("Escape");
        await card.hover();
        await page.getByRole("button", { name: "Add reaction" }).first().click();
      };
      await open();
      await page.getByRole("button", { name: "👍", exact: true }).click();
      await page.waitForTimeout(300); // the 👍 upsert is answered and its GetMemo is on the wire
      await open();
      await page.getByRole("button", { name: "❤️", exact: true }).click();
    },
    shown: async (page) =>
      `reactions=${
        (await page.locator("main button[aria-pressed]").evaluateAll((els) => els.map((b) => b.textContent.replace(/\s+/g, "")).join(" "))) ||
        "none"
      }`,
    server: (memo) =>
      `reactions=${
        Object.entries((memo.reactions ?? []).reduce((acc, r) => ({ ...acc, [r.reactionType]: (acc[r.reactionType] ?? 0) + 1 }), {}))
          .map(([k, n]) => `${k}${n}`)
          .join(" ") || "none"
      }`,
  },
};
const s = surfaces[arg.surface];
if (!s) throw new Error(`unknown surface ${arg.surface}`);

const browser = await chromium.launch();
const trials = [];
for (let i = 0; i < Number(arg.trials); i++) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const signIn = await ctx.request.post(`${M}/memos.api.AuthService/SignIn`, {
    data: { passwordCredentials: { username: arg.user, password: arg.password } },
  });
  const { accessToken } = await signIn.json();
  const call = async (method, body) =>
    (await ctx.request.post(`${M}/memos.api.MemoService/${method}`, { data: body, headers: { Authorization: `Bearer ${accessToken}` } })).json();
  const before = await call("GetMemo", { name: target });
  if (before.pinned) await call("UpdateMemo", { memo: { name: target, pinned: false }, updateMask: "pinned" });
  for (const r of before.reactions ?? []) await call("DeleteMemoReaction", { name: r.name });

  const page = await ctx.newPage();
  const state = { updates: 0, upserts: 0, taken: false, armed: false };
  let heldDelivered = null;
  await page.route("**/memos.api.MemoService/*", async (route) => {
    const method = route.request().url().split("/").pop();
    const held = state.armed && s.hold(method, state);
    const reply = await route.fetch(); // the request reaches the server now; only the reply waits
    if (held && delay > 0) await sleep(delay);
    await route.fulfill({ response: reply });
    if (held) heldDelivered = Date.now();
  });
  await page.goto(`${M}/${target}`);
  await page.getByRole("button", { name: "More" }).first().waitFor();
  await page.waitForTimeout(1000); // the page's own first requests and the SSE connection settle
  state.armed = true;
  let shownSoon = "ERROR";
  let shownLater = "ERROR";
  let serverSoon = "";
  let serverLater = "";
  try {
    await s.steps(page);
    for (let w = 0; heldDelivered === null && w < 400; w++) await sleep(50);
    await sleep(3000);
    shownSoon = await s.shown(page);
    serverSoon = s.server(await call("GetMemo", { name: target }));
    await sleep(Number(arg.later));
    shownLater = await s.shown(page);
    serverLater = s.server(await call("GetMemo", { name: target }));
  } catch (e) {
    shownSoon = `ERROR ${String(e).split("\n")[0]}`;
  }
  await ctx.close();
  const t = { trial: i + 1, shownSoon, serverSoon, shownLater, serverLater, stale: shownSoon !== serverSoon, staleLater: shownLater !== serverLater };
  trials.push(t);
  console.log(JSON.stringify(t));
}
await browser.close();
const summary = {
  surface: arg.surface,
  memos: M,
  held: s.held,
  delay_ms: delay,
  later_ms: Number(arg.later),
  trials: trials.length,
  stale_after_3s: trials.filter((t) => t.stale).length,
  stale_after_later: trials.filter((t) => t.staleLater).length,
};
console.log(JSON.stringify(summary));
if (arg.out) writeFileSync(arg.out, JSON.stringify({ ...summary, results: trials }, null, 2));
