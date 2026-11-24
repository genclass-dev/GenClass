import { beforeEach, describe, expect, it } from "vitest";
import { codesOf, isCode, LIFETIME_UNTIL, makeCode, normaliseCode } from "../src/appsumo.js";
import { accessOf } from "../src/plans.js";
import { makeCodes } from "../scripts/appsumo-codes.mjs";
import { call, cliToken, now, resetClock, setup, signedIn } from "./account-helpers.js";

// AppSumo codes (src/appsumo.ts, the owner 2026-11-24: launch on AppSumo): a signed code is redeemed once, by one
// account, which then has Pro for life; a second code gives Business; nothing more stacks.

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
beforeEach(() => resetClock());

const redeem = (env: ReturnType<typeof setup>["env"], cookie: string, code: unknown) => call(env, "POST", "/api/account/appsumo", { body: { code }, cookie });
const grant = (sql: ReturnType<typeof setup>["sql"], id: string) => sql.rows("SELECT comp_plan, comp_until FROM accounts WHERE id = ?", id)[0] as { comp_plan: string | null; comp_until: string | null };

describe("AppSumo codes: what a code is (src/appsumo.ts)", () => {
  it("a code is GC-<12>-<8> in Crockford base32, signed with the secret; another secret's code or a changed one fails", async () => {
    const code = await makeCode(SECRET);
    expect(code).toMatch(/^GC-[0-9A-HJKMNP-TV-Z]{12}-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(await isCode(SECRET, code)).toBe(true);
    expect(await isCode("another-secret-0123456789abcdef0123456789", code)).toBe(false);
    const flipped = code.slice(0, -1) + (code.endsWith("0") ? "1" : "0");
    expect(await isCode(SECRET, flipped)).toBe(false);
    // pasted with spaces or in lower case, it is the same code
    expect(normaliseCode(` ${code.toLowerCase()} `)).toBe(code);
    expect(normaliseCode("GC-XXXX")).toBeNull();
  });

  it("the CSV script makes codes the collector accepts, all different", async () => {
    const codes = await makeCodes(SECRET, 200);
    expect(new Set(codes).size).toBe(200);
    for (const c of codes.slice(0, 20)) expect(await isCode(SECRET, c)).toBe(true);
  });
});

describe("AppSumo codes: redeeming (POST /api/account/appsumo, /account/appsumo)", () => {
  it("one code gives Pro for life, a second gives Business, a third is refused", async () => {
    const { env, sql } = setup({ APPSUMO_CODE_SECRET: SECRET });
    const me = await signedIn(env);
    const [a, b, c] = await makeCodes(SECRET, 3);
    const r1 = await redeem(env, me.cookie, a);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, plan: "Pro", codes: 1, already: false });
    expect(grant(sql, me.account.id)).toEqual({ comp_plan: "team", comp_until: LIFETIME_UNTIL });
    expect(accessOf({ plan: null, stripe_mode: null, ...grant(sql, me.account.id) }, null, now()).plan.id).toBe("team");
    const r2 = await redeem(env, me.cookie, b);
    expect(await r2.json()).toMatchObject({ ok: true, plan: "Business", codes: 2 });
    expect(grant(sql, me.account.id).comp_plan).toBe("business");
    const r3 = await redeem(env, me.cookie, c);
    expect(r3.status).toBe(409);
    expect(((await r3.json()) as any).error).toContain("2 codes at most");
    expect(await codesOf(sql.api, me.account.id)).toBe(2);
  });

  it("a code works once: the same account again is told it has it, another account is refused", async () => {
    const { env } = setup({ APPSUMO_CODE_SECRET: SECRET });
    const ada = await signedIn(env, "ada@example.com");
    const bob = await signedIn(env, "bob@example.com");
    const code = await makeCode(SECRET);
    expect((await redeem(env, ada.cookie, code)).status).toBe(200);
    const again = await redeem(env, ada.cookie, code);
    expect(await again.json()).toMatchObject({ ok: true, already: true, codes: 1 });
    const other = await redeem(env, bob.cookie, code);
    expect(other.status).toBe(409);
    expect(((await other.json()) as any).error).toBe("this code was redeemed already");
  });

  it("a code that is not ours is refused and records nothing", async () => {
    const { env, sql } = setup({ APPSUMO_CODE_SECRET: SECRET });
    const me = await signedIn(env);
    const forged = await makeCode("someone-else-0123456789abcdef0123456789");
    for (const bad of [forged, "GC-AAAA", "", 42]) {
      const r = await redeem(env, me.cookie, bad);
      expect(r.status).toBe(400);
    }
    expect(sql.rows("SELECT COUNT(*) AS n FROM appsumo_codes")[0]!.n).toBe(0);
    expect(grant(sql, me.account.id).comp_until).toBeNull();
  });

  it("a higher grant GenClass gave by hand stays as it is", async () => {
    const { env, sql } = setup({ APPSUMO_CODE_SECRET: SECRET });
    const me = await signedIn(env);
    sql.db.prepare("UPDATE accounts SET comp_plan = 'enterprise', comp_until = '2027-06-01T00:00:00.000Z' WHERE id = ?").run(me.account.id);
    expect((await redeem(env, me.cookie, await makeCode(SECRET))).status).toBe(200);
    expect(grant(sql, me.account.id)).toEqual({ comp_plan: "enterprise", comp_until: "2027-06-01T00:00:00.000Z" });
  });

  it("only a signed-in browser on genclass.dev redeems: signed out 401, another site 403, the CLI's token 403; no secret 503", async () => {
    const { env } = setup({ APPSUMO_CODE_SECRET: SECRET });
    const me = await signedIn(env);
    const code = await makeCode(SECRET);
    expect((await call(env, "POST", "/api/account/appsumo", { body: { code } })).status).toBe(401);
    expect((await call(env, "POST", "/api/account/appsumo", { body: { code }, cookie: me.cookie, origin: "https://evil.example" })).status).toBe(403);
    const bearer = await cliToken(env, me.cookie);
    expect((await call(env, "POST", "/api/account/appsumo", { body: { code }, bearer, origin: null })).status).toBe(403);
    const off = setup({});
    const you = await signedIn(off.env);
    expect((await redeem(off.env, you.cookie, code)).status).toBe(503);
  });

  it("the page sends a signed-out buyer to sign in and back with the code, and fills it in", async () => {
    const { env } = setup({ APPSUMO_CODE_SECRET: SECRET });
    const code = await makeCode(SECRET);
    const out = await call(env, "GET", `/account/appsumo?code=${code}`);
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe(`/login?next=${encodeURIComponent(`/account/appsumo?code=${code}`)}`);
    const me = await signedIn(env);
    const html = await (await call(env, "GET", `/account/appsumo?code=${code.toLowerCase()}`, { cookie: me.cookie })).text();
    expect(html).toContain("Redeem your AppSumo code");
    expect(html).toContain(`value="${code}"`);
    // a query that is not a code is not echoed
    const odd = await (await call(env, "GET", `/account/appsumo?code=%22%3E%3Cscript%3E`, { cookie: me.cookie })).text();
    expect(odd).not.toContain("<script>alert");
    expect(odd).toContain('value=""');
  });
});
