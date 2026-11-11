// Shared by the GitHub App's tests: an app with a real RSA key, signed webhook deliveries through the real handler,
// and a fake of the parts of GitHub's REST API the app calls. The fake checks what the real one would: the app's JWT
// (signature with the public key, issuer, times), that every repository call carries an installation token minted for
// that repository, and that an artifact's storage address is fetched without any credential.
import { generateKeyPairSync, createPublicKey, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { handle, type Env } from "../src/collector.js";
import { resetGithubCaches } from "../src/github/api.js";
import { resetBaselineCache, resetSettingsCache } from "../src/github/handlers.js";
import { resetJwtCache } from "../src/github/jwt.js";
import { now, ORIGIN, setup, type Fetch } from "./account-helpers.js";
import { makeZip } from "./github-zip-helper.js";

export const APP_ID = "424242";
export const SLUG = "genclass-dev";
export const WEBHOOK_SECRET = "gh_webhook_secret_0123456789abcdef";
export const CLIENT_ID = "Iv23liTESTCLIENTID00";
export const CLIENT_SECRET = "0123456789abcdef0123456789abcdef01234567";
export const API = "https://api.github.com";
export const STORAGE = "https://artifacts.example.test";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** The app's private key as GitHub hands it out (PKCS#1 PEM), and the same key as PKCS#8. */
export const PRIVATE_KEY_PKCS1 = pair.privateKey.export({ type: "pkcs1", format: "pem" }) as string;
export const PRIVATE_KEY_PKCS8 = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PUBLIC_KEY = createPublicKey(pair.publicKey.export({ type: "spki", format: "pem" }) as string);

/** An env with the app set up (the app's tables come from the migrations, like every other table). */
export function githubSetup(over: Partial<Env> = {}) {
  resetGithubCaches();
  resetSettingsCache();
  resetBaselineCache();
  resetJwtCache();
  return setup({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PKCS1, GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET, GITHUB_APP_CLIENT_ID: CLIENT_ID, GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET, ...over });
}

export async function signature(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let deliveries = 0;
export const deliveryId = (): string => `00000000-0000-4000-8000-${String(++deliveries).padStart(12, "0")}`;

export interface DeliverOptions {
  fetch?: Fetch;
  id?: string;
  secret?: string;
  /** The exact signature header (to send a wrong one); null sends none. */
  header?: string | null;
  path?: string;
  /** ctx.waitUntil as in production: the response comes first, the returned promises hold the work. */
  waitUntil?: (p: Promise<unknown>) => void;
  /**
   * Send it as a webhook set to application/x-www-form-urlencoded does: the JSON percent-encoded in a field named
   * `payload`, the signature over those form bytes. A string is sent as the form body itself (to send a broken one).
   */
  form?: boolean | string;
}

/** Deliver a webhook as GitHub does: no Origin, no cookie, signed, with its event and delivery headers. */
export async function deliver(env: Env, event: string, payload: unknown, o: DeliverOptions = {}): Promise<Response> {
  const json = typeof payload === "string" ? payload : JSON.stringify(payload);
  const body = typeof o.form === "string" ? o.form : o.form ? new URLSearchParams({ payload: json }).toString() : json;
  const headers: Record<string, string> = { "content-type": o.form ? "application/x-www-form-urlencoded" : "application/json", "x-github-event": event, "x-github-delivery": o.id ?? deliveryId(), "user-agent": "GitHub-Hookshot/test" };
  const sig = o.header === undefined ? await signature(body, o.secret) : o.header;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  return handle(new Request(`${ORIGIN}${o.path ?? "/api/github/webhook"}`, { method: "POST", headers, body }), env, { now, fetch: o.fetch, waitUntil: o.waitUntil });
}

/**
 * A pull_request event as GitHub sends it, with the fake GitHub holding the same pull request (a review started by a
 * workflow run or a command asks GitHub for it).
 */
export async function pullRequest(
  env: Env,
  gh: { fetch: Fetch; pulls: Map<string, unknown> },
  action: string,
  number: number,
  sha: string,
  over: Record<string, unknown> = {},
  repo: { full_name: string } & Record<string, unknown> = REPO,
): Promise<Response> {
  const event = pullEvent(action, number, sha, over, repo);
  gh.pulls.set(`${repo.full_name}#${number}`, event.pull_request);
  return deliver(env, "pull_request", event, { fetch: gh.fetch });
}

/** The result word of a delivery handled inline. */
export async function result(r: Response): Promise<string> {
  return ((await r.json()) as { result?: string }).result ?? "";
}

// --------------------------------------------------------------------------------------------- payloads

export const INSTALLATION = 9001;
export const OWNER = { id: 501, login: "acme", type: "Organization" };
export const REPO = { id: 7001, name: "shop", full_name: "acme/shop", private: false, owner: OWNER, default_branch: "main" };
export const SHA1 = "1".repeat(40);
export const SHA2 = "2".repeat(40);
export const SHA3 = "3".repeat(40);

export const installationCreated = (over: Record<string, unknown> = {}) => ({
  action: "created",
  installation: { id: INSTALLATION, account: OWNER, repository_selection: "selected", app_id: Number(APP_ID), ...over },
  repositories: [{ id: REPO.id, name: REPO.name, full_name: REPO.full_name, private: false }],
  sender: { id: 77, login: "ada", type: "User" },
});

export function pull(number: number, sha: string, over: Record<string, unknown> = {}) {
  return {
    number,
    state: "open",
    draft: false,
    merged: false,
    user: { id: 77, login: "ada", type: "User" },
    author_association: "MEMBER",
    head: { sha, ref: "feature", repo: { id: REPO.id, full_name: REPO.full_name } },
    base: { ref: "main", repo: { id: REPO.id, full_name: REPO.full_name } },
    ...over,
  };
}

export const pullEvent = (action: string, number: number, sha: string, over: Record<string, unknown> = {}, repo: Record<string, unknown> = REPO) => ({
  action,
  number,
  pull_request: pull(number, sha, over),
  repository: repo,
  installation: { id: INSTALLATION },
  sender: { id: 77, login: "ada", type: "User" },
});

export const runEvent = (runId: number, sha: string, over: Record<string, unknown> = {}, repo: Record<string, unknown> = REPO) => ({
  action: "completed",
  workflow_run: { id: runId, head_sha: sha, head_branch: "feature", status: "completed", conclusion: "success", event: "pull_request", pull_requests: [], ...over },
  repository: repo,
  installation: { id: INSTALLATION },
  sender: { id: 77, login: "ada", type: "User" },
});

export const commentEvent = (number: number, body: string, over: { user?: Record<string, unknown>; association?: string; issue?: Record<string, unknown>; id?: number } = {}, repo: Record<string, unknown> = REPO) => ({
  action: "created",
  issue: { number, state: "open", user: { id: 77, login: "ada" }, pull_request: { url: `${API}/repos/acme/shop/pulls/${number}` }, ...(over.issue ?? {}) },
  comment: { id: over.id ?? 880000 + ++deliveries, body, user: over.user ?? { id: 77, login: "ada", type: "User" }, author_association: over.association ?? "MEMBER" },
  repository: repo,
  installation: { id: INSTALLATION },
  sender: over.user ?? { id: 77, login: "ada", type: "User" },
});

// --------------------------------------------------------------------------------------------- race files

const FIXTURES = new URL("../../packages/playwright/test/fixtures/races/", import.meta.url);
/** The reporter's own fixtures: checkout (a duplicate submit in 2 of 2 seeds) and search (a stale response in 1 of 2). */
export const raceFile = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");
export const RACES = ["checkout-1.json", "checkout-2.json", "search-1.json", "search-2.json"];

/** An artifact's zip with these race files (name -> JSON text). */
export function racesZip(files: Record<string, string> = Object.fromEntries(RACES.map((n) => [n, raceFile(n)]))): Uint8Array {
  return makeZip(Object.entries(files).map(([name, data]) => ({ name, data })));
}

/** A race file for one test and seed with the given signatures (same shape as the fixture writes). */
export function races(test: string, seed: number, signatures: { diagnosis: string; op: string; trigger?: string; confidence?: number; evidence?: string }[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "genclass-races/1",
    test,
    seed,
    signatures: signatures.map((s) => ({
      sig: `${s.trigger ?? "request"}|${s.diagnosis}|${s.op}`,
      trigger: s.trigger ?? "request",
      diagnosis: s.diagnosis,
      op: s.op,
      confidence: s.confidence ?? 0.95,
      evidence: s.evidence ?? `evidence for ${s.op}`,
      seeds: [seed],
    })),
    ...extra,
  });
}

// --------------------------------------------------------------------------------------------- the fake GitHub

export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  auth: string;
}

export interface FakeRun {
  id: number;
  head_sha: string;
  status?: string;
  conclusion?: string | null;
  name?: string;
  workflow_id?: number;
  created_at?: string;
  /** When it ended (GitHub's `updated_at` of a completed run). */
  updated_at?: string;
  /** The branch GitHub files the run under (a pull request's head branch, or the branch pushed to). Default "feature". */
  head_branch?: string;
  /** What started it. Default "pull_request". */
  event?: string;
  /** The repository its head commit is in (a fork's id for a pull request from a fork). Default: the repository itself. */
  head_repository_id?: number;
  /** Artifacts by name: the zip bytes. */
  artifacts?: Record<string, Uint8Array>;
  /** Names of artifacts GitHub lists as expired (their retention ran out). */
  expired?: string[];
}

function decodeJwt(token: string): { header: any; payload: any; valid: boolean } {
  const [h, p, s] = token.split(".");
  const dec = (x: string) => JSON.parse(Buffer.from(x, "base64url").toString("utf8"));
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  return { header: dec(h!), payload: dec(p!), valid: v.verify(PUBLIC_KEY, Buffer.from(s!, "base64url")) };
}

/**
 * A fake api.github.com (and the storage host artifacts redirect to). State is plain and public so a test can set it
 * up and look at it: `pulls`, `files`, `settings` (the settings file's text per repository), `runs`, `permissions`
 * (login -> permission; a login that is not set has "none"), `selections` (installation id -> "all" | "selected", what GET /app/installations/{id}
 * answers; "selected" when not set), `privates` (ids of private repositories), and what the app wrote: `checks`,
 * `comments`, `reviews`, `issues`, `reactions`.
 * `answer` runs first for every request (return a Response to take it over: a rate limit, a failure).
 */
export function fakeGithub(o: { answer?: (call: FakeCall, url: URL) => Response | undefined } = {}) {
  const calls: FakeCall[] = [];
  const storage: { url: string; headers: Record<string, string> }[] = [];
  const tokens = new Map<string, { installation: number; repos: number[] }>();
  const repos = new Map<string, number>([[REPO.full_name, REPO.id]]);
  const selections = new Map<number, string>();
  const privates = new Set<number>();
  const pulls = new Map<string, any>();
  const files = new Map<string, any[]>();
  const settings = new Map<string, string>();
  const runs = new Map<string, FakeRun[]>();
  const permissions = new Map<string, string>([["ada", "write"]]);
  const checks = new Map<number, any>();
  const comments = new Map<number, { repo: string; issue: number; body: string }>();
  const deletedComments = new Set<number>();
  const reviews: { repo: string; number: number; body: any }[] = [];
  /** Issues in the repositories. `user` (default: the app's bot) and `state` (default "open") are what GitHub lists them with. */
  const issues: { repo: string; number: number; title: string; body: string; user?: string; state?: string }[] = [];
  const reactions: { comment: number; content: string }[] = [];
  const artifactBytes = new Map<number, Uint8Array>();
  const user = { id: 77, login: "ada", installations: [] as any[], repositories: new Map<number, any[]>() };
  let nextId = 1000;
  let minted = 0;
  const ok = (j: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json", ...headers } });
  const notFound = () => ok({ message: "Not Found" }, 404);
  /** A workflow run as GitHub describes it, in a list or by itself. */
  const runJson = (full: string, r: FakeRun) => ({
    id: r.id,
    name: r.name ?? "e2e",
    head_sha: r.head_sha,
    status: r.status ?? "completed",
    conclusion: r.conclusion === undefined ? "success" : r.conclusion,
    html_url: `https://github.com/${full}/actions/runs/${r.id}`,
    workflow_id: r.workflow_id ?? 1,
    created_at: r.created_at ?? "2026-10-13T11:00:00Z",
    ...(r.updated_at ? { updated_at: r.updated_at } : {}),
    head_branch: r.head_branch ?? "feature",
    event: r.event ?? "pull_request",
    head_repository: { id: r.head_repository_id ?? repos.get(full) },
  });

  const fetch: Fetch = async (input, init = {}) => {
    const url = new URL(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const method = init.method ?? "GET";
    if (url.origin === STORAGE) {
      storage.push({ url: input, headers });
      const id = Number(url.pathname.split("/").pop());
      const bytes = artifactBytes.get(id);
      return bytes ? new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }) : new Response("gone", { status: 404 });
    }
    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(String(init.body ?? ""));
      calls.push({ method, path: url.pathname, query: url.searchParams, body: Object.fromEntries(form), auth: "" });
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET || form.get("code") !== "good-code") return ok({ error: "bad_verification_code" });
      return ok({ access_token: "ghu_usertoken", token_type: "bearer", expires_in: 28800 });
    }
    if (url.origin !== API) return new Response("unexpected host", { status: 599 });
    const path = url.pathname;
    let body: any;
    try {
      body = init.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = String(init.body);
    }
    const call: FakeCall = { method, path, query: url.searchParams, body, auth: headers.authorization ?? "" };
    calls.push(call);
    // what every request to GitHub must carry
    expect(headers["user-agent"], `user-agent on ${path}`).toBeTruthy();
    expect(headers["x-github-api-version"], `api version on ${path}`).toBe("2026-03-10");
    const custom = o.answer?.(call, url);
    if (custom) return custom;
    const bearer = /^Bearer (.+)$/.exec(call.auth)?.[1] ?? "";

    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (mint && method === "POST") {
      const jwt = decodeJwt(bearer);
      const nowS = Math.floor(now().getTime() / 1000);
      if (!jwt.valid || jwt.header.alg !== "RS256" || String(jwt.payload.iss) !== APP_ID || jwt.payload.iat > nowS || jwt.payload.exp <= nowS || jwt.payload.exp - nowS > 600) return ok({ message: "A JSON web token could not be decoded" }, 401);
      const token = `ghs_test_${++minted}_${"x".repeat(60)}`;
      const ids: number[] = body?.repository_ids ?? [];
      // GitHub refuses a token for a repository the installation does not cover
      if (ids.some((id) => ![...repos.values()].includes(id))) return ok({ message: "There is at least one repository that does not exist or is not accessible to the parent installation." }, 422);
      tokens.set(token, { installation: Number(mint[1]), repos: ids });
      // as GitHub answers a token request for named repositories: the repositories themselves
      const named = [...repos].filter(([, id]) => ids.includes(id)).map(([full_name, id]) => ({ id, name: full_name.split("/")[1], full_name, private: privates.has(id), owner: OWNER }));
      return ok({ token, expires_at: new Date(now().getTime() + 3_600_000).toISOString(), permissions: {}, repository_selection: "selected", repositories: named }, 201);
    }
    const about = /^\/app\/installations\/(\d+)$/.exec(path);
    if (about && method === "GET") {
      // asked as the app: its JWT, never an installation token
      if (!decodeJwt(bearer).valid) return ok({ message: "A JSON web token could not be decoded" }, 401);
      return ok({ id: Number(about[1]), app_id: Number(APP_ID), account: OWNER, repository_selection: selections.get(Number(about[1])) ?? "selected" });
    }

    if (path === "/user" || path.startsWith("/user/")) {
      if (bearer !== "ghu_usertoken") return ok({ message: "Bad credentials" }, 401);
      if (path === "/user") return ok({ id: user.id, login: user.login });
      if (path === "/user/installations") return ok({ total_count: user.installations.length, installations: user.installations });
      const ur = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
      if (ur) {
        const list = user.repositories.get(Number(ur[1])) ?? [];
        return ok({ total_count: list.length, repositories: list });
      }
      return notFound();
    }

    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    if (!m) return notFound();
    const full = m[1]!;
    const rest = m[2] ?? "";
    const repoId = repos.get(full);
    const tok = tokens.get(bearer);
    // an installation token works only for the repositories it was minted for
    if (!tok || !repoId || !tok.repos.includes(repoId)) return ok({ message: "Bad credentials" }, 401);

    let x: RegExpExecArray | null;
    if ((x = /^\/pulls\/(\d+)$/.exec(rest)) && method === "GET") {
      const p = pulls.get(`${full}#${x[1]}`);
      return p ? ok(p) : notFound();
    }
    if ((x = /^\/pulls\/(\d+)\/files$/.exec(rest)) && method === "GET") {
      const all = files.get(`${full}#${x[1]}`) ?? [];
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return ok(all.slice((page - 1) * per, page * per));
    }
    if ((x = /^\/pulls\/(\d+)\/reviews$/.exec(rest)) && method === "POST") {
      reviews.push({ repo: full, number: Number(x[1]), body });
      return ok({ id: ++nextId });
    }
    if (rest === "/contents/.github/genclass.yml" && method === "GET") {
      // the settings file is read from the default branch: a `ref` would let a pull request choose its own settings
      expect(url.searchParams.has("ref")).toBe(false);
      const text = settings.get(full);
      if (text === undefined) return notFound();
      return ok({ type: "file", encoding: "base64", size: text.length, content: Buffer.from(text, "utf8").toString("base64").replace(/(.{60})/g, "$1\n") });
    }
    if (rest.startsWith("/contents/")) return ok({ message: "Resource not accessible by integration" }, 403);
    if (rest === "/actions/runs" && method === "GET") {
      // as GitHub lists a repository's runs: by commit, or by the branch they are filed under and their status, the
      // most recently created first (a pull request from a fork whose branch has the same name is listed with them)
      const sha = url.searchParams.get("head_sha");
      const branch = url.searchParams.get("branch");
      const status = url.searchParams.get("status");
      const list = (runs.get(full) ?? [])
        .filter((r) => (branch === null ? r.head_sha === sha : (r.head_branch ?? "feature") === branch && (sha === null || r.head_sha === sha)))
        .filter((r) => status === null || (r.status ?? "completed") === status);
      if (branch !== null) list.sort((a, b) => (b.created_at ?? "2026-10-13T11:00:00Z").localeCompare(a.created_at ?? "2026-10-13T11:00:00Z"));
      return ok({ total_count: list.length, workflow_runs: list.map((r) => runJson(full, r)) });
    }
    if ((x = /^\/actions\/runs\/(\d+)$/.exec(rest)) && method === "GET") {
      // one run by its id, whether or not a list shows it
      const run = (runs.get(full) ?? []).find((r) => r.id === Number(x![1]));
      return run ? ok(runJson(full, run)) : notFound();
    }
    if ((x = /^\/actions\/runs\/(\d+)\/artifacts$/.exec(rest)) && method === "GET") {
      const run = (runs.get(full) ?? []).find((r) => r.id === Number(x![1]));
      if (!run) return notFound();
      const arts = Object.entries(run.artifacts ?? {}).map(([name, bytes], i) => {
        const id = run.id * 100 + i;
        artifactBytes.set(id, bytes);
        return { id, name, size_in_bytes: bytes.length, expired: run.expired?.includes(name) ?? false };
      });
      return ok({ total_count: arts.length, artifacts: arts });
    }
    if ((x = /^\/actions\/artifacts\/(\d+)\/zip$/.exec(rest)) && method === "GET") {
      return new Response(null, { status: 302, headers: { location: `${STORAGE}/a/${x[1]}` } });
    }
    if (rest === "/check-runs" && method === "POST") {
      const id = ++nextId;
      checks.set(id, { repo: full, ...body });
      return ok({ id }, 201);
    }
    if ((x = /^\/check-runs\/(\d+)$/.exec(rest)) && method === "PATCH") {
      const c = checks.get(Number(x[1]));
      if (!c) return notFound();
      const next = { ...c, ...body };
      // a check run set back to "in progress" has no conclusion any more
      if (body.status && body.status !== "completed") delete next.conclusion;
      checks.set(Number(x[1]), next);
      return ok({ id: Number(x[1]) });
    }
    if ((x = /^\/issues\/(\d+)\/comments$/.exec(rest)) && method === "POST") {
      const id = ++nextId;
      comments.set(id, { repo: full, issue: Number(x[1]), body: body.body });
      return ok({ id }, 201);
    }
    if ((x = /^\/issues\/comments\/(\d+)$/.exec(rest)) && method === "PATCH") {
      const id = Number(x[1]);
      const c = comments.get(id);
      if (!c || deletedComments.has(id)) return notFound();
      c.body = body.body;
      return ok({ id });
    }
    if ((x = /^\/issues\/comments\/(\d+)\/reactions$/.exec(rest)) && method === "POST") {
      reactions.push({ comment: Number(x[1]), content: body.content });
      return ok({ id: ++nextId }, 201);
    }
    if ((x = /^\/collaborators\/([^/]+)\/permission$/.exec(rest)) && method === "GET") {
      return ok({ permission: permissions.get(x[1]!) ?? "none", role_name: permissions.get(x[1]!) ?? "none" });
    }
    if (rest === "/issues" && method === "POST") {
      const number = 300 + issues.length + 1;
      issues.push({ repo: full, number, title: body.title, body: body.body });
      return ok({ number, id: ++nextId }, 201);
    }
    if (rest === "/issues" && method === "GET") {
      // as GitHub lists a repository's issues: newest first, open ones unless `state` says otherwise, by `creator` when given
      const want = url.searchParams.get("state") ?? "open";
      const creator = url.searchParams.get("creator");
      const all = issues
        .filter((i) => i.repo === full && (want === "all" || (i.state ?? "open") === want) && (!creator || (i.user ?? `${SLUG}[bot]`) === creator))
        .map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state ?? "open", user: { login: i.user ?? `${SLUG}[bot]`, type: i.user ? "User" : "Bot" } }))
        .reverse();
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return ok(all.slice((page - 1) * per, page * per));
    }
    return ok({ message: `fake GitHub has no ${method} ${path}` }, 404);
  };

  return {
    fetch,
    calls,
    storage,
    tokens,
    repos,
    selections,
    privates,
    pulls,
    files,
    settings,
    runs,
    permissions,
    checks,
    comments,
    deletedComments,
    reviews,
    issues,
    reactions,
    user,
    /** Calls to api.github.com made with an installation token (not the token mint itself). */
    apiCalls: () => calls.filter((c) => c.path.startsWith("/repos/")),
    /** A completed workflow run on a commit that uploaded the reporter's fixtures as the artifact `genclass-races`. */
    addRun(sha: string, artifacts: Record<string, Uint8Array> = { "genclass-races": racesZip() }, over: Partial<FakeRun> = {}, full = REPO.full_name): FakeRun {
      const run: FakeRun = { id: 5000 + (runs.get(full)?.length ?? 0) + 1, head_sha: sha, artifacts, ...over };
      runs.set(full, [...(runs.get(full) ?? []), run]);
      return run;
    },
    /**
     * A completed workflow run that a push to the default branch ("main") started, with these artifacts (default: the
     * reporter's fixtures as `genclass-races`): what a review compares a pull request's findings with.
     */
    addBaseRun(sha: string, artifacts: Record<string, Uint8Array> = { "genclass-races": racesZip() }, over: Partial<FakeRun> = {}, full = REPO.full_name): FakeRun {
      const run: FakeRun = { id: 5000 + (runs.get(full)?.length ?? 0) + 1, head_sha: sha, artifacts, head_branch: "main", event: "push", ...over };
      runs.set(full, [...(runs.get(full) ?? []), run]);
      return run;
    },
    /** The app's summary comment on a pull request, if it posted one. */
    summary(number: number, full = REPO.full_name): string | null {
      for (const [id, c] of comments) if (c.repo === full && c.issue === number && c.body.startsWith("<!-- genclass-bot:summary -->") && !deletedComments.has(id)) return c.body;
      return null;
    },
    /** Every comment the app posted on a pull request, oldest first. */
    posted(number: number, full = REPO.full_name): string[] {
      return [...comments.values()].filter((c) => c.repo === full && c.issue === number).map((c) => c.body);
    },
    /** The check runs on a commit, oldest first. */
    checksAt(sha: string): any[] {
      return [...checks.values()].filter((c) => c.head_sha === sha);
    },
  };
}
