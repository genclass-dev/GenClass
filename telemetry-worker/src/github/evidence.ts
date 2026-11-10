// The evidence a review is built from, and nothing else:
//
//   1. CI: the race files (`genclass-races/1`, packages/playwright) the pull request's own workflow run uploaded as an
//      artifact. They are what the GenClass Playwright fixture saw in the page while the repository's tests ran.
//   2. Production: when the repository is linked to a GenClass app, that app's findings (kinds, page routes, counts)
//      from the dashboard's own aggregates (src/dashboard.ts stats), split by whether the pull request's changed files
//      serve those pages (src/github/routes.ts).
//
// Invariants:
// - An artifact is untrusted input (a pull request from a fork uploads whatever it likes). It is downloaded up to a
//   byte cap, unzipped in memory with entry, size and count caps (src/github/zip.ts), and only its `.json` entries are
//   read, each through the race-file validator. Nothing from it is executed, fetched or stored; what reaches a comment
//   goes through the summariser's escaping.
// - What one review reads and keeps is bounded for the review as a whole, not per artifact, because the worker's
//   isolate (128 MB, shared with ingest and the dashboards) holds it all at once: MAX_INFLATED_BYTES of unzipped race
//   files however many artifacts they come in, counted for every entry the zip reader starts, kept or not; a file at
//   most MAX_RACE_FILE_BYTES; MAX_RACE_FILES files; MAX_REVIEW_SIGNATURES signatures. The format's validator caps a
//   file's signatures and the length of each string before anything is built from them. Of a file that validates,
//   only what a review uses is kept, as compact JSON; a file's own text is kept only when it does not validate, so
//   that the report can say why.
// - Only workflow runs on the pull request's head commit count, so a review never shows another commit's results.
//   Every run GitHub lists for the commit is considered (one request, MAX_LISTED_RUNS), and the artifacts of up to
//   MAX_ASKED_RUNS completed ones are asked for, in an order that reaches the run with the race files early on a
//   commit with dozens of runs: the most recently finished first, one run of every workflow before a second run of
//   any. When runs are left unasked and race files may be in them (nothing was read, or a workflow had none of its
//   runs asked), a note says how many were asked and how many were not. Of two artifacts with one name in a run (a
//   re-run uploads the name again) the one created last is read, and an older one never stands in for it.
// - It spends at most MAX_EVIDENCE_CALLS of the client's request budget, so the review's own reads and writes always
//   have theirs.
// - No source code is read: not the diff's contents, not the repository's files. The changed files' PATHS are used.
// - The production part reads only the linked app's aggregates, which hold no page text (src/dashboard.ts header).

import { parseRaces } from "../../../packages/playwright/src/schema.js";
import { RACES_LIMITS, type GenClassRacesFile, type RacesFileInput } from "../../../packages/playwright/src/types.js";
import type { Env } from "../collector.js";
import { PROJECT_COLUMNS, stats, type D1Like, type Project, type Range } from "../dashboard.js";
import { hasDashboard, projectAccess } from "../plans.js";
import { GithubError, posInt, type GithubClient } from "./api.js";
import { matchesRoute, routesOfFiles } from "./routes.js";
import type { RepoSettings } from "./settings.js";
import { readZip, ZipError } from "./zip.js";

/** Workflow runs of the head commit that are listed: one request, the most GitHub gives in one. */
export const MAX_LISTED_RUNS = 100;
/** Completed workflow runs whose artifacts one review asks for, ASKED_AT_ONCE at a time. */
export const MAX_ASKED_RUNS = 30;
const ASKED_AT_ONCE = 4;
/**
 * GitHub requests the evidence of one review may make, of the 60 a client has (src/github/api.ts): the list of runs,
 * a list of artifacts for each run asked and a download for each artifact read come to 37. The rest of the client's
 * budget is the review's own reads and writes.
 */
export const MAX_EVIDENCE_CALLS = 38;
/** Workflow runs kept in CiEvidence.runs, newest first. */
export const MAX_RUNS = 8;
/** Artifacts downloaded for one review. */
export const MAX_ARTIFACTS = 6;
/** Largest artifact downloaded, and the most downloaded for one review: bytes as GitHub stores them, zipped. */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
/** Race files read for one review (a file is one test in one seed). */
export const MAX_RACE_FILES = 600;
/** Largest race file read, unzipped: the size the fixture keeps its files within (RACES_LIMITS.bytes). */
export const MAX_RACE_FILE_BYTES = RACES_LIMITS.bytes;
/** Unzipped bytes of race files one review reads, over all its artifacts. A file that is started and not kept counts. */
export const MAX_INFLATED_BYTES = 4 * 1024 * 1024;
/** Signatures in the race files of one review. A file that would take the review past it is not read. */
export const MAX_REVIEW_SIGNATURES = 2000;

export interface WorkflowRunInfo {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

export interface CiEvidence {
  /** none: no run or no artifact; pending: runs still going and no artifact yet; ready: race files were read. */
  state: "none" | "pending" | "ready";
  runs: WorkflowRunInfo[];
  /** Artifacts read, with how many race files each gave. */
  artifacts: { name: string; runId: number; files: number }[];
  /**
   * The race files, for the summariser. `content` is JSON text: of a file that validates, the fields a review reads
   * (compact, so smaller than the file); of one that does not, the file as it came, so the report lists it with the
   * validator's reasons. A file that was not read (the zip reader left it out, or a limit of the review was reached)
   * carries `error` and no content, and the report lists it as skipped with that reason.
   */
  inputs: RacesFileInput[];
  /** Sentences for the report about what could not be read. */
  notes: string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
// eslint-disable-next-line no-control-regex
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

type Run = WorkflowRunInfo & { workflow: number; at: string; ended: string };

/** A run that ended with one of these ran no job, so it uploaded nothing: such runs are asked last. */
const NO_JOBS: readonly string[] = ["skipped", "action_required", "startup_failure"];
/** Two of GitHub's timestamps (ISO 8601 in UTC, so the order of the text is the order in time), the later one first. */
const later = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);
/** A failure that ends the whole job, not the reading of one run or one artifact. */
const fatal = (e: unknown): boolean => e instanceof GithubError && (e.kind === "rate_limited" || e.kind === "unauthorized" || e.kind === "budget");
const megabytes = (bytes: number): number => Math.round(bytes / 1024 / 1024);

/**
 * What a review keeps of a race file that validates: the validator's copy without the two fields that may hold
 * anything and that no review reads (`shadow` and the chaos routes), as compact JSON.
 */
function kept(file: GenClassRacesFile): string {
  const lean: GenClassRacesFile = { ...file };
  delete lean.shadow;
  if (lean.chaos) {
    lean.chaos = { ...lean.chaos };
    delete lean.chaos.routes;
  }
  return JSON.stringify(lean);
}

/** Why the zip reader left an entry out, with the number where one of this module's limits is the reason. */
function whyNot(reason: string): string {
  if (reason === "too large") return `larger than ${MAX_RACE_FILE_BYTES / 1024} KB`;
  if (reason === "too many files") return `over ${MAX_RACE_FILES} race files in one review`;
  if (reason === "archive too large") return `over ${megabytes(MAX_INFLATED_BYTES)} MB of race files in one review`;
  return reason;
}

/**
 * The race files of the workflow runs on `headSha`. `repo` is "/repos/<owner>/<name>". `o.firstRun`: a run to ask
 * before every other (the run whose end started the review, when the caller knows it). Throws GithubError when the
 * commit's runs cannot be listed, and anywhere for a rate limit, a refused token or a used-up request budget (the
 * caller reports those); anything else wrong with one run or artifact is a note.
 */
export async function ciEvidence(gh: GithubClient, repo: string, headSha: string, settings: RepoSettings, o: { firstRun?: number } = {}): Promise<CiEvidence> {
  const out: CiEvidence = { state: "none", runs: [], artifacts: [], inputs: [], notes: [] };
  if (!/^[0-9a-f]{40,64}$/.test(headSha)) return out;
  const before = gh.calls();
  // requests this function made; the client counts more than one for each when GitHub redirects them (a renamed repository)
  let made = 1;
  // one request for every run of the commit; without each run's list of pull requests, an entry is about 10 KB
  const listed = obj(await gh.get(`${repo}/actions/runs`, { query: { head_sha: headSha, per_page: MAX_LISTED_RUNS, exclude_pull_requests: true }, maxBytes: 4 * 1024 * 1024 }));
  const all = Array.isArray(listed.workflow_runs) ? listed.workflow_runs : [];
  const runs: Run[] = [];
  const ids = new Set<number>();
  for (const r0 of all) {
    const r = obj(r0);
    const id = posInt(r.id);
    if (!id || r.head_sha !== headSha || ids.has(id)) continue;
    ids.add(id);
    runs.push({
      id,
      name: text(r.name, 80) || "workflow",
      status: text(r.status, 20),
      conclusion: text(r.conclusion, 20) || null,
      url: text(r.html_url, 300),
      workflow: posInt(r.workflow_id) ?? 0,
      at: text(r.created_at, 30),
      ended: text(r.updated_at, 30),
    });
  }
  runs.sort((a, b) => later(a.at, b.at) || b.id - a.id);
  out.runs = runs.slice(0, MAX_RUNS).map(({ id, name, status, conclusion, url }) => ({ id, name, status, conclusion, url }));

  // The order runs are asked in. The most recently finished first: the run whose end started this review is then
  // first or close to it, and a test run, which ends after lint and build, comes before them. Then one run of every
  // workflow before a second run of any, so runs started again by a label or a review cannot use up the asking.
  const byEnd = runs.filter((r) => r.status === "completed").sort((a, b) => later(a.ended, b.ended) || later(a.at, b.at) || b.id - a.id);
  const first = o.firstRun === undefined ? undefined : byEnd.find((r) => r.id === o.firstRun);
  const workflows = new Set<number>(first ? [first.workflow] : []);
  const lead: Run[] = [];
  const again: Run[] = [];
  const idle: Run[] = [];
  for (const r of byEnd) {
    if (r === first) continue;
    if (NO_JOBS.includes(r.conclusion ?? "")) idle.push(r);
    else if (workflows.has(r.workflow)) again.push(r);
    else {
      workflows.add(r.workflow);
      lead.push(r);
    }
  }
  const order = [...(first ? [first] : []), ...lead, ...again, ...idle];

  const seen = new Set<string>();
  const limits = {
    artifacts: `Only the first ${MAX_ARTIFACTS} artifacts whose name starts with "${settings.artifact}" were read.`,
    files: `Only ${MAX_RACE_FILES} race files are read for one review; the rest were not read.`,
    bytes: `Race files are read up to ${megabytes(MAX_INFLATED_BYTES)} MB for one review, unzipped; the rest were not read.`,
  };
  const said = new Set<keyof typeof limits>();
  /** The note about a limit of the whole review, said once however many artifacts and files run into it. */
  const say = (limit: keyof typeof limits): void => {
    if (said.has(limit)) return;
    said.add(limit);
    out.notes.push(limits[limit]);
  };
  const dec = new TextDecoder();
  let downloaded = 0;
  // artifacts a download was asked for, whether or not it came: each cost a request
  let tried = 0;
  // unzipped bytes the zip reader started on, kept or not
  let inflated = 0;
  let signatures = 0;
  let overSignatures = 0;
  // artifacts with the name the settings ask for, in the runs whose lists came
  let matched = 0;
  // A limit of the review was reached and something was left out because of it, which a note says. Until then the
  // commit's other runs are still asked, also when the review can read no more: an artifact found there is what tells
  // that something was left out.
  const stopped = (): boolean => said.size > 0;

  /** A run's artifacts and how many GitHub says it has; null when the list did not come. */
  const artifactsOf = async (run: Run): Promise<{ arts: Obj[]; total: number } | null> => {
    try {
      const a = obj(await gh.get(`${repo}/actions/runs/${run.id}/artifacts`, { query: { per_page: 100 } }));
      const arts = (Array.isArray(a.artifacts) ? a.artifacts : []).map(obj);
      return { arts, total: typeof a.total_count === "number" ? a.total_count : arts.length };
    } catch (e) {
      if (fatal(e)) throw e;
      return null;
    }
  };

  /** Reads the race files of one run's artifacts, within what is left of the review's limits. */
  const readRun = async (run: Run, arts: Obj[]): Promise<void> => {
    // A re-run keeps the run's id and uploads its names again, and GitHub does not list a run's artifacts in the order
    // they were made: the one created last comes first here, so it is the one read.
    arts.sort((x, y) => later(text(x.created_at, 30), text(y.created_at, 30)) || (posInt(y.id) ?? 0) - (posInt(x.id) ?? 0));
    for (const a of arts) {
      const id = posInt(a.id);
      const name = text(a.name, 100);
      if (!id || !name || !name.startsWith(settings.artifact) || a.expired === true) continue;
      matched++;
      // the same name again, from an earlier attempt of this run or from another run of the same workflow: the first
      // one met is the newest, and it counts even when it could not be read (an older one must not stand in for it)
      const key = `${run.workflow}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (tried >= MAX_ARTIFACTS) return say("artifacts");
      if (out.inputs.length >= MAX_RACE_FILES || said.has("files")) return say("files");
      if (inflated >= MAX_INFLATED_BYTES || said.has("bytes")) return say("bytes");
      const size = typeof a.size_in_bytes === "number" ? a.size_in_bytes : 0;
      if (size > MAX_ARTIFACT_BYTES || downloaded + size > MAX_DOWNLOAD_BYTES) {
        out.notes.push(`The artifact "${name}" is larger than this review reads (${megabytes(MAX_ARTIFACT_BYTES)} MB); upload only the race files (test-results/genclass).`);
        continue;
      }
      let bytes: Uint8Array;
      tried++;
      made++;
      try {
        bytes = await gh.download(`${repo}/actions/artifacts/${id}/zip`, MAX_ARTIFACT_BYTES);
      } catch (e) {
        if (fatal(e)) throw e;
        out.notes.push(`The artifact "${name}" could not be downloaded${e instanceof GithubError && e.kind === "too_large" ? " (it is too large)" : ""}.`);
        continue;
      }
      downloaded += bytes.length;
      let files = 0;
      try {
        // what is left of the review's limits is this archive's limits
        const zip = await readZip(bytes, {
          filter: (n) => n.toLowerCase().endsWith(".json"),
          limits: { maxEntries: MAX_RACE_FILES - out.inputs.length, maxEntryBytes: MAX_RACE_FILE_BYTES, maxTotalBytes: MAX_INFLATED_BYTES - inflated },
        });
        inflated += zip.spent;
        for (const e of zip.entries) {
          const label = `${name}/${e.name}`;
          const raw = dec.decode(e.bytes);
          // validated here, once per file, so that a review holds what it can use and knows how much that is
          const parsed = parseRaces(raw);
          // a file that does not validate goes on as it came: the report lists it with the validator's reasons
          if (!parsed.ok) out.inputs.push({ name: label, content: raw });
          else if (signatures + parsed.file.signatures.length > MAX_REVIEW_SIGNATURES) {
            overSignatures++;
            out.inputs.push({ name: label, content: "", error: `not read: over ${MAX_REVIEW_SIGNATURES} signatures in one review` });
          } else {
            signatures += parsed.file.signatures.length;
            out.inputs.push({ name: label, content: kept(parsed.file) });
          }
          files++;
        }
        for (const s of zip.skipped) {
          if (s.reason === "too many files") say("files");
          if (s.reason === "archive too large") say("bytes");
          out.inputs.push({ name: `${name}/${s.name}`, content: "", error: `not read: ${whyNot(s.reason)}` });
        }
        if (!zip.entries.length && !zip.skipped.length) out.notes.push(`The artifact "${name}" holds no .json file.`);
      } catch (e) {
        out.notes.push(`The artifact "${name}" could not be opened${e instanceof ZipError ? ` (${e.message})` : ""}.`);
      }
      out.artifacts.push({ name, runId: run.id, files });
    }
  };

  // runs asked, and those of them whose list came
  let asked = 0;
  let answered = 0;
  while (asked < order.length && asked < MAX_ASKED_RUNS && !stopped()) {
    // Every artifact that may still be downloaded costs a request: those are kept back. The rest is for lists, each at
    // what a request has cost so far (two when GitHub redirects them).
    const used = gh.calls() - before;
    const room = Math.floor((MAX_EVIDENCE_CALLS - used - (MAX_ARTIFACTS - tried)) / Math.max(1, Math.ceil(used / made)));
    const batch = order.slice(asked, asked + Math.min(ASKED_AT_ONCE, MAX_ASKED_RUNS - asked, room));
    if (!batch.length) break;
    asked += batch.length;
    made += batch.length;
    const lists = await Promise.all(batch.map(artifactsOf));
    for (const [i, run] of batch.entries()) {
      const list = lists[i];
      if (!list) {
        out.notes.push(`The artifacts of the workflow run "${run.name}" could not be listed.`);
        continue;
      }
      answered++;
      if (list.total > list.arts.length && list.arts.length) out.notes.push(`The workflow run "${run.name}" has ${list.total} artifacts; the ${list.arts.length} GitHub lists first were looked at.`);
      await readRun(run, list.arts);
    }
  }

  if (out.inputs.length) out.state = "ready";
  else if (runs.some((r) => r.status !== "completed")) out.state = "pending";
  else if (answered && !matched) out.notes.push(`No artifact whose name starts with "${settings.artifact}" in ${answered} completed workflow run${answered === 1 ? "" : "s"} on this commit.`);
  if (overSignatures) out.notes.push(`Race files are read up to ${MAX_REVIEW_SIGNATURES} signatures for one review; ${overSignatures} file${overSignatures === 1 ? " over that was" : "s over that were"} not read.`);
  // The asking stopped at its own limit, not at one of the review's that a note already tells. That is said when race
  // files may be in a run that was not asked: nothing was read, or a workflow had none of its runs asked. Older runs
  // of workflows that were asked, and runs in which no job ran, are left out without a word.
  const unasked = order.slice(asked).filter((r) => !NO_JOBS.includes(r.conclusion ?? ""));
  if (unasked.length && !stopped() && (out.state !== "ready" || unasked.some((r) => lead.includes(r)))) {
    const left = order.length - asked;
    out.notes.push(`Of the ${order.length} completed workflow runs listed for this commit, the artifacts of ${asked} were looked at, the most recently finished first; the other ${left} ${left === 1 ? "was" : "were"} not.`);
  }
  const total = typeof listed.total_count === "number" ? listed.total_count : 0;
  if (all.length && total > all.length) out.notes.push(`This commit has ${total} workflow runs; the ${all.length} GitHub lists first were looked at.`);
  return out;
}

// --------------------------------------------------------------------------------------------- production

export interface ProductionFinding {
  /** detection: the model's likely tier; possible: its lower tier; check: a measured visual check. */
  group: "detection" | "possible" | "check";
  /** The diagnosis ("stale", "duplicate"...) or the check kind ("scroll-lock"...). */
  label: string;
  route: string;
  count: number;
  /** The changed file whose route matched. */
  file: string;
}

export interface ProductionEvidence {
  app: string;
  appId: string;
  days: number;
  /** Page loads the app reported in the period. */
  loads: number;
  /** Findings on pages the changed files serve, most frequent first (at most MAX_TOUCHED). */
  touched: ProductionFinding[];
  /** Findings on other pages, counted only. */
  elsewhere: { findings: number; pages: number };
  /** Routes the changed files map to (0: none of them is a route file by a known convention). */
  routes: string[];
  /** The coding agent's loop for this app, when it reports (src/dashboard.ts agentStats). */
  agent: { open: number; reproduced: number; fixed: number; closed: number } | null;
}

export const MAX_TOUCHED = 12;
const GROUPS: [ProductionFinding["group"], string][] = [
  ["detection", "detect_issue"],
  ["possible", "possible_issue"],
  ["check", "check_issue"],
];
const LABEL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

/**
 * The linked app's findings in the last `settings.production.days` days, or null when the repository has no link, the
 * app is gone, its plan has no dashboard, or the setting is off.
 */
export async function productionEvidence(db: D1Like, env: Env, projectId: string | null, files: readonly string[], settings: RepoSettings, now: Date): Promise<ProductionEvidence | null> {
  if (!projectId || !settings.production.enabled) return null;
  const p = await db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`).bind(projectId).first<Project>();
  if (!p || !p.account_id || !p.id) return null;
  if (!hasDashboard(await projectAccess(db, p, env, now))) return null;
  const range: Range = settings.production.days === 1 ? "24h" : settings.production.days === 30 ? "30d" : "7d";
  const st = await stats(db, p, range, now);
  const patterns = routesOfFiles(files);
  const touched: ProductionFinding[] = [];
  const otherPages = new Set<string>();
  let other = 0;
  for (const [group, metric] of GROUPS) {
    for (const row of st.breakdowns[metric] ?? []) {
      const tab = row.key.indexOf("\t");
      if (tab < 1) continue;
      const label = row.key.slice(0, tab);
      const route = row.key.slice(tab + 1);
      if (!LABEL_RE.test(label) || !route.startsWith("/") || !(row.count > 0)) continue;
      const hit = patterns.find((pt) => matchesRoute(pt, route));
      if (hit) touched.push({ group, label, route: route.slice(0, 200), count: Math.round(row.count), file: hit.file });
      else {
        other++;
        otherPages.add(route);
      }
    }
  }
  touched.sort((a, b) => b.count - a.count || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0) || (a.label < b.label ? -1 : 1));
  const a = st.agent;
  const agent = a.last ? { open: a.stages.open, reproduced: a.stages.reproduced, fixed: a.stages.fixed, closed: a.stages.closed } : null;
  return {
    app: p.name,
    appId: p.id,
    days: settings.production.days,
    loads: Math.round(st.totals.sessions ?? 0),
    touched: touched.slice(0, MAX_TOUCHED),
    elsewhere: { findings: other + Math.max(0, touched.length - MAX_TOUCHED), pages: otherPages.size },
    routes: patterns.map((x) => x.route).slice(0, 20),
    agent,
  };
}
