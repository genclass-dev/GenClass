// `genclass onboard <code>` against the real collector, in process (telemetry-worker/src/collector.ts handle): the code
// Get started gives signs the terminal in, the walk reports where it stands, and the run is what Get started reads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../../../telemetry-worker/src/collector.js";
import { advance, call, now, resetClock, setup, signedIn } from "../../../telemetry-worker/test/account-helpers.js";
import { readCredentials } from "../../runtime/bin/lib/account.mjs";
import { onboard } from "../src/setup.mjs";
import { isolate, printed, tempDir } from "./helpers.js";

isolate();
beforeEach(() => {
  resetClock();
});

type Env = Parameters<typeof handle>[1];
const through = (env: Env) =>
  (async (input: string | URL, init?: RequestInit) => handle(new Request(String(input), { method: init?.method, headers: init?.headers, body: init?.body as never }), env, { now: () => now() })) as unknown as typeof fetch;

/** Get started's command for a signed-in browser: its code. */
async function codeFor(env: Env, cookie: string): Promise<string> {
  const r = await call(env, "POST", "/api/account/onboard", { cookie });
  expect(r.status).toBe(200);
  return ((await r.json()) as any).code;
}

describe("genclass onboard <code> (setup.mjs onboard, telemetry-worker src/onboard.ts)", () => {
  it("the code signs the terminal in with no browser, the walk says where it stands, and Get started can read the run", async () => {
    const { env } = setup({ ONBOARD_CLI: "on" } as never);
    const me = await signedIn(env);
    const code = await codeFor(env, me.cookie);
    vi.stubGlobal("fetch", through(env));
    // a folder with no web app: the walk signs in, finds nothing to add here, and says so; every step is reported
    const dir = tempDir();
    let exit = -1;
    const text = await printed(async () => (exit = await onboard(code, { cwd: dir }, { fetchFn: through(env) })));
    expect(exit).toBe(0);
    expect(text).toContain("Signed in as");
    expect(text).toContain("genclass.dev/account/get-started");
    expect(readCredentials()).toMatchObject({ account: { id: me.account.id } });
    const run = ((await (await call(env, "GET", "/api/account/onboard", { cookie: me.cookie })).json()) as any).run;
    expect(run).not.toBeNull();
    expect(run.finished).toBe(true);
    expect(run.exit).toBe(0);
    const state = Object.fromEntries(run.steps.map((s: any) => [s.id, s.state]));
    expect(state.account).toBe("done");
    expect(state.runtime).toBe("blocked");
    // the code was used: a second run with it does not sign in
    let again = -1;
    await printed(async () => (again = await onboard(code, { cwd: dir }, { fetchFn: through(env) })));
    expect(again).toBe(1);
  });

  it("a code that is not one is refused before anything is asked; an expired one says to get a new one", async () => {
    const { env } = setup({ ONBOARD_CLI: "on" } as never);
    const me = await signedIn(env);
    let bad = -1;
    await printed(async () => (bad = await onboard("not-a-code", { cwd: tempDir() })));
    expect(bad).toBe(2);
    const code = await codeFor(env, me.cookie);
    advance(11 * 60 * 1000);
    vi.stubGlobal("fetch", through(env));
    let late = -1;
    const text = await printed(async () => (late = await onboard(code, { cwd: tempDir() }, { fetchFn: through(env) })));
    expect(late).toBe(1);
    expect(text).toContain("expired or was used already");
  });
});

describe("the setup's last lines: Day to day (src/setup.mjs closing)", () => {
  it("on Free names only what works there (fix <url>, scan <url>, upgrade), with Pro the Pro commands (the 2026-11-25 onboarding walk)", async () => {
    const { closing } = await import("../src/setup.mjs");
    const base = { steps: [], signedIn: true, complete: true, app: { token: "gc_t", name: "shop" } };
    const free = await printed(() => closing({ ...base, account: { cli: { paid: false, plan: "Pro" } } }));
    for (const line of ["npx genclass fix <url>", "npx genclass scan <url>", "npx genclass upgrade"]) expect(free).toContain(line);
    expect(free).not.toContain("npx genclass suggest");
    expect(free).not.toContain("npx genclass dashboard");
    const pro = await printed(() => closing({ ...base, account: { cli: { paid: true } } }));
    expect(pro).toContain("npx genclass suggest");
    expect(pro).toContain("npx genclass dashboard");
    expect(pro).not.toContain("npx genclass upgrade");
  });
});
