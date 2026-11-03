// Shared helpers for the Superset SQL Lab hunt scripts (hunt.mjs, repro-*.mjs): the admin login and the PUT body reader.

/** Logs in through Superset's login form once and returns the session as a Playwright storageState. */
export async function login(browser, app, user = "admin", password = "general") {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${app}/login/`);
  await page.locator('input[name="username"], #username').first().fill(user);
  await page.locator('input[name="password"], #password').first().fill(password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 }), page.keyboard.press("Enter")]);
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

/** One field of a multipart form body (SupersetClient's postPayload), JSON-decoded as the server does. */
export function formField(req, name) {
  const body = req.postDataBuffer()?.toString("utf8") ?? "";
  const m = new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(body);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return m[1];
  }
}
