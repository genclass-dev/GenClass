// An app's extra keys (migration 0022, src/dashboard.ts canonicalToken, src/collector.ts ingest): a batch that carries
// one is counted on the app it belongs to, as if it carried the app's own key; an unknown key is still not counted; an
// app's own key wins over an extra key with the same value; deleting the app deletes its extra keys.
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalToken, resetTokenCache } from "../src/dashboard.js";
import { call, createApp, now, resetClock, sendBatch, setup, signedIn } from "./account-helpers.js";

const page = (route: string): Record<string, unknown> => ({ t: "session", seq: 0, at: 0, host: "shop.example", route, effectiveMode: "observe" });

const OLD = "gc_OLDKEYOLDKEYOLDKEYOLDKEY0".slice(0, 25);

const loads = (sql: ReturnType<typeof setup>["sql"], token: string): number =>
  Number((sql.db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM daily WHERE token = ? AND metric = 'sessions' AND key = ''").get(token) as { n: number }).n);

beforeEach(() => {
  resetClock();
  resetTokenCache();
});

describe("extra keys of an app (migration 0022)", () => {
  it("a batch with an app's extra key is counted on that app; an unknown key is not", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie, "Glyco site");
    expect(OLD).toMatch(/^gc_[A-Za-z0-9]{22}$/);
    sql.db.prepare("INSERT INTO app_keys (token, project_token, created) VALUES (?, ?, ?)").run(OLD, app.token, now().toISOString());
    await sendBatch(env, app.token, [page("/")], { sid: "aaaaaaaaaaaa" });
    await sendBatch(env, OLD, [page("/pricing")], { sid: "bbbbbbbbbbbb" });
    await sendBatch(env, "gc_UNKNOWNUNKNOWNUNKNOWN0".slice(0, 25), [page("/")], { sid: "cccccccccccc" });
    expect(loads(sql, app.token)).toBe(2);
    expect(loads(sql, OLD)).toBe(0);
    expect(await canonicalToken(env.DB!, OLD, now().getTime())).toBe(app.token);
    // the dashboard shows both pages under the one app
    const routes = sql.db.prepare("SELECT key FROM daily WHERE token = ? AND metric = 'page_route' ORDER BY key").all(app.token) as { key: string }[];
    expect(routes.map((r) => r.key)).toEqual(["/", "/pricing"]);
  });

  it("an app's own key wins over an extra key with the same value, and a key whose app is gone counts nowhere", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    const a = await createApp(env, cookie, "A");
    const b = await createApp(env, cookie, "B");
    sql.db.prepare("INSERT INTO app_keys (token, project_token, created) VALUES (?, ?, ?)").run(b.token, a.token, now().toISOString());
    expect(await canonicalToken(env.DB!, b.token, now().getTime())).toBe(b.token);
    resetTokenCache();
    sql.db.prepare("INSERT INTO app_keys (token, project_token, created) VALUES (?, ?, ?)").run(OLD, "gc_NOSUCHAPPNOSUCHAPPNOSU", now().toISOString());
    expect(await canonicalToken(env.DB!, OLD, now().getTime())).toBeNull();
  });

  it("deleting the app deletes its extra keys, and the key stops counting at once", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie, "Shop");
    sql.db.prepare("INSERT INTO app_keys (token, project_token, created) VALUES (?, ?, ?)").run(OLD, app.token, now().toISOString());
    await sendBatch(env, OLD, [page("/")]);
    expect(loads(sql, app.token)).toBe(1);
    const del = await call(env, "DELETE", `/api/account/projects/${app.id}`, { body: { confirm: "delete" }, cookie });
    expect(del.status).toBe(204);
    expect(sql.db.prepare("SELECT COUNT(*) AS n FROM app_keys").get()).toEqual({ n: 0 });
    expect(await canonicalToken(env.DB!, OLD, now().getTime())).toBeNull();
  });
});
