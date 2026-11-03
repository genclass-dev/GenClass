// Seeds a local Linkwarden for the race hunt (docs/adoption/hunts/linkwarden.md). Not part of CI.
//
//   node docs/adoption/hunts/linkwarden/seed.mjs [--base http://localhost:3000] [--links 120]
//
// Creates the user test/password through POST /api/v1/users (what apps/web/e2e/data/user.ts does), logs in through
// the login form, then creates three collections and --links links through the app's own API. Links use the reserved
// .test TLD, so nothing outside this machine is contacted; without the worker every link stays "pending", which keeps
// the 5 s preservation polling of the list and the link page running. Writes the session to storage-state.json next
// to this file (gitignored by the hunt: it holds a session cookie for the local instance only).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const { values: arg } = parseArgs({
  options: { base: { type: "string", default: "http://localhost:3000" }, links: { type: "string", default: "120" } },
});
const B = arg.base;

const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: B });
const reg = await ctx.request.post("/api/v1/users", { data: { username: "test", password: "password", name: "Test User" } });
console.log("register", reg.status());
const page = await ctx.newPage();
await page.goto("/login");
await page.getByTestId("username-input").fill("test");
await page.getByTestId("password-input").fill("password");
await page.getByTestId("submit-login-button").click();
await page.getByTestId("dashboard-wrapper").waitFor({ timeout: 120_000 });
await ctx.storageState({ path: join(here, "storage-state.json") });

const existing = (await (await ctx.request.get("/api/v1/collections")).json()).response;
const want = ["Reading", "Research", "Recipes"];
const cols = {};
for (const c of existing) cols[c.name] = c.id;
for (const name of want) {
  if (cols[name]) continue;
  const r = await ctx.request.post("/api/v1/collections", { data: { name } });
  cols[name] = (await r.json()).response.id;
}
const have = (await (await ctx.request.get("/api/v1/search?cursor=0")).json()).data.links.length;
const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
for (let i = have; i < Number(arg.links); i++) {
  const w = words[i % words.length];
  const r = await ctx.request.post("/api/v1/links", {
    data: {
      url: `https://${w}-${i}.example.test/page`,
      name: `${w} article ${i}`,
      description: `seeded link ${i}`,
      collection: { id: cols[want[i % 3]], name: want[i % 3] },
      tags: [{ name: w }],
    },
  });
  if (!r.ok()) throw new Error(`link ${i}: HTTP ${r.status()} ${await r.text()}`);
}
console.log("collections", cols);
console.log("links", (await (await ctx.request.get("/api/v2/dashboard")).json()).data?.numberOfLinks ?? "?");
await browser.close();
