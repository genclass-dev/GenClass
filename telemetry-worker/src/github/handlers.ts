// What genclass[bot] does when GitHub tells it something happened: the webhook events, one function each, and the
// review of one pull request (reviewPull).
//
// Invariants:
// - The app acts only inside an installation, on the repository an event is about, and only in answer to an event
//   from GitHub that passed the signature check (src/github/http.ts). It never opens a pull request, never comments
//   on a repository it is not installed on, and never @mentions anyone.
// - A review reads: the pull request's own fields, the repository's settings file on its default branch, the workflow
//   runs and artifacts of the head commit and, only when needed, the list of changed files. It never reads file
//   contents, and of a file's patch it keeps the line ranges only.
// - It writes at most: one check run per head commit, one summary comment per pull request (edited in place), one
//   review with inline comments per new reproducible finding, and one reply per command. An unchanged result is not
//   written again (body hashes in the pull request's state).
// - Commands are taken only from people GitHub says have write access (for review, replay and help: also the pull
//   request's author), never from bots, and `fix` never for a pull request from a fork (an agent workflow would run
//   that fork's code with the repository's secrets).
// - A private repository without a plan that includes it is not read (src/github/entitlement.ts).
// - One review at a time per pull request (the lease), at most REVIEWS_PER_HOUR per installation and REVIEWS_PER_PR
//   per pull request; a rate limit from GitHub ends the job quietly and the next event tries again.
// - Nothing from GitHub is logged except a short outcome word per delivery.

import type { Env } from "../collector.js";
import type { D1Like } from "../dashboard.js";
import { forgetInstallation, GithubError, installationClient, posInt, repoPath, type Fetch, type GithubClient } from "./api.js";
import { NEEDS_FINDING, NEEDS_WRITE, parseCommand } from "./commands.js";
import type { GithubAppConfig } from "./config.js";
import { repoEntitled } from "./entitlement.js";
import { ciEvidence, productionEvidence, type CiEvidence } from "./evidence.js";
import {
  CHECK_NAME,
  inlineComments,
  mergeFindings,
  parseState,
  patchLines,
  renderCheck,
  renderFixBrief,
  renderHelp,
  renderIssue,
  renderReplay,
  renderSummary,
  REPLY_MARKER,
  sha256Hex,
  summaryOf,
  testLocations,
  type PrState,
  type ReviewLinks,
  type ReviewModel,
  type TestLocation,
} from "./review.js";
import { branchMatches, readSettings, SETTINGS_PATH, type RepoSettings } from "./settings.js";
import {
  claimReview,
  closePr,
  deleteInstallation,
  deleteMarketplace,
  installationById,
  prRow,
  prsAtSha,
  releaseLease,
  removeRepos,
  repoById,
  REVIEWS_PER_PR,
  savePr,
  setMarketplace,
  setMarketplacePending,
  setSuspended,
  takeLease,
  touchRepo,
  upsertInstallation,
  type Installation,
  type PrRow,
} from "./store.js";

export interface Ctx {
  env: Env;
  db: D1Like;
  cfg: GithubAppConfig;
  f: Fetch;
  now: () => Date;
}

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
}

function repoOf(p: Obj): RepoRef | null {
  const r = obj(p.repository);
  const id = posInt(r.id);
  const path = repoPath(r.full_name);
  if (!id || !path) return null;
  const o = obj(r.owner);
  const ownerId = posInt(o.id);
  const login = str(o.login, 40);
  return { id, fullName: String(r.full_name), path, private: r.private !== false, owner: ownerId && /^[A-Za-z0-9-]{1,39}$/.test(login) ? { id: ownerId, login, type: str(o.type, 20) } : null };
}

const installationIdOf = (p: Obj): number | null => posInt(obj(p.installation).id);

/** The installation an event is about; recorded from the event itself when its `created` event never arrived. */
async function installationFor(ctx: Ctx, id: number, repo: RepoRef | null): Promise<Installation | null> {
  const known = await installationById(ctx.db, id);
  if (known || !repo?.owner) return known;
  await upsertInstallation(ctx.db, { id, accountId: repo.owner.id, login: repo.owner.login, type: repo.owner.type, selection: "selected" }, ctx.now());
  return installationById(ctx.db, id);
}

// --------------------------------------------------------------------------------------------- settings

const SETTINGS_TTL_MS = 120_000;
const settingsCache = new Map<number, { exp: number; text: string | null }>();
/** Drops cached settings files (tests). */
export const resetSettingsCache = (): void => settingsCache.clear();

/** The repository's settings file on its default branch (cached two minutes per isolate), parsed. */
async function settingsOf(ctx: Ctx, gh: GithubClient, repo: RepoRef): Promise<{ settings: RepoSettings; warnings: string[] }> {
  const nowMs = ctx.now().getTime();
  const hit = settingsCache.get(repo.id);
  if (hit && hit.exp > nowMs) return readSettings(hit.text);
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
    }
  } catch (e) {
    if (e instanceof GithubError && (e.kind === "rate_limited" || e.kind === "unauthorized" || e.kind === "budget")) throw e;
    tooLarge = e instanceof GithubError && e.kind === "too_large";
    // no file, or the app was not given the single-file permission: the defaults
  }
  if (settingsCache.size > 2000) settingsCache.clear();
  settingsCache.set(repo.id, { exp: nowMs + SETTINGS_TTL_MS, text });
  const out = readSettings(text);
  if (tooLarge) out.warnings.push(`${SETTINGS_PATH} is too large to read; the defaults are used.`);
  return out;
}

// --------------------------------------------------------------------------------------------- publishing

function retryable(e: unknown): boolean {
  return e instanceof GithubError && (e.kind === "rate_limited" || e.kind === "unauthorized" || e.kind === "budget" || e.kind === "network" || e.kind === "server");
}

/** Create or update the check run on `headSha`. Returns its id (null when it could not be written). */
async function publishCheck(gh: GithubClient, repo: RepoRef, row: PrRow, state: PrState, headSha: string, out: ReturnType<typeof renderCheck>): Promise<number | null> {
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
  if (same && state.checkHash === hash) return row.check_run_id;
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
  if (id === null) id = posInt(obj(await gh.post(`${repo.path}/check-runs`, body)).id);
  state.checkHash = hash;
  return id;
}

/**
 * Create or update the summary comment. Returns its id, or null when there is none now. A comment someone deleted is
 * written again only when there is a new finding to tell them about.
 */
async function publishComment(gh: GithubClient, repo: RepoRef, number: number, row: PrRow, state: PrState, body: string | null, wanted: boolean, hasNew: boolean): Promise<number | null> {
  if (body === null || !wanted) return row.comment_id;
  const hash = (await sha256Hex(body)).slice(0, 32);
  if (row.comment_id !== null) {
    if (state.commentHash === hash) return row.comment_id;
    try {
      await gh.patch(`${repo.path}/issues/comments/${row.comment_id}`, { body });
      state.commentHash = hash;
      return row.comment_id;
    } catch (e) {
      if (!(e instanceof GithubError && e.kind === "not_found")) throw e;
      state.commentHash = null;
      state.commentDeleted = true;
    }
  }
  if (state.commentDeleted && !hasNew) return null;
  const id = posInt(obj(await gh.post(`${repo.path}/issues/${number}/comments`, { body })).id);
  state.commentHash = id ? hash : null;
  if (id) state.commentDeleted = false;
  return id;
}

// --------------------------------------------------------------------------------------------- the review

export interface ReviewTarget {
  installationId: number;
  repo: RepoRef;
  number: number;
}

export interface ReviewOptions {
  /** The pull request as a webhook payload carried it (saves one request on the first pass). */
  pull?: Obj;
  /** A person asked for it: run even when automatic reviews are off, a draft, or paused on the pull request. */
  asked?: boolean;
}

interface Pull {
  open: boolean;
  merged: boolean;
  draft: boolean;
  headSha: string;
  baseRef: string;
  author: string;
  /** The head branch lives in this repository (not a fork). */
  sameRepo: boolean;
}

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
    sameRepo: posInt(obj(head.repo).id) === repo.id,
  };
}

/**
 * Review one pull request: read its evidence, fold it into the stored findings, and write what changed. Returns a
 * short word for what happened. Throws GithubError when GitHub could not be reached or refused (the caller forgets
 * the delivery so a redelivery tries again).
 */
export async function reviewPull(ctx: Ctx, t: ReviewTarget, o: ReviewOptions = {}): Promise<string> {
  const { db } = ctx;
  const inst = await installationFor(ctx, t.installationId, t.repo);
  if (!inst) return "unknown installation";
  if (inst.suspended) return "suspended";
  const stored = await repoById(db, t.repo.id);
  if (stored) await touchRepo(db, { repoId: t.repo.id, installationId: t.installationId, fullName: t.repo.fullName, private: t.repo.private }, ctx.now());
  if (stored?.paused) return "paused";

  let row = await takeLease(db, { repoId: t.repo.id, number: t.number, installationId: t.installationId }, ctx.now());
  if (!row) return "busy";
  let outcome = "nothing";
  try {
    for (let pass = 0; pass < 3 && row; pass++) {
      if (row.reviews >= REVIEWS_PER_PR) {
        outcome = "over the pull request's budget";
        break;
      }
      if (!(await claimReview(db, t.installationId, ctx.now()))) {
        outcome = "over the hourly budget";
        break;
      }
      outcome = await reviewOnce(ctx, t, inst, stored?.project_id ?? null, row, pass === 0 ? o : { asked: o.asked });
      // something arrived while this pass ran: once more, from the pull request's current state
      const again = await releaseLease(db, t.repo.id, t.number);
      row = again ? await takeLease(db, { repoId: t.repo.id, number: t.number, installationId: t.installationId }, ctx.now()) : null;
    }
  } finally {
    if (row) await releaseLease(db, t.repo.id, t.number).catch(() => undefined);
  }
  return outcome;
}

async function reviewOnce(ctx: Ctx, t: ReviewTarget, inst: Installation, projectId: string | null, row: PrRow, o: ReviewOptions): Promise<string> {
  const { db, cfg } = ctx;
  const { repo, number } = t;
  const state = parseState(row.state);

  const entitled = await repoEntitled(db, ctx.env, cfg, inst, repo, ctx.now());
  const gh = installationClient(cfg, ctx.f, ctx.now, t.installationId, repo.id);

  // nothing of a private repository without a plan is read: only an event that carried the pull request goes on, to say why
  if (!entitled.ok && !o.pull) return "private repository without a plan";
  const pull = pullOf(o.pull ?? obj(await gh.get(`${repo.path}/pulls/${number}`)), repo);
  if (!pull) return "unreadable pull request";
  if (!pull.open) {
    await closePr(db, repo.id, number, ctx.now());
    return "closed";
  }
  // reopened: its row counts as open again (workflow runs find it, the sweep leaves it)
  if (row.closed) await savePr(db, repo.id, number, { closed: null }, ctx.now());
  // a check run belongs to one commit: the stored one is this commit's, or there is none yet
  const ownCheck = row.head_sha === pull.headSha ? row.check_run_id : null;
  const links = linksOf(cfg);

  if (!entitled.ok) {
    const empty: CiEvidence = { state: "none", runs: [], artifacts: [], inputs: [], notes: [] };
    const model: ReviewModel = { repo: repo.fullName, number, headSha: pull.headSha, mention: cfg.slug, ci: empty, summary: null, findings: [], production: null, settings: readSettings(null).settings, warnings: [], links };
    const check = await publishCheck(gh, repo, row, state, pull.headSha, renderCheck(model, { entitled: false, plansUrl: `${cfg.origin}/github#plans` }));
    await savePr(db, repo.id, number, { headSha: pull.headSha, checkRunId: check, state: JSON.stringify(state), reviewed: true }, ctx.now());
    return "private repository without a plan";
  }

  const { settings, warnings } = await settingsOf(ctx, gh, repo);
  if (!o.asked) {
    if (!settings.reviews.auto) return "automatic reviews are off";
    if (pull.draft && !settings.reviews.drafts) return "draft";
    if (!branchMatches(settings.reviews.branches, pull.baseRef)) return "base branch not reviewed";
    if (settings.reviews.ignoreAuthors.includes(pull.author)) return "author not reviewed";
    if (state.paused) return "paused on this pull request";
  }

  const ci = await ciEvidence(gh, repo.path, pull.headSha, settings);
  // GitHub often tells us about a push before it has created the commit's workflow runs. Where the check may fail a
  // pull request (fail_on), "no run yet" must not read as "nothing to wait for": the check waits, and the run's own
  // event finishes it. A person asking for a review gets the answer as it stands, so a commit that starts no workflow
  // at all cannot leave the check waiting for good.
  if (ci.state === "none" && ci.runs.length === 0 && settings.check.failOn !== "never" && !o.asked) ci.state = "pending";
  const summary = summaryOf(ci.inputs, settings);
  const merged = await mergeFindings(state, summary, pull.headSha);
  const next = merged.state;

  // the changed files are listed only when something needs their paths: a linked app's pages, or an inline comment
  const locations = settings.inline ? testLocations(ci.inputs) : new Map<string, TestLocation>();
  const wantInline = settings.inline && merged.view.some((f) => f.status === "new" && f.rep && f.now && !next.inline.includes(f.fp) && locations.has(f.test));
  const wantProduction = !!projectId && settings.production.enabled;
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

  const model: ReviewModel = { repo: repo.fullName, number, headSha: pull.headSha, mention: cfg.slug, ci, summary, findings: merged.view, production, settings, warnings, links };
  const check = renderCheck(model);
  next.waiting = check.status === "in_progress" ? pull.headSha : null;

  let checkId = ownCheck;
  if (settings.check.enabled) checkId = await publishCheck(gh, repo, row, next, pull.headSha, check);

  const openNow = merged.view.some((f) => f.status === "new" || f.status === "still");
  // new in this review: flagged now and not already reported as new by an earlier one
  const was = new Map(state.findings.map((f) => [f.fp, f.status]));
  const hasNew = merged.view.some((f) => f.status === "new" && was.get(f.fp) !== "new");
  const news = openNow || (production?.touched.length ?? 0) > 0;
  const wanted = settings.comment === "always" || (settings.comment === "findings" && (news || row.comment_id !== null));
  // the row is saved as soon as the comment exists, so a failure after it cannot lead to a second comment
  const commentId = await publishComment(gh, repo, number, row, next, renderSummary(model), wanted, hasNew);
  await savePr(db, repo.id, number, { headSha: pull.headSha, commentId, checkRunId: checkId, state: JSON.stringify(next) }, ctx.now());

  if (wantInline) {
    const comments = inlineComments(model, next, locations, diff);
    if (comments.length) {
      for (const c of comments) next.inline.push(c.fp);
      try {
        await gh.post(`${repo.path}/pulls/${number}/reviews`, {
          commit_id: pull.headSha,
          event: "COMMENT",
          body: `GenClass flagged ${comments.length === 1 ? "a test" : `${comments.length} tests`} this pull request changes. The summary comment has the whole report.`,
          comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
        });
      } catch (e) {
        if (retryable(e)) throw e;
        // a line GitHub does not accept (the diff moved): the summary comment still carries the finding
      }
    }
  }
  await savePr(db, repo.id, number, { state: JSON.stringify(next), reviewed: true }, ctx.now());
  if (!summary) return ci.state === "pending" ? "waiting for the test run" : "no race files";
  return openNow ? "findings" : "nothing flagged";
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
      if (!accountId || !/^[A-Za-z0-9-]{1,39}$/.test(login)) return "ignored";
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
    const row = await prRow(ctx.db, repo.id, number);
    if (!row) return "closed";
    await closePr(ctx.db, repo.id, number, ctx.now());
    return pull.merged === true ? await issueOnMerge(ctx, { installationId, repo, number }, row, str(obj(pull.head).sha, 64)) : "closed";
  }
  if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(action)) return "ignored";
  return reviewPull(ctx, { installationId, repo, number }, { pull });
}

/** `issues: merge`: one issue for a pull request that merges with reproducible findings still flagged. */
async function issueOnMerge(ctx: Ctx, t: ReviewTarget, row: PrRow, headSha: string): Promise<string> {
  const state = parseState(row.state);
  const left = state.findings.filter((f) => (f.status === "new" || f.status === "still") && f.rep);
  if (!left.length || state.issue !== null) return "closed";
  const inst = await installationFor(ctx, t.installationId, t.repo);
  if (!inst || inst.suspended || !(await repoEntitled(ctx.db, ctx.env, ctx.cfg, inst, t.repo, ctx.now())).ok) return "closed";
  const gh = installationClient(ctx.cfg, ctx.f, ctx.now, t.installationId, t.repo.id);
  const { settings } = await settingsOf(ctx, gh, t.repo);
  if (settings.issues !== "merge") return "closed";
  const issue = renderIssue(left, { repo: t.repo.fullName, number: t.number, headSha: headSha || row.head_sha, mention: ctx.cfg.slug, links: linksOf(ctx.cfg), merged: true });
  const made = posInt(obj(await gh.post(`${t.repo.path}/issues`, issue)).number);
  if (!made) return "closed";
  state.issue = made;
  await savePr(ctx.db, t.repo.id, t.number, { state: JSON.stringify(state) }, ctx.now());
  return "issue opened";
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
  // a commit has many workflow runs; only one that uploaded race files, or one a waiting check waits for, starts a review
  if (!rows.some((r) => parseState(r.state).waiting === sha)) {
    const inst = await installationFor(ctx, installationId, repo);
    if (!inst || inst.suspended) return "suspended";
    if (!(await repoEntitled(ctx.db, ctx.env, ctx.cfg, inst, repo, ctx.now())).ok) return "private repository without a plan";
    const gh = installationClient(ctx.cfg, ctx.f, ctx.now, installationId, repo.id);
    const { settings } = await settingsOf(ctx, gh, repo);
    const listed = obj(await gh.get(`${repo.path}/actions/runs/${runId}/artifacts`, { query: { per_page: 50 } }));
    const has = (Array.isArray(listed.artifacts) ? listed.artifacts : []).some((a) => str(obj(a).name, 100).startsWith(settings.artifact) && obj(a).expired !== true);
    if (!has) return "no race files in this run";
  }
  let outcome = "ok";
  for (const number of [...numbers].slice(0, 5)) outcome = await reviewPull(ctx, { installationId, repo, number });
  return outcome;
}

async function onCheckRun(ctx: Ctx, p: Obj): Promise<string> {
  if (p.action !== "rerequested") return "ignored";
  const repo = repoOf(p);
  const installationId = installationIdOf(p);
  const check = obj(p.check_run);
  if (!repo || !installationId || String(obj(check.app).id ?? "") !== ctx.cfg.appId) return "ignored";
  const sha = str(check.head_sha, 64);
  const rows = await prsAtSha(ctx.db, repo.id, sha);
  let outcome = "no pull request at this commit";
  for (const r of rows) outcome = await reviewPull(ctx, { installationId, repo, number: r.number }, { asked: true });
  return outcome;
}

async function onComment(ctx: Ctx, p: Obj): Promise<string> {
  if (p.action !== "created") return "ignored";
  const issue = obj(p.issue);
  if (!issue.pull_request) return "not a pull request";
  const comment = obj(p.comment);
  const user = obj(comment.user);
  const login = str(user.login, 60);
  // never answer a bot (itself included): two bots must not be able to talk to each other
  if (user.type === "Bot" || obj(p.sender).type === "Bot" || login.endsWith("[bot]") || str(comment.body, 200).includes(REPLY_MARKER)) return "bot";
  const cmd = parseCommand(comment.body, ctx.cfg.slug);
  if (!cmd) return "no command";
  const repo = repoOf(p);
  const installationId = installationIdOf(p);
  const number = posInt(issue.number);
  const commentId = posInt(comment.id);
  if (!repo || !installationId || !number || !commentId || !/^[A-Za-z0-9-]{1,39}$/.test(login)) return "ignored";
  if (issue.state !== "open") return "closed";

  const inst = await installationFor(ctx, installationId, repo);
  if (!inst || inst.suspended) return "suspended";
  if ((await repoById(ctx.db, repo.id))?.paused) return "paused";
  if (!(await repoEntitled(ctx.db, ctx.env, ctx.cfg, inst, repo, ctx.now())).ok) return "private repository without a plan";
  const gh = installationClient(ctx.cfg, ctx.f, ctx.now, installationId, repo.id);
  const { settings } = await settingsOf(ctx, gh, repo);
  if (!settings.commands) return "commands are off";

  // who is asking, by GitHub's own account of it
  const collaborator = ["OWNER", "MEMBER", "COLLABORATOR"].includes(str(comment.author_association, 30));
  const author = posInt(user.id) !== null && posInt(user.id) === posInt(obj(issue.user).id);
  if (NEEDS_WRITE.includes(cmd.name)) {
    if (!collaborator) return "not allowed";
    const perm = str(obj(await gh.get(`${repo.path}/collaborators/${login}/permission`)).permission, 20);
    if (perm !== "admin" && perm !== "write") return "not allowed";
  } else if (!collaborator && !author) return "not allowed";

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
  if (cmd.name === "review") return reviewPull(ctx, { installationId, repo, number }, { asked: true });
  if (cmd.name === "pause" || cmd.name === "resume") {
    if (!row) await takeLease(ctx.db, { repoId: repo.id, number, installationId }, ctx.now()).then(() => releaseLease(ctx.db, repo.id, number));
    state.paused = cmd.name === "pause";
    await savePr(ctx.db, repo.id, number, { state: JSON.stringify(state) }, ctx.now());
    await say(`${REPLY_MARKER}\n${state.paused ? `Paused: this pull request is not updated until someone with write access replies \`@${ctx.cfg.slug} resume\`.` : "Resumed: the next push or test run updates this pull request again."}\n`);
    return state.paused ? "paused" : "resumed";
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
  if (!accountId || !/^[A-Za-z0-9-]{1,39}$/.test(login)) return "ignored";
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
