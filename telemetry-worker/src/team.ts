// Teams: the members of an account, its invite links, and whose apps a member may read. Data only (D1); the routes
// are src/team-routes.ts, and src/auth.ts asks activeOwners when it lists or opens apps.
//
// Invariants:
// - A team is an account and the accounts it added as members (team_members). The account's owner is the first seat;
//   members take the next ones in the order they joined. How many people an account holds comes from its plan
//   (src/plans.ts accountAccess: Free 1, a paid per-seat plan the seats paid for, a grant or an open server no limit).
// - A member reads: the dashboards and stats of the owner's apps, shown with the owner's plan, and nothing else. A
//   member cannot delete or rename an app, make or turn off its private link, change forwarding, export, see billing,
//   invite or remove anyone. Those stay the owner's (src/auth.ts ownedProject).
// - A member beyond the seats (the owner lowered the quantity, or the plan ended) keeps the row and loses the access:
//   activeOwners leaves that owner out until there is a seat again. Nobody is removed by a billing change.
// - Invites are single-use links, valid 7 days; only the SHA-256 hex of the code is stored. GenClass sends no email:
//   the owner copies the link to the person. A link gives nothing until a signed-in account joins with it. Members
//   and unexpired invites together never exceed the seats when an invite is made; a join checks the seats again.
//   Expired invites go in the daily sweep (src/auth.ts authRetention).
// - Joining never merges or links accounts, and a member's own apps, plan and billing are untouched by it.

import type { Env } from "./collector.js";
import { randomBase62, sha256Hex, type D1Like } from "./dashboard.js";
import { accountAccess, PAID_PLANS, type Access } from "./plans.js";

/** The plans on sale that hold more than one person (per seat, or with no limit on people), for the upgrade message. */
const TEAM_PLANS = PAID_PLANS.filter((p) => p.per_seat === true || p.limits.seats === null)
  .map((p) => p.name)
  .join(" and ");

export const INVITE_MS = 7 * 86_400_000;
/** The code in an invite link (/join/<code>). */
export const INVITE_CODE_RE = /^[A-Za-z0-9]{32}$/;
const ID_RE = /^[A-Za-z0-9]{16,22}$/;

export interface Member {
  id: string;
  email: string | null;
  githubLogin: string | null;
  joined: string;
  /** Within the seats now: this member can open the team's dashboards. */
  active: boolean;
}

export interface Invite {
  id: string;
  created: string;
  expires: string;
}

export interface Team {
  access: Access;
  /** People the plan holds, the owner included; null: no limit. */
  seats: number | null;
  /** Seats taken: the owner and every member (unexpired invites are counted when one is made, not here). */
  used: number;
  members: Member[];
  invites: Invite[];
}

/** A failed team operation: an HTTP status, a sentence for the person, and `upgrade` when the plan is why. */
export interface TeamError {
  status: number;
  error: string;
  upgrade?: boolean;
}

const isError = (v: unknown): v is TeamError => !!v && typeof v === "object" && "error" in v && "status" in v;
export { isError as isTeamError };

/** How many members fit beside the owner (Infinity: no limit). */
const room = (seats: number | null): number => (seats === null ? Infinity : Math.max(0, seats - 1));

/** The account's team as its owner sees it: plan, seats, members in joining order and unexpired invites. */
export async function teamOf(db: D1Like, env: Env, accountId: string, now: Date): Promise<Team> {
  const access = await accountAccess(db, accountId, env, now);
  const [m, i] = await db.batch([
    db
      .prepare(
        "SELECT t.member_id AS id, t.created AS joined, a.email AS email, a.github_login AS github_login FROM team_members t JOIN accounts a ON a.id = t.member_id " +
          "WHERE t.account_id = ? ORDER BY t.created, t.member_id",
      )
      .bind(accountId),
    db.prepare("SELECT id, created, expires FROM team_invites WHERE account_id = ? AND expires > ? ORDER BY created").bind(accountId, now.toISOString()),
  ]);
  const rows = <T>(r: unknown): T[] => ((r as { results?: T[] } | null | undefined)?.results ?? []) as T[];
  const fit = room(access.seats);
  const members = rows<{ id: string; joined: string; email: string | null; github_login: string | null }>(m).map((r, n) => ({
    id: r.id,
    email: r.email,
    githubLogin: r.github_login,
    joined: r.joined,
    active: n < fit,
  }));
  return { access, seats: access.seats, used: 1 + members.length, members, invites: rows<Invite>(i) };
}

/**
 * The accounts whose apps `memberId` may read now: each team it is a member of whose plan still holds it (the owner
 * first, then members in joining order, up to the seats). Empty for an account in no team, at the cost of one query.
 */
export async function activeOwners(db: D1Like, env: Env, memberId: string, now: Date): Promise<string[]> {
  const r = await db.prepare("SELECT account_id, created FROM team_members WHERE member_id = ? ORDER BY created, account_id").bind(memberId).all<{ account_id: string; created: string }>();
  const out: string[] = [];
  for (const row of r.results ?? []) {
    const fit = room((await accountAccess(db, row.account_id, env, now)).seats);
    if (fit === Infinity) {
      out.push(row.account_id);
      continue;
    }
    if (fit === 0) continue;
    const before = await db
      .prepare("SELECT COUNT(*) AS n FROM team_members WHERE account_id = ? AND (created < ? OR (created = ? AND member_id < ?))")
      .bind(row.account_id, row.created, row.created, memberId)
      .first<{ n: number }>();
    if (Number(before?.n ?? 0) < fit) out.push(row.account_id);
  }
  return out;
}

/** `memberId` may read the apps of `ownerId` now (it is the owner, or an active member of its team). */
export async function canRead(db: D1Like, env: Env, memberId: string, ownerId: string | null | undefined, now: Date): Promise<boolean> {
  if (!ownerId) return false;
  if (ownerId === memberId) return true;
  return (await activeOwners(db, env, memberId, now)).includes(ownerId);
}

const fullError = (t: Team): TeamError =>
  t.seats !== null && t.seats <= 1
    ? { status: 403, upgrade: true, error: `the ${t.access.plan.name} plan is for one person; members come with ${TEAM_PLANS || "a paid plan"}` }
    : { status: 409, error: `every seat is taken (${t.seats} of ${t.seats}): add a seat in Manage billing, remove a member or revoke an invite` };

/**
 * A new invite link for the account's team, when its plan has a seat free for it (members and unexpired invites
 * counted). Returns the code once; only its hash is stored.
 */
export async function createInvite(db: D1Like, env: Env, accountId: string, now: Date): Promise<{ id: string; code: string; expires: string } | TeamError> {
  const t = await teamOf(db, env, accountId, now);
  if (t.members.length + t.invites.length >= room(t.seats)) return fullError(t);
  const id = randomBase62(16);
  const code = randomBase62(32);
  const expires = new Date(now.getTime() + INVITE_MS).toISOString();
  await db.prepare("INSERT INTO team_invites (id, hash, account_id, created, expires) VALUES (?, ?, ?, ?, ?)").bind(id, await sha256Hex(code), accountId, now.toISOString(), expires).run();
  return { id, code, expires };
}

/** The team an invite code opens, for the join page: its owner's label, or null for a code that is unknown or expired. */
export async function inviteOwner(db: D1Like, code: string, now: Date): Promise<{ accountId: string; email: string | null; githubLogin: string | null } | null> {
  if (!INVITE_CODE_RE.test(code)) return null;
  const r = await db
    .prepare("SELECT i.account_id AS id, a.email AS email, a.github_login AS github_login FROM team_invites i JOIN accounts a ON a.id = i.account_id WHERE i.hash = ? AND i.expires > ?")
    .bind(await sha256Hex(code), now.toISOString())
    .first<{ id: string; email: string | null; github_login: string | null }>();
  return r ? { accountId: r.id, email: r.email, githubLogin: r.github_login } : null;
}

/**
 * `memberId` joins the team an invite code opens: the member row is written and the invite is used up, in one
 * transaction. Joining a team one is already in is a success that keeps the invite for someone else.
 */
export async function joinTeam(db: D1Like, env: Env, memberId: string, code: string, now: Date): Promise<{ ownerId: string; already: boolean } | TeamError> {
  const gone: TeamError = { status: 404, error: "this invite link is not valid any more (used, revoked or older than 7 days); ask for a new one" };
  if (!INVITE_CODE_RE.test(code)) return gone;
  const hash = await sha256Hex(code);
  const inv = await db.prepare("SELECT id, account_id FROM team_invites WHERE hash = ? AND expires > ?").bind(hash, now.toISOString()).first<{ id: string; account_id: string }>();
  if (!inv) return gone;
  if (inv.account_id === memberId) return { status: 409, error: "this is your own team's invite link; send it to the person you want to add" };
  const t = await teamOf(db, env, inv.account_id, now);
  if (t.members.some((m) => m.id === memberId)) return { ownerId: inv.account_id, already: true };
  if (t.members.length >= room(t.seats)) {
    return t.seats !== null && t.seats <= 1
      ? { status: 409, error: "this team's plan has no seat for members now; ask its owner" }
      : { status: 409, error: "every seat of this team is taken; ask its owner to add one" };
  }
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO team_members (account_id, member_id, created) VALUES (?, ?, ?)").bind(inv.account_id, memberId, now.toISOString()),
    db.prepare("DELETE FROM team_invites WHERE id = ?").bind(inv.id),
  ]);
  return { ownerId: inv.account_id, already: false };
}

/** The owner removes a member, or a member leaves: true when a row went. */
export async function removeMember(db: D1Like, ownerId: string, memberId: string): Promise<boolean> {
  if (!ID_RE.test(ownerId) || !ID_RE.test(memberId)) return false;
  return !!(await db.prepare("DELETE FROM team_members WHERE account_id = ? AND member_id = ? RETURNING member_id").bind(ownerId, memberId).first());
}

/** The owner revokes an invite link: true when a row went. */
export async function revokeInvite(db: D1Like, ownerId: string, id: string): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  return !!(await db.prepare("DELETE FROM team_invites WHERE id = ? AND account_id = ? RETURNING id").bind(id, ownerId).first());
}

/** The teams `memberId` is in, for its account page: each owner's label and whether the membership is active now. */
export async function membershipsOf(db: D1Like, env: Env, memberId: string, now: Date): Promise<{ ownerId: string; email: string | null; githubLogin: string | null; joined: string; active: boolean }[]> {
  const r = await db
    .prepare(
      "SELECT t.account_id AS id, t.created AS joined, a.email AS email, a.github_login AS github_login FROM team_members t JOIN accounts a ON a.id = t.account_id " +
        "WHERE t.member_id = ? ORDER BY t.created, t.account_id",
    )
    .bind(memberId)
    .all<{ id: string; joined: string; email: string | null; github_login: string | null }>();
  const rows = r.results ?? [];
  if (!rows.length) return [];
  const active = new Set(await activeOwners(db, env, memberId, now));
  return rows.map((x) => ({ ownerId: x.id, email: x.email, githubLogin: x.github_login, joined: x.joined, active: active.has(x.id) }));
}

/** The statements that take a deleted account out of every team: its own team, its invites and its memberships. */
export function forgetTeam(db: D1Like, accountId: string): ReturnType<D1Like["prepare"]>[] {
  return [
    db.prepare("DELETE FROM team_members WHERE account_id = ? OR member_id = ?").bind(accountId, accountId),
    db.prepare("DELETE FROM team_invites WHERE account_id = ?").bind(accountId),
  ];
}
