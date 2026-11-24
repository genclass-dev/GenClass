// The partner API (src/partner.ts): a partner's server makes an app for each of its users and reads what it finds.
// Only for an account GenClass made a partner (accounts.partner_apps); keys made in the browser and shown once;
// a key reaches its own account's apps only, never through a browser (no CORS), and stops at once when revoked or
// when the account stops being a partner.
import { beforeEach, describe, expect, it } from "vitest";
import { resetTokenCache } from "../src/dashboard.js";
import { encodeCursor } from "../src/partner.js";
import { call, cliToken, createApp, detection, now, resetClock, sendBatch, setPlan, setup, signedIn } from "./account-helpers.js";

beforeEach(() => {
  resetClock();
  resetTokenCache();
});

const FOREVER = "9999-12-31T00:00:00.000Z";

/** A partner: GenClass's Enterprise grant and a partner limit, set by hand as in production, with one key. */
async function partner(apps = 5) {
  const t = setup();
  const a = await signedIn(t.env, "partner@example.com");
  setPlan(t.sql, a.account.id, "free", { comp_until: FOREVER, comp_plan: "enterprise", partner_apps: apps });
  const made = await call(t.env, "POST", "/api/account/partner-keys", { body: { label: "server" }, cookie: a.cookie });
  expect(made.status).toBe(201);
  const key = ((await made.json()) as any).key as string;
  return { ...t, ...a, key };
}

const api = (t: { env: any; key: string }, method: string, path: string, body?: unknown) =>
  call(t.env, method, `/api/partner/v1${path}`, { bearer: t.key, origin: null, ...(body === undefined ? {} : { body }) });
const lines = async (r: Response) => (await r.text()).split("\n").filter(Boolean);

describe("partner API (src/partner.ts)", () => {
  it("only a partner makes keys; a key is shown once, stored as a hash, listed without it", async () => {
    const t = setup();
    const a = await signedIn(t.env);
    expect((await call(t.env, "POST", "/api/account/partner-keys", { body: {}, cookie: a.cookie })).status).toBe(403);
    setPlan(t.sql, a.account.id, "free", { comp_until: FOREVER, comp_plan: "enterprise", partner_apps: 3 });
    // the browser only, from genclass.dev
    expect((await call(t.env, "POST", "/api/account/partner-keys", { body: {}, cookie: a.cookie, origin: "https://evil.example" })).status).toBe(403);
    const bearer = await cliToken(t.env, a.cookie);
    expect((await call(t.env, "POST", "/api/account/partner-keys", { body: {}, bearer, origin: null })).status).toBe(403);
    const made = await call(t.env, "POST", "/api/account/partner-keys", { body: { label: "prod\u0000server" }, cookie: a.cookie });
    expect(made.status).toBe(201);
    const { id, key, label } = (await made.json()) as any;
    expect(key).toMatch(/^gcp_[A-Za-z0-9_-]{43}$/);
    expect(label).toBe("prod server");
    expect(JSON.stringify(t.sql.rows("SELECT * FROM partner_keys"))).not.toContain(key);
    const listed = await (await call(t.env, "GET", "/api/account/partner-keys", { cookie: a.cookie })).json();
    expect(JSON.stringify(listed)).not.toContain(key);
    expect((listed as any).keys.map((k: any) => k.id)).toEqual([id]);
    // /account shows the section to a partner, with its count
    const page = await (await call(t.env, "GET", "/account", { cookie: a.cookie })).text();
    expect(page).toContain('id="partner"');
    expect(page).toContain("0 of 3 apps");
    expect(page).not.toContain(key);
  });

  it("an account that is not a partner sees no section, and its requests are refused", async () => {
    const t = setup();
    const a = await signedIn(t.env);
    expect(await (await call(t.env, "GET", "/account", { cookie: a.cookie })).text()).not.toContain('id="partner"');
    expect((await call(t.env, "GET", "/api/partner/v1/apps", { origin: null })).status).toBe(401);
    expect((await call(t.env, "GET", "/api/partner/v1/apps", { cookie: a.cookie })).status).toBe(401);
    expect((await call(t.env, "GET", "/api/partner/v1/apps", { bearer: `gcp_${"A".repeat(43)}`, origin: null })).status).toBe(401);
    // a terminal's session is not a partner key
    expect((await call(t.env, "GET", "/api/partner/v1/apps", { bearer: await cliToken(t.env, a.cookie), origin: null })).status).toBe(401);
  });

  it("makes one app per ref: 201 the first time, the same app after; bad refs are 400", async () => {
    const t = await partner();
    const r = await api(t, "POST", "/apps", { ref: "user_42", name: "Ada's shop" });
    expect(r.status).toBe(201);
    const { created, app } = (await r.json()) as any;
    expect(created).toBe(true);
    expect(app).toMatchObject({ ref: "user_42", name: "Ada's shop", first_event: null });
    expect(app.key).toMatch(/^gc_[A-Za-z0-9]{22}$/);
    expect(app.install).toBe(`npx @genclass/runtime@beta init --token ${app.key}`);
    expect(app.dashboard_url).toBe(`https://genclass.dev/account/apps/${app.id}`);
    // the app is the partner's, like any other
    expect(t.sql.rows("SELECT account_id, partner_ref, private_link FROM projects WHERE id = ?", app.id)).toEqual([{ account_id: t.account.id, partner_ref: "user_42", private_link: 0 }]);
    const again = await api(t, "POST", "/apps", { ref: "user_42", name: "Another name" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as any)).toMatchObject({ created: false, app: { id: app.id, name: "Ada's shop", key: app.key } });
    // no name: the ref names it
    expect(((await (await api(t, "POST", "/apps", { ref: "u-7" })).json()) as any).app.name).toBe("u-7");
    for (const ref of [undefined, "", " x", "a/b", "x".repeat(65), 42]) expect((await api(t, "POST", "/apps", { ref })).status).toBe(400);
    expect((await api(t, "POST", "/apps", { ref: "ok", name: 5 })).status).toBe(400);
  });

  it("stops at the partner limit, counting every app of the account", async () => {
    const t = await partner(3);
    await createApp(t.env, t.cookie, "Own site");
    expect((await api(t, "POST", "/apps", { ref: "a" })).status).toBe(201);
    expect((await api(t, "POST", "/apps", { ref: "b" })).status).toBe(201);
    const over = await api(t, "POST", "/apps", { ref: "c" });
    expect(over.status).toBe(409);
    expect(((await over.json()) as any).error).toContain("partner limit of 3");
    // an existing ref still answers
    expect((await api(t, "POST", "/apps", { ref: "a" })).status).toBe(200);
  });

  it("lists the apps it made, oldest first, by ref and by page, with the limit", async () => {
    const t = await partner();
    await createApp(t.env, t.cookie, "Own site");
    const ids: string[] = [];
    for (const ref of ["a", "b", "c"]) {
      ids.push(((await (await api(t, "POST", "/apps", { ref })).json()) as any).app.id);
      t.sql.db.prepare("UPDATE projects SET created = ? WHERE id = ?").run(new Date(now().getTime() + ids.length * 1000).toISOString(), ids.at(-1)!);
    }
    const all = (await (await api(t, "GET", "/apps")).json()) as any;
    expect(all.apps.map((a: any) => a.ref)).toEqual(["a", "b", "c"]);
    expect(all).toMatchObject({ next_cursor: null, limit: { apps: 5, used: 4 } });
    expect(((await (await api(t, "GET", "/apps?ref=b")).json()) as any).apps.map((a: any) => a.id)).toEqual([ids[1]]);
    const first = all.apps[0];
    const rest = (await (await api(t, "GET", `/apps?cursor=${encodeCursor({ created: first.created, id: first.id })}`)).json()) as any;
    expect(rest.apps.map((a: any) => a.ref)).toEqual(["b", "c"]);
    expect((await api(t, "GET", "/apps?cursor=!!")).status).toBe(400);
    expect((await api(t, "GET", "/apps?ref=a/b")).status).toBe(400);
  });

  it("reads an app's dashboard and events, and hands its user a private link", async () => {
    const t = await partner();
    const { app } = (await (await api(t, "POST", "/apps", { ref: "u1" })).json()) as any;
    await sendBatch(t.env, app.key, [{ t: "session", seq: 0, host: "shop.example", route: "/" }]);
    await sendBatch(t.env, app.key, detection("duplicate", "/checkout"), { sid: "dddddddddddd" });
    const view = await api(t, "GET", `/apps/${app.id}?range=7d`);
    expect(view.status).toBe(200);
    expect(view.headers.get("access-control-allow-origin")).toBeNull();
    const v = (await view.json()) as any;
    expect(v.plan).toMatchObject({ id: "enterprise" });
    expect(JSON.stringify(v)).not.toContain("SECRET PAGE TEXT");
    const ev = await api(t, "GET", `/apps/${app.id}/events`);
    expect(ev.status).toBe(200);
    expect(await lines(ev)).toHaveLength(3); // one line per event: the session, then the decision and its detection
    const link = await api(t, "POST", `/apps/${app.id}/link`);
    expect(link.status).toBe(201);
    const url = ((await link.json()) as any).dashboard_url as string;
    expect(url).toMatch(/^https:\/\/genclass\.dev\/dashboard\/[A-Za-z0-9]{32}$/);
    expect((await call(t.env, "GET", new URL(url).pathname, { origin: null })).status).toBe(200);
    // a new link replaces the old one
    await api(t, "POST", `/apps/${app.id}/link`);
    expect((await call(t.env, "GET", new URL(url).pathname, { origin: null })).status).toBe(404);
    // methods
    expect((await api(t, "GET", `/apps/${app.id}/link`)).status).toBe(405);
    expect((await api(t, "DELETE", `/apps/${app.id}`)).status).toBe(405);
    expect((await api(t, "GET", "/nothing")).status).toBe(404);
  });

  it("never another account's app; stops at once when revoked or no longer a partner", async () => {
    const t = await partner();
    const other = await signedIn(t.env, "bob@example.com");
    setPlan(t.sql, other.account.id, "free", { comp_until: FOREVER, comp_plan: "enterprise" });
    const bobs = await createApp(t.env, other.cookie, "Bob's");
    expect((await api(t, "GET", `/apps/${bobs.id}`)).status).toBe(404);
    expect((await api(t, "GET", `/apps/${bobs.id}/events`)).status).toBe(404);
    expect((await api(t, "POST", `/apps/${bobs.id}/link`)).status).toBe(404);
    expect((await api(t, "GET", "/apps")).status).toBe(200);
    t.sql.db.prepare("UPDATE accounts SET partner_apps = NULL WHERE id = ?").run(t.account.id);
    expect((await api(t, "GET", "/apps")).status).toBe(403);
    t.sql.db.prepare("UPDATE accounts SET partner_apps = 5 WHERE id = ?").run(t.account.id);
    const [{ id }] = t.sql.rows("SELECT id FROM partner_keys") as { id: string }[];
    expect((await call(t.env, "DELETE", `/api/account/partner-keys/${id}`, { cookie: t.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(t.env, "DELETE", `/api/account/partner-keys/${id}`, { cookie: t.cookie })).status).toBe(204);
    expect((await api(t, "GET", "/apps")).status).toBe(401);
  });

  it("at most 10 keys; deleting the account removes them, and an app with a link leaves without its ref", async () => {
    const t = await partner();
    for (let i = 1; i < 10; i++) expect((await call(t.env, "POST", "/api/account/partner-keys", { body: {}, cookie: t.cookie })).status).toBe(201);
    expect((await call(t.env, "POST", "/api/account/partner-keys", { body: {}, cookie: t.cookie })).status).toBe(409);
    const { app } = (await (await api(t, "POST", "/apps", { ref: "kept" })).json()) as any;
    await api(t, "POST", `/apps/${app.id}/link`);
    expect((await call(t.env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: t.cookie })).status).toBe(204);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM partner_keys")).toEqual([{ n: 0 }]);
    expect(t.sql.rows("SELECT account_id, partner_ref FROM projects WHERE id = ?", app.id)).toEqual([{ account_id: null, partner_ref: null }]);
  });
});
