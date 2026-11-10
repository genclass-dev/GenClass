// A small GitHub REST client for the app: authentication as the app (JWT), as an installation (a token scoped to one
// repository) or as a person (a user access token, used once while linking), with the limits a webhook handler needs.
//
// Invariants:
// - Requests go only to the configured API root (cfg.api), over https, with a 10 s timeout. The one exception is a
//   download (an artifact's zip): GitHub answers with a redirect to its storage, which is fetched WITHOUT any
//   credential, only over https on a public host name, and read up to a byte cap.
// - Installation tokens are asked for one repository at a time (`repository_ids`), so a token that leaked from one
//   review could not touch another repository of the same installation. They are cached in memory only (never in D1,
//   never logged) until 5 minutes before they expire.
// - Every response body is read up to a cap; an answer over it is an error, not a truncated parse.
// - Rate limits are honoured, never slept through: a primary or secondary limit (403 or 429 with `retry-after`, or
//   `x-ratelimit-remaining: 0`) throws GithubError("rate_limited") and marks the installation as limited until the
//   time GitHub named; calls made before then fail at once without reaching GitHub. Reads are retried once on a
//   network error or a 5xx; writes are never retried here (a retried POST could post a comment twice).
// - A client counts its calls and refuses to go past `budget` (a review that loops cannot drain the hourly limit).
// - Error messages carry the status and GitHub's own `message` field cut to 200 characters; never a token.

import { appJwt } from "./jwt.js";
import { isLoopback, type GithubAppConfig } from "./config.js";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type GithubErrorKind = "network" | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "validation" | "conflict" | "server" | "too_large" | "budget" | "unexpected";

/** A GitHub request that did not succeed. `retryAfterS`: seconds until GitHub accepts requests again, when it said. */
export class GithubError extends Error {
  constructor(
    readonly kind: GithubErrorKind,
    readonly status: number,
    message: string,
    readonly retryAfterS: number | null = null,
  ) {
    super(message);
  }
}

/**
 * The REST API version every request names (GitHub: "2026-03-10", the latest; its breaking changes over 2022-11-28,
 * `merge_commit_sha` and the singular `assignee` gone from pull requests, touch nothing this client reads).
 */
export const API_VERSION = "2026-03-10";
export const USER_AGENT = "genclass-bot (+https://genclass.dev/github)";
const TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** API calls one client may make (one review, one command). */
export const DEFAULT_BUDGET = 60;
/** An installation token is replaced this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** A secondary rate limit without a `retry-after` header keeps the installation quiet this long. */
const SECONDARY_BACKOFF_S = 60;

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** Largest response body read, in bytes (default 2 MB). */
  maxBytes?: number;
  accept?: string;
}

export interface GithubClient {
  get<T = unknown>(path: string, o?: RequestOptions): Promise<T>;
  post<T = unknown>(path: string, body: unknown, o?: RequestOptions): Promise<T>;
  patch<T = unknown>(path: string, body: unknown, o?: RequestOptions): Promise<T>;
  delete(path: string, o?: RequestOptions): Promise<void>;
  /**
   * The items of a list endpoint, page by page (100 a page), up to `max`. `key`: the field holding the array when the
   * answer is an object ({ total_count, artifacts: [...] }).
   */
  list<T = unknown>(path: string, o: RequestOptions & { max: number; key?: string }): Promise<T[]>;
  /** The bytes behind a download endpoint that redirects to storage (an artifact's zip), up to `maxBytes`. */
  download(path: string, maxBytes: number): Promise<Uint8Array>;
  /** Calls made so far. */
  calls(): number;
}

// --------------------------------------------------------------------------------------------- per-isolate state

const tokens = new Map<string, { token: string; exp: number }>();
const limitedUntil = new Map<string, number>();

/** Drops cached installation tokens and remembered rate limits (tests). */
export function resetGithubCaches(): void {
  tokens.clear();
  limitedUntil.clear();
}

/** Forget an installation's tokens (it was removed or suspended). */
export function forgetInstallation(installationId: number): void {
  for (const k of tokens.keys()) if (k.startsWith(`${installationId}:`)) tokens.delete(k);
  limitedUntil.delete(`i${installationId}`);
}

/** When GitHub last said this scope is rate limited, the time (ms) requests may resume; 0 when it is not. */
export function limitedFor(scope: string, nowMs: number): number {
  const until = limitedUntil.get(scope) ?? 0;
  if (until <= nowMs) {
    if (until) limitedUntil.delete(scope);
    return 0;
  }
  return until;
}

// --------------------------------------------------------------------------------------------- helpers

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** "/repos/<owner>/<name>" for a full name from a webhook, or null when it is not a repository name. */
export function repoPath(fullName: unknown): string | null {
  if (typeof fullName !== "string") return null;
  const [owner, name, ...rest] = fullName.split("/");
  if (rest.length || !owner || !name || !OWNER_RE.test(owner) || !REPO_RE.test(name) || name === "." || name === "..") return null;
  return `/repos/${owner}/${name}`;
}

/** A positive safe integer (ids, numbers) from untrusted JSON, else null. */
export function posInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

async function readCappedBody(res: Response, cap: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return null;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

function messageOf(body: unknown): string {
  const m = body && typeof body === "object" ? (body as Record<string, unknown>).message : null;
  // eslint-disable-next-line no-control-regex
  return typeof m === "string" ? m.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200) : "";
}

function retryAfter(res: Response, nowMs: number): number | null {
  const ra = Number(res.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return Math.min(3600, Math.ceil(ra));
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return Math.min(3600, Math.max(1, Math.ceil(reset - nowMs / 1000)));
  }
  return null;
}

/** An https URL on a public host name (a redirect target we fetch without credentials), else null. */
export function publicDownloadUrl(v: string | null): string | null {
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || !h.includes(".") || h.endsWith(".")) return null;
  if (/^[\d.]+$/.test(h) || h.startsWith("[") || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return null;
  return u.toString();
}

// --------------------------------------------------------------------------------------------- the client

interface Core {
  cfg: GithubAppConfig;
  f: Fetch;
  now: () => Date;
  /** The Authorization header value for the next request. */
  auth: () => Promise<string>;
  /** The rate-limit scope, "app" or "i<installation id>"; null for a person's token (one person's limit is not another's). */
  scope: string | null;
  budget: number;
}

const REDIRECTS = new Set([301, 302, 307, 308]);

function makeClient(core: Core): GithubClient {
  let calls = 0;
  // against a stand-in for GitHub on this machine (development only), its storage address is on this machine too
  const dev = isLoopback(new URL(core.cfg.api));
  const downloadUrl = (v: string | null): string | null => {
    if (dev && v) {
      try {
        if (isLoopback(new URL(v))) return v;
      } catch {
        return null;
      }
    }
    return publicDownloadUrl(v);
  };

  const url = (path: string, query?: RequestOptions["query"]): string => {
    if (!path.startsWith("/") || path.includes("..") || /[\s\\]/.test(path)) throw new GithubError("unexpected", 0, "refused a malformed API path");
    const u = new URL(core.cfg.api + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  };

  /**
   * One request to the API root. Redirects are never followed by fetch itself (`redirect: "manual"`): `follow` set, a
   * GET that GitHub redirects within the API root (a renamed repository) is asked once more there; any other redirect
   * is returned to the caller (download) or is an error (json).
   */
  async function send(method: string, path: string, body: unknown, o: RequestOptions, follow = true): Promise<Response> {
    const nowMs = core.now().getTime();
    const until = core.scope ? limitedFor(core.scope, nowMs) : 0;
    if (until) throw new GithubError("rate_limited", 429, "GitHub's rate limit for this installation is used up", Math.ceil((until - nowMs) / 1000));
    if (++calls > core.budget) throw new GithubError("budget", 0, `more than ${core.budget} GitHub requests for one job`);
    const headers: Record<string, string> = {
      accept: o.accept ?? "application/vnd.github+json",
      authorization: await core.auth(),
      "user-agent": USER_AGENT,
      "x-github-api-version": API_VERSION,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit = { method, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
    const target = url(path, o.query);
    const res = await once(method, target, init);
    if (!follow || method !== "GET" || !REDIRECTS.has(res.status)) return res;
    // a moved repository: the same request at the address GitHub names, only inside the API root (the token stays there)
    const loc = res.headers.get("location");
    let next: URL | null = null;
    try {
      next = loc ? new URL(loc, target) : null;
    } catch {
      next = null;
    }
    try { await res.body?.cancel(); } catch { /* ignore */ }
    const apiRoot = new URL(core.cfg.api);
    if (!next || next.origin !== apiRoot.origin || !next.pathname.startsWith(apiRoot.pathname.replace(/\/+$/, "") + "/")) {
      throw new GithubError("unexpected", res.status, "GitHub redirected outside its API");
    }
    if (++calls > core.budget) throw new GithubError("budget", 0, `more than ${core.budget} GitHub requests for one job`);
    return once(method, next.toString(), { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  async function once(method: string, target: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await core.f(target, init);
    } catch {
      if (method !== "GET") throw new GithubError("network", 0, "GitHub did not answer");
      try {
        res = await core.f(target, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        throw new GithubError("network", 0, "GitHub did not answer");
      }
    }
    if (method === "GET" && res.status >= 500 && res.status <= 599) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      try {
        res = await core.f(target, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        throw new GithubError("network", 0, "GitHub did not answer");
      }
    }
    return res;
  }

  async function fail(res: Response): Promise<never> {
    const nowMs = core.now().getTime();
    const raw = await readCappedBody(res, 64 * 1024).catch(() => null);
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(new TextDecoder().decode(raw)) : null;
    } catch {
      /* not JSON */
    }
    const msg = messageOf(parsed);
    const wait = retryAfter(res, nowMs);
    const secondary = /secondary rate limit|abuse detection/i.test(msg);
    if (res.status === 429 || (res.status === 403 && (wait !== null || secondary))) {
      const s = wait ?? SECONDARY_BACKOFF_S;
      if (core.scope) {
        if (limitedUntil.size > 2000) limitedUntil.clear();
        limitedUntil.set(core.scope, nowMs + s * 1000);
      }
      throw new GithubError("rate_limited", res.status, `GitHub rate limit: ${msg || "try again later"}`, s);
    }
    const kind: GithubErrorKind =
      res.status === 401 ? "unauthorized" : res.status === 403 ? "forbidden" : res.status === 404 || res.status === 410 ? "not_found" : res.status === 409 ? "conflict" : res.status === 422 ? "validation" : res.status >= 500 ? "server" : "unexpected";
    throw new GithubError(kind, res.status, `GitHub answered HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
  }

  async function json<T>(method: string, path: string, body: unknown, o: RequestOptions = {}): Promise<T> {
    const res = await send(method, path, body, o);
    if (res.status < 200 || res.status > 299) return fail(res);
    if (res.status === 204 || res.status === 205) return undefined as T;
    const raw = await readCappedBody(res, o.maxBytes ?? DEFAULT_MAX_BYTES);
    if (raw === null) throw new GithubError("too_large", res.status, "GitHub's answer was larger than this job reads");
    if (!raw.length) return undefined as T;
    try {
      return JSON.parse(new TextDecoder().decode(raw)) as T;
    } catch {
      throw new GithubError("unexpected", res.status, "GitHub's answer was not JSON");
    }
  }

  return {
    get: (path, o) => json("GET", path, undefined, o),
    post: (path, body, o) => json("POST", path, body, o),
    patch: (path, body, o) => json("PATCH", path, body, o),
    async delete(path, o) {
      await json("DELETE", path, undefined, o);
    },
    async list<T>(path: string, o: RequestOptions & { max: number; key?: string }): Promise<T[]> {
      const out: T[] = [];
      const per = Math.max(1, Math.min(100, o.max));
      for (let page = 1; out.length < o.max && page <= 10; page++) {
        const data = await json<unknown>("GET", path, undefined, { ...o, query: { ...o.query, per_page: per, page } });
        const items = o.key ? (data && typeof data === "object" ? (data as Record<string, unknown>)[o.key] : null) : data;
        if (!Array.isArray(items)) throw new GithubError("unexpected", 200, "GitHub's list answer was not a list");
        for (const x of items) if (out.length < o.max) out.push(x as T);
        if (items.length < per) break;
      }
      return out;
    },
    async download(path: string, maxBytes: number): Promise<Uint8Array> {
      const res = await send("GET", path, undefined, {}, false);
      let from = res;
      if (REDIRECTS.has(res.status)) {
        const loc = downloadUrl(res.headers.get("location"));
        try { await res.body?.cancel(); } catch { /* ignore */ }
        if (!loc) throw new GithubError("unexpected", res.status, "GitHub's download redirect was not an https address");
        try {
          // no credential goes to the storage host: the address itself is the short-lived permission
          from = await core.f(loc, { method: "GET", headers: { "user-agent": USER_AGENT }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch {
          throw new GithubError("network", 0, "the download did not answer");
        }
      }
      if (from.status !== 200) return from === res ? fail(res) : Promise.reject(new GithubError(from.status === 404 || from.status === 410 ? "not_found" : "unexpected", from.status, `the download answered HTTP ${from.status}`));
      const raw = await readCappedBody(from, maxBytes);
      if (raw === null) throw new GithubError("too_large", 200, `the download is larger than ${maxBytes} bytes`);
      return raw;
    },
    calls: () => calls,
  };
}

/** A client that acts as the app itself (installations, access tokens, the Marketplace API). */
export function appClient(cfg: GithubAppConfig, f: Fetch, now: () => Date, budget = DEFAULT_BUDGET): GithubClient {
  return makeClient({ cfg, f, now, scope: "app", budget, auth: async () => `Bearer ${await appJwt(cfg, now())}` });
}

/**
 * A client that acts as one installation on one repository. The token is asked for that repository only and cached
 * until shortly before it expires.
 */
export function installationClient(cfg: GithubAppConfig, f: Fetch, now: () => Date, installationId: number, repoId: number, budget = DEFAULT_BUDGET): GithubClient {
  const key = `${installationId}:${repoId}`;
  const auth = async (): Promise<string> => {
    const nowMs = now().getTime();
    const hit = tokens.get(key);
    if (hit && hit.exp - TOKEN_MARGIN_MS > nowMs) return `Bearer ${hit.token}`;
    const app = appClient(cfg, f, now, 4);
    const t = await app.post<{ token?: unknown; expires_at?: unknown }>(`/app/installations/${installationId}/access_tokens`, { repository_ids: [repoId] });
    const exp = typeof t?.expires_at === "string" ? Date.parse(t.expires_at) : NaN;
    if (typeof t?.token !== "string" || !t.token || !Number.isFinite(exp)) throw new GithubError("unexpected", 200, "GitHub did not return an installation token");
    if (tokens.size > 2000) tokens.clear();
    tokens.set(key, { token: t.token, exp });
    return `Bearer ${t.token}`;
  };
  return makeClient({ cfg, f, now, scope: `i${installationId}`, budget, auth });
}

/** A client that acts as a person with a user access token (used during linking, then dropped). */
export function userClient(cfg: GithubAppConfig, f: Fetch, now: () => Date, token: string, budget = 12): GithubClient {
  return makeClient({ cfg, f, now, scope: null, budget, auth: async () => `Bearer ${token}` });
}
