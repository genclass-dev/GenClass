// Reproduces the realm settings lost update without GenClass (docs/adoption/hunts/keycloak-admin-console.md): the
// admin saves the General tab (new display name), then, before the console's refetch of the realm
// (GET /admin/realms/{realm}) has come back, switches to the Login tab and turns "User registration" on. The second
// write sends the realm the console had loaded before the first save, so the display name goes back on the server.
//
// Nothing is reordered: only the console's refetch of the realm is made slower (a Playwright route that waits
// `delay` ms before letting the GET through), the stand-in for a slow network or a busy server. Every other request
// goes out as the console sends it. Per trial it prints the realm's displayName and registrationAllowed as the server
// stores them afterwards (read through the admin REST API), and what the General tab shows after a reload.
//
//   node docs/adoption/hunts/keycloak-admin-console/repro-lost-update.mjs [delays=0,300,1000] [trials=3]
//
// THROTTLE_MS=<ms> replaces the route with Chromium's own network emulation (CDP Network.emulateNetworkConditions,
// that much latency on every request, as DevTools' throttling does) from the moment the form is shown, and
// PAUSE_MS=<ms> waits that long after the save notification before clicking the Login tab, a person's reaction time.
// In that mode the "delays" argument is ignored (one row per trial).
//
// A throwaway realm per trial, created with displayName "Original display name" (a field left unset is not sent at all
// and the server keeps what it has, so the realm needs a value to go back to), deleted afterwards. KEYCLOAK_URL defaults to
// http://localhost:8080.

import { chromium, expect } from "@playwright/test";
import { KC, createRealm, deleteRealm, getRealm, login, realmName } from "./kc.mjs";

const delays = (process.argv[2] ?? "0,300,1000").split(",").map(Number);
const trials = Number(process.argv[3] ?? 3);
const SHOW = process.env.HUNT_HEADED === "1";
const THROTTLE = Number(process.env.THROTTLE_MS ?? 0);
const PAUSE = Number(process.env.PAUSE_MS ?? 0);

const browser = await chromium.launch({ headless: !SHOW });
const results = [];
for (const delay of THROTTLE ? [0] : delays) {
  for (let t = 1; t <= trials; t++) {
    const realm = realmName("repro");
    await createRealm(realm, { displayName: "Original display name" });
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    try {
      await login(page, `/${realm}/realm-settings/general`);
      const displayName = page.getByTestId("displayName");
      await displayName.waitFor();
      // From here on, the refetch of the realm is slower by `delay` ms.
      let refetches = 0;
      let cdp = null;
      if (THROTTLE) {
        cdp = await ctx.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: THROTTLE, downloadThroughput: -1, uploadThroughput: -1 });
      }
      if (delay) {
        await ctx.route(`${KC}/admin/realms/${realm}`, async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          refetches++;
          await new Promise((r) => setTimeout(r, delay));
          return route.fallback();
        });
      }
      const alert = page.getByTestId("last-alert");
      await displayName.fill("Display name from the General tab");
      await page.getByTestId("realmSettingsGeneralTab-save").click();
      await expect(alert).toContainText("Realm successfully updated");
      if (PAUSE) await page.waitForTimeout(PAUSE);
      await page.getByTestId("rs-login-tab").click();
      const reg = page.getByTestId("user-reg-switch");
      await reg.waitFor({ state: "attached" });
      await reg.click({ force: true }); // the switch only follows the server after the refetch, so no check()
      await expect(alert).toContainText("changed successfully");
      await page.waitForTimeout(delay * 2 + THROTTLE * 4 + 1000); // every refetch has landed
      const stored = await getRealm(realm);
      if (cdp) await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await page.goto(`${KC}/admin/master/console/#/${realm}/realm-settings/general`);
      await page.reload();
      await page.getByTestId("displayName").waitFor();
      const shown = await page.getByTestId("displayName").inputValue();
      const lost = stored.displayName !== "Display name from the General tab";
      results.push({ delay, throttle: THROTTLE, pause: PAUSE, trial: t, refetches, stored: { displayName: stored.displayName ?? null, registrationAllowed: stored.registrationAllowed }, shownAfterReload: shown, outcome: lost ? "display name LOST" : "both saved" });
    } catch (e) {
      results.push({ delay, trial: t, outcome: `error: ${String(e).split("\n")[0]}` }); if (process.env.HUNT_DEBUG) console.error(e);
    } finally {
      await ctx.close();
      await deleteRealm(realm);
    }
    const r = results.at(-1);
    const what = THROTTLE ? `latency ${THROTTLE} ms, pause ${PAUSE} ms` : `refetch delayed ${String(delay).padStart(4)} ms`;
    console.log(`${what}, trial ${t}: ${r.outcome}  ${JSON.stringify(r.stored ?? {})}`);
  }
}
await browser.close();
console.log(JSON.stringify(results));
