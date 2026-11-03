// The identical-in-flight witness with a real server delay (keystone-admin-ui.md section 8, item 2). Not part of any
// test suite. Natural schedule, no bridge (the hello fails at once), createTag held 400 ms by page.route, Enter twice
// 60 ms apart on /tags/create; prints the recorded steps and witnesses.
// Usage: node docs/adoption/hunts/keystone-admin-ui/witness-probe.mjs (from the GenClass-lib root, runtime built)
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const APP = "http://localhost:3000"; const rtDist = new URL("../../../../packages/runtime/dist", import.meta.url).pathname;
const browser = await chromium.launch();
const ctx = await browser.newContext({ bypassCSP: true });
await ctx.addInitScript(() => { window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, devtools: false, visual: false, analytics: false, report: "silent", autoState: false }; window.__GENCLASS_SCHEDULE__ = { order: "natural" }; });
await ctx.route((u) => u.pathname.startsWith("/__genclass/"), (r) => { const f = join(rtDist, new URL(r.request().url()).pathname.slice(12)); return existsSync(f) ? r.fulfill({ status: 200, contentType: "text/javascript", body: readFileSync(f) }) : r.fulfill({ status: 404 }); });
await ctx.route("**/api/graphql", async (r) => { if ((r.request().postData() ?? "").includes("createTag")) await new Promise((x) => setTimeout(x, 400)); return r.fallback(); });
await ctx.route((u) => u.pathname === "/tags/create", async (route) => { const res = await route.fetch(); const html = (await res.text()).replace(/<head[^>]*>/, (m) => `${m}<script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script><script type="module">import { connectAgent } from "/__genclass/agent.js"; window.__C = connectAgent(window.GenClass.runtime, { url: "http://127.0.0.1:1" });</script>`); return route.fulfill({ status: 200, contentType: "text/html", body: html }); });
const page = await ctx.newPage();
await page.goto(`${APP}/tags/create`);
await page.waitForFunction(() => window.__GENCLASS_AGENT__);
const box = page.getByRole("textbox", { name: "Name" });
await box.click(); await box.pressSequentially("dbg tag", { delay: 30 });
await box.press("Enter"); await page.waitForTimeout(60); await box.press("Enter");
await page.waitForURL((u) => u.pathname !== "/tags/create", { timeout: 15000 });
await page.waitForTimeout(1500);
const rec = await page.evaluate(() => ({ steps: window.__GENCLASS_AGENT__.recorded().steps, w: window.__GENCLASS_AGENT__.witnesses() }));
for (const s of rec.steps) console.log(JSON.stringify(s).slice(0, 220));
console.log("witnesses", JSON.stringify(rec.w));
await browser.close();
