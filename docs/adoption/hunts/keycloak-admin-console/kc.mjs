// Shared helpers for the Keycloak admin console hunt (docs/adoption/hunts/keycloak-admin-console.md): the admin REST
// API through the master realm's admin-cli client (admin/admin, the dev server's bootstrap admin), a throwaway realm
// per run, and the console's own login form. Nothing here touches Keycloak's source.
//
// KEYCLOAK_URL defaults to http://localhost:8080 (js/apps/keycloak-server, `pnpm start`).

export const KC = (process.env.KEYCLOAK_URL ?? "http://localhost:8080").replace(/\/+$/, "");

async function token() {
  const r = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: "admin" }),
  });
  if (!r.ok) throw new Error(`token: HTTP ${r.status}`);
  return (await r.json()).access_token;
}

/** Calls the admin REST API (`path` below /admin/realms) and returns the parsed body (null for a GET that finds nothing). */
export async function admin(method, path, body) {
  const r = await fetch(`${KC}/admin/realms${path}`, {
    method,
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 404 && method === "GET") return null;
  if (!r.ok && r.status !== 404) throw new Error(`${method} ${path}: HTTP ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

export const createRealm = (realm, extra = {}) => admin("POST", "", { realm, enabled: true, ...extra });
export const deleteRealm = (realm) => admin("DELETE", `/${encodeURIComponent(realm)}`);
export const getRealm = (realm) => admin("GET", `/${encodeURIComponent(realm)}`);

/** Signs in through the console's login form (keycloak-js redirects there) and opens `hash` in the master console. */
export async function login(page, hash = "") {
  await page.goto(`${KC}/admin/master/console/${hash ? `#${hash}` : ""}`);
  const user = page.getByLabel("Username");
  const masthead = page.getByRole("button", { name: "admin", exact: true });
  await user.or(masthead).first().waitFor({ timeout: 60_000 });
  if (await user.isVisible()) {
    await user.fill("admin");
    await page.getByLabel("Password", { exact: true }).fill("admin");
    await page.getByRole("button", { name: "Sign In" }).click();
  }
  await masthead.waitFor({ timeout: 60_000 });
}

/** A unique realm name for one run. */
export const realmName = (tag) => `hunt-${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
