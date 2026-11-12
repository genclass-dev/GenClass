// What the collector does after storing a batch from an app in an account, beyond the dashboard counters: index the
// batch for the export (copied under export/ when the owner's plan keeps more than 90 days) when the owner's plan
// includes export, and forward its detections when the owner's plan includes forwarding and a destination is on. The
// owner's plan is what src/plans.ts accessOf says: the paid plan or GenClass's grant, else Free (which has neither
// export nor forwarding since plans.json version 3). Apps without an account (private links only) cannot export or forward, so their
// batches cost nothing more: no index row, no copy. Runs in waitUntil; never affects the response.

import type { BucketLike, Env } from "./collector.js";
import { RETENTION_DAYS, type D1Like } from "./dashboard.js";
import { storeForExport } from "./export.js";
import { forwardBatch } from "./forward.js";
import { ACCESS_COLUMNS, accessOf, accountWide, better, entitled, FREE, keepDays, planGatesOpen, projectOwnAccess, stripeMode, type AccessRow, type Plan, type StripeMode } from "./plans.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Owner {
  projectId: string | null;
  name: string;
  accountId: string | null;
  plan: Plan;
  /** Enabled forwarding destinations. */
  destinations: number;
}

const OWNER_MS = 60_000;
const owners = new Map<string, { o: Owner | null; exp: number }>();
export const resetOwnerCache = (): void => owners.clear();
/** Drop one app from this isolate's cache (its destinations or plan just changed). */
export const forgetOwner = (token: string): boolean => owners.delete(token);

/**
 * The app behind a token, its owner's plan and how many destinations are on (cached a minute per isolate). `mode`: the
 * current Stripe key's; a plan bought in test mode counts only under a test key (src/plans.ts inMode). A grant gives
 * its plan's entitlements while it runs (accessOf). `open`: this server's PLAN_GATES is open, so every account has the
 * grant plan (an app without an account still has no export and no forwarding: there is nobody to set them up).
 */
export async function ownerOf(db: D1Like, token: string, nowMs: number, mode: StripeMode | null = null, open = false): Promise<Owner | null> {
  const c = owners.get(token);
  if (c && c.exp > nowMs) return c.o;
  const cols = ACCESS_COLUMNS.split(", ").map((k) => `a.${k}`).join(", ");
  const row = await db
    .prepare(
      `SELECT p.id, p.name, p.account_id, p.created, p.plan AS p_plan, p.stripe_mode AS p_mode, p.comp_until AS p_comp, p.comp_plan AS p_comp_plan, ${cols}, ` +
        "(SELECT COUNT(*) FROM integrations i WHERE i.project_id = p.id AND i.enabled = 1) AS n " +
        "FROM projects p LEFT JOIN accounts a ON a.id = p.account_id WHERE p.token = ?",
    )
    .bind(token)
    .first<AccessRow & { id: string | null; name: string; account_id: string | null; created: string; p_plan: string | null; p_mode: string | null; p_comp: string | null; p_comp_plan: string | null; n: number }>();
  const now = new Date(nowMs);
  // the project's own plan or grant, or a subscription of its whole account from before plans were per project
  // (src/plans.ts projectAccess; Free has neither export nor forwarding, so the 3-project lock does not matter here)
  const plan = !row?.account_id
    ? FREE
    : open
      ? accessOf(row, mode, now, true).plan
      : better(projectOwnAccess({ id: row.id, token, created: row.created, plan: row.p_plan, stripe_mode: row.p_mode, comp_until: row.p_comp, comp_plan: row.p_comp_plan }, mode, now), accountWide(row, mode, now)).plan;
  const o: Owner | null = row ? { projectId: row.id, name: row.name, accountId: row.account_id, plan, destinations: Number(row.n) || 0 } : null;
  if (owners.size > 5000) owners.clear();
  owners.set(token, { o, exp: nowMs + OWNER_MS });
  return o;
}

export interface StoredBatch {
  token: string;
  runtime: string;
  model: string | null;
  events: Record<string, unknown>[];
  /** The R2 key under events/, its gzip bytes, the time it was received and its id (the key's file name). */
  key: string;
  gz: Uint8Array;
  received: string;
  id: string;
}

export async function afterBatch(env: Env & { BUCKET: BucketLike }, db: D1Like, b: StoredBatch, now: Date, f: Fetch): Promise<void> {
  const owner = await ownerOf(db, b.token, now.getTime(), stripeMode(env), planGatesOpen(env));
  if (!owner?.accountId) return;
  const tasks: Promise<unknown>[] = [];
  // the export covers the batches received while the account's plan includes it (one index row per batch, so not for
  // Free apps, which could never read them)
  if (entitled(owner.plan, "export")) {
    tasks.push(
      storeForExport(db, env.BUCKET, {
        token: b.token,
        key: b.key,
        gz: b.gz,
        received: b.received,
        events: b.events.length,
        id: b.id,
        keepLong: keepDays(owner.plan) > RETENTION_DAYS,
      }),
    );
  }
  if (owner.projectId && owner.destinations > 0 && entitled(owner.plan, "forwarding") && b.events.some((e) => e.t === "detect")) {
    const origin = (env.AUTH_ORIGIN || env.DASHBOARD_ORIGIN || "https://genclass.dev").replace(/\/+$/, "");
    tasks.push(forwardBatch(env, db, { id: owner.projectId, name: owner.name, dashboard: `${origin}/account/apps/${owner.projectId}` }, b, now, f));
  }
  await Promise.allSettled(tasks);
}
