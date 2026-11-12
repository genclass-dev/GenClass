// The GitHub App's daily counts of installs and uninstalls (migrations/0018_github_install_days.sql; src/github/store.ts
// header): through the worker's real handler, with the D1 migrations under node:sqlite. What is checked: a count per
// UTC day and nothing else is kept, each install and uninstall counts once, the operator's own accounts are counted
// apart, and the count never decides whether an install or an uninstall goes through.
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_OWN_ACCOUNTS, ownAccounts } from "../src/github/config.js";
import { deleteInstallation, githubRetention, upsertInstallation } from "../src/github/store.js";
import { advance, call, now, resetClock, setNow, signedIn } from "./account-helpers.js";
import { d1 } from "./d1.js";
import { APP_ID, deliver, fakeGithub, githubSetup, INSTALLATION, installationCreated, OWNER, pullRequest, REPO, result, SHA1 } from "./github-helpers.js";

beforeEach(() => {
  resetClock();
});

const DAY = "2026-10-13"; // the tests' clock starts at noon UTC on this day
const DAYS = "SELECT day, own, installs, uninstalls FROM github_install_days ORDER BY day, own";
/** A second installation, on a person's account. */
const OTHER = { id: 9002, account: { id: 502, login: "globex", type: "User" } };
const created = (over: Record<string, unknown> = {}) => installationCreated(over);
const deleted = (over: Record<string, unknown> = {}) => ({ ...installationCreated(over), action: "deleted" });

describe("github app: installs and uninstalls per day (src/github/store.ts header)", () => {
  it("the table holds a day, the own mark and two numbers: no column for an installation, an account or a repository", () => {
    const { sql } = githubSetup();
    expect(sql.rows("SELECT name FROM pragma_table_info('github_install_days') ORDER BY cid").map((c) => c.name)).toEqual(["day", "own", "installs", "uninstalls"]);
  });

  it("an install counts once on its UTC day; the installation seen again counts nothing", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    expect(sql.rows(DAYS)).toEqual([]);
    expect(await result(await deliver(env, "installation", created(), { fetch: gh.fetch }))).toBe("created");
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 0, installs: 1, uninstalls: 0 }]);

    for (const action of ["created", "unsuspend", "new_permissions_accepted", "suspend"]) {
      await deliver(env, "installation", { ...created(), action }, { fetch: gh.fetch });
    }
    await pullRequest(env, gh, "opened", 12, SHA1);
    expect(sql.rows("SELECT id FROM github_installations")).toEqual([{ id: INSTALLATION }]);
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 0, installs: 1, uninstalls: 0 }]);
  });

  it("an uninstall counts once on the day it happened, and the count is all that is left", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", created(), { fetch: gh.fetch });
    await pullRequest(env, gh, "opened", 12, SHA1);
    advance(2 * 86_400_000);
    expect(await result(await deliver(env, "installation", deleted(), { fetch: gh.fetch }))).toBe("deleted");
    const after = [
      { day: DAY, own: 0, installs: 1, uninstalls: 0 },
      { day: "2026-10-15", own: 0, installs: 0, uninstalls: 1 },
    ];
    expect(sql.rows(DAYS)).toEqual(after);
    for (const t of ["github_installations", "github_repos", "github_repo_facts", "github_prs", "github_usage"]) expect(sql.rows(`SELECT * FROM ${t}`), t).toEqual([]);
    // nothing of the account that left is in the counts: not its name, not an id
    const kept = JSON.stringify(sql.rows("SELECT * FROM github_install_days"));
    for (const v of [OWNER.login, String(OWNER.id), String(INSTALLATION), String(REPO.id), REPO.name]) expect(kept, v).not.toContain(v);

    // GitHub sends the uninstall again (a new delivery), and one for an installation that was never recorded
    expect(await result(await deliver(env, "installation", deleted(), { fetch: gh.fetch }))).toBe("deleted");
    expect(await result(await deliver(env, "installation", deleted(OTHER), { fetch: gh.fetch }))).toBe("deleted");
    expect(sql.rows(DAYS)).toEqual(after);
  });

  it("several on one day add up, and a day is a UTC day", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    setNow(new Date("2026-10-13T23:59:59.000Z"));
    await deliver(env, "installation", created(), { fetch: gh.fetch });
    await deliver(env, "installation", created(OTHER), { fetch: gh.fetch });
    advance(2_000);
    await deliver(env, "installation", created({ id: 9003, account: { id: 503, login: "initech", type: "Organization" } }), { fetch: gh.fetch });
    await deliver(env, "installation", deleted(OTHER), { fetch: gh.fetch });
    await deliver(env, "installation", deleted(), { fetch: gh.fetch });
    expect(sql.rows(DAYS)).toEqual([
      { day: "2026-10-13", own: 0, installs: 2, uninstalls: 0 },
      { day: "2026-10-14", own: 0, installs: 1, uninstalls: 2 },
    ]);
    // what was counted in and out is what is there now
    const sum = sql.rows("SELECT SUM(installs) - SUM(uninstalls) AS n FROM github_install_days")[0]!.n;
    expect(sum).toBe(sql.rows("SELECT COUNT(*) AS n FROM github_installations")[0]!.n);
  });

  it("an installation first seen through another event than its own counts as an install", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    expect(sql.rows("SELECT id FROM github_installations")).toEqual([{ id: INSTALLATION }]);
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 0, installs: 1, uninstalls: 0 }]);
    // its `created` event arrives late: the installation is already counted
    await deliver(env, "installation", created(), { fetch: gh.fetch });
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 0, installs: 1, uninstalls: 0 }]);
  });

  it("an installation first recorded when a person connects GitHub counts as an install, once", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    gh.user.installations = [{ id: INSTALLATION, app_id: Number(APP_ID), account: OWNER, repository_selection: "selected", suspended_at: null }];
    gh.user.repositories.set(INSTALLATION, [{ id: REPO.id, full_name: REPO.full_name, private: false, permissions: { admin: false, push: true, pull: true } }]);
    const me = await signedIn(env, "ada@example.com");
    const connect = async (): Promise<void> => {
      const start = await call(env, "GET", "/github/connect", { cookie: me.cookie, origin: null });
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const oauth = start.headers.getSetCookie().find((x) => x.startsWith("gc_oauth_ghapp="))!.split(";")[0]!;
      await call(env, "GET", `/github/callback?code=good-code&state=${encodeURIComponent(state)}`, { cookie: `${me.cookie}; ${oauth}`, origin: null, fetch: gh.fetch });
    };
    await connect();
    expect(sql.rows("SELECT id FROM github_installations")).toEqual([{ id: INSTALLATION }]);
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 0, installs: 1, uninstalls: 0 }]);
    await connect();
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 0, installs: 1, uninstalls: 0 }]);
  });

  it("the operator's own accounts are counted apart, whatever the case of the name (GITHUB_APP_OWN_ACCOUNTS)", async () => {
    const { env, sql } = githubSetup({ GITHUB_APP_OWN_ACCOUNTS: " Acme , someone-else" });
    const gh = fakeGithub();
    await deliver(env, "installation", created(), { fetch: gh.fetch }); // on "acme": the operator's
    await deliver(env, "installation", created(OTHER), { fetch: gh.fetch }); // on "globex": not
    expect(sql.rows(DAYS)).toEqual([
      { day: DAY, own: 0, installs: 1, uninstalls: 0 },
      { day: DAY, own: 1, installs: 1, uninstalls: 0 },
    ]);
    await deliver(env, "installation", deleted(), { fetch: gh.fetch });
    expect(sql.rows(DAYS)).toEqual([
      { day: DAY, own: 0, installs: 1, uninstalls: 0 },
      { day: DAY, own: 1, installs: 1, uninstalls: 1 },
    ]);
    await deliver(env, "installation", deleted(OTHER), { fetch: gh.fetch });
    expect(sql.rows(DAYS)).toEqual([
      { day: DAY, own: 0, installs: 1, uninstalls: 1 },
      { day: DAY, own: 1, installs: 1, uninstalls: 1 },
    ]);
    // the mark changes nothing else: both were recorded and removed alike
    expect(sql.rows("SELECT * FROM github_installations")).toEqual([]);
  });

  it("an uninstall is counted by the account the installation was recorded on, not by what the event says", async () => {
    const { env, sql } = githubSetup({ GITHUB_APP_OWN_ACCOUNTS: "acme" });
    const gh = fakeGithub();
    await deliver(env, "installation", created(), { fetch: gh.fetch });
    // the uninstall names no account at all
    await deliver(env, "installation", { action: "deleted", installation: { id: INSTALLATION } }, { fetch: gh.fetch });
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 1, installs: 1, uninstalls: 1 }]);
  });

  it("without GITHUB_APP_OWN_ACCOUNTS no account is the operator's", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", created({ account: { id: 1, login: "genclass-dev", type: "Organization" } }), { fetch: gh.fetch });
    await deliver(env, "installation", deleted({ account: { id: 1, login: "genclass-dev", type: "Organization" } }), { fetch: gh.fetch });
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 0, installs: 1, uninstalls: 1 }]);
  });

  it("the names in GITHUB_APP_OWN_ACCOUNTS: lower case, each one once, only what GitHub could name an account", () => {
    expect(ownAccounts(undefined)).toEqual([]);
    expect(ownAccounts("")).toEqual([]);
    expect(ownAccounts("GenClass-Dev, octo_cat ,genclass-dev,,")).toEqual(["genclass-dev", "octo_cat"]);
    expect(ownAccounts("a b, x/y, ../z, 'q', ok, " + "n".repeat(40))).toEqual(["ok"]);
    expect(ownAccounts(Array.from({ length: 50 }, (_, i) => `acct-${i}`).join(","))).toHaveLength(MAX_OWN_ACCOUNTS);
  });

  it("the count and the row are one transaction: an install that fails is not counted, and counts once when redelivered", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    sql.db.exec("CREATE TRIGGER refuse BEFORE INSERT ON github_installations BEGIN SELECT RAISE(ABORT, 'refused'); END");
    const id = "aaaaaaaa-1111-4222-8333-444444444444";
    const failed = await deliver(env, "installation", created(), { fetch: gh.fetch, id });
    expect(failed.status).toBe(502);
    expect(sql.rows("SELECT * FROM github_installations")).toEqual([]);
    expect(sql.rows(DAYS)).toEqual([]);
    sql.db.exec("DROP TRIGGER refuse");
    expect(await result(await deliver(env, "installation", created(), { fetch: gh.fetch, id }))).toBe("created");
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 0, installs: 1, uninstalls: 0 }]);
  });

  it("an uninstall that fails is not counted and deletes nothing; redelivered, it does both once", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", created(), { fetch: gh.fetch });
    sql.db.exec("CREATE TRIGGER keep BEFORE DELETE ON github_installations BEGIN SELECT RAISE(ABORT, 'refused'); END");
    const id = "bbbbbbbb-1111-4222-8333-444444444444";
    expect((await deliver(env, "installation", deleted(), { fetch: gh.fetch, id })).status).toBe(502);
    expect(sql.rows("SELECT id FROM github_installations")).toEqual([{ id: INSTALLATION }]);
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 0, installs: 1, uninstalls: 0 }]);
    sql.db.exec("DROP TRIGGER keep");
    expect(await result(await deliver(env, "installation", deleted(), { fetch: gh.fetch, id }))).toBe("deleted");
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 0, installs: 1, uninstalls: 1 }]);
  });

  it("the daily sweep leaves the counts alone, however old", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    await deliver(env, "installation", created(), { fetch: gh.fetch });
    await deliver(env, "installation", deleted(), { fetch: gh.fetch });
    await githubRetention(env.DB!, new Date(now().getTime() + 800 * 86_400_000));
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 0, installs: 1, uninstalls: 1 }]);
  });
});

describe("github app: a database without the daily counts (migrations/0018, \"Until it is applied\")", () => {
  it("installs and uninstalls go through as before, without a count", async () => {
    const { env, sql } = githubSetup();
    const gh = fakeGithub();
    sql.db.exec("DROP TABLE github_install_days");
    expect(await result(await deliver(env, "installation", created(), { fetch: gh.fetch }))).toBe("created");
    expect(sql.rows("SELECT id, account_login FROM github_installations")).toEqual([{ id: INSTALLATION, account_login: "acme" }]);
    expect(await result(await pullRequest(env, gh, "opened", 12, SHA1))).toBe("no race files");
    expect(await result(await deliver(env, "installation", deleted(), { fetch: gh.fetch }))).toBe("deleted");
    for (const t of ["github_installations", "github_repos", "github_repo_facts", "github_prs", "github_usage"]) expect(sql.rows(`SELECT * FROM ${t}`), t).toEqual([]);
  });

  it("only the missing table is passed over: any other failure is thrown, and nothing is written twice", async () => {
    const { sql } = githubSetup();
    sql.db.exec("DROP TABLE github_install_days");
    sql.db.exec("CREATE TRIGGER refuse BEFORE INSERT ON github_installations BEGIN SELECT RAISE(ABORT, 'refused'); END");
    await expect(upsertInstallation(sql.api, { id: 1, accountId: 2, login: "acme", type: "User", selection: "all" }, now())).rejects.toThrow(/refused/);
    sql.db.exec("DROP TRIGGER refuse");
    const before = sql.batches();
    await upsertInstallation(sql.api, { id: 1, accountId: 2, login: "acme", type: "User", selection: "all" }, now());
    // one try with the count, one without
    expect(sql.batches() - before).toBe(2);
    expect(sql.rows("SELECT id FROM github_installations")).toEqual([{ id: 1 }]);
    await deleteInstallation(sql.api, 1, now(), ["acme"]);
    expect(sql.rows("SELECT id FROM github_installations")).toEqual([]);
  });

  it("applied to a database that has installations: none is counted as an install, and one that leaves counts as an uninstall", async () => {
    const s = githubSetup();
    const sql = d1({
      before: "0018",
      seed: (db) =>
        db
          .prepare("INSERT INTO github_installations (id, account_id, account_login, account_type, selection, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(INSTALLATION, OWNER.id, OWNER.login, "Organization", "all", "2026-10-01T08:00:00.000Z", "2026-10-01T08:00:00.000Z"),
    });
    const env = { ...s.env, DB: sql.api };
    const gh = fakeGithub();
    expect(sql.rows(DAYS)).toEqual([]);
    // seen again after the migration: still not an install
    await deliver(env, "installation", { ...created(), action: "unsuspend" }, { fetch: gh.fetch });
    expect(sql.rows("SELECT created FROM github_installations")).toEqual([{ created: "2026-10-01T08:00:00.000Z" }]);
    expect(sql.rows(DAYS)).toEqual([]);
    await deliver(env, "installation", deleted(), { fetch: gh.fetch });
    expect(sql.rows(DAYS)).toEqual([{ day: DAY, own: 0, installs: 0, uninstalls: 1 }]);
  });
});
