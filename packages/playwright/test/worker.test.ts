// The register entry's process side (src/worker.ts) on a fake process: where it starts (a Playwright worker), where it
// waits (a child Playwright started, before it is told to be a worker), where it does nothing (everywhere else,
// including a process a worker forked, and with the off switch), that it starts once, and that a failure is one
// remembered line and an inert entry. Then the two lookups against the installed Playwright: which package a worker's
// script belongs to, and that the objects it gives are the ones `@playwright/test` gives (the same copy, never a
// second one, and never looked for from anywhere but the worker's own script).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REGISTER_KEY, type TestInfoLike } from "../src/session.js";
import { WRAPPED } from "../src/wrap.js";
import { MAX_MESSAGES, isPlaywrightChildScript, loadPlaywright, newRegisterState, playwrightRoot, processIo, registerState, startRegister, type RegisterIo } from "../src/worker.js";
import { fakePlaywright, fakeRuntimeDir, fakeTestInfo, here, type FakePlaywright } from "./helpers.js";

let root = "";
let runtimeDir = "";
let pw: FakePlaywright;
let current: TestInfoLike | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-worker-"));
  runtimeDir = fakeRuntimeDir();
  pw = fakePlaywright();
  current = null;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
});

interface FakeIo extends RegisterIo {
  env: Record<string, string | undefined>;
  channel: boolean;
  child: boolean;
  loads: number;
  listeners: (() => void)[];
  exits: (() => void)[];
  reported: string[];
  /** A message from the runner arrives. */
  message(): void;
}

/** A process with a channel to its parent. `child`: its script is the playwright package's (Playwright started it); a worker's is. */
function fakeIo(env: Record<string, string | undefined> = {}, child = env.TEST_WORKER_INDEX !== undefined): FakeIo {
  const io: FakeIo = {
    env: { GENCLASS_RUNTIME_DIR: runtimeDir, GENCLASS_OUT_DIR: join(root, "races"), ...env },
    cwd: root,
    channel: true,
    child,
    loads: 0,
    listeners: [],
    exits: [],
    reported: [],
    forked: () => io.channel,
    playwrightChild: () => io.child,
    playwright: () => {
      io.loads++;
      return {
        test: {
          info: () => {
            if (!current) throw new Error("test.info() can only be called while test is running");
            return current;
          },
        },
        browserTypes: [pw.chromium, pw.firefox, pw.webkit],
      };
    },
    onMessage(fn) {
      io.listeners.push(fn);
      return () => void io.listeners.splice(io.listeners.indexOf(fn), 1);
    },
    onExit: (fn) => void io.exits.push(fn),
    report: (line) => void io.reported.push(line),
    message: () => {
      for (const fn of [...io.listeners]) fn();
    },
  };
  return io;
}

const wrappedNow = (): boolean => (pw.protos.browserType.launch as Record<symbol, unknown>)[WRAPPED] === true;
const BT = ["BrowserType.launch", "BrowserType.launchPersistentContext", "BrowserType.connect", "BrowserType.connectOverCDP"];

describe("worker: where the register entry starts", () => {
  it("in a Playwright worker (TEST_WORKER_INDEX is set): Playwright's browser types are wrapped at once", async () => {
    const io = fakeIo({ TEST_WORKER_INDEX: "0", GENCLASS_CHAOS: "on", GENCLASS_SEED: "5" });
    const state = startRegister(io, newRegisterState());
    expect(state.state).toBe("active");
    expect(state.wrapped).toEqual(BT);
    expect(io.loads).toBe(1);
    expect(io.listeners).toEqual([]);
    expect(state.notes).toEqual([]);
    expect(wrappedNow()).toBe(true);
    // the test's identity is Playwright's, and the options are the environment's
    expect(state.currentTestId()).toBeNull();
    current = fakeTestInfo(root, { repeatEachIndex: 1 });
    expect(state.currentTestId()).toBe("a1b2c3-d4e5f6");
    const context = await (await pw.chromium.launch()).newContext();
    expect(state.contexts.has(context)).toBe(true);
    expect(context.routes[0].pattern).toBe("**/*");
    await context.newPage();
    await context.close();
    const written = readdirSync(join(root, "races"));
    expect(written).toEqual(["chromium-checkout-spec-ts-checkout-places-one-order-a1b2c3-d4e5f6-s6.json"]);
    expect(JSON.parse(readFileSync(join(root, "races", written[0]), "utf8"))).toMatchObject({ seed: 6, chaos: { latencyMs: [0, 600], reorder: true } });
  });

  it("at the end of the process, what open contexts handed over is written", async () => {
    const io = fakeIo({ TEST_WORKER_INDEX: "3" });
    startRegister(io, newRegisterState());
    expect(io.exits).toHaveLength(1);
    current = fakeTestInfo(root);
    const context = await (await pw.chromium.launch()).newContext();
    context.push({ t: "witness", witness: { kind: "identical-in-flight", by: "POST /api/orders#2", over: "POST /api/orders#1", gapMs: 30 } });
    expect(existsSync(join(root, "races"))).toBe(false);
    io.exits[0]();
    const written = readdirSync(join(root, "races"));
    expect(written).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, "races", written[0]), "utf8")).signatures).toHaveLength(1);
  });

  it("the off switch: nothing is loaded, nothing is wrapped, nothing is listened to", async () => {
    const io = fakeIo({ TEST_WORKER_INDEX: "0", GENCLASS_PLAYWRIGHT: "off" });
    io.child = true;
    const state = startRegister(io, newRegisterState());
    expect(state).toMatchObject({ state: "off", wrapped: [], notes: [] });
    expect(io.loads).toBe(0);
    expect(io.listeners).toEqual([]);
    expect(io.exits).toEqual([]);
    expect(wrappedNow()).toBe(false);
    current = fakeTestInfo(root);
    const context = await (await pw.chromium.launch()).newContext();
    expect(context.instrumented()).toBe(false);
  });

  it("anywhere else (Playwright's runner, a web server, a build tool): nothing, and Playwright is not loaded", () => {
    const io = fakeIo();
    const state = startRegister(io, newRegisterState());
    expect(state).toMatchObject({ state: "idle", wrapped: [], notes: [] });
    expect(io.loads).toBe(0);
    expect(io.listeners).toEqual([]);
    expect(wrappedNow()).toBe(false);
  });

  it("a process without a channel to a parent is no worker, even with TEST_WORKER_INDEX inherited from the test that started it", () => {
    const io = fakeIo({ TEST_WORKER_INDEX: "0" });
    io.channel = false;
    io.child = true;
    const state = startRegister(io, newRegisterState());
    expect(state).toMatchObject({ state: "idle", wrapped: [], notes: [] });
    expect(io.loads).toBe(0);
    expect(io.listeners).toEqual([]);
    expect(wrappedNow()).toBe(false);
  });

  it("a process a worker forked (a channel, TEST_WORKER_INDEX and the preload inherited, a script that is not Playwright's) is no worker: Playwright is not loaded there", () => {
    // child_process.fork from a test or a worker fixture: a mock server, say
    const io = fakeIo({ TEST_WORKER_INDEX: "0", NODE_OPTIONS: "--import /abs/register.js", GENCLASS_CHAOS: "on" }, false);
    expect(io.forked()).toBe(true);
    const state = startRegister(io, newRegisterState());
    expect(state).toMatchObject({ state: "idle", wrapped: [], notes: [] });
    expect(io.loads).toBe(0);
    expect(io.listeners).toEqual([]);
    expect(io.exits).toEqual([]);
    expect(io.reported).toEqual([]);
    expect(wrappedNow()).toBe(false);
    // messages from the worker that forked it change nothing: it never listened
    io.message();
    expect(state.state).toBe("idle");
    expect(io.loads).toBe(0);
  });

  it("preloaded in a child Playwright started: it waits, and starts on the first message after Playwright made it a worker", () => {
    const io = fakeIo();
    io.child = true;
    const state = startRegister(io, newRegisterState());
    expect(state.state).toBe("waiting");
    expect(io.loads).toBe(0);
    expect(io.listeners).toHaveLength(1);
    io.message(); // the runner's first message: Playwright has not set the index yet
    expect(state.state).toBe("waiting");
    expect(io.loads).toBe(0);
    io.env.TEST_WORKER_INDEX = "2";
    io.message();
    expect(state.state).toBe("active");
    expect(state.wrapped).toEqual(BT);
    expect(io.loads).toBe(1);
    expect(io.listeners).toEqual([]);
    io.message();
    expect(io.loads).toBe(1);
  });

  it("a child that is never made a worker stops listening", () => {
    const io = fakeIo();
    io.child = true;
    const state = startRegister(io, newRegisterState());
    for (let i = 0; i < MAX_MESSAGES - 1; i++) io.message();
    expect(io.listeners).toHaveLength(1);
    expect(state.state).toBe("waiting");
    io.message();
    expect(io.listeners).toEqual([]);
    expect(state.state).toBe("idle");
    expect(io.loads).toBe(0);
  });

  it("it starts once: a second start with the same state (another copy of the module) changes nothing", () => {
    const io = fakeIo({ TEST_WORKER_INDEX: "0" });
    const state = newRegisterState();
    startRegister(io, state);
    const launch = pw.protos.browserType.launch;
    const again = startRegister(fakeIo({ TEST_WORKER_INDEX: "0" }), state);
    expect(again).toBe(state);
    expect(state.wrapped).toEqual(BT);
    expect(pw.protos.browserType.launch).toBe(launch);
    expect(io.exits).toHaveLength(1);
    // a different state in the same process (a module copy that cannot see the first one): the prototypes say so
    const other = startRegister(fakeIo({ TEST_WORKER_INDEX: "0" }), newRegisterState());
    expect(other.state).toBe("failed");
    expect(pw.protos.browserType.launch).toBe(launch);
  });
});

describe("worker: a failure is one line and an inert entry", () => {
  it("no runtime: failed, Playwright is not loaded, the line says what to do", () => {
    const io = fakeIo({ TEST_WORKER_INDEX: "0", GENCLASS_RUNTIME_DIR: join(root, "nowhere") });
    const state = startRegister(io, newRegisterState());
    expect(state.state).toBe("failed");
    expect(io.loads).toBe(0);
    expect(wrappedNow()).toBe(false);
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0]).toMatch(/^GenClass was not put on this run: @genclass\/playwright: runtimeDir .*nowhere has no genclass\.global\.js/);
    expect(state.notes[0]).toContain("GENCLASS_RUNTIME_DIR");
    expect(io.reported).toEqual(state.notes);
    expect(state.currentTestId()).toBeNull();
  });

  it("no Playwright: failed, with the reason", () => {
    const io = fakeIo({ TEST_WORKER_INDEX: "0" });
    io.playwright = () => {
      throw new Error("@playwright/test was not found from /work");
    };
    const state = startRegister(io, newRegisterState());
    expect(state.state).toBe("failed");
    expect(state.notes).toEqual(["GenClass was not put on this run: @playwright/test was not found from /work"]);
  });

  it("values of the environment that cannot be read are remembered, once each, and reporting never throws", async () => {
    const io = fakeIo({ TEST_WORKER_INDEX: "0", GENCLASS_CHAOS: "on", GENCLASS_SEED: "x", GENCLASS_MODEL: "cdn" });
    io.report = () => {
      throw new Error("the notes file is gone");
    };
    const state = startRegister(io, newRegisterState());
    expect(state.state).toBe("active");
    expect(state.notes).toEqual(['GENCLASS_SEED="x" is not a whole number from 0; using 1', 'GENCLASS_MODEL="cdn" is not "skip" or "load"; using skip']);
    // a failure that repeats for every context is remembered once
    const reported: string[] = [];
    const again = fakeIo({ TEST_WORKER_INDEX: "0", GENCLASS_OUT_DIR: join(root, "races") });
    again.report = (l) => void reported.push(l);
    pw = fakePlaywright();
    const s2 = startRegister(again, newRegisterState());
    current = fakeTestInfo(root);
    const browser = await pw.chromium.launch();
    pw.protos.context.exposeBinding = async function (): Promise<void> {
      throw new Error("Target closed");
    };
    await browser.newContext();
    await browser.newContext();
    expect(s2.notes).toEqual(["could not put GenClass on a browser context: Target closed"]);
    expect(reported).toEqual(s2.notes);
  });

  it("pages the fixture left to the entry are said at the end", () => {
    const io = fakeIo({ TEST_WORKER_INDEX: "0" });
    const state = startRegister(io, newRegisterState());
    state.fixturePages = 2;
    io.exits[0]();
    expect(state.notes).toEqual(["2 pages of tests that import @genclass/playwright/fixture were left to the register entry: its options come from the environment, not from use.genclass"]);
  });
});

describe("worker: the process's own state", () => {
  it("is one object per process, under a registered symbol", () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    const before = g[REGISTER_KEY];
    try {
      delete g[REGISTER_KEY];
      const state = registerState();
      expect(state).toEqual({ version: 1, state: "idle", wrapped: [], notes: [], contexts: expect.any(WeakSet), fixturePages: 0, currentTestId: expect.any(Function) });
      expect(registerState()).toBe(state);
      expect(g[Symbol.for("@genclass/playwright/register")]).toBe(state);
      expect(state.currentTestId()).toBeNull();
    } finally {
      if (before === undefined) delete g[REGISTER_KEY];
      else g[REGISTER_KEY] = before;
    }
  });

  it("the real process: a note goes to the file the command named, else to stderr", () => {
    const file = join(root, "notes");
    const before = process.env.GENCLASS_NOTES_FILE;
    process.env.GENCLASS_NOTES_FILE = file;
    try {
      const io = processIo();
      io.report("first");
      io.report("second");
      expect(readFileSync(file, "utf8")).toBe("first\nsecond\n");
      expect(io.cwd).toBe(process.cwd());
      // vitest's worker is no child of Playwright's, with or without a channel to vitest
      expect(io.playwrightChild()).toBe(false);
      expect(typeof io.forked()).toBe("boolean");
    } finally {
      if (before === undefined) delete process.env.GENCLASS_NOTES_FILE;
      else process.env.GENCLASS_NOTES_FILE = before;
    }
  });
});

describe("worker: the installed Playwright", () => {
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve("playwright/package.json"));
  const entries = ["lib/worker/workerProcessEntry.js", "lib/common/process.js"].map((f) => join(pkg, f)).filter((f) => existsSync(f));

  it("a worker's script belongs to the playwright package; its command and other packages' scripts do not count as its child", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(realpathSync(playwrightRoot(entry)!)).toBe(realpathSync(pkg));
      expect(isPlaywrightChildScript(entry)).toBe(true);
    }
    // the command (playwright test) is the runner, not a child
    expect(realpathSync(playwrightRoot(join(pkg, "cli.js"))!)).toBe(realpathSync(pkg));
    expect(isPlaywrightChildScript(join(pkg, "cli.js"))).toBe(false);
    // @playwright/test's command, this test file, nothing
    expect(playwrightRoot(require.resolve("@playwright/test/cli"))).toBeNull();
    expect(isPlaywrightChildScript(require.resolve("@playwright/test/cli"))).toBe(false);
    expect(playwrightRoot(join(here, "worker.test.ts"))).toBeNull();
    expect(playwrightRoot(undefined)).toBeNull();
    expect(isPlaywrightChildScript(undefined)).toBe(false);
    expect(playwrightRoot(join(root, "no", "such", "script.js"))).toBeNull();
  });

  it("says which hook is running and which test is the one running, as the entry's rules for a context need (a real run, no browser)", () => {
    // test/hook-smoke holds the facts as a spec; it fails when the installed Playwright no longer has them
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GENCLASS_") && !k.startsWith("VITEST") && k !== "NODE_OPTIONS" && k !== "TEST_WORKER_INDEX" && k !== "TEST_PARALLEL_INDEX") env[k] = v;
    const r = spawnSync(process.execPath, [require.resolve("@playwright/test/cli"), "test"], { cwd: join(here, "hook-smoke"), encoding: "utf8", timeout: 120_000, env: { ...env, CI: "1" } });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).toContain("2 passed");
    expect(r.status, out).toBe(0);
  }, 150_000);

  it("the objects come from the copy that runs the worker: the same ones @playwright/test gives", async () => {
    const mine = (await import("@playwright/test")) as unknown as { test: { info(): unknown }; chromium: object; firefox: object; webkit: object };
    const found = loadPlaywright(entries[0]);
    expect(found.browserTypes).toEqual([mine.chromium, mine.firefox, mine.webkit]);
    expect(found.browserTypes[0]).toBe(mine.chromium);
    expect(found.test.info).toBe(mine.test.info);
    expect(() => found.test.info()).toThrow(/can only be called while test is running/);
    // and from nowhere else: a script that is not Playwright's gets none, even where @playwright/test could be resolved
    expect(() => loadPlaywright(join(here, "worker.test.ts"))).toThrow(/worker\.test\.ts\) is not the playwright package's: it is not a Playwright worker/);
    expect(() => loadPlaywright(require.resolve("@playwright/test/cli"))).toThrow(/is not the playwright package's/);
    expect(() => loadPlaywright(undefined)).toThrow(/\(none\) is not the playwright package's/);
    // the four methods the entry wraps are plain, replaceable methods of the shared prototype
    const proto = Object.getPrototypeOf(mine.chromium) as object;
    expect(Object.getPrototypeOf(mine.firefox)).toBe(proto);
    expect(Object.getPrototypeOf(mine.webkit)).toBe(proto);
    for (const m of ["launch", "launchPersistentContext", "connect", "connectOverCDP"]) {
      const d = Object.getOwnPropertyDescriptor(proto, m);
      expect(typeof d?.value, m).toBe("function");
      expect(d?.writable || d?.configurable, m).toBe(true);
    }
  });
});
