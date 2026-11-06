// A private dashboard link protected by a password or a passkey (owner, 2026-11-05: "you can't give out a company's
// analytics to a random person on the street"). /start asks for one when it makes the link; a link made before, or by
// the CLI's init (POST /api/projects), stays open until someone with the link adds one from its dashboard (Protect).
// A protected link opens only in a browser that unlocked it: a session cookie per link (30 days), whose SHA-256 is
// stored in link_sessions. The dashboard, the setup page and their APIs (stats, status, funnels) check it; the agent
// endpoint (POST .../agent, write only) does not, so a coding agent can still report.
// Passwords use src/password.ts (PBKDF2, the same rules and the same delay after wrong ones as accounts); passkeys use
// src/webauthn.ts and the `challenges` table, with kinds of their own (link-register, link-add, link-unlock).
// Every POST must come from the site's own origin. Errors are short sentences for the page.

import { authConfig, getCookie } from "./auth.js";
import type { Env } from "./collector.js";
import { randomBase62, sha256Hex, type D1Like } from "./dashboard.js";
import { embed, esc } from "./escape.js";
import { json, mediaType, readCapped } from "./http.js";
import { QUIET_NAV, securityHeaders, shell, START_CSS } from "./pages.js";
import { FAILURE_WINDOW_MS, delayAfter, hashPassword, passwordProblem, verifyPassword, waitText } from "./password.js";
import { icon } from "./studio.js";
import { b64url, ES256, fromB64url, RS256, verifyAssertion, verifyRegistration, WebAuthnError, type VerifiedRegistration } from "./webauthn.js";

/** How long a browser stays unlocked for a link. */
export const LINK_SESSION_MS = 30 * 86_400_000;
/** How long a passkey request stays open. */
const CHALLENGE_MS = 5 * 60_000;
const ID22_RE = /^[A-Za-z0-9]{22}$/;
const COOKIE_RE = /^[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{16,1366}$/;

export type LockKind = "password" | "passkey";

interface Cfg {
  origin: string;
  rpId: string;
  secure: boolean;
}

const cfgOf = (env: Env): Cfg => {
  const a = authConfig(env);
  return { origin: a.origin, rpId: a.rpId, secure: a.secure };
};

const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const fail = (status: number, error: string, headers: Record<string, string> = {}): Response => json(status, { ok: false, error }, headers);
const originOk = (req: Request, cfg: Cfg): boolean => req.headers.get("origin") === cfg.origin;

// --------------------------------------------------------------------------------------------- state

interface LockRow {
  lock_kind: LockKind | null;
  lock_hash: string | null;
  lock_failures: number;
  lock_failed_at: string | null;
}

async function lockRow(db: D1Like, token: string): Promise<LockRow | null> {
  return db.prepare("SELECT lock_kind, lock_hash, lock_failures, lock_failed_at FROM projects WHERE token = ?").bind(token).first<LockRow>();
}

/** The link's lock: "password", "passkey" or null (open). */
export async function lockKind(db: D1Like, token: string): Promise<LockKind | null> {
  return (await lockRow(db, token))?.lock_kind ?? null;
}

async function cookieName(cfg: Cfg, token: string): Promise<string> {
  return `${cfg.secure ? "__Host-" : ""}gc_link_${(await sha256Hex(`link:${token}`)).slice(0, 12)}`;
}

/** Whether this request may see the link's dashboard: an open link, or a browser that unlocked it. */
export async function linkUnlocked(req: Request, env: Env, db: D1Like, token: string, now: Date): Promise<boolean> {
  const kind = await lockKind(db, token);
  if (!kind) return true;
  const v = getCookie(req, await cookieName(cfgOf(env), token));
  if (!v || !COOKIE_RE.test(v)) return false;
  const row = await db.prepare("SELECT expires FROM link_sessions WHERE hash = ? AND token = ?").bind(await sha256Hex(v), token).first<{ expires: string }>();
  return !!row && Date.parse(row.expires) > now.getTime();
}

/** A new unlocked browser for the link: the Set-Cookie header. */
export async function linkSession(env: Env, db: D1Like, token: string, now: Date): Promise<string> {
  const cfg = cfgOf(env);
  const value = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare("INSERT INTO link_sessions (hash, token, created, expires) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(value), token, now.toISOString(), new Date(now.getTime() + LINK_SESSION_MS).toISOString())
    .run();
  return `${await cookieName(cfg, token)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LINK_SESSION_MS / 1000}${cfg.secure ? "; Secure" : ""}`;
}

/** The JSON answer of an API the link's lock refuses. */
export const lockedJson = (): Response => fail(401, "this dashboard is protected; unlock it first", { "www-authenticate": 'GenClass realm="link"' });

// --------------------------------------------------------------------------------------------- passkey challenges

async function putChallenge(db: D1Like, kind: string, data: unknown, now: Date): Promise<{ id: string; challenge: string }> {
  const id = randomBase62(22);
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare("INSERT INTO challenges (id, kind, challenge, account_id, data, expires) VALUES (?, ?, ?, NULL, ?, ?)")
    .bind(id, kind, challenge, JSON.stringify(data ?? {}), new Date(now.getTime() + CHALLENGE_MS).toISOString())
    .run();
  return { id, challenge };
}

async function takeChallenge(db: D1Like, id: unknown, kind: string, now: Date): Promise<{ challenge: string; data: Record<string, unknown> } | null> {
  if (typeof id !== "string" || !ID22_RE.test(id)) return null;
  const row = await db
    .prepare("DELETE FROM challenges WHERE id = ? AND kind = ? RETURNING challenge, data, expires")
    .bind(id, kind)
    .first<{ challenge: string; data: string | null; expires: string }>();
  if (!row || Date.parse(row.expires) <= now.getTime()) return null;
  try {
    return { challenge: row.challenge, data: row.data ? (JSON.parse(row.data) as Record<string, unknown>) : {} };
  } catch {
    return { challenge: row.challenge, data: {} };
  }
}

/** Options for navigator.credentials.create(): a passkey for one link, named after the app. */
async function registerOptions(env: Env, db: D1Like, kind: "link-register" | "link-add", data: Record<string, unknown>, label: string, now: Date): Promise<Response> {
  const cfg = cfgOf(env);
  const ch = await putChallenge(db, kind, data, now);
  return json(200, {
    id: ch.id,
    publicKey: {
      rp: { id: cfg.rpId, name: "GenClass" },
      user: { id: b64url(crypto.getRandomValues(new Uint8Array(16))), name: label, displayName: label },
      challenge: ch.challenge,
      pubKeyCredParams: [
        { type: "public-key", alg: ES256 },
        { type: "public-key", alg: RS256 },
      ],
      timeout: CHALLENGE_MS,
      attestation: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    },
  });
}

const passkeyLabel = (name: string): string => `${name && name !== "Untitled app" ? name : "GenClass"} dashboard`;

/** POST /api/start/passkey {name?}: the options for the passkey of a link /start is about to make. */
export async function startPasskeyOptions(request: Request, env: Env, db: D1Like, name: string, now: Date): Promise<Response> {
  if (!originOk(request, cfgOf(env))) return fail(403, "cross-origin request refused");
  return registerOptions(env, db, "link-register", {}, passkeyLabel(name), now);
}

function credentialParts(v: unknown): { id: unknown; cred: Record<string, unknown>; resp: Record<string, unknown> } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const cred = o.credential;
  if (!cred || typeof cred !== "object" || Array.isArray(cred)) return null;
  const c = cred as Record<string, unknown>;
  if (c.type !== "public-key" || !c.response || typeof c.response !== "object" || Array.isArray(c.response)) return null;
  return { id: o.id, cred: c, resp: c.response as Record<string, unknown> };
}

// --------------------------------------------------------------------------------------------- setting a lock

/** A lock as asked for: a password's stored hash, or a verified passkey. */
export type LockInput = { kind: "password"; hash: string } | { kind: "passkey"; cred: VerifiedRegistration };

/**
 * The lock a body asks for ({ password } or { passkey: { id, credential } }), checked: the password's rules, or the
 * passkey's registration against its challenge (`token`: the link it was asked for, when adding one later).
 */
export async function readLock(env: Env, db: D1Like, body: Record<string, unknown>, kind: "link-register" | "link-add", token: string | null, now: Date): Promise<LockInput | { error: string }> {
  if (body.passkey !== undefined) {
    const parts = credentialParts(body.passkey);
    if (!parts) return { error: "Missing passkey. Try again." };
    const ch = await takeChallenge(db, parts.id, kind, now);
    if (!ch || (token !== null && ch.data.token !== token)) return { error: "This passkey request expired. Try again." };
    const cfg = cfgOf(env);
    try {
      const cred = await verifyRegistration(
        { rawId: parts.cred.rawId, clientDataJSON: parts.resp.clientDataJSON, attestationObject: parts.resp.attestationObject },
        { challenge: ch.challenge, origin: cfg.origin, rpId: cfg.rpId, requireUserVerification: true },
      );
      if (await db.prepare("SELECT 1 AS x FROM link_credentials WHERE id = ?").bind(cred.credentialId).first()) return { error: "This passkey is already in use. Make a new one." };
      return { kind: "passkey", cred };
    } catch (e) {
      if (e instanceof WebAuthnError) return { error: "That passkey didn't work. Try again." };
      throw e;
    }
  }
  const pw = body.password;
  const problem = passwordProblem(pw, null);
  if (problem) return { error: `${upper(problem)}.` };
  return { kind: "password", hash: await hashPassword(pw as string) };
}

/** Put the lock on an open link. False when the link already had one (nothing changes). */
export async function applyLock(db: D1Like, token: string, lock: LockInput, now: Date): Promise<boolean> {
  if (lock.kind === "password") {
    const r = await db
      .prepare("UPDATE projects SET lock_kind = 'password', lock_hash = ?, lock_failures = 0, lock_failed_at = NULL WHERE token = ? AND lock_kind IS NULL RETURNING token")
      .bind(lock.hash, token)
      .first();
    return !!r;
  }
  // the key first, then the lock: a lock with no key would shut the owner out
  const c = lock.cred;
  await db
    .prepare("INSERT INTO link_credentials (id, token, public_key, alg, sign_count, created) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(c.credentialId, token, b64url(c.publicKey), c.alg, c.signCount, now.toISOString())
    .run();
  const r = await db.prepare("UPDATE projects SET lock_kind = 'passkey', lock_hash = NULL WHERE token = ? AND lock_kind IS NULL RETURNING token").bind(token).first();
  if (!r) await db.prepare("DELETE FROM link_credentials WHERE id = ?").bind(c.credentialId).run();
  return !!r;
}

// --------------------------------------------------------------------------------------------- reading bodies

/** A JSON object body, or a form's fields (the no-script unlock and /start forms). null: neither, or too large. */
export async function readBody(request: Request, cap = 96 * 1024): Promise<{ form: boolean; body: Record<string, unknown> } | null> {
  const type = mediaType(request);
  const raw = await readCapped(request, cap);
  if (raw === null) return null;
  const text = new TextDecoder().decode(raw);
  if (type === "application/x-www-form-urlencoded") {
    const body: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(text)) body[k] = v;
    return { form: true, body };
  }
  if (!text.trim()) return { form: type !== "application/json", body: {} };
  if (type !== "application/json") return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? { form: false, body: v as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------------------------- the routes

/** Where an unlock form may send the browser back to: the link's own dashboard or setup page. */
function backTo(v: unknown, secret: string): string {
  return v === `/start/${secret}` ? v : `/dashboard/${secret}`;
}

/**
 * /api/link/<secret>/... for a known link (`token`): unlock it (a password, or a passkey with its options first), or
 * protect an open one. null for a path this module does not serve.
 */
export async function routeLink(request: Request, env: Env, db: D1Like, rest: string, secret: string, token: string, name: string, now: Date): Promise<Response | null> {
  if (request.method !== "POST") return ["unlock", "unlock/passkey", "lock", "lock/passkey"].includes(rest) ? fail(405, "method not allowed") : null;
  const cfg = cfgOf(env);
  if (!originOk(request, cfg)) return fail(403, "cross-origin request refused");
  const kind = await lockKind(db, token);

  if (rest === "lock/passkey") {
    if (kind) return fail(409, "This dashboard is already protected.");
    return registerOptions(env, db, "link-add", { token }, passkeyLabel(name), now);
  }

  if (rest === "lock") {
    if (kind) return fail(409, "This dashboard is already protected.");
    const read = await readBody(request);
    if (!read) return fail(400, "Something went wrong. Try again.");
    const lock = await readLock(env, db, read.body, "link-add", token, now);
    if ("error" in lock) return fail(400, lock.error);
    if (!(await applyLock(db, token, lock, now))) return fail(409, "This dashboard is already protected.");
    return json(200, { ok: true, lock: lock.kind }, { "set-cookie": await linkSession(env, db, token, now) });
  }

  if (rest === "unlock/passkey") {
    if (kind !== "passkey") return fail(400, "This dashboard uses a password.");
    const creds = await db.prepare("SELECT id FROM link_credentials WHERE token = ?").bind(token).all<{ id: string }>();
    const ch = await putChallenge(db, "link-unlock", { token }, now);
    return json(200, {
      id: ch.id,
      publicKey: { challenge: ch.challenge, rpId: cfg.rpId, timeout: CHALLENGE_MS, userVerification: "required", allowCredentials: creds.results.map((c) => ({ type: "public-key", id: c.id })) },
    });
  }

  if (rest === "unlock") {
    const read = await readBody(request);
    if (!read) return fail(400, "Something went wrong. Try again.");
    const form = read.form;
    const next = backTo(read.body.next, secret);
    const answer = async (status: number, error: string | null, extra: Record<string, string> = {}): Promise<Response> => {
      if (!error) {
        const cookie = await linkSession(env, db, token, now);
        return form ? new Response(null, { status: 303, headers: { location: next, "set-cookie": cookie, "cache-control": "no-store" } }) : json(200, { ok: true }, { "set-cookie": cookie });
      }
      if (!form) return fail(status, error, extra);
      const nonce = randomBase62(22);
      return new Response(unlockPage(nonce, { secret, kind: kind ?? "password", next, error }), { status, headers: { ...securityHeaders(nonce, {}, { account: true }), ...extra } });
    };
    if (!kind) return answer(200, null);
    if (kind === "passkey") {
      const parts = credentialParts(read.body.passkey);
      if (!parts) return answer(400, "Use your passkey to unlock.");
      const ch = await takeChallenge(db, parts.id, "link-unlock", now);
      if (!ch || ch.data.token !== token) return answer(400, "This passkey request expired. Try again.");
      let credId: string;
      try {
        credId = b64url(fromB64url(parts.cred.rawId, "rawId"));
      } catch {
        return answer(400, "That passkey didn't work. Try again.");
      }
      if (!CREDENTIAL_ID_RE.test(credId)) return answer(400, "That passkey didn't work. Try again.");
      const row = await db
        .prepare("SELECT public_key, alg, sign_count FROM link_credentials WHERE id = ? AND token = ?")
        .bind(credId, token)
        .first<{ public_key: string; alg: number; sign_count: number }>();
      if (!row) return answer(400, "That passkey isn't for this dashboard.");
      let v;
      try {
        v = await verifyAssertion(
          { clientDataJSON: parts.resp.clientDataJSON, authenticatorData: parts.resp.authenticatorData, signature: parts.resp.signature },
          { challenge: ch.challenge, origin: cfg.origin, rpId: cfg.rpId, requireUserVerification: true },
          { publicKey: fromB64url(row.public_key), alg: Number(row.alg), signCount: Number(row.sign_count) },
        );
      } catch (e) {
        if (e instanceof WebAuthnError) return answer(400, "That passkey didn't work. Try again.");
        throw e;
      }
      const upd = await db
        .prepare("UPDATE link_credentials SET sign_count = ?, last_used = ? WHERE id = ? AND sign_count = ? RETURNING id")
        .bind(v.signCount, now.toISOString(), credId, row.sign_count)
        .first();
      if (!upd) return answer(409, "Try again.");
      return answer(200, null);
    }
    // a password: the same spacing after wrong ones as an account's (none for the first few, then 30 s doubling)
    const lock = (await lockRow(db, token))!;
    const lastFail = lock.lock_failed_at ? Date.parse(lock.lock_failed_at) : 0;
    const failures = now.getTime() - lastFail > FAILURE_WINDOW_MS ? 0 : Number(lock.lock_failures) || 0;
    const wait = delayAfter(failures) - (now.getTime() - lastFail);
    if (failures && wait > 0) return answer(429, `Too many tries. Try again in ${waitText(wait)}.`, { "retry-after": String(Math.ceil(wait / 1000)) });
    const pw = typeof read.body.password === "string" ? read.body.password : "";
    if (pw && pw.length <= 1024 && lock.lock_hash && (await verifyPassword(pw, lock.lock_hash))) {
      await db.prepare("UPDATE projects SET lock_failures = 0, lock_failed_at = NULL WHERE token = ?").bind(token).run();
      return answer(200, null);
    }
    await db.prepare("UPDATE projects SET lock_failures = ?, lock_failed_at = ? WHERE token = ?").bind(failures + 1, now.toISOString(), token).run();
    return answer(400, pw ? "Wrong password." : "Enter the password.");
  }
  return null;
}

// --------------------------------------------------------------------------------------------- the unlock page

/**
 * The page a protected link shows a browser that has not unlocked it: one field and one button (a password), or one
 * button (a passkey). The password form also works without scripts.
 */
export function unlockPage(nonce: string, o: { secret: string; kind: LockKind; next: string; error?: string }): string {
  const api = `/api/link/${o.secret}/unlock`;
  const inner =
    o.kind === "password"
      ? `<form class="st-card" id="uf" method="post" action="${esc(api)}">
  <input type="hidden" name="next" value="${esc(o.next)}">
  <div class="fld"><label for="pw">Password</label><input type="password" id="pw" name="password" autocomplete="current-password" required autofocus></div>
  <p id="err" class="lk-err" role="alert">${o.error ? esc(o.error) : ""}</p>
  <button class="btn green xl" id="go" type="submit">Unlock</button>
</form>`
      : `<div class="st-card">
  <p id="err" class="lk-err" role="alert">${o.error ? esc(o.error) : ""}</p>
  <button class="btn green xl" id="go" type="button">${icon("key", 16)}Unlock with passkey</button>
  <noscript><p class="muted small">Turn on JavaScript to use your passkey.</p></noscript>
</div>`;
  const body = `
<div class="st">
  <div class="lk-ic">${icon("lock", 28)}</div>
  <h1>This dashboard is protected</h1>
  ${inner}
</div>
<style nonce="${nonce}">${START_CSS}</style>`;
  const script = `
(function(){
  var go = document.getElementById("go"), err = document.getElementById("err"), next = ${embed(o.next)}, api = ${embed(api)};
  if (!go || !window.fetch) return;
  function done(){ location.replace(next); }
  function oops(e){ err.textContent = gcLkWhy(e); go.disabled = false; }
  var f = document.getElementById("uf");
  if (f) f.addEventListener("submit", function(ev){
    ev.preventDefault(); err.textContent = ""; go.disabled = true;
    gcLkPost(api, { password: document.getElementById("pw").value }).then(done, oops);
  });
  else go.addEventListener("click", function(){
    err.textContent = ""; go.disabled = true;
    gcLkGet(api + "/passkey").then(function(p){ return gcLkPost(api, { passkey: p }); }).then(done, oops);
  });
})();`;
  return shell(nonce, "Protected dashboard | GenClass", body, script, { account: true, nav: QUIET_NAV, lock: true });
}
