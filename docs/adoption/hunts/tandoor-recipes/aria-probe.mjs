// One-off: which ancestors of an open VModelSelect menu carry ARIA live-region semantics (the report's section 7).
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { BASE, OUT } from "./seed.mjs";
const fx = JSON.parse((await import("node:fs")).readFileSync(join(OUT, "fixture.json"), "utf8"));
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await b.newContext({ storageState: join(OUT, "state.json"), serviceWorkers: "block" });
const page = await ctx.newPage();
await page.goto(`${BASE}/edit/Recipe/${fx.recipes[0]}`);
const input = page.locator(".v-autocomplete").filter({ hasText: "Keyword" }).locator("input").first();
await input.click();
await page.keyboard.type("b");
await page.waitForTimeout(1500);
console.log(await page.evaluate(() => {
  const el = document.querySelector(".v-overlay-container .v-list-item-title");
  const chain = [];
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    const a = ["role", "aria-live", "aria-atomic", "aria-relevant"].map((k) => e.getAttribute(k) ? `${k}=${e.getAttribute(k)}` : "").filter(Boolean).join(" ");
    chain.push(`${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 2).join(".")} ${a}`);
  }
  return chain.join("\n");
}));
await b.close();
