// Seeds a fresh local Memos instance for the race hunt (docs/adoption/hunts/memos.md). Not part of CI.
//
//   node docs/adoption/hunts/memos/setup.mjs [--memos http://localhost:3001] [--user hunter] [--password hunt-pass-1]
//     [--state <file>] [--count 60]
//
// First run of an instance: creates the owner account through /auth/signup (the page every fresh instance redirects
// to), then seeds memos over the app's own Connect JSON API from inside the signed-in page (a refresh-token cookie,
// then a bearer access token, as web/src/connect.ts does): one memo with a task list for the check-all surface, one
// "race target" memo for pin, archive and reactions, and --count filler memos so the home list paginates. Later runs
// sign in instead. Writes the Playwright storage state (the refresh cookie) to --state and prints the memo names.

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: arg } = parseArgs({
  options: {
    memos: { type: "string", default: "http://localhost:3001" },
    user: { type: "string", default: "hunter" },
    password: { type: "string", default: "hunt-pass-1" },
    state: { type: "string", default: `${process.env.HOME}/targets/memos-state.json` },
    count: { type: "string", default: "60" },
  },
});
const M = arg.memos.replace(/\/+$/, "");

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${M}/`);
await page.waitForLoadState("networkidle");
if (page.url().includes("/auth/signup")) {
  await page.fill("#signup-username", arg.user);
  await page.fill("#signup-password", arg.password);
  await page.getByRole("button", { name: /create admin account/i }).click();
} else if (page.url().includes("/auth")) {
  await page.locator('input[autocomplete="username"]').fill(arg.user);
  await page.locator('input[type="password"]').fill(arg.password);
  await page.getByRole("button", { name: /sign in/i }).click();
}
await page.waitForURL((u) => !u.pathname.startsWith("/auth"), { timeout: 15_000 });

const names = await page.evaluate(async (count) => {
  const call = async (method, body, token) => {
    const r = await fetch(`/memos.api.${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      credentials: "include",
    });
    if (r.status === 429) {
      // The server limits writes to 120 per user per minute (RATE_LIMITED, write_user): wait out the window.
      await new Promise((done) => setTimeout(done, 31_000));
      return call(method, body, token);
    }
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status} ${await r.text()}`);
    return r.json();
  };
  const { accessToken } = await call("AuthService/RefreshToken", {});
  const make = (content) => call("MemoService/CreateMemo", { memo: { content, visibility: "PRIVATE" } }, accessToken);
  for (let i = 0; i < count; i++) await make(`filler memo ${i} #seed`);
  const tasks = await make("race tasks memo\n\n- [ ] first task\n- [ ] second task\n- [ ] third task");
  const target = await make("race target memo for pin, archive and reactions");
  return { tasks: tasks.name, target: target.name };
}, Number(arg.count));

await ctx.storageState({ path: arg.state });
await browser.close();
console.log(JSON.stringify({ state: arg.state, ...names }));
writeFileSync(arg.state.replace(/\.json$/, "-memos.json"), JSON.stringify(names));
