// The partner API: a product that builds GenClass in for its own users (a tools directory, a hosting or app-builder
// platform) makes a GenClass app for each of them from its own server, hands that user the app's key, and reads what
// the app finds. Checked before the account routes (src/collector.ts).
//
//   POST /api/partner/v1/apps                  { ref, name? }: the app for that user (201), or the one made for that ref
//                                              before (200); `ref` is the partner's own id for the user
//   GET  /api/partner/v1/apps?ref=&cursor=     the apps the API made, oldest first, 100 a page (`next_cursor`)
//   GET  /api/partner/v1/apps/<id>?range=7d    one app and its dashboard as data (what `genclass dashboard` reads)
//   GET  /api/partner/v1/apps/<id>/events      its stored events: the export's from, to, format, limit and cursor
//   POST /api/partner/v1/apps/<id>/link        a private dashboard link to hand that user; the previous one stops
//   GET|POST /api/account/partner-keys, DELETE /api/account/partner-keys/<id>    partner keys (browser session, /account)
//
// Invariants:
// - A partner is an account GenClass set accounts.partner_apps on by hand, with the agreement (README "Partner API").
//   Without it every partner route is 403 and /account shows no partner section; the keys of an account that stops
//   being a partner stop working at once, and its apps stay in the account.
// - The /api/partner/ routes take a partner key (Authorization: Bearer gcp_...) and nothing else: no cookie, no
//   terminal session, no export key. They send no CORS headers, so no page in a browser can read them: the key stays
//   on the partner's server. Keys are made, listed and revoked only by the browser session on genclass.dev; the
//   key is shown once and only its SHA-256 is stored.
// - A key reaches its own account's apps only (another account's app is 404). Nothing here deletes an app or
//   changes its key: removing an app stays on the website.
// - An app made here is an ordinary app of the partner's account: its plan is the account's (src/plans.ts), so the
//   dashboard's lock, history and analytics rules apply unchanged. partner_apps takes the place of the account's
//   abuse cap (MAX_APPS_PER_ACCOUNT) for apps made here; the per-account and global creation limits still apply.
// - Every partner route counts against the account's per-minute budget (EXPORT_LIMIT, bucket "partner"); the events
//   route also against the export's own (src/billing.ts exportFor).

import { accountContext, fail, makeLinkFor, MAX_ACCOUNT_PROJECTS_PER_MINUTE, ownedProject, readJson, type C } from "./auth.js";
import { browserRead, browserWrite, exportFor, overBudget, tooMany } from "./billing.js";
import { appView } from "./cli.js";
import type { Env, HandleOptions } from "./collector.js";
import { createProject, projectsCreatedSince, PROJECT_COLUMNS, randomBase62, sanitizeName, sha256Hex, type Project } from "./dashboard.js";
import { json } from "./http.js";
import { RUNTIME_PKG } from "./pages.js";
import { PLANS_FILE } from "./plans.js";
import { b64url } from "./webauthn.js";

const KEY_RE = /^gcp_[A-Za-z0-9_-]{43}$/;
/** A partner's id for one of its users: what its own database calls them, never shown to anyone else. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
export const MAX_PARTNER_KEYS = 10;
const PAGE = 100;
const MINUTE = 60_000;

const method = (): Response => fail(405, "method not allowed");

/** The partner behind a request: its key's account, while it is a partner. */
async function partnerAuth(c: C): Promise<{ accountId: string; apps: number } | Response> {
  const h = c.req.headers.get("authorization");
  const m = h === null ? null : /^Bearer\s+(\S+)$/i.exec(h.trim());
  if (!m || !KEY_RE.test(m[1]!)) return fail(401, "send a partner key: Authorization: Bearer gcp_...");
  const row = await c.db
    .prepare("SELECT k.id, k.account_id, k.last_used, a.partner_apps FROM partner_keys k JOIN accounts a ON a.id = k.account_id WHERE k.hash = ?")
    .bind(await sha256Hex(m[1]!))
    .first<{ id: string; account_id: string; last_used: string | null; partner_apps: number | null }>();
  if (!row) return fail(401, "this partner key is not valid (revoked, or never created)");
  const apps = Number(row.partner_apps ?? 0);
  if (!(apps > 0)) return fail(403, `this account is not a partner; write to ${PLANS_FILE.contact}`);
  if (!row.last_used || Date.parse(row.last_used) < c.now.getTime() - 10 * MINUTE) {
    await c.db.prepare("UPDATE partner_keys SET last_used = ? WHERE id = ?").bind(c.now.toISOString(), row.id).run();
  }
  if (await overBudget(c.env.EXPORT_LIMIT, "partner", row.account_id)) return tooMany();
  return { accountId: row.account_id, apps };
}

type PartnerRow = Pick<Project, "id" | "token" | "name" | "created" | "last_event" | "first_event"> & { partner_ref: string | null };

/** One app as the partner API shows it: `key` is the app's public key, the one its runtime sends. */
function appJson(c: C, p: PartnerRow): Record<string, unknown> {
  return {
    id: p.id,
    ref: p.partner_ref,
    name: p.name,
    key: p.token,
    created: p.created,
    first_event: p.first_event,
    last_event: p.last_event,
    install: `npx ${RUNTIME_PKG} init --token ${p.token}`,
    dashboard_url: `${c.cfg.origin}/account/apps/${p.id}`,
  };
}

const COLUMNS = `${PROJECT_COLUMNS}, partner_ref`;

async function byRef(c: C, accountId: string, ref: string): Promise<PartnerRow | null> {
  return c.db.prepare(`SELECT ${COLUMNS} FROM projects WHERE account_id = ? AND partner_ref = ?`).bind(accountId, ref).first<PartnerRow>();
}

async function createApp(c: C, who: { accountId: string; apps: number }): Promise<Response> {
  const body = await readJson(c, 4096);
  if (body instanceof Response) return body;
  const ref = body.ref;
  if (typeof ref !== "string" || !REF_RE.test(ref)) return fail(400, "ref is your id for the user, 1 to 64 letters, digits and . _ : @ - (starting with a letter or digit)");
  if (body.name !== undefined && typeof body.name !== "string") return fail(400, "name is text");
  const had = await byRef(c, who.accountId, ref);
  if (had) return json(200, { created: false, app: appJson(c, had) });
  const n = Number((await c.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE account_id = ?").bind(who.accountId).first<{ n: number }>())?.n ?? 0);
  if (n >= who.apps) return fail(409, `this account holds ${n} apps, its partner limit of ${who.apps}; write to ${PLANS_FILE.contact} for more`);
  if (c.env.CREATE_LIMITER) {
    const { success } = await c.env.CREATE_LIMITER.limit({ key: (await sha256Hex(`create:account:${who.accountId}`)).slice(0, 32) });
    if (!success) return fail(429, "too many apps created; try again in a minute", { "retry-after": "60" });
  }
  if ((await projectsCreatedSince(c.db, new Date(c.now.getTime() - MINUTE), "account")) >= MAX_ACCOUNT_PROJECTS_PER_MINUTE) {
    return fail(429, "too many apps created; try again in a minute", { "retry-after": "60" });
  }
  const name = sanitizeName(typeof body.name === "string" && body.name.trim() ? body.name : ref);
  try {
    await createProject(c.db, name, c.now, who.accountId, ref);
  } catch (e) {
    // two requests for one ref at once: the unique index lets one in, and the other answers with that app
    const won = await byRef(c, who.accountId, ref);
    if (won) return json(200, { created: false, app: appJson(c, won) });
    throw e;
  }
  return json(201, { created: true, app: appJson(c, (await byRef(c, who.accountId, ref))!) });
}

export const encodeCursor = (p: { created: string; id: string }): string => b64url(new TextEncoder().encode(`${p.created}|${p.id}`));
function decodeCursor(v: string | null): { created: string; id: string } | null | "bad" {
  if (v === null || v === "") return null;
  try {
    const s = atob(v.replace(/-/g, "+").replace(/_/g, "/"));
    const [created, id] = s.split("|");
    return created && id && !Number.isNaN(Date.parse(created)) ? { created, id } : "bad";
  } catch {
    return "bad";
  }
}

async function listApps(c: C, who: { accountId: string; apps: number }): Promise<Response> {
  const q = c.url.searchParams;
  const ref = q.get("ref");
  if (ref !== null && !REF_RE.test(ref)) return fail(400, "ref is your id for the user, 1 to 64 letters, digits and . _ : @ -");
  const cursor = decodeCursor(q.get("cursor"));
  if (cursor === "bad") return fail(400, "this cursor is not valid; send next_cursor from the previous page");
  const where = ["account_id = ?", "partner_ref IS NOT NULL"];
  const args: unknown[] = [who.accountId];
  if (ref !== null) {
    where.push("partner_ref = ?");
    args.push(ref);
  }
  if (cursor) {
    where.push("(created > ? OR (created = ? AND id > ?))");
    args.push(cursor.created, cursor.created, cursor.id);
  }
  const r = await c.db
    .prepare(`SELECT ${COLUMNS} FROM projects WHERE ${where.join(" AND ")} ORDER BY created, id LIMIT ${PAGE + 1}`)
    .bind(...args)
    .all<PartnerRow>();
  const rows = r.results ?? [];
  const more = rows.length > PAGE;
  const shown = rows.slice(0, PAGE);
  const used = Number((await c.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE account_id = ?").bind(who.accountId).first<{ n: number }>())?.n ?? 0);
  return json(200, {
    apps: shown.map((p) => appJson(c, p)),
    next_cursor: more ? encodeCursor(shown[shown.length - 1]! as { created: string; id: string }) : null,
    limit: { apps: who.apps, used },
  });
}

async function partnerKeys(c: C, id: string | null): Promise<Response> {
  const m = c.req.method;
  if (id === null && (m === "GET" || m === "HEAD")) {
    const a = await browserRead(c);
    if (a instanceof Response) return a;
    const r = await c.db.prepare("SELECT id, label, created, last_used FROM partner_keys WHERE account_id = ? ORDER BY created").bind(a.account.id).all();
    return json(200, { keys: r.results ?? [] });
  }
  if (id === null && m === "POST") {
    const a = await browserWrite(c, "partner keys can be created");
    if (a instanceof Response) return a;
    const body = await readJson(c, 1024);
    if (body instanceof Response) return body;
    const acct = await c.db.prepare("SELECT partner_apps FROM accounts WHERE id = ?").bind(a.account.id).first<{ partner_apps: number | null }>();
    if (!(Number(acct?.partner_apps ?? 0) > 0)) return fail(403, `partner keys are for partners; write to ${PLANS_FILE.contact}`);
    if (await overBudget(c.env.AUTH_LIMIT, "partner-key", a.account.id)) return tooMany();
    const n = await c.db.prepare("SELECT COUNT(*) AS n FROM partner_keys WHERE account_id = ?").bind(a.account.id).first<{ n: number }>();
    if (Number(n?.n ?? 0) >= MAX_PARTNER_KEYS) return fail(409, `an account can have at most ${MAX_PARTNER_KEYS} partner keys; revoke one first`);
    // eslint-disable-next-line no-control-regex
    const label = typeof body.label === "string" ? body.label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60) || null : null;
    const key = `gcp_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const keyId = randomBase62(16);
    await c.db
      .prepare("INSERT INTO partner_keys (id, hash, account_id, label, created) VALUES (?, ?, ?, ?, ?)")
      .bind(keyId, await sha256Hex(key), a.account.id, label, c.now.toISOString())
      .run();
    return json(201, { id: keyId, key, label, created: c.now.toISOString() });
  }
  if (id !== null && m === "DELETE") {
    const a = await browserWrite(c, "partner keys can be revoked");
    if (a instanceof Response) return a;
    const r = await c.db.prepare("DELETE FROM partner_keys WHERE id = ? AND account_id = ? RETURNING id").bind(id, a.account.id).first();
    return r ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : fail(404, "no such partner key");
  }
  return method();
}

/** The partner routes; null for any other path. */
export async function routePartner(request: Request, url: URL, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  const keys = /^\/api\/account\/partner-keys(?:\/([^/]+))?$/.exec(path);
  if (!keys && !path.startsWith("/api/partner/")) return null;
  const c = accountContext(request, url, env, opts);
  if (!c) return fail(503, "accounts unavailable");
  if (keys) return partnerKeys(c, keys[1] ?? null);
  const m = request.method;
  const get = m === "GET" || m === "HEAD";
  const route = /^\/api\/partner\/v1\/apps(?:\/([^/]+)(\/events|\/link)?)?$/.exec(path);
  if (!route) return fail(404, "not found");
  const [, id, sub] = route;
  if (id === undefined) {
    if (!get && m !== "POST") return method();
    const who = await partnerAuth(c);
    if (who instanceof Response) return who;
    return m === "POST" ? createApp(c, who) : listApps(c, who);
  }
  if (sub === "/link" ? m !== "POST" : !get) return method();
  const who = await partnerAuth(c);
  if (who instanceof Response) return who;
  if (sub === "/events") return exportFor(c, who.accountId, id);
  if (sub === "/link") {
    const r = await makeLinkFor(c, who.accountId, id);
    if (r.status !== 201) return r;
    return json(201, { dashboard_url: ((await r.json()) as { dashboardUrl: string }).dashboardUrl });
  }
  const p = await ownedProject(c, who.accountId, id);
  if (!p) return fail(404, "not found");
  return appView(c, p);
}
