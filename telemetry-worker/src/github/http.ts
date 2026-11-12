// The GitHub App's routes on this worker. Checked before the account routes (src/auth.ts); null for any other path.
//
//   POST /api/github/webhook        GitHub only: the app's webhook (signature, then src/github/handlers.ts)
//   POST /api/github/marketplace    GitHub only: the Marketplace listing's webhook (plan purchases and changes)
//   GET  /github                    the app's public page: what it does, what it may read and write, install
//   GET  /github/install            to GitHub's install page for the app
//   GET  /github/setup              where GitHub sends someone after installing: what the app does, the one step
//                                   left, and "Continue with GitHub" (reviews need no account)
//   GET  /github/connect            ask GitHub who this is and which installations they can reach; from a browser
//                                   that is not signed in, GitHub's answer also signs the person in
//   GET  /github/callback           GitHub's answer to /github/connect
//   GET  /account/github            signed in: the installations and repositories, and which app each is linked to
//   GET  /api/account/github        the same as JSON
//   POST /api/account/github/repos/<repo id>   { project_id?: string | null, paused?: boolean }
//
// Invariants:
// - A webhook is acted on only when its X-Hub-Signature-256 is the HMAC-SHA256 of the exact bytes received under the
//   app's webhook secret (WebCrypto's verify, constant time). No signature, a wrong one, or an app that is not set up
//   on this server: nothing is parsed. A delivery id is handled once.
// - The webhook answers at once and works after the response (waitUntil), so GitHub's 10 seconds are never at risk.
//   The job has a deadline counted from the moment the webhook arrived (handlers.ts JOB_MS), well inside the 30
//   seconds the platform gives work after a response. A job that fails, or runs out of time, forgets its delivery id,
//   so "Redeliver" on GitHub's side runs it again; a job that ended marks its delivery done, and one the platform
//   stopped before it could do either can be redelivered a minute later (store.ts claimDelivery).
// - /github/setup trusts nothing in its address (GitHub's documentation warns that `installation_id` there can be
//   made up): it is a static page. Who may manage what is established only by /github/connect, where GitHub itself
//   answers which installations and repositories the signed-in person can reach.
// - An installation is managed (its `owner`, whose plan decides whether its private repositories are read:
//   entitlement.ts) only by the GenClass account of the person whose own GitHub account it is on, by GitHub's answer
//   to who they are. Reaching or pushing to a repository of an installation never makes an account its manager. An
//   organization's installation is never claimed here: with this app's permissions GitHub does not say who
//   administers an organization (GET /user/memberships/orgs/{org} needs the organization permission "Members"), so
//   the server's operator sets that account by hand (docs/github-app/SETUP.md). Connecting never takes an
//   installation from an account whose plan includes private repositories for one whose plan does not.
// - The user access token from /github/callback is used for those few questions and dropped: never stored, never
//   logged. What is kept for 30 minutes is the answer (repository ids, names, default branches and whether the person
//   can push).
// - /github/connect from a browser that is not signed in ("Continue with GitHub" on /github/setup) is GitHub sign-in
//   through the app's own OAuth client: GitHub's answer to who the person is signs them in to the account that has
//   that GitHub identity, or makes one (auth.ts signInWithGithubIdentity: the same path as GitHub sign-in, so an
//   account with a passkey still needs it), and the same answer is kept for that account. Nothing in the callback's
//   address chooses the account, and such a start is rate limited like every sign-in start that stores a row.
// - A repository is linked to a GenClass app only by an account that owns the app AND can push to the repository
//   according to that answer, from the browser, with this server's Origin (CSRF). Taking a link away needs less: the
//   account that owns the linked app can always do it (same browser session and Origin), with or without access to
//   the repository, because the link posts that app's findings there.
// - The account page reads its rows in a few statements however many repositories GitHub listed (store.ts
//   installationsByIds, reposByIds), never one statement per repository.
// - The Marketplace listing's webhook may be set to send a form (application/x-www-form-urlencoded: the JSON in a
//   field named `payload`, signed over the form's bytes). Such a delivery is checked against its signature over the
//   exact bytes received before anything is parsed, like every other; only then is the field taken out and handed
//   to the webhook handler as the JSON delivery it stands for (formDelivery). Only what GitHub sends is taken as a
//   form: a body that is exactly one `payload` field. Anything else is refused (400), so that bytes GitHub signed as
//   JSON for the app's webhook (a comment's text may hold "&payload=...") can never be read as a form that sets a plan.
// - The callback asks again once, and only where a second try is safe: the code's exchange when the request itself got
//   no answer (never after GitHub answered about the code, which is good once), and GitHub's answers about the person
//   when GitHub refused a token it had just issued, did not answer, or this server could not save what it said. A
//   rate limit, a refusal or a malformed answer is never asked twice, and nothing is asked again once the callback
//   has taken RETRY_WITHIN_MS. When it still fails, the page names the step that failed (CONNECT_FAILED) and the log
//   line names the step and how it failed: no token, no code, nothing of the person.
// - The OAuth state is single use, kept server-side and named by a cookie that holds only its row id; the callback
//   must arrive in the session that started it, or, for a start made signed out, in the browser that holds the cookie.
// - What the account page says the app is doing on a repository (race files read, pull requests written on) is shown
//   only for repositories GitHub's answer lists for that person, and comes in one statement per 90 of them.

import { accountContext, accountProjects, csrfFail, fail, getCookie, oauthStartLimited, originOk, ownedProject, page, readJson, redirect, signInWithGithubIdentity, webSession, type C } from "../auth.js";
import { messagePage } from "../account-pages.js";
import type { Env, HandleOptions } from "../collector.js";
import { randomBase62 } from "../dashboard.js";
import { json, readCapped } from "../http.js";
import { securityHeaders } from "../pages.js";
import { accountAccess, entitled } from "../plans.js";
import { b64url, equalStrings } from "../webauthn.js";
import { GithubError, posInt, repoPath, userClient, type Fetch } from "./api.js";
import { githubApp, installUrl, isOwnAccount, type GithubAppConfig } from "./config.js";
import { repoEntitled } from "./entitlement.js";
import { handleEvent, jobContext, OutOfTime } from "./handlers.js";
import { AppKeyError } from "./jwt.js";
import { accountGithubPage, githubLandingPage, githubSetupPage, type GithubAccountView } from "./pages.js";
import { claimDelivery, finishDelivery, forgetDelivery, installationById, installationsByIds, installationsOf, linkRepo, pauseRepo, repoActivityByIds, repoById, reposByIds, reposLinkedToAccount, setInstallationOwner, unlinkRepo, upsertInstallation } from "./store.js";
import { BRANCH_RE } from "./workflow-file.js";

/** Largest webhook body read (an installation event lists every repository it covers). */
export const MAX_WEBHOOK_BYTES = 3 * 1024 * 1024;
const EVENTS = new Set(["ping", "installation", "installation_repositories", "pull_request", "workflow_run", "check_run", "issue_comment", "github_app_authorization", "marketplace_purchase"]);
const DELIVERY_RE = /^[0-9A-Fa-f-]{16,64}$/;
const OAUTH_COOKIE = "gc_oauth_ghapp";
const OAUTH_MS = 10 * 60_000;
/** The pause before the callback asks GitHub the same things a second time. */
export const RETRY_WAIT_MS = 1_000;
/** No second try once the callback has taken this long: someone is looking at a blank tab. */
export const RETRY_WITHIN_MS = 15_000;

/** What the callback was doing: the code's exchange, then GitHub's answers about the person, then this server's own write. */
type ConnectStep = "code" | "who" | "installations" | "repositories" | "save";
/** What the page says when a step failed, so a person can say which one it was (this server keeps no request logs). */
const CONNECT_FAILED: Record<ConnectStep, string> = {
  code: "GitHub did not answer when asked to confirm your sign-in.",
  who: "GitHub did not say who you are.",
  installations: "GitHub did not say where the app is installed.",
  repositories: "GitHub did not say which repositories the app is on.",
  save: "GitHub answered, but GenClass could not save what it said.",
};
/** How long GitHub's answer about a person's repositories is good for linking. */
export const GRANT_MS = 30 * 60_000;
const MAX_INSTALLATIONS = 20;
const MAX_GRANT_REPOS = 300;

// --------------------------------------------------------------------------------------------- webhook signature

/**
 * Whether `header` ("sha256=<hex>") is the HMAC-SHA256 of `body` under `secret`. The comparison is WebCrypto's
 * verify, which does not leak where two signatures differ.
 */
export async function verifyGithubSignature(body: Uint8Array, header: string | null, secret: string): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/.exec((header ?? "").trim());
  if (!m || !secret) return false;
  const sig = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sig[i] = parseInt(m[1]!.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig as BufferSource, body as BufferSource);
}

async function webhook(request: Request, env: Env, opts: HandleOptions, cfg: GithubAppConfig | null, which: "app" | "marketplace"): Promise<Response> {
  if (request.method !== "POST") return fail(405, "method not allowed");
  if (!cfg || !env.DB) return fail(503, "the GitHub App is not set up on this server");
  const now = opts.now ?? (() => new Date());
  // the job's time is counted from here: what reading and checking the delivery takes is part of it
  const started = now().getTime();
  const raw = await readCapped(request, MAX_WEBHOOK_BYTES);
  if (raw === null) return fail(413, "body too large");
  // the listing's webhook has a secret of its own on GitHub's side; unset here, the app's is expected for both
  const secret = which === "marketplace" ? (env.GITHUB_MARKETPLACE_WEBHOOK_SECRET ?? "").trim() || cfg.webhookSecret : cfg.webhookSecret;
  if (!(await verifyGithubSignature(raw, request.headers.get("x-hub-signature-256"), secret))) return fail(401, "signature check failed");
  const event = (request.headers.get("x-github-event") ?? "").trim();
  const delivery = (request.headers.get("x-github-delivery") ?? "").trim();
  if (!DELIVERY_RE.test(delivery)) return fail(400, "no delivery id");
  // each endpoint takes its own events: the listing's webhook cannot start a review, the app's cannot set a plan
  const taken = which === "marketplace" ? event === "marketplace_purchase" || event === "ping" : EVENTS.has(event) && event !== "marketplace_purchase";
  if (!taken) return json(200, { ok: true, result: "ignored" });
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return fail(400, "invalid JSON");
  }
  const db = env.DB;
  if (!(await claimDelivery(db, delivery, event, now()))) return json(200, { ok: true, duplicate: true });
  const ctx = jobContext({ env, db, cfg, f: opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i)), now }, started);
  const job = handleEvent(ctx, event, payload)
    .then(async (result) => {
      // ended: never run again. (A delivery left neither done nor forgotten is one the platform stopped.)
      await finishDelivery(db, delivery, now()).catch(() => undefined);
      return result;
    })
    .catch(async (e: unknown) => {
      // forgotten, so that a redelivery runs it; the reason is a word, never a payload
      await forgetDelivery(db, delivery).catch(() => undefined);
      const why = e instanceof OutOfTime || now().getTime() >= ctx.deadline ? "deadline" : e instanceof GithubError ? e.kind : "error";
      // a key that cannot be used says why in words that hold no key material (jwt.ts), which is what setup needs to see
      console.log(`github webhook: ${event} failed: ${why}${e instanceof AppKeyError ? ` (${e.message})` : ""}`);
      return `failed: ${why}`;
    });
  if (opts.waitUntil) {
    opts.waitUntil(job);
    return json(202, { ok: true, queued: true });
  }
  const result = await job;
  return json(result.startsWith("failed") ? 502 : 200, { ok: !result.startsWith("failed"), result });
}

// --------------------------------------------------------------------------------------------- the listing's webhook, sent as a form

const FORM_TYPE = "application/x-www-form-urlencoded";

/** "sha256=<hex>" for `body` under `secret`: what verifyGithubSignature accepts for exactly these bytes. */
async function githubSignature(body: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, body as BufferSource));
  let hex = "";
  for (const b of sig) hex += b.toString(16).padStart(2, "0");
  return `sha256=${hex}`;
}

/**
 * The Marketplace listing's webhook form offers two content types. With application/x-www-form-urlencoded GitHub posts
 * `payload=<the JSON, percent-encoded>` and signs those bytes; GitHub does not send a Marketplace delivery again, so
 * a purchase answered with "invalid JSON" would be lost. This takes such a delivery before the webhook handler does:
 * the signature is checked over the exact bytes received (401 otherwise, nothing parsed), then the handler gets the
 * JSON from the `payload` field as an ordinary JSON delivery with the same event and delivery headers. Its
 * signature header is computed here for those JSON bytes under the same secret, because the handler checks every
 * body it parses; that value is made only for a body GitHub's own signature covered and never leaves this worker.
 * A form is taken only in the shape GitHub sends it: the body starts with `payload=` and holds no `&`, so it is that
 * one field and nothing else. Any other body is refused with 400 and no field is looked for in it: a JSON delivery
 * that GitHub signed for the app's own webhook, sent here as a form with its signature (the two endpoints share a
 * secret until the listing has its own), starts with `{` and is not searched for a `payload` inside its text.
 * Any other request (JSON, another method, an app that is not set up) is returned untouched, its body unread.
 */
async function formDelivery(request: Request, env: Env, cfg: GithubAppConfig | null): Promise<Request | Response> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (request.method !== "POST" || !cfg || type !== FORM_TYPE) return request;
  const raw = await readCapped(request, MAX_WEBHOOK_BYTES);
  if (raw === null) return fail(413, "body too large");
  // the same secret the webhook handler expects on this endpoint: the listing's own, else the app's
  const secret = (env.GITHUB_MARKETPLACE_WEBHOOK_SECRET ?? "").trim() || cfg.webhookSecret;
  if (!(await verifyGithubSignature(raw, request.headers.get("x-hub-signature-256"), secret))) return fail(401, "signature check failed");
  const form = new TextDecoder().decode(raw);
  // exactly one field, named payload: what GitHub sends, and nothing that merely holds such a field somewhere
  if (!form.startsWith("payload=") || form.includes("&")) return fail(400, "invalid JSON");
  const payload = new URLSearchParams(form).get("payload");
  if (payload === null) return fail(400, "invalid JSON");
  const body = new TextEncoder().encode(payload);
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.set("x-hub-signature-256", await githubSignature(body, secret));
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body });
}

// --------------------------------------------------------------------------------------------- connect (OAuth)

interface GrantRepo {
  id: number;
  name: string;
  private: boolean;
  installation: number;
  push: boolean;
  /** The repository's default branch as GitHub named it, when it is a name the workflow link takes. */
  branch?: string;
}
interface Grant {
  github: { id: number; login: string };
  repos: GrantRepo[];
  /** More repositories than MAX_GRANT_REPOS were reachable; the rest are not listed. */
  more: boolean;
  expires: string;
}

const cookie = (c: C, name: string, value: string, maxAgeS: number, path: string): string =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${c.cfg.secure ? "; Secure" : ""}`;

/**
 * GET /github/connect: to GitHub's authorization page for the app, with a state kept on the server. Signed in, the
 * state belongs to the session ("Connect GitHub"). Not signed in ("Continue with GitHub" on /github/setup), it belongs
 * to this browser only, through the cookie that names its row: GitHub's answer to who this is then signs the person
 * in (connectCallback), so installing the app and having an account is one round trip.
 */
async function connectStart(c: C, cfg: GithubAppConfig): Promise<Response> {
  if (!cfg.clientId) return page(404, (n) => messagePage(n, { title: "Connecting GitHub is not set up", text: "This GenClass server has no client id and secret for its GitHub App, so it cannot ask GitHub who you are. Reviews work without it.", links: [["Your apps", "/account"]] }));
  const a = await webSession(c);
  const id = randomBase62(22);
  const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const insert = c.db.prepare("INSERT INTO challenges (id, kind, challenge, account_id, data, expires) VALUES (?, 'oauth:ghapp', ?, ?, ?, ?)");
  const expires = new Date(c.now.getTime() + OAUTH_MS).toISOString();
  if (a) {
    // one start at a time per account: a page that makes a signed-in browser load this address cannot pile up rows
    await c.db.batch([c.db.prepare("DELETE FROM challenges WHERE kind = 'oauth:ghapp' AND account_id = ?").bind(a.account.id), insert.bind(id, state, a.account.id, JSON.stringify({ sid: a.sessionId }), expires)]);
  } else {
    // no account to keep to one row, so these starts are rate limited like every sign-in start that stores one
    const limited = await oauthStartLimited(c);
    if (limited) return limited;
    await insert.bind(id, state, null, JSON.stringify({ signin: true }), expires).run();
  }
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: `${cfg.origin}/github/callback`, state });
  return redirect(`${cfg.web}/login/oauth/authorize?${q}`, [cookie(c, OAUTH_COOKIE, id, OAUTH_MS / 1000, "/github")]);
}

async function connectCallback(c: C, cfg: GithubAppConfig, f: Fetch): Promise<Response> {
  const clear = cookie(c, OAUTH_COOKIE, "", 0, "/github");
  // where "Try again" leads: the account page, or, for a start made signed out, the start itself
  let again = "/account/github";
  const bad = (status: number, text: string): Response => {
    const r = page(status, (n) => messagePage(n, { title: "GitHub was not connected", text, links: [["Try again", again]] }));
    r.headers.append("set-cookie", clear);
    return r;
  };
  if (!cfg.clientId || !cfg.clientSecret) return bad(404, "This GenClass server cannot ask GitHub who you are.");
  // GitHub sent someone here on its own, after an install (an app set to ask for authorization while installing):
  // there is no state of ours, so nothing is exchanged and they get the page every installer gets
  if (!c.url.searchParams.has("state") && c.url.searchParams.has("installation_id")) return redirect("/github/setup");
  const id = getCookie(c.req, OAUTH_COOKIE);
  const row =
    id && /^[A-Za-z0-9]{22}$/.test(id)
      ? await c.db.prepare("DELETE FROM challenges WHERE id = ? AND kind = 'oauth:ghapp' RETURNING challenge, account_id, data, expires").bind(id).first<{ challenge: string; account_id: string | null; data: string | null; expires: string }>()
      : null;
  // a start made signed out names no account: its row belongs to this browser alone
  if (row && row.account_id === null) again = "/github/connect";
  if (c.url.searchParams.get("error")) return bad(400, "GitHub did not authorize this. Nothing was connected.");
  const state = c.url.searchParams.get("state");
  if (!row || Date.parse(row.expires) <= c.now.getTime() || !state || !equalStrings(state, row.challenge)) {
    // also what a visit that GitHub started (an install with no state of ours) gets: nothing is exchanged
    return bad(400, "This link expired or was opened in another browser. Start again from your account page.");
  }
  const a = await webSession(c);
  let data: { sid?: unknown; signin?: unknown } = {};
  try {
    data = (JSON.parse(row.data ?? "{}") ?? {}) as { sid?: unknown; signin?: unknown };
  } catch {
    /* no session recorded */
  }
  const signin = row.account_id === null && data.signin === true;
  // a start made by a session must come back in that session; one made signed out has no session to come back in
  if (!signin && (!a || a.account.id !== row.account_id || a.sessionId !== data.sid)) return bad(403, "Your session changed while you were away. Sign in, then connect GitHub again.");
  const code = c.url.searchParams.get("code");
  if (!code || code.length > 2048) return bad(400, "GitHub did not send a code. Start again.");

  // the step under way, for the page and the log line when it fails
  const at: { step: ConnectStep } = { step: "code" };
  const clock = c.opts.now ?? (() => new Date());
  const began = clock().getTime();
  const wait = c.opts.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let twice = false;
  let answer: Answer;
  try {
    const exchange = (): Promise<Response> =>
      f(`${cfg.web}/login/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "genclass.dev" },
        body: new URLSearchParams({ client_id: cfg.clientId ?? "", client_secret: cfg.clientSecret ?? "", code, redirect_uri: `${cfg.origin}/github/callback` }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    let r: Response;
    try {
      r = await exchange();
      if (r.status >= 500) {
        await r.body?.cancel().catch(() => undefined);
        throw new GithubError("server", r.status, "GitHub's sign-in answered a server error");
      }
    } catch {
      // The request itself got no answer (the network, a timeout, GitHub's own 5xx): handed in once more. An answer
      // about the code is never asked for twice.
      twice = true;
      r = await exchange();
    }
    const tok = ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (!r.ok || typeof tok.access_token !== "string" || !tok.access_token) {
      // GitHub's own word for why (a short code such as bad_verification_code, never the token or the code itself),
      // so a failed connect can be told apart afterwards: this server keeps no request logs to look it up in
      const why = typeof tok.error === "string" && /^[a-z_]{1,60}$/.test(tok.error) ? tok.error : `http ${r.status}`;
      console.log(`github connect: no token: ${why}${twice ? " (asked twice)" : ""}`);
      // A code is good once and for ten minutes: a page that was loaded twice, or left open, ends here. Not when this
      // was the second try: then GitHub took the code the first time and its answer never arrived.
      if (why === "bad_verification_code" && !twice) return bad(400, "GitHub says this link was already used or has expired. Start again: it takes a few seconds.");
      throw new Error("no token");
    }
    const token = tok.access_token;
    try {
      answer = await readGrant(c, cfg, f, token, at);
    } catch (e) {
      // Asked once more, after a pause, only where that can help: GitHub refused a token it issued a moment ago, did
      // not answer (the client has already tried each request twice), or this server's own write failed.
      const again = at.step === "save" || (e instanceof GithubError && (e.kind === "unauthorized" || e.kind === "network" || e.kind === "server"));
      if (!again || clock().getTime() - began > RETRY_WITHIN_MS) throw e;
      twice = true;
      await wait(RETRY_WAIT_MS);
      answer = await readGrant(c, cfg, f, token, at);
    }
  } catch (e) {
    const what = e instanceof GithubError ? `${e.kind} ${e.status}` : e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "error";
    console.log(`github connect: failed: ${at.step}: ${what}${twice ? " (asked twice)" : ""}`);
    // this server's own write is not GitHub's failure, and a rate limit does not pass in a minute
    if (at.step === "save") return bad(500, `${CONNECT_FAILED.save} Start again in a minute.`);
    if (e instanceof GithubError && e.kind === "rate_limited") return bad(502, "GitHub is limiting requests right now. Start again in a few minutes.");
    return bad(502, `${CONNECT_FAILED[at.step]} Start again in a minute.`);
  }
  const to = "/account/github?connected=1";
  // signed in (also: signed in since, in this browser, for a start made signed out): the answer is this account's
  if (a) {
    await keepAnswer(c, a.account.id, answer);
    return redirect(to, [clear]);
  }
  // Not signed in: GitHub's answer to who this is signs the person in, as GitHub sign-in does: to the account that
  // has this GitHub identity, or to a new one. With a passkey on the account the response is the passkey step, and
  // the session comes after it; the answer is kept for the account either way.
  const { response, accountId } = await signInWithGithubIdentity(c, answer.grant.github, to);
  if (accountId) await keepAnswer(c, accountId, answer);
  response.headers.append("set-cookie", clear);
  return response;
}

/** GitHub's answer for one person, and the installations of this app that are on that person's own GitHub account. */
interface Answer {
  grant: Grant;
  own: number[];
}

/**
 * Keep GitHub's answer for `accountId` (the newest replaces any earlier one of the account), and make the account the
 * manager of the installations on the person's own GitHub account.
 */
async function keepAnswer(c: C, accountId: string, answer: Answer): Promise<void> {
  for (const id of answer.own) await manageInstallation(c, id, accountId);
  await c.db.batch([
    c.db.prepare("DELETE FROM challenges WHERE kind = 'ghapp:grant' AND account_id = ?").bind(accountId),
    c.db
      .prepare("INSERT INTO challenges (id, kind, challenge, account_id, data, expires) VALUES (?, 'ghapp:grant', ?, ?, ?, ?)")
      .bind(randomBase62(22), b64url(crypto.getRandomValues(new Uint8Array(16))), accountId, JSON.stringify(answer.grant), answer.grant.expires),
  ]);
}

/** The longest default branch name kept with GitHub's answer (a longer one is left out: no workflow button for it). */
const MAX_BRANCH_CHARS = 120;

/**
 * Ask GitHub, as the person, who they are and which installations of THIS app and which of their repositories they
 * can reach, and record those installations. `own` lists the ones on their own GitHub account, which keepAnswer
 * makes theirs to manage. The token goes no further than this function.
 */
async function readGrant(c: C, cfg: GithubAppConfig, f: Fetch, token: string, at: { step: ConnectStep }): Promise<Answer> {
  const gh = userClient(cfg, f, () => c.now, token, 4 + MAX_INSTALLATIONS * 3);
  at.step = "who";
  const me = (await gh.get<Record<string, unknown>>("/user")) ?? {};
  const id = posInt(me.id);
  // the person's own login: letters, digits, hyphens and, for an Enterprise Managed User, an underscore before the
  // short code ("mona-cat_octo"). It is only shown on the account page, through the page's escaping.
  const login = typeof me.login === "string" && /^[A-Za-z0-9_-]{1,39}$/.test(me.login) ? me.login : null;
  if (!id || !login) throw new GithubError("unexpected", 200, "GitHub did not say who this is");
  at.step = "installations";
  const installs = await gh.list<Record<string, unknown>>("/user/installations", { max: 100, key: "installations" });
  const repos: GrantRepo[] = [];
  const own: number[] = [];
  let more = false;
  let seen = 0;
  for (const i of installs) {
    const iid = posInt(i.id);
    // only installations of this app count, whatever else the token can see
    if (!iid || String(i.app_id ?? "") !== cfg.appId) continue;
    if (++seen > MAX_INSTALLATIONS) {
      more = true;
      break;
    }
    const acct = (i.account ?? {}) as Record<string, unknown>;
    const acctId = posInt(acct.id);
    const acctLogin = typeof acct.login === "string" && /^[A-Za-z0-9_-]{1,39}$/.test(acct.login) ? acct.login : null;
    if (!acctId || !acctLogin) continue;
    at.step = "repositories";
    const mine = await gh.list<Record<string, unknown>>(`/user/installations/${iid}/repositories`, { max: MAX_GRANT_REPOS, key: "repositories" });
    for (const r of mine) {
      const rid = posInt(r.id);
      const name = typeof r.full_name === "string" && repoPath(r.full_name) ? r.full_name : null;
      if (!rid || !name) continue;
      const perms = (r.permissions ?? {}) as Record<string, unknown>;
      const push = perms.push === true || perms.admin === true;
      if (repos.length >= MAX_GRANT_REPOS) {
        more = true;
        continue;
      }
      // the default branch, as GitHub names it: where the account page's button opens the workflow file's editor
      const branch = typeof r.default_branch === "string" && r.default_branch.length <= MAX_BRANCH_CHARS && BRANCH_RE.test(r.default_branch) ? r.default_branch : null;
      repos.push({ id: rid, name, private: r.private !== false, installation: iid, push, ...(branch ? { branch } : {}) });
    }
    // the installation is recorded (its webhook may have been missed)
    at.step = "save";
    await upsertInstallation(c.db, { id: iid, accountId: acctId, login: acctLogin, type: String(acct.type ?? "User"), selection: String(i.repository_selection ?? "selected"), suspended: !!i.suspended_at, own: isOwnAccount(cfg, acctLogin) }, c.now);
    // Managed by the person's account only when the installation is on the GitHub account of the person connecting:
    // GitHub's own answer to who they are. What they can reach or push to in it proves nothing about the account it
    // is on (an outside collaborator on one repository of an organization can push there), so it never counts.
    if (acctId === id) own.push(iid);
  }
  return { grant: { github: { id, login }, repos, more, expires: new Date(c.now.getTime() + GRANT_MS).toISOString() }, own };
}

/**
 * Make `accountId` the installation's managing account, for a person GitHub said is the account the installation is
 * on. One case leaves it as it is: the account managing it now has a plan with private repositories and this one has
 * not (the same person's other GenClass account, or one the server's operator set), so that connecting never turns
 * reviews of private repositories off.
 */
async function manageInstallation(c: C, installationId: number, accountId: string): Promise<void> {
  const known = await installationById(c.db, installationId);
  if (!known || known.owner === accountId) return;
  if (known.owner) {
    const theirs = await accountAccess(c.db, known.owner, c.env, c.now);
    if (entitled(theirs.plan, "github_private") && !entitled((await accountAccess(c.db, accountId, c.env, c.now)).plan, "github_private")) return;
  }
  await setInstallationOwner(c.db, installationId, accountId, c.now);
}

async function grantOf(c: C, accountId: string): Promise<Grant | null> {
  const row = await c.db
    .prepare("SELECT data FROM challenges WHERE kind = 'ghapp:grant' AND account_id = ? AND expires > ? ORDER BY expires DESC LIMIT 1")
    .bind(accountId, c.now.toISOString())
    .first<{ data: string | null }>();
  if (!row?.data) return null;
  try {
    const g = JSON.parse(row.data) as Grant;
    return g && Array.isArray(g.repos) && g.github ? g : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------------------------- the account's view

async function accountView(c: C, cfg: GithubAppConfig, accountId: string, who: string): Promise<GithubAccountView> {
  const grant = await grantOf(c, accountId);
  const managed = await installationsOf(c.db, accountId);
  const projects = (await accountProjects(c, accountId)).map((p) => ({ id: p.id!, name: p.name }));
  const access = await accountAccess(c.db, accountId, c.env, c.now);
  const granted = grant?.repos ?? [];
  // The rows come in a few statements however many repositories GitHub listed (up to MAX_GRANT_REPOS): the
  // installations not already at hand in one, what is kept for the repositories in one per 90. Nothing below asks
  // the database once per repository.
  const insts = new Map(managed.map((i) => [i.id, i]));
  for (const i of await installationsByIds(c.db, granted.map((r) => r.installation).filter((id) => !insts.has(id)))) insts.set(i.id, i);
  const stored = new Map((await reposByIds(c.db, granted.map((r) => r.id))).map((r) => [r.repo_id, r]));
  // what the app has done on each repository GitHub's answer lists: one statement per 90 of them
  const activity = new Map((await repoActivityByIds(c.db, granted.map((r) => r.id))).map((r) => [r.repo_id, r]));
  // Whether a private repository is reviewed is a matter of its installation (the plan of the account managing it,
  // or its Marketplace plan), not of the account looking at this page: asked once per installation that lists one.
  const unread = new Map<number, boolean>();
  for (const id of new Set(granted.filter((r) => r.private).map((r) => r.installation))) {
    const inst = insts.get(id);
    unread.set(id, !inst || !(await repoEntitled(c.db, c.env, cfg, inst, { private: true }, c.now)).ok);
  }
  const repos: GithubAccountView["repos"] = granted.map((r) => {
    const s = stored.get(r.id);
    // a link to another account's app is shown as linked, never by name
    const mine = s?.project_id && projects.some((p) => p.id === s.project_id) ? s.project_id : null;
    const did = activity.get(r.id);
    return {
      id: r.id,
      name: r.name,
      private: r.private,
      installation: r.installation,
      push: r.push,
      project: mine,
      linkedElsewhere: !!s?.project_id && !mine,
      paused: !!s?.paused,
      needsPlan: r.private && unread.get(r.installation) === true,
      branch: typeof r.branch === "string" && BRANCH_RE.test(r.branch) ? r.branch : null,
      evidence: !!did?.evidence,
      prs: did?.prs ?? 0,
      last: did?.last ?? null,
    };
  });
  // Links to this account's apps on repositories GitHub's answer does not list (no answer now, or no access any
  // more): all this page can do there is take the link away. A private one is not named: its name may have changed
  // since this account could see it.
  const listed = new Set(granted.map((r) => r.id));
  const linked: GithubAccountView["linked"] = [];
  for (const r of await reposLinkedToAccount(c.db, accountId)) {
    if (r.project_id && !listed.has(r.repo_id)) linked.push({ id: r.repo_id, name: r.private ? null : r.full_name, private: !!r.private, project: r.project_id });
  }
  return {
    who,
    plan: access.plan.name,
    slug: cfg.slug,
    canConnect: !!cfg.clientId,
    connected: grant ? { login: grant.github.login, expires: grant.expires, more: grant.more } : null,
    installations: [...insts.values()]
      .map((i) => ({ id: i.id, login: i.account_login, type: i.account_type, selection: i.selection, suspended: !!i.suspended, managed: i.owner === accountId, managedElsewhere: !!i.owner && i.owner !== accountId }))
      .sort((a, b) => a.login.localeCompare(b.login)),
    repos: repos.sort((a, b) => a.name.localeCompare(b.name)),
    linked,
    projects,
    notice: c.url.searchParams.get("connected") === "1" ? "GitHub is connected. Each repository the app is on is listed below, with what the app is doing there." : null,
    privatePlan: cfg.privateRepos === "open" || access.plan.entitlements.github_private === true,
    // just connected (also: just installed and signed in from /github/setup): the page says in short what the app does
    welcome: c.url.searchParams.get("connected") === "1",
    openRepos: cfg.privateRepos === "open",
    workflowLink: cfg.workflowLink ? { web: cfg.web } : null,
  };
}

/**
 * POST /api/account/github/repos/<id>: link a repository to one of the account's apps, unlink it, pause or resume it.
 * Everything needs GitHub's answer that the person can push to the repository, except `{ "project_id": null }` alone
 * from the account that owns the linked app.
 */
async function updateRepo(c: C, repoId: number): Promise<Response> {
  const a = await webSession(c);
  if (!a) return fail(401, "not signed in");
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c, 1024);
  if (body instanceof Response) return body;
  const grant = await grantOf(c, a.account.id);
  const r = grant?.repos.find((x) => x.id === repoId);
  // Taking the link away, and nothing else, is also for the account that owns the linked app, without GitHub's word
  // on the repository: the link posts that app's findings on its pull requests, and an account that lost its access
  // there (or whose answer from GitHub ran out) must still be able to stop that.
  if (!r?.push && body.project_id === null && typeof body.paused !== "boolean") {
    const row = await repoById(c.db, repoId);
    const own = row?.project_id ? await ownedProject(c, a.account.id, row.project_id) : null;
    if (row && own?.id && (await unlinkRepo(c.db, repoId, own.id, c.now))) return json(200, { ok: true, repo: { id: repoId, project: null, paused: !!row.paused } });
  }
  // GitHub's own answer, at most 30 minutes old, that this person can push to this repository
  if (!grant || !r) return fail(403, "connect GitHub again: this page only changes repositories GitHub just confirmed you can reach");
  if (!r.push) return fail(403, "you need write access to this repository on GitHub to change its GenClass settings");
  const inst = await installationById(c.db, r.installation);
  if (!inst) return fail(404, "the GitHub App is no longer installed there");
  const base = { repoId, installationId: r.installation, fullName: r.name, private: r.private };
  if ("project_id" in body) {
    let projectId: string | null = null;
    if (body.project_id !== null) {
      const p = typeof body.project_id === "string" ? await ownedProject(c, a.account.id, body.project_id) : null;
      if (!p?.id) return fail(404, "no such app in your account");
      projectId = p.id;
    }
    await linkRepo(c.db, { ...base, projectId, accountId: a.account.id }, c.now);
  }
  if (typeof body.paused === "boolean") await pauseRepo(c.db, { ...base, paused: body.paused }, c.now);
  const now = await repoById(c.db, repoId);
  return json(200, { ok: true, repo: { id: repoId, project: now?.project_id ?? null, paused: !!now?.paused } });
}

// --------------------------------------------------------------------------------------------- for the genclass command

/**
 * What the app is doing on one repository ("owner/name"), for the `genclass` command (src/cli.ts GET /api/cli/github).
 * GitHub is asked nothing here: the answer comes from what GitHub told this account in the last 30 minutes (grantOf)
 * and from what the app keeps for a repository that answer lists. `known: false` means there is no such answer, or
 * it was cut at MAX_GRANT_REPOS and does not list the repository: the person continues with GitHub (`connect_url`)
 * and the next call knows. So nothing is said about a repository GitHub did not just confirm the account can reach.
 */
export async function repoStatusForAccount(c: C, cfg: GithubAppConfig | null, accountId: string, name: string): Promise<Record<string, unknown>> {
  const urls = { connect_url: cfg?.clientId ? `${c.cfg.origin}/github/connect` : null, install_url: cfg ? `${c.cfg.origin}/github/install` : null };
  const unknown = { repo: name, known: false, installed: null, evidence: false, prs: 0, last: null, private: false, needs_plan: false, paused: false, ...urls };
  if (!cfg) return unknown;
  const grant = await grantOf(c, accountId);
  if (!grant) return unknown;
  const r = grant.repos.find((x) => x.name.toLowerCase() === name.toLowerCase());
  // GitHub's answer does not list it: the app is not on it (or the person cannot reach it), unless the answer was cut
  if (!r) return grant.more ? unknown : { ...unknown, known: true, installed: false };
  const [did] = await repoActivityByIds(c.db, [r.id]);
  const stored = await repoById(c.db, r.id);
  const inst = await installationById(c.db, r.installation);
  const needsPlan = r.private && (!inst || !(await repoEntitled(c.db, c.env, cfg, inst, { private: true }, c.now)).ok);
  return { repo: r.name, known: true, installed: true, evidence: !!did?.evidence, prs: did?.prs ?? 0, last: did?.last ?? null, private: r.private, needs_plan: needsPlan, paused: !!stored?.paused, ...urls };
}

// --------------------------------------------------------------------------------------------- routes

const html = (status: number, body: string, nonce: string, extra: Record<string, string> = {}): Response => new Response(body, { status, headers: securityHeaders(nonce, extra) });

export async function routeGithub(request: Request, url: URL, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  const mine = path === "/github" || path.startsWith("/github/") || path === "/account/github" || path === "/api/account/github" || path.startsWith("/api/account/github/") || path.startsWith("/api/github/");
  if (!mine) return null;
  const cfg = githubApp(env);
  const m = request.method;
  const get = m === "GET" || m === "HEAD";
  if (path === "/api/github/webhook") return webhook(request, env, opts, cfg, "app");
  if (path === "/api/github/marketplace") {
    // the listing's webhook may be set to send a form instead of JSON: the same delivery either way
    const delivery = await formDelivery(request, env, cfg);
    return delivery instanceof Response ? delivery : webhook(delivery, env, opts, cfg, "marketplace");
  }
  if (path.startsWith("/api/github/")) return fail(404, "not found");

  // without the app's secrets this server has no GitHub App: its pages are not found (the site may answer them)
  if (!cfg) return path.startsWith("/api/") ? fail(404, "not found") : null;
  if (path === "/github") {
    if (!get) return fail(405, "method not allowed");
    const nonce = randomBase62(22);
    // the one page of this worker meant to be found: what the app is, before anyone installs it
    return html(200, githubLandingPage(nonce, { slug: cfg.slug, privateRepos: cfg.privateRepos }), nonce, { "x-robots-tag": "index, follow" });
  }
  if (path === "/github/install") return get ? redirect(installUrl(cfg)) : fail(405, "method not allowed");
  if (path === "/github/setup") {
    if (!get) return fail(405, "method not allowed");
    const nonce = randomBase62(22);
    return html(200, githubSetupPage(nonce, { slug: cfg.slug, canConnect: !!cfg.clientId, workflowLink: cfg.workflowLink ? { web: cfg.web } : null, privateRepos: cfg.privateRepos }), nonce);
  }

  const c = accountContext(request, url, env, opts);
  if (!c) return path.startsWith("/api/") ? fail(503, "accounts unavailable") : null;
  const f: Fetch = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  if (path === "/github/connect") return get ? connectStart(c, cfg) : fail(405, "method not allowed");
  if (path === "/github/callback") return get ? connectCallback(c, cfg, f) : fail(405, "method not allowed");
  if (path === "/account/github" || path === "/api/account/github") {
    if (!get) return fail(405, "method not allowed");
    const a = await webSession(c);
    if (!a) return path.startsWith("/api/") ? fail(401, "not signed in") : redirect(`/login?next=${encodeURIComponent("/account/github")}`);
    const view = await accountView(c, cfg, a.account.id, a.account.email ?? (a.account.github_login ? `@${a.account.github_login}` : "Your account"));
    return path.startsWith("/api/") ? json(200, view) : page(200, (n) => accountGithubPage(n, view));
  }
  const repo = /^\/api\/account\/github\/repos\/(\d{1,15})$/.exec(path);
  if (repo) return m === "POST" ? updateRepo(c, Number(repo[1])) : fail(405, "method not allowed");
  if (path.startsWith("/api/")) return fail(404, "not found");
  return null;
}
