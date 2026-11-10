// GenClass on an unmodified Playwright suite: wraps Playwright's public objects, through their prototypes, so that
// a browser context a test makes gets what the fixture gives a page (session.ts, install.ts): the runtime before the
// app's first script, in observe mode with telemetry off, the seeded chaos when it is on, and the collection of what
// the runtime saw, written as one "genclass-races/1" file per test, seed and retry.
//
// What is wrapped, and nothing else:
//   - BrowserType.launch, connect, connectOverCDP: the browser they return is how Browser's prototype is reached
//     (Playwright exports no Browser class); BrowserType.launchPersistentContext returns a context, treated as below;
//   - Browser.newContext: the context it returns is instrumented when it is a test's (Browser.newPage calls it);
//   - BrowserContext.close and Browser.close: before a context goes away, what its pages saw is collected and the
//     test's file is written. A test that opens several pages or contexts gets one file: they are merged.
// The test comes from the `testInfo` given (Playwright's own `test.info()`): when it throws, no test is running and
// the context is left exactly as Playwright made it.
//
// A context is one test's, or it is nobody's. Playwright keeps a test current while it runs that test's beforeAll and
// afterAll hooks and while it sets up a worker-scoped fixture for it, so "a test is running" is not enough:
//   1. a context made while a beforeAll or afterAll hook runs is shared by the tests of its describe: it is left
//      exactly as Playwright made it. Which hook is running is the one thing read from outside the public API
//      (`testInfo._currentHookType()`, the call Playwright's own `context` fixture makes to refuse those hooks), by
//      shape: where the method is missing or answers something else, the context is taken for a test's, and rule 2
//      still holds;
//   2. a context belongs to the test that was running when it was made, and only while that test is the one
//      `test.info()` gives. What its pages hand over at any other time is dropped, a request it sends then is passed on
//      without a hold, and when it is found still open after its test (at such a push or request, at its close, at
//      its browser's close, at the next test's first context, at the end of the process) it is released: its held
//      requests leave, its pages are not asked, and the test's file is written with what was handed over while the test
//      ran. So a context kept for later tests (a variable, a worker-scoped fixture) or one a test did not close never
//      puts anything into another test's file, and never rewrites its own test's file with later findings. This rule
//      uses `test.info()` alone.
//
// Invariants:
//   - a wrapped call is the original call: same receiver, same arguments, the same result and the same error. The
//     original is called through `super.<its own name>(...)`, from a method of that name, so Playwright, which names an
//     API call after the stack frame that entered it (and reads that name through source maps), still says
//     "browserType.launch" in its errors and steps. A call adds one stack frame of this file (two for a close that
//     first waits for the collection), nothing else;
//   - wrapping is idempotent (a wrapped function carries WRAPPED, and is never wrapped again, by this copy of the
//     module or another);
//   - nothing here throws into the test run or changes its outcome: every hook catches its own errors, hands the
//     result back untouched and remembers one line (`note`); a context that could not be instrumented is a context
//     without GenClass;
//   - only public Playwright API, by shape: no import of Playwright, and no private member apart from the one
//     shape-checked read of rule 1, which nothing depends on.

import { CONTEXT_BINDING, install, type Collected, type PageLike, type RequestLike, type RouteLike, type Session } from "./install.js";
import { mergeAgent, mergeCollected, planRun, writeRun, type GenClassOptions, type RunPlan, type TestInfoLike } from "./session.js";

/** Marks a function this module put on a prototype (a registered symbol: the same in every copy of the module). */
export const WRAPPED = Symbol.for("@genclass/playwright/wrapped");
/** The longest a new context waits for GenClass before it is handed back without it, in ms. */
export const ATTACH_CAP_MS = 15_000;
/** The line remembered when a context made in a beforeAll or afterAll hook is left alone. */
export const HOOK_NOTE = "a browser context made in a beforeAll or afterAll hook was left without GenClass: it is shared by the tests of its describe, so what it sees is no single test's";
/** The line remembered when a context is found still open after the test that made it. */
export const OUTLIVED_NOTE =
  "a browser context was still open after the test that made it (kept for later tests, or not closed): that test's file has what the context handed over while the test ran; after that nothing from it was recorded and none of its requests were held";

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

/** A page of a context, as far as this module uses it (Playwright's Page, by shape). */
export interface ContextPageLike {
  evaluate(expression: string): Promise<unknown>;
  isClosed?(): boolean;
}

/** A browser context, as far as this module uses it (Playwright's BrowserContext, by shape). */
export interface ContextLike {
  route(url: string, handler: (route: RouteLike, request: RequestLike) => Promise<void> | void): Promise<unknown>;
  addInitScript(script: { content: string }): Promise<unknown>;
  /** Playwright's exposeBinding: the callback's first argument says who called (`{ page, frame, ... }`), the rest is what the page passed. */
  exposeBinding(name: string, fn: (source: unknown, item: unknown) => unknown): Promise<unknown>;
  pages(): ContextPageLike[];
}

export interface WrapDeps {
  /** The test running now (Playwright's `test.info()`). Throws when no test is running. */
  testInfo(): TestInfoLike;
  /** What the fixture takes from `use.genclass` (here: from the environment, env.ts). */
  options: GenClassOptions;
  /** Remembers one line for the summary. */
  note(line: string): void;
  /** Every context this wrapper instruments is added here (the fixture leaves the pages of those alone). */
  contexts?: WeakSet<object>;
}

/**
 * What the pages of one context pushed that a later push from another of its pages must not undo. The binding is the
 * context's, so every page pushes through it, and install.ts keeps the last status and the last agent state it got,
 * whichever page they came from. Kept here per page, as the fixture has it for its one page: a page counts with the
 * state it reported last (a page that navigates reports again), and a page that is closed still counts.
 */
interface Sticky {
  /** The agent state each page reported last: null when its agent entry connected, else why not. */
  agents: Map<object, string | null>;
  /** Each distinct reason reported by a caller whose page is not known: none of them is ever taken back. */
  unknown: string[];
  /** A page's runtime started (a status with a mode arrived): a page whose runtime did not start no longer changes the mode. */
  started: boolean;
}

/** One browser context of a test. */
interface ContextSession {
  run: TestRun;
  install: Session;
  sticky: Sticky;
  /** What the context collected (null until it was asked at close, or released after its test). */
  collected: Collected | null;
  /** Set once collecting has started (a context is asked once); it resolves when the test's file was written. */
  done: Promise<void> | null;
}

/** One test (one attempt of it, under one seed): its contexts and its file. */
interface TestRun {
  /** testId, repeat index and attempt: what tells this run from every other in the process. */
  key: string;
  info: TestInfoLike;
  plan: RunPlan;
  sessions: ContextSession[];
  /** Contexts being instrumented right now (a run is kept while one is). */
  attaching: number;
  /** Where its file was written last (null: not yet, or the test was skipped). */
  path: string | null;
}

interface BrowserTypeMethods {
  launch(...args: unknown[]): unknown;
  launchPersistentContext(...args: unknown[]): unknown;
  connect(...args: unknown[]): unknown;
  connectOverCDP(...args: unknown[]): unknown;
}
interface BrowserMethods {
  newContext(...args: unknown[]): unknown;
  close(...args: unknown[]): unknown;
}
interface ContextMethods {
  close(...args: unknown[]): unknown;
}

/** Runs after a wrapped call resolved, with its value. Never rejects. */
type After = (value: unknown) => Promise<void>;
/** Runs before a wrapped close, with the object being closed: a promise to wait for, or null for nothing to do. Never rejects. */
type Before = (target: unknown) => Promise<void> | null;

function isObject(v: unknown): v is object {
  return (typeof v === "object" && v !== null) || typeof v === "function";
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return isObject(v) && typeof (v as { then?: unknown }).then === "function";
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function keyOf(info: TestInfoLike): string {
  return `${info.testId}\u0000${info.repeatEachIndex}\u0000${info.retry ?? 0}`;
}

/**
 * The hook Playwright is running for this test ("beforeAll", "afterAll", "beforeEach", "afterEach"), or undefined
 * for none. Read by shape from `testInfo._currentHookType()`, which is not public API: a missing method, a throw or
 * an answer that is not a string all mean "not a hook" (see rule 1 in the header).
 */
export function hookOf(info: TestInfoLike): string | undefined {
  try {
    const read = (info as unknown as { _currentHookType?: unknown })._currentHookType;
    const hook = typeof read === "function" ? (read as (this: unknown) => unknown).call(info) : undefined;
    return typeof hook === "string" ? hook : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What install.ts collected, with the agent state of every page counted (Sticky): connected only when no page's last
 * word was that its agent entry did not connect, whether that page is still open or not.
 */
function withSticky(collected: Collected, sticky: Sticky): Collected {
  const failures = [...sticky.agents.values()].filter((state): state is string => state !== null).concat(sticky.unknown);
  return failures.length ? { ...collected, agent: mergeAgent([collected.agent, ...failures]) } : collected;
}

/** The result as it was; when it is a promise, `hook` runs on its value before the caller gets it. */
function after(result: unknown, hook: After): unknown {
  if (!isThenable(result)) return result;
  return result.then(async (value) => {
    try {
      await hook(value);
    } catch {
      /* never the caller's problem */
    }
    return value;
  });
}

// The three sets of methods below call the original through `super.<name>(...)`: `originals` is made the prototype
// their class extends, so `super.launch` is the original `launch`, called with the caller's own `this`. Written out
// per name on purpose: the name at the call site is what Playwright reads (see the header).

function browserTypeMethods(originals: Partial<BrowserTypeMethods>, browser: After, context: After): BrowserTypeMethods {
  const Originals = function () {} as unknown as { new (): BrowserTypeMethods; prototype: Partial<BrowserTypeMethods> };
  Originals.prototype = originals;
  class BrowserType extends Originals {
    override launch(...args: unknown[]): unknown {
      return after(super.launch(...args), browser);
    }
    override launchPersistentContext(...args: unknown[]): unknown {
      return after(super.launchPersistentContext(...args), context);
    }
    override connect(...args: unknown[]): unknown {
      return after(super.connect(...args), browser);
    }
    override connectOverCDP(...args: unknown[]): unknown {
      return after(super.connectOverCDP(...args), browser);
    }
  }
  return BrowserType.prototype;
}

function browserMethods(originals: Partial<BrowserMethods>, context: After, closing: Before): BrowserMethods {
  const Originals = function () {} as unknown as { new (): BrowserMethods; prototype: Partial<BrowserMethods> };
  Originals.prototype = originals;
  class Browser extends Originals {
    override newContext(...args: unknown[]): unknown {
      return after(super.newContext(...args), context);
    }
    override close(...args: unknown[]): unknown {
      const pending = closing(this);
      if (!pending) return super.close(...args);
      return (async () => {
        await pending;
        return super.close(...args);
      })();
    }
  }
  return Browser.prototype;
}

function contextMethods(originals: Partial<ContextMethods>, closing: Before): ContextMethods {
  const Originals = function () {} as unknown as { new (): ContextMethods; prototype: Partial<ContextMethods> };
  Originals.prototype = originals;
  class BrowserContext extends Originals {
    override close(...args: unknown[]): unknown {
      const pending = closing(this);
      if (!pending) return super.close(...args);
      return (async () => {
        await pending;
        return super.close(...args);
      })();
    }
  }
  return BrowserContext.prototype;
}

/** The prototype (never the object itself) that owns `name` as a plain, replaceable, not yet wrapped method, with its descriptor. */
function ownerOf(target: object, name: string): { owner: object; desc: PropertyDescriptor & { value: AnyFn } } | null {
  for (let p: object | null = Object.getPrototypeOf(target); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    const desc = Object.getOwnPropertyDescriptor(p, name);
    if (!desc) continue;
    if (typeof desc.value !== "function" || (desc.value as unknown as Record<symbol, unknown>)[WRAPPED]) return null;
    if (!desc.writable && !desc.configurable) return null;
    return { owner: p, desc: desc as PropertyDescriptor & { value: AnyFn } };
  }
  return null;
}

/**
 * What the pages of one context answered to the page script's collect(), as the one answer install.ts reads: the mode
 * and model of the first page whose runtime started, a service worker on any, and an agent state that is null
 * (connected) only when it is null on every page whose runtime started. Null when no page had the collector (no
 * http page was open).
 */
export function mergePageStates(results: readonly unknown[]): Record<string, unknown> | null {
  const states = results.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  if (states.length === 0) return null;
  const started = states.filter((s) => typeof s.mode === "string");
  const out: Record<string, unknown> = { serviceWorker: states.some((s) => s.serviceWorker === true) };
  if (started.length) out.mode = started[0].mode;
  const model = started.find((s) => s.model && typeof s.model === "object")?.model;
  if (model) out.model = model;
  const agents = (started.length ? started : states).map((s) => s.agent).filter((a): a is string | null => a === null || typeof a === "string");
  if (agents.length) out.agent = mergeAgent(agents);
  return out;
}

/**
 * A context as the page install.ts works on: its routes, init script and binding cover every page it opens. The
 * binding is exposed with the context's exposeBinding, which says which page called. What a page pushes reaches
 * install.ts only while `live()` says the context's test is still running, and after `sticky` has noted what a later
 * push from another page must not undo: the agent state that page reported last, and a mode once a runtime started
 * (a status without one is then not passed on).
 */
function pageLikeOf(context: ContextLike, live: () => boolean, sticky: Sticky): PageLike {
  const take = (fn: (item: unknown) => unknown, source: unknown, item: unknown): void => {
    try {
      if (!live()) return;
      if (item && typeof item === "object") {
        const x = item as Record<string, unknown>;
        if (x.t === "agent") {
          const state = x.ok === true ? null : String(x.reason ?? "unknown");
          const page = isObject(source) ? (source as { page?: unknown }).page : undefined;
          if (isObject(page)) sticky.agents.set(page, state);
          else if (state !== null && !sticky.unknown.includes(state)) sticky.unknown.push(state);
        } else if (x.t === "status") {
          if (typeof x.mode === "string") sticky.started = true;
          else if (sticky.started) return;
        }
      }
      fn(item);
    } catch {
      /* never into Playwright's binding call */
    }
  };
  return {
    route: async (url, handler) => void (await context.route(url, handler)),
    addInitScript: async (script) => void (await context.addInitScript(script)),
    exposeFunction: async (name, fn) => void (await context.exposeBinding(name, (source, item) => take(fn, source, item))),
    // every open page is asked; one that is closed, crashed or mid-navigation answers nothing
    async evaluate(expression: string): Promise<unknown> {
      let pages: ContextPageLike[] = [];
      try {
        pages = context.pages();
      } catch {
        /* the context is gone */
      }
      const results = await Promise.all(
        pages.map(async (page) => {
          try {
            return page.isClosed?.() ? null : await page.evaluate(expression);
          } catch {
            return null;
          }
        }),
      );
      return mergePageStates(results);
    },
    isClosed: () => false,
  };
}

function isContext(v: unknown): v is ContextLike & object {
  if (!isObject(v)) return false;
  const c = v as Partial<Record<keyof ContextLike, unknown>>;
  return typeof c.route === "function" && typeof c.addInitScript === "function" && typeof c.exposeBinding === "function" && typeof c.pages === "function";
}

/**
 * The wrapper of one process. `wrapBrowserType` is the way in (worker.ts calls it with Playwright's chromium, firefox
 * and webkit); everything else follows from the objects Playwright returns.
 */
export class Wrapper {
  private readonly sessions = new WeakMap<object, ContextSession>();
  private readonly runs = new Map<string, TestRun>();

  constructor(private readonly deps: WrapDeps) {}

  /**
   * Wraps launch, launchPersistentContext, connect and connectOverCDP on the prototype of a BrowserType (Playwright's
   * `chromium`; `firefox` and `webkit` share it). Returns what was wrapped now ("BrowserType.launch", ...): nothing
   * the second time.
   */
  wrapBrowserType(browserType: unknown): string[] {
    return this.wrap("BrowserType", browserType, ["launch", "launchPersistentContext", "connect", "connectOverCDP"], (originals) =>
      browserTypeMethods(originals, this.afterBrowser, this.afterPersistentContext),
    );
  }

  /** Wraps newContext and close on a browser's prototype. Returns what was wrapped now. */
  wrapBrowser(browser: unknown): string[] {
    return this.wrap("Browser", browser, ["newContext", "close"], (originals) => browserMethods(originals, this.afterNewContext, this.beforeBrowserClose));
  }

  /** Wraps close on a context's prototype. Returns what was wrapped now. */
  wrapContext(context: unknown): string[] {
    return this.wrap("BrowserContext", context, ["close"], (originals) => contextMethods(originals, this.beforeContextClose));
  }

  /**
   * Puts GenClass on a context for the test running now. False (and the context untouched) when no test is running,
   * when a beforeAll or afterAll hook is (the context is then shared by several tests), when the context already has
   * it, or when it could not be done.
   */
  async attach(context: unknown): Promise<boolean> {
    try {
      if (!isContext(context) || this.sessions.has(context) || this.deps.contexts?.has(context)) return false;
      let info: TestInfoLike;
      try {
        info = this.deps.testInfo();
      } catch {
        return false; // no test is running: the context is left as Playwright made it
      }
      if (!info || typeof info !== "object") return false;
      const hook = hookOf(info);
      if (hook === "beforeAll" || hook === "afterAll") {
        this.note(HOOK_NOTE);
        return false; // not one test's: left as Playwright made it
      }
      const run = this.runOf(info);
      const o = this.deps.options;
      // from here on the context is this wrapper's, even if the next step fails: the fixture must not install on its
      // pages over a half-installed context
      this.deps.contexts?.add(context);
      run.attaching++;
      try {
        const sticky: Sticky = { agents: new Map<object, string | null>(), unknown: [], started: false };
        let session: ContextSession | null = null;
        // asked at every push and before every hold: the context's test is still the one running. When it is not, the
        // context has outlived its test and is released there and then
        const live = (): boolean => {
          if (this.isCurrent(run)) return true;
          if (session) this.outlive(session);
          return false;
        };
        const installed = await install(pageLikeOf(context, live, sticky), { runtimeDir: o.runtimeDir, model: run.plan.model, modelUrl: o.modelUrl, chaos: run.plan.chaos, binding: CONTEXT_BINDING, live });
        session = { run, install: installed, sticky, collected: null, done: null };
        this.sessions.set(context, session);
        run.sessions.push(session);
        // the test ended while the context was being set up
        if (!this.isCurrent(run)) this.outlive(session);
      } finally {
        run.attaching--;
      }
      return true;
    } catch (e) {
      this.note(`could not put GenClass on a browser context: ${message(e)}`);
      return false;
    }
  }

  /**
   * Writes the file of every test that still has a context nobody closed, from what its pages handed over while that
   * test ran. Synchronous: for the end of the process. Never throws.
   */
  flush(): void {
    try {
      for (const run of this.runs.values()) {
        if (!this.isCurrent(run)) for (const s of run.sessions) this.outlive(s);
        // the test still running as the process ends, or a context whose collection had started
        if (run.sessions.some((s) => s.collected === null)) this.write(run);
      }
    } catch (e) {
      this.note(`could not write the race files left at the end: ${message(e)}`);
    }
  }

  /** The files written so far, one per test that had a context (for the summary and for tests). */
  written(): string[] {
    return [...this.runs.values()].map((r) => r.path).filter((p): p is string => p !== null);
  }

  private note(line: string): void {
    try {
      this.deps.note(line);
    } catch {
      /* a note is never worth a failure */
    }
  }

  private wrap<M extends object>(kind: string, target: unknown, names: readonly (keyof M & string)[], methods: (originals: Partial<M>) => M): string[] {
    const done: string[] = [];
    try {
      if (!isObject(target)) return done;
      const found = names.map((name) => ({ name, at: ownerOf(target, name) })).filter((f): f is { name: keyof M & string; at: NonNullable<ReturnType<typeof ownerOf>> } => f.at !== null);
      if (found.length === 0) return done;
      const originals: Partial<M> = {};
      for (const f of found) (originals as Record<string, AnyFn>)[f.name] = f.at.desc.value;
      const wrapped = methods(originals) as unknown as Record<string, AnyFn>;
      for (const f of found) {
        try {
          const fn = wrapped[f.name];
          Object.defineProperty(fn, WRAPPED, { value: true });
          Object.defineProperty(fn, "length", { value: f.at.desc.value.length, configurable: true });
          Object.defineProperty(f.at.owner, f.name, { ...f.at.desc, value: fn });
          done.push(`${kind}.${f.name}`);
        } catch (e) {
          this.note(`${kind}.${f.name} could not be wrapped: ${message(e)}`);
        }
      }
    } catch (e) {
      this.note(`${kind} could not be wrapped: ${message(e)}`);
    }
    return done;
  }

  /** `work`, with its errors and a time limit turned into a note: what a wrapped call waits for before it returns. */
  private settled(what: string, work: () => Promise<void>): Promise<void> {
    return new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.note(`${what} took more than ${ATTACH_CAP_MS / 1000}s; the test went on without waiting`);
        done();
      }, ATTACH_CAP_MS);
      timer.unref?.();
      const finish = (): void => {
        clearTimeout(timer);
        done();
      };
      try {
        work().then(finish, (e) => {
          this.note(`${what}: ${message(e)}`);
          finish();
        });
      } catch (e) {
        this.note(`${what}: ${message(e)}`);
        finish();
      }
    });
  }

  private readonly afterBrowser: After = async (browser) => {
    this.wrapBrowser(browser);
  };

  private readonly afterNewContext: After = (context) =>
    this.settled("putting GenClass on a browser context", async () => {
      this.wrapContext(context);
      await this.attach(context);
    });

  private readonly afterPersistentContext: After = (context) =>
    this.settled("putting GenClass on a persistent context", async () => {
      this.wrapContext(context);
      const browser = isObject(context) && typeof (context as { browser?: unknown }).browser === "function" ? (context as { browser(): unknown }).browser() : null;
      if (browser) this.wrapBrowser(browser);
      await this.attach(context);
    });

  // A context that was collected already closes at once; one that is being collected right now (a second close, or
  // its browser closing meanwhile) waits for that same collection, so the pages are still there to answer.
  private readonly beforeContextClose: Before = (context) => {
    try {
      const session = isObject(context) ? this.sessions.get(context) : undefined;
      return session ? this.closing(session) : null;
    } catch {
      return null;
    }
  };

  private readonly beforeBrowserClose: Before = (browser) => {
    try {
      const contexts = isObject(browser) && typeof (browser as { contexts?: unknown }).contexts === "function" ? (browser as { contexts(): unknown[] }).contexts() : [];
      const pending = contexts
        .map((c) => (isObject(c) ? this.sessions.get(c) : undefined))
        .map((s) => (s ? this.closing(s) : null))
        .filter((p): p is Promise<void> => p !== null);
      return pending.length ? Promise.all(pending).then(() => undefined) : null;
    } catch {
      return null;
    }
  };

  /**
   * What a close of the context waits for: its collection, when its test is still the one running; nothing when it
   * was collected already, or when its test is over (it is released without asking its pages).
   */
  private closing(session: ContextSession): Promise<void> | null {
    if (session.collected !== null) return null;
    if (session.done) return session.done;
    if (this.isCurrent(session.run)) return this.finish(session);
    this.outlive(session);
    return null;
  }

  /** The run's test is the one running now, by Playwright's `test.info()`. */
  private isCurrent(run: TestRun): boolean {
    try {
      const info = this.deps.testInfo();
      return !!info && typeof info === "object" && keyOf(info) === run.key;
    } catch {
      return false; // no test is running
    }
  }

  /**
   * The context is still open and its test is over: it stops here. Its held requests leave and no later one is held,
   * nothing more is taken from it, its pages are not asked (another test may be using them), and its test's file is
   * written with what it handed over while that test ran. Once per context; never throws.
   */
  private outlive(session: ContextSession): void {
    if (session.collected !== null || session.done) return;
    try {
      session.install.release();
      session.collected = withSticky(session.install.snapshot(), session.sticky);
    } catch {
      session.collected = { records: [], witnesses: [], mode: null, model: null, agent: "not-loaded", plans: [], serviceWorker: false, modeOverridden: null };
    }
    this.note(OUTLIVED_NOTE);
    this.write(session.run);
  }

  /**
   * The test's run, made on its first context. When a test's first context is made, every other test is over: their
   * contexts still open are released (outlive), and a run whose contexts are all collected is dropped.
   */
  private runOf(info: TestInfoLike): TestRun {
    const key = keyOf(info);
    let run = this.runs.get(key);
    if (!run) {
      for (const [k, r] of this.runs) {
        if (r.attaching !== 0) continue;
        for (const s of r.sessions) this.outlive(s);
        if (r.sessions.every((s) => s.collected !== null)) this.runs.delete(k);
      }
      run = { key, info, plan: planRun(this.deps.options, info), sessions: [], attaching: 0, path: null };
      this.runs.set(key, run);
    }
    return run;
  }

  /** Asks the context's pages once, then writes the test's file with everything its contexts collected so far. Never rejects. */
  private finish(session: ContextSession): Promise<void> {
    session.done ??= (async () => {
      let collected: Collected;
      try {
        collected = await session.install.finish();
      } catch {
        collected = session.install.snapshot();
      }
      session.collected = withSticky(collected, session.sticky);
      this.write(session.run);
    })().catch((e) => this.note(`could not collect from a browser context: ${message(e)}`));
    return session.done;
  }

  /** One file per test: its contexts merged (one still open gives what it handed over so far). Never throws. */
  private write(run: TestRun): void {
    try {
      const collected = mergeCollected(run.sessions.map((s) => s.collected ?? withSticky(s.install.snapshot(), s.sticky)));
      run.path = writeRun(run.info, this.deps.options.outDir, run.plan, collected).path ?? run.path;
    } catch (e) {
      this.note(`could not write the race file: ${message(e)}`);
    }
  }
}
