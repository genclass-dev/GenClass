// The register entry's process side: decides whether this process is a Playwright worker, finds the Playwright that
// runs it, and starts the wrapper (wrap.ts) there with the options the environment gives (env.ts). register.ts calls
// startRegister() once, on import; everything is injectable (RegisterIo) so unit tests run it without a process.
//
// The entry is imported in more places than it works in, and does nothing in the others:
//   - through the generated config (genclass-playwright-run): Playwright loads the config in its runner process and
//     again in every worker. In a worker Playwright has set TEST_WORKER_INDEX by then: the wrapper starts at once;
//   - through NODE_OPTIONS="--import <register>": every Node process of the run loads it at startup (the runner, the
//     web server, a package manager, a helper a test forks). Only a child process Playwright started from its own
//     package can become a worker: there it waits for a message from the runner, and starts when TEST_WORKER_INDEX
//     appears (before the worker loads a config or a test file). Anywhere else it reads the environment and returns.
// A worker is three things at once, and the entry starts on nothing less: a child with a channel to its parent (that
// is how Playwright talks to it), whose script is one of the `playwright` package's other than its command (Playwright
// forks its workers from its own package), with TEST_WORKER_INDEX set. A process a test starts inherits
// TEST_WORKER_INDEX and NODE_OPTIONS from the worker, and has a channel too when it was forked: its script is not
// Playwright's, so it is never taken for a worker and Playwright is never loaded into it.
//
// Invariants:
//   - never a second copy of Playwright: the public objects (`test.info`, `chromium`, `firefox`, `webkit`) come from
//     the Playwright that runs this worker, found from the worker's own script (its package's `playwright/test`
//     export) and from nowhere else. Playwright itself is loaded only in a worker;
//   - never throws into the process that imported it; a failure is one remembered line (appended to the file the
//     command names in GENCLASS_NOTES_FILE, else printed once on stderr) and the entry stays inert;
//   - one state per process, on globalThis under a registered symbol, so two copies of this module (or the fixture)
//     see the same one and nothing is wrapped twice.

import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { ENV, isOff, optionsFromEnv, type Env } from "./env.js";
import { findRuntimeDir } from "./install.js";
import { REGISTER_KEY, type TestInfoLike } from "./session.js";
import { Wrapper } from "./wrap.js";

/** What the entry did in this process (globalThis[REGISTER_KEY]). */
export interface RegisterState {
  /** The shape of this object. */
  version: 1;
  /**
   * "idle": not a Playwright worker, nothing done. "off": the off switch is set. "waiting": started by Playwright,
   * not told to be a worker yet. "active": Playwright's public methods are wrapped. "failed": could not start (see
   * `notes`).
   */
  state: "idle" | "off" | "waiting" | "active" | "failed";
  /** The public methods wrapped by the entry itself ("BrowserType.launch", ...). */
  wrapped: string[];
  /** One line per distinct thing that went wrong or was ignored. */
  notes: string[];
  /** The browser contexts the entry instruments. The fixture leaves the pages of these alone. */
  contexts: WeakSet<object>;
  /** Pages the fixture (`@genclass/playwright/fixture`) left to the entry, because their context was already covered. */
  fixturePages: number;
  /** The id of the test running now, as the entry sees it; null when none is (or when the entry is not active). */
  currentTestId(): string | null;
}

/** Playwright's public objects, as far as the entry uses them. */
export interface PlaywrightLike {
  test: { info(): TestInfoLike };
  /** chromium, firefox, webkit: whichever exist. */
  browserTypes: unknown[];
}

/** The process, as far as the entry uses it. */
export interface RegisterIo {
  /** The live environment (TEST_WORKER_INDEX is read again on every message). */
  env: Env;
  cwd: string;
  /**
   * True when the process has a channel to the process that started it, as every Playwright worker has. Without one
   * it is no worker, whatever its environment says (a server a test starts inherits TEST_WORKER_INDEX).
   */
  forked(): boolean;
  /**
   * True when the process's script belongs to the playwright package and is not its command: Playwright started it.
   * Anything else is no worker either, channel or not (a helper a test forks inherits TEST_WORKER_INDEX too).
   */
  playwrightChild(): boolean;
  /** Playwright's public objects, from the copy that runs this process. Throws when there is none. */
  playwright(): PlaywrightLike;
  /** Calls `fn` on every message from the parent process, until the function it returns is called. */
  onMessage(fn: () => void): () => void;
  /** Calls `fn` when the process exits (synchronously: nothing can be awaited there). */
  onExit(fn: () => void): void;
  /** Where a remembered line goes. */
  report(line: string): void;
}

/** After this many messages without becoming a worker, a child process stops listening (it is not one). */
export const MAX_MESSAGES = 16;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A fresh state: nothing done. */
export function newRegisterState(): RegisterState {
  return { version: 1, state: "idle", wrapped: [], notes: [], contexts: new WeakSet<object>(), fixturePages: 0, currentTestId: () => null };
}

/** The process's state, made on first use. */
export function registerState(): RegisterState {
  const g = globalThis as unknown as Record<symbol, RegisterState | undefined>;
  return (g[REGISTER_KEY] ??= newRegisterState());
}

/**
 * The root of the `playwright` package that `main` (a process's script) belongs to, or null when the nearest
 * package.json above it is another package's or none. Playwright starts its workers with a script of that package.
 */
export function playwrightRoot(main: string | undefined): string | null {
  if (!main) return null;
  try {
    for (let dir = dirname(resolve(main)), i = 0; i < 64; i++) {
      const pkg = join(dir, "package.json");
      if (existsSync(pkg)) return (JSON.parse(readFileSync(pkg, "utf8")) as { name?: unknown }).name === "playwright" ? dir : null;
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch {
    /* unreadable: not a package this entry knows */
  }
  return null;
}

/** True when `main` is a script of the `playwright` package other than its command (`bin`): a process Playwright started itself. */
export function isPlaywrightChildScript(main: string | undefined): boolean {
  const root = playwrightRoot(main);
  if (!root || !main) return false;
  try {
    const bin = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: unknown }).bin;
    const bins = typeof bin === "string" ? [bin] : bin && typeof bin === "object" ? Object.values(bin as Record<string, unknown>).filter((b): b is string => typeof b === "string") : [];
    const real = realpathSync(resolve(main));
    return !bins.some((b) => {
      try {
        return realpathSync(join(root, b)) === real;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function shapeOf(mod: unknown, from: string): PlaywrightLike {
  const m = mod as { test?: { info?: unknown }; info?: unknown; chromium?: unknown; firefox?: unknown; webkit?: unknown } | null;
  const test = m && typeof m.test?.info === "function" ? m.test : m && typeof m.info === "function" ? m : null;
  const browserTypes = m ? [m.chromium, m.firefox, m.webkit].filter((t) => typeof t === "object" && t !== null) : [];
  if (!test || browserTypes.length === 0) throw new Error(`${from} does not look like Playwright Test (no test.info or no browser types)`);
  return { test: test as PlaywrightLike["test"], browserTypes };
}

/**
 * Playwright's public objects for a worker whose script is `main`: from the `playwright` package that script belongs
 * to (its `playwright/test` export: the copy that runs the worker, so never a second one). Throws when the script is
 * not one of that package's: Playwright is never looked for anywhere else, so it is never loaded into a process that
 * Playwright is not already running in.
 */
export function loadPlaywright(main: string | undefined): PlaywrightLike {
  const own = playwrightRoot(main);
  if (!own) throw new Error(`this process's script (${main ?? "none"}) is not the playwright package's: it is not a Playwright worker`);
  return shapeOf(createRequire(join(own, "package.json"))("playwright/test"), join(own, "test"));
}

/** The real process. */
export function processIo(): RegisterIo {
  return {
    env: process.env,
    cwd: process.cwd(),
    forked: () => typeof process.send === "function",
    playwrightChild: () => isPlaywrightChildScript(process.argv[1]),
    playwright: () => loadPlaywright(process.argv[1]),
    onMessage(fn) {
      process.on("message", fn);
      return () => void process.off("message", fn);
    },
    onExit: (fn) => void process.on("exit", fn),
    report(line) {
      const file = process.env[ENV.notesFile];
      if (file) appendFileSync(file, `${line}\n`);
      else process.stderr.write(`[@genclass/playwright] ${line}\n`);
    },
  };
}

function activate(io: RegisterIo, state: RegisterState, note: (line: string) => void): void {
  try {
    const env = optionsFromEnv(io.env, io.cwd);
    for (const n of env.notes) note(n);
    let runtimeDir: string;
    try {
      runtimeDir = findRuntimeDir(env.options.runtimeDir, io.cwd);
    } catch (e) {
      throw new Error(`${message(e)} (for a suite run without changes: install @genclass/runtime@beta next to @genclass/playwright, or set ${ENV.runtimeDir} to its dist/ directory)`);
    }
    const pw = io.playwright();
    const wrapper = new Wrapper({ testInfo: () => pw.test.info(), options: { ...env.options, runtimeDir }, note, contexts: state.contexts });
    for (const type of pw.browserTypes) state.wrapped.push(...wrapper.wrapBrowserType(type));
    if (state.wrapped.length === 0) throw new Error("Playwright's browser types have nothing to wrap (no launch, connect or launchPersistentContext, or another copy of this entry has them already)");
    state.currentTestId = () => {
      try {
        const id = pw.test.info().testId;
        return typeof id === "string" ? id : null;
      } catch {
        return null;
      }
    };
    io.onExit(() => {
      wrapper.flush();
      if (state.fixturePages > 0) note(`${state.fixturePages} page${state.fixturePages === 1 ? "" : "s"} of tests that import @genclass/playwright/fixture were left to the register entry: its options come from the environment, not from use.genclass`);
    });
    state.state = "active";
  } catch (e) {
    state.state = "failed";
    note(`GenClass was not put on this run: ${message(e)}`);
  }
}

/**
 * Starts the entry in this process: wraps Playwright's public methods when it is a Playwright worker (a child with a
 * channel, started by Playwright from its own package, with TEST_WORKER_INDEX set), waits to become one when
 * Playwright started it and the index is not there yet, does nothing anywhere else or when the off switch
 * (GENCLASS_PLAYWRIGHT=off) is set. Idempotent (a state that is not "idle" is returned as it is) and never throws.
 */
export function startRegister(io: RegisterIo = processIo(), state: RegisterState = registerState()): RegisterState {
  try {
    if (state.state !== "idle") return state;
    if (isOff(io.env)) {
      state.state = "off";
      return state;
    }
    // a worker is a child with a channel that Playwright started from its own package: nothing else is one, whatever
    // it inherited (a helper a test forks has the channel, TEST_WORKER_INDEX and, preloaded, this entry)
    if (!io.forked() || !io.playwrightChild()) return state;
    const note = (line: string): void => {
      if (state.notes.includes(line)) return;
      state.notes.push(line);
      try {
        io.report(line);
      } catch {
        /* a note is never worth a failure */
      }
    };
    if (io.env.TEST_WORKER_INDEX !== undefined) activate(io, state, note);
    else {
      state.state = "waiting";
      let seen = 0;
      const stop = io.onMessage(() => {
        try {
          if (io.env.TEST_WORKER_INDEX !== undefined) {
            stop();
            if (state.state === "waiting") activate(io, state, note);
          } else if (++seen >= MAX_MESSAGES) {
            stop();
            state.state = "idle";
          }
        } catch {
          /* never into Playwright's message handling */
        }
      });
    }
  } catch {
    /* never into the process that imported the entry */
  }
  return state;
}
