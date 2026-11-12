// What a project has used of its plan this month: the problems GenClass fixed live on visitors' screens (the
// runtime's interventions in guard or heal mode, and visual fixes), against the plan's limits.live_fixes_per_month
// (billing/plans.json: 100 on Free, no limit on Team). Past the limit the runtime is told to observe only until the
// month ends (the owner's decision, 2026-11-12): it keeps finding and reporting every problem, and stops changing
// anything, which is what observe always is. Paying for the project lifts it at once.
//
// Invariants:
// - The count is the dashboard's own: the daily counters of applied interventions and applied visual fixes for the
//   UTC month so far (src/dashboard.ts aggregate). Nothing new is collected or stored for it.
// - Ingest's reply may carry one header, OBSERVE_HEADER, when the project is past its limit; the runtime reads it
//   (packages/runtime/src/telemetry) and only ever lowers its mode with it. The batch is stored and counted the same
//   either way, and a failure to work it out leaves the header off: never a reason to drop data or to act more.
// - The answer is cached a minute per isolate per project, so ingest does not read the counters on every batch.

import type { Env } from "./collector.js";
import type { D1Like } from "./dashboard.js";
import { ownerOf } from "./paid.js";
import { planGatesOpen, stripeMode, type Plan } from "./plans.js";

/** The header on ingest's reply that tells the runtime to observe only; its value says why. */
export const OBSERVE_HEADER = "x-genclass-observe";
export const OBSERVE_REASON = "live-fix-limit";

/** The first day of the UTC month of `now` (YYYY-MM-01), and of the month after it (when the limit lifts), as ISO. */
export const monthOf = (now: Date): { from: string; resets: string } => {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return { from: `${now.toISOString().slice(0, 7)}-01`, resets: new Date(Date.UTC(y, m + 1, 1)).toISOString() };
};

/** The problems GenClass fixed live for this project in the UTC month of `now`. */
export async function liveFixes(db: D1Like, token: string, now: Date): Promise<number> {
  const r = await db
    .prepare("SELECT COALESCE(SUM(count), 0) AS n FROM daily WHERE token = ? AND day >= ? AND (metric = 'intervention' OR (metric = 'check_fix' AND key = 'applied'))")
    .bind(token, monthOf(now).from)
    .first<{ n: number }>();
  return Math.max(0, Math.round(Number(r?.n ?? 0)));
}

export interface LiveFixUsage {
  /** Fixed live this month. */
  used: number;
  /** The plan's monthly limit; null: none. */
  limit: number | null;
  /** Past the limit: the runtime is told to observe only. */
  observe_only: boolean;
  /** When the month ends and the count starts again (ISO). */
  resets: string;
}

/** A project's live fixes this month against `plan`'s limit. */
export async function liveFixUsage(db: D1Like, token: string, plan: Plan, now: Date): Promise<LiveFixUsage> {
  const limit = plan.limits.live_fixes_per_month ?? null;
  const used = await liveFixes(db, token, now);
  return { used, limit, observe_only: limit !== null && used >= limit, resets: monthOf(now).resets };
}

const CACHE_MS = 60_000;
const cache = new Map<string, { observe: boolean; exp: number }>();
/** For the tests: forget every cached answer. */
export const resetUsageCache = (): void => cache.clear();

/**
 * Whether ingest's reply for this project tells the runtime to observe only: its plan (src/paid.ts ownerOf: the
 * project's own, or its account's subscription from before plans were per project) has a monthly limit and this
 * month's live fixes reached it. False on any error and for a token no project has.
 */
export async function observeOnly(db: D1Like, env: Env, token: string, now: Date): Promise<boolean> {
  const c = cache.get(token);
  if (c && c.exp > now.getTime()) return c.observe;
  let observe = false;
  try {
    const owner = await ownerOf(db, token, now.getTime(), stripeMode(env), planGatesOpen(env));
    const limit = owner?.plan.limits.live_fixes_per_month ?? null;
    observe = limit !== null && (await liveFixes(db, token, now)) >= limit;
  } catch {
    observe = false;
  }
  if (cache.size > 5000) cache.clear();
  cache.set(token, { observe, exp: now.getTime() + CACHE_MS });
  return observe;
}
