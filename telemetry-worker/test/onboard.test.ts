// `npx genclass onboard <code>` followed on genclass.dev (src/onboard.ts): the command's one-time code from a browser
// session, the command's reports, and Get started's view of the run.
import { beforeEach, describe, expect, it } from "vitest";
import { advance, call, resetClock, setup, signedIn } from "./account-helpers.js";
import { ONBOARD_KEEP_MS, onboardReady, readReport, resetOnboardReady } from "../src/onboard.js";

beforeEach(() => {
  resetClock();
  resetOnboardReady();
});

/** A command for this browser session, then the terminal's sign-in with it (what `genclass onboard` does first). */
async function onboarded(env: Parameters<typeof call>[0], cookie: string) {
  const made = await call(env, "POST", "/api/account/onboard", { cookie });
  expect(made.status).toBe(200);
  const j = (await made.json()) as any;
  const tok = await call(env, "POST", "/api/device/token", { body: { device_code: j.code }, origin: null });
  return { made: j, token: tok, json: (await tok.json()) as any };
}

const STEPS = [
  { id: "account", title: "Account", state: "done", detail: "ada@example.com" },
  { id: "runtime", title: "Runtime", state: "next", detail: "Next.js 15 (App Router)" },
  { id: "workflow", title: "Test workflow", state: "todo", detail: "Playwright found" },
];

describe("onboarding: the command Get started gives (the owner, 2026-11-24: one command, the whole setup, shown live)", () => {
  it("a signed-in browser gets npx genclass onboard <code>; the code signs the terminal in once, with no second approval", async () => {
    const { env } = setup({ ONBOARD_CLI: "on" });
    const { cookie, account } = await signedIn(env);
    const o = await onboarded(env, cookie);
    expect(o.made.command).toBe(`npx genclass@latest onboard ${o.made.code}`);
    expect(o.made.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(o.made.expires_in).toBe(600);
    expect(o.token.status).toBe(200);
    expect(o.json.token_type).toBe("Bearer");
    expect(o.json.account.id).toBe(account.id);
    // once only
    const again = await call(env, "POST", "/api/device/token", { body: { device_code: o.made.code }, origin: null });
    expect(((await again.json()) as any).error).toBe("expired_token");
  });

  it("the code lasts ten minutes", async () => {
    const { env } = setup({ ONBOARD_CLI: "on" });
    const { cookie } = await signedIn(env);
    const j = (await (await call(env, "POST", "/api/account/onboard", { cookie })).json()) as any;
    advance(10 * 60 * 1000 + 1000);
    const late = await call(env, "POST", "/api/device/token", { body: { device_code: j.code }, origin: null });
    expect(((await late.json()) as any).error).toBe("expired_token");
  });

  it("until npm's genclass has the command, the page gives the plain npx genclass and makes no code; npm is asked at most every ten minutes", async () => {
    const off = setup({ ONBOARD_CLI: "off" });
    const a = await signedIn(off.env);
    expect(await (await call(off.env, "POST", "/api/account/onboard", { cookie: a.cookie })).json()).toEqual({ ok: true, code: null, command: "npx genclass@latest", expires_in: null });
    const asked: string[] = [];
    const npm = (version: string) => async (u: string) => (asked.push(u), new Response(JSON.stringify({ name: "genclass", version }), { status: 200 }));
    expect(await onboardReady({}, npm("0.3.14"), 0)).toBe(false);
    expect(await onboardReady({}, npm("0.3.17"), 60_000)).toBe(false);
    expect(asked).toEqual(["https://registry.npmjs.org/genclass/latest"]);
    expect(await onboardReady({}, npm("0.3.17"), 11 * 60_000)).toBe(true);
    resetOnboardReady();
    expect(await onboardReady({}, npm("0.4.0"), 0)).toBe(true);
    resetOnboardReady();
    expect(await onboardReady({}, async () => { throw new Error("offline"); }, 0)).toBe(false);
    expect(await onboardReady({ ONBOARD_CLI: "on" }, npm("0.1.0"), 0)).toBe(true);
  });

  it("only a signed-in browser on genclass.dev makes one: signed out 401, another site's page 403, a terminal's session 401", async () => {
    const { env } = setup({ ONBOARD_CLI: "on" });
    const { cookie } = await signedIn(env);
    expect((await call(env, "POST", "/api/account/onboard", {})).status).toBe(401);
    expect((await call(env, "POST", "/api/account/onboard", { cookie, origin: "https://evil.example" })).status).toBe(403);
    const { json } = await onboarded(env, cookie);
    expect((await call(env, "POST", "/api/account/onboard", { bearer: json.access_token })).status).toBe(401);
  });

  it("the command's reports build the run Get started shows: the steps, the step running, its log, the end", async () => {
    const { env } = setup({ ONBOARD_CLI: "on" });
    const { cookie } = await signedIn(env);
    const { json } = await onboarded(env, cookie);
    const bearer = json.access_token;
    const post = (body: unknown) => call(env, "POST", "/api/cli/onboard", { bearer, body, origin: null });
    const view = async () => ((await (await call(env, "GET", "/api/account/onboard", { cookie })).json()) as any).run;
    expect(await view()).toBeNull();
    expect((await post({ run: "run-0123456789", steps: STEPS, app: { name: "polar-parts", framework: "Next.js 15" } })).status).toBe(200);
    expect((await post({ run: "run-0123456789", step: { id: "runtime", doing: "Add GenClass to this app", result: "running" } })).status).toBe(200);
    let r = await view();
    expect(r.steps.map((s: any) => s.id)).toEqual(["account", "runtime", "workflow"]);
    expect(r.app).toEqual({ name: "polar-parts", framework: "Next.js 15" });
    expect(r.now).toEqual({ id: "runtime", doing: "Add GenClass to this app" });
    await post({ run: "run-0123456789", step: { id: "runtime", doing: "Add GenClass to this app", result: "done" } });
    await post({ run: "run-0123456789", end: true, exit: 0 });
    r = await view();
    expect(r.now).toBeNull();
    expect(r.log.map((l: any) => [l.id, l.result])).toEqual([["runtime", "done"]]);
    expect(r.finished).toBe(true);
    expect(r.exit).toBe(0);
  });

  it("reports come from the command's own session only, and a browser cannot write one", async () => {
    const { env } = setup({ ONBOARD_CLI: "on" });
    const { cookie } = await signedIn(env);
    expect((await call(env, "POST", "/api/cli/onboard", { cookie, body: { run: "run-0123456789" } })).status).toBe(403);
    expect((await call(env, "POST", "/api/cli/onboard", { body: { run: "run-0123456789" }, origin: null })).status).toBe(401);
  });

  it("a report is cut to what the command's screen says: known steps and states, short words, a small body", async () => {
    const r = readReport({
      run: "run-0123456789",
      steps: [
        { id: "runtime", title: "Runtime", state: "done", detail: "x".repeat(500) },
        { id: "rm -rf", title: "?", state: "done", detail: "" },
        { id: "agent", title: "Coding agent", state: "hacked", detail: "line\nbreak\u0007" },
      ],
      step: { id: "nope", doing: "x", result: "done" },
    });
    if (typeof r === "string") throw new Error(r);
    expect(r.steps!.map((s) => s.id)).toEqual(["runtime", "agent"]);
    expect(r.steps![0]!.detail).toHaveLength(160);
    expect(r.steps![1]).toEqual({ id: "agent", title: "Coding agent", state: "todo", detail: "line break" });
    expect(r.step).toBeNull();
    expect(readReport({ run: "x" })).toBe("run is missing or malformed");
    expect(readReport(null)).toBe("send JSON");
  });

  it("an account sees only its own runs, and a run is gone two hours after its last report", async () => {
    const { env } = setup({ ONBOARD_CLI: "on" });
    const ada = await signedIn(env, "ada@example.com");
    const bob = await signedIn(env, "bob@example.com");
    const { json } = await onboarded(env, ada.cookie);
    await call(env, "POST", "/api/cli/onboard", { bearer: json.access_token, body: { run: "run-0123456789", steps: STEPS }, origin: null });
    const runOf = async (cookie: string) => ((await (await call(env, "GET", "/api/account/onboard", { cookie })).json()) as any).run;
    expect((await runOf(ada.cookie)).run).toBe("run-0123456789");
    expect(await runOf(bob.cookie)).toBeNull();
    advance(ONBOARD_KEEP_MS + 1000);
    expect(await runOf(ada.cookie)).toBeNull();
  });
});
