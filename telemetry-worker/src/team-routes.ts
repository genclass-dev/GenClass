// Routes for teams (src/team.ts). Checked after the billing routes and before the account routes; null for any other
// path.
//
//   GET    /api/team                        browser session; the plan, the seats, the members, the open invites and
//                                            the teams this account is a member of
//   POST   /api/team/invites                browser session + Origin; {id, url, expires}: a single-use link, shown once
//   DELETE /api/team/invites/<id>           browser session + Origin; revoke an invite link
//   DELETE /api/team/members/<account id>   browser session + Origin; the owner removes a member
//   DELETE /api/team/memberships/<account id>  browser session + Origin; a member leaves that owner's team
//   POST   /api/team/join {code}            browser session + Origin; join the team the invite code opens
//   GET    /account/join/<code>             the invite page: sign in (or up) first, then Join
//
// A command line session (the CLI's bearer token) is refused on every route here, like billing: who is in a team is
// the browser's. Making an invite and joining take AUTH_LIMIT's budget per account. The invite page says whose team
// the link opens only to a signed-in visitor, and nothing about a code that is unknown, used or expired beyond that.

import { accountContext, fail, page, readJson, redirect, webSession, type C } from "./auth.js";
import { joinPage } from "./account-pages.js";
import { browserRead, browserWrite, overBudget, tooMany } from "./billing.js";
import type { Env, HandleOptions } from "./collector.js";
import { json } from "./http.js";
import { createInvite, INVITE_CODE_RE, inviteOwner, isTeamError, joinTeam, membershipsOf, removeMember, revokeInvite, teamOf, type TeamError } from "./team.js";

const method = (): Response => fail(405, "method not allowed");
const noContent = (): Response => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
const label = (x: { email: string | null; githubLogin: string | null }): string => x.email ?? (x.githubLogin ? `@${x.githubLogin}` : "a GenClass account");

function teamFail(c: C, e: TeamError): Response {
  const url = `${c.cfg.origin}/account/billing`;
  return json(e.status, { ok: false, error: e.upgrade ? `${e.error}; see the plans at ${url}` : e.error, ...(e.upgrade ? { upgrade_url: url } : {}) });
}

export async function routeTeam(request: Request, url: URL, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  const invite = /^\/api\/team\/invites(?:\/([^/]+))?$/.exec(path);
  const member = /^\/api\/team\/members\/([^/]+)$/.exec(path);
  const membership = /^\/api\/team\/memberships\/([^/]+)$/.exec(path);
  const join = /^\/account\/join\/([^/]+)$/.exec(path);
  if (path !== "/api/team" && path !== "/api/team/join" && !invite && !member && !membership && !join) return null;
  const c = accountContext(request, url, env, opts);
  if (!c) return null; // the account routes answer "unavailable"
  const m = request.method;
  const get = m === "GET" || m === "HEAD";

  if (join) {
    if (!get) return method();
    const code = join[1]!;
    if (!INVITE_CODE_RE.test(code)) return page(404, (n) => joinPage(n, { state: "gone" }));
    const a = await webSession(c);
    if (!a) return redirect(`/login?next=${encodeURIComponent(`/account/join/${code}`)}`);
    const owner = await inviteOwner(c.db, code, c.now);
    if (!owner) return page(404, (n) => joinPage(n, { state: "gone" }));
    if (owner.accountId === a.account.id) return page(200, (n) => joinPage(n, { state: "own" }));
    return page(200, (n) => joinPage(n, { state: "ask", code, owner: label(owner), me: label({ email: a.account.email, githubLogin: a.account.github_login }) }));
  }

  if (path === "/api/team") {
    if (!get) return method();
    const a = await browserRead(c);
    if (a instanceof Response) return a;
    const t = await teamOf(c.db, env, a.account.id, c.now);
    const memberships = await membershipsOf(c.db, env, a.account.id, c.now);
    return json(200, {
      plan: t.access.plan.id,
      seats: t.seats,
      used: t.used,
      members: t.members.map((x) => ({ id: x.id, email: x.email, github_login: x.githubLogin, joined: x.joined, active: x.active })),
      invites: t.invites,
      memberships: memberships.map((x) => ({ owner: x.ownerId, email: x.email, github_login: x.githubLogin, joined: x.joined, active: x.active })),
    });
  }

  if (path === "/api/team/join") {
    if (m !== "POST") return method();
    const a = await browserWrite(c, "a team can be joined");
    if (a instanceof Response) return a;
    const body = await readJson(c, 1024);
    if (body instanceof Response) return body;
    if (await overBudget(env.AUTH_LIMIT, "team-join", a.account.id)) return tooMany();
    const r = await joinTeam(c.db, env, a.account.id, typeof body.code === "string" ? body.code : "", c.now);
    if (isTeamError(r)) return teamFail(c, r);
    return json(200, { ok: true, already: r.already, next: "/account" });
  }

  if (invite) {
    const id = invite[1] ?? null;
    if (id === null) {
      if (m !== "POST") return method();
      const a = await browserWrite(c, "an invite link can be made");
      if (a instanceof Response) return a;
      const body = await readJson(c, 1024);
      if (body instanceof Response) return body;
      if (await overBudget(env.AUTH_LIMIT, "team-invite", a.account.id)) return tooMany();
      const r = await createInvite(c.db, env, a.account.id, c.now);
      if (isTeamError(r)) return teamFail(c, r);
      return json(201, { id: r.id, url: `${c.cfg.origin}/account/join/${r.code}`, expires: r.expires });
    }
    if (m !== "DELETE") return method();
    const a = await browserWrite(c, "an invite link can be revoked");
    if (a instanceof Response) return a;
    return (await revokeInvite(c.db, a.account.id, id)) ? noContent() : fail(404, "no such invite link");
  }

  if (member) {
    if (m !== "DELETE") return method();
    const a = await browserWrite(c, "a member can be removed");
    if (a instanceof Response) return a;
    return (await removeMember(c.db, a.account.id, member[1]!)) ? noContent() : fail(404, "no such member");
  }

  if (membership) {
    if (m !== "DELETE") return method();
    const a = await browserWrite(c, "a team can be left");
    if (a instanceof Response) return a;
    return (await removeMember(c.db, membership[1]!, a.account.id)) ? noContent() : fail(404, "you are not a member of that team");
  }
  return fail(404, "not found");
}
