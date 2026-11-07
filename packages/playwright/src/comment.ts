// `genclass-playwright-report --comment`: the command's GitHub side (Node only; src/cli.ts runs it after the report
// is written). It adds the report to the job summary and keeps one GenClass comment on the pull request up to date,
// through GitHub's REST API with Node's fetch. What it does, and what it never does:
//
//   - The comment is touched only in a `pull_request` run (GITHUB_EVENT_NAME), on the pull request whose number the
//     event file (GITHUB_EVENT_PATH) holds, in GITHUB_REPOSITORY, through GITHUB_API_URL (default
//     https://api.github.com; GitHub Enterprise Server sets its own; https only).
//   - Skipped with a one-line notice and no request: other events, a pull request from a fork (its head repository
//     is not its base repository; the workflow's token is read-only there) and a missing GITHUB_TOKEN.
//   - The GenClass comment is the first of the pull request's comments, over every page, that starts with
//     REPORT_MARKER and whose author is a bot account (user.type "Bot"; the workflow's token writes as
//     github-actions[bot]). No other comment is ever edited: not a person's, even one that starts with the marker.
//   - A comment is created only when the report flags something. An existing one is edited to the new report or, when
//     nothing is flagged, to the summariser's one line saying so (renderNothingFlagged), and left alone when it
//     already says that. Nothing flagged and no GenClass comment: no write at all.
//   - Each write sends `{ body }` with text the summariser produced and nothing else, at most COMMENT_MAX_CHARS
//     characters, GitHub's limit (the report as written when its maxChars is at most that, else one cut to 60000).
//   - The token goes only into the Authorization header of requests to GITHUB_API_URL and never follows a redirect
//     (redirect: "error"). It is never printed: every line is scrubbed of it.
//   - Any API or network error is a one-line warning. Nothing here throws or rejects, and the command's exit code does
//     not depend on it. Every line it prints starts with the command's name (src/cli.ts), so none is read as a
//     workflow command.
//   - dryRun: the same checks, then the requests are printed instead of made, and the job summary is left alone.

import { appendFileSync, readFileSync } from "node:fs";
import { DEFAULT_MAX_CHARS, REPORT_MARKER, renderMarkdown, renderNothingFlagged, type RaceSummary, type SummarizeOptions } from "./summarize.js";

/** GitHub's limit on a comment's body, in characters. */
export const COMMENT_MAX_CHARS = 65536;
/** The REST API used when GITHUB_API_URL is not set. */
export const DEFAULT_GITHUB_API_URL = "https://api.github.com";
/** GitHub's limit on what one step adds to the job summary, in bytes. */
export const JOB_SUMMARY_MAX_BYTES = 1024 * 1024;
/** Comments per page when listing (GitHub's maximum). */
const PER_PAGE = 100;
/** Pages listed at most (5,000 comments): past that nothing is written, rather than risk a second GenClass comment. */
const MAX_PAGES = 50;
/** Each request's time limit. */
const TIMEOUT_MS = 30_000;

/** What became of the pull-request comment. */
export type CommentResult = "created" | "updated" | "unchanged" | "none" | "skipped" | "failed" | "dry-run";

/** The environment the step reads: process.env in the command. */
export type GitHubEnv = Readonly<Record<string, string | undefined>>;

/** What commentReport needs. */
export interface CommentOptions {
  /** The summariser's report: the comment's text when it flags something. At most COMMENT_MAX_CHARS characters. */
  report: string;
  /**
   * The summariser's one line for a run that flagged nothing (renderNothingFlagged), which an existing GenClass comment
   * is edited to; null when the report flags something.
   */
  nothingFlagged: string | null;
  /** GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_TOKEN and GITHUB_API_URL are read. */
  env: GitHubEnv;
  /** The fetch to call: the global fetch in the command, a fake in tests. */
  fetch: typeof fetch;
  /** Print the requests instead of making them. */
  dryRun?: boolean;
  /** Prints one line (given without its newline). */
  log(line: string): void;
}

/** What runCommentStep needs: the written report and how it was rendered, and the same env, fetch and log. */
export interface CommentStepOptions {
  /** The report as the command wrote it, rendered with `options`. */
  markdown: string;
  /** The same report as data. */
  summary: RaceSummary;
  /** The summariser's options the report was rendered with (maxChars, title, ...). */
  options: SummarizeOptions;
  /** As CommentOptions.env; GITHUB_STEP_SUMMARY is read too. */
  env: GitHubEnv;
  fetch: typeof fetch;
  dryRun?: boolean;
  log(line: string): void;
}

/**
 * What `--comment` runs once the report is written: it adds the report to the job summary (when GITHUB_STEP_SUMMARY is
 * set; a report over JOB_SUMMARY_MAX_BYTES is replaced by the comment's), then runs commentReport with the report as
 * written when `options.maxChars` is 1 to COMMENT_MAX_CHARS (the default, 60000, included), and otherwise with the
 * report rendered again within 60000 characters. Never throws or rejects.
 */
export async function runCommentStep(o: CommentStepOptions): Promise<CommentResult> {
  const token = tokenOf(o.env);
  const log = (line: string) => o.log(clean(line, token));
  try {
    const max = o.options.maxChars;
    const limit = typeof max === "number" && max > 0 && max <= COMMENT_MAX_CHARS ? max : DEFAULT_MAX_CHARS;
    const report = limit === (max ?? DEFAULT_MAX_CHARS) ? o.markdown : renderMarkdown(o.summary, { ...o.options, maxChars: limit });
    addToJobSummary(Buffer.byteLength(o.markdown, "utf8") <= JOB_SUMMARY_MAX_BYTES ? o.markdown : report, o.env, o.dryRun === true, log);
    return await commentReport({ report, nothingFlagged: renderNothingFlagged(o.summary, o.options), env: o.env, fetch: o.fetch, dryRun: o.dryRun, log });
  } catch (e) {
    log(`warning: --comment stopped (${errorText(e)}); the job is not failed for it`);
    return "failed";
  }
}

/**
 * Appends `text` to the job summary, the file GITHUB_STEP_SUMMARY names (GitHub Actions sets it for every step); does
 * nothing when that is not set, and with `dryRun` only says what it would do. Never throws: a failure is a warning.
 */
export function addToJobSummary(text: string, env: GitHubEnv, dryRun: boolean, log: (line: string) => void): void {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  if (dryRun) {
    log(`dry run: the report (${text.length} characters) would be added to the job summary`);
    return;
  }
  try {
    appendFileSync(path, text);
    log("added the report to the job summary");
  } catch (e) {
    log(`warning: could not add the report to the job summary (${errorText(e)}); the job is not failed for it`);
  }
}

/**
 * Keeps the pull request's GenClass comment up to date, as the module header says: creates it only for a report that
 * flags something, edits only a bot account's comment that starts with REPORT_MARKER, and sends only `report` or
 * `nothingFlagged`. Resolves to what became of it; never rejects, and every line it prints is scrubbed of the token.
 */
export async function commentReport(o: CommentOptions): Promise<CommentResult> {
  const token = tokenOf(o.env);
  const log = (line: string) => o.log(clean(line, token));
  const failed = (why: string): CommentResult => {
    log(`warning: ${why}; the job is not failed for it`);
    return "failed";
  };
  try {
    const pr = pullRequestOf(o.env);
    if (typeof pr === "string") {
      log(pr);
      return "skipped";
    }
    if (!token) {
      log("no pull-request comment: GITHUB_TOKEN is not set (the step needs env GITHUB_TOKEN: ${{ github.token }} and the job permissions pull-requests: write)");
      return "skipped";
    }
    if (!/^[\x21-\x7e]+$/.test(token)) {
      log("no pull-request comment: GITHUB_TOKEN holds spaces or control characters, so it is not sent");
      return "skipped";
    }
    const api = apiOf(o.env.GITHUB_API_URL);
    if (api === null) {
      log("no pull-request comment: GITHUB_API_URL is not an https URL, so the token is not sent to it");
      return "skipped";
    }
    const flagged = o.nothingFlagged === null;
    const body = o.nothingFlagged ?? o.report;
    if (body.length > COMMENT_MAX_CHARS) return failed(`no pull-request comment: the report has ${body.length} characters, more than GitHub takes in a comment (${COMMENT_MAX_CHARS})`);

    const issue = `${api}/repos/${pr.repo}/issues/${pr.number}`;
    const comments = `${api}/repos/${pr.repo}/issues/comments/`;
    const what = flagged ? `the report (${body.length} characters)` : `one line: ${body.slice(REPORT_MARKER.length).trim()}`;
    if (o.dryRun) {
      log(`dry run, no request is made: GET ${issue}/comments?per_page=${PER_PAGE}&page=1 (and the next pages while they are full) to find the first comment by a bot account that starts with ${REPORT_MARKER}`);
      log(`dry run: with one, PATCH ${comments}<its id> with ${what}`);
      log(flagged ? `dry run: without one, POST ${issue}/comments with ${what}` : "dry run: without one, no request (nothing flagged)");
      return "dry-run";
    }
    if (typeof o.fetch !== "function") return failed("no pull-request comment: this Node has no fetch");

    const send = (method: string, url: string, text?: string) => call(o.fetch, token, method, url, text);
    let found: GitHubComment | null = null;
    for (let page = 1; found === null; page++) {
      if (page > MAX_PAGES) {
        log(`no pull-request comment: pull request ${pr.number} has more than ${MAX_PAGES * PER_PAGE} comments, too many to look for the GenClass comment among`);
        return "skipped";
      }
      const r = await send("GET", `${issue}/comments?per_page=${PER_PAGE}&page=${page}`);
      if (!r.ok) return failed(r.why);
      if (!Array.isArray(r.data)) return failed(`GitHub's answer to GET ${issue}/comments is not a list`);
      found = (r.data as unknown[]).find(isGenClassComment) ?? null;
      if (r.data.length < PER_PAGE) break;
    }

    if (found === null) {
      if (!flagged) {
        log(`nothing flagged, so no comment on pull request ${pr.number}`);
        return "none";
      }
      const r = await send("POST", `${issue}/comments`, body);
      if (!r.ok) return failed(r.why);
      log(`posted the report on pull request ${pr.number}${authorNote(r.data)}`);
      return "created";
    }
    if (found.body === body) {
      log(`the GenClass comment on pull request ${pr.number} already says this; not edited`);
      return "unchanged";
    }
    const r = await send("PATCH", `${comments}${found.id}`, body);
    if (!r.ok) return failed(r.why);
    log(flagged ? `updated the GenClass comment on pull request ${pr.number}` : `nothing flagged in this run: the GenClass comment on pull request ${pr.number} now says so in one line`);
    return "updated";
  } catch (e) {
    return failed(`the pull-request comment stopped (${errorText(e)})`);
  }
}

interface GitHubComment {
  id: number;
  body: string;
}

type Answer = { ok: true; data: unknown } | { ok: false; why: string };

/** One request to the API. The token is in the Authorization header only; a redirect is an error. Never rejects. */
async function call(fetchImpl: typeof fetch, token: string, method: string, url: string, text?: string): Promise<Answer> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "genclass-playwright-report",
    "x-github-api-version": "2022-11-28",
  };
  if (text !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body: text === undefined ? undefined : JSON.stringify({ body: text }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, why: `${method} ${url} failed (${errorText(e)})` };
  }
  let answer = "";
  try {
    answer = await res.text();
  } catch {
    /* an unreadable answer reads as empty */
  }
  if (!res.ok) return { ok: false, why: `GitHub answered ${res.status} to ${method} ${url}${apiMessage(answer)}${hint(res.status)}` };
  try {
    return { ok: true, data: answer === "" ? null : (JSON.parse(answer) as unknown) };
  } catch {
    return { ok: false, why: `GitHub's answer to ${method} ${url} is not JSON` };
  }
}

/** The pull request to comment on, or the notice that says why there is none. */
function pullRequestOf(env: GitHubEnv): { repo: string; number: number } | string {
  const name = env.GITHUB_EVENT_NAME;
  if (name !== "pull_request") {
    return name
      ? `no pull-request comment: this run's event is ${JSON.stringify(name)}, not "pull_request"`
      : "no pull-request comment: this is not a GitHub Actions pull_request run (GITHUB_EVENT_NAME is not set)";
  }
  const path = env.GITHUB_EVENT_PATH;
  if (!path) return "no pull-request comment: GITHUB_EVENT_PATH is not set, so the pull request is not known";
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return `warning: no pull-request comment: the event file could not be read (${errorText(e)})`;
  }
  const pr = isObject(event) && isObject(event.pull_request) ? event.pull_request : null;
  const number = pr?.number;
  if (pr === null || typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return "warning: no pull-request comment: the event file names no pull request";
  const repo = env.GITHUB_REPOSITORY ?? "";
  if (!isRepoName(repo)) return "no pull-request comment: GITHUB_REPOSITORY is not owner/name";
  const base = repoOf(pr.base);
  const head = repoOf(pr.head);
  if (base === null || base.toLowerCase() !== repo.toLowerCase()) return `no pull-request comment: the event's pull request ${number} is not in ${repo}`;
  if (head === null || head.toLowerCase() !== base.toLowerCase()) {
    return `no pull-request comment: pull request ${number} comes from a fork (${head ?? "a repository that is gone"}), where the workflow's token cannot write`;
  }
  return { repo, number };
}

/** A pull request side's repository ("owner/name"), or null. */
function repoOf(side: unknown): string | null {
  const name = isObject(side) && isObject(side.repo) ? side.repo.full_name : undefined;
  return typeof name === "string" && isRepoName(name) ? name : null;
}

/** "owner/name" with GitHub's characters only, so it cannot change the shape of a URL path. */
function isRepoName(s: string): boolean {
  const parts = s.split("/");
  return parts.length === 2 && parts.every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && p !== "." && p !== "..");
}

/** GITHUB_API_URL (or the default) without a trailing slash, or null unless it is https with no credentials, query or fragment. */
function apiOf(value: string | undefined): string | null {
  let u: URL;
  try {
    u = new URL(value?.trim() || DEFAULT_GITHUB_API_URL);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

/** A comment the command may edit: a bot account's, starting with the marker, with an id. */
function isGenClassComment(c: unknown): c is GitHubComment {
  if (!isObject(c) || !isObject(c.user) || c.user.type !== "Bot") return false;
  return typeof c.id === "number" && Number.isSafeInteger(c.id) && c.id > 0 && typeof c.body === "string" && c.body.startsWith(REPORT_MARKER);
}

/** After a POST: a note when the new comment's author is not a bot account (a personal token), whose comments are never edited. */
function authorNote(data: unknown): string {
  const user = isObject(data) && isObject(data.user) ? data.user : null;
  if (user === null || user.type === "Bot") return "";
  const login = typeof user.login === "string" && /^[A-Za-z0-9_.-]+$/.test(user.login) ? user.login : "an account";
  return `. It was written as ${login}, not a bot account, and the command never edits such a comment, so each run will add one: give the step the workflow's token (github.token) or a GitHub App's`;
}

/** GitHub's error message from an error answer, shortened: " (message)", or "". */
function apiMessage(answer: string): string {
  try {
    const m = (JSON.parse(answer) as { message?: unknown } | null)?.message;
    if (typeof m === "string" && m.trim()) return ` (${m.trim().length > 200 ? `${m.trim().slice(0, 199)}…` : m.trim()})`;
  } catch {
    /* not JSON: nothing of it is printed */
  }
  return "";
}

function hint(status: number): string {
  if (status === 401) return "; the token was refused";
  if (status === 403 || status === 404) return "; does the job have permissions: pull-requests: write?";
  return "";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function tokenOf(env: GitHubEnv): string {
  return (env.GITHUB_TOKEN ?? "").trim();
}

/** One line, with the token replaced by *** wherever it appears. */
function clean(line: string, token: string): string {
  const scrubbed = token ? line.split(token).join("***") : line;
  return scrubbed.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ");
}

/** An error's message, with its cause's code or message (fetch's "fetch failed" says nothing on its own). */
function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  const detail = isObject(cause) ? (typeof cause.code === "string" ? cause.code : typeof cause.message === "string" ? cause.message : "") : "";
  return detail ? `${e.message}: ${detail}` : e.message;
}
