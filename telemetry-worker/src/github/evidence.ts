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
// - Only workflow runs on the pull request's head commit count, so a review never shows another commit's results.
// - No source code is read: not the diff's contents, not the repository's files. The changed files' PATHS are used.
// - The production part reads only the linked app's aggregates, which hold no page text (src/dashboard.ts header).

import type { RacesFileInput } from "../../../packages/playwright/src/types.js";
import type { Env } from "../collector.js";
import { PROJECT_COLUMNS, stats, type D1Like, type Project, type Range } from "../dashboard.js";
import { hasDashboard, projectAccess } from "../plans.js";
import { GithubError, posInt, type GithubClient } from "./api.js";
import { matchesRoute, routesOfFiles } from "./routes.js";
import type { RepoSettings } from "./settings.js";
import { readZip, ZipError } from "./zip.js";

/** Workflow runs on the head commit that are looked at, newest first. */
export const MAX_RUNS = 8;
/** Artifacts read for one review. */
export const MAX_ARTIFACTS = 6;
/** Largest artifact downloaded, and the most downloaded for one review. */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
/** Race files read for one review (a file is one test in one seed). */
export const MAX_RACE_FILES = 600;

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
  /** The race files, for the summariser (unreadable ones carry `error`, so the report lists them as skipped). */
  inputs: RacesFileInput[];
  /** Sentences for the report about what could not be read. */
  notes: string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
// eslint-disable-next-line no-control-regex
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

/**
 * The race files of the workflow runs on `headSha`. `repo` is "/repos/<owner>/<name>". Throws GithubError only for a
 * rate limit or a refused token (the caller reports those); anything wrong with one run or artifact is a note.
 */
export async function ciEvidence(gh: GithubClient, repo: string, headSha: string, settings: RepoSettings): Promise<CiEvidence> {
  const out: CiEvidence = { state: "none", runs: [], artifacts: [], inputs: [], notes: [] };
  if (!/^[0-9a-f]{40,64}$/.test(headSha)) return out;
  const listed = obj(await gh.get(`${repo}/actions/runs`, { query: { head_sha: headSha, per_page: 30 } }));
  const all = Array.isArray(listed.workflow_runs) ? listed.workflow_runs : [];
  const runs: (WorkflowRunInfo & { workflow: number; at: string })[] = [];
  for (const r0 of all) {
    const r = obj(r0);
    const id = posInt(r.id);
    if (!id || r.head_sha !== headSha) continue;
    runs.push({
      id,
      name: text(r.name, 80) || "workflow",
      status: text(r.status, 20),
      conclusion: text(r.conclusion, 20) || null,
      url: text(r.html_url, 300),
      workflow: posInt(r.workflow_id) ?? 0,
      at: text(r.created_at, 30),
    });
  }
  runs.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
  out.runs = runs.slice(0, MAX_RUNS).map(({ id, name, status, conclusion, url }) => ({ id, name, status, conclusion, url }));

  const seen = new Set<string>();
  let downloaded = 0;
  let completed = 0;
  for (const run of runs.slice(0, MAX_RUNS)) {
    if (run.status !== "completed") continue;
    completed++;
    if (out.artifacts.length >= MAX_ARTIFACTS || out.inputs.length >= MAX_RACE_FILES) break;
    let arts: unknown[];
    try {
      const a = obj(await gh.get(`${repo}/actions/runs/${run.id}/artifacts`, { query: { per_page: 50 } }));
      arts = Array.isArray(a.artifacts) ? a.artifacts : [];
    } catch (e) {
      if (e instanceof GithubError && (e.kind === "rate_limited" || e.kind === "unauthorized" || e.kind === "budget")) throw e;
      out.notes.push(`The artifacts of the workflow run "${run.name}" could not be listed.`);
      continue;
    }
    for (const a0 of arts) {
      const a = obj(a0);
      const id = posInt(a.id);
      const name = text(a.name, 100);
      if (!id || !name || !name.startsWith(settings.artifact) || a.expired === true) continue;
      // a re-run of the same workflow uploads the same names again: the newest run's are the ones that count
      const key = `${run.workflow}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (out.artifacts.length >= MAX_ARTIFACTS) {
        out.notes.push(`Only the first ${MAX_ARTIFACTS} artifacts whose name starts with "${settings.artifact}" were read.`);
        break;
      }
      const size = typeof a.size_in_bytes === "number" ? a.size_in_bytes : 0;
      if (size > MAX_ARTIFACT_BYTES || downloaded + size > MAX_DOWNLOAD_BYTES) {
        out.notes.push(`The artifact "${name}" is larger than this review reads (${Math.round(MAX_ARTIFACT_BYTES / 1024 / 1024)} MB); upload only the race files (test-results/genclass).`);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await gh.download(`${repo}/actions/artifacts/${id}/zip`, MAX_ARTIFACT_BYTES);
      } catch (e) {
        if (e instanceof GithubError && (e.kind === "rate_limited" || e.kind === "unauthorized" || e.kind === "budget")) throw e;
        out.notes.push(`The artifact "${name}" could not be downloaded${e instanceof GithubError && e.kind === "too_large" ? " (it is too large)" : ""}.`);
        continue;
      }
      downloaded += bytes.length;
      let files = 0;
      try {
        const zip = await readZip(bytes, { filter: (n) => n.toLowerCase().endsWith(".json"), limits: { maxEntries: MAX_RACE_FILES - out.inputs.length } });
        const dec = new TextDecoder();
        for (const e of zip.entries) {
          out.inputs.push({ name: `${name}/${e.name}`, content: dec.decode(e.bytes) });
          files++;
        }
        for (const s of zip.skipped) out.inputs.push({ name: `${name}/${s.name}`, content: "", error: `not read: ${s.reason}` });
        if (!zip.entries.length && !zip.skipped.length) out.notes.push(`The artifact "${name}" holds no .json file.`);
      } catch (e) {
        out.notes.push(`The artifact "${name}" could not be opened${e instanceof ZipError ? ` (${e.message})` : ""}.`);
      }
      out.artifacts.push({ name, runId: run.id, files });
    }
  }
  if (out.inputs.length) out.state = "ready";
  else if (runs.slice(0, MAX_RUNS).some((r) => r.status !== "completed")) out.state = "pending";
  else if (completed && !out.notes.length) out.notes.push(`No artifact whose name starts with "${settings.artifact}" in ${completed} completed workflow run${completed === 1 ? "" : "s"} on this commit.`);
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
