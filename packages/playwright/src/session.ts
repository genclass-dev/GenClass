// One test under GenClass, without Playwright: the options, how a test is named and where its file goes, and the
// two halves every entry shares: start (install the runtime and the chaos on a page, install.ts) and finish (what was
// collected -> one "genclass-races/1" file, races.ts). Two entries use it and neither forks it:
//   - the fixture (fixture.ts), which starts it on Playwright's `page` and takes its options from `use.genclass`;
//   - the register entry (wrap.ts, worker.ts), which starts it on the browser contexts the tests of an unmodified
//     suite make, takes its options from the environment, and merges a test's contexts into the one file.
// Nothing here imports Playwright: the page and the TestInfo are taken by shape, so unit tests pass fakes and the
// register entry never loads a second copy of @playwright/test.
//
// The runtime only observes: it never holds, delays or changes anything the app does. Chaos, when given, holds matched
// requests before they leave (that is its job), never changes what they say. A finding never changes a test's outcome.

import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DEFAULT_SEED, MAX_WAIT_MS, describeMatch, resolveChaos, type ChaosOptions, type ResolvedChaos } from "./chaos.js";
import { emptyCollected, install, type Collected, type PageLike } from "./install.js";
import { buildRacesFile, racesFileName, writeRacesFile } from "./races.js";
import { sequenceOf } from "./steps.js";
import { RACES_STATUSES, STEPS_LIMITS, type GenClassRacesFile, type RacesLocation, type RacesStatus } from "./types.js";

export interface GenClassOptions {
  /** false: the fixture does nothing (no runtime on the page, no file). Default true. */
  enabled?: boolean;
  /** Only "observe": the runtime reports and never holds, delays or changes anything. Guard and heal are not for tests. */
  mode?: "observe";
  /**
   * "skip" (default): no model download (13 MB), so the file carries the runtime's witnesses (overwrote-newer,
   * identical-in-flight), facts computed without the model, and no model diagnoses or confidences. "load": the
   * runtime loads its model (from `modelUrl`, else the package default on jsDelivr) and the file also carries its
   * detections with their confidence.
   */
  model?: "skip" | "load";
  /** With `model: "load"`: a model directory URL (the runtime's `model.baseUrl`). */
  modelUrl?: string;
  /** Seeded network chaos (ChaosOptions; `true` for the defaults). Off unless given. */
  chaos?: ChaosOptions | true | false;
  /**
   * Where the files go, relative to the Playwright config's directory. Default: `genclass` in the project's
   * outputDir (test-results/genclass), which Playwright empties at the start of each run, so no file of an earlier
   * run is read as another seed. The reporter reads both places by default.
   */
  outDir?: string;
  /** @genclass/runtime's dist/ directory. Default: the installed package's. */
  runtimeDir?: string;
  /**
   * At the end of a test: how long, at most, to wait for the responses to requests the page had already sent, in ms,
   * so that a response which lands after the test's last assertion is still seen. Default: 1000 more than the chaos
   * delay's upper bound (1600 with the default chaos, 1000 without chaos), at most 5000. 0 turns the wait off. The
   * wait ends as soon as those requests are answered, never runs past what the test has left of its own timeout, and
   * adds nothing to a test that ends with no request in flight.
   */
  waitForResponsesMs?: number;
  /**
   * Without chaos: the number a run's file is named and labelled with (default 1; Playwright's repeat index is added),
   * so that runs started one after the other do not write over each other's files. With chaos, `chaos.seed` is it.
   */
  seed?: number;
  /**
   * How many steps of the page's order a race file carries at most: user actions, each request's send and the delivery
   * of its response, in order (the file's `steps`). They are what the comparison of a test's failing and passing runs
   * reads. Default 300 (and at most about 5 KB of the file); `false` or 0: none; at most 2000.
   */
  steps?: number | false;
}

/** How many steps a race file carries unless `steps` says otherwise, and how many bytes they may take then. */
export const DEFAULT_STEPS = 300;
export const DEFAULT_STEPS_BYTES = 5 * 1024;
/** With a `steps` above the default: the bytes they may take, per step asked for, and at most. */
export const STEPS_BYTES_EACH = 18;
export const MAX_STEPS_BYTES = 40 * 1024;

/** The largest end-of-test wait a default gives, and the largest that may be asked for, in ms. */
export const MAX_DEFAULT_WAIT_MS = 5000;
export { MAX_WAIT_MS };
/** What the default wait adds to the chaos delay's upper bound: time for the server to answer, in ms. */
export const WAIT_AFTER_CHAOS_MS = 1000;
/** What a test must have left of its timeout after the wait, in ms: its own fixtures still have to tear down. */
export const WAIT_TIMEOUT_MARGIN_MS = 2000;

/** The parts of Playwright's TestInfo the fixture reads. */
export interface TestInfoLike {
  titlePath: readonly string[];
  file: string;
  /** The line the test is declared on (Playwright's TestInfo.line). */
  line?: number;
  testId: string;
  repeatEachIndex: number;
  /** The attempt (0 for the first run); a retry writes a file of its own. */
  retry?: number;
  /** The test's status when the fixture finishes ("skipped": no file is written). */
  status?: string;
  /** The test's timeout in ms as it stands (Playwright's TestInfo.timeout; 0: none). */
  timeout?: number;
  /** Playwright's TestInfo.duration: 0 while the test's function runs, set the moment it returns or throws. */
  duration?: number;
  project: { name: string; testDir: string; outputDir?: string };
  config: { configFile?: string; rootDir: string };
}

/** The test's name in the file: "[project] file.spec.ts > describe > title" (the project only when it has a name). */
export function testName(info: TestInfoLike): string {
  const path = [...info.titlePath];
  // TestInfo.titlePath starts with the file ([file, ...describes, title]); a reporter's TestCase.titlePath() adds
  // ["", project] in front. Find the file to be safe about either shape
  const rel = relative(info.project.testDir, info.file).split(sep).join("/");
  let at = path.findIndex((t) => t === rel || t.split(sep).join("/") === rel);
  if (at < 0) at = path.findIndex((t) => t.endsWith(".ts") || t.endsWith(".js") || t.endsWith(".mjs") || t.endsWith(".tsx") || t.endsWith(".jsx"));
  const titles = at >= 0 ? path.slice(at) : path.filter(Boolean);
  if (at >= 0 && titles[0] !== rel && rel) titles[0] = rel;
  const name = titles.join(" > ") || info.testId;
  const project = info.project.name;
  return project ? `[${project}] ${name}` : name;
}

/**
 * The directory the file goes to: `outDir` against the config's directory (else the root dir); by default `genclass`
 * in the project's outputDir (else test-results/genclass next to the config).
 */
export function outDirOf(info: TestInfoLike, outDir?: string): string {
  const base = info.config.configFile ? dirname(info.config.configFile) : info.config.rootDir;
  if (!outDir) return info.project.outputDir ? join(info.project.outputDir, "genclass") : join(base, "test-results", "genclass");
  return isAbsolute(outDir) ? outDir : join(base, outDir);
}

/**
 * Where the test is declared, for the file's `location`: its path relative to the repository root and its line.
 * `root` is the repository's checkout (GITHUB_WORKSPACE on GitHub Actions); without it, the Playwright config's
 * directory, which is the repository root in the usual layout. Undefined when Playwright gave no line or the file is
 * outside that directory, so a file never names a path above the repository.
 */
export function locationOf(info: TestInfoLike, root: string | undefined = process.env.GITHUB_WORKSPACE): RacesLocation | undefined {
  const line = info.line;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return undefined;
  const base = root || (info.config.configFile ? dirname(info.config.configFile) : info.config.rootDir);
  if (!base || !info.file) return undefined;
  const rel = relative(base, info.file).split(sep).join("/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return undefined;
  return { file: rel, line };
}

export interface GenClassRun {
  /** What the page reported and the file written for it (null while the test runs or when disabled). */
  readonly collected: Collected | null;
  readonly file: GenClassRacesFile | null;
  readonly path: string | null;
}

/** What one test runs under, decided before a page is touched. */
export interface RunPlan {
  /** The chaos of this run (its seed already carries the repeat index), or null for none. */
  chaos: ResolvedChaos | null;
  /** The seed the file is named and labelled with: the chaos seed, or without chaos `seed` (default 1) plus the repeat index. */
  seed: number;
  model: "skip" | "load";
  /** The end-of-test wait for responses, in ms (0: none). */
  waitMs: number;
  /** The most steps the file carries (0: none), and the most bytes they take. */
  steps: number;
  stepsBytes: number;
}

/** The `steps` option as a number of steps: the default when unset, 0 for false, never more than the format holds. */
export function stepsOf(o: GenClassOptions): number {
  const v = o.steps;
  if (v === false) return 0;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return DEFAULT_STEPS;
  return Math.min(STEPS_LIMITS.steps, Math.floor(v));
}

/**
 * Tells when the test's own code finishes. Playwright sets `testInfo.duration` the moment the test's function returns
 * or throws, before its after-hooks, its screenshots and the teardown of its fixtures; nothing public says so any
 * other way, and a fixture or a closing context hears of the end only after all of those. So `duration`, while it is
 * the plain property Playwright made, is watched for its next assignment: the time is noted, the property is put back
 * as it was, and the value is what Playwright set. Where `duration` is anything else (not there, not a plain writable
 * number), nothing is touched. Returns a function that gives the time (Date.now()), or undefined while it is not
 * known. Never throws.
 */
export function watchEnd(info: TestInfoLike): () => number | undefined {
  let endedAt: number | undefined;
  try {
    const d = Object.getOwnPropertyDescriptor(info, "duration");
    if (d && d.configurable && d.writable && typeof d.value === "number" && !d.get && !d.set) {
      let value: unknown = d.value;
      Object.defineProperty(info, "duration", {
        configurable: true,
        enumerable: d.enumerable,
        get: () => value,
        set: (v: unknown) => {
          value = v;
          endedAt ??= Date.now();
          try {
            Object.defineProperty(info, "duration", { configurable: true, enumerable: d.enumerable, writable: true, value: v });
          } catch {
            /* it stays watched: reads and writes still go through */
          }
        },
      });
    }
  } catch {
    /* not ours to watch */
  }
  return () => endedAt;
}

/** The test's status for the file: Playwright's, when it is one a file carries (a skipped test writes none). */
export function statusOf(info: TestInfoLike): RacesStatus | undefined {
  return (RACES_STATUSES as readonly string[]).includes(info.status ?? "") ? (info.status as RacesStatus) : undefined;
}

/**
 * The end-of-test wait of one run: the option when it is a number from 0 (at most MAX_WAIT_MS), else 1000 ms more than
 * the chaos delay's upper bound, at most MAX_DEFAULT_WAIT_MS.
 */
export function waitOf(o: GenClassOptions, chaos: ResolvedChaos | null): number {
  const given = o.waitForResponsesMs;
  if (typeof given === "number" && Number.isFinite(given) && given >= 0) return Math.min(MAX_WAIT_MS, Math.floor(given));
  return Math.min(MAX_DEFAULT_WAIT_MS, (chaos ? chaos.delayMs[1] : 0) + WAIT_AFTER_CHAOS_MS);
}

/**
 * How long the end-of-test wait may take for this test now, in ms: what is left of the test's timeout after
 * WAIT_TIMEOUT_MARGIN_MS, counted from `startedAt` (when GenClass was put on the test's page or context). Undefined
 * (no limit beyond the wait's own) for a test without a timeout; 0 for a test that already timed out or was
 * interrupted, whose teardown must not be made longer.
 */
export function waitBudget(info: TestInfoLike, startedAt: number, now: number = Date.now()): number | undefined {
  if (info.status === "timedOut" || info.status === "interrupted") return 0;
  const timeout = info.timeout;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return undefined;
  return Math.max(0, Math.floor(timeout - (now - startedAt) - WAIT_TIMEOUT_MARGIN_MS));
}

/** Checks the options and decides the chaos, seed and model of one test. Throws on a mode or model it does not know. */
export function planRun(o: GenClassOptions, info: TestInfoLike): RunPlan {
  if (o.mode !== undefined && o.mode !== "observe") throw new Error(`@genclass/playwright: genclass.mode must be "observe" (got ${JSON.stringify(o.mode)}): guard and heal are not for tests`);
  if (o.model !== undefined && o.model !== "skip" && o.model !== "load") throw new Error(`@genclass/playwright: genclass.model must be "skip" or "load" (got ${JSON.stringify(o.model)})`);
  const chaos = o.chaos ? resolveChaos(o.chaos, info.repeatEachIndex) : null;
  const base = typeof o.seed === "number" && Number.isSafeInteger(o.seed) && o.seed >= 0 ? o.seed : DEFAULT_SEED;
  const seed = chaos ? chaos.seed : base + Math.max(0, Math.floor(info.repeatEachIndex) || 0);
  const steps = stepsOf(o);
  return { chaos, seed, model: o.model ?? "skip", waitMs: waitOf(o, chaos), steps, stepsBytes: steps <= DEFAULT_STEPS ? DEFAULT_STEPS_BYTES : Math.min(MAX_STEPS_BYTES, steps * STEPS_BYTES_EACH) };
}

/** The "genclass-races/1" file of one test: what was collected, under the plan it ran with. */
export function racesFileOf(info: TestInfoLike, plan: RunPlan, collected: Collected): GenClassRacesFile {
  const { chaos, seed, model } = plan;
  return buildRacesFile({
    test: testName(info),
    seed,
    mode: collected.mode,
    model: collected.model,
    chaos: chaos ? { latencyMs: chaos.delayMs, reorder: chaos.reorder, routes: describeMatch(chaos.match) } : null,
    records: collected.records,
    witnesses: collected.witnesses,
    fixture: {
      model,
      agent: collected.agent,
      chaosApplied: chaos ? collected.plans.length : null,
      serviceWorker: collected.serviceWorker,
      ...(collected.modeOverridden ? { modeOverridden: collected.modeOverridden } : {}),
    },
    location: locationOf(info),
    status: statusOf(info),
    steps: plan.steps > 0 ? { sequence: sequenceOf(collected.streams ?? [], collected.endedAt), max: plan.steps, bytes: plan.stepsBytes, more: collected.stepsOver ?? 0 } : undefined,
  });
}

/**
 * Writes the file of one test (one per test, seed and retry) and returns it with its path. A test skipped in its body
 * was not run: nothing is written, so the report does not count it as unchecked.
 */
export function writeRun(info: TestInfoLike, outDir: string | undefined, plan: RunPlan, collected: Collected): { file: GenClassRacesFile | null; path: string | null } {
  if (info.status === "skipped") return { file: null, path: null };
  const file = racesFileOf(info, plan, collected);
  const path = writeRacesFile(outDirOf(info, outDir), racesFileName(file.test, info.testId, plan.seed, info.retry ?? 0), file);
  return { file, path };
}

/**
 * What several pages or contexts of one test collected, as one: detections, witnesses and chaos plans in the order
 * given; the mode, model and mode switch of the first that reported one. The agent state is null (connected) only
 * when every part whose runtime started connected: one that did not gives its reason, so a test that was checked in
 * part is not reported as checked. A part whose runtime never started (a context that opened no http page) does not
 * count, unless none started.
 */
export function mergeCollected(parts: readonly Collected[]): Collected {
  const out: Collected = emptyCollected();
  for (const c of parts) {
    out.records.push(...c.records);
    out.witnesses.push(...c.witnesses);
    out.plans.push(...c.plans);
    out.streams.push(...(c.streams ?? []));
    out.stepsOver += c.stepsOver ?? 0;
    // one test, one end: the earliest any part was told
    if (c.endedAt !== undefined && (out.endedAt === undefined || c.endedAt < out.endedAt)) out.endedAt = c.endedAt;
    if (out.mode === null) out.mode = c.mode;
    if (out.model === null) out.model = c.model;
    if (c.serviceWorker) out.serviceWorker = true;
    if (out.modeOverridden === null) out.modeOverridden = c.modeOverridden;
  }
  const started = parts.filter((c) => c.mode !== null);
  out.agent = mergeAgent((started.length ? started : parts).map((c) => c.agent));
  return out;
}

/**
 * One agent state for several: null when every one connected; else the first specific reason, else "not-loaded"
 * (also for none at all: nothing started is nothing recorded).
 */
export function mergeAgent(states: readonly (string | null)[]): string | null {
  const failed = states.filter((s): s is string => s !== null);
  if (states.length > 0 && failed.length === 0) return null;
  return failed.find((s) => s !== "not-loaded") ?? "not-loaded";
}

/** The key under which the register entry (worker.ts) keeps its state on globalThis: one per process. */
export const REGISTER_KEY = Symbol.for("@genclass/playwright/register");

/** The page's browser context is one the register entry already instruments in this process. */
function coveredByRegister(page: PageLike): boolean {
  try {
    const state = (globalThis as unknown as Record<symbol, { contexts?: WeakSet<object>; fixturePages?: number } | undefined>)[REGISTER_KEY];
    if (!state?.contexts) return false;
    const context = (page as unknown as { context?: () => unknown }).context?.();
    if (!context || typeof context !== "object" || !state.contexts.has(context)) return false;
    state.fixturePages = (state.fixturePages ?? 0) + 1;
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts GenClass on a page for one test: installs the runtime (and chaos), and returns what to call when the test
 * ends. Inert when `enabled` is false, and on a page whose browser context the register entry
 * (`@genclass/playwright/register`) already covers: that context has the runtime and its file is written there, with
 * the options the environment gave.
 */
export async function startGenClass(page: PageLike, options: GenClassOptions | undefined, info: TestInfoLike): Promise<{ finish(): Promise<GenClassRun> }> {
  const o = options ?? {};
  const empty: GenClassRun = { collected: null, file: null, path: null };
  if (o.enabled === false) return { finish: async () => empty };
  const plan = planRun(o, info);
  if (coveredByRegister(page)) return { finish: async () => empty };
  const startedAt = Date.now();
  const ended = watchEnd(info);
  const session = await install(page, { runtimeDir: o.runtimeDir, model: plan.model, modelUrl: o.modelUrl, chaos: plan.chaos, waitForResponsesMs: plan.waitMs });
  return {
    async finish(): Promise<GenClassRun> {
      const collected = await session.finish(waitBudget(info, startedAt), ended());
      return { collected, ...writeRun(info, o.outDir, plan, collected) };
    },
  };
}
