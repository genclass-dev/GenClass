// What the GitHub App keeps in D1 (migrations/0013_github_app.sql): installations, linked repositories, what it
// posted per pull request, handled webhook deliveries, hourly review counts and Marketplace plans.
//
// Invariants:
// - Nothing here holds code, diffs, race files or tokens. A pull request's row holds ids, hashes and the short titles
//   that are already in its public comment.
// - Removing the app removes its rows: an uninstall deletes the installation, its repositories' links and pauses and
//   its pull-request rows at once (deleteInstallation); repositories taken out of an installation go the same way.
// - One review at a time per pull request (takeLease / releaseLease), so two events arriving together never post two
//   summary comments.
// - A webhook delivery is handled once (claimDelivery); a failed one is forgotten again (forgetDelivery) so that a
//   redelivery from GitHub's settings page runs it.

import type { D1Like, D1Stmt } from "../dashboard.js";

export interface Installation {
  id: number;
  account_id: number;
  account_login: string;
  account_type: string;
  selection: string;
  /** The GenClass account managing it (accounts.id), or null. */
  owner: string | null;
  suspended: string | null;
  created: string;
  updated: string;
}

export interface RepoRow {
  repo_id: number;
  installation_id: number;
  full_name: string;
  private: number;
  project_id: string | null;
  linked_by: string | null;
  linked: string | null;
  paused: number;
  updated: string;
}

export interface PrRow {
  repo_id: number;
  number: number;
  installation_id: number;
  head_sha: string;
  comment_id: number | null;
  check_run_id: number | null;
  state: string;
  reviews: number;
  lease: string | null;
  pending: number;
  closed: string | null;
  updated: string;
}

/**
 * Reviews one installation may run per UTC hour. A review is 5 to 15 GitHub requests of the installation's 5,000 an
 * hour and writes at most four things (a check, a comment, a review, a reply), and GitHub allows 500 content-creating
 * requests an hour: 120 keeps a busy installation under both.
 */
export const REVIEWS_PER_HOUR = 120;
/** Reviews of one pull request, ever: past this the app stops updating it (a loop, or a bot pushing forever). */
export const REVIEWS_PER_PR = 400;
/** How long a review may hold a pull request before another may take over. */
export const LEASE_MS = 60_000;
export const DELIVERY_KEEP_DAYS = 7;
export const CLOSED_PR_KEEP_DAYS = 30;
export const PR_KEEP_DAYS = 180;

const INSTALLATION_COLUMNS = "id, account_id, account_login, account_type, selection, owner, suspended, created, updated";
const REPO_COLUMNS = "repo_id, installation_id, full_name, private, project_id, linked_by, linked, paused, updated";
const PR_COLUMNS = "repo_id, number, installation_id, head_sha, comment_id, check_run_id, state, reviews, lease, pending, closed, updated";

// --------------------------------------------------------------------------------------------- installations

/** Record an installation as GitHub describes it (created, or seen again). The managing account is kept. */
export async function upsertInstallation(
  db: D1Like,
  i: { id: number; accountId: number; login: string; type: string; selection: string; suspended?: boolean },
  now: Date,
): Promise<void> {
  const iso = now.toISOString();
  await db
    .prepare(
      "INSERT INTO github_installations (id, account_id, account_login, account_type, selection, suspended, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id, account_login = excluded.account_login, account_type = excluded.account_type, selection = excluded.selection, suspended = excluded.suspended, updated = excluded.updated",
    )
    .bind(i.id, i.accountId, i.login, i.type === "Organization" ? "Organization" : "User", i.selection === "all" ? "all" : "selected", i.suspended ? iso : null, iso, iso)
    .run();
}

export async function installationById(db: D1Like, id: number): Promise<Installation | null> {
  return db.prepare(`SELECT ${INSTALLATION_COLUMNS} FROM github_installations WHERE id = ?`).bind(id).first<Installation>();
}

/** The installations a GenClass account manages, by GitHub account name. */
export async function installationsOf(db: D1Like, accountId: string): Promise<Installation[]> {
  const r = await db.prepare(`SELECT ${INSTALLATION_COLUMNS} FROM github_installations WHERE owner = ? ORDER BY account_login COLLATE NOCASE, id`).bind(accountId).all<Installation>();
  return r.results ?? [];
}

/** Everything kept for an installation goes with it. */
export async function deleteInstallation(db: D1Like, id: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM github_prs WHERE installation_id = ?").bind(id),
    db.prepare("DELETE FROM github_repos WHERE installation_id = ?").bind(id),
    db.prepare("DELETE FROM github_usage WHERE installation_id = ?").bind(id),
    db.prepare("DELETE FROM github_installations WHERE id = ?").bind(id),
  ]);
}

export async function setSuspended(db: D1Like, id: number, suspended: boolean, now: Date): Promise<void> {
  await db.prepare("UPDATE github_installations SET suspended = ?, updated = ? WHERE id = ?").bind(suspended ? now.toISOString() : null, now.toISOString(), id).run();
}

/** A GenClass account starts managing an installation (after GitHub confirmed it can reach it). */
export async function setInstallationOwner(db: D1Like, id: number, accountId: string | null, now: Date): Promise<void> {
  await db.prepare("UPDATE github_installations SET owner = ?, updated = ? WHERE id = ?").bind(accountId, now.toISOString(), id).run();
}

// --------------------------------------------------------------------------------------------- repositories

export async function repoById(db: D1Like, repoId: number): Promise<RepoRow | null> {
  return db.prepare(`SELECT ${REPO_COLUMNS} FROM github_repos WHERE repo_id = ?`).bind(repoId).first<RepoRow>();
}

export async function reposOfInstallation(db: D1Like, installationId: number): Promise<RepoRow[]> {
  const r = await db.prepare(`SELECT ${REPO_COLUMNS} FROM github_repos WHERE installation_id = ? ORDER BY full_name COLLATE NOCASE`).bind(installationId).all<RepoRow>();
  return r.results ?? [];
}

/** Keep a repository's name, visibility and installation current (a row is made only when there is something to keep). */
export async function touchRepo(db: D1Like, r: { repoId: number; installationId: number; fullName: string; private: boolean }, now: Date): Promise<void> {
  await db
    .prepare("UPDATE github_repos SET installation_id = ?1, full_name = ?2, private = ?3, updated = ?4 WHERE repo_id = ?5 AND (installation_id <> ?1 OR full_name <> ?2 OR private <> ?3)")
    .bind(r.installationId, r.fullName, r.private ? 1 : 0, now.toISOString(), r.repoId)
    .run();
}

/** Link a repository to a GenClass app (or, with projectId null, take the link away). */
export async function linkRepo(
  db: D1Like,
  r: { repoId: number; installationId: number; fullName: string; private: boolean; projectId: string | null; accountId: string },
  now: Date,
): Promise<void> {
  const iso = now.toISOString();
  await db
    .prepare(
      "INSERT INTO github_repos (repo_id, installation_id, full_name, private, project_id, linked_by, linked, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (repo_id) DO UPDATE SET installation_id = excluded.installation_id, full_name = excluded.full_name, private = excluded.private, project_id = excluded.project_id, linked_by = excluded.linked_by, linked = excluded.linked, updated = excluded.updated",
    )
    .bind(r.repoId, r.installationId, r.fullName, r.private ? 1 : 0, r.projectId, r.projectId ? r.accountId : null, r.projectId ? iso : null, iso)
    .run();
}

/** Pause or resume reviews of a repository. */
export async function pauseRepo(db: D1Like, r: { repoId: number; installationId: number; fullName: string; private: boolean; paused: boolean }, now: Date): Promise<void> {
  const iso = now.toISOString();
  await db
    .prepare(
      "INSERT INTO github_repos (repo_id, installation_id, full_name, private, paused, updated) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (repo_id) DO UPDATE SET installation_id = excluded.installation_id, full_name = excluded.full_name, private = excluded.private, paused = excluded.paused, updated = excluded.updated",
    )
    .bind(r.repoId, r.installationId, r.fullName, r.private ? 1 : 0, r.paused ? 1 : 0, iso)
    .run();
}

/** Repositories taken out of an installation: their links, pauses and pull-request rows go. */
export async function removeRepos(db: D1Like, installationId: number, repoIds: number[]): Promise<void> {
  const stmts: D1Stmt[] = [];
  for (const id of repoIds.slice(0, 500)) {
    stmts.push(db.prepare("DELETE FROM github_prs WHERE repo_id = ? AND installation_id = ?").bind(id, installationId));
    stmts.push(db.prepare("DELETE FROM github_repos WHERE repo_id = ? AND installation_id = ?").bind(id, installationId));
  }
  if (stmts.length) await db.batch(stmts);
}

/**
 * A deleted GenClass app leaves no repository linked to it (src/auth.ts deleteProject calls this after its own batch,
 * on its own, so a database without the app's tables never fails a deletion).
 */
export async function unlinkProject(db: D1Like, projectId: string): Promise<void> {
  await db.prepare("UPDATE github_repos SET project_id = NULL, linked_by = NULL, linked = NULL WHERE project_id = ?").bind(projectId).run();
}

/**
 * A deleted GenClass account (src/auth.ts deleteAccount, after its own batch): the links it made and the links to
 * apps that went with it are taken away, and the installations it managed are managed by nobody. The app keeps
 * reviewing those repositories from their race files; only the account's part is gone.
 */
export async function forgetAccount(db: D1Like, accountId: string): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE github_repos SET project_id = NULL, linked_by = NULL, linked = NULL WHERE linked_by = ? OR (project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects WHERE id IS NOT NULL))")
      .bind(accountId),
    db.prepare("UPDATE github_installations SET owner = NULL WHERE owner = ?").bind(accountId),
  ]);
}

// --------------------------------------------------------------------------------------------- pull requests

export async function prRow(db: D1Like, repoId: number, number: number): Promise<PrRow | null> {
  return db.prepare(`SELECT ${PR_COLUMNS} FROM github_prs WHERE repo_id = ? AND number = ?`).bind(repoId, number).first<PrRow>();
}

/**
 * Take the pull request's review lease. Returns its row when this caller now holds it, or null when another review is
 * running: in that case `pending` is set, and the holder will run once more before it lets go.
 */
export async function takeLease(db: D1Like, p: { repoId: number; number: number; installationId: number }, now: Date): Promise<PrRow | null> {
  const iso = now.toISOString();
  const until = new Date(now.getTime() + LEASE_MS).toISOString();
  const got = await db
    .prepare(
      "INSERT INTO github_prs (repo_id, number, installation_id, lease, updated) VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT (repo_id, number) DO UPDATE SET lease = excluded.lease, installation_id = excluded.installation_id, pending = 0 WHERE github_prs.lease IS NULL OR github_prs.lease < ?5 " +
        `RETURNING ${PR_COLUMNS}`,
    )
    .bind(p.repoId, p.number, p.installationId, until, iso)
    .first<PrRow>();
  if (got) return got;
  await db.prepare("UPDATE github_prs SET pending = 1 WHERE repo_id = ? AND number = ?").bind(p.repoId, p.number).run();
  return null;
}

/** Let go of the lease. Returns true when something arrived meanwhile (the caller reviews once more first). */
export async function releaseLease(db: D1Like, repoId: number, number: number): Promise<boolean> {
  const row = await db.prepare("UPDATE github_prs SET lease = NULL WHERE repo_id = ? AND number = ? RETURNING pending").bind(repoId, number).first<{ pending: number }>();
  return !!row?.pending;
}

/** Keep the lease for another pass and clear the pending mark (the holder goes round again). */
export async function renewLease(db: D1Like, repoId: number, number: number, now: Date): Promise<void> {
  await db.prepare("UPDATE github_prs SET lease = ?, pending = 0 WHERE repo_id = ? AND number = ?").bind(new Date(now.getTime() + LEASE_MS).toISOString(), repoId, number).run();
}

/** Store what a review posted. Only the given fields change. */
export async function savePr(
  db: D1Like,
  repoId: number,
  number: number,
  v: { headSha?: string; commentId?: number | null; checkRunId?: number | null; state?: string; reviewed?: boolean; closed?: string | null },
  now: Date,
): Promise<void> {
  const sets: string[] = ["updated = ?"];
  const params: unknown[] = [now.toISOString()];
  if (v.headSha !== undefined) { sets.push("head_sha = ?"); params.push(v.headSha); }
  if (v.commentId !== undefined) { sets.push("comment_id = ?"); params.push(v.commentId); }
  if (v.checkRunId !== undefined) { sets.push("check_run_id = ?"); params.push(v.checkRunId); }
  if (v.state !== undefined) { sets.push("state = ?"); params.push(v.state); }
  if (v.closed !== undefined) { sets.push("closed = ?"); params.push(v.closed); }
  if (v.reviewed) sets.push("reviews = reviews + 1");
  await db.prepare(`UPDATE github_prs SET ${sets.join(", ")} WHERE repo_id = ? AND number = ?`).bind(...params, repoId, number).run();
}

/** A closed pull request: its row stays CLOSED_PR_KEEP_DAYS (a reopen finds its comment), then the sweep takes it. */
export async function closePr(db: D1Like, repoId: number, number: number, now: Date): Promise<void> {
  await db.prepare("UPDATE github_prs SET closed = ?, updated = ? WHERE repo_id = ? AND number = ?").bind(now.toISOString(), now.toISOString(), repoId, number).run();
}

/** Open pull requests of a repository whose stored review is about this head commit. */
export async function prsAtSha(db: D1Like, repoId: number, sha: string): Promise<PrRow[]> {
  const r = await db.prepare(`SELECT ${PR_COLUMNS} FROM github_prs WHERE repo_id = ? AND head_sha = ? AND closed IS NULL LIMIT 5`).bind(repoId, sha).all<PrRow>();
  return r.results ?? [];
}

// --------------------------------------------------------------------------------------------- deliveries, usage

/** True the first time a delivery id is seen; false for a repeat. */
export async function claimDelivery(db: D1Like, id: string, event: string, now: Date): Promise<boolean> {
  const row = await db.prepare("INSERT INTO github_deliveries (id, event, received) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING id").bind(id, event.slice(0, 60), now.toISOString()).first();
  return !!row;
}

/** A delivery whose handling failed: a redelivery may run it. */
export async function forgetDelivery(db: D1Like, id: string): Promise<void> {
  await db.prepare("DELETE FROM github_deliveries WHERE id = ?").bind(id).run();
}

/** Count one review against the installation's hourly cap. False when the cap is used up. */
export async function claimReview(db: D1Like, installationId: number, now: Date, cap = REVIEWS_PER_HOUR): Promise<boolean> {
  const hour = now.toISOString().slice(0, 13);
  const row = await db
    .prepare(
      "INSERT INTO github_usage (installation_id, hour, reviews) VALUES (?1, ?2, 1) ON CONFLICT (installation_id, hour) DO UPDATE SET reviews = reviews + 1 WHERE github_usage.reviews < ?3 RETURNING reviews",
    )
    .bind(installationId, hour, cap)
    .first();
  return !!row;
}

// --------------------------------------------------------------------------------------------- Marketplace

export interface MarketplaceRow {
  account_id: number;
  login: string;
  plan_id: number;
  plan_name: string;
  monthly_cents: number;
  unit_count: number | null;
  free_trial_ends: string | null;
  pending: string | null;
  updated: string;
}

export async function marketplaceOf(db: D1Like, githubAccountId: number): Promise<MarketplaceRow | null> {
  return db
    .prepare("SELECT account_id, login, plan_id, plan_name, monthly_cents, unit_count, free_trial_ends, pending, updated FROM github_marketplace WHERE account_id = ?")
    .bind(githubAccountId)
    .first<MarketplaceRow>();
}

export async function setMarketplace(
  db: D1Like,
  m: { accountId: number; login: string; planId: number; planName: string; monthlyCents: number; unitCount: number | null; freeTrialEnds: string | null; pending: string | null },
  now: Date,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO github_marketplace (account_id, login, plan_id, plan_name, monthly_cents, unit_count, free_trial_ends, pending, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (account_id) DO UPDATE SET login = excluded.login, plan_id = excluded.plan_id, plan_name = excluded.plan_name, monthly_cents = excluded.monthly_cents, unit_count = excluded.unit_count, free_trial_ends = excluded.free_trial_ends, pending = excluded.pending, updated = excluded.updated",
    )
    .bind(m.accountId, m.login, m.planId, m.planName.slice(0, 80), m.monthlyCents, m.unitCount, m.freeTrialEnds, m.pending, now.toISOString())
    .run();
}

export async function setMarketplacePending(db: D1Like, githubAccountId: number, pending: string | null, now: Date): Promise<void> {
  await db.prepare("UPDATE github_marketplace SET pending = ?, updated = ? WHERE account_id = ?").bind(pending, now.toISOString(), githubAccountId).run();
}

export async function deleteMarketplace(db: D1Like, githubAccountId: number): Promise<void> {
  await db.prepare("DELETE FROM github_marketplace WHERE account_id = ?").bind(githubAccountId).run();
}

// --------------------------------------------------------------------------------------------- retention

/**
 * Daily (index.ts): handled delivery ids older than DELIVERY_KEEP_DAYS, hourly counts older than 2 days, rows of pull
 * requests closed more than CLOSED_PR_KEEP_DAYS ago or untouched for PR_KEEP_DAYS, and links to apps that no longer
 * exist. Does nothing (and does not fail) on a database without the app's tables.
 */
export async function githubRetention(db: D1Like, now: Date): Promise<void> {
  const day = 86_400_000;
  const ago = (days: number): string => new Date(now.getTime() - days * day).toISOString();
  await db.batch([
    db.prepare("DELETE FROM github_deliveries WHERE received < ?").bind(ago(DELIVERY_KEEP_DAYS)),
    db.prepare("DELETE FROM github_usage WHERE hour < ?").bind(ago(2).slice(0, 13)),
    db.prepare("DELETE FROM github_prs WHERE (closed IS NOT NULL AND closed < ?) OR updated < ?").bind(ago(CLOSED_PR_KEEP_DAYS), ago(PR_KEEP_DAYS)),
    db.prepare("UPDATE github_repos SET project_id = NULL, linked_by = NULL, linked = NULL WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects WHERE id IS NOT NULL)"),
    db.prepare("DELETE FROM github_repos WHERE project_id IS NULL AND paused = 0"),
    db.prepare("UPDATE github_installations SET owner = NULL WHERE owner IS NOT NULL AND owner NOT IN (SELECT id FROM accounts)"),
  ]);
}
