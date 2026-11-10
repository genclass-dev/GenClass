// Shared by the tests: the fixture files (test/fixtures/races: two tests, two seeds each; one signature flagged in
// both seeds of its test, one in a single seed) and the exact report they produce. README.md shows the same report
// (package.test.ts keeps it in sync). Below them, the fakes of Playwright's public objects that the register entry's
// tests wrap (a BrowserType, a Browser, a BrowserContext and a Page, by shape), a fake TestInfo and a stand-in for
// the runtime's dist/.

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT_BINDING, type RequestLike, type RouteLike } from "../src/install.js";
import type { TestInfoLike } from "../src/session.js";
import type { RacesFileInput } from "../src/types.js";

export const here = dirname(fileURLToPath(import.meta.url));
export const racesDir = join(here, "fixtures", "races");

/** The fixture files, as the reporter passes them (names relative to the Playwright config's directory). */
export function fixtureInputs(): RacesFileInput[] {
  return readdirSync(racesDir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => ({ name: `test-results/genclass/${n}`, content: readFileSync(join(racesDir, n), "utf8") }));
}

/** U+200B, which the report puts after "#" before a digit (and "@" before a name) so GitHub links nothing. */
export const Z = "\u200B";

/** The exact report for the fixture, with sources ["test-results/genclass"]. */
export const FIXTURE_REPORT = [
  "<!-- genclass-report -->",
  "## GenClass race report",
  "",
  "**2 signatures** in 2 tests, **1 reproducible** (flagged in 2 or more seeds of the same test) · 4 files read in `test-results/genclass`",
  "",
  "| | signatures | reproducible |",
  "|---|---:|---:|",
  "| Duplicate submits | 1 | 1 |",
  "| Stale responses | 1 | 0 |",
  "| Failing endpoints | 0 | 0 |",
  "| Other detections | 0 | 0 |",
  "",
  "### checkout.spec.ts > checkout > places one order",
  "",
  "2 seeds (1, 2) · 1 signature",
  "",
  "**Duplicate submits**",
  "",
  "- **Reproducible**: 2 of 2 seeds (1, 2) · `POST /api/orders` · `request:duplicate` · confidence 0.97",
  `  > 1 identical POST /api/orders request in the last 10s (#${Z}15, 0.03s earlier, still in flight); no user action between them.`,
  "",
  "### search.spec.ts > search > shows the results of the last query",
  "",
  "2 seeds (1, 2) · 1 signature",
  "",
  "**Stale responses**",
  "",
  "- 1 of 2 seeds (2) · `GET /api/search` · `delivery:stale` · confidence 0.91",
  `  > The response of GET /api/search (#${Z}21) arrives after a newer GET /api/search (#${Z}23) was answered; it would replace results.query, which #${Z}23 wrote 0.31s ago.`,
  "",
  "---",
  "",
  "Each line is a diagnosis by GenClass's on-device model in the page under test, one per signature (trigger, diagnosis, operation). Reproducible: flagged in 2 or more seeds of the same test. A signature seen in fewer seeds may depend on that seed's timing: re-run with more seeds before acting on it. Confidence is the model's probability for the diagnosis (the highest over the seeds), and the quoted evidence line is from that seed.",
  "",
].join("\n");

// ---------------------------------------------------------------------------------------------------------------
// Fakes for the register entry's tests (wrap.test.ts, worker.test.ts): Playwright's public objects by shape, with
// their methods on prototypes, the way the real ones have them (that is what the entry wraps). fakePlaywright() makes
// a fresh set of classes each time, so a test's wrapping never reaches another test.

/** A directory that passes for @genclass/runtime's dist/ (the two files the installer looks for). Remove it after the test. */
export function fakeRuntimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "genclass-rt-"));
  writeFileSync(join(dir, "genclass.global.js"), "/* the script-tag build */\n");
  writeFileSync(join(dir, "agent.js"), "export function connectAgent() {}\n");
  return dir;
}

/** A TestInfo as Playwright's test.info() returns it, as far as the package reads it. `root` stands for the repository. */
export function fakeTestInfo(root: string, over: Partial<TestInfoLike> = {}): TestInfoLike {
  return {
    titlePath: ["checkout.spec.ts", "checkout", "places one order"],
    file: join(root, "tests", "checkout.spec.ts"),
    line: 7,
    testId: "a1b2c3-d4e5f6",
    repeatEachIndex: 0,
    retry: 0,
    status: "passed",
    project: { name: "chromium", testDir: join(root, "tests"), outputDir: join(root, "test-results") },
    config: { configFile: join(root, "playwright.config.ts"), rootDir: join(root, "tests") },
    ...over,
  };
}

type RouteHandler = (route: RouteLike, request: RequestLike) => Promise<void> | void;

/** What the page script's collect() answers on a page whose runtime started and whose agent entry connected. */
export const PAGE_OK = { mode: "observe", model: { state: "off" }, agent: null, serviceWorker: false };

export interface FakePage {
  closed: boolean;
  /** What collect() answers (null: no collector, like about:blank). */
  state: unknown;
  /** Set to make evaluate reject, or to "hang" to make it never answer. */
  fail: Error | "hang" | null;
  evaluated: string[];
  /** The functions exposed on this page alone (page.exposeFunction). */
  exposed: Map<string, (item: unknown) => unknown>;
  context(): FakeContext;
  evaluate(expression: string): Promise<unknown>;
  /** As Playwright's: refuses a name this page or its context already has. */
  exposeFunction(name: string, fn: (item: unknown) => unknown): Promise<void>;
  route(pattern: string, handler: RouteHandler): Promise<void>;
  addInitScript(script: { content: string }): Promise<void>;
  isClosed(): boolean;
  close(): Promise<void>;
}

export interface FakeContext {
  routes: { pattern: string; handler: RouteHandler }[];
  initScripts: string[];
  /** The bindings exposed on the context, by name: called with who called (`{ context, page }`) and what was passed. */
  exposed: Map<string, (source: unknown, item: unknown) => unknown>;
  opened: FakePage[];
  closed: boolean;
  /** The arguments of every close() that reached the original method. */
  closeCalls: unknown[][];
  closeError: Error | null;
  /** Set to make exposeBinding and exposeFunction reject (a context that cannot be instrumented), or to "hang" to make them never answer. */
  exposeError: Error | "hang" | null;
  options: unknown;
  route(pattern: string, handler: RouteHandler): Promise<void>;
  addInitScript(script: { content: string }): Promise<void>;
  exposeBinding(name: string, fn: (source: unknown, item: unknown) => unknown): Promise<void>;
  exposeFunction(name: string, fn: (item: unknown) => unknown): Promise<void>;
  pages(): FakePage[];
  newPage(): Promise<FakePage>;
  browser(): FakeBrowser | null;
  close(...args: unknown[]): Promise<void>;
  /**
   * A page of the context hands an item to Node through the context's binding, as the page script does: `page` when
   * given, else the context's first page (a context that has none yet calls without one).
   */
  push(item: unknown, page?: FakePage): void;
  /** Anything of GenClass is on it. */
  instrumented(): boolean;
}

export interface FakeBrowser {
  open: Set<FakeContext>;
  closed: boolean;
  newContextError: Error | null;
  newContext(options?: unknown): Promise<FakeContext>;
  newPage(options?: unknown): Promise<FakePage>;
  contexts(): FakeContext[];
  close(...args: unknown[]): Promise<string>;
}

export interface FakeBrowserType {
  launched: FakeBrowser[];
  /** The receiver and arguments of every call that reached an original method. */
  calls: { method: string; self: unknown; args: unknown[] }[];
  launchError: Error | null;
  name(): string;
  launch(options?: unknown): Promise<FakeBrowser>;
  launchPersistentContext(userDataDir: string, options?: unknown): Promise<FakeContext>;
  connect(endpoint: string, options?: unknown): Promise<FakeBrowser>;
  connectOverCDP(endpoint: string, options?: unknown): Promise<FakeBrowser>;
}

export interface FakePlaywright {
  chromium: FakeBrowserType;
  firefox: FakeBrowserType;
  webkit: FakeBrowserType;
  /** The three prototypes the entry wraps. */
  protos: { browserType: Record<string, unknown>; browser: Record<string, unknown>; context: Record<string, unknown> };
  /** Every original method call, in order ("browser.newContext", "page.evaluate", "context.close", ...). */
  log: string[];
}

/** A fresh fake Playwright: three browser types on one prototype, as the real chromium, firefox and webkit are. */
export function fakePlaywright(): FakePlaywright {
  const log: string[] = [];

  class Page implements FakePage {
    closed = false;
    state: unknown = { ...PAGE_OK };
    fail: Error | "hang" | null = null;
    evaluated: string[] = [];
    exposed = new Map<string, (item: unknown) => unknown>();
    routes: { pattern: string; handler: RouteHandler }[] = [];
    initScripts: string[] = [];
    owned = false;
    constructor(private readonly ctx: Context) {}
    context(): Context {
      return this.ctx;
    }
    // Playwright's rule (page.exposeBinding): a name already registered on the page or in its browser context is refused
    async exposeFunction(name: string, fn: (item: unknown) => unknown): Promise<void> {
      if (this.exposed.has(name)) throw new Error(`Function "${name}" has been already registered`);
      if (this.ctx.exposed.has(name)) throw new Error(`Function "${name}" has been already registered in the browser context`);
      this.exposed.set(name, fn);
    }
    async route(pattern: string, handler: RouteHandler): Promise<void> {
      this.routes.push({ pattern, handler });
    }
    async addInitScript(script: { content: string }): Promise<void> {
      this.initScripts.push(script.content);
    }
    async evaluate(expression: string): Promise<unknown> {
      log.push("page.evaluate");
      this.evaluated.push(expression);
      if (this.closed || this.ctx.closed) throw new Error("Target page, context or browser has been closed");
      if (this.fail === "hang") return new Promise<unknown>(() => undefined);
      if (this.fail) throw this.fail;
      return this.state;
    }
    isClosed(): boolean {
      return this.closed;
    }
    async close(): Promise<void> {
      // a page of browser.newPage() owns its context: closing it closes the context, through the public method
      if (this.owned) await this.ctx.close();
      this.closed = true;
    }
  }

  class Context implements FakeContext {
    routes: { pattern: string; handler: RouteHandler }[] = [];
    initScripts: string[] = [];
    exposed = new Map<string, (source: unknown, item: unknown) => unknown>();
    opened: Page[] = [];
    closed = false;
    closeCalls: unknown[][] = [];
    closeError: Error | null = null;
    exposeError: Error | "hang" | null = null;
    constructor(
      private readonly owner: Browser | null,
      readonly options: unknown,
    ) {}
    async route(pattern: string, handler: RouteHandler): Promise<void> {
      this.routes.push({ pattern, handler });
    }
    async addInitScript(script: { content: string }): Promise<void> {
      this.initScripts.push(script.content);
    }
    // as Playwright's: the callback's first argument says who called
    async exposeBinding(name: string, fn: (source: unknown, item: unknown) => unknown): Promise<void> {
      if (this.exposeError === "hang") return new Promise<void>(() => undefined);
      if (this.exposeError) throw this.exposeError;
      if (this.exposed.has(name)) throw new Error(`Function "${name}" has been already registered`);
      this.exposed.set(name, fn);
    }
    async exposeFunction(name: string, fn: (item: unknown) => unknown): Promise<void> {
      await this.exposeBinding(name, (_source, item) => fn(item));
    }
    pages(): Page[] {
      return this.opened.filter((p) => !p.closed);
    }
    async newPage(): Promise<Page> {
      const page = new Page(this);
      this.opened.push(page);
      return page;
    }
    browser(): Browser | null {
      return this.owner;
    }
    async close(...args: unknown[]): Promise<void> {
      log.push("context.close");
      this.closeCalls.push(args);
      if (this.closeError) throw this.closeError;
      this.closed = true;
      for (const p of this.opened) p.closed = true;
      this.owner?.open.delete(this);
    }
    push(item: unknown, page: FakePage | undefined = this.opened[0]): void {
      this.exposed.get(CONTEXT_BINDING)?.({ context: this, page, frame: undefined }, item);
    }
    instrumented(): boolean {
      return this.routes.length > 0 || this.initScripts.length > 0 || this.exposed.size > 0;
    }
  }

  class Browser implements FakeBrowser {
    open = new Set<Context>();
    closed = false;
    newContextError: Error | null = null;
    async newContext(options?: unknown): Promise<Context> {
      log.push("browser.newContext");
      if (this.newContextError) throw this.newContextError;
      const context = new Context(this, options);
      this.open.add(context);
      return context;
    }
    // as Playwright's: through this.newContext, so a wrapped newContext is what it calls
    async newPage(options?: unknown): Promise<Page> {
      const context = await this.newContext(options);
      const page = await context.newPage();
      page.owned = true;
      return page;
    }
    contexts(): Context[] {
      return [...this.open];
    }
    async close(...args: unknown[]): Promise<string> {
      log.push("browser.close");
      this.closed = true;
      for (const c of this.open) {
        c.closed = true;
        for (const p of c.opened) p.closed = true;
      }
      this.open.clear();
      return `closed:${JSON.stringify(args)}`;
    }
  }

  class BrowserType implements FakeBrowserType {
    launched: Browser[] = [];
    calls: { method: string; self: unknown; args: unknown[] }[] = [];
    launchError: Error | null = null;
    constructor(private readonly browserName: string) {}
    name(): string {
      return this.browserName;
    }
    private made(): Browser {
      const browser = new Browser();
      this.launched.push(browser);
      return browser;
    }
    async launch(...args: unknown[]): Promise<Browser> {
      log.push("browserType.launch");
      this.calls.push({ method: "launch", self: this, args });
      if (this.launchError) throw this.launchError;
      return this.made();
    }
    async launchPersistentContext(userDataDir: string, options?: unknown): Promise<Context> {
      log.push("browserType.launchPersistentContext");
      this.calls.push({ method: "launchPersistentContext", self: this, args: [userDataDir, options] });
      const browser = this.made();
      const context = new Context(browser, options);
      browser.open.add(context);
      await context.newPage();
      return context;
    }
    async connect(endpoint: string, options?: unknown): Promise<Browser> {
      log.push("browserType.connect");
      this.calls.push({ method: "connect", self: this, args: [endpoint, options] });
      return this.made();
    }
    async connectOverCDP(endpoint: string, options?: unknown): Promise<Browser> {
      log.push("browserType.connectOverCDP");
      this.calls.push({ method: "connectOverCDP", self: this, args: [endpoint, options] });
      return this.made();
    }
  }

  return {
    chromium: new BrowserType("chromium"),
    firefox: new BrowserType("firefox"),
    webkit: new BrowserType("webkit"),
    protos: {
      browserType: BrowserType.prototype as unknown as Record<string, unknown>,
      browser: Browser.prototype as unknown as Record<string, unknown>,
      context: Context.prototype as unknown as Record<string, unknown>,
    },
    log,
  };
}
