// `--comment` (src/comment.ts through the command): the job summary and the one GenClass comment on the pull request,
// against a fake GitHub API, a mocked fetch that keeps one pull request's comments in memory and records every
// request. No network: the global fetch is replaced by one that fails, and every run passes its own env and fetch
// (one test sets both through the defaults, process.env and the global fetch, to fakes). Every run also checks that
// nothing it printed contains the token.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { COMMENT_MAX_CHARS, commentReport, runCommentStep, JOB_SUMMARY_MAX_BYTES } from "../src/comment.js";
import { buildSummary, renderMarkdown, renderNothingFlagged, REPORT_MARKER } from "../src/summarize.js";
import { FIXTURE_REPORT, fixtureInputs, racesDir, Z } from "./helpers.js";

const TOKEN = "ghs_fakeTOKENfor0nlyTheseTests9a8b7c6d5e4f";
const REPO = "acme/shop";
const PR = 12;
const API = "https://api.github.com";
const LIST = `${API}/repos/${REPO}/issues/${PR}/comments`;
const EDIT = `${API}/repos/${REPO}/issues/comments`;
/** The one line a quiet run (one file, nothing flagged) edits an existing GenClass comment to. */
const QUIET = `${REPORT_MARKER}\n**GenClass race report**: nothing flagged in this run (1 test, 1 file read).\n`;

interface Comment {
  id: number;
  body: string;
  user: { login: string; type: string };
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  payload?: Record<string, unknown>;
  redirect?: string;
  signal?: unknown;
}

const person = (id: number, body: string): Comment => ({ id, body, user: { login: "jane", type: "User" } });
const bot = (id: number, body: string, login = "github-actions[bot]"): Comment => ({ id, body, user: { login, type: "Bot" } });

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/**
 * A fake GitHub API for pull request 12 of acme/shop: lists its comments (per_page, page), creates comments (as
 * `author`), edits them, and records every request. `answer` can answer a request first (an error, say).
 */
function fakeGitHub(comments: Comment[] = [], o: { answer?: (c: Call) => Response | undefined; author?: Comment["user"] } = {}) {
  const calls: Call[] = [];
  let next = 9000;
  const fetch = vi.fn(async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const call: Call = {
      method: init.method ?? "GET",
      url: String(input),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      payload: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      redirect: init.redirect,
      signal: init.signal,
    };
    calls.push(call);
    const forced = o.answer?.(call);
    if (forced) return forced;
    const u = new URL(call.url);
    const list = /^\/(?:api\/v3\/)?repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(u.pathname);
    const one = /^\/(?:api\/v3\/)?repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(u.pathname);
    if (list && call.method === "GET") {
      const page = Number(u.searchParams.get("page") ?? "1");
      const per = Number(u.searchParams.get("per_page") ?? "30");
      return json(200, comments.slice((page - 1) * per, page * per));
    }
    if (list && call.method === "POST") {
      const c: Comment = { id: next++, body: String(call.payload?.body), user: o.author ?? { login: "github-actions[bot]", type: "Bot" } };
      comments.push(c);
      return json(201, c);
    }
    if (one && call.method === "PATCH") {
      const c = comments.find((x) => x.id === Number(one[1]));
      if (!c) return json(404, { message: "Not Found" });
      c.body = String(call.payload?.body);
      return json(200, c);
    }
    return json(404, { message: "Not Found" });
  });
  return { fetch, calls, comments, requests: () => calls.map((c) => `${c.method} ${c.url}`) };
}

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-comment-"));
  vi.stubGlobal("fetch", () => {
    throw new Error("these tests use no network");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** test-results/genclass with the fixture's four files: two signatures, the report is FIXTURE_REPORT. */
function flaggedRun(): void {
  cpSync(racesDir, join(root, "test-results", "genclass"), { recursive: true });
}

/** test-results/genclass with one file that flagged nothing. */
function quietRun(): void {
  mkdirSync(join(root, "test-results", "genclass"), { recursive: true });
  cpSync(join(racesDir, "search-1.json"), join(root, "test-results", "genclass", "search-1.json"));
}

let events = 0;

/**
 * A new event file of a pull_request run (the fields the command reads, and the top-level number it does not), with
 * `pr` over the pull request's fields. Each call writes its own file.
 */
function event(pr: Record<string, unknown> = {}): string {
  const path = join(root, `event-${++events}.json`);
  writeFileSync(path, JSON.stringify({ action: "synchronize", number: PR, pull_request: { number: PR, head: { repo: { full_name: REPO } }, base: { repo: { full_name: REPO } }, ...pr } }));
  return path;
}

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event(), GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: TOKEN, GITHUB_STEP_SUMMARY: join(root, "summary.md"), ...over };
}

/** Runs the command; returns its exit code, stdout, stderr and the lines --comment printed. Nothing printed holds the token. */
async function run(argv: string[], e: Record<string, string | undefined>, fetch?: unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { cwd: root, out: (s) => void out.push(s), err: (s) => void err.push(s), env: e, fetch: fetch as typeof globalThis.fetch | undefined });
  const printed = out.join("") + err.join("");
  expect(printed).not.toContain(TOKEN);
  const lines = err.join("").split("\n").filter((l) => l.startsWith("genclass-playwright-report: ")).map((l) => l.slice("genclass-playwright-report: ".length));
  return { code, out: out.join(""), err: err.join(""), lines };
}

describe("comment: one GenClass comment on the pull request, only when the report flags something", () => {
  it("creates it when the report flags something and the pull request has no GenClass comment", async () => {
    flaggedRun();
    const gh = fakeGitHub([person(1, "LGTM")]);
    const r = await run(["--comment", "--quiet"], env(), gh.fetch);
    expect(r.code).toBe(0);
    expect(gh.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`, `POST ${LIST}`]);
    const post = gh.calls[1];
    // the summariser's report and nothing else
    expect(post.payload).toEqual({ body: FIXTURE_REPORT });
    expect(post.headers).toEqual({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "user-agent": "genclass-playwright-report",
      "x-github-api-version": "2022-11-28",
    });
    for (const c of gh.calls) {
      expect(c.redirect).toBe("error");
      expect(c.signal).toBeInstanceOf(AbortSignal);
      expect(c.url).not.toContain(TOKEN);
    }
    expect(gh.comments).toEqual([person(1, "LGTM"), bot(9000, FIXTURE_REPORT)]);
    expect(r.lines).toEqual(["added the report to the job summary", "posted the report on pull request 12"]);
    // the report file, the job summary and the comment are the same report
    expect(readFileSync(join(root, "genclass-report.md"), "utf8")).toBe(FIXTURE_REPORT);
    expect(readFileSync(join(root, "summary.md"), "utf8")).toBe(FIXTURE_REPORT);
  });

  it("edits the bot account's GenClass comment in place, and leaves it alone when it already shows the report", async () => {
    flaggedRun();
    const old = `${REPORT_MARKER}\n## GenClass race report\n\nan earlier run's report\n`;
    const gh = fakeGitHub([person(1, "LGTM"), bot(2, old), person(3, "thanks")]);
    const r = await run(["--comment", "--quiet"], env(), gh.fetch);
    expect(r.code).toBe(0);
    expect(gh.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`, `PATCH ${EDIT}/2`]);
    expect(gh.calls[1].payload).toEqual({ body: FIXTURE_REPORT });
    expect(gh.comments.map((c) => c.body)).toEqual(["LGTM", FIXTURE_REPORT, "thanks"]);
    expect(r.lines).toContain("updated the GenClass comment on pull request 12");

    const again = fakeGitHub(gh.comments);
    const r2 = await run(["--comment", "--quiet"], env(), again.fetch);
    expect(r2.code).toBe(0);
    expect(again.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`]);
    expect(r2.lines).toContain("the GenClass comment on pull request 12 already says this; not edited");
  });

  it("a GitHub App's bot account counts as well (a step given an app token); the first GenClass comment is the one edited", async () => {
    flaggedRun();
    const gh = fakeGitHub([bot(4, `${REPORT_MARKER}\nold`, "acme-ci[bot]"), bot(5, `${REPORT_MARKER}\nolder copy`)]);
    expect((await run(["--comment", "--quiet"], env(), gh.fetch)).code).toBe(0);
    expect(gh.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`, `PATCH ${EDIT}/4`]);
    expect(gh.comments[1].body).toBe(`${REPORT_MARKER}\nolder copy`);
  });

  it("never edits a person's comment, even one that starts with the marker, nor a bot's that does not start with it", async () => {
    flaggedRun();
    const forged = person(1, `${REPORT_MARKER}\n## GenClass race report\n\n**Nothing flagged** in 9 tests`);
    const quoting = bot(2, `Deploy preview ready. ${REPORT_MARKER}`);
    const gh = fakeGitHub([forged, quoting]);
    expect((await run(["--comment", "--quiet"], env(), gh.fetch)).code).toBe(0);
    expect(gh.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`, `POST ${LIST}`]);
    expect(gh.comments.slice(0, 2)).toEqual([person(1, forged.body), bot(2, quoting.body)]);

    // nothing flagged: the person's comment is not "the GenClass comment" either, so nothing is written
    rmSync(join(root, "test-results"), { recursive: true });
    quietRun();
    const quiet = fakeGitHub([person(1, forged.body)]);
    expect((await run(["--comment", "--quiet"], env(), quiet.fetch)).code).toBe(0);
    expect(quiet.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`]);
    expect(quiet.comments).toEqual([person(1, forged.body)]);
  });

  it("posts nothing when nothing is flagged and there is no GenClass comment; the job summary still gets the report", async () => {
    quietRun();
    const gh = fakeGitHub([person(1, "LGTM")]);
    const r = await run(["--comment", "--quiet"], env(), gh.fetch);
    expect(r.code).toBe(0);
    expect(gh.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`]);
    expect(r.lines).toEqual(["added the report to the job summary", "nothing flagged, so no comment on pull request 12"]);
    expect(readFileSync(join(root, "summary.md"), "utf8")).toBe(readFileSync(join(root, "genclass-report.md"), "utf8"));
    expect(readFileSync(join(root, "summary.md"), "utf8")).toContain("**Nothing flagged** in 1 test");
  });

  it("shortens an existing GenClass comment to one line when a later run flags nothing", async () => {
    quietRun();
    const gh = fakeGitHub([bot(5, FIXTURE_REPORT)]);
    const r = await run(["--comment", "--quiet"], env(), gh.fetch);
    expect(r.code).toBe(0);
    expect(gh.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`, `PATCH ${EDIT}/5`]);
    expect(gh.calls[1].payload).toEqual({ body: QUIET });
    // the marker, so the next run finds it, and one line a reader sees
    expect(QUIET.split("\n").filter((l) => l !== "" && l !== REPORT_MARKER)).toHaveLength(1);
    expect(r.lines).toContain("nothing flagged in this run: the GenClass comment on pull request 12 now says so in one line");

    const again = fakeGitHub(gh.comments);
    expect((await run(["--comment", "--quiet"], env(), again.fetch)).code).toBe(0);
    expect(again.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`]);

    // and back to the report when a run flags something again
    rmSync(join(root, "test-results"), { recursive: true });
    flaggedRun();
    const back = fakeGitHub(gh.comments);
    expect((await run(["--comment", "--quiet"], env(), back.fetch)).code).toBe(0);
    expect(back.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`, `PATCH ${EDIT}/5`]);
    expect(back.comments[0].body).toBe(FIXTURE_REPORT);
  });

  it("reads every page of comments: the GenClass comment on page 2 is found, and a full last page is followed by one more request", async () => {
    flaggedRun();
    const many = Array.from({ length: 100 }, (_, i) => person(i + 1, `comment ${i + 1}`));
    const gh = fakeGitHub([...many, bot(101, `${REPORT_MARKER}\nold`)]);
    expect((await run(["--comment", "--quiet"], env(), gh.fetch)).code).toBe(0);
    expect(gh.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`, `GET ${LIST}?per_page=100&page=2`, `PATCH ${EDIT}/101`]);

    const full = fakeGitHub(Array.from({ length: 100 }, (_, i) => person(i + 1, "x")));
    expect((await run(["--comment", "--quiet"], env(), full.fetch)).code).toBe(0);
    expect(full.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`, `GET ${LIST}?per_page=100&page=2`, `POST ${LIST}`]);

    const lots = fakeGitHub(Array.from({ length: 250 }, (_, i) => person(i + 1, "x")));
    expect((await run(["--comment", "--quiet"], env(), lots.fetch)).code).toBe(0);
    expect(lots.requests()).toEqual([1, 2, 3].map((p) => `GET ${LIST}?per_page=100&page=${p}`).concat(`POST ${LIST}`));
  });

  it("with a personal token the new comment is a person's, which no run edits: the line says each run will add one", async () => {
    flaggedRun();
    const gh = fakeGitHub([], { author: { login: "jane", type: "User" } });
    const r = await run(["--comment", "--quiet"], env(), gh.fetch);
    expect(r.code).toBe(0);
    expect(r.lines[1]).toMatch(/^posted the report on pull request 12\. It was written as jane, not a bot account, .* so each run will add one: /);
  });
});

describe("comment: when it does not comment (one line, no request)", () => {
  it("a pull request from a fork; the job summary still gets the report", async () => {
    flaggedRun();
    for (const head of [{ repo: { full_name: "alice/shop" } }, { repo: null }]) {
      const gh = fakeGitHub();
      const r = await run(["--comment", "--quiet"], env({ GITHUB_EVENT_PATH: event({ head }) }), gh.fetch);
      expect(r.code).toBe(0);
      expect(gh.calls).toEqual([]);
      expect(r.lines).toEqual([
        "added the report to the job summary",
        `no pull-request comment: pull request 12 comes from a fork (${head.repo ? "alice/shop" : "a repository that is gone"}), where the workflow's token cannot write`,
      ]);
    }
    expect(readFileSync(join(root, "summary.md"), "utf8")).toBe(FIXTURE_REPORT + FIXTURE_REPORT);
  });

  it("no GITHUB_TOKEN, or one with spaces or control characters (which is never sent)", async () => {
    flaggedRun();
    for (const token of [undefined, "", "  \n"]) {
      const gh = fakeGitHub();
      const r = await run(["--comment", "--quiet"], env({ GITHUB_TOKEN: token }), gh.fetch);
      expect(r.code).toBe(0);
      expect(gh.calls).toEqual([]);
      expect(r.lines[1]).toBe("no pull-request comment: GITHUB_TOKEN is not set (the step needs env GITHUB_TOKEN: ${{ github.token }} and the job permissions pull-requests: write)");
    }
    for (const token of ["ghs_abc def", "ghs_abc\ndef", "ghs_abc\u0000def"]) {
      const gh = fakeGitHub();
      const r = await run(["--comment", "--quiet"], env({ GITHUB_TOKEN: token }), gh.fetch);
      expect(gh.calls).toEqual([]);
      expect(r.lines[1]).toBe("no pull-request comment: GITHUB_TOKEN holds spaces or control characters, so it is not sent");
      expect(r.err).not.toContain("ghs_abc");
    }
  });

  it("only pull_request runs, on the pull request number in the event file", async () => {
    flaggedRun();
    for (const [name, line] of [
      ["push", 'no pull-request comment: this run\'s event is "push", not "pull_request"'],
      ["schedule", 'no pull-request comment: this run\'s event is "schedule", not "pull_request"'],
      ["pull_request_target", 'no pull-request comment: this run\'s event is "pull_request_target", not "pull_request"'],
      [undefined, "no pull-request comment: this is not a GitHub Actions pull_request run (GITHUB_EVENT_NAME is not set)"],
    ] as const) {
      const gh = fakeGitHub();
      const r = await run(["--comment", "--quiet"], env({ GITHUB_EVENT_NAME: name }), gh.fetch);
      expect(r.code).toBe(0);
      expect(gh.calls).toEqual([]);
      expect(r.lines[1]).toBe(line);
    }
    const missing = fakeGitHub();
    expect((await run(["--comment", "--quiet"], env({ GITHUB_EVENT_PATH: undefined }), missing.fetch)).lines[1]).toBe("no pull-request comment: GITHUB_EVENT_PATH is not set, so the pull request is not known");
    expect((await run(["--comment", "--quiet"], env({ GITHUB_EVENT_PATH: join(root, "nope.json") }), missing.fetch)).lines[1]).toMatch(/^warning: no pull-request comment: the event file could not be read \(ENOENT/);
    writeFileSync(join(root, "push.json"), JSON.stringify({ ref: "refs/heads/main", number: 7 }));
    for (const path of [join(root, "push.json"), event({ number: "12" }), event({ number: 0 }), event({ number: -1 }), event({ number: 1.5 }), event({ number: "../../x" })]) {
      expect((await run(["--comment", "--quiet"], env({ GITHUB_EVENT_PATH: path }), missing.fetch)).lines[1]).toBe("warning: no pull-request comment: the event file names no pull request");
    }
    expect(missing.calls).toEqual([]);

    // the number is the event file's, whatever else the environment says
    const gh = fakeGitHub();
    await run(["--comment", "--quiet"], env({ GITHUB_REF: "refs/pull/99/merge", GITHUB_EVENT_PATH: event({ number: 34 }) }), gh.fetch);
    expect(gh.requests()).toEqual([`GET ${API}/repos/${REPO}/issues/34/comments?per_page=100&page=1`, `POST ${API}/repos/${REPO}/issues/34/comments`]);
  });

  it("GITHUB_REPOSITORY must be owner/name and the pull request's own repository", async () => {
    flaggedRun();
    const gh = fakeGitHub();
    for (const repo of [undefined, "acme", "acme/shop/x", "acme/..", "../shop", "acme/sh op", "acme/shop?x=1", "acme/shop#1"]) {
      const r = await run(["--comment", "--quiet"], env({ GITHUB_REPOSITORY: repo }), gh.fetch);
      expect(r.lines[1]).toBe("no pull-request comment: GITHUB_REPOSITORY is not owner/name");
    }
    const other = await run(["--comment", "--quiet"], env({ GITHUB_REPOSITORY: "acme/other" }), gh.fetch);
    expect(other.lines[1]).toBe("no pull-request comment: the event's pull request 12 is not in acme/other");
    expect(gh.calls).toEqual([]);
    // GitHub's names are not case-sensitive
    const cased = fakeGitHub();
    await run(["--comment", "--quiet"], env({ GITHUB_REPOSITORY: "Acme/Shop" }), cased.fetch);
    expect(cased.requests()).toEqual([`GET ${API}/repos/Acme/Shop/issues/12/comments?per_page=100&page=1`, `POST ${API}/repos/Acme/Shop/issues/12/comments`]);
  });

  it("GITHUB_API_URL: GitHub Enterprise Server's API is used; anything but a plain https URL is refused", async () => {
    flaggedRun();
    const ghe = fakeGitHub();
    await run(["--comment", "--quiet"], env({ GITHUB_API_URL: "https://ghe.example.com/api/v3/" }), ghe.fetch);
    expect(ghe.requests()).toEqual([`GET https://ghe.example.com/api/v3/repos/${REPO}/issues/12/comments?per_page=100&page=1`, `POST https://ghe.example.com/api/v3/repos/${REPO}/issues/12/comments`]);
    const gh = fakeGitHub();
    for (const url of ["http://ghe.example.com/api/v3", "https://user:secret@ghe.example.com/api/v3", "https://ghe.example.com/api/v3?x=1", "https://ghe.example.com/#x", "ftp://ghe.example.com", "not a url"]) {
      const r = await run(["--comment", "--quiet"], env({ GITHUB_API_URL: url }), gh.fetch);
      expect(r.code).toBe(0);
      expect(r.lines[1]).toBe("no pull-request comment: GITHUB_API_URL is not an https URL, so the token is not sent to it");
      expect(r.err).not.toContain("secret");
    }
    expect(gh.calls).toEqual([]);
  });

  it("outside GitHub Actions (no GITHUB_* at all): one line, no job summary, exit 0", async () => {
    flaggedRun();
    const gh = fakeGitHub();
    const r = await run(["--comment", "--quiet"], {}, gh.fetch);
    expect(r.code).toBe(0);
    expect(gh.calls).toEqual([]);
    expect(r.lines).toEqual(["no pull-request comment: this is not a GitHub Actions pull_request run (GITHUB_EVENT_NAME is not set)"]);
  });
});

describe("comment: an API or network error is one warning line, and the exit code stays 0", () => {
  it("a 500, a 403, a 401, a network error, a timeout, a redirect, an answer that is not JSON or not a list", async () => {
    flaggedRun();
    const cases: [string, (c: Call) => Response | undefined | never, string][] = [
      ["500 on the list", (c) => (c.method === "GET" ? json(500, { message: "Server Error" }) : undefined), `warning: GitHub answered 500 to GET ${LIST}?per_page=100&page=1 (Server Error); the job is not failed for it`],
      [
        "403 on the post",
        (c) => (c.method === "POST" ? json(403, { message: "Resource not accessible by integration" }) : undefined),
        `warning: GitHub answered 403 to POST ${LIST} (Resource not accessible by integration); does the job have permissions: pull-requests: write?; the job is not failed for it`,
      ],
      ["401", () => json(401, { message: "Bad credentials" }), `warning: GitHub answered 401 to GET ${LIST}?per_page=100&page=1 (Bad credentials); the token was refused; the job is not failed for it`],
      ["an HTML error page", () => new Response("<html>bad gateway</html>", { status: 502 }), `warning: GitHub answered 502 to GET ${LIST}?per_page=100&page=1; the job is not failed for it`],
      ["not JSON", () => new Response("<html>hi</html>", { status: 200 }), `warning: GitHub's answer to GET ${LIST}?per_page=100&page=1 is not JSON; the job is not failed for it`],
      ["not a list", () => json(200, { comments: [] }), `warning: GitHub's answer to GET ${LIST} is not a list; the job is not failed for it`],
    ];
    for (const [what, answer, line] of cases) {
      const gh = fakeGitHub([], { answer });
      const r = await run(["--comment", "--quiet"], env(), gh.fetch);
      expect(r.code, what).toBe(0);
      expect(r.lines.slice(1), what).toEqual([line]);
    }
    const rejects: [unknown, string][] = [
      [Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }), "fetch failed: ECONNREFUSED"],
      [new DOMException("The operation was aborted due to timeout", "TimeoutError"), "The operation was aborted due to timeout"],
      [Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") }), "fetch failed: unexpected redirect"],
      ["a string", "a string"],
    ];
    for (const [e, why] of rejects) {
      const fetch = vi.fn(async () => {
        throw e;
      });
      const r = await run(["--comment", "--quiet"], env(), fetch);
      expect(r.code).toBe(0);
      expect(r.lines.slice(1)).toEqual([`warning: GET ${LIST}?per_page=100&page=1 failed (${why}); the job is not failed for it`]);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    // a fetch that throws before it returns a promise
    const sync = await run(["--comment", "--quiet"], env(), () => {
      throw new Error("boom");
    });
    expect(sync.code).toBe(0);
    expect(sync.lines.slice(1)).toEqual([`warning: GET ${LIST}?per_page=100&page=1 failed (boom); the job is not failed for it`]);
  });

  it("an unwritable job summary is a warning too, and the comment still goes ahead", async () => {
    flaggedRun();
    const gh = fakeGitHub();
    const r = await run(["--comment", "--quiet"], env({ GITHUB_STEP_SUMMARY: join(root, "no-such-dir", "summary.md") }), gh.fetch);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/^warning: could not add the report to the job summary \(ENOENT.*\); the job is not failed for it$/);
    expect(r.lines[1]).toBe("posted the report on pull request 12");
  });

  it("never prints the token, even when GitHub's answer repeats it", async () => {
    flaggedRun();
    const gh = fakeGitHub([], { answer: () => json(401, { message: `Bad credentials: ${TOKEN}` }) });
    const r = await run(["--comment", "--quiet"], env(), gh.fetch);
    expect(r.lines[1]).toBe(`warning: GitHub answered 401 to GET ${LIST}?per_page=100&page=1 (Bad credentials: ***); the token was refused; the job is not failed for it`);
    const thrown = await run(["--comment", "--quiet"], env(), async () => {
      throw new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`);
    });
    expect(thrown.lines[1]).toBe(`warning: GET ${LIST}?per_page=100&page=1 failed (Headers.append: "Bearer ***" is an invalid header value.); the job is not failed for it`);
    // a token given with a trailing newline is sent trimmed, and printed nowhere
    const trimmed = fakeGitHub();
    await run(["--comment", "--quiet"], env({ GITHUB_TOKEN: `${TOKEN}\n` }), trimmed.fetch);
    expect(trimmed.calls.map((c) => c.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });
});

describe("comment: what is sent fits in one GitHub comment", () => {
  /** One race file with 200 signatures and long evidence lines (a report well over 60000 characters). */
  function bigRun(): void {
    const dir = join(root, "test-results", "genclass");
    mkdirSync(dir, { recursive: true });
    const signatures = Array.from({ length: 200 }, (_, i) => ({
      sig: `request|duplicate|POST /api/r${i}`,
      trigger: "request",
      diagnosis: "duplicate",
      op: `POST /api/r${i}`,
      confidence: 0.9,
      evidence: `request ${i}: ${"word ".repeat(70).trim()}`,
      seeds: [1],
    }));
    writeFileSync(join(dir, "big.json"), JSON.stringify({ schema: "genclass-races/1", test: "big", seed: 1, signatures, shadow: null }));
  }

  it("--max-chars 0 or over 65536: the file and the job summary get it, the comment the report cut to 60000", async () => {
    bigRun();
    for (const max of ["0", "300000"]) {
      rmSync(join(root, "summary.md"), { force: true });
      const gh = fakeGitHub();
      expect((await run(["--comment", "--quiet", "--max-chars", max], env(), gh.fetch)).code).toBe(0);
      const file = readFileSync(join(root, "genclass-report.md"), "utf8");
      expect(file.length).toBeGreaterThan(65536);
      expect(readFileSync(join(root, "summary.md"), "utf8")).toBe(file);
      const body = String(gh.calls[1].payload?.body);
      expect(body.length).toBeLessThanOrEqual(60000);
      expect(body).toContain("_Shortened to fit 60000 characters: ");
      expect(body.startsWith(REPORT_MARKER)).toBe(true);
    }
  });

  it("--max-chars up to 65536: the comment is the report as written", async () => {
    bigRun();
    for (const max of ["3000", "65536"]) {
      const gh = fakeGitHub();
      expect((await run(["--comment", "--quiet", "--max-chars", max], env(), gh.fetch)).code).toBe(0);
      const file = readFileSync(join(root, "genclass-report.md"), "utf8");
      expect(file.length).toBeLessThanOrEqual(Number(max));
      expect(gh.calls[1].payload).toEqual({ body: file });
    }
  });

  it("a body over 65,536 characters is never sent", async () => {
    const gh = fakeGitHub();
    const lines: string[] = [];
    const r = await commentReport({ report: `${REPORT_MARKER}\n${"x".repeat(COMMENT_MAX_CHARS)}`, nothingFlagged: null, env: env(), fetch: gh.fetch, log: (l) => void lines.push(l) });
    expect(r).toBe("failed");
    expect(gh.calls).toEqual([]);
    expect(lines).toEqual([`warning: no pull-request comment: the report has ${COMMENT_MAX_CHARS + REPORT_MARKER.length + 1} characters, more than GitHub takes in a comment (65536); the job is not failed for it`]);
  });

  it("a report over the job summary's 1 MiB goes there as the comment's report instead", async () => {
    const summary = buildSummary(fixtureInputs(), { sources: ["test-results/genclass"] });
    const gh = fakeGitHub();
    const lines: string[] = [];
    const huge = "x".repeat(JOB_SUMMARY_MAX_BYTES + 1);
    const r = await runCommentStep({ markdown: huge, summary, options: { sources: ["test-results/genclass"], maxChars: 0 }, env: env(), fetch: gh.fetch, log: (l) => void lines.push(l) });
    expect(r).toBe("created");
    expect(readFileSync(join(root, "summary.md"), "utf8")).toBe(FIXTURE_REPORT);
    expect(gh.calls[1].payload).toEqual({ body: renderMarkdown(summary, { sources: ["test-results/genclass"], maxChars: 60000 }) });
  });
});

describe("comment: --dry-run prints the requests instead of making them", () => {
  it("the same checks, then GET, PATCH and POST printed; no request, no job summary", async () => {
    flaggedRun();
    const gh = fakeGitHub();
    const r = await run(["--comment", "--dry-run", "--quiet"], env(), gh.fetch);
    expect(r.code).toBe(0);
    expect(gh.calls).toEqual([]);
    expect(existsSync(join(root, "summary.md"))).toBe(false);
    expect(r.lines).toEqual([
      `dry run: the report (${FIXTURE_REPORT.length} characters) would be added to the job summary`,
      `dry run, no request is made: GET ${LIST}?per_page=100&page=1 (and the next pages while they are full) to find the first comment by a bot account that starts with ${REPORT_MARKER}`,
      `dry run: with one, PATCH ${EDIT}/<its id> with the report (${FIXTURE_REPORT.length} characters)`,
      `dry run: without one, POST ${LIST} with the report (${FIXTURE_REPORT.length} characters)`,
    ]);
    // the report file is written as without --dry-run
    expect(readFileSync(join(root, "genclass-report.md"), "utf8")).toBe(FIXTURE_REPORT);
  });

  it("nothing flagged: the one line it would edit a GenClass comment to, and no request without one", async () => {
    quietRun();
    const r = await run(["--comment", "--dry-run", "--quiet"], env({ GITHUB_STEP_SUMMARY: undefined }), fakeGitHub().fetch);
    expect(r.lines).toEqual([
      `dry run, no request is made: GET ${LIST}?per_page=100&page=1 (and the next pages while they are full) to find the first comment by a bot account that starts with ${REPORT_MARKER}`,
      `dry run: with one, PATCH ${EDIT}/<its id> with one line: **GenClass race report**: nothing flagged in this run (1 test, 1 file read).`,
      "dry run: without one, no request (nothing flagged)",
    ]);
  });

  it("a fork or a missing token: the same one-line notice as without --dry-run", async () => {
    flaggedRun();
    const fork = await run(["--comment", "--dry-run", "--quiet"], env({ GITHUB_EVENT_PATH: event({ head: { repo: { full_name: "alice/shop" } } }), GITHUB_STEP_SUMMARY: undefined }), fakeGitHub().fetch);
    expect(fork.lines).toEqual(["no pull-request comment: pull request 12 comes from a fork (alice/shop), where the workflow's token cannot write"]);
    const none = await run(["--comment", "--dry-run", "--quiet"], env({ GITHUB_TOKEN: undefined, GITHUB_STEP_SUMMARY: undefined }), fakeGitHub().fetch);
    expect(none.lines).toEqual(["no pull-request comment: GITHUB_TOKEN is not set (the step needs env GITHUB_TOKEN: ${{ github.token }} and the job permissions pull-requests: write)"]);
  });
});

describe("comment: the command's defaults are process.env and the global fetch", () => {
  it("without env and fetch in its io, --comment reads process.env and calls the global fetch", async () => {
    flaggedRun();
    const gh = fakeGitHub();
    vi.stubGlobal("fetch", gh.fetch);
    for (const [k, v] of Object.entries(env({ GITHUB_API_URL: "", GITHUB_STEP_SUMMARY: "" }))) vi.stubEnv(k, v ?? "");
    const err: string[] = [];
    expect(await runCli(["--comment", "--quiet"], { cwd: root, out: () => undefined, err: (s) => void err.push(s) })).toBe(0);
    expect(gh.requests()).toEqual([`GET ${LIST}?per_page=100&page=1`, `POST ${LIST}`]);
    expect(err.join("")).not.toContain(TOKEN);
  });
});

describe("comment: the one line for a run that flags nothing (renderNothingFlagged)", () => {
  const quiet = (name: string, seed: number) => ({ name, content: { schema: "genclass-races/1", test: `t${name}`, seed, signatures: [], shadow: null } });

  it("says what was read; null when the report flags something", () => {
    expect(renderNothingFlagged(buildSummary(fixtureInputs()))).toBeNull();
    expect(renderNothingFlagged(buildSummary([quiet("a", 1)]))).toBe(QUIET);
    expect(renderNothingFlagged(buildSummary([quiet("a", 1), quiet("b", 1), quiet("b", 2)]))).toBe(`${REPORT_MARKER}\n**GenClass race report**: nothing flagged in this run (2 tests, 3 files read).\n`);
    expect(renderNothingFlagged(buildSummary([quiet("a", 1), { name: "z.json", content: "{" }]))).toBe(
      `${REPORT_MARKER}\n**GenClass race report**: nothing flagged in this run (1 test, 1 file read, 1 skipped).\n`,
    );
    expect(renderNothingFlagged(buildSummary([{ name: "y.json", content: "{" }, { name: "z.json", content: "[]" }]))).toBe(
      `${REPORT_MARKER}\n**GenClass race report**: nothing flagged in this run: no race file could be read (2 skipped).\n`,
    );
    expect(renderNothingFlagged(buildSummary([]))).toBe(`${REPORT_MARKER}\n**GenClass race report**: nothing flagged in this run: no race files were found.\n`);
  });

  it("uses the report's title, escaped like the report's heading", () => {
    expect(renderNothingFlagged(buildSummary([quiet("a", 1)]), { title: "E2E *races* @team #1" })).toBe(
      `${REPORT_MARKER}\n**E2E \\*races\\* @${Z}team #${Z}1**: nothing flagged in this run (1 test, 1 file read).\n`,
    );
  });
});
