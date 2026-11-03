// Saves a logged-in admin session (Playwright storageState) for ../strapi/repro-403.mjs, through the admin's own login
// form, against the test app of Strapi's e2e harness (docs/adoption/hunts/strapi.md, "Refresh (2026-11-03)"). No
// GenClass. Run it from a directory whose node_modules resolves @playwright/test (the refresh used a folder with a
// node_modules symlink to the Strapi monorepo's, Playwright 1.56.1), with PLAYWRIGHT_BROWSERS_PATH pointing at a
// Chromium that version accepts.
//
//   STRAPI_URL=http://127.0.0.1:8000 HUNT_OUT=$PWD/out STRAPI_EMAIL=test@testing.com STRAPI_PASSWORD='Testing123!' \
//     node login.mjs
//   node repro-403.mjs 1500 3

import { chromium } from "@playwright/test";

const APP = (process.env.STRAPI_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const OUT = process.env.HUNT_OUT ?? "./out";

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(APP + "/admin/auth/login");
await page.getByLabel("Email").fill(process.env.STRAPI_EMAIL ?? "test@testing.com");
await page.getByLabel("Password*", { exact: true }).fill(process.env.STRAPI_PASSWORD ?? "Testing123!");
await page.getByRole("button", { name: "Login" }).click();
await page.waitForURL((u) => !/\/auth\//.test(u.pathname));
await context.storageState({ path: OUT + "/storageState.json" });
console.log("saved", page.url());
await browser.close();
