// AppSumo lifetime deal codes (the owner, 2026-11-24: "just push it all to AppSumo ... I just want to launch on
// AppSumo"). AppSumo sells codes; a buyer redeems one here, signed in:
//
//   GET  /account/appsumo[?code=]   the redeem page: sign in (or up) first, then paste the code
//   POST /api/account/appsumo       browser session + Origin; {code}: redeem it; {ok, plan, codes}
//
// Invariants:
// - A code is GC-<12 base32>-<8 base32>: a random part and the first 40 bits of HMAC-SHA256(APPSUMO_CODE_SECRET,
//   "genclass-appsumo-v1:" + random part). Nothing is stored before a code is used; scripts/appsumo-codes.mjs makes the
//   CSV AppSumo takes with the same secret. Without the secret every code is refused (503).
// - A used code is a row of appsumo_codes (migration 0025): it works once, for one account.
// - One code per account: it gives the Pro plan (id team) for life (the owner, 2026-11-25: Pro, not Business; it was
//   "two codes give Business" on 2026-11-24), as a grant with comp_until LIFETIME_UNTIL. src/plans.ts gives such a
//   lifetime grant Pro's own limits (3 apps, one developer) and never a subscription, a trial or a renewal (isLifetime;
//   src/billing.ts refuses its checkout). A grant never moves an account down: a higher grant GenClass gave by hand and
//   still running stays (accessOf picks the better of a subscription and the grant).
// - Browser only, like billing and teams: the CLI's bearer token is refused. AUTH_LIMIT's budget per account.

import { accountContext, fail, page, readJson, redirect, webSession, type C } from "./auth.js";
import { appsumoPage } from "./account-pages.js";
import { browserWrite, overBudget, tooMany } from "./billing.js";
import type { D1Like } from "./dashboard.js";
import type { Env, HandleOptions } from "./collector.js";
import { json } from "./http.js";
import { grantPlan, LIFETIME_UNTIL, planById, PLANS } from "./plans.js";

export { LIFETIME_UNTIL };

/** Crockford's base32: no I, L, O or U, so a code read aloud or retyped stays one code. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_RE = /^GC-([0-9A-HJKMNP-TV-Z]{12})-([0-9A-HJKMNP-TV-Z]{8})$/;
/** Codes one account can hold: one, Pro for life. */
export const MAX_CODES = 1;
/** The plan a code gives, for life. */
const PLAN_ID = "team";

const b32 = (bytes: Uint8Array, chars: number): string => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, chars);
};

async function signature(secret: string, part: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`genclass-appsumo-v1:${part}`)));
  return b32(mac.slice(0, 5), 8);
}

/** A new code for `secret` (the CSV generator and the tests). */
export async function makeCode(secret: string): Promise<string> {
  const part = b32(crypto.getRandomValues(new Uint8Array(8)), 12);
  return `GC-${part}-${await signature(secret, part)}`;
}

/** A code as a buyer may paste it (spaces, lower case) in its one form, or null when it is not shaped like one. */
export function normaliseCode(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 80) return null;
  const s = v.replace(/\s+/g, "").toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

/** Whether `code` (normalised) was made with `secret`. */
export async function isCode(secret: string, code: string): Promise<boolean> {
  const m = CODE_RE.exec(code);
  if (!m) return false;
  const want = await signature(secret, m[1]!);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return diff === 0;
}

/** How many codes an account holds now (refunded ones do not count). */
export async function codesOf(db: D1Like, accountId: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM appsumo_codes WHERE account_id = ? AND refunded IS NULL").bind(accountId).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

export type RedeemResult = { ok: true; plan: string; codes: number; already: boolean } | { ok: false; status: number; error: string };

/** Redeems `raw` for `accountId`: checks it, records it, and gives the account its plan for life. */
export async function redeemCode(db: D1Like, secret: string | undefined, accountId: string, raw: unknown, now: Date): Promise<RedeemResult> {
  if (!secret) return { ok: false, status: 503, error: "AppSumo codes are not set up yet; write to mehar@genclass.dev" };
  const code = normaliseCode(raw);
  if (!code || !(await isCode(secret, code))) return { ok: false, status: 400, error: "that is not a GenClass code; copy it from your AppSumo purchase" };
  const used = await db.prepare("SELECT account_id, refunded FROM appsumo_codes WHERE code = ?").bind(code).first<{ account_id: string; refunded: string | null }>();
  if (used) {
    if (used.account_id !== accountId || used.refunded) return { ok: false, status: 409, error: "this code was redeemed already" };
    const n = await codesOf(db, accountId);
    return { ok: true, plan: planById(PLAN_ID).name, codes: n, already: true };
  }
  const before = await codesOf(db, accountId);
  if (before >= MAX_CODES) return { ok: false, status: 409, error: "this account has an AppSumo code already, and one code is all an account takes; redeem this one on another account, or write to mehar@genclass.dev" };
  try {
    await db.prepare("INSERT INTO appsumo_codes (code, account_id, redeemed) VALUES (?, ?, ?)").bind(code, accountId, now.toISOString()).run();
  } catch {
    return { ok: false, status: 409, error: "this code was redeemed already" };
  }
  const n = before + 1;
  const plan = planById(PLAN_ID);
  const acct = await db.prepare("SELECT comp_plan, comp_until FROM accounts WHERE id = ?").bind(accountId).first<{ comp_plan: string | null; comp_until: string | null }>();
  const running = !!acct?.comp_until && Date.parse(acct.comp_until) > now.getTime();
  // a higher grant GenClass gave by hand stays exactly as it is (its plan and its end); otherwise the code's plan, for life
  const higher = running && PLANS.indexOf(grantPlan(acct?.comp_plan)) > PLANS.indexOf(plan);
  if (!higher) await db.prepare("UPDATE accounts SET comp_plan = ?, comp_until = ? WHERE id = ?").bind(plan.id, LIFETIME_UNTIL, accountId).run();
  return { ok: true, plan: plan.name, codes: n, already: false };
}

const method = (): Response => fail(405, "method not allowed");
const label = (x: { email: string | null; github_login: string | null }): string => x.email ?? (x.github_login ? `@${x.github_login}` : "your GenClass account");

export async function routeAppsumo(request: Request, url: URL, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  if (path !== "/account/appsumo" && path !== "/api/account/appsumo") return null;
  const c: C | null = accountContext(request, url, env, opts);
  if (!c) return null; // the account routes answer "unavailable"
  const m = request.method;

  if (path === "/account/appsumo") {
    if (m !== "GET" && m !== "HEAD") return method();
    const code = normaliseCode(url.searchParams.get("code")) ?? "";
    const a = await webSession(c);
    if (!a) return redirect(`/login?next=${encodeURIComponent(`/account/appsumo${code ? `?code=${code}` : ""}`)}`);
    const codes = await codesOf(c.db, a.account.id);
    return page(200, (n) => appsumoPage(n, { me: label(a.account), code, codes, plan: codes ? planById(PLAN_ID).name : null, ready: !!env.APPSUMO_CODE_SECRET, max: MAX_CODES }));
  }

  if (m !== "POST") return method();
  const a = await browserWrite(c, "a code can be redeemed");
  if (a instanceof Response) return a;
  const body = await readJson(c, 1024);
  if (body instanceof Response) return body;
  if (await overBudget(env.AUTH_LIMIT, "appsumo", a.account.id)) return tooMany();
  const r = await redeemCode(c.db, env.APPSUMO_CODE_SECRET, a.account.id, body.code, c.now);
  if (!r.ok) return fail(r.status, r.error);
  return json(200, { ok: true, plan: r.plan, codes: r.codes, already: r.already, next: "/account/get-started" });
}
