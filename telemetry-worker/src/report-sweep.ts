// The hourly run of GenClass reports (cron REPORT_CRON, src/index.ts): the reports that are due, then P0 alerts for
// apps whose critical problems no report has told their owner about yet.
//
// Invariants:
// - A report is claimed before it is built: one statement moves the account's report_next to the next slot only if
//   it still holds the value this run read, so two runs that overlap never send the same report twice.
// - An account without a slot yet gets one (the next slot of its schedule) and nothing is sent that run: a deploy,
//   or a new account, never sends a report at once.
// - An hourly report with nothing critical or important, and nothing in its last hour, is not sent.
// - An alert goes out at most once a day per app and rule (report_alerts), only for P0 items, only to an account with
//   alerts on and reports not 'off', and never in the same run as that account's report (the report holds the same
//   items). Every email counts against the account's daily cap (src/report.ts claimSend).
// - Nothing here throws: each account runs in its own try/catch, and a failure leaves its slot moved on (the next
//   slot tries again) rather than retrying every hour.

import type { Env } from "./collector.js";
import { PROJECT_COLUMNS, stats, type D1Like, type Project } from "./dashboard.js";
import { renderReport } from "./report-email.js";
import {
  ACCOUNT_REPORT_COLUMNS,
  ALERT_APPS,
  appItems,
  appReport,
  buildReport,
  everyOf,
  hourlyWorthSending,
  MODEL_EVERY_MS,
  nextSlot,
  originOf,
  sendReport,
  SWEEP_ACCOUNTS,
  type AccountRow,
  type Item,
} from "./report.js";
import { accountProjectsAccess } from "./plans.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const PARALLEL = 4;

async function rows<T>(db: D1Like, sql: string, ...params: unknown[]): Promise<T[]> {
  try {
    return ((await db.prepare(sql).bind(...params).all<T>()).results ?? []) as T[];
  } catch {
    return [];
  }
}

/** Runs `fn` over `xs`, `k` at a time, never throwing. */
async function inGroups<T>(xs: T[], k: number, fn: (x: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < xs.length; i += k) await Promise.allSettled(xs.slice(i, i + k).map((x) => fn(x).catch(() => undefined)));
}

/** Gives every account that has an email and no slot yet the next slot of its schedule. */
async function giveSlots(db: D1Like, now: Date): Promise<void> {
  const todo = await rows<{ id: string; report_every: string | null }>(db, "SELECT id, report_every FROM accounts WHERE report_next IS NULL AND email IS NOT NULL AND COALESCE(report_every, 'daily') <> 'off' LIMIT 500");
  if (!todo.length) return;
  await db.batch(todo.map((a) => db.prepare("UPDATE accounts SET report_next = ? WHERE id = ? AND report_next IS NULL").bind(nextSlot(now, everyOf(a.report_every)), a.id))).catch(() => undefined);
}

/** Moves the account's slot on if it still holds `was`; false when another run took it first. */
async function claim(db: D1Like, a: AccountRow, now: Date): Promise<boolean> {
  try {
    const r = await db.prepare("UPDATE accounts SET report_next = ? WHERE id = ? AND report_next = ? RETURNING id").bind(nextSlot(now, everyOf(a.report_every)), a.id, a.report_next).first<{ id: string }>();
    return !!r;
  } catch {
    return false;
  }
}

/** One account's scheduled report: built, rendered and sent. Whether an email went out. */
export async function runReport(env: Env, a: AccountRow, now: Date, f: Fetch): Promise<boolean> {
  const db = env.DB!;
  const every = everyOf(a.report_every);
  const model = every !== "hourly" || !a.report_model || now.getTime() - Date.parse(a.report_model) >= MODEL_EVERY_MS;
  const built = await buildReport(env, a, { kind: "report", now, model, fetch: f });
  if (!built) return false;
  const r = built.report;
  if (every === "hourly" && !hourlyWorthSending(r)) return false;
  if (r.summary) await db.prepare("UPDATE accounts SET report_model = ? WHERE id = ?").bind(now.toISOString(), a.id).run().catch(() => undefined);
  const sent = await sendReport(env, r, renderReport(r), now);
  // a report covers the P0 items it lists: no alert for them for a day
  if (sent) await markAlerted(db, r.items.filter((i) => i.p === 0 && i.appId), now);
  return sent;
}

async function markAlerted(db: D1Like, items: Item[], now: Date): Promise<void> {
  if (!items.length) return;
  await db
    .batch(items.map((i) => db.prepare("INSERT INTO report_alerts (project_id, rule, sent) VALUES (?, ?, ?) ON CONFLICT (project_id, rule) DO UPDATE SET sent = excluded.sent").bind(i.appId, i.rule, now.toISOString())))
    .catch(() => undefined);
}

/**
 * The P0 items of the apps that sent something in the last 30 hours, per account, that no email told their owner
 * about in the last day. Reads the 24-hour stats of at most ALERT_APPS apps (the most recent first). Only accounts
 * with alerts on and reports not 'off'; never `skip` (accounts whose report went out this run).
 */
export async function dueAlerts(env: Env, now: Date, skip: Set<string>): Promise<Map<string, Item[]>> {
  const db = env.DB!;
  const origin = originOf(env);
  const since = new Date(now.getTime() - 30 * 3_600_000).toISOString();
  const apps = await rows<Project>(
    db,
    `SELECT ${PROJECT_COLUMNS.split(", ").map((c) => `p.${c}`).join(", ")} FROM projects p JOIN accounts a ON a.id = p.account_id WHERE p.last_event >= ? AND a.email IS NOT NULL AND a.report_alerts = 1 AND COALESCE(a.report_every, 'daily') <> 'off' ORDER BY p.last_event DESC LIMIT ${ALERT_APPS}`,
    since,
  );
  const out = new Map<string, Item[]>();
  const access = new Map<string, Awaited<ReturnType<typeof accountProjectsAccess>>>();
  for (const p of apps) {
    if (!p.account_id || !p.id || skip.has(p.account_id)) continue;
    try {
      if (!access.has(p.account_id)) access.set(p.account_id, await accountProjectsAccess(db, p.account_id, env, now));
      const acc = access.get(p.account_id)!.find((x) => x.row.id === p.id)?.access;
      if (!acc) continue;
      const s = await stats(db, p, "24h", now);
      const app = appReport(p, acc, s, origin, "daily");
      // a Free app's alert names the rule, never its pages: the item's kind and pages are Pro's
      const p0 = appItems(app, s, null, origin, now).filter((i) => i.p === 0 && (app.pro || i.rule === "silent" || i.rule === "spike"));
      if (!p0.length) continue;
      const sent = await rows<{ rule: string; sent: string }>(db, "SELECT rule, sent FROM report_alerts WHERE project_id = ?", p.id);
      const recent = new Set(sent.filter((x) => now.getTime() - Date.parse(x.sent) < 86_400_000).map((x) => x.rule));
      const fresh = p0.filter((i) => !recent.has(i.rule));
      if (fresh.length) out.set(p.account_id, [...(out.get(p.account_id) ?? []), ...fresh]);
    } catch {
      /* one app's failure skips that app */
    }
  }
  return out;
}

/** One account's alert: a report of kind "alert" whose items are the fresh P0 items only. */
async function runAlert(env: Env, accountId: string, fresh: Item[], now: Date, f: Fetch): Promise<boolean> {
  const db = env.DB!;
  const a = await db.prepare(`SELECT ${ACCOUNT_REPORT_COLUMNS} FROM accounts WHERE id = ?`).bind(accountId).first<AccountRow>();
  if (!a) return false;
  const built = await buildReport(env, a, { kind: "alert", now, model: false, fetch: f });
  if (!built) return false;
  const want = new Set(fresh.map((i) => `${i.appId}\t${i.rule}`));
  const r = { ...built.report, items: built.report.items.filter((i) => want.has(`${i.appId}\t${i.rule}`)) };
  if (!r.items.length) return false;
  const sent = await sendReport(env, r, renderReport(r), now);
  if (sent) await markAlerted(db, r.items, now);
  return sent;
}

/**
 * The hourly run. Returns what it sent, for the tests and the log. Without the database or the EMAIL binding it
 * sends nothing.
 */
export async function reportSweep(env: Env, now: Date, f: Fetch = fetch): Promise<{ reports: number; alerts: number }> {
  const db = env.DB;
  const done = { reports: 0, alerts: 0 };
  if (!db || !env.EMAIL) return done;
  await giveSlots(db, now);
  const due = await rows<AccountRow>(
    db,
    `SELECT ${ACCOUNT_REPORT_COLUMNS} FROM accounts WHERE email IS NOT NULL AND COALESCE(report_every, 'daily') <> 'off' AND report_next IS NOT NULL AND report_next <= ? ORDER BY report_next LIMIT ${SWEEP_ACCOUNTS}`,
    now.toISOString(),
  );
  const reported = new Set<string>();
  await inGroups(due, PARALLEL, async (a) => {
    if (!(await claim(db, a, now))) return;
    reported.add(a.id);
    if (await runReport(env, a, now, f)) done.reports++;
  });
  const alerts = await dueAlerts(env, now, reported);
  await inGroups([...alerts.entries()], PARALLEL, async ([id, items]) => {
    if (await runAlert(env, id, items, now, f)) done.alerts++;
  });
  if (done.reports || done.alerts) console.log(`report: ${done.reports} reports and ${done.alerts} alerts sent`);
  return done;
}

/** The daily sweep: send counts older than 3 days and alert marks older than 7 go. */
export async function reportRetention(db: D1Like, now: Date): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM report_sends WHERE day < ?").bind(new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10)),
    db.prepare("DELETE FROM report_alerts WHERE sent < ?").bind(new Date(now.getTime() - 7 * 86_400_000).toISOString()),
  ]);
}
