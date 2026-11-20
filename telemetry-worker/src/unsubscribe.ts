// The unsubscribe page for email a person at GenClass writes by hand (genclass.dev/unsubscribe, the link in their
// signature). GenClass reports and alerts are not turned off here: each of those carries its own link
// (src/report-routes.ts), which is signed for one account.
//
//   GET  /unsubscribe   the form: an email address and one button
//   POST /unsubscribe   the form's post (or JSON { email }): the address is saved, and the page says so
//
// Invariants:
// - No sign-in and no link token: the link in a signature is the same for everyone, so the person types the address.
// - Nothing is ever sent to the typed address: a form anyone can fill must not be a way to mail a stranger.
// - The answer is the same for an address that was already on the list and one that was not.
// - The request does nothing else: no account, report setting or app is read or changed.
// - A new address sends one short notice to UNSUBSCRIBE_NOTIFY (when that and the EMAIL binding are set), at most
//   NOTIFY_DAILY_CAP a day, so the form cannot fill that inbox. The row is saved either way.
// - AUTH_LIMIT per network, like the sign-in routes.

import { ACCOUNT_CSS } from "./account-pages.js";
import { cleanEmail, fail, page, RECOVERY_CONTACT } from "./auth.js";
import type { Env, HandleOptions } from "./collector.js";
import { sha256Hex } from "./dashboard.js";
import { esc } from "./escape.js";
import { json, mediaType, readCapped } from "./http.js";
import { LOGO, shell } from "./pages.js";
import { FROM } from "./report.js";

/** Notices to UNSUBSCRIBE_NOTIFY in one UTC day; past it the rows are still saved. */
export const NOTIFY_DAILY_CAP = 50;
const MAX_BODY = 2048;

const PAGE_CSS = `
.un{display:grid;gap:14px;max-width:420px}
.un label{font-size:14px;font-weight:500}
.un-note{color:var(--ink3);font-size:13px;margin:0}
.un-err{color:var(--warn-f,#e5484d);font-size:14px;margin:0}`;

function barePage(nonce: string, title: string, inner: string): string {
  return shell(nonce, `${title} | GenClass`, `<style nonce="${nonce}">${ACCOUNT_CSS}${PAGE_CSS}</style><div class="auth">${LOGO}${inner}</div>`, "", { bare: true, account: true });
}

function formPage(nonce: string, o: { error?: string; typed?: string } = {}): string {
  return barePage(
    nonce,
    "Unsubscribe",
    `<h1>Unsubscribe</h1>
<p class="lead">Enter your email address and we will not write to you again.</p>
<form class="pwf un" method="post" action="/unsubscribe">
  <div><label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com" value="${esc(o.typed ?? "")}" required${o.error ? ' aria-describedby="un-err" aria-invalid="true"' : ""}></div>
  ${o.error ? `<p class="un-err" id="un-err" role="alert">${esc(o.error)}</p>` : ""}
  <button class="btn prov green" type="submit"><span>Unsubscribe</span></button>
</form>
<p class="un-note">Reports from your own GenClass account are turned off with the link at the bottom of each report.</p>`,
  );
}

const donePage = (nonce: string, email: string): string =>
  barePage(nonce, "You are unsubscribed", `<h1>You are unsubscribed</h1>\n<p class="lead">We will not write to ${esc(email)} again.</p>`);

const failedPage = (nonce: string): string =>
  barePage(
    nonce,
    "That did not save",
    `<h1>That did not save</h1>\n<p class="lead">Something went wrong on our side. Write to <a href="mailto:${esc(RECOVERY_CONTACT)}?subject=Unsubscribe">${esc(RECOVERY_CONTACT)}</a> and we will take you off the list by hand.</p>`,
  );

/** The address a form post or a JSON body carries, as typed (a string, possibly not an email), or a response to send. */
async function typedEmail(request: Request): Promise<string | Response> {
  const raw = await readCapped(request, MAX_BODY);
  if (raw === null) return fail(413, "body too large");
  const text = new TextDecoder().decode(raw);
  if (mediaType(request) === "application/json") {
    try {
      const v: unknown = JSON.parse(text);
      const e = v && typeof v === "object" ? (v as { email?: unknown }).email : undefined;
      return typeof e === "string" ? e : "";
    } catch {
      return "";
    }
  }
  return new URLSearchParams(text).get("email") ?? "";
}

async function overLimit(env: Env, request: Request): Promise<boolean> {
  const lim = env.AUTH_LIMIT;
  if (!lim) return false;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  try {
    return !(await lim.limit({ key: (await sha256Hex(`unsubscribe:${ip}`)).slice(0, 32) })).success;
  } catch {
    return false; // the limiter is best effort
  }
}

/** The notice for a newly saved address. Never throws; never mails the typed address. */
async function notify(env: Env, email: string, now: Date): Promise<void> {
  const to = cleanEmail(env.UNSUBSCRIBE_NOTIFY);
  if (!env.EMAIL || !env.DB || !to) return;
  try {
    const day = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM unsubscribes WHERE created >= ?").bind(day).first<{ n: number }>();
    if ((row?.n ?? 0) > NOTIFY_DAILY_CAP) return;
    const line = `${email} asked for no more email from GenClass (genclass.dev/unsubscribe, ${now.toISOString()}). Do not write to this address again.`;
    await env.EMAIL.send({ to, from: FROM, subject: `Unsubscribe: ${email}`, text: line, html: `<p>${esc(line)}</p>` });
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code).slice(0, 40) : "error";
    console.log(`unsubscribe: the notice was not sent (${code})`);
  }
}

/** The unsubscribe page's route. Returns null for any other path (the caller continues routing). */
export async function routeUnsubscribe(request: Request, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  if (path !== "/unsubscribe") return null;
  const m = request.method;
  if (m === "GET" || m === "HEAD") return page(200, (n) => formPage(n));
  if (m !== "POST") return fail(405, "method not allowed", { allow: "GET, POST" });
  const wantsJson = mediaType(request) === "application/json";
  if (await overLimit(env, request)) {
    if (wantsJson) return fail(429, "too many requests from your network; try again in a minute", { "retry-after": "60" });
    const r = page(429, (n) => formPage(n, { error: "Too many requests came from your network. Wait a minute, then try again." }));
    r.headers.set("retry-after", "60");
    return r;
  }
  const typed = await typedEmail(request);
  if (typed instanceof Response) return typed;
  const email = cleanEmail(typed)?.toLowerCase() ?? null;
  if (!email) {
    if (wantsJson) return fail(400, "email must be an email address");
    return page(400, (n) => formPage(n, { error: "That does not look like an email address.", typed: typed.slice(0, 254) }));
  }
  const now = (opts.now ?? (() => new Date()))();
  let added = false;
  try {
    if (!env.DB) throw new Error("no database");
    added = !(await env.DB.prepare("SELECT 1 AS x FROM unsubscribes WHERE email = ?").bind(email).first<{ x: number }>());
    if (added) await env.DB.prepare("INSERT OR IGNORE INTO unsubscribes (email, created) VALUES (?, ?)").bind(email, now.toISOString()).run();
  } catch {
    // no database, or migration 0024 not applied: say so, with a way to reach a person
    return wantsJson ? fail(503, "unsubscribe is unavailable") : page(503, (n) => failedPage(n));
  }
  if (added) {
    const task = notify(env, email, now);
    if (opts.waitUntil) opts.waitUntil(task);
    else await task;
  }
  return wantsJson ? json(200, { ok: true }) : page(200, (n) => donePage(n, email));
}
