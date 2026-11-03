// Logs in to the local reproduction app once and saves the storage state that dup-requests.spec.mjs reads.
import { chromium } from "@playwright/test";
const APP = process.env.PAYLOAD_URL ?? "http://localhost:3000";
const OUT = `${process.env.HUNT_OUT}/storageState.json`;
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${APP}/admin/login`);
await page.fill("#field-email", "dev@payloadcms.com");
await page.fill("#field-password", "test");
await page.click("button[type=submit]");
await page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 120000 });
await ctx.storageState({ path: OUT });
console.log("logged in, state saved");
await browser.close();
