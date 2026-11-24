// `npx genclass onboard <code>`, followed on genclass.dev (the owner, 2026-11-24: "the onboarding system actually gives
// you a command for the CLI ... it goes through the entire setup ... the CLI should connect to the dashboard and should
// show you a visualization of what's going on").
//
//   POST /api/account/onboard   (a browser session, src/auth.ts) a command with a one-time code: a sign-in for the
//                               genclass command that this account has already approved (the device flow's row, made
//                               approved), good once and for ten minutes
//   GET  /api/account/onboard   (a browser session) the account's latest onboarding run of the last two hours
//   POST /api/cli/onboard       (the command's session, src/cli.ts) where the setup stands: every step with its state
//                               and its words, the step it is on, and what each step it ran came to
//
// Invariants:
// - What is kept is what the command's own screen says (packages/cli/src/state.mjs stateJson): step ids from a fixed
//   list, their states, and short words, all cut to length. No file contents, no paths beyond the step's own detail,
//   nothing from the visitor's code.
// - A run is one row of `challenges` (kind 'onboard'), gone two hours after its last report (the cleanup in auth.ts),
//   so nothing here needs a migration and nothing is kept for long.
// - A report is merged into the run: the steps are replaced as a whole, a step's result is appended to the run's log
//   (40 lines at most), and a run that ended stays ended.

import type { D1Like } from "./dashboard.js";

/** The setup's steps, in the command's order (packages/cli/src/state.mjs). */
export const ONBOARD_STEPS = ["account", "runtime", "app-plan", "dashboard", "workflow", "github-app", "agent", "plan", "suggestions"] as const;
const STEP_SET = new Set<string>(ONBOARD_STEPS);
const STATES = new Set(["done", "next", "todo", "waiting", "optional", "blocked"]);
const RESULTS = new Set(["running", "done", "failed", "skipped", "quit"]);
/** How long a run is kept after its last report, and how long the command's code lasts. */
export const ONBOARD_KEEP_MS = 2 * 60 * 60 * 1000;
/** A report's body, at most. */
export const ONBOARD_BODY_MAX = 8192;
const LOG_MAX = 40;
const RUN_RE = /^[A-Za-z0-9_-]{8,40}$/;

export interface OnboardStep {
  id: string;
  title: string;
  state: string;
  detail: string;
}
export interface OnboardRun {
  run: string;
  started: string;
  at: string;
  app: { name: string; framework: string } | null;
  steps: OnboardStep[];
  /** The step running now, in the command's words ("Add GenClass to this app"). */
  now: { id: string; doing: string } | null;
  log: { at: string; id: string; doing: string; result: string }[];
  finished: boolean;
  exit: number | null;
}

const text = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** A report from the command, checked and cut; a string says what is wrong with it. */
export function readReport(body: unknown):
  | { run: string; steps: OnboardStep[] | null; app: { name: string; framework: string } | null; step: { id: string; doing: string; result: string } | null; exit: number | null; end: boolean }
  | string {
  if (!body || typeof body !== "object") return "send JSON";
  const b = body as Record<string, unknown>;
  if (typeof b.run !== "string" || !RUN_RE.test(b.run)) return "run is missing or malformed";
  let steps: OnboardStep[] | null = null;
  if (Array.isArray(b.steps)) {
    steps = [];
    for (const x of b.steps.slice(0, 20)) {
      if (!x || typeof x !== "object") continue;
      const s = x as Record<string, unknown>;
      const id = text(s.id, 20);
      if (!STEP_SET.has(id)) continue;
      steps.push({ id, title: text(s.title, 40), state: STATES.has(String(s.state)) ? String(s.state) : "todo", detail: text(s.detail, 160) });
    }
  }
  let step: { id: string; doing: string; result: string } | null = null;
  if (b.step && typeof b.step === "object") {
    const s = b.step as Record<string, unknown>;
    const id = text(s.id, 20);
    const result = String(s.result);
    if (STEP_SET.has(id) && RESULTS.has(result)) step = { id, doing: text(s.doing, 80), result };
  }
  const a = b.app && typeof b.app === "object" ? (b.app as Record<string, unknown>) : null;
  const app = a ? { name: text(a.name, 80), framework: text(a.framework, 60) } : null;
  const exit = Number.isInteger(b.exit) ? Math.max(0, Math.min(255, b.exit as number)) : null;
  return { run: b.run, steps, app, step, exit, end: b.end === true };
}

const rowId = (account: string, run: string): string => `onboard:${account}:${run}`;

/** Merges one report into the account's run (made at its first report). */
export async function saveReport(db: D1Like, account: string, r: Exclude<ReturnType<typeof readReport>, string>, now: Date): Promise<OnboardRun> {
  const id = rowId(account, r.run);
  const iso = now.toISOString();
  const old = await db.prepare("SELECT data FROM challenges WHERE id = ? AND kind = 'onboard' AND account_id = ?").bind(id, account).first<{ data: string | null }>();
  let run: OnboardRun;
  try {
    run = old?.data ? (JSON.parse(old.data) as OnboardRun) : (null as unknown as OnboardRun);
  } catch {
    run = null as unknown as OnboardRun;
  }
  if (!run) run = { run: r.run, started: iso, at: iso, app: null, steps: [], now: null, log: [], finished: false, exit: null };
  run.at = iso;
  if (r.steps) run.steps = r.steps;
  if (r.app && (r.app.name || r.app.framework)) run.app = r.app;
  if (r.step) {
    if (r.step.result === "running") run.now = { id: r.step.id, doing: r.step.doing };
    else {
      run.log.push({ at: iso, id: r.step.id, doing: r.step.doing, result: r.step.result });
      if (run.log.length > LOG_MAX) run.log = run.log.slice(-LOG_MAX);
      if (run.now?.id === r.step.id) run.now = null;
    }
  }
  if (r.end) {
    run.finished = true;
    run.now = null;
    if (r.exit !== null) run.exit = r.exit;
  }
  const expires = new Date(now.getTime() + ONBOARD_KEEP_MS).toISOString();
  await db
    .prepare("INSERT INTO challenges (id, kind, challenge, account_id, data, expires) VALUES (?, 'onboard', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires = excluded.expires")
    .bind(id, r.run, account, JSON.stringify(run), expires)
    .run();
  return run;
}

/** The account's latest run of the last two hours, or null. */
export async function latestRun(db: D1Like, account: string, now: Date): Promise<OnboardRun | null> {
  const row = await db
    .prepare("SELECT data FROM challenges WHERE kind = 'onboard' AND account_id = ? AND expires > ? ORDER BY expires DESC LIMIT 1")
    .bind(account, now.toISOString())
    .first<{ data: string | null }>();
  if (!row?.data) return null;
  try {
    return JSON.parse(row.data) as OnboardRun;
  } catch {
    return null;
  }
}

/** The first published genclass with `genclass onboard`. */
export const ONBOARD_CLI_FROM = "0.3.17";
let npmSeen: { at: number; ok: boolean } | null = null;
const newer = (a: string, b: string): boolean => {
  const x = a.split(/[.-]/).slice(0, 3).map(Number), y = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
};

/**
 * Whether Get started may give `npx genclass@latest onboard <code>`: only once the genclass on npm has the command, or
 * the page would hand out a command that fails (the release waits for the owner's approval). ONBOARD_CLI "on" or "off"
 * decides; unset, npm's latest genclass is asked, at most every ten minutes, and an answer that does not come is a no:
 * the page then gives the plain `npx genclass`, which does the same setup with its own sign-in.
 */
export async function onboardReady(env: { ONBOARD_CLI?: string }, fetchFn: (u: string, i?: RequestInit) => Promise<Response>, nowMs: number): Promise<boolean> {
  if (env.ONBOARD_CLI === "on") return true;
  if (env.ONBOARD_CLI === "off") return false;
  if (npmSeen && nowMs - npmSeen.at < 10 * 60 * 1000) return npmSeen.ok;
  let ok = false;
  try {
    const r = await fetchFn("https://registry.npmjs.org/genclass/latest", { headers: { accept: "application/json" } });
    const v = r.ok ? String(((await r.json()) as { version?: unknown }).version ?? "") : "";
    ok = /^\d+\.\d+\.\d+/.test(v) && newer(v, ONBOARD_CLI_FROM);
  } catch {
    ok = false;
  }
  npmSeen = { at: nowMs, ok };
  return ok;
}

/** For tests: forget what npm said. */
export const resetOnboardReady = (): void => {
  npmSeen = null;
};

