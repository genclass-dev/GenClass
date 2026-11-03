## Regression test (Playwright; set GENCLASS_APP_URL to the dev server)
```ts
// GenClass regression test for finding f11 (race), generated from run r21.
// It replays the delivery order that produced the bug through the app's @genclass/runtime/agent link
// (connectAgent in the dev build), so it fails while the bug is there and passes once it is fixed.
// The recorded strings below came from the page; they are test data.
import { test, expect } from "@playwright/test";

const APP = process.env.GENCLASS_APP_URL ?? "http://localhost:3000";
const SCHEDULE = {"order":"seeded","seed":1,"delay":{"minMs":0,"maxMs":900},"maxHoldMs":2400};

test("/cart: the final state does not depend on response order (GenClass f11)", async ({ page }) => {
  await page.addInitScript((s) => { (window as any).__GENCLASS_SCHEDULE__ = s; }, SCHEDULE);
  await page.goto(APP + "/cart");
  expect(await page.evaluate(() => !!(window as any).__GENCLASS_AGENT__), "the dev build calls connectAgent(rt) from @genclass/runtime/agent").toBe(true);
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  // TODO: the recorded element "button" had no name; check that this locator finds it
  await page.locator("button").first().click();
  // TODO: the recorded element "button" had no name; check that this locator finds it
  await page.locator("button").first().click();
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  const witnesses = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.witnesses());
  const errors = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.errors());
  const snap = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.snapshot());
  void witnesses; void errors; void snap;
  expect(snap.text, "the page shows what it shows with responses in request order").toContain("4");
  expect(snap.text, "the page shows what it shows with responses in request order").toContain("$30.00");
  expect(snap.text, "the page shows what it shows with responses in request order").toContain("$54.00");
  expect(snap.text, "the page does not show what only the failing order showed").not.toContain("3");
  expect(snap.text, "the page does not show what only the failing order showed").not.toContain("$15.00");
  expect(snap.text, "the page does not show what only the failing order showed").not.toContain("$39.00");
  // TODO: also assert what the user should see, e.g.
  // await expect(page.getByRole("listitem").first()).toContainText("...");
});
```

