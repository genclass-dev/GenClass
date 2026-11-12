import { beforeEach, describe, expect, it } from "vitest";
import { authRetention } from "../src/auth.js";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { resetStripeCache } from "../src/stripe.js";
import { activeOwners, INVITE_MS } from "../src/team.js";
import { advance, call, cliToken, createApp, detection, GENCLASS_PORTAL, now, resetClock, sendBatch, setPlan, setup, signedIn, WEBHOOK_SECRET } from "./account-helpers.js";

// Teams on the real plans (billing/plans.json version 3; src/team.ts, src/team-routes.ts): Free is one person, Team
// holds the seats paid for (the owner first, then members in joining order), a grant has no seat count. Members read
// the owner's dashboards with the owner's plan and change nothing.

const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL };
const PLANS_URL = "https://genclass.dev/account/billing";

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
});

const text = async (r: Promise<Response> | Response) => (await r).text();
const json = async (r: Promise<Response> | Response) => (await (await r).json()) as any;
/** A paid Team account with `seats` seats (as the webhook leaves it). */
const team = (sql: ReturnType<typeof setup>["sql"], accountId: string, seats: number) =>
  setPlan(sql, accountId, "team", { stripe_mode: "live", seats, subscription_id: "sub_t000000001", subscription_status: "active", current_period_end: "2026-11-13T12:00:00.000Z" });
/** An invite link's code, made by `cookie`'s account. */
async function invite(env: ReturnType<typeof setup>["env"], cookie: string): Promise<{ id: string; code: string; url: string }> {
  const r = await call(env, "POST", "/api/team/invites", { body: {}, cookie });
  expect(r.status).toBe(201);
  const j = (await r.json()) as { id: string; url: string; expires: string };
  expect(j.url).toMatch(/^https:\/\/genclass\.dev\/account\/join\/[A-Za-z0-9]{32}$/);
  return { id: j.id, url: j.url, code: j.url.split("/").pop()! };
}
const join = (env: ReturnType<typeof setup>["env"], cookie: string, code: string) => call(env, "POST", "/api/team/join", { body: { code }, cookie });

describe("invite links: who can make one, and how many", () => {
  it("Free is one person: no invite, a 403 that says where the plans are; the team answer says 1 of 1", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie } = await signedIn(env);
    const r = await call(env, "POST", "/api/team/invites", { body: {}, cookie });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({
      ok: false,
      error: `the Free plan is for one person; members come with a plan sold per developer; see the plans at ${PLANS_URL}`,
      upgrade_url: PLANS_URL,
    });
    expect(sql.rows("SELECT id FROM team_invites")).toEqual([]);
    expect(await json(call(env, "GET", "/api/team", { cookie }))).toEqual({ plan: "free", seats: 1, used: 1, members: [], invites: [], memberships: [] });
  });

  it("Team: members and unused invites never pass the seats; the link is shown once and only its hash is stored", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    team(sql, account.id, 3);
    const a = await invite(env, cookie);
    const b = await invite(env, cookie);
    const full = await call(env, "POST", "/api/team/invites", { body: {}, cookie });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ ok: false, error: "every seat is taken (3 of 3): add a seat in Manage billing, remove a member or revoke an invite" });
    const stored = JSON.stringify(sql.rows("SELECT * FROM team_invites"));
    expect(stored).not.toContain(a.code);
    expect(stored).not.toContain(b.code);
    const t = await json(call(env, "GET", "/api/team", { cookie }));
    expect(t).toMatchObject({ plan: "team", seats: 3, used: 1, members: [] });
    expect(t.invites.map((x: any) => x.id)).toEqual([a.id, b.id]);
    expect(JSON.stringify(t)).not.toContain(a.code);
    // revoking one frees its place
    expect((await call(env, "DELETE", `/api/team/invites/${a.id}`, { cookie })).status).toBe(204);
    expect((await call(env, "DELETE", `/api/team/invites/${a.id}`, { cookie })).status).toBe(404);
    await invite(env, cookie);
    // a Team with one seat has no place for a member either, and the message says what to do
    team(sql, account.id, 1);
    const one = await call(env, "POST", "/api/team/invites", { body: {}, cookie });
    expect(one.status).toBe(403);
    expect((await one.json()).upgrade_url).toBe(PLANS_URL);
  });

  it("only the browser session with our Origin: a CLI session and a cross-origin post are refused, a signed-out one is 401", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    team(sql, account.id, 3);
    const bearer = await cliToken(env, cookie);
    expect((await call(env, "POST", "/api/team/invites", { body: {}, bearer, origin: null })).status).toBe(403);
    expect((await call(env, "GET", "/api/team", { bearer, origin: null })).status).toBe(403);
    expect((await call(env, "POST", "/api/team/invites", { body: {}, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(env, "POST", "/api/team/invites", { body: {}, cookie, origin: null })).status).toBe(403);
    expect((await call(env, "POST", "/api/team/invites", { body: {} })).status).toBe(401);
    expect((await call(env, "GET", "/api/team", {})).status).toBe(401);
    expect(sql.rows("SELECT id FROM team_invites")).toEqual([]);
  });
});

describe("joining: the invite page, single use, 7 days", () => {
  it("signed out it leads through sign-in and back; signed in it asks; joining uses the link up", async () => {
    const { env, sql } = setup(LIVE);
    const owner = await signedIn(env, "ada@example.com");
    team(sql, owner.account.id, 3);
    const inv = await invite(env, owner.cookie);
    const path = `/account/join/${inv.code}`;
    const out = await call(env, "GET", path, {});
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe(`/login?next=${encodeURIComponent(path)}`);
    // the owner opening their own link is told to send it on
    expect(await text(call(env, "GET", path, { cookie: owner.cookie }))).toContain("This is your own team&#39;s invite link");
    expect((await join(env, owner.cookie, inv.code)).status).toBe(409);
    const bob = await signedIn(env, "bob@example.com");
    const page = await text(call(env, "GET", path, { cookie: bob.cookie }));
    expect(page).toContain("<h1>Join the team of ada@example.com</h1>");
    expect(page).toContain("You are signed in as <b>bob@example.com</b>.");
    const r = await join(env, bob.cookie, inv.code);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, already: false, next: "/account" });
    expect(sql.rows("SELECT account_id, member_id FROM team_members")).toEqual([{ account_id: owner.account.id, member_id: bob.account.id }]);
    expect(sql.rows("SELECT id FROM team_invites")).toEqual([]);
    // used up: the page and the join both say so, to anyone
    const carol = await signedIn(env, "carol@example.com");
    const gone = await call(env, "GET", path, { cookie: carol.cookie });
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain("This invite link does not work");
    expect((await join(env, carol.cookie, inv.code)).status).toBe(404);
    // joining a team one is already in keeps the new link for someone else
    const again = await invite(env, owner.cookie);
    expect(await json(join(env, bob.cookie, again.code))).toEqual({ ok: true, already: true, next: "/account" });
    expect(sql.rows("SELECT id FROM team_invites")).toHaveLength(1);
    // a code that is not one, a cross-origin post and a signed-out post
    expect((await call(env, "GET", "/account/join/nope", { cookie: carol.cookie })).status).toBe(404);
    expect((await join(env, carol.cookie, "x".repeat(32))).status).toBe(404);
    expect((await call(env, "POST", "/api/team/join", { body: { code: again.code }, cookie: carol.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(env, "POST", "/api/team/join", { body: { code: again.code } })).status).toBe(401);
  });

  it("a link older than 7 days does not work and goes in the daily sweep; a team with no seat left refuses the join", async () => {
    const { env, sql } = setup(LIVE);
    const owner = await signedIn(env, "ada@example.com");
    team(sql, owner.account.id, 2);
    const inv = await invite(env, owner.cookie);
    const bob = await signedIn(env, "bob@example.com");
    advance(INVITE_MS + 1000);
    expect((await join(env, bob.cookie, inv.code)).status).toBe(404);
    expect(sql.rows("SELECT id FROM team_invites")).toHaveLength(1);
    await authRetention(sql.api, now());
    expect(sql.rows("SELECT id FROM team_invites")).toEqual([]);
    // the seats went down after the invite was made
    const late = await invite(env, owner.cookie);
    team(sql, owner.account.id, 1);
    const r = await join(env, bob.cookie, late.code);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("this team's plan has no seat for members now; ask its owner");
    expect(sql.rows("SELECT member_id FROM team_members")).toEqual([]);
  });
});

describe("a member reads the owner's dashboards with the owner's plan, and changes nothing", () => {
  const joined = async () => {
    const t = setup(LIVE);
    const owner = await signedIn(t.env, "ada@example.com");
    team(t.sql, owner.account.id, 3);
    const app = await createApp(t.env, owner.cookie, "Shop");
    const view = { t: "interactions", seq: 1, at: 10, view: 1, route: "/pricing", start: true, visit: "0123456789abcdef", entry: true, device: "mobile", browser: "Safari", os: "iOS", returning: false };
    await sendBatch(t.env, app.token, [view, ...detection()]);
    const bob = await signedIn(t.env, "bob@example.com");
    expect((await join(t.env, bob.cookie, (await invite(t.env, owner.cookie)).code)).status).toBe(200);
    return { ...t, owner, bob, app };
  };

  it("the app is in the member's list (marked shared), opens, and its stats have Team's analytics and 90 days", async () => {
    const { env, owner, bob, app } = await joined();
    const me = await json(call(env, "GET", "/api/me", { cookie: bob.cookie }));
    expect(me.projects).toMatchObject([{ id: app.id, name: "Shop", shared: true }]);
    // the owner's own list has no such mark
    expect((await json(call(env, "GET", "/api/me", { cookie: owner.cookie }))).projects[0].shared).toBeUndefined();
    expect(await text(call(env, "GET", "/account", { cookie: bob.cookie }))).toContain("<span>Team of ada@example.com</span>");
    const page = await call(env, "GET", `/account/apps/${app.id}`, { cookie: bob.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Shop");
    // no forwarding or export section: those are the owner's
    expect(html).not.toContain('id="forwarding"');
    expect(html).not.toContain('id="export"');
    const st = await json(call(env, "GET", `/api/account/projects/${app.id}/stats?range=90d`, { cookie: bob.cookie }));
    expect(st.range).toBe("90d");
    expect(st.locked).toBeUndefined();
    expect(st.totals.ix_views).toBe(1);
    expect(st.totals.detections).toBe(1);
    // the member's own account is still Free: its own app shows 7 days and no analytics
    const own = await createApp(env, bob.cookie, "Mine");
    const mine = await json(call(env, "GET", `/api/account/projects/${own.id}/stats?range=90d`, { cookie: bob.cookie }));
    expect(mine.range).toBe("7d");
    expect(mine.locked.analytics.plan).toBe("Team");
  });

  it("every write and every paid setting stays the owner's: delete, private link, funnels, forwarding, export, invites", async () => {
    const { env, sql, owner, bob, app } = await joined();
    const c = { cookie: bob.cookie };
    expect((await call(env, "DELETE", `/api/account/projects/${app.id}`, { ...c, body: { confirm: "delete" } })).status).toBe(404);
    expect((await call(env, "POST", `/api/account/projects/${app.id}/link`, { ...c, body: {} })).status).toBe(404);
    expect((await call(env, "PUT", `/api/account/projects/${app.id}/funnels`, { ...c, body: { funnels: [] } })).status).toBe(404);
    expect((await call(env, "GET", `/api/account/projects/${app.id}/integrations`, c)).status).toBe(404);
    expect((await call(env, "GET", `/api/account/projects/${app.id}/events`, c)).status).toBe(404);
    // the member's own team is Free's: no invites, and it cannot remove the owner's members
    expect((await call(env, "POST", "/api/team/invites", { ...c, body: {} })).status).toBe(403);
    expect((await call(env, "DELETE", `/api/team/members/${bob.account.id}`, c)).status).toBe(404);
    expect(sql.rows("SELECT name FROM projects WHERE id = ?", app.id)).toEqual([{ name: "Shop" }]);
    // the member's billing answer is its own
    expect(await json(call(env, "GET", "/api/billing", c))).toMatchObject({ plan: "free", access: null, seats: 1 });
    // the owner's page lists the member; the member's lists the team it is in
    const page = await text(call(env, "GET", "/account/billing", { cookie: owner.cookie }));
    expect(page).toContain('<span class="aside">2 of 3 seats used</span>');
    expect(page).toContain("<td>bob@example.com</td>");
    expect(page).toContain(`data-rmmember="${bob.account.id}"`);
    const theirs = await text(call(env, "GET", "/account/billing", c));
    expect(theirs).toContain("<h2>Teams you are in</h2>");
    expect(theirs).toContain(`data-leave="${owner.account.id}"`);
    expect(theirs).not.toContain("data-rmmember=");
  });

  it("an account outside the team sees nothing of it", async () => {
    const { env, app } = await joined();
    const eve = await signedIn(env, "eve@example.com");
    expect((await json(call(env, "GET", "/api/me", { cookie: eve.cookie }))).projects).toEqual([]);
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie: eve.cookie })).status).toBe(404);
    expect((await call(env, "GET", `/account/apps/${app.id}`, { cookie: eve.cookie })).status).toBe(404);
  });

  it("the owner removes a member, or the member leaves: the access goes with the row", async () => {
    for (const how of ["remove", "leave"] as const) {
      const { env, sql, owner, bob, app } = await joined();
      const r =
        how === "remove"
          ? await call(env, "DELETE", `/api/team/members/${bob.account.id}`, { cookie: owner.cookie })
          : await call(env, "DELETE", `/api/team/memberships/${owner.account.id}`, { cookie: bob.cookie });
      expect(r.status, how).toBe(204);
      expect(sql.rows("SELECT member_id FROM team_members"), how).toEqual([]);
      expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie: bob.cookie })).status, how).toBe(404);
      expect((await json(call(env, "GET", "/api/me", { cookie: bob.cookie }))).projects, how).toEqual([]);
      // the owner still has the app
      expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie: owner.cookie })).status, how).toBe(200);
    }
  });
});

describe("seats decide who is in: the owner first, then members in joining order", () => {
  it("fewer seats or an ended plan takes the access and keeps the rows; more seats bring it back", async () => {
    const { env, sql } = setup(LIVE);
    const owner = await signedIn(env, "ada@example.com");
    team(sql, owner.account.id, 3);
    const app = await createApp(env, owner.cookie, "Shop");
    const bob = await signedIn(env, "bob@example.com");
    expect((await join(env, bob.cookie, (await invite(env, owner.cookie)).code)).status).toBe(200);
    advance(60_000);
    const carol = await signedIn(env, "carol@example.com");
    expect((await join(env, carol.cookie, (await invite(env, owner.cookie)).code)).status).toBe(200);
    const reads = async (cookie: string) => (await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie })).status;
    expect([await reads(bob.cookie), await reads(carol.cookie)]).toEqual([200, 200]);
    // two seats: the owner and the member who joined first
    team(sql, owner.account.id, 2);
    expect([await reads(bob.cookie), await reads(carol.cookie)]).toEqual([200, 404]);
    expect(await activeOwners(sql.api, env, carol.account.id, now())).toEqual([]);
    const page = await text(call(env, "GET", "/account/billing", { cookie: owner.cookie }));
    expect(page).toContain('<span class="aside">3 of 2 seats used</span>');
    expect(page).toContain("<b>More members than seats.</b>");
    expect((await json(call(env, "GET", "/api/team", { cookie: owner.cookie }))).members.map((m: any) => [m.email, m.active])).toEqual([
      ["bob@example.com", true],
      ["carol@example.com", false],
    ]);
    expect((await json(call(env, "GET", "/api/team", { cookie: carol.cookie }))).memberships).toMatchObject([{ owner: owner.account.id, email: "ada@example.com", active: false }]);
    // the plan ends: nobody but the owner, who is on Free again
    setPlan(sql, owner.account.id, "free", { subscription_status: "canceled", seats: null });
    expect([await reads(owner.cookie), await reads(bob.cookie), await reads(carol.cookie)]).toEqual([200, 404, 404]);
    expect(sql.rows("SELECT COUNT(*) AS n FROM team_members")[0]!.n).toBe(2);
    // back on Team with three seats: both are in again, with no new invite
    team(sql, owner.account.id, 3);
    expect([await reads(bob.cookie), await reads(carol.cookie)]).toEqual([200, 200]);
  });

  it("a plan GenClass grants has no seat count, and neither has a server with PLAN_GATES open", async () => {
    for (const how of ["grant", "open"] as const) {
      const { env, sql } = setup(how === "open" ? { PLAN_GATES: "open" } : LIVE);
      const owner = await signedIn(env, "ada@example.com");
      if (how === "grant") setPlan(sql, owner.account.id, "free", { comp_until: "9999-12-31T00:00:00.000Z", comp_plan: "team" });
      const app = await createApp(env, owner.cookie, "Shop");
      for (const who of ["bob", "carol", "dave"]) {
        const m = await signedIn(env, `${who}@example.com`);
        expect((await join(env, m.cookie, (await invite(env, owner.cookie)).code)).status, `${how} ${who}`).toBe(200);
        expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie: m.cookie })).status, `${how} ${who}`).toBe(200);
      }
      expect(await json(call(env, "GET", "/api/team", { cookie: owner.cookie }))).toMatchObject({ seats: null, used: 4 });
      expect(await text(call(env, "GET", "/account/billing", { cookie: owner.cookie }))).toContain('<span class="aside">4 people</span>');
    }
  });
});

describe("deleting an account takes it out of every team", () => {
  it("the owner's team, its invites and its members' access go; a member's deletion removes only its own row", async () => {
    const { env, sql } = setup(LIVE);
    const owner = await signedIn(env, "ada@example.com");
    setPlan(sql, owner.account.id, "free", { comp_until: "9999-12-31T00:00:00.000Z", comp_plan: "team" });
    const bob = await signedIn(env, "bob@example.com");
    const carol = await signedIn(env, "carol@example.com");
    for (const m of [bob, carol]) expect((await join(env, m.cookie, (await invite(env, owner.cookie)).code)).status).toBe(200);
    await invite(env, owner.cookie);
    expect((await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: carol.cookie })).status).toBe(204);
    expect(sql.rows("SELECT member_id FROM team_members")).toEqual([{ member_id: bob.account.id }]);
    expect((await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: owner.cookie })).status).toBe(204);
    expect(sql.rows("SELECT member_id FROM team_members")).toEqual([]);
    expect(sql.rows("SELECT id FROM team_invites")).toEqual([]);
    expect((await json(call(env, "GET", "/api/team", { cookie: bob.cookie }))).memberships).toEqual([]);
  });
});
