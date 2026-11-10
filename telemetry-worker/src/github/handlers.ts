// What genclass-dev[bot] does when GitHub tells it something happened: the webhook events, one function each, and the
// review of one pull request (reviewPull).
//
// Invariants:
// - The app acts only inside an installation, on the repository an event is about, and only in answer to an event
//   from GitHub that passed the signature check (src/github/http.ts), or, in the sweep, to run a review that
//   such an event started and that is still owed. It never opens a pull request, never comments on a repository it
//   is not installed on, and never @mentions anyone.
// - A review reads: the pull request's own fields, the repository's settings file on its default branch, the workflow
//   runs and artifacts of the head commit and, only when needed, the list of changed files. It never reads file
//   contents, and of a file's patch it keeps the line ranges only. Before an issue is opened at a merge, the issues
//   the app itself opened in the repository are listed, so that no finding is filed twice.
// - It writes at most: one check run per head commit (a second only to take the place of one in progress whose id
//   was lost with the job that created it), one summary comment per pull request (edited in place), one review with
//   inline comments per new reproducible finding, and one reply per command. An unchanged result is not written again
//   (body hashes in the pull request's state). An issue is opened only when the repository's settings ask for one at
//   a merge (`issues: merge`: one per pull request, and none for a finding that already has one) or a person with
//   write access asks (`issue <n>`).
// - A repository hears nothing until there is something to read for it. Before race files were read for it once, a
//   pull request without them gets no check and no comment. The exceptions: once per repository of an installation on
//   selected repositories, a check that says what the app reads; once per private repository without a plan, a check
//   that says so; a repository linked to a GenClass app; a pull request that had race files or a comment itself; and
//   a person who asks (a command, Re-run on the check), who always gets an answer. An artifact that could not be
//   read is not race files read: it changes none of this. Only race files from inside a repository (a branch of it,
//   or an author GitHub calls owner, member or collaborator) make it one whose every pull request gets the check.
// - A check that says how to set the app up may carry a link that opens GitHub's new-file editor with the workflow
//   file filled in (workflowLinkFor), only on a server that has the link on (GITHUB_APP_WORKFLOW_LINK). Its parts are
//   the server's own GitHub web root, the repository's full name, its default branch as GitHub names it (in the pull
//   request GitHub returns, else in the signed payload of the event) and the app's own text; no default branch, no
//   link. The link goes to a check run and nowhere else: never into a comment, a reply or an issue.
// - The pull request's state (its head commit, open or closed) is always asked of GitHub, never taken from a webhook
//   payload: a payload may be old (a redelivery, deliveries out of order).
// - A check run is never left "in progress" without something certain to finish it. One is left in progress only
//   under `check.fail_on`, while its commit's test run can still report or after a first read of its race files that
//   was not whole (below), and the row says so before the check exists (PrState.waiting and held, the row's `due`). Every way a wait can end without a review finishes the check and
//   says why: a pause, a setting, a newer commit, a closed pull request, a limit reached for good. An hourly limit, a
//   failed job, and a job the platform stopped leave the review owed, and the sweep (githubSweep: every 20 minutes
//   on its own cron trigger, and with the daily one) runs it. One run of the sweep looks at SWEEP_ROWS pull requests
//   at most, and ends at the first failure that is not GitHub's answer (the database, a limit of the platform).
// - A verdict a commit's race files gave is not replaced by a weaker one because those files cannot be read again.
// - Under `check.fail_on` no verdict is given from a first read of a commit that is not whole (an artifact that could
//   not be downloaded, one that has expired; evidence.ts `incomplete`) unless what was read fails the check: the check
//   stays in progress with the note, nothing of that read is kept, and the review is owed. A person who asks, and the
//   sweep, get the verdict from what can be read then, neutral at best.
// - A repository's settings are never guessed. The defaults stand in only when GitHub says there is no settings file
//   (or that the app may not read it, or that it is too large). When the file could not be fetched, the job fails
//   before it writes anything, nothing is cached, and the next event asks again: a repository that turned the comment,
//   reviews or commands off is not treated as having the defaults because GitHub did not answer.
// - Commands are taken only from people GitHub says have write access (for review, replay and help: also the pull
//   request's author), never from bots, and `fix` never for a pull request from a fork (an agent workflow would run
//   that fork's code with the repository's secrets). "Write access" is GitHub's answer to the permission question for
//   that person on that repository, never the association an event carries (it calls a member whose membership is
//   private a contributor, and a member with read access a member). A review asked for by the author without write
//   access reads the commit again; it does not lift a pause on the pull request or `reviews.ignore_authors`.
// - What a person asked for holds for the one pass it was asked for. A pass that follows in the same job runs as what
//   arrived meanwhile (an event, or another request), so a request does not carry its asker's rights into later
//   passes. A pause set after a request stops that request's pass before it writes, and the passes after it; a
//   request that was waiting when the pause was set does not lift it (store.ts savePr). A pass that runs as a request
//   is counted as one, never under the share of the hour that pushes have.
// - An issue (`issues: merge`) is opened under the pull request's lease, only for findings flagged in the race files
//   of the commit that merged (they are read first when the stored findings are an older commit's), never for a
//   paused pull request or repository, once per pull request, and never for a finding that an issue the app opened
//   in the repository already lists. Reading at the merge follows the review settings: for a pull request that
//   `reviews.auto`, `reviews.branches` or `reviews.ignore_authors` leave out, nothing is read or counted then, and
//   there is no issue. While the merged commit's workflow runs do not exist yet or have not all finished, nothing is
//   decided: the review stays owed and the sweep decides with what there is.
// - A private repository without a plan that includes it is not read (src/github/entitlement.ts).
// - One review at a time per pull request (the lease). Limits: PR_REVIEWS_PER_HOUR per pull request an hour, counted
//   before anything is asked of GitHub; REVIEWS_PER_HOUR per installation an hour, counted only for a review that
//   reads a commit's evidence (of them at most PUSH_REVIEWS_PER_HOUR started by pull_request events and
//   OUTSIDE_REVIEWS_PER_HOUR for pull requests by authors from outside the repository); REVIEWS_PER_PR writes per pull
//   request in all. What is written about an hourly limit names the one that stopped the review. A rate limit from
//   GitHub ends the job quietly and the next event tries again.
// - A job stops itself JOB_MS after its webhook arrived, well inside the 30 seconds the platform gives it: no request
//   to GitHub starts after that, the lease is released, the review is left owed and the job fails, so its delivery
//   is forgotten and can be redelivered.
// - Nothing from GitHub is logged except a short outcome word per delivery.

import type { Env } from "../collector.js";
import type { D1Like } from "../dashboard.js";
import { appClient, forgetInstallation, GithubError, installationClient, posInt, repoPath, type Fetch, type GithubClient } from "./api.js";
import { NEEDS_FINDING, NEEDS_WRITE, parseCommand } from "./commands.js";
import { githubApp, type GithubAppConfig } from "./config.js";
import { repoEntitled } from "./entitlement.js";
import { ciEvidence, noEvidence, productionEvidence } from "./evidence.js";
import {
  CHECK_NAME,
  inlineComments,
  issueFingerprints,
  mergeFindings,
  parseState,
  patchLines,
  renderCheck,
  renderFixBrief,
  renderHelp,
  renderIntro,
  renderIssue,
  renderOverLimit,
  renderReplay,
  renderStopped,
  renderSummary,
  renderUnsettled,
  REPLY_MARKER,
  sha256Hex,
  summaryOf,
  testLocations,
  unread,
  type CheckOutput,
  type HourLimit,
  type PrState,
  type ReviewLinks,
  type ReviewModel,
  type StopReason,
  type StoredFinding,
  type TestLocation,
} from "./review.js";
import { branchMatches, readSettings, SETTINGS_PATH, type RepoSettings } from "./settings.js";
import { WORKFLOW_ARTIFACT, workflowLink } from "./workflow-file.js";
import {
  claimPrHour,
  claimRepoFact,
  claimReview,
  closePr,
  deleteInstallation,
  deleteMarketplace,
  DUE_AFTER_MS,
  duePrs,
  installationById,
  OUTSIDE_REVIEWS_PER_HOUR,
  PENDING_ASKED,
  PENDING_AUTHOR,
  PR_REVIEWS_PER_HOUR,
  prRow,
  prsAtSha,
  PUSH_REVIEWS_PER_HOUR,
  releaseIssueTurn,
  releaseLease,
  removeRepos,
  repoById,
  repoFacts,
  REVIEWS_PER_HOUR,
  REVIEWS_PER_PR,
  savePr,
  setDue,
  setMarketplace,
  setMarketplacePending,
  setSelection,
  setSuspended,
  takeIssueTurn,
  takeLease,
  touchRepo,
  upsertInstallation,
  type Installation,
  type PrRow,
  type RepoRow,
} from "./store.js";

export interface Ctx {
  env: Env;
  db: D1Like;
  cfg: GithubAppConfig;
  /** Requests to GitHub. In a job (jobContext) none starts after the deadline. */
  f: Fetch;
  now: () => Date;
  /** When the job must have stopped, in ms by `now`: nothing new is started after it. */
  deadline: number;
}

// --------------------------------------------------------------------------------------------- a job's time

/**
 * How long a job may work, from the moment its webhook arrived. The platform stops whatever still runs 30 seconds
 * after the webhook's response, without running another line: a job that stops itself well before that ends like any
 * failed job, with its lease released, its review left owed and its delivery forgotten.
 */
export const JOB_MS = 20_000;
/** A request that writes and started before the deadline may be answered until this long after the job's start. */
const JOB_HARD_MS = 27_000;
/** The least time left in which another pass over a pull request, or another pull request, is started. */
export const PASS_MS = 5_000;
/** Passes over one pull request in one job, however many events arrive while it runs. */
const MAX_PASSES = 5;
/** The REST client's own timeout per request (src/github/api.ts). */
const FETCH_MS = 10_000;
/**
 * The sweep: pull requests looked at in one run, and how long one run may take. A review is some 15 statements on the
 * database and up to 40 requests to GitHub, and the platform caps both for one invocation: 20 reviews stay under a
 * thousand of each.
 */
export const SWEEP_ROWS = 20;
const SWEEP_MS = 240_000;
/**
 * The cron trigger that runs the sweep and nothing else (wrangler.toml `crons`; src/index.ts chooses by it): every 20
 * minutes. The daily trigger runs the sweep too, after the retention sweeps.
 */
export const SWEEP_CRON = "*/20 * * * *";

/**
 * A job's context. Its `f` starts no request to GitHub once JOB_MS have passed since `startedMs` (the REST client
 * reports that as a network error, so the job fails the ordinary way), and no request waits past the time the job has.
 */
export function jobContext(base: Omit<Ctx, "deadline">, startedMs: number): Ctx {
  const deadline = startedMs + JOB_MS;
  const hard = startedMs + JOB_HARD_MS;
  const f: Fetch = (input, init) => {
    const nowMs = base.now().getTime();
    if (nowMs >= deadline) return Promise.reject(new Error("the job's time is up"));
    // a read is given up at the deadline; a write that has started is given time to be answered, so that the id of
    // what it made (a check run, a comment) is not lost
    const left = ((init?.method ?? "GET") === "GET" ? deadline : hard) - nowMs;
    return base.f(input, left < FETCH_MS ? { ...init, signal: AbortSignal.timeout(left) } : init);
  };
  return { ...base, f, deadline };
}

const timeLeft = (ctx: Ctx): number => ctx.deadline - ctx.now().getTime();

/**
 * What a job fails with when too little of its time is left to start what remains (another pass, another pull
 * request). The webhook reports it, and a request refused after the deadline, as "deadline".
 */
export class OutOfTime extends GithubError {
  constructor() {
    super("network", 0, "the job's time is up");
  }
}
const timeUp = (): OutOfTime => new OutOfTime();
/** The end of the current UTC hour as "HH:MM", for the sentences about an hourly limit. */
const hourEnd = (now: Date): string => new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 + 3_600_000).toISOString().slice(11, 16);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Where the docs live: the app's guide in this repository (what each line means, setup, every setting). */
export const DOCS_URL = "https://github.com/genclass-dev/GenClass/blob/main/docs/github-app/README.md#what-the-lines-mean";
export const SETUP_URL = "https://github.com/genclass-dev/GenClass/blob/main/docs/github-app/README.md";

export const linksOf = (cfg: GithubAppConfig): ReviewLinks => ({ docs: DOCS_URL, setup: SETUP_URL, app: `${cfg.origin}/github`, origin: cfg.origin });

interface RepoRef {
  id: number;
  fullName: string;
  /** "/repos/<owner>/<name>" */
  path: string;
  private: boolean;
  owner: { id: number; login: string; type: string } | null;
  /** The default branch's name as the event's payload (or GitHub's answer to a token request) gives it; null when it gives none. */
  defaultBranch: string | null;
}

/** A branch's name from GitHub, whole or not at all: one that is too long is not cut down to another name. */
const branchName = (v: unknown): string | null => (typeof v === "string" && v !== "" && v.length <= 255 ? v : null);

function repoOf(p: Obj): RepoRef | null {
  const r = obj(p.repository);
  const id = posInt(r.id);
  const path = repoPath(r.full_name);
  if (!id || !path) return null;
  const o = obj(r.owner);
  const ownerId = posInt(o.id);
  const login = str(o.login, 40);
  const owner = ownerId && /^[A-Za-z0-9_-]{1,39}$/.test(login) ? { id: ownerId, login, type: str(o.type, 20) } : null;
  return { id, fullName: String(r.full_name), path, private: r.private !== false, owner, defaultBranch: branchName(r.default_branch) };
}

/**
 * The address that opens GitHub's new-file editor with the workflow file filled in, for a check that says how to set
 * the app up (src/github/workflow-file.ts). Null, and the check's text is what it is without the link, when this
 * server has the link off (GITHUB_APP_WORKFLOW_LINK), when the repository's default branch is not known, when the
 * repository's settings read artifacts under another name than the one that file uploads, or when the name or the
 * branch is not one a link can be built from.
 */
function workflowLinkFor(cfg: GithubAppConfig, repo: RepoRef, branch: string | null, settings: RepoSettings): string | null {
  if (!cfg.workflowLink || !branch || !WORKFLOW_ARTIFACT.startsWith(settings.artifact)) return null;
  return workflowLink(cfg.web, repo.fullName, branch);
}

const installationIdOf = (p: Obj): number | null => posInt(obj(p.installation).id);

/**
 * A login as GitHub can give one, else null: letters, digits and hyphens; for an Enterprise Managed User an underscore
 * before the short code ("mona-cat_octo"); for a bot the "[bot]" ending. A login is only ever used as one segment of
 * an API path and printed through the escaping, so this checks what those two uses need (no "/", ".", "%", space or
 * markup), not that the account exists.
 */
export function githubLogin(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,39}(?:\[bot\])?$/.test(v) ? v : null;
}

/**
 * The installation an event is about; recorded from the event itself when its `created` event never arrived. Such an
 * event does not say whether the installation covers all repositories or selected ones: that stays "unknown" until
 * GitHub is asked (selectionOf).
 */
async function installationFor(ctx: Ctx, id: number, repo: RepoRef | null): Promise<Installation | null> {
  const known = await installationById(ctx.db, id);
  if (known || !repo?.owner) return known;
  await upsertInstallation(ctx.db, { id, accountId: repo.owner.id, login: repo.owner.login, type: repo.owner.type, selection: "unknown" }, ctx.now());
  return installationById(ctx.db, id);
}

/**
 * Whether the installation covers all repositories or selected ones. One that was first seen through an event is
 * asked about once, as the app, and the answer is stored. Until GitHub has answered it counts as "all", the quieter
 * of the two (a repository of it gets nothing before race files were read for it).
 */
async function selectionOf(ctx: Ctx, inst: Installation): Promise<"all" | "selected"> {
  if (inst.selection === "all" || inst.selection === "selected") return inst.selection;
  try {
    const answer = obj(await appClient(ctx.cfg, ctx.f, ctx.now, 2).get(`/app/installations/${inst.id}`));
    const selection = answer.repository_selection === "all" ? "all" : answer.repository_selection === "selected" ? "selected" : null;
    if (!selection) return "all";
    await setSelection(ctx.db, inst.id, selection, ctx.now());
    inst.selection = selection;
    return selection;
  } catch {
    return "all";
  }
}

// --------------------------------------------------------------------------------------------- settings

const SETTINGS_TTL_MS = 120_000;
/** What GitHub answered about a repository's settings file: its text, null when there is none to read, or that it is too large. */
const settingsCache = new Map<number, { exp: number; text: string | null; tooLarge: boolean }>();
/** Drops cached settings files (tests). */
export const resetSettingsCache = (): void => settingsCache.clear();

/**
 * The repository's settings file on its default branch (cached two minutes per isolate), parsed.
 * The defaults are returned only when GitHub itself says there is nothing to read: no file (404), the app may not read
 * it (403: it was registered without the single-file permission, docs/github-app/SETUP.md), or the file is too large
 * (the check says so). Every other failure is thrown and nothing is cached: GitHub did not answer, answered 5xx, gave
 * no installation token, or sent something that cannot be read. The caller's job then fails before it has written
 * anything from these settings, and the next event asks GitHub again. A repository that set `comment: never`,
 * `reviews: false` or `commands: false` is never treated as having the defaults because the file could not be fetched.
 */
async function settingsOf(ctx: Ctx, gh: GithubClient, repo: RepoRef): Promise<{ settings: RepoSettings; warnings: string[] }> {
  const nowMs = ctx.now().getTime();
  const hit = settingsCache.get(repo.id);
  let got = hit && hit.exp > nowMs ? hit : null;
  if (!got) {
    let text: string | null = null;
    let tooLarge = false;
    try {
      // no `ref`: the default branch, whatever a pull request's head says
      const file = obj(await gh.get(`${repo.path}/contents/${SETTINGS_PATH}`, { maxBytes: 64 * 1024 }));
      if (file.type === "file" && file.encoding === "base64" && typeof file.content === "string") {
        const bin = atob(file.content.replace(/\s+/g, ""));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        text = new TextDecoder().decode(bytes);
      } else if (file.type === "file") {
        // a file GitHub describes without its content (over 1 MB)
        tooLarge = true;
      }
    } catch (e) {
      const kind = e instanceof GithubError ? e.kind : null;
      if (kind !== "not_found" && kind !== "forbidden" && kind !== "too_large") throw e;
      tooLarge = kind === "too_large";
    }
    // only an answer from GitHub is kept: the file, or its word that there is none to read
    if (settingsCache.size > 2000) settingsCache.clear();
    got = { exp: nowMs + SETTINGS_TTL_MS, text, tooLarge };
    settingsCache.set(repo.id, got);
  }
  const out = readSettings(got.text);
  if (got.tooLarge) out.warnings.push(`${SETTINGS_PATH} is too large to read; the defaults are used.`);
  return out;
}

// --------------------------------------------------------------------------------------------- publishing

function retryable(e: unknown): boolean {
  return e instanceof GithubError && (e.kind === "rate_limited" || e.kind === "unauthorized" || e.kind === "budget" || e.kind === "network" || e.kind === "server");
}

/** The pull request's row as a pass sees it: kept current as the pass saves. */
type RowView = Pick<PrRow, "head_sha" | "check_run_id" | "comment_id">;

/**
 * Create or update the check run on `headSha`; with `create` false one that exists is rewritten and none is made.
 * Returns its id (null when there is none) and whether GitHub was written to: an unchanged result is not sent again.
 */
async function publishCheck(gh: GithubClient, repo: RepoRef, row: RowView, state: PrState, headSha: string, out: CheckOutput, create = true): Promise<{ id: number | null; wrote: boolean }> {
  const body: Obj = {
    name: CHECK_NAME,
    head_sha: headSha,
    status: out.status,
    details_url: SETUP_URL,
    output: { title: out.title, summary: out.summary || out.title, ...(out.text ? { text: out.text } : {}) },
    ...(out.conclusion ? { conclusion: out.conclusion } : {}),
  };
  const hash = (await sha256Hex(JSON.stringify(body))).slice(0, 32);
  const same = row.check_run_id !== null && row.head_sha === headSha;
  if (same && state.checkHash === hash) return { id: row.check_run_id, wrote: false };
  let id: number | null = null;
  if (same) {
    const { head_sha: _sha, ...patch } = body;
    try {
      await gh.patch(`${repo.path}/check-runs/${row.check_run_id}`, patch);
      id = row.check_run_id;
    } catch (e) {
      if (!(e instanceof GithubError && e.kind === "not_found")) throw e;
    }
  }
  if (id === null) {
    if (!create) return { id: null, wrote: false };
    id = posInt(obj(await gh.post(`${repo.path}/check-runs`, body)).id);
  }
  state.checkHash = hash;
  return { id, wrote: true };
}

/**
 * Create or update the summary comment. Returns its id (null when there is none now) and whether GitHub was written
 * to. A comment someone deleted is written again only when there is a new finding to tell them about.
 */
async function publishComment(gh: GithubClient, repo: RepoRef, number: number, row: RowView, state: PrState, body: string | null, wanted: boolean, hasNew: boolean): Promise<{ id: number | null; wrote: boolean }> {
  if (body === null || !wanted) return { id: row.comment_id, wrote: false };
  const hash = (await sha256Hex(body)).slice(0, 32);
  if (row.comment_id !== null) {
    if (state.commentHash === hash) return { id: row.comment_id, wrote: false };
    try {
      await gh.patch(`${repo.path}/issues/comments/${row.comment_id}`, { body });
      state.commentHash = hash;
      return { id: row.comment_id, wrote: true };
    } catch (e) {
      if (!(e instanceof GithubError && e.kind === "not_found")) throw e;
      state.commentHash = null;
      state.commentDeleted = true;
    }
  }
  if (state.commentDeleted && !hasNew) return { id: null, wrote: false };
  const id = posInt(obj(await gh.post(`${repo.path}/issues/${number}/comments`, { body })).id);
  state.commentHash = id ? hash : null;
  if (id) state.commentDeleted = false;
  return { id, wrote: true };
}

/** The workflow runs on a commit, from one request: which of them have completed. */
async function runsOf(gh: GithubClient, repo: RepoRef, sha: string): Promise<{ id: number; completed: boolean }[]> {
  const listed = obj(await gh.get(`${repo.path}/actions/runs`, { query: { head_sha: sha, per_page: 100 } }));
  const out: { id: number; completed: boolean }[] = [];
  for (const r0 of Array.isArray(listed.workflow_runs) ? listed.workflow_runs : []) {
    const r = obj(r0);
    const id = posInt(r.id);
    if (id && r.head_sha === sha) out.push({ id, completed: r.status === "completed" });
  }
  return out;
}

// --------------------------------------------------------------------------------------------- the review

export interface ReviewTarget {
  installationId: number;
  repo: RepoRef;
  number: number;
}

export interface ReviewOptions {
  /**
   * The pull request as a webhook payload carried it. It is used for one thing: the head commit on which a private
   * repository without a plan is told, once, why nothing is read (nothing may be asked of GitHub about it). A review
   * itself always asks GitHub for the pull request.
   */
  pull?: Obj;
  /**
   * A person asked for it. `true`: someone with write access did (a command, Re-run on the check): run even when
   * automatic reviews are off, for a draft, a base branch or an author the settings leave out, when paused on the pull
   * request, or in a repository the app has had nothing to read for yet. "author": the pull request's author, whom
   * GitHub does not give write access, typed `review`: the same, except that a pause on the pull request and
   * `reviews.ignore_authors` still hold. Only someone with write access lifts those. It holds for the first pass of
   * the job; a pass after it runs as what arrived meanwhile (reviewPull).
   */
  asked?: boolean | "author";
  /**
   * Started by a pull_request event (an open, a push). The commit's test run has usually not finished then, so these
   * reviews use at most PUSH_REVIEWS_PER_HOUR of the installation's hour.
   */
  push?: boolean;
  /**
   * The workflow run whose end started the review, when it uploaded an artifact whose name starts with the `artifact`
   * setting: its workflow's runs are asked for their artifacts first, and the run is asked about by itself when
   * GitHub's list of the commit's runs does not show it (src/github/evidence.ts).
   */
  run?: number;
  /** The sweep: a wait that nothing ended is ended with what there is, as for a person who asks. */
  final?: boolean;
  /** A `closed` event: GitHub is asked whether the pull request is closed now, and nothing is reviewed when it is not. */
  closing?: boolean;
}

interface Pull {
  open: boolean;
  merged: boolean;
  draft: boolean;
  headSha: string;
  baseRef: string;
  author: string;
  /** GitHub's word for what the author is to the repository ("OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "NONE"...). */
  association: string;
  /** The head branch lives in this repository (not a fork). */
  sameRepo: boolean;
  /** The repository's default branch as the pull request names it (its base repository is this one); null when it does not. */
  defaultBranch: string | null;
}

/** Authors GitHub counts as part of the repository. */
const INSIDE: readonly string[] = ["OWNER", "MEMBER", "COLLABORATOR"];

const OVER_PR = "over the pull request's budget";
const OVER_PR_HOUR = "over the pull request's hourly budget";
const OVER_HOUR = "over the hourly budget";
const OVER_PUSH = "over the hourly budget for pushes";
const OVER_OUTSIDE = "over the hourly budget for outside authors";
/** For each word a pass ends with at an hourly limit: the limit that stopped it, as a reply to a person names it. */
const HOUR_LIMITS = new Map<string, { scope: HourLimit; limit: number }>([
  [OVER_HOUR, { scope: "installation", limit: REVIEWS_PER_HOUR }],
  [OVER_PUSH, { scope: "push", limit: PUSH_REVIEWS_PER_HOUR }],
  [OVER_OUTSIDE, { scope: "outside", limit: OUTSIDE_REVIEWS_PER_HOUR }],
  [OVER_PR_HOUR, { scope: "pull request", limit: PR_REVIEWS_PER_HOUR }],
]);
const NOT_CLOSED = "not closed";
const ISSUE_OPENED = "issue opened";

function pullOf(p: Obj, repo: RepoRef): Pull | null {
  const head = obj(p.head);
  const base = obj(p.base);
  const sha = str(head.sha, 64);
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return null;
  return {
    open: p.state === "open",
    merged: p.merged === true,
    draft: p.draft === true,
    headSha: sha,
    baseRef: str(base.ref, 255),
    author: str(obj(p.user).login, 60).toLowerCase(),
    association: str(p.author_association, 30),
    sameRepo: posInt(obj(head.repo).id) === repo.id,
    defaultBranch: posInt(obj(base.repo).id) === repo.id ? branchName(obj(base.repo).default_branch) : null,
  };
}

/** What one pass over a pull request ended with: a word for the delivery's answer, and whether a review is still owed. */
interface Pass {
  word: string;
  due: boolean;
}

/**
 * Review one pull request: read its evidence, fold it into the stored findings, and write what changed. Returns a
 * short word for what happened. Throws GithubError when GitHub could not be reached or refused, or when the job's time
 * ran out (the caller forgets the delivery so a redelivery tries again); the pull request's row then stays due, and
 * the sweep reviews it if nothing else does first.
 */
export async function reviewPull(ctx: Ctx, t: ReviewTarget, o: ReviewOptions = {}): Promise<string> {
  const { db } = ctx;
  const inst = await installationFor(ctx, t.installationId, t.repo);
  if (!inst) return "unknown installation";
  if (inst.suspended) return "suspended";
  const stored = await repoById(db, t.repo.id);
  if (stored) await touchRepo(db, { repoId: t.repo.id, installationId: t.installationId, fullName: t.repo.fullName, private: t.repo.private }, ctx.now());
  // a paused repository is left alone, with one exception: a check it left in progress is finished
  if (stored?.paused) {
    const known = await prRow(db, t.repo.id, t.number);
    if (!known || !parseState(known.state).held) return "paused";
  }

  const key = { repoId: t.repo.id, number: t.number, installationId: t.installationId };
  let row = await takeLease(db, { ...key, asked: o.asked }, ctx.now());
  if (!row) return "busy";
  // what a person asked for holds for the pass it was asked for: the first one, or the one their mark starts
  let asked: boolean | "author" = o.asked ?? false;
  // a `closed` event's question is answered by the first pass; a pass after it is a review like any other
  let closing = !!o.closing;
  let open = false;
  for (let pass = 1; ; pass++) {
    let result: Pass | null = null;
    let failure: unknown;
    try {
      // a pass that runs as a person's request is counted as one: not under the share of the hour that pushes have
      result = await reviewOnce(ctx, t, inst, stored, row, { ...o, asked, closing, push: asked ? false : o.push });
      if (result.word === NOT_CLOSED) open = true;
      closing = false;
    } catch (e) {
      failure = e;
    }
    // let go. A pass that failed leaves the row due, as takeLease marked it: its review is owed
    const settled = result ? { due: result.due ? ctx.now().toISOString() : null } : {};
    const pending = await releaseLease(db, t.repo.id, t.number, { lease: row.lease, ...settled }).catch(() => 0);
    if (pending) {
      // something arrived while this pass ran (after a failure too): once more, from the pull request's current state
      if (pass >= MAX_PASSES || timeLeft(ctx) < PASS_MS) {
        // no time for it in this job: the review is owed, and the job fails so that its delivery can be redelivered
        await setDue(db, t.repo.id, t.number, ctx.now().toISOString()).catch(() => undefined);
        throw result ? timeUp() : failure;
      }
      // The next pass is what arrived meanwhile, and no more than that: a request is run as one, with what its asker
      // may lift; an event is run as an event, whoever asked for the pass before it. So the rights of a request end
      // with its pass, and a pause set after it stops the passes that follow.
      asked = pending === PENDING_ASKED ? true : pending === PENDING_AUTHOR ? "author" : false;
      const next = await takeLease(db, { ...key, asked }, ctx.now());
      if (next) {
        row = next;
        continue;
      }
      // another review took the pull request first: it starts from the current state, which is what the mark asked for
    }
    if (!result) throw failure;
    return open ? NOT_CLOSED : result.word;
  }
}

async function reviewOnce(ctx: Ctx, t: ReviewTarget, inst: Installation, stored: RepoRow | null, leased: PrRow, o: ReviewOptions): Promise<Pass> {
  const { db, cfg } = ctx;
  const { repo, number } = t;
  const row: RowView = { head_sha: leased.head_sha, check_run_id: leased.check_run_id, comment_id: leased.comment_id };
  const state = parseState(leased.state);
  const links = linksOf(cfg);
  const gh = installationClient(cfg, ctx.f, ctx.now, t.installationId, repo.id);
  const repoKey = { repoId: repo.id, installationId: t.installationId };
  const save = (v: Parameters<typeof savePr>[3]): Promise<void> => savePr(db, repo.id, number, v, ctx.now());
  // a pass that wrote something on GitHub counts once toward the pull request's lifetime budget
  let counted = false;
  const count = (wrote: boolean): boolean => (wrote && !counted ? (counted = true) : false);
  /** `commands` of the settings, once they are read (the sentences that name a command leave it out when they are off). */
  let commands: boolean | undefined;

  /**
   * End the pass without a review. A check that waits on the stored head commit is told why, so that it never goes on
   * saying it waits, or stays in progress, when nothing will read the commit. An hourly limit is different: the review
   * is still owed, so the wait is kept (a check in progress stays in progress, with the reason) and the row stays due.
   */
  const stop = async (word: string, why: StopReason): Promise<Pass> => {
    const owed = why === "hour" || why === "hour-push" || why === "hour-outside" || why === "pr-hour";
    const had = state.waiting !== null;
    const waits = had && state.waiting === row.head_sha;
    const known = row.check_run_id !== null;
    // these three change nothing for a check that is already completed: only one left in progress is rewritten
    const heldOnly = owed || why === "closed" || why === "plan";
    let wrote = false;
    // A check in progress whose id the row does not have (the job that created it was stopped before it could store
    // the id) cannot be rewritten: a new check run on the commit takes its place, as GitHub shows the latest of a name.
    if (waits && (state.held || (known && !heldOnly))) {
      // the number of the limit that stopped the review, not of another one
      const limits: Partial<Record<StopReason, number>> = { hour: REVIEWS_PER_HOUR, "hour-push": PUSH_REVIEWS_PER_HOUR, "hour-outside": OUTSIDE_REVIEWS_PER_HOUR, "pr-hour": PR_REVIEWS_PER_HOUR, "pr-total": REVIEWS_PER_PR };
      const limit = limits[why];
      const out = renderStopped(why, { mention: cfg.slug, held: state.held, commands, limit, after: hourEnd(ctx.now()) });
      const res = await publishCheck(gh, repo, row, state, row.head_sha, out, !known);
      wrote = res.wrote;
      row.check_run_id = res.id;
    }
    if (had && !owed) {
      state.waiting = null;
      state.held = false;
    }
    if (had || wrote) await save({ checkRunId: row.check_run_id, state: JSON.stringify(state), reviewed: count(wrote) });
    return { word, due: owed };
  };

  // nothing of a private repository without a plan is read
  const entitled = await repoEntitled(db, ctx.env, cfg, inst, repo, ctx.now());
  if (!entitled.ok) {
    const word = "private repository without a plan";
    // a check from the time the repository was reviewed is not left waiting
    if (state.waiting !== null) return stop(word, "plan");
    // The repository is told why once: a check on the first pull request an event carries, never again, never as a
    // comment. The claim comes before the write, so two pull requests opened together cannot both get it.
    const head = o.pull ? pullOf(o.pull, repo) : null;
    if (head?.open && (await claimRepoFact(db, repoKey, "plan_notice", ctx.now()))) {
      const model: ReviewModel = { repo: repo.fullName, number, headSha: head.headSha, mention: cfg.slug, ci: noEvidence(), summary: null, findings: [], production: null, settings: readSettings(null).settings, warnings: [], links };
      const res = await publishCheck(gh, repo, row, state, head.headSha, renderCheck(model, { entitled: false, plansUrl: `${cfg.origin}/github#plans` }));
      await save({ headSha: head.headSha, checkRunId: res.id, state: JSON.stringify(state), reviewed: count(res.wrote) });
    }
    return { word, due: false };
  }

  // the limits that need nothing from GitHub come before anything is asked of it
  if (stored?.paused) return stop("paused", "repo-paused");
  if (leased.reviews >= REVIEWS_PER_PR) return stop(OVER_PR, "pr-total");
  if (!(await claimPrHour(db, repo.id, number, ctx.now()))) return stop(OVER_PR_HOUR, "pr-hour");

  // The pull request as GitHub has it now. A webhook's copy may be old (a redelivery, deliveries out of order), and an
  // old copy must not move the row back to a commit that is no longer the head, or reopen a pull request that closed.
  const pull = pullOf(obj(await gh.get(`${repo.path}/pulls/${number}`)), repo);
  if (!pull) return { word: "unreadable pull request", due: state.waiting !== null };
  if (!pull.open) {
    await closePr(db, repo.id, number, ctx.now());
    const closed = await stop("closed", "closed");
    // Merged: whether an issue is opened (`issues: merge`) is decided here, under the lease, by the first pass that
    // finds the pull request merged, whichever event started it.
    return pull.merged ? issueOnMerge(ctx, t, gh, leased, state, pull, { run: o.run, final: !!o.final }) : closed;
  }
  if (o.closing) return { word: NOT_CLOSED, due: state.waiting !== null };
  // reopened: its row counts as open again (workflow runs find it, the sweep leaves it)
  if (leased.closed) await save({ closed: null });

  // A check run belongs to one commit. When the head moved, the stored one is the old commit's: one left in progress
  // there is finished, and the row is about the new commit from here on (its workflow runs find the pull request).
  if (row.head_sha !== pull.headSha) {
    let wrote = false;
    if (state.held && state.waiting === row.head_sha) {
      // (when the row never got the id of the check in progress, a new check run on the old commit takes its place)
      wrote = (await publishCheck(gh, repo, row, state, row.head_sha, renderStopped("superseded", { mention: cfg.slug, held: true, head: pull.headSha }), row.check_run_id === null)).wrote;
    }
    state.waiting = null;
    state.held = false;
    state.checkHash = null;
    await save({ headSha: pull.headSha, checkRunId: null, state: JSON.stringify(state), reviewed: count(wrote) });
    row.head_sha = pull.headSha;
    row.check_run_id = null;
  }

  const { settings, warnings } = await settingsOf(ctx, gh, repo);
  commands = settings.commands;
  // For the checks that say how to set the app up, and for nothing else. The default branch as GitHub names it now,
  // in the pull request it just returned; the event's payload stands in when that names none.
  const checkOptions = { entitled: true, workflowLink: workflowLinkFor(cfg, repo, pull.defaultBranch ?? repo.defaultBranch, settings) };
  if (!o.asked) {
    if (!settings.reviews.auto) return stop("automatic reviews are off", "auto-off");
    if (pull.draft && !settings.reviews.drafts) return stop("draft", "draft");
    if (!branchMatches(settings.reviews.branches, pull.baseRef)) return stop("base branch not reviewed", "branch");
  }
  // an author the settings leave out and a pause on the pull request are lifted only by someone with write access
  if (o.asked !== true) {
    if (settings.reviews.ignoreAuthors.includes(pull.author)) return stop("author not reviewed", "author");
    if (leased.paused) return stop("paused on this pull request", "paused");
  }

  // A repository hears nothing until there is something to read for it. It "speaks" once race files were read for it,
  // for a pull request that had race files or a comment itself, when it is linked to a GenClass app, when a check on
  // this commit says it waits, and always to a person who asks.
  const facts = await repoFacts(db, repo.id);
  const projectId = stored?.project_id ?? null;
  const wantProduction = !!projectId && settings.production.enabled;
  const speaks = !!o.asked || !!facts?.evidence || state.evidence !== null || row.comment_id !== null || wantProduction || state.waiting === pull.headSha;
  /**
   * Nothing to read, in a repository nothing was read for yet: no check, no comment. One exception, once per
   * repository of an installation on selected repositories: a check that says what the app reads and how to give it
   * something. It is left out where the check may fail a pull request (`check.fail_on`): "skipped" would pass.
   */
  const quiet = async (): Promise<Pass> => {
    if (settings.check.enabled && settings.check.failOn === "never" && !facts?.intro && row.check_run_id === null && (await selectionOf(ctx, inst)) === "selected") {
      if (await claimRepoFact(db, repoKey, "intro", ctx.now())) {
        const res = await publishCheck(gh, repo, row, state, pull.headSha, renderIntro({ links, settings }, checkOptions));
        await save({ checkRunId: res.id, state: JSON.stringify(state), reviewed: count(res.wrote) });
      }
    }
    return { word: "no race files", due: false };
  };
  // the cheapest look, counted against no hour: until a workflow run of this commit has finished there is no artifact to read
  if (!speaks && o.run === undefined && !(await runsOf(gh, repo, pull.headSha)).some((r) => r.completed)) return quiet();

  // the installation's hour is charged here, for a review that reads the commit's evidence, and not before
  const outside = !pull.sameRepo && !INSIDE.includes(pull.association);
  const claim = await claimReview(db, t.installationId, ctx.now(), o.push ? PUSH_REVIEWS_PER_HOUR : REVIEWS_PER_HOUR, outside);
  // what is said about the limit (the check, a reply) names the one that refused: the hour, pushes' share, outsiders' share
  if (claim === "hour") return stop(OVER_HOUR, "hour");
  if (claim === "share") return stop(OVER_PUSH, "hour-push");
  if (claim === "outside") return stop(OVER_OUTSIDE, "hour-outside");

  const ci = await ciEvidence(gh, repo.path, pull.headSha, settings, { firstRun: o.run });
  // A pause that arrived while the commit's files were read holds from here on: nothing more is written for this
  // pass. Someone with write access lifts a pause that was there when their pass began; one set since stops it too.
  if ((o.asked !== true || !leased.paused) && (await prRow(db, repo.id, number))?.paused) return stop("paused on this pull request", "paused");
  // GitHub often tells us about a push before it has created the commit's workflow runs. Where the check may fail a
  // pull request (fail_on), "no run yet" must not read as "nothing to wait for": the check waits, and the run's own
  // event finishes it. A person asking for a review gets the answer as it stands, and so does the sweep, so a
  // commit that starts no workflow at all cannot leave the check waiting for good.
  if (ci.state === "none" && ci.runs.length === 0 && settings.check.failOn !== "never" && !o.asked && !o.final) ci.state = "pending";
  const summary = summaryOf(ci.inputs, settings);
  // no race file that could be read: nothing was learned about this commit's tests
  const nothingRead = summary === null || unread(summary);
  // still nothing read for this repository: an artifact that could not be read, or files that are not race files, do
  // not end the silence (a person who asks is told what was wrong with them)
  if (!speaks && nothingRead) return quiet();
  // This commit's race files were read before and cannot be read now (an expired artifact, a download that failed):
  // what was said from them stands. "No race files" must never replace a result, least of all a failing one.
  if (nothingRead && state.evidence === pull.headSha) return { word: "race files not read again", due: false };
  // some of the commit's race files may have gone unread this time: what was read is not the whole of its evidence
  const partial = ci.incomplete;
  const merged = await mergeFindings(state, nothingRead ? null : summary, pull.headSha, { partial });
  const next = merged.state;
  const base: ReviewModel = { repo: repo.fullName, number, headSha: pull.headSha, mention: cfg.slug, ci, summary, findings: merged.view, production: null, settings, warnings, links, partial, unlisted: merged.unlisted };

  // Where the check may fail a pull request, a first read of a commit that is not whole gives no verdict, unless what
  // was read already fails the check: "neutral" passes a required check, and it would pass on race files nobody read
  // (a download that failed, an artifact that has expired). The check stays in progress with the note, recorded
  // before it exists like every check left in progress; nothing of this read is kept or commented, so the next read
  // is a first read again; and the review stays owed. A person who asks, and the sweep, end it with what can be read
  // then. (A check that would stay in progress anyway, waiting for the test run, is left to say so.)
  if (settings.check.enabled && settings.check.failOn !== "never" && partial && !o.asked && !o.final && state.evidence !== pull.headSha) {
    const verdict = renderCheck(base, checkOptions);
    if (verdict.status === "completed" && verdict.conclusion !== "failure") {
      if (!(state.held && state.waiting === pull.headSha)) {
        state.waiting = pull.headSha;
        state.held = true;
        await save({ state: JSON.stringify(state) });
      }
      const res = await publishCheck(gh, repo, row, state, pull.headSha, renderUnsettled({ ci, headSha: pull.headSha, mention: cfg.slug, settings }));
      row.check_run_id = res.id;
      await save({ checkRunId: res.id, state: JSON.stringify(state), reviewed: count(res.wrote) });
      return { word: "race files not all read", due: true };
    }
  }

  // the changed files are listed only when something needs their paths: a linked app's pages, or an inline comment
  const locations = settings.inline ? testLocations(ci.inputs) : new Map<string, TestLocation>();
  const wantInline = settings.inline && merged.view.some((f) => f.status === "new" && f.rep && f.now && !next.inline.includes(f.fp) && locations.has(f.test));
  const paths: string[] = [];
  const diff = new Map<string, [number, number][]>();
  if (wantInline || wantProduction) {
    try {
      const files = await gh.list<Obj>(`${repo.path}/pulls/${number}/files`, { max: 300, maxBytes: 4 * 1024 * 1024 });
      for (const f of files) {
        const name = str(f.filename, 400);
        if (!name || f.status === "removed") continue;
        paths.push(name);
        if (wantInline) diff.set(name, patchLines(f.patch));
      }
    } catch (e) {
      if (retryable(e)) throw e;
      ci.notes.push("The list of changed files could not be read, so nothing was matched to them.");
    }
  }
  const production = wantProduction ? await productionEvidence(db, ctx.env, projectId, paths, settings, ctx.now()).catch(() => null) : null;

  const model: ReviewModel = { ...base, production };
  const check = renderCheck(model, checkOptions);
  // the commit's runs have not all finished: its last run to finish reads again, and until then a review is owed
  const waiting = summary === null && ci.state === "pending";
  next.waiting = waiting ? pull.headSha : null;
  next.held = false;

  if (settings.check.enabled) {
    if (check.status === "in_progress") {
      // A check about to be left in progress is recorded before it exists. Whatever happens to this job after the
      // request, the row says that a check waits on this commit, and the sweep finishes it.
      if (!(state.held && state.waiting === pull.headSha)) {
        state.waiting = pull.headSha;
        state.held = true;
        await save({ state: JSON.stringify(state) });
      }
      next.held = true;
    }
    const res = await publishCheck(gh, repo, row, next, pull.headSha, check);
    row.check_run_id = res.id;
    // the row knows the check at once: a failure after this cannot lead to a second check run on the commit
    await save({ checkRunId: res.id, state: JSON.stringify({ ...state, waiting: next.waiting, held: next.held, checkHash: next.checkHash }), reviewed: count(res.wrote) });
  } else if (state.held && state.waiting === pull.headSha && row.check_run_id !== null) {
    // the check was turned off while one was in progress on this commit: that one is finished
    const res = await publishCheck(gh, repo, row, next, pull.headSha, renderStopped("check-off", { mention: cfg.slug, held: true }), false);
    await save({ state: JSON.stringify({ ...state, waiting: next.waiting, held: false, checkHash: next.checkHash }), reviewed: count(res.wrote) });
  }

  const openNow = merged.view.some((f) => f.status === "new" || f.status === "still");
  // new to the people in the pull request: a finding it has never listed. One that was listed before and is flagged
  // again (its test was not in a run, or ran once without it) is not: a deleted comment does not come back for it.
  const was = new Set(state.findings.map((f) => f.fp));
  const hasNew = merged.view.some((f) => f.status === "new" && !was.has(f.fp));
  const news = openNow || (production?.touched.length ?? 0) > 0;
  const wanted = settings.comment === "always" || (settings.comment === "findings" && (news || row.comment_id !== null));
  // the row is saved as soon as the comment exists, so a failure after it cannot lead to a second comment
  const comment = await publishComment(gh, repo, number, row, next, renderSummary(model), wanted, hasNew);
  row.comment_id = comment.id;
  await save({ commentId: comment.id, state: JSON.stringify(next), reviewed: count(comment.wrote) });

  if (wantInline) {
    const comments = inlineComments(model, next, locations, diff);
    if (comments.length) {
      for (const c of comments) next.inline.push(c.fp);
      let posted = false;
      try {
        await gh.post(`${repo.path}/pulls/${number}/reviews`, {
          commit_id: pull.headSha,
          event: "COMMENT",
          body: `GenClass flagged ${comments.length === 1 ? "a test" : `${comments.length} tests`} this pull request changes. The summary comment has the whole report.`,
          comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
        });
        posted = true;
      } catch (e) {
        if (retryable(e)) throw e;
        // a line GitHub does not accept (the diff moved): the summary comment still carries the finding
      }
      await save({ state: JSON.stringify(next), reviewed: count(posted) });
    }
  }

  // Race files were read for this repository: from now on each of its pull requests gets the check. Only race files
  // from inside the repository count for that (a branch of it, or an author GitHub calls owner, member or
  // collaborator): a fork's workflow uploads what it likes, and must not switch the check on for every pull request.
  if (!nothingRead && !facts?.evidence && !outside) await claimRepoFact(db, repoKey, "evidence", ctx.now());

  if (summary === null) return { word: waiting ? "waiting for the test run" : "no race files", due: waiting };
  if (nothingRead) return { word: "no race file could be read", due: false };
  return { word: openNow ? "findings" : "nothing flagged", due: false };
}

// --------------------------------------------------------------------------------------------- events

async function onInstallation(ctx: Ctx, p: Obj): Promise<string> {
  const i = obj(p.installation);
  const id = posInt(i.id);
  const a = obj(i.account);
  const accountId = posInt(a.id);
  const login = str(a.login, 40);
  if (!id) return "ignored";
  switch (p.action) {
    case "created":
    case "unsuspend":
    case "new_permissions_accepted":
      if (!accountId || !/^[A-Za-z0-9_-]{1,39}$/.test(login)) return "ignored";
      await upsertInstallation(ctx.db, { id, accountId, login, type: str(a.type, 20), selection: str(i.repository_selection, 10) }, ctx.now());
      return String(p.action);
    case "suspend":
      await setSuspended(ctx.db, id, true, ctx.now());
      forgetInstallation(id);
      return "suspended";
    case "deleted":
      await deleteInstallation(ctx.db, id);
      forgetInstallation(id);
      return "deleted";
    default:
      return "ignored";
  }
}

async function onInstallationRepositories(ctx: Ctx, p: Obj): Promise<string> {
  const id = installationIdOf(p);
  if (!id) return "ignored";
  const sel = str(p.repository_selection, 10);
  if (sel) await ctx.db.prepare("UPDATE github_installations SET selection = ?, updated = ? WHERE id = ?").bind(sel === "all" ? "all" : "selected", ctx.now().toISOString(), id).run();
  const removed = (Array.isArray(p.repositories_removed) ? p.repositories_removed : []).map((r) => posInt(obj(r).id)).filter((x): x is number => x !== null);
  if (removed.length) {
    await removeRepos(ctx.db, id, removed);
    for (const r of removed) settingsCache.delete(r);
  }
  return removed.length ? "repositories removed" : "ok";
}

async function onPullRequest(ctx: Ctx, p: Obj): Promise<string> {
  const repo = repoOf(p);
  const installationId = installationIdOf(p);
  const pull = obj(p.pull_request);
  const number = posInt(pull.number) ?? posInt(p.number);
  if (!repo || !installationId || !number) return "ignored";
  const action = str(p.action, 30);
  if (action === "closed") {
    if (!(await prRow(ctx.db, repo.id, number))) return "closed";
    // GitHub is asked whether the pull request is closed now: an old `closed` delivery must not close one that was
    // reopened since. Under the lease, so a check left in progress on its head commit is finished with it.
    const word = await reviewPull(ctx, { installationId, repo, number }, { closing: true });
    // the pass that found it merged decided about the issue (`issues: merge`), under the lease
    if (word === NOT_CLOSED || word === ISSUE_OPENED) return word;
    // Where GitHub could not be asked (paused, suspended, a private repository without a plan, a limit, a review
    // that is running), the event is taken at its word, for the row only. No issue is opened from a payload: a review
    // that is running goes round once more and finds the pull request merged, one that an hourly limit stopped is
    // owed and the sweep runs it, and for the rest (paused, no plan, the pull request's limit) there is none.
    if (word !== "closed") await closePr(ctx.db, repo.id, number, ctx.now());
    return "closed";
  }
  if (action === "converted_to_draft") {
    // nothing new to review. A check or comment that waits for the commit's test run is told at once when drafts are
    // not reviewed here (the pass stops at that setting and finishes the check); otherwise the event is nothing to act on
    const row = await prRow(ctx.db, repo.id, number);
    if (!row || parseState(row.state).waiting === null) return "ignored";
    return reviewPull(ctx, { installationId, repo, number });
  }
  if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(action)) return "ignored";
  return reviewPull(ctx, { installationId, repo, number }, { pull, push: true });
}

/**
 * Review several pull requests of one event in turn. When the job's time runs out before the last of them, the rest
 * are left owed (the sweep reviews them) and the job fails, so that its delivery can be redelivered.
 */
async function reviewEach(ctx: Ctx, installationId: number, repo: RepoRef, numbers: number[], o: ReviewOptions): Promise<string> {
  let outcome = "ok";
  for (let i = 0; i < numbers.length; i++) {
    if (i > 0 && timeLeft(ctx) < PASS_MS) {
      for (const n of numbers.slice(i)) await setDue(ctx.db, repo.id, n, ctx.now().toISOString()).catch(() => undefined);
      throw timeUp();
    }
    outcome = await reviewPull(ctx, { installationId, repo, number: numbers[i]! }, o);
  }
  return outcome;
}

/**
 * The fingerprints of the findings that issues the app opened in this repository already list. Open and closed issues
 * both count: one that someone closed (an overwrite that is intended, say) must not be opened again by the next pull
 * request that merges. Only the app's own issues count, whatever GitHub's `creator` filter let through: anyone can
 * write a marker into an issue of theirs. The newest 300 are looked at.
 */
async function filedFindings(gh: GithubClient, repo: RepoRef, slug: string): Promise<Set<string>> {
  const bot = `${slug}[bot]`.toLowerCase();
  const listed = await gh.list<Obj>(`${repo.path}/issues`, { query: { state: "all", creator: `${slug}[bot]` }, max: 300, maxBytes: 4 * 1024 * 1024 });
  const out = new Set<string>();
  for (const i of listed) {
    if (i.pull_request || str(obj(i.user).login, 60).toLowerCase() !== bot) continue;
    for (const fp of issueFingerprints(i.body)) out.add(fp);
  }
  return out;
}

/**
 * `issues: merge`: one issue for a pull request that merged with reproducible findings flagged in the race files of
 * the commit that merged. Called by the review pass that finds the pull request merged (reviewOnce), so it runs under
 * the pull request's lease, on the row as that pass took it, whichever event got there first: `closed`, or the end of
 * the last push's test run.
 * - Never for a paused pull request (a pass over a paused repository does not get here), and once per pull request.
 * - The stored findings count only when they were worked out from the merged commit's race files. When they are an
 *   older commit's (the last push's test run was not read before the merge), that commit's race files are read first.
 *   With no race files to read no issue is opened.
 * - Reading at the merge follows the review settings: for a pull request an automatic review leaves out
 *   (`reviews.auto` off, its base branch not in `reviews.branches`, its author in `reviews.ignore_authors`) nothing
 *   is read or counted at the merge either. Such a pull request gets an issue only from findings a person had read
 *   for the merged commit while it was open.
 * - While the merged commit's workflow runs do not exist yet (a merge straight after the push) or have not all
 *   finished, nothing is decided, also when some of its race files were read before: the events of the runs still to
 *   end will find the pull request closed. The review stays owed, and the sweep (`o.final`) decides with what there is
 *   then: it reads the commit's race files again, and when none can be read, what was read before stands.
 * - A finding that an issue the app opened here already lists is left out: the same finding is in every pull
 *   request's race files until someone fixes it, and one issue is enough. When those issues cannot be listed, none is
 *   opened.
 * - One pull request at a time lists and opens in a repository (takeIssueTurn). Two that merge together with the same
 *   finding would each find no issue for it. The one that has to wait is owed its review, and the sweep decides
 *   it when the list shows what the first one opened.
 * `o.run`: the workflow run whose end started the pass, if one did. `o.final`: the pass is the sweep's.
 */
async function issueOnMerge(ctx: Ctx, t: ReviewTarget, gh: GithubClient, leased: PrRow, state: PrState, pull: Pull, o: { run?: number; final: boolean }): Promise<Pass> {
  const { db, cfg } = ctx;
  const { repo, number } = t;
  const closed: Pass = { word: "closed", due: false };
  if (leased.issue !== null || leased.paused) return closed;
  const short = pull.headSha.slice(0, 7);
  /** Reproducible findings flagged in the merged commit's race files, by a state worked out from those files. */
  const flagged = (s: PrState): StoredFinding[] => (s.evidence === pull.headSha ? s.findings.filter((f) => (f.status === "new" || f.status === "still") && f.rep && f.last === short) : []);
  const { settings } = await settingsOf(ctx, gh, repo);
  if (settings.issues !== "merge") return closed;
  /** Still owed: nothing is decided now, and the sweep comes back to it. */
  const owed: Pass = { word: "closed", due: true };
  // the stored findings are the merged commit's (else an older commit's, or none: an issue must not say those of it)
  const stored = state.evidence === pull.headSha;
  // The merged commit's race files are read only for a pull request an automatic review would have read. Where the
  // settings leave it out, nothing was read for it while it was open (unless a person asked), and nothing is read or
  // counted for it at the merge.
  const reads = settings.reviews.auto && branchMatches(settings.reviews.branches, pull.baseRef) && !settings.reviews.ignoreAuthors.includes(pull.author);
  if (!stored && !reads) return closed;
  let current = state;
  if (reads && (!stored || o.final)) {
    const outside = !pull.sameRepo && !INSIDE.includes(pull.association);
    if ((await claimReview(db, t.installationId, ctx.now(), REVIEWS_PER_HOUR, outside)) !== "ok") return owed;
    const ci = await ciEvidence(gh, repo.path, pull.headSha, settings, { firstRun: o.run });
    // The commit's runs do not exist yet, or one is still going: race files may still come, and the events of those
    // runs find the pull request closed. Nothing is decided from a part, and nothing of it is kept.
    if (!o.final && (ci.unfinished || ci.runs.length === 0)) return owed;
    const summary = summaryOf(ci.inputs, settings);
    if (summary !== null && !unread(summary)) {
      current = (await mergeFindings(state, summary, pull.headSha, { partial: ci.incomplete })).state;
      await savePr(db, repo.id, number, { state: JSON.stringify(current) }, ctx.now());
    } else if (!stored) return closed;
    // (no race file can be read now, and the commit's were read before: what they said stands)
  } else if (reads && (await runsOf(gh, repo, pull.headSha)).some((r) => !r.completed)) {
    // The commit's race files were read while the pull request was open, and one of its runs is still going: what
    // was read may be a part (one workflow's files, while another's test run has not ended).
    return owed;
  }
  const left = flagged(current);
  if (!left.length) return closed;
  const turn = await takeIssueTurn(db, { repoId: repo.id, installationId: t.installationId }, ctx.now());
  if (!turn) return { word: "closed", due: true };
  let sent = false;
  let made: number | null = null;
  try {
    const filed = await filedFindings(gh, repo, cfg.slug);
    const fresh = left.filter((f) => !filed.has(f.fp));
    if (fresh.length) {
      const issue = renderIssue(fresh, { repo: repo.fullName, number, headSha: pull.headSha, mention: cfg.slug, links: linksOf(cfg), merged: true });
      sent = true;
      made = posInt(obj(await gh.post(`${repo.path}/issues`, issue)).number);
    }
  } catch (e) {
    // GitHub could not be reached: the pass fails and is run again (an issue that was made after all is found by its
    // markers then). Anything else (issues are turned off in the repository, the list is too large): no issue.
    if (retryable(e)) throw e;
  } finally {
    // Nothing was sent: the turn goes back at once. After a request to open an issue it is kept until it runs out, so
    // that the next pull request to look finds the issue in GitHub's list.
    if (!sent) await releaseIssueTurn(db, repo.id, turn).catch(() => undefined);
  }
  if (!made) return closed;
  await savePr(db, repo.id, number, { issue: made, reviewed: true }, ctx.now());
  return { word: ISSUE_OPENED, due: false };
}

async function onWorkflowRun(ctx: Ctx, p: Obj): Promise<string> {
  if (p.action !== "completed") return "ignored";
  const repo = repoOf(p);
  const installationId = installationIdOf(p);
  const run = obj(p.workflow_run);
  const sha = str(run.head_sha, 64);
  const runId = posInt(run.id);
  if (!repo || !installationId || !runId || !/^[0-9a-f]{40,64}$/.test(sha)) return "ignored";
  // the pull requests this commit is the head of: the ones already seen (stored when they opened or were pushed to)
  const rows = await prsAtSha(ctx.db, repo.id, sha);
  const numbers = new Set(rows.map((r) => r.number));
  for (const pr of Array.isArray(run.pull_requests) ? run.pull_requests.slice(0, 5) : []) {
    const n = posInt(obj(pr).number);
    if (n && str(obj(obj(pr).head).sha, 64) === sha) numbers.add(n);
  }
  if (!numbers.size) return "no pull request at this commit";
  const inst = await installationFor(ctx, installationId, repo);
  if (!inst || inst.suspended) return "suspended";
  // pull requests whose check or comment says it waits for this commit's test run, and those whose check is in progress
  const waiting = rows.filter((r) => parseState(r.state).waiting === sha).map((r) => r.number);
  const held = rows.filter((r) => parseState(r.state).held && parseState(r.state).waiting === sha).map((r) => r.number);
  // A paused repository and a private one without a plan are not read. A check left in progress there is finished
  // (reviewPull reads nothing for it either); everything else is left alone.
  const stopped = (await repoById(ctx.db, repo.id))?.paused ? "paused" : (await repoEntitled(ctx.db, ctx.env, ctx.cfg, inst, repo, ctx.now())).ok ? null : "private repository without a plan";
  if (stopped) {
    if (held.length) await reviewEach(ctx, installationId, repo, held, {});
    return stopped;
  }
  // A commit has many workflow runs, and a review is not started for each. One request says whether this run uploaded
  // race files: then the review reads them. When it did not, only a pull request that waits is looked at, and only once
  // the commit's other runs have finished too (one more request), so that the wait is ended once, by its last run.
  const gh = installationClient(ctx.cfg, ctx.f, ctx.now, installationId, repo.id);
  const { settings } = await settingsOf(ctx, gh, repo).catch(async (e: unknown) => {
    // The settings could not be read, so which artifact holds the race files is not known and nothing is done now.
    // The pull requests at this commit are owed their review: the sweep runs it if no event does first.
    for (const r of rows) if (r.due === null) await setDue(ctx.db, repo.id, r.number, ctx.now().toISOString()).catch(() => undefined);
    throw e;
  });
  const listed = obj(await gh.get(`${repo.path}/actions/runs/${runId}/artifacts`, { query: { per_page: 50 } }));
  const has = (Array.isArray(listed.artifacts) ? listed.artifacts : []).some((a) => str(obj(a).name, 100).startsWith(settings.artifact) && obj(a).expired !== true);
  if (has) return reviewEach(ctx, installationId, repo, [...numbers].slice(0, 5), { run: runId });
  if (!waiting.length) return "no race files in this run";
  if ((await runsOf(gh, repo, sha)).some((r) => r.id !== runId && !r.completed)) return "waiting for the test run";
  return reviewEach(ctx, installationId, repo, waiting, {});
}

async function onCheckRun(ctx: Ctx, p: Obj): Promise<string> {
  if (p.action !== "rerequested") return "ignored";
  const repo = repoOf(p);
  const installationId = installationIdOf(p);
  const check = obj(p.check_run);
  if (!repo || !installationId || String(obj(check.app).id ?? "") !== ctx.cfg.appId) return "ignored";
  const sha = str(check.head_sha, 64);
  const rows = await prsAtSha(ctx.db, repo.id, sha);
  if (!rows.length) return "no pull request at this commit";
  return reviewEach(ctx, installationId, repo, rows.map((r) => r.number), { asked: true });
}

async function onComment(ctx: Ctx, p: Obj): Promise<string> {
  if (p.action !== "created") return "ignored";
  const issue = obj(p.issue);
  if (!issue.pull_request) return "not a pull request";
  const comment = obj(p.comment);
  const user = obj(comment.user);
  // never answer a bot (itself included): two bots must not be able to talk to each other
  if (user.type === "Bot" || obj(p.sender).type === "Bot" || str(user.login, 60).endsWith("[bot]") || str(comment.body, 200).includes(REPLY_MARKER)) return "bot";
  const cmd = parseCommand(comment.body, ctx.cfg.slug);
  if (!cmd) return "no command";
  const repo = repoOf(p);
  const installationId = installationIdOf(p);
  const number = posInt(issue.number);
  const commentId = posInt(comment.id);
  const login = githubLogin(user.login);
  if (!repo || !installationId || !number || !commentId || !login) return "ignored";
  if (issue.state !== "open") return "closed";

  const inst = await installationFor(ctx, installationId, repo);
  if (!inst || inst.suspended) return "suspended";
  if ((await repoById(ctx.db, repo.id))?.paused) return "paused";
  if (!(await repoEntitled(ctx.db, ctx.env, ctx.cfg, inst, repo, ctx.now())).ok) return "private repository without a plan";
  const gh = installationClient(ctx.cfg, ctx.f, ctx.now, installationId, repo.id);
  const { settings } = await settingsOf(ctx, gh, repo);
  if (!settings.commands) return "commands are off";

  // Who is asking, by GitHub's answer to the question itself: this person's permission on this repository. The
  // association the event carries is not used: it calls a member of the organization whose membership is private
  // (GitHub's default) a contributor, and it calls a member who can only read a member.
  const author = posInt(user.id) !== null && posInt(user.id) === posInt(obj(issue.user).id);
  const needsWrite = NEEDS_WRITE.includes(cmd.name);
  let write = false;
  // the author may use review, replay and help without write access; for `review`, having it decides what the review lifts
  if (needsWrite || !author || cmd.name === "review") {
    try {
      const perm = str(obj(await gh.get(`${repo.path}/collaborators/${login}/permission`)).permission, 20);
      write = perm === "admin" || perm === "write";
    } catch (e) {
      // GitHub does not know this person on the repository: no access
      if (!(e instanceof GithubError && e.kind === "not_found")) throw e;
    }
  }
  if (!write && (needsWrite || !author)) return "not allowed";

  const row = (await prRow(ctx.db, repo.id, number)) ?? null;
  if (row && row.reviews >= REVIEWS_PER_PR) return "over the pull request's budget";
  // seen: the reaction is the only acknowledgement a command gets besides its result
  await gh.post(`${repo.path}/issues/comments/${commentId}/reactions`, { content: "eyes" }).catch(() => undefined);

  const links = linksOf(ctx.cfg);
  const say = async (body: string): Promise<void> => {
    await gh.post(`${repo.path}/issues/${number}/comments`, { body });
    if (row) await savePr(ctx.db, repo.id, number, { reviewed: true }, ctx.now());
  };
  const state = parseState(row?.state);

  if (cmd.name === "help") {
    await say(renderHelp(ctx.cfg.slug, links));
    return "help";
  }
  if (cmd.name === "review") {
    // from the author without write access, a pause on the pull request and `reviews.ignore_authors` still hold
    const word = await reviewPull(ctx, { installationId, repo, number }, { asked: write ? true : "author" });
    // a person who asks always gets an answer: when a limit for this hour stopped the review, a reply says which
    const over = HOUR_LIMITS.get(word);
    if (over) await say(renderOverLimit({ ...over, after: hourEnd(ctx.now()) }));
    return word;
  }
  if (cmd.name === "pause" || cmd.name === "resume") {
    // a pull request not seen before gets its row (made by the lease, which is let go at once with nothing owed)
    if (!row) await takeLease(ctx.db, { repoId: repo.id, number, installationId }, ctx.now()).then((made) => (made ? releaseLease(ctx.db, repo.id, number, { lease: made.lease, due: null }) : 0));
    const paused = cmd.name === "pause";
    // A column of its own, written in one statement: a review that is running cannot undo it when it saves, and the
    // findings that review saves are not written over by a copy read before it.
    await savePr(ctx.db, repo.id, number, { paused }, ctx.now());
    await say(`${REPLY_MARKER}\n${paused ? `Paused: this pull request is not updated until someone with write access replies \`@${ctx.cfg.slug} resume\`.` : "Resumed: the next push or test run updates this pull request again."}\n`);
    // Paused: a check that waits for the test run is told so now, not left waiting, and a review that is running is
    // told too (it goes round once more and stops at the pause). Resumed: what the pause skipped is read now, under
    // the repository's settings as for any push. The command itself is done either way: a failure here leaves the
    // review owed, it does not run the command again.
    const cur = await prRow(ctx.db, repo.id, number);
    const running = !!cur?.lease && cur.lease >= ctx.now().toISOString();
    if (!paused || running || parseState(cur?.state).waiting !== null) await reviewPull(ctx, { installationId, repo, number }).catch(() => undefined);
    return paused ? "paused" : "resumed";
  }

  if (NEEDS_FINDING.includes(cmd.name)) {
    const numbers = state.findings.map((f) => f.n).sort((a, b) => a - b);
    const f = cmd.n === null && numbers.length === 1 ? state.findings[0] : state.findings.find((x) => x.n === cmd.n);
    if (!f) {
      await say(`${REPLY_MARKER}\n${numbers.length ? `There is no finding ${cmd.n ?? "with that number"} on this pull request. Its findings are numbered ${numbers.slice(0, 30).join(", ")}: name one, as in \`@${ctx.cfg.slug} ${cmd.name} ${numbers[0]}\`.` : "No finding is recorded for this pull request yet. Findings come from the race files its test run uploads."}\n`);
      return "no such finding";
    }
    const at = { repo: repo.fullName, number, headSha: row?.head_sha ?? "", mention: ctx.cfg.slug, links };
    if (cmd.name === "replay") {
      await say(renderReplay(f, at));
      return "replay";
    }
    if (cmd.name === "issue") {
      const issueBody = renderIssue([f], { ...at, merged: false });
      const made = posInt(obj(await gh.post(`${repo.path}/issues`, issueBody)).number);
      await say(`${REPLY_MARKER}\n${made ? `Opened #${made} for finding ${f.n}.` : `The issue for finding ${f.n} could not be opened.`}\n`);
      return "issue";
    }
    // fix: never for a fork's branch (an agent workflow would run that fork's code with this repository's secrets)
    const pull = pullOf(obj(await gh.get(`${repo.path}/pulls/${number}`)), repo);
    if (!pull?.sameRepo) {
      await say(`${REPLY_MARKER}\nA fix brief is only written for branches of this repository. This pull request comes from a fork, and an agent workflow started from here would run the fork's code with this repository's secrets. A maintainer can check the branch out and run the agent on their own machine: \`@${ctx.cfg.slug} replay ${f.n}\` has the steps.\n`);
      return "fix refused for a fork";
    }
    await say(renderFixBrief(f, { ...at, headSha: pull.headSha, asker: login }));
    return "fix brief";
  }
  return "ignored";
}

async function onMarketplace(ctx: Ctx, p: Obj): Promise<string> {
  const mp = obj(p.marketplace_purchase);
  const account = obj(mp.account);
  const plan = obj(mp.plan);
  const accountId = posInt(account.id);
  const login = str(account.login, 40);
  const planId = posInt(plan.id);
  if (!accountId || !/^[A-Za-z0-9_-]{1,39}$/.test(login)) return "ignored";
  const cents = typeof plan.monthly_price_in_cents === "number" && plan.monthly_price_in_cents >= 0 ? Math.floor(plan.monthly_price_in_cents) : 0;
  const trial = typeof mp.free_trial_ends_on === "string" && Number.isFinite(Date.parse(mp.free_trial_ends_on)) ? new Date(Date.parse(mp.free_trial_ends_on)).toISOString() : null;
  switch (p.action) {
    case "purchased":
    case "changed":
      if (!planId) return "ignored";
      await setMarketplace(ctx.db, { accountId, login, planId, planName: str(plan.name, 80) || "plan", monthlyCents: cents, unitCount: posInt(mp.unit_count), freeTrialEnds: trial, pending: null }, ctx.now());
      return String(p.action);
    case "cancelled":
      await deleteMarketplace(ctx.db, accountId);
      return "cancelled";
    case "pending_change":
      await setMarketplacePending(ctx.db, accountId, JSON.stringify({ plan_id: planId, plan_name: str(plan.name, 80), effective: str(p.effective_date, 40) }), ctx.now());
      return "pending change";
    case "pending_change_cancelled":
      await setMarketplacePending(ctx.db, accountId, null, ctx.now());
      return "pending change cancelled";
    default:
      return "ignored";
  }
}

// --------------------------------------------------------------------------------------------- the sweep

/**
 * Every 20 minutes (SWEEP_CRON) and with the daily cron (index.ts): the reviews that are owed. A pull request is due
 * while a review of it started and has not ended (the platform stopped the job), after one that failed or could not
 * run (GitHub's rate limit, an hourly limit, no time left), and while its check or comment says it waits for the
 * commit's test run. Each one due for more than DUE_AFTER_MS is reviewed once here, as `final`: a wait that nothing
 * ended is ended with what there is. This is what makes it certain that a check left in progress is finished.
 * One run looks at SWEEP_ROWS pull requests at most, the longest due first, so that it stays inside what the platform
 * lets one invocation do; the rest wait for the next run. It ends at the first failure that is not GitHub's answer
 * (the database, a limit of the platform): the rows after it would fail the same way, and a statement that fails
 * straight after a write to GitHub loses the id of what was written. Returns how many pull requests were looked at.
 */
export async function githubSweep(env: Env, o: { now?: () => Date; fetch?: Fetch } = {}): Promise<number> {
  const cfg = githubApp(env);
  const db = env.DB;
  if (!cfg || !db) return 0;
  const now = o.now ?? (() => new Date());
  const f: Fetch = o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const started = now().getTime();
  let looked = 0;
  for (const row of await duePrs(db, new Date(started - DUE_AFTER_MS), now(), SWEEP_ROWS)) {
    if (now().getTime() - started > SWEEP_MS) break;
    looked++;
    // looked at now: whatever happens below, the row goes to the back of the line
    const again = now().toISOString();
    try {
      const inst = await installationById(db, row.installation_id);
      if (!inst) {
        await setDue(db, row.repo_id, row.number, null);
        continue;
      }
      if (inst.suspended) {
        await setDue(db, row.repo_id, row.number, again);
        continue;
      }
      // The repository's name and visibility are not kept: GitHub names it in its answer to a token request for it.
      const minted = obj(await appClient(cfg, f, now, 2).post(`/app/installations/${row.installation_id}/access_tokens`, { repository_ids: [row.repo_id] }));
      const repo = repoOf({ repository: (Array.isArray(minted.repositories) ? minted.repositories : []).find((r) => posInt(obj(r).id) === row.repo_id) });
      if (!repo) {
        await setDue(db, row.repo_id, row.number, again);
        continue;
      }
      const word = await reviewPull(jobContext({ env, db, cfg, f, now }, now().getTime()), { installationId: row.installation_id, repo, number: row.number }, { final: true });
      // a review that ran settled the row itself; these did not get that far
      if (word === "paused" || word === "unknown installation") await setDue(db, row.repo_id, row.number, null);
      else if (word === "busy" || word === "suspended") await setDue(db, row.repo_id, row.number, again);
    } catch (e) {
      // GitHub gives no token for it: the repository left the installation, or the installation is gone. Nothing is
      // owed any more. Anything else is tried again by a later sweep.
      const gone = e instanceof GithubError && (e.kind === "not_found" || e.kind === "validation");
      await setDue(db, row.repo_id, row.number, gone ? null : again).catch(() => undefined);
      // not GitHub's answer: this run ends here, and what it did not look at stays due as it was
      if (!(e instanceof GithubError)) break;
    }
  }
  return looked;
}

/** Handle one verified webhook event. Returns a short word for what happened (the delivery's answer, and the tests). */
export async function handleEvent(ctx: Ctx, event: string, payload: unknown): Promise<string> {
  const p = obj(payload);
  switch (event) {
    case "ping":
      return "pong";
    case "installation":
      return onInstallation(ctx, p);
    case "installation_repositories":
      return onInstallationRepositories(ctx, p);
    case "pull_request":
      return onPullRequest(ctx, p);
    case "workflow_run":
      return onWorkflowRun(ctx, p);
    case "check_run":
      return onCheckRun(ctx, p);
    case "issue_comment":
      return onComment(ctx, p);
    case "marketplace_purchase":
      return onMarketplace(ctx, p);
    default:
      // github_app_authorization (nothing of a person's authorization is kept), and anything not subscribed to
      return "ignored";
  }
}
