// What the GitHub App keeps in D1 (migrations/0013_github_app.sql): installations, linked repositories, what it did
// once per repository, what it posted per pull request, webhook deliveries, hourly review counts and Marketplace plans.
// And (migrations/0016_github_install_days.sql) how many installations were added and removed on each UTC day.
//
// Invariants:
// - Nothing here holds code, diffs, race files or tokens. A pull request's row holds ids, hashes and the short titles
//   that are already in its public comment.
// - Removing the app removes its rows: an uninstall deletes the installation, its repositories' links, pauses and
//   once-only marks and its pull-request rows at once (deleteInstallation); repositories taken out of an installation
//   go the same way.
// - The daily counts (github_install_days) hold no installation, account or repository: only a day, whether the
//   account was one of the operator's own, and two numbers. An install is counted when the installation's row is
//   made and an uninstall when it is deleted, each in the row's own transaction, so an event handled twice counts
//   once and the counts are never ahead of the rows. The count never decides whether the row is written: on a
//   database without the table the install or uninstall goes through without it (withDayCount).
// - An installation's managing account (`owner`) is written for the person whose own GitHub account the installation
//   is on (http.ts readGrant), or by the server's operator by hand (docs/github-app/SETUP.md). Being able to reach or
//   push to one of its repositories never sets it: the owner's plan decides whether its private repositories are read
//   (entitlement.ts).
// - The account that owns a linked app can always take that link away (unlinkRepo), whatever its access to the
//   repository is now; nothing but the link changes.
// - A page asks for many installations or repositories in a few statements (installationsByIds, reposByIds), never
//   one statement per row.
// - One review at a time per pull request (takeLease / releaseLease), so two events arriving together never post two
//   summary comments. A lease lasts LEASE_MS, longer than a job can live, so it is never taken from a job that still
//   runs. An event that finds the lease taken marks the row `pending` only while the lease is live, in one statement:
//   the mark is always seen by a holder.
// - A pull request's `state` (its findings and hashes) is written only by the review that holds the lease. What a
//   command or a setting changes while a review may be running has a column of its own and is written by one
//   statement (`paused`, `issue`): a pause is never lost to a review that ends after it, and a command never writes
//   back findings it read before a review saved. A request for a review that waits on the row when a pause is set
//   becomes a plain event in that statement: it was made before the pause and does not lift it.
// - A review that started and did not end leaves its row `due` (takeLease sets it, releaseLease settles it), and so
//   does one that ended waiting or could not run. The sweep reviews what has been due for DUE_AFTER_MS (duePrs).
// - What is done once per repository is claimed in one statement before it is done (claimRepoFact): two pull requests
//   opened together cannot both get the one check.
// - One pull request at a time opens issues in a repository (takeIssueTurn): two that merge together with the same
//   finding cannot both find that it has no issue and both open one.
// - A webhook delivery is handled once (claimDelivery, finishDelivery); a failed one is forgotten again
//   (forgetDelivery), and one whose job never ended can be claimed again after DELIVERY_STALE_MS, so that a redelivery
//   from GitHub's settings page runs it.

import type { D1Like, D1Stmt } from "../dashboard.js";

export interface Installation {
  id: number;
  account_id: number;
  account_login: string;
  account_type: string;
  /** "all" | "selected" repositories, or "unknown" until GitHub was asked (first seen through another event than `created`). */
  selection: string;
  /**
   * The GenClass account managing it (accounts.id), or null: the account of the person whose own GitHub account the
   * installation is on, or one the server's operator set by hand. Its plan decides whether private repositories are read.
   */
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

/** What the app has done once for a repository (github_repo_facts): each is the time it happened, or null. */
export interface RepoFacts {
  repo_id: number;
  installation_id: number;
  /** Race files were read for it: from then on every pull request gets the check. */
  evidence: string | null;
  /** The one check that says what the app reads was written. */
  intro: string | null;
  /** The one check that says a private repository needs a plan was written. */
  plan_notice: string | null;
  /** Not a fact: until when one pull request has the repository's turn to open an issue (takeIssueTurn), else null. */
  issue_turn: string | null;
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
  /** 1 while updates are paused on this pull request (the pause command), else 0. */
  paused: number;
  /** The issue opened for this pull request's findings when it merged (`issues: merge`), else null. */
  issue: number | null;
  /** Reviews and replies that wrote something on the pull request, ever. */
  reviews: number;
  lease: string | null;
  /**
   * While a review runs, what arrived meanwhile: 1 an event, 2 a request for a review by a person with write access,
   * 3 a request by the pull request's author without write access (PENDING_*).
   */
  pending: number;
  /** Since when a review is owed (it started and has not ended, ended waiting, or could not run), else null. */
  due: string | null;
  /** The UTC hour (YYYY-MM-DDTHH) `hour_reviews` counts. */
  hour: string | null;
  hour_reviews: number;
  closed: string | null;
  updated: string;
}

/**
 * Reviews one installation may run per UTC hour. A review is 5 to 15 GitHub requests of the installation's 5,000 an
 * hour and writes at most four things (a check, a comment, a review, a reply), and GitHub allows 500 content-creating
 * requests an hour: 120 keeps a busy installation under both. Only a review that reads a commit's evidence counts:
 * one that stops at a setting, or finds that no workflow run has finished yet, does not.
 */
export const REVIEWS_PER_HOUR = 120;
/**
 * Of those, the reviews a pull_request event (an open, a push) may start: the commit's test run has usually not
 * finished then, so the rest of the hour is left to the reviews test runs and people start.
 */
export const PUSH_REVIEWS_PER_HOUR = 90;
/** Of those, the reviews of pull requests whose author is not an owner, member or collaborator of the repository. */
export const OUTSIDE_REVIEWS_PER_HOUR = 60;
/** Reviews of one pull request per UTC hour, whatever started them: one pull request cannot use up the installation's hour. */
export const PR_REVIEWS_PER_HOUR = 30;
/** Reviews and replies written on one pull request, ever: past this the app stops updating it (a loop, or a bot pushing forever). */
export const REVIEWS_PER_PR = 400;
/**
 * How long a review may hold a pull request before another may take over: more than the 30 seconds the platform gives
 * a job after its response, so a lease is only ever taken over from a job that is gone.
 */
export const LEASE_MS = 35_000;
/** A delivery taken this long ago whose job never ended may be taken again: no job lives that long. */
export const DELIVERY_STALE_MS = 60_000;
/** How long a pull request is due before the sweep reviews it (a test run that takes longer is simply looked at again). */
export const DUE_AFTER_MS = 3_600_000;
export const DELIVERY_KEEP_DAYS = 7;
export const CLOSED_PR_KEEP_DAYS = 30;
export const PR_KEEP_DAYS = 180;

const INSTALLATION_COLUMNS = "id, account_id, account_login, account_type, selection, owner, suspended, created, updated";
const REPO_COLUMNS = "repo_id, installation_id, full_name, private, project_id, linked_by, linked, paused, updated";
const PR_COLUMNS = "repo_id, number, installation_id, head_sha, comment_id, check_run_id, state, paused, issue, reviews, lease, pending, due, hour, hour_reviews, closed, updated";
const FACT_COLUMNS = "repo_id, installation_id, evidence, intro, plan_notice, issue_turn, updated";

// --------------------------------------------------------------------------------------------- installations

/**
 * Run `rest` in one transaction with `count`, a statement that adds to the day's install counts. Only when the
 * database has no github_install_days (migration 0016 is not applied) `rest` runs alone: an install or an uninstall
 * never waits on, or fails for, its count. Any other failure is thrown as it is.
 */
async function withDayCount(db: D1Like, count: D1Stmt, rest: D1Stmt[]): Promise<void> {
  try {
    await db.batch([count, ...rest]);
  } catch (e) {
    if (!/no such table: github_install_days/i.test(e instanceof Error ? e.message : String(e))) throw e;
    await db.batch(rest);
  }
}

/**
 * Record an installation as GitHub describes it (created, or seen again). The managing account is kept. A `selection`
 * that is neither "all" nor "selected" is stored as "unknown" and never replaces one GitHub already gave.
 * The first time an installation is recorded, the day's install count goes up by one (github_install_days; the row
 * for the operator's own accounts when `own`), in the same transaction: seen again, it counts nothing.
 */
export async function upsertInstallation(
  db: D1Like,
  i: { id: number; accountId: number; login: string; type: string; selection: string; suspended?: boolean; own?: boolean },
  now: Date,
): Promise<void> {
  const iso = now.toISOString();
  const count = db
    .prepare(
      "INSERT INTO github_install_days (day, own, installs, uninstalls) SELECT ?1, ?2, 1, 0 WHERE NOT EXISTS (SELECT 1 FROM github_installations WHERE id = ?3) " +
        "ON CONFLICT (day, own) DO UPDATE SET installs = installs + 1",
    )
    .bind(iso.slice(0, 10), i.own ? 1 : 0, i.id);
  const upsert = db
    .prepare(
      "INSERT INTO github_installations (id, account_id, account_login, account_type, selection, suspended, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id, account_login = excluded.account_login, account_type = excluded.account_type, " +
        "selection = CASE WHEN excluded.selection = 'unknown' THEN github_installations.selection ELSE excluded.selection END, suspended = excluded.suspended, updated = excluded.updated",
    )
    .bind(i.id, i.accountId, i.login, i.type === "Organization" ? "Organization" : "User", i.selection === "all" ? "all" : i.selection === "selected" ? "selected" : "unknown", i.suspended ? iso : null, iso, iso);
  await withDayCount(db, count, [upsert]);
}

/** GitHub's answer to whether an installation covers all repositories or selected ones. */
export async function setSelection(db: D1Like, id: number, selection: "all" | "selected", now: Date): Promise<void> {
  await db.prepare("UPDATE github_installations SET selection = ?, updated = ? WHERE id = ?").bind(selection, now.toISOString(), id).run();
}

export async function installationById(db: D1Like, id: number): Promise<Installation | null> {
  return db.prepare(`SELECT ${INSTALLATION_COLUMNS} FROM github_installations WHERE id = ?`).bind(id).first<Installation>();
}

/** Ids asked for in one statement: D1 binds at most 100 values to a statement. */
const IN_CHUNK = 90;

/** `?, ?, ...` for a chunk of ids. */
const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/** The installations with these ids: one statement per IN_CHUNK ids, however many there are. Unknown ids are left out. */
export async function installationsByIds(db: D1Like, ids: number[]): Promise<Installation[]> {
  const all = [...new Set(ids)];
  const out: Installation[] = [];
  for (let i = 0; i < all.length; i += IN_CHUNK) {
    const part = all.slice(i, i + IN_CHUNK);
    const r = await db.prepare(`SELECT ${INSTALLATION_COLUMNS} FROM github_installations WHERE id IN (${marks(part.length)})`).bind(...part).all<Installation>();
    out.push(...(r.results ?? []));
  }
  return out;
}

/** The installations a GenClass account manages, by GitHub account name. */
export async function installationsOf(db: D1Like, accountId: string): Promise<Installation[]> {
  const r = await db.prepare(`SELECT ${INSTALLATION_COLUMNS} FROM github_installations WHERE owner = ? ORDER BY account_login COLLATE NOCASE, id`).bind(accountId).all<Installation>();
  return r.results ?? [];
}

/**
 * Everything kept for an installation goes with it. If it was recorded, the day's uninstall count goes up by one in
 * the same transaction (github_install_days): the row for the operator's own accounts when its account is one of
 * `ownAccounts` (lower case), else the other. The count keeps nothing of the installation.
 */
export async function deleteInstallation(db: D1Like, id: number, now: Date, ownAccounts: string[] = []): Promise<void> {
  const own = ownAccounts.length ? `CASE WHEN lower(account_login) IN (${marks(ownAccounts.length)}) THEN 1 ELSE 0 END` : "0";
  const count = db
    .prepare(
      `INSERT INTO github_install_days (day, own, installs, uninstalls) SELECT ?, ${own}, 0, 1 FROM github_installations WHERE id = ? ` +
        "ON CONFLICT (day, own) DO UPDATE SET uninstalls = uninstalls + 1",
    )
    .bind(now.toISOString().slice(0, 10), ...ownAccounts, id);
  await withDayCount(db, count, [
    db.prepare("DELETE FROM github_prs WHERE installation_id = ?").bind(id),
    db.prepare("DELETE FROM github_repos WHERE installation_id = ?").bind(id),
    db.prepare("DELETE FROM github_repo_facts WHERE installation_id = ?").bind(id),
    db.prepare("DELETE FROM github_usage WHERE installation_id = ?").bind(id),
    db.prepare("DELETE FROM github_installations WHERE id = ?").bind(id),
  ]);
}

export async function setSuspended(db: D1Like, id: number, suspended: boolean, now: Date): Promise<void> {
  await db.prepare("UPDATE github_installations SET suspended = ?, updated = ? WHERE id = ?").bind(suspended ? now.toISOString() : null, now.toISOString(), id).run();
}

/**
 * A GenClass account starts managing an installation, or with null nobody does. The one caller (http.ts readGrant)
 * calls it only after GitHub said the person connecting is the account the installation is on; that the person can
 * reach or push to a repository in it is never enough.
 */
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

/**
 * What is kept for these repositories: one statement per IN_CHUNK ids, however many there are. Most repositories have
 * no row (a row exists only for a link or a pause) and are left out.
 */
export async function reposByIds(db: D1Like, repoIds: number[]): Promise<RepoRow[]> {
  const all = [...new Set(repoIds)];
  const out: RepoRow[] = [];
  for (let i = 0; i < all.length; i += IN_CHUNK) {
    const part = all.slice(i, i + IN_CHUNK);
    const r = await db.prepare(`SELECT ${REPO_COLUMNS} FROM github_repos WHERE repo_id IN (${marks(part.length)})`).bind(...part).all<RepoRow>();
    out.push(...(r.results ?? []));
  }
  return out;
}

/** What the app has done on a repository, for the account page: whether race files were ever read, and the pull requests it wrote on. */
export interface RepoActivity {
  repo_id: number;
  /** ISO time race files were first read for it, else null (github_repo_facts.evidence). */
  evidence: string | null;
  /** Pull requests the app wrote something on, among the rows still kept (github_prs: 30 days after a close). */
  prs: number;
  /** ISO time the newest of those rows last changed, else null. */
  last: string | null;
}

/**
 * What the app has done on these repositories: one statement per IN_CHUNK ids, however many there are (the ids are
 * bound once and named by number in both halves). A repository the app has done nothing on is left out.
 */
export async function repoActivityByIds(db: D1Like, repoIds: number[]): Promise<RepoActivity[]> {
  const all = [...new Set(repoIds)];
  const out = new Map<number, RepoActivity>();
  for (let i = 0; i < all.length; i += IN_CHUNK) {
    const part = all.slice(i, i + IN_CHUNK);
    const ids = part.map((_, k) => `?${k + 1}`).join(", ");
    const r = await db
      .prepare(
        `SELECT repo_id, evidence, 0 AS prs, NULL AS last FROM github_repo_facts WHERE repo_id IN (${ids}) ` +
          `UNION ALL SELECT repo_id, NULL AS evidence, COUNT(*) AS prs, MAX(updated) AS last FROM github_prs WHERE repo_id IN (${ids}) AND reviews > 0 GROUP BY repo_id`,
      )
      .bind(...part)
      .all<RepoActivity>();
    for (const row of r.results ?? []) {
      const at = out.get(row.repo_id) ?? { repo_id: row.repo_id, evidence: null, prs: 0, last: null };
      out.set(row.repo_id, { repo_id: row.repo_id, evidence: row.evidence ?? at.evidence, prs: at.prs + Number(row.prs ?? 0), last: row.last ?? at.last });
    }
  }
  return [...out.values()];
}

/** The most linked repositories of one account a page lists (reposLinkedToAccount). */
export const MAX_LINKED_LISTED = 300;

/** The repositories linked to an app of this GenClass account, whoever made the link and whoever can reach them now. */
export async function reposLinkedToAccount(db: D1Like, accountId: string): Promise<RepoRow[]> {
  const r = await db
    .prepare(`SELECT ${REPO_COLUMNS} FROM github_repos WHERE project_id IN (SELECT id FROM projects WHERE account_id = ? AND id IS NOT NULL) ORDER BY full_name COLLATE NOCASE, repo_id LIMIT ${MAX_LINKED_LISTED}`)
    .bind(accountId)
    .all<RepoRow>();
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

/**
 * Take away a repository's link to this app, and nothing else: its pause, name and installation stay as they are. For
 * the account that owns the app, which may no longer reach the repository (linkRepo is for an account that can push to
 * it). False when the repository is not linked to this app.
 */
export async function unlinkRepo(db: D1Like, repoId: number, projectId: string, now: Date): Promise<boolean> {
  const row = await db
    .prepare("UPDATE github_repos SET project_id = NULL, linked_by = NULL, linked = NULL, updated = ? WHERE repo_id = ? AND project_id = ? RETURNING repo_id")
    .bind(now.toISOString(), repoId, projectId)
    .first();
  return !!row;
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

/** Repositories taken out of an installation: their links, pauses, once-only marks and pull-request rows go. */
export async function removeRepos(db: D1Like, installationId: number, repoIds: number[]): Promise<void> {
  const stmts: D1Stmt[] = [];
  for (const id of repoIds.slice(0, 500)) {
    stmts.push(db.prepare("DELETE FROM github_prs WHERE repo_id = ? AND installation_id = ?").bind(id, installationId));
    stmts.push(db.prepare("DELETE FROM github_repos WHERE repo_id = ? AND installation_id = ?").bind(id, installationId));
    stmts.push(db.prepare("DELETE FROM github_repo_facts WHERE repo_id = ? AND installation_id = ?").bind(id, installationId));
  }
  if (stmts.length) await db.batch(stmts);
}

// --------------------------------------------------------------------------------------------- once per repository

/** The things done once per repository (the columns of github_repo_facts that hold when). */
export type RepoFact = "evidence" | "intro" | "plan_notice";
const FACT_COLUMN: Record<RepoFact, string> = { evidence: "evidence", intro: "intro", plan_notice: "plan_notice" };

/** What the app has done once for a repository; null when nothing yet. */
export async function repoFacts(db: D1Like, repoId: number): Promise<RepoFacts | null> {
  return db.prepare(`SELECT ${FACT_COLUMNS} FROM github_repo_facts WHERE repo_id = ?`).bind(repoId).first<RepoFacts>();
}

/**
 * Claim something that happens once per repository. True for the one caller that may now do it; false when it was
 * done before (or another review claimed it at the same moment). The claim comes first and is never taken back: if
 * the write that follows fails, the thing is not done at all, which is better than done twice.
 */
export async function claimRepoFact(db: D1Like, r: { repoId: number; installationId: number }, fact: RepoFact, now: Date): Promise<boolean> {
  const col = FACT_COLUMN[fact];
  const iso = now.toISOString();
  const row = await db
    .prepare(
      `INSERT INTO github_repo_facts (repo_id, installation_id, ${col}, updated) VALUES (?1, ?2, ?3, ?3) ` +
        `ON CONFLICT (repo_id) DO UPDATE SET installation_id = excluded.installation_id, ${col} = excluded.${col}, updated = excluded.updated WHERE github_repo_facts.${col} IS NULL RETURNING repo_id`,
    )
    .bind(r.repoId, r.installationId, iso)
    .first();
  return !!row;
}

/**
 * How long a repository's turn to open an issue lasts once a request to open one was sent: long enough for GitHub's
 * list of issues to show it to the next pull request that looks.
 */
export const ISSUE_TURN_MS = 60_000;

/**
 * Take the repository's turn to open an issue (`issues: merge`). Returns the turn (the time it runs out) for the one
 * caller that may now list the issues the app opened there and open another, or null while a pull request has it. Two
 * pull requests that merge together with the same finding (a merge queue lands a group at once) would otherwise each
 * find that it has no issue and each open one. The turn runs out by itself after ISSUE_TURN_MS; a caller that sent
 * nothing gives it back at once (releaseIssueTurn).
 */
export async function takeIssueTurn(db: D1Like, r: { repoId: number; installationId: number }, now: Date): Promise<string | null> {
  const iso = now.toISOString();
  const until = new Date(now.getTime() + ISSUE_TURN_MS).toISOString();
  const row = await db
    .prepare(
      "INSERT INTO github_repo_facts (repo_id, installation_id, issue_turn, updated) VALUES (?1, ?2, ?3, ?4) " +
        "ON CONFLICT (repo_id) DO UPDATE SET installation_id = excluded.installation_id, issue_turn = excluded.issue_turn " +
        "WHERE github_repo_facts.issue_turn IS NULL OR github_repo_facts.issue_turn < ?4 RETURNING repo_id",
    )
    .bind(r.repoId, r.installationId, until, iso)
    .first();
  return row ? until : null;
}

/** Give the repository's turn back (only the holder's own): nothing was sent to GitHub, so the next pull request need not wait. */
export async function releaseIssueTurn(db: D1Like, repoId: number, turn: string): Promise<void> {
  await db.prepare("UPDATE github_repo_facts SET issue_turn = NULL WHERE repo_id = ? AND issue_turn = ?").bind(repoId, turn).run();
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

/** `pending` on a live lease: an event arrived while the review ran. */
export const PENDING_EVENT = 1;
/** `pending`: a person with write access asked for a review meanwhile (a command, Re-run on the check). */
export const PENDING_ASKED = 2;
/** `pending`: the pull request's author, without write access, asked for a review meanwhile. */
export const PENDING_AUTHOR = 3;

/**
 * Take the pull request's review lease. Returns its row when this caller now holds it (the row is marked due until the
 * review ends: releaseLease), or null when another review is running: in that case `pending` is set on the live lease
 * (PENDING_ASKED when `asked`, a request by a person with write access; PENDING_AUTHOR when `asked` is "author", a
 * request by the pull request's author without it; else PENDING_EVENT), and the holder will run once more before it
 * lets go. Of two marks the stronger stays: a request over an event, and one with write access over the author's. The
 * mark is made in one statement that only matches a live lease; when it matches nothing the holder has just let go,
 * and the lease is tried for again, so an event is never left as a mark nobody reads.
 */
export async function takeLease(db: D1Like, p: { repoId: number; number: number; installationId: number; asked?: boolean | "author" }, now: Date): Promise<PrRow | null> {
  const iso = now.toISOString();
  const until = new Date(now.getTime() + LEASE_MS).toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await db
      .prepare(
        "INSERT INTO github_prs (repo_id, number, installation_id, lease, due, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?5) " +
          "ON CONFLICT (repo_id, number) DO UPDATE SET lease = excluded.lease, installation_id = excluded.installation_id, pending = 0, due = COALESCE(github_prs.due, excluded.due) " +
          "WHERE github_prs.lease IS NULL OR github_prs.lease < ?5 " +
          `RETURNING ${PR_COLUMNS}`,
      )
      .bind(p.repoId, p.number, p.installationId, until, iso)
      .first<PrRow>();
    if (got) return got;
    const marked = await db
      .prepare(
        // PENDING_ASKED (2) is the strongest mark, then PENDING_AUTHOR (3), then PENDING_EVENT (1)
        `UPDATE github_prs SET pending = CASE WHEN pending = ${PENDING_ASKED} OR ?4 = ${PENDING_ASKED} THEN ${PENDING_ASKED} ELSE MAX(pending, ?4) END ` +
          "WHERE repo_id = ?1 AND number = ?2 AND lease IS NOT NULL AND lease >= ?3 RETURNING pending",
      )
      .bind(p.repoId, p.number, iso, p.asked === "author" ? PENDING_AUTHOR : p.asked ? PENDING_ASKED : PENDING_EVENT)
      .first();
    if (marked) return null;
  }
  // taken and let go three times between two statements: not a state to guess from; the caller's job fails and its delivery can be redelivered
  throw new Error("the pull request's lease could not be taken or marked");
}

/**
 * Let go of the lease, and settle whether a review is still owed. `lease`: the value takeLease returned, so that only
 * the holder's own lease is released. `due`: a time keeps the row due (the review ended waiting, or could not run),
 * null clears it (it ended), left out leaves the mark takeLease made (the review failed). Returns what arrived
 * meanwhile: 0 nothing, PENDING_EVENT, PENDING_ASKED or PENDING_AUTHOR (the caller reviews once more first).
 */
export async function releaseLease(db: D1Like, repoId: number, number: number, o: { lease?: string | null; due?: string | null } = {}): Promise<number> {
  const sets = ["lease = NULL"];
  const params: unknown[] = [];
  if (o.due !== undefined) {
    sets.push("due = ?");
    params.push(o.due);
  }
  params.push(repoId, number);
  let where = "repo_id = ? AND number = ?";
  if (o.lease) {
    where += " AND lease = ?";
    params.push(o.lease);
  }
  const row = await db.prepare(`UPDATE github_prs SET ${sets.join(", ")} WHERE ${where} RETURNING pending`).bind(...params).first<{ pending: number }>();
  return row?.pending ?? 0;
}

/** Mark a pull request as owed a review since `due` (the sweep runs it), or with null as owed nothing. `updated` is left alone. */
export async function setDue(db: D1Like, repoId: number, number: number, due: string | null): Promise<void> {
  await db.prepare("UPDATE github_prs SET due = ? WHERE repo_id = ? AND number = ?").bind(due, repoId, number).run();
}

/** Pull requests that have been due since before `before` and that no review holds now, longest due first. */
export async function duePrs(db: D1Like, before: Date, now: Date, limit: number): Promise<PrRow[]> {
  const r = await db
    .prepare(`SELECT ${PR_COLUMNS} FROM github_prs WHERE due IS NOT NULL AND due < ?1 AND (lease IS NULL OR lease < ?2) ORDER BY due, repo_id, number LIMIT ?3`)
    .bind(before.toISOString(), now.toISOString(), limit)
    .all<PrRow>();
  return r.results ?? [];
}

/**
 * Count one review against the pull request's own hour. False when it has had PR_REVIEWS_PER_HOUR in this UTC hour.
 */
export async function claimPrHour(db: D1Like, repoId: number, number: number, now: Date, cap = PR_REVIEWS_PER_HOUR): Promise<boolean> {
  const hour = now.toISOString().slice(0, 13);
  const row = await db
    .prepare(
      "UPDATE github_prs SET hour = ?3, hour_reviews = CASE WHEN hour = ?3 THEN hour_reviews + 1 ELSE 1 END " +
        "WHERE repo_id = ?1 AND number = ?2 AND (hour IS NULL OR hour <> ?3 OR hour_reviews < ?4) RETURNING hour_reviews",
    )
    .bind(repoId, number, hour, cap)
    .first();
  return !!row;
}

/**
 * Store what a review posted, or what a command changed. Only the given fields change, in one statement. `state` is
 * for the review that holds the lease, and nobody else; `paused` and `issue` are columns of their own, so that a
 * command and a review never write over each other. `reviewed`: something was written on the pull request, which
 * counts toward REVIEWS_PER_PR. A pause also turns a request for a review that is waiting on the row (`pending`,
 * PENDING_ASKED or PENDING_AUTHOR) into a plain event, in the same statement: that request was made before the pause,
 * so the pass it would have started must stop at the pause, not lift it. A request made after the pause marks the row
 * again.
 */
export async function savePr(
  db: D1Like,
  repoId: number,
  number: number,
  v: { headSha?: string; commentId?: number | null; checkRunId?: number | null; state?: string; paused?: boolean; issue?: number | null; reviewed?: boolean; closed?: string | null },
  now: Date,
): Promise<void> {
  const sets: string[] = ["updated = ?"];
  const params: unknown[] = [now.toISOString()];
  if (v.headSha !== undefined) { sets.push("head_sha = ?"); params.push(v.headSha); }
  if (v.commentId !== undefined) { sets.push("comment_id = ?"); params.push(v.commentId); }
  if (v.checkRunId !== undefined) { sets.push("check_run_id = ?"); params.push(v.checkRunId); }
  if (v.state !== undefined) { sets.push("state = ?"); params.push(v.state); }
  if (v.paused !== undefined) { sets.push("paused = ?"); params.push(v.paused ? 1 : 0); }
  if (v.paused === true) sets.push(`pending = MIN(pending, ${PENDING_EVENT})`);
  if (v.issue !== undefined) { sets.push("issue = ?"); params.push(v.issue); }
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

/**
 * True when this caller may handle the delivery: the first time its id is seen, or again when it was taken more than
 * DELIVERY_STALE_MS ago and its job never ended (the platform stopped it: a redelivery must be able to run it). False
 * for a delivery that is being handled or was handled.
 */
export async function claimDelivery(db: D1Like, id: string, event: string, now: Date): Promise<boolean> {
  const row = await db
    .prepare(
      "INSERT INTO github_deliveries (id, event, received) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT (id) DO UPDATE SET event = excluded.event, received = excluded.received WHERE github_deliveries.done IS NULL AND github_deliveries.received < ?4 RETURNING id",
    )
    .bind(id, event.slice(0, 60), now.toISOString(), new Date(now.getTime() - DELIVERY_STALE_MS).toISOString())
    .first();
  return !!row;
}

/** A delivery whose job ended: it is never run again. */
export async function finishDelivery(db: D1Like, id: string, now: Date): Promise<void> {
  await db.prepare("UPDATE github_deliveries SET done = ? WHERE id = ?").bind(now.toISOString(), id).run();
}

/** A delivery whose handling failed: a redelivery may run it. */
export async function forgetDelivery(db: D1Like, id: string): Promise<void> {
  await db.prepare("DELETE FROM github_deliveries WHERE id = ?").bind(id).run();
}

/**
 * What claimReview answered: "ok" when the review was counted, else the limit that refused it. "hour": the
 * installation has had REVIEWS_PER_HOUR. "share": it has had `cap`, a smaller share of the hour that the caller asked
 * under (PUSH_REVIEWS_PER_HOUR), and not yet the whole hour. "outside": pull requests by authors from outside the
 * repository have had OUTSIDE_REVIEWS_PER_HOUR.
 */
export type ReviewClaim = "ok" | "hour" | "share" | "outside";

/**
 * Count one review against the installation's hourly cap. Refused when `cap` is used up, or, for a pull request whose
 * author is from outside the repository (`outside`), when such pull requests have had OUTSIDE_REVIEWS_PER_HOUR. The
 * claim is one statement. Only a refusal reads the hour's counts, to say which limit it was (what is written on the
 * repository names that limit): the widest one that applies, so the installation's hour before a share of it.
 */
export async function claimReview(db: D1Like, installationId: number, now: Date, cap = REVIEWS_PER_HOUR, outside = false): Promise<ReviewClaim> {
  const hour = now.toISOString().slice(0, 13);
  const limit = Math.max(1, cap);
  const row = await db
    .prepare(
      "INSERT INTO github_usage (installation_id, hour, reviews, outside) VALUES (?1, ?2, 1, ?4) " +
        "ON CONFLICT (installation_id, hour) DO UPDATE SET reviews = reviews + 1, outside = outside + ?4 " +
        "WHERE github_usage.reviews < ?3 AND (?4 = 0 OR github_usage.outside < ?5) RETURNING reviews",
    )
    .bind(installationId, hour, limit, outside ? 1 : 0, OUTSIDE_REVIEWS_PER_HOUR)
    .first();
  if (row) return "ok";
  const used = await db.prepare("SELECT reviews FROM github_usage WHERE installation_id = ? AND hour = ?").bind(installationId, hour).first<{ reviews: number }>();
  const reviews = used?.reviews ?? 0;
  if (reviews >= REVIEWS_PER_HOUR) return "hour";
  if (reviews >= limit) return limit < REVIEWS_PER_HOUR ? "share" : "hour";
  return "outside";
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
 * exist. What was done once per repository (github_repo_facts) is kept: it goes with the installation or the
 * repository, never with time. Does nothing (and does not fail) on a database without the app's tables.
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
