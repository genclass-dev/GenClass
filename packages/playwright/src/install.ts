// Puts GenClass on a Playwright page without touching the app under test, and collects what it saw. Node only, but
// Playwright-agnostic: it takes the few page methods it uses as an interface (PageLike), so unit tests drive it with
// a fake page and the fixture (fixture.ts) passes the real one.
//
// What it does to the page:
//   - serves @genclass/runtime's dist/ (resolved from the installed package, or `runtimeDir`) on the virtual
//     same-origin path RUNTIME_PATH ("/__genclass__/") with page.route, so the script-tag build, the agent entry and
//     anything the runtime loads later come from disk, never from a CDN;
//   - adds one init script (page.addInitScript): the page-side function of page.ts plus the script-tag build, so the
//     runtime starts before the app's first script, in observe mode with telemetry off and the model as chosen;
//   - exposes one function (page.exposeFunction) the page pushes each finding through as it happens, so navigations
//     and an early page close lose nothing;
//   - with chaos, routes every request through the seeded scheduler (chaos.ts): a matched fetch/XHR request is held
//     for its planned time and then passed on with route.fallback(), so it still reaches the user's own routes
//     (context.route, routeFromHAR), the browser's network stack and its cache. Anything else is passed on at once.
//     An identical read, and a write to the same path, leave in the order the page sent them, whatever their delays.
// The page's agent link never sends a request (page.ts gives it a stand-in fetch); requests to its URL are aborted
// anyway as a safety net. Observe only: no hold on the page's side, no change to any request or response (chaos
// changes when a request leaves, never what it says). Every handler catches its own errors: a page that closes
// mid-test is not a failure.
//
// An install belongs to one test. The fixture finishes it with that test. The register entry installs on a browser
// context, which can stay open after its test: it passes `live` (asked before anything is taken or held) and calls
// release(), so that from the moment the test is over nothing is recorded and no request is held. The runtime's files
// are still served after that: the init script stays on the context, and a page that asks for them must get them.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { ChaosScheduler, RUNTIME_PATH, isCandidate, isRuntimeUrl, orderKey, type ResolvedChaos } from "./chaos.js";
import { genclassPageScript, type PageScriptConfig } from "./page.js";

/** The page methods the installer uses (a subset of Playwright's Page, by shape). */
export interface PageLike {
  route(url: string, handler: (route: RouteLike, request: RequestLike) => Promise<void> | void): Promise<void>;
  addInitScript(script: { content: string }): Promise<void>;
  exposeFunction(name: string, fn: (item: unknown) => unknown): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  /**
   * The same expression in every page there is, one answer per page (null for a page that could not answer). A browser
   * context has it (wrap.ts); for a single page `evaluate` is asked instead.
   */
  evaluateEach?(expression: string): Promise<unknown[]>;
  isClosed?(): boolean;
}

export interface RouteLike {
  fulfill(options: { status?: number; headers?: Record<string, string>; body?: string | Buffer; contentType?: string }): Promise<void>;
  fallback(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export interface RequestLike {
  url(): string;
  method(): string;
  resourceType(): string;
  headers(): Record<string, string>;
  frame(): { url(): string };
  /** The request's body as text, when it has one (Playwright's Request.postData). */
  postData?(): string | null;
}

export interface InstallOptions {
  /** The runtime's dist/ directory. Default: the installed @genclass/runtime package's. */
  runtimeDir?: string;
  /** "skip": no model (the file carries witnesses only). "load": the runtime loads its model. */
  model: "skip" | "load";
  /** With `model: "load"`: a model directory URL (the runtime's `model.baseUrl`). */
  modelUrl?: string;
  /** Resolved chaos, or null for none. */
  chaos: ResolvedChaos | null;
  /**
   * At the end of the test: how long, at most, to wait for the responses to requests the page had already sent, in
   * ms (see `finish`). 0 or unset: no wait.
   */
  waitForResponsesMs?: number;
  /** The name of the function exposed for the page to hand items over through. Default BINDING. */
  binding?: string;
  /**
   * Asked each time the page hands something over and each time a request could be held: false when the test this
   * install belongs to is no longer the one running. The item is then dropped and the request passed on at once, so
   * nothing is filed under a test that did not see it. Default: always live (the fixture finishes with its test).
   */
  live?: () => boolean;
}

/** The runtime's model status as the page reported it last. */
export interface ModelInfo {
  state?: string;
  name?: string;
  version?: string;
  device?: string;
}

/** What one test collected. */
export interface Collected {
  /** Sink records of kind "detection" (likely tier), as the runtime sent them. */
  records: unknown[];
  /** The agent entry's witnesses, in order of appearance. */
  witnesses: unknown[];
  /** The runtime's mode on the page (null: it never started). */
  mode: string | null;
  /** Its model status (null: it never started). */
  model: ModelInfo | null;
  /** The agent entry's state: null when connected, else why not ("not-loaded", an error message). */
  agent: string | null;
  /** The chaos plans applied, in request order. */
  plans: { key: string; delayMs: number }[];
  /** A service worker controlled the page when the fixture collected (page.route does not see what it handles). */
  serviceWorker: boolean;
  /** The URL or localStorage switch had put the runtime in another mode; the fixture set it back to observe. */
  modeOverridden: string | null;
}

export interface Session {
  /**
   * Collect what the page still holds, release every chaos hold, and return everything seen. Before it collects it
   * waits for the responses to requests the page had sent a moment ago and not seen answered (a held request counts:
   * it leaves when its planned delay is over, as during the test), so that a response landing after the test's last
   * assertion is still observed. The wait ends when they have all been answered, and at the latest after
   * `waitForResponsesMs`, or after `budgetMs` when that is less (what the test has left of its own timeout). Requests
   * sent longer ago than `waitForResponsesMs` are long-running (a stream, a long poll) and are not waited for; neither
   * are requests the page sends during the wait. Nothing is waited for when the option is 0 or the page is gone.
   */
  finish(budgetMs?: number): Promise<Collected>;
  /**
   * What the page handed over so far, without asking it and without releasing anything: for a caller that cannot
   * wait (the process is exiting with the page still open). A copy; `finish()` stays the complete answer.
   */
  snapshot(): Collected;
  /**
   * Stops the install without asking the page: every held request leaves now, later ones are passed on at once, and
   * nothing the page hands over from here on is kept. For a page that is still open when its test is over.
   * `snapshot()` then gives what was handed over until this call; `finish()` no longer asks the page.
   */
  release(): void;
}

/** The name of the function the fixture exposes on a page. */
export const BINDING = "__genclassPlaywright";
/**
 * The name of the function the register entry exposes on a browser context. A name of its own: Playwright refuses a
 * page-level function whose name the page's context already has, so with one shared name a page-level install next to
 * a context-level one would throw into the test. With two names, the second init script to run stops at the first
 * one's window.__GENCLASS_PLAYWRIGHT__ and nothing is installed twice.
 */
export const CONTEXT_BINDING = "__genclassPlaywrightContext";
/** The loopback URL the page's agent link is pointed at; the fixture aborts every request to it. */
export const AGENT_URL = "http://127.0.0.1:9";
/** How often the fixture asks the page which of the awaited requests are still unanswered, in ms. */
export const WAIT_POLL_MS = 40;
/** After the last awaited response: time for its handler to run and the app to write its state before collecting, in ms. */
export const WAIT_GRACE_MS = 120;
/** How long one question to the page may take before it counts as unanswered, in ms. */
const ASK_MS = 1000;
const OPEN_EXPRESSION = `(function () { var a = window.__GENCLASS_PLAYWRIGHT__; return a && a.open ? a.open() : null; })()`;

/** What window.__GENCLASS_PLAYWRIGHT__.open() answers (page.ts): the page load, and its unanswered requests with their age. */
function openOf(v: unknown): { id: string; open: [string, number][] } | null {
  if (!v || typeof v !== "object") return null;
  const x = v as { id?: unknown; open?: unknown };
  if (typeof x.id !== "string" || !Array.isArray(x.open)) return null;
  const open = x.open.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number");
  return { id: x.id, open };
}

const sleep = (ms: number): Promise<void> => new Promise<void>((res) => void setTimeout(res, Math.max(0, ms)).unref?.());

const require = createRequire(import.meta.url);
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};
const fileCache = new Map<string, Buffer>();

/** The installed @genclass/runtime's dist/ directory (its package.json export), or `given`. Throws when neither exists. */
export function resolveRuntimeDir(given?: string): string {
  if (given) {
    const dir = resolve(given);
    if (!existsSync(join(dir, "genclass.global.js"))) throw new Error(`@genclass/playwright: runtimeDir ${dir} has no genclass.global.js (point it at @genclass/runtime's dist/)`);
    return dir;
  }
  let pkg: string;
  try {
    pkg = require.resolve("@genclass/runtime/package.json");
  } catch {
    throw new Error("@genclass/playwright: @genclass/runtime is not installed (npm install -D @genclass/runtime@beta), or pass genclass.runtimeDir");
  }
  const dir = join(dirname(pkg), "dist");
  if (!existsSync(join(dir, "genclass.global.js"))) throw new Error(`@genclass/playwright: ${dir} has no genclass.global.js: the installed @genclass/runtime has no build`);
  if (!existsSync(join(dir, "agent.js"))) throw new Error(`@genclass/playwright: ${dir} has no agent.js: the fixture needs @genclass/runtime 0.3.0-beta.1 or later`);
  return dir;
}

/**
 * The same for a suite that was not written for GenClass (the register entry and its command): the directory given,
 * else the package installed next to this one, else the project's own, resolved from `cwd`. Throws
 * resolveRuntimeDir's error when there is none.
 */
export function findRuntimeDir(given: string | undefined, cwd: string): string {
  try {
    return resolveRuntimeDir(given);
  } catch (e) {
    if (given) throw e;
    try {
      return resolveRuntimeDir(join(dirname(createRequire(join(cwd, "noop.js")).resolve("@genclass/runtime/package.json")), "dist"));
    } catch {
      throw e;
    }
  }
}

function readCached(path: string): Buffer {
  let b = fileCache.get(path);
  if (!b) {
    b = readFileSync(path);
    fileCache.set(path, b);
  }
  return b;
}

/** The init script's source: the page function applied to its config and to the script-tag build wrapped in a function. */
export function initScriptContent(runtimeDir: string, cfg: PageScriptConfig): string {
  const global = readCached(join(runtimeDir, "genclass.global.js")).toString("utf8");
  return `(${genclassPageScript.toString()})(${JSON.stringify(cfg)}, function () {\n${global}\n});\n`;
}

/** A URL on the agent link's address (not merely one whose port starts with the same digits). */
export function isAgentUrl(url: string): boolean {
  return url === AGENT_URL || url.startsWith(`${AGENT_URL}/`);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** The file inside dist/ a request for RUNTIME_PATH names, or null when it is not a plain file path inside it. */
export function runtimeFile(runtimeDir: string, url: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  if (!pathname.startsWith(RUNTIME_PATH)) return null;
  const rel = pathname.slice(RUNTIME_PATH.length);
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(rel) || rel.split("/").some((s) => s === "." || s === "..")) return null;
  const abs = resolve(runtimeDir, ...rel.split("/"));
  if (!abs.startsWith(resolve(runtimeDir) + sep)) return null;
  return abs;
}

/**
 * Installs GenClass on the page and returns the session to finish at the end of the test. Throws only before touching
 * the page (a runtime that cannot be found); everything after that is best effort.
 */
export async function install(page: PageLike, o: InstallOptions): Promise<Session> {
  const runtimeDir = resolveRuntimeDir(o.runtimeDir);
  const collected: Collected = { records: [], witnesses: [], mode: null, model: null, agent: "not-loaded", plans: [], serviceWorker: false, modeOverridden: null };
  const scheduler = o.chaos ? new ChaosScheduler(o.chaos) : null;
  const binding = o.binding ?? BINDING;
  let released = false;
  // the test this install belongs to is still the one running (a `live` that throws counts as over: never misfile)
  const live = (): boolean => {
    if (released) return false;
    if (!o.live) return true;
    try {
      return o.live() !== false;
    } catch {
      return false;
    }
  };

  const take = (item: unknown): void => {
    if (!live()) return;
    if (!item || typeof item !== "object") return;
    const x = item as Record<string, unknown>;
    if (x.t === "record" && x.record) collected.records.push(x.record);
    else if (x.t === "witness" && x.witness) collected.witnesses.push(x.witness);
    else if (x.t === "status") {
      collected.mode = typeof x.mode === "string" ? x.mode : null;
      collected.model = x.model && typeof x.model === "object" ? (x.model as ModelInfo) : null;
      if (typeof x.overridden === "string") collected.modeOverridden = x.overridden;
    } else if (x.t === "agent") collected.agent = x.ok === true ? null : String(x.reason ?? "unknown");
    else if (x.t === "net") {
      // offline: nothing is held (page.ts, chaos.ts pause)
      if (x.online === false) scheduler?.pause();
      else scheduler?.resume();
    }
  };
  await page.exposeFunction(binding, take);

  // chaos first: the routes below are matched before it (Playwright tries the last registered handler first)
  if (scheduler) {
    const chaos = scheduler.chaos;
    await page.route("**/*", async (route, request) => {
      try {
        const url = request.url();
        if (isRuntimeUrl(url) || isAgentUrl(url)) return await route.fallback();
        // the test is over (a context kept for later tests): its chaos is not theirs
        if (!live()) return await route.fallback();
        let frameUrl = "";
        try {
          frameUrl = request.frame().url();
        } catch {
          /* a detached frame */
        }
        const origin = originOf(url);
        let accept = "";
        try {
          accept = request.headers()["accept"] ?? "";
        } catch {
          /* no headers */
        }
        const host = hostOf(url);
        const req = { url, method: request.method(), resourceType: request.resourceType(), sameOrigin: origin !== null && origin === originOf(frameUrl), sameHost: host !== null && host === hostOf(frameUrl), accept };
        // planned now, in the order the page sent its requests; the request itself is only held, never fetched here
        if (isCandidate(req, chaos.match)) {
          let body: string | null = null;
          try {
            body = request.postData?.() ?? null;
          } catch {
            /* a body that cannot be read as text: requests are then told apart by method and URL alone */
          }
          // an identical read, and a write to the same path, leave in the order the page sent them (chaos.ts)
          await scheduler.hold(scheduler.plan(req.method, req.url, req.sameOrigin), orderKey(req.method, req.url, body));
        }
        await route.fallback();
      } catch {
        /* the page closed while the request was held */
      }
    });
  }

  // the runtime's files, from disk
  await page.route(`**${RUNTIME_PATH}**`, async (route, request) => {
    try {
      const file = runtimeFile(runtimeDir, request.url());
      if (!file || !existsSync(file)) return await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
      await route.fulfill({ status: 200, headers: { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }, body: readCached(file) });
    } catch {
      /* the page closed */
    }
  });
  // the page's agent link sends nothing (page.ts gives it a stand-in fetch); should anything still ask, never let it
  // reach a bridge
  await page.route(`${AGENT_URL}/**`, (route) => route.abort("connectionrefused").catch(() => undefined));

  const cfg: PageScriptConfig = {
    base: RUNTIME_PATH,
    model: o.model === "load" ? (o.modelUrl ? { baseUrl: o.modelUrl } : {}) : false,
    agentUrl: AGENT_URL,
    binding,
  };
  await page.addInitScript({ content: initScriptContent(runtimeDir, cfg) });

  // every page there is, asked once; a page that does not answer in time, or is gone, answers nothing
  const askOpen = async (): Promise<{ id: string; open: [string, number][] }[]> => {
    const all = page.evaluateEach ? page.evaluateEach(OPEN_EXPRESSION) : page.evaluate(OPEN_EXPRESSION).then((r) => [r]);
    const answers = await Promise.race([all.catch(() => [] as unknown[]), sleep(ASK_MS).then(() => [] as unknown[])]);
    return answers.map(openOf).filter((a): a is { id: string; open: [string, number][] } => a !== null);
  };
  const waitForResponses = async (budgetMs?: number): Promise<void> => {
    const most = Math.max(0, Math.floor(o.waitForResponsesMs ?? 0));
    const limit = typeof budgetMs === "number" && Number.isFinite(budgetMs) ? Math.min(most, Math.floor(budgetMs)) : most;
    if (!(limit > 0)) return;
    const started = Date.now();
    // the requests to wait for: unanswered now, and sent no longer ago than the wait itself (older ones are streams
    // and long polls, which a test's end says nothing about), by page load
    const awaited = new Map<string, Set<string>>();
    for (const a of await askOpen()) {
      const keys = a.open.filter(([, age]) => age <= most).map(([key]) => key);
      if (keys.length) awaited.set(a.id, new Set(keys));
    }
    if (awaited.size === 0) return;
    while (Date.now() - started < limit) {
      await sleep(Math.min(WAIT_POLL_MS, limit - (Date.now() - started)));
      if (released || !live() || page.isClosed?.()) return;
      let left = 0;
      for (const a of await askOpen()) {
        const keys = awaited.get(a.id);
        if (keys) for (const [key] of a.open) if (keys.has(key)) left++;
      }
      if (left === 0) {
        // answered: its handler and the write it makes come a moment later
        await sleep(Math.min(WAIT_GRACE_MS, Math.max(0, limit - (Date.now() - started))));
        return;
      }
    }
  };

  return {
    async finish(budgetMs?: number): Promise<Collected> {
      try {
        if (!released && !page.isClosed?.()) await waitForResponses(budgetMs);
      } catch {
        /* the page is gone: nothing to wait for */
      }
      try {
        if (!released && !page.isClosed?.()) {
          const r = await Promise.race([
            page.evaluate(`(function () { var a = window.__GENCLASS_PLAYWRIGHT__; return a ? a.collect() : null; })()`),
            new Promise<null>((res) => setTimeout(() => res(null), 2000).unref?.()),
          ]);
          if (r && typeof r === "object") {
            const x = r as Record<string, unknown>;
            if (typeof x.mode === "string") collected.mode = x.mode;
            if (x.model && typeof x.model === "object") collected.model = x.model as ModelInfo;
            // a specific reason the page already pushed (an import error) beats collect()'s generic "not-loaded"
            if (x.agent === null) collected.agent = null;
            else if (typeof x.agent === "string" && (collected.agent === null || collected.agent === "not-loaded")) collected.agent = x.agent;
            if (x.serviceWorker === true) collected.serviceWorker = true;
          }
        }
      } catch {
        /* the page is gone: what it pushed so far is what there is */
      }
      scheduler?.dispose();
      collected.plans = scheduler ? scheduler.plans.slice() : [];
      return collected;
    },
    snapshot(): Collected {
      return { ...collected, records: collected.records.slice(), witnesses: collected.witnesses.slice(), plans: scheduler ? scheduler.plans.slice() : [] };
    },
    release(): void {
      released = true;
      scheduler?.dispose();
    },
  };
}
