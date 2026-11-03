// The pin race without GenClass: plain Playwright, nothing injected into the page. Not part of any test suite.
//
//   node docs/adoption/hunts/memos/repro.mjs [--memos http://localhost:3001] [--trials 10] [--delay 1500] [--later 30000]
//     [--memo memos/<uid>] [--out file]
//
// On the memo detail page: More > Pin, then More > Unpin, as two quick clicks. A Playwright route lets every request
// reach the server at once and holds only the reply to the first UpdateMemo (pinned: true) for --delay ms, as a slow
// connection or a busy server would; the second reply (pinned: false) and everything else pass untouched. The server
// therefore saves pin, then unpin, and ends unpinned. The script reads the pinned corner mark (the icon with
// aria-label "Pinned") 3 s after the held reply was delivered and again 30 s later, and GetMemo from the server, in each
// trial; it prints how many trials showed the memo pinned while the server held it unpinned. With --delay 0 nothing is
// held (the control). Each trial starts from a fresh sign-in and an unpinned memo (the seeds from setup.mjs).

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: arg } = parseArgs({
  options: {
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
  await call("UpdateMemo", { memo: { name: target, pinned: false }, updateMask: "pinned" });

  const page = await ctx.newPage();
  let updates = 0;
  let heldDelivered = null;
  await page.route("**/memos.api.MemoService/UpdateMemo", async (route) => {
    const first = updates++ === 0;
    const reply = await route.fetch(); // the request reaches the server now; only the reply waits
    if (first && delay > 0) await sleep(delay);
    await route.fulfill({ response: reply });
    if (first) heldDelivered = Date.now();
  });
  await page.goto(`${M}/${target}`);
  const more = page.getByRole("button", { name: "More" }).first();
  await more.waitFor();
  await page.waitForTimeout(1000); // the page's own first requests and the SSE connection settle
  await more.click();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await more.click();
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  while (heldDelivered === null) await sleep(50);
  await sleep(3000);
  const pinnedMark = () => page.locator('main [role="img"][aria-label="Pinned"]').count().then((n) => n > 0);
  const shownSoon = await pinnedMark();
  const serverSoon = (await call("GetMemo", { name: target })).pinned === true;
  await sleep(Number(arg.later));
  const shownLater = await pinnedMark();
  const serverLater = (await call("GetMemo", { name: target })).pinned === true;
  await ctx.close();
  const t = { trial: i + 1, updates, shownSoon, serverSoon, shownLater, serverLater, stale: shownSoon && !serverSoon, staleLater: shownLater && !serverLater };
  trials.push(t);
  console.log(JSON.stringify(t));
}
await browser.close();
const summary = {
  memos: M,
  delay_ms: delay,
  later_ms: Number(arg.later),
  trials: trials.length,
  stale_after_3s: trials.filter((t) => t.stale).length,
  stale_after_later: trials.filter((t) => t.staleLater).length,
};
console.log(JSON.stringify(summary));
if (arg.out) writeFileSync(arg.out, JSON.stringify({ ...summary, results: trials }, null, 2));
