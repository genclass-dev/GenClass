// A protected private link (src/link-lock.ts): /start makes every link with a password or a passkey, the dashboard,
// the setup page and their APIs open only in a browser that unlocked it, the agent endpoint stays open, and an open
// link (made by the CLI's init) can be protected from its dashboard.
import { beforeEach, describe, expect, it } from "vitest";
import { advance, call, resetClock, setup, ORIGIN } from "./account-helpers.js";
import { makeAuthenticator } from "./authenticator.mjs";
import type { Env } from "../src/collector.js";

const PW = "a long test password";
const cookieOf = (r: Response): string => r.headers.getSetCookie().find((c) => c.startsWith("__Host-gc_link_"))!.split(";")[0]!;
const secretOf = (url: string): string => url.split("/").pop()!.split("?")[0]!;

async function startWithPassword(env: Env, name = "Shop") {
  const r = await call(env, "POST", "/start", { body: { name, password: PW }, headers: { accept: "application/json" } });
  expect(r.status).toBe(201);
  const j = (await r.json()) as { url: string; token: string };
  return { secret: secretOf(j.url), token: j.token, cookie: cookieOf(r), res: r };
}

describe("protected private links: /start asks for a password or a passkey (link-lock.ts)", () => {
  beforeEach(() => resetClock());

  it("a password: the link is made with it, this browser is unlocked, another browser sees the unlock page", async () => {
    const { env, sql } = setup();
    const { secret, cookie, res } = await startWithPassword(env, "My shop");
    const set = res.headers.getSetCookie().find((c) => c.startsWith("__Host-gc_link_"))!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Lax");
    const [row] = sql.rows("SELECT name, lock_kind, lock_hash FROM projects");
    expect(row).toMatchObject({ name: "My shop", lock_kind: "password" });
    expect(String(row!.lock_hash)).toMatch(/^\$pbkdf2-sha256\$/);
    // the creator's browser opens everything
    expect(await (await call(env, "GET", `/dashboard/${secret}`, { cookie })).text()).toContain("<body class=\"sb\"");
    expect(await (await call(env, "GET", `/start/${secret}`, { cookie })).text()).toContain("Your app is ready");
    expect((await call(env, "GET", `/api/projects/${secret}`, { cookie })).status).toBe(200);
    expect((await call(env, "GET", `/api/projects/${secret}/status`, { cookie })).status).toBe(200);
    // anyone else with the link: the unlock page and 401s
    const page = await call(env, "GET", `/dashboard/${secret}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("This dashboard is protected");
    expect(html).toContain(`action="/api/link/${secret}/unlock"`);
    expect(html).not.toContain("<body class=\"sb\"");
    expect(await (await call(env, "GET", `/start/${secret}`)).text()).toContain("This dashboard is protected");
    expect((await call(env, "GET", `/api/projects/${secret}`)).status).toBe(401);
    expect((await call(env, "GET", `/api/projects/${secret}/status`)).status).toBe(401);
    expect((await call(env, "PUT", `/api/projects/${secret}/funnels`, { body: { funnels: [] } })).status).toBe(401);
  });

  it("unlocking: the right password sets a cookie, a wrong one is refused, then spaced out after five", async () => {
    const { env } = setup();
    const { secret } = await startWithPassword(env);
    const wrong = await call(env, "POST", `/api/link/${secret}/unlock`, { body: { password: "not the password" } });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe("Wrong password.");
    const ok = await call(env, "POST", `/api/link/${secret}/unlock`, { body: { password: PW } });
    expect(ok.status).toBe(200);
    const cookie = cookieOf(ok);
    expect((await call(env, "GET", `/api/projects/${secret}`, { cookie })).status).toBe(200);
    // five wrong in a row, then a wait
    for (let i = 0; i < 5; i++) expect((await call(env, "POST", `/api/link/${secret}/unlock`, { body: { password: "nope nope nope" } })).status).toBe(400);
    const slow = await call(env, "POST", `/api/link/${secret}/unlock`, { body: { password: PW } });
    expect(slow.status).toBe(429);
    expect(((await slow.json()) as { error: string }).error).toMatch(/^Too many tries\. Try again in /);
    advance(31_000);
    expect((await call(env, "POST", `/api/link/${secret}/unlock`, { body: { password: PW } })).status).toBe(200);
    // a cookie expires after 30 days
    advance(31 * 86_400_000);
    expect((await call(env, "GET", `/api/projects/${secret}`, { cookie })).status).toBe(401);
  });

  it("the no-script forms: /start posts the name and the password, the unlock form sends the browser back", async () => {
    const { env, sql } = setup();
    const form = { "content-type": "application/x-www-form-urlencoded" };
    const made = await call(env, "POST", "/start", { body: new URLSearchParams({ name: "Form app", password: PW }).toString(), headers: form });
    expect(made.status).toBe(303);
    const secret = secretOf(made.headers.get("location")!);
    expect(sql.rows("SELECT lock_kind FROM projects")[0]).toMatchObject({ lock_kind: "password" });
    const back = await call(env, "POST", `/api/link/${secret}/unlock`, { body: new URLSearchParams({ password: PW, next: `/start/${secret}` }).toString(), headers: form });
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`/start/${secret}`);
    expect(cookieOf(back)).toMatch(/^__Host-gc_link_[0-9a-f]{12}=/);
    // anywhere else is the dashboard
    const elsewhere = await call(env, "POST", `/api/link/${secret}/unlock`, { body: new URLSearchParams({ password: PW, next: "https://evil.example/" }).toString(), headers: form });
    expect(elsewhere.headers.get("location")).toBe(`/dashboard/${secret}`);
    // a wrong password shows the page again with why
    const bad = await call(env, "POST", `/api/link/${secret}/unlock`, { body: new URLSearchParams({ password: "wrong wrong wrong" }).toString(), headers: form });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Wrong password.");
  });

  it("no link without a lock: an empty or weak request makes nothing and says why", async () => {
    const { env, sql } = setup();
    const empty = await call(env, "POST", "/start", { headers: { accept: "application/json" } });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe("Enter a password.");
    const weak = await call(env, "POST", "/start", { body: { password: "short" }, headers: { accept: "application/json" } });
    expect(((await weak.json()) as { error: string }).error).toBe("Use at least 10 characters.");
    const page = await call(env, "POST", "/start", { body: new URLSearchParams({ name: "Kept", password: "short" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(page.status).toBe(400);
    const html = await page.text();
    expect(html).toContain("Use at least 10 characters.");
    expect(html).toContain('value="Kept"');
    expect(sql.rows("SELECT token FROM projects")).toHaveLength(0);
  });

  it("a passkey: made on /start, used to unlock in another browser; a wrong or replayed one is refused", async () => {
    const { env, sql } = setup();
    const auth = await makeAuthenticator();
    const opts = (await (await call(env, "POST", "/api/start/passkey", { body: { name: "Shop" } })).json()) as any;
    expect(opts.publicKey.rp.id).toBe("genclass.dev");
    expect(opts.publicKey.user.name).toBe("Shop dashboard");
    const credential = await auth.register(opts.publicKey);
    const made = await call(env, "POST", "/start", { body: { name: "Shop", passkey: { id: opts.id, credential } }, headers: { accept: "application/json" } });
    expect(made.status).toBe(201);
    const secret = secretOf(((await made.json()) as { url: string }).url);
    expect(sql.rows("SELECT lock_kind, lock_hash FROM projects")[0]).toEqual({ lock_kind: "passkey", lock_hash: null });
    expect(sql.rows("SELECT id FROM link_credentials")).toEqual([{ id: auth.credentialId }]);
    // the same challenge cannot make a second link
    expect((await call(env, "POST", "/start", { body: { passkey: { id: opts.id, credential } }, headers: { accept: "application/json" } })).status).toBe(400);
    // another browser: the passkey page, then the passkey
    expect(await (await call(env, "GET", `/dashboard/${secret}`)).text()).toContain("Unlock with passkey");
    const u = (await (await call(env, "POST", `/api/link/${secret}/unlock/passkey`, { body: {} })).json()) as any;
    expect(u.publicKey.allowCredentials).toEqual([{ type: "public-key", id: auth.credentialId }]);
    const tampered = await auth.assert(u.publicKey, { tamper: true });
    expect((await call(env, "POST", `/api/link/${secret}/unlock`, { body: { passkey: { id: u.id, credential: tampered } } })).status).toBe(400);
    const u2 = (await (await call(env, "POST", `/api/link/${secret}/unlock/passkey`, { body: {} })).json()) as any;
    const ok = await call(env, "POST", `/api/link/${secret}/unlock`, { body: { passkey: { id: u2.id, credential: await auth.assert(u2.publicKey) } } });
    expect(ok.status).toBe(200);
    expect((await call(env, "GET", `/api/projects/${secret}`, { cookie: cookieOf(ok) })).status).toBe(200);
    // a passkey from another link does not open this one
    const other = await makeAuthenticator();
    const u3 = (await (await call(env, "POST", `/api/link/${secret}/unlock/passkey`, { body: {} })).json()) as any;
    expect((await call(env, "POST", `/api/link/${secret}/unlock`, { body: { passkey: { id: u3.id, credential: await other.assert(u3.publicKey) } } })).status).toBe(400);
  });

  it("an open link (the CLI's init) stays open and can be protected once from its dashboard", async () => {
    const { env } = setup();
    const made = (await (await call(env, "POST", "/api/projects", { body: { name: "CLI app" }, origin: null })).json()) as { dashboardUrl: string };
    const secret = secretOf(made.dashboardUrl);
    expect((await call(env, "GET", `/api/projects/${secret}`)).status).toBe(200);
    const html = await (await call(env, "GET", `/dashboard/${secret}`)).text();
    expect(html).toContain('id="m-protect"');
    expect(html).not.toContain(secret);
    // protect it with a password: this browser stays in, others are asked
    const p = await call(env, "POST", `/api/link/${secret}/lock`, { body: { password: PW } });
    expect(p.status).toBe(200);
    const cookie = cookieOf(p);
    expect((await call(env, "GET", `/api/projects/${secret}`, { cookie })).status).toBe(200);
    expect((await call(env, "GET", `/api/projects/${secret}`)).status).toBe(401);
    const locked = await (await call(env, "GET", `/dashboard/${secret}`, { cookie })).text();
    expect(locked).not.toContain('id="m-protect"');
    expect(locked).toContain('title="Protected"');
    // only once: nobody with the link can change it afterwards
    expect((await call(env, "POST", `/api/link/${secret}/lock`, { body: { password: "another long password" } })).status).toBe(409);
    expect((await call(env, "POST", `/api/link/${secret}/lock/passkey`, { body: {} })).status).toBe(409);
    // the agent endpoint stays open: a coding agent reports with the link alone
    expect((await call(env, "POST", `/api/projects/${secret}/agent`, { body: { findings: [] }, origin: null })).status).not.toBe(401);
  });

  it("every POST comes from genclass.dev itself; the sample and unknown links have no lock routes", async () => {
    const { env } = setup();
    const { secret } = await startWithPassword(env);
    expect((await call(env, "POST", `/api/link/${secret}/unlock`, { body: { password: PW }, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(env, "POST", "/api/start/passkey", { body: {}, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(env, "POST", `/api/link/${"Z".repeat(32)}/unlock`, { body: { password: PW } })).status).toBe(404);
    expect((await call(env, "POST", "/api/link/sample/unlock", { body: { password: PW } })).status).toBe(404);
    expect((await call(env, "GET", `/api/link/${secret}/unlock`)).status).toBe(405);
  });

  it("signed in, /start is the account's New project page", async () => {
    const { env } = setup();
    const { signedIn } = await import("./account-helpers.js");
    const { cookie } = await signedIn(env);
    const r = await call(env, "GET", "/start", { cookie });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/account/new");
    expect(ORIGIN).toBe("https://genclass.dev");
  });
});
