// `genclass-playwright-run`: an existing Playwright suite under GenClass with no change to its tests or its config.
//
//   npx genclass-playwright-run [arguments of "playwright test" ...]
//
// It finds the project's own Playwright (never another copy) and the user's config the way Playwright finds it,
// writes a config next to it that imports the register entry and then that config (wrapper.ts), runs
// `playwright test --config <generated>` with every other argument passed through, removes the generated file (also
// when the run fails or is interrupted) and prints where the race files are and what they hold. Defaults for a first
// run: chaos on (GENCLASS_CHAOS), `--repeat-each 2` unless one is given (two seeds, so a finding can be marked
// reproducible), race files in test-results/genclass under the working directory whatever the config's outputDir
// (GENCLASS_OUT_DIR), emptied of an earlier run's race files first. Everything else is an environment variable
// (env.ts); GENCLASS_PLAYWRIGHT=off runs Playwright as it is.
//
// The exit code is Playwright's (128 plus the signal number when a signal ended it). 2 when Playwright could not be
// started at all: it is not installed, @genclass/runtime is not there, or the config could not be written. What the
// command prints goes to stderr, so Playwright's own stdout (a JSON reporter, say) stays as it is.
//
// One mode of its own, for a test that fails in some runs and passes in others:
//
//   npx genclass-playwright-run --explain-flaky[=N] [arguments of "playwright test" that select the test ...]
//
// It runs Playwright N times (default 30), each time once and without retries (`--repeat-each 1 --retries=0`) under
// the next seed, so no two runs share a process, a server or a saved login and no failing seed is counted twice,
// keeps every run's race files, and then compares the order of steps in each
// test's failing runs with the order in its passing runs (order.ts). Playwright empties its output directory when a
// run starts, and the race files are in it by default: so after each run they are set aside in a directory of the
// command's own (under the system's temporary directory), and put back together when the last run is over, or when
// the command is ended early; a file that cannot be put back stays there and is read from there, never deleted. A
// signal that arrives between two runs stops the runs and still puts the files back. A failing test is what this mode is for, so its
// exit code is 0 when the runs were made, whatever the tests did; 2 when nothing could be run, and 128 plus the signal
// number when a signal ended it. While it runs, Playwright's HTML reporter is told not to open (PLAYWRIGHT_HTML_OPEN,
// unless set): it would wait for a key after the first failing run.
//
// The command's parts are pure and tested as exact text and exact argv (parseRunArgs, planCommand, runSummary);
// runCommand takes its process (RunIo), so a test runs it without starting anything.

import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_OUT_DIR, ENV, flagOf, isOff, type Env } from "./env.js";
import { displayPath, readRacesDirs } from "./files.js";
import { findRuntimeDir } from "./install.js";
import { EXPLAIN_FLAG, EXPLAIN_RUNS, orderLines, ordersToReport, testOrders } from "./explain.js";
import { buildSummary } from "./summarize.js";
import { RACES_SCHEMA, type RacesFileInput } from "./types.js";
import { isModuleFile, resolveConfig, wrapperConfigName, wrapperConfigSource, type ConfigLocation } from "./wrapper.js";

export const RUN_USAGE = `usage: genclass-playwright-run [arguments of "playwright test" ...]

Runs your Playwright suite with GenClass on the pages your tests open, with no change to your tests or
your playwright.config, and writes one race file per test and seed.

  - every argument goes to "playwright test" as it is (--project, --grep, a file name, ...);
  - --config / -c names your config, as usual: a config that imports GenClass's register entry and then
    yours is written next to it for the run and removed afterwards;
  - --repeat-each 2 is added unless you pass one: two seeds, so a finding can be marked reproducible.

For a test that fails in some runs and passes in others:
  genclass-playwright-run --explain-flaky[=N] [arguments that select the test ...]
    runs it N times (default 30), each run a Playwright run of its own under the next seed and without
    retries, then says which order of user actions, requests and responses sets its failing runs apart
    from its passing ones, with the counts and with what shuffled outcomes give. With
    GENCLASS_CHAOS=off the runs differ only by their own timing. Its exit code is 0 when the runs were
    made.

Options are environment variables:
  GENCLASS_CHAOS=off             no seeded network chaos (on by default here: matched API requests are held
                                 for a seeded time, so a suite that passes normally can fail under it)
  GENCLASS_SEED=<n>              the chaos seed (default 1; Playwright's repeat index is added)
  GENCLASS_CHAOS_DELAY_MS=a,b    extra latency per matched request, in ms (default 0,600)
  GENCLASS_CHAOS_REORDER=off     latency only: matched requests leave in the order they were sent
  GENCLASS_CHAOS_MATCH=/api,...  path or URL prefixes to hold (default: same host /api* or Accept: json)
  GENCLASS_OUT_DIR=<dir>         where the race files go (default test-results/genclass)
  GENCLASS_STEPS=<n>             steps of the page's order kept per race file (default 300; 0: none)
  GENCLASS_MODEL=load            load the runtime's model in the page (default skip: no download)
  GENCLASS_RUNTIME_DIR=<dir>     @genclass/runtime's dist/, when it is not installed next to this package
  GENCLASS_PLAYWRIGHT=off        run Playwright as it is

The exit code is Playwright's.
`;

/** How many seeds a first run gets (`--repeat-each`), unless the user passes one. */
export const DEFAULT_REPEAT_EACH = 2;
/** --explain-flaky: the fewest and the most runs it makes, and the steps a race file keeps then unless GENCLASS_STEPS says. */
export const MIN_EXPLAIN_RUNS = 2;
export const MAX_EXPLAIN_RUNS = 400;
export const EXPLAIN_STEPS = 1000;
/** At most this many signature lines in the command's summary; the report has them all. */
export const MAX_SUMMARY_SIGNATURES = 10;

export interface RunArgs {
  /** --help or -h: print the usage and run nothing. */
  help: boolean;
  /** The value of the user's --config / -c (the last one), or undefined. */
  config: string | undefined;
  /** The user passed --repeat-each. */
  repeatEach: boolean;
  /** --explain-flaky: how many runs to make (null: not asked for). */
  explain: number | null;
  /** What is wrong with the arguments, when something is (the command then runs nothing). */
  error?: string;
  /** Every argument except --config, --explain-flaky and their values, in the order given. */
  rest: string[];
}

/**
 * Reads the command's arguments. It knows three of Playwright's (--config / -c in all their spellings, --repeat-each,
 * --help / -h) and one of its own (--explain-flaky, --explain-flaky=N, or --explain-flaky N when N is a number), and
 * passes everything else through; after a bare `--` nothing is read at all.
 */
export function parseRunArgs(argv: readonly string[]): RunArgs {
  const out: RunArgs = { help: false, config: undefined, repeatEach: false, explain: null, rest: [] };
  const runs = (text: string): void => {
    const n = /^\d+$/.test(text) ? Number(text) : NaN;
    if (n >= MIN_EXPLAIN_RUNS && n <= MAX_EXPLAIN_RUNS) out.explain = n;
    else out.error = `${EXPLAIN_FLAG} takes a number of runs from ${MIN_EXPLAIN_RUNS} to ${MAX_EXPLAIN_RUNS}, got ${JSON.stringify(text)}`;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.rest.push(...argv.slice(i));
      break;
    }
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === EXPLAIN_FLAG) {
      out.explain = EXPLAIN_RUNS;
      if (i + 1 < argv.length && /^\d+$/.test(argv[i + 1])) runs(argv[++i]);
    } else if (a.startsWith(`${EXPLAIN_FLAG}=`)) runs(a.slice(EXPLAIN_FLAG.length + 1));
    else if ((a === "--config" || a === "-c") && i + 1 < argv.length) out.config = argv[++i];
    else if (a.startsWith("--config=")) out.config = a.slice("--config=".length);
    else if (/^-c./.test(a)) out.config = a.slice(2);
    else {
      if (a === "--repeat-each" || a.startsWith("--repeat-each=")) out.repeatEach = true;
      out.rest.push(a);
    }
  }
  if (out.explain !== null && out.repeatEach && !out.error) out.error = `${EXPLAIN_FLAG} gives each seed a run of its own: leave out --repeat-each`;
  return out;
}

/**
 * The project's own Playwright command (`@playwright/test`'s cli, else the `playwright` package's), resolved from the
 * first of `dirs` that has one. Null when none has: Playwright is never taken from anywhere else.
 */
export function findPlaywrightCli(dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const require = createRequire(join(dir, "noop.js"));
    try {
      return require.resolve("@playwright/test/cli");
    } catch {
      /* the playwright package alone has the test runner too */
    }
    try {
      const pkg = require.resolve("playwright/package.json");
      const bin = (JSON.parse(readFileSync(pkg, "utf8")) as { bin?: unknown }).bin;
      const rel = typeof bin === "string" ? bin : bin && typeof bin === "object" ? (bin as Record<string, unknown>).playwright : undefined;
      if (typeof rel === "string") return join(dirname(pkg), rel);
    } catch {
      /* not from this directory */
    }
  }
  return null;
}

export interface CommandInput {
  args: RunArgs;
  cwd: string;
  env: Env;
  /** The project's Playwright command (findPlaywrightCli). */
  cli: string;
  /** Where the user's config is (resolveConfig). */
  location: ConfigLocation;
  /** isModuleFile(location.file). */
  module: boolean;
  /** dist/register.js of this package. */
  registerPath: string;
  /** @genclass/runtime's dist/ (findRuntimeDir). */
  runtimeDir: string;
  /** Tells this run's generated config from another run's (the process id). */
  id: number | string;
  /** The file the workers append their remembered lines to. */
  notesFile: string;
}

export interface CommandPlan {
  /** What node is started with: the project's Playwright command, "test", and its arguments. */
  argv: string[];
  /** The environment variables added to the run's. */
  env: Record<string, string>;
  /** The generated config: where it goes and what it says. */
  wrapper: { path: string; source: string };
  /** Where the race files go (absolute). */
  outDir: string;
}

/** What the command runs, without running it. */
export function planCommand(i: CommandInput): CommandPlan {
  const wrapperPath = join(i.location.dir, wrapperConfigName(i.location.file, i.id));
  const given = i.env[ENV.outDir]?.trim();
  const outDir = given ? (isAbsolute(given) ? given : resolve(i.cwd, given)) : resolve(i.cwd, DEFAULT_OUT_DIR);
  const env: Record<string, string> = { [ENV.outDir]: outDir, [ENV.runtimeDir]: i.runtimeDir, [ENV.notesFile]: i.notesFile };
  if (flagOf(i.env[ENV.chaos]) === undefined) env[ENV.chaos] = "on";
  const explain = i.args.explain !== null;
  if (explain) {
    // a failing run is expected here: the HTML reporter must not wait for a key after one; and a long test's steps
    if (!i.env.PLAYWRIGHT_HTML_OPEN?.trim()) env.PLAYWRIGHT_HTML_OPEN = "never";
    if (!i.env[ENV.steps]?.trim()) env[ENV.steps] = String(EXPLAIN_STEPS);
  }
  return {
    // --explain-flaky: each seed once, and no retries (an attempt made after a failure, under the same seed, is not a
    // run of its own; a --retries of the user's comes later on the line and stands, and its retried attempts are then
    // left out of the comparison)
    argv: [i.cli, "test", "--config", wrapperPath, ...(explain ? ["--repeat-each", "1", "--retries=0"] : i.args.repeatEach ? [] : ["--repeat-each", String(DEFAULT_REPEAT_EACH)]), ...i.args.rest],
    env,
    wrapper: { path: wrapperPath, source: wrapperConfigSource({ registerUrl: pathToFileURL(i.registerPath).href, config: i.location.file, module: i.module }) },
    outDir,
  };
}

/** The race files directly inside a directory: its `*.json` files whose `schema` is "genclass-races/1", by name. */
function raceFilesIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (!name.toLowerCase().endsWith(".json")) return false;
    try {
      const path = join(dir, name);
      if (!statSync(path).isFile()) return false;
      const value = JSON.parse(readFileSync(path, "utf8")) as { schema?: unknown } | null;
      return !!value && typeof value === "object" && value.schema === RACES_SCHEMA;
    } catch {
      return false; // not a race file, or not ours to touch
    }
  });
}

/**
 * Removes the race files of an earlier run from the directory: the `*.json` files directly inside it whose `schema` is
 * "genclass-races/1", and nothing else, so a file of an earlier run is never read as another seed. Returns how many.
 */
export function removeRaceFiles(dir: string): number {
  let removed = 0;
  for (const name of raceFilesIn(dir)) {
    try {
      rmSync(join(dir, name));
      removed++;
    } catch {
      /* not ours to remove */
    }
  }
  return removed;
}

/**
 * Moves the race files of one directory into another (made when it is not there), and nothing else. A file of the
 * same name is replaced. Returns how many were moved; one that could not be moved stays where it was.
 */
export function moveRaceFiles(from: string, to: string): number {
  const names = raceFilesIn(from);
  if (names.length === 0) return 0;
  let moved = 0;
  try {
    mkdirSync(to, { recursive: true });
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      copyFileSync(join(from, name), join(to, name));
      rmSync(join(from, name));
      moved++;
    } catch {
      /* it stays where it was */
    }
  }
  return moved;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export interface RunSummaryInput {
  /** The race files of the run (readRacesDirs). */
  inputs: readonly RacesFileInput[];
  /** Where they are, for display. */
  dir: string;
  /** The lines the workers remembered, one per worker that had it. */
  notes: readonly string[];
  /** The command that renders the full report from these files. */
  report: string;
}

/** What the command prints when the run ends: where the race files are, what they hold, and what went wrong. */
export function runSummary(i: RunSummaryInput): string {
  const s = buildSummary(i.inputs);
  const lines: string[] = [];
  if (s.files === 0 && s.skipped.length === 0) {
    lines.push(`GenClass: no race file in ${i.dir}. One is written for each test that opens a browser context while GenClass is on.`);
  } else {
    const t = s.totals;
    lines.push(`GenClass: ${count(s.files, "race file")} in ${i.dir} (${count(t.tests, "test")}): ${count(t.signatures, "signature")} in ${count(t.testsWithSignatures, "test")}, ${t.reproducible} reproducible (flagged in ${s.minSeeds} or more seeds of the same test).`);
    let shown = 0;
    for (const test of s.tests) {
      if (test.signatures.length === 0 || shown >= MAX_SUMMARY_SIGNATURES) continue;
      lines.push(`  ${test.test}`);
      for (const sig of test.signatures) {
        if (shown >= MAX_SUMMARY_SIGNATURES) break;
        lines.push(`    ${sig.trigger}:${sig.diagnosis} · ${sig.op} · ${sig.seeds.length} of ${count(test.seeds.length, "seed")} (${sig.seeds.join(", ")})${sig.reproducible ? " · reproducible" : ""}`);
        shown++;
      }
    }
    if (t.signatures > shown) lines.push(`  and ${count(t.signatures - shown, "more signature")}`);
    // chaos that held nothing tried no other order: say so here, where a first run is read, not only in the report
    const idle = s.tests.reduce((n, test) => n + test.chaosIdle, 0);
    if (idle > 0)
      lines.push(
        `  Chaos held no request in ${idle} of ${count(s.files, "race file")}: nothing matched its filter (unless one is set: the page's own host, with a path under /api or an Accept header asking for JSON), or a route of the test or a service worker answered first. For an API elsewhere: ${ENV.match}=/graphql,https://api.example.com/`,
      );
    if (s.skipped.length) lines.push(`  ${count(s.skipped.length, "file")} in that directory could not be read as a race file`);
    // a test that failed in some runs: its failing runs against its passing ones, or the command that makes enough of them
    const compared = ordersToReport(testOrders(i.inputs));
    if (compared.length) {
      lines.push(`  Failed in some runs (${ORDER_CAVEAT}):`);
      for (const t of compared) lines.push(...indented(orderLines(t, false)));
    }
    lines.push(`  The report: ${i.report}`);
  }
  lines.push(...noteLines(i.notes));
  return `${lines.join("\n")}\n`;
}

/** What the comparison of failing and passing runs is, wherever the command prints one. */
export const ORDER_CAVEAT = "the order of steps, failing against passing: a measured comparison, not a diagnosis";

/** A test's lines under a heading: its first line at four spaces, the rest at six, no empty lines. */
function indented(lines: readonly string[]): string[] {
  return lines.filter((l) => l.trim() !== "").map((l, i) => `${i === 0 ? "    " : "      "}${l.trimStart()}`);
}

function noteLines(given: readonly string[]): string[] {
  const notes = new Map<string, number>();
  for (const n of given) if (n.trim()) notes.set(n.trim(), (notes.get(n.trim()) ?? 0) + 1);
  if (!notes.size) return [];
  return ["GenClass notes:", ...[...notes].map(([line, n]) => `  - ${line}${n > 1 ? ` (${n} workers)` : ""}`)];
}

export interface ExplainSummaryInput extends RunSummaryInput {
  /** How many runs were asked for, and how many were made. */
  wanted: number;
  made: number;
  /** The seed of the first run (each run takes the next). */
  firstSeed: number;
}

/**
 * What --explain-flaky prints when its runs are over: for every test in the race files, its failing runs against its
 * passing ones (order.ts), or why there is nothing to compare.
 */
export function explainSummary(i: ExplainSummaryInput): string {
  const s = buildSummary(i.inputs);
  const seeds = i.made > 1 ? `seeds ${i.firstSeed} to ${i.firstSeed + i.made - 1}` : `seed ${i.firstSeed}`;
  const lines = [`GenClass: ${i.made === i.wanted ? count(i.made, "run") : `${i.made} of ${count(i.wanted, "run")}`}, each a Playwright run of its own (${seeds}): ${count(s.files, "race file")} in ${i.dir} (${count(s.totals.tests, "test")}).`];
  if (s.files === 0) lines.push("  No race file was written, so there is nothing to compare. One is written for each test that opens a browser context while GenClass is on.");
  else lines.push(`  ${ORDER_CAVEAT[0].toUpperCase()}${ORDER_CAVEAT.slice(1)}. An order that sets the failing runs apart may be the cause, a consequence of the cause, or neither.`);
  for (const t of testOrders(i.inputs)) {
    const { failed, passed } = t;
    const runs = failed + passed;
    const x = t.explanation;
    if (failed > 0 && x.verdict !== "too-few-runs") lines.push(...indented(orderLines(t, false)));
    else if (runs === 0) lines.push(`    ${t.test} · its race files do not say whether it passed (written by an older @genclass/playwright): nothing to compare.`);
    else if (failed === 0) lines.push(`    ${t.test} · passed in all ${count(runs, "run")}: nothing to compare.`);
    else if (passed === 0) lines.push(`    ${t.test} · failed in all ${count(runs, "run")}: there is no passing run to compare with.${t.underDelays ? ` ${ENV.chaos}=off makes the runs without the delays.` : ""}`);
    else {
      const steps = t.withoutSteps > 0 ? ` (${count(t.withoutSteps, "run")} had no recorded steps)` : "";
      // enough runs for three of the rarer outcome, with room: three times what it took to see one
      const rarer = Math.max(1, Math.min(failed, passed));
      const more = Math.min(MAX_EXPLAIN_RUNS, Math.max(i.wanted + 10, Math.ceil((3 * 3 * runs) / rarer / 10) * 10));
      lines.push(`    ${t.test} · failed in ${failed} of ${count(runs, "run")}${steps}: too few of one kind to compare (it takes ${x.minimum.failing} failing and ${x.minimum.passing} passing). More runs: ${EXPLAIN_FLAG}=${more}`);
    }
  }
  if (s.skipped.length) lines.push(`  ${count(s.skipped.length, "file")} in that directory could not be read as a race file`);
  lines.push(...noteLines(i.notes));
  return `${lines.join("\n")}\n`;
}

/** How a started process ended. */
export interface SpawnResult {
  code: number | null;
  signal: string | null;
}

/** The command's process. */
export interface RunIo {
  cwd: string;
  env: Env;
  out(s: string): void;
  err(s: string): void;
  /** dist/register.js of this package. */
  registerPath: string;
  /** Tells this run from another (the process id). */
  id: number | string;
  /** Where the workers' notes file goes. */
  tmpdir: string;
  /** The project's own Playwright command, looked for from these directories in order (findPlaywrightCli). */
  findCli(dirs: readonly string[]): string | null;
  /** Runs `fn` when this process exits, whatever ends it. */
  onExit(fn: () => void): void;
  /** Starts node with these arguments and this environment, and waits for it to end. */
  spawn(argv: string[], env: Record<string, string | undefined>): Promise<SpawnResult>;
  /**
   * Keeps a signal sent to this process (Ctrl+C, a kill) from ending it on the spot until `release` is called:
   * `signal()` says which one arrived, if any. A child that is running still gets it (spawn passes it on); this is for
   * the moments no child runs, between two of --explain-flaky's runs and while the generated config is being removed.
   */
  hold?(): { signal(): NodeJS.Signals | null; release(): void };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function quoted(s: string): string {
  return /\s/.test(s) ? JSON.stringify(s) : s;
}

function exitCodeOf(r: SpawnResult): number {
  if (typeof r.code === "number") return r.code;
  const n = r.signal ? (constants.signals as Record<string, number | undefined>)[r.signal] : undefined;
  return n ? 128 + n : 1;
}

/**
 * PATH as `npx playwright test` gives it to the project: the `node_modules/.bin` of each directory given and of each of
 * its parents, nearest first, in front of what was there. The workflow file starts this command with `node <path>`,
 * which adds none of them, so a `webServer.command` that names a local bin (`vite`, `next`, `pglite-server`) was not
 * found: exit 127 and no test ran (seen on a public Next.js starter). Returns the one variable to set, under the name
 * the environment already has for it ("Path" on Windows).
 */
export function localBinsPath(env: Env, cwd: string, dirs: readonly string[]): Record<string, string> {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const have = (env[key] ?? "").split(delimiter).filter((p) => p !== "");
  const bins: string[] = [];
  for (const d of dirs) {
    let cur = isAbsolute(d) ? d : resolve(cwd, d);
    for (let i = 0; i < 64; i++) {
      const bin = join(cur, "node_modules", ".bin");
      if (!bins.includes(bin) && !have.includes(bin)) bins.push(bin);
      const up = dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  return { [key]: [...bins, ...have].join(delimiter) };
}

/** Runs the command with `argv` (without node and the script). Returns the exit code. Never throws. */
export async function runCommand(argv: readonly string[], io: RunIo): Promise<number> {
  try {
    const args = parseRunArgs(argv);
    if (args.help) {
      io.out(RUN_USAGE);
      return 0;
    }
    if (args.error) {
      io.err(`genclass-playwright-run: ${args.error}.\nNothing was run.\n`);
      return 2;
    }
    const off = isOff(io.env);
    const location = resolveConfig(io.cwd, args.config);
    const cli = io.findCli(location ? [location.dir, io.cwd] : [io.cwd]);
    if (!cli) {
      io.err(`genclass-playwright-run: Playwright Test was not found from ${location?.dir ?? io.cwd}. Run this where "npx playwright test" works, after the project's dependencies are installed.\n`);
      return 2;
    }
    if ((off || !location) && args.explain !== null) {
      // the mode is GenClass's own: Playwright does not know the option, so its arguments are not passed on as they are
      io.err(`genclass-playwright-run: ${off ? `${EXPLAIN_FLAG} compares what GenClass records, and GenClass is off (${ENV.off}=${io.env[ENV.off]})` : `the config ${args.config} was not found`}.\nNothing was run.\n`);
      return 2;
    }
    if (off || !location) {
      // nothing of GenClass: the off switch, or a --config path that does not exist (Playwright says that best itself)
      if (off) io.err(`GenClass is off (${ENV.off}=${io.env[ENV.off]}): running Playwright as it is.\n`);
      return exitCodeOf(await io.spawn([cli, "test", ...argv], { ...io.env, ...localBinsPath(io.env, io.cwd, location ? [location.dir, io.cwd] : [io.cwd]) }));
    }
    let runtimeDir: string;
    try {
      const given = io.env[ENV.runtimeDir]?.trim();
      runtimeDir = findRuntimeDir(given ? resolve(io.cwd, given) : undefined, io.cwd);
    } catch (e) {
      io.err(`genclass-playwright-run: ${message(e)}\nNothing was run. Install @genclass/runtime@beta next to @genclass/playwright, or set ${ENV.runtimeDir} to its dist/ directory.\n`);
      return 2;
    }
    const notesFile = join(io.tmpdir, `genclass-playwright-${io.id}.notes`);
    const plan = planCommand({ args, cwd: io.cwd, env: io.env, cli, location, module: location.file ? isModuleFile(location.file) : true, registerPath: io.registerPath, runtimeDir, id: io.id, notesFile });
    // --explain-flaky: where each run's race files wait while the next run starts (Playwright empties its output
    // directory then). They are put back before anything is read, and whatever ends the command.
    const kept = args.explain !== null ? join(io.tmpdir, `genclass-playwright-${io.id}.runs`) : null;
    /** Race files that could not be put back: they stay where they waited, and are read from there. */
    let stranded = 0;
    const remove = (): void => {
      if (kept) {
        try {
          moveRaceFiles(kept, plan.outDir);
          stranded = raceFilesIn(kept).length;
          // only an empty waiting place is removed: a run's files are never deleted for not fitting back
          if (stranded === 0) rmSync(kept, { recursive: true, force: true });
        } catch {
          /* what could not be put back stays in the temporary directory */
        }
      }
      for (const path of [plan.wrapper.path, notesFile]) {
        try {
          rmSync(path, { force: true });
        } catch {
          /* gone already */
        }
      }
    };
    removeRaceFiles(plan.outDir);
    try {
      // nothing an earlier command with this id left behind is this run's
      if (kept) rmSync(kept, { recursive: true, force: true });
      rmSync(notesFile, { force: true });
      writeFileSync(plan.wrapper.path, plan.wrapper.source);
    } catch (e) {
      io.err(
        `genclass-playwright-run: could not write ${plan.wrapper.path} (${message(e)}).\nNothing was run. Without a generated config, the register entry can be preloaded instead:\n  NODE_OPTIONS=${JSON.stringify(`--import ${pathToFileURL(io.registerPath).href}`)} npx playwright test\n`,
      );
      return 2;
    }
    io.onExit(remove);
    // a signal between two runs, or while the generated config is removed, must not end this process on the spot
    const held = io.hold?.();
    let result: SpawnResult;
    let notes: string[] = [];
    // --explain-flaky: the same run once per seed, each a Playwright run of its own; every run's race files are kept
    const wanted = args.explain ?? 1;
    const seedText = io.env[ENV.seed]?.trim() ?? "";
    const firstSeed = /^\d+$/.test(seedText) && Number.isSafeInteger(Number(seedText)) ? Number(seedText) : 1;
    let made = 0;
    try {
      for (;;) {
        if (args.explain !== null) io.err(`\nGenClass: run ${made + 1} of ${wanted} (seed ${firstSeed + made})\n`);
        result = await io.spawn(plan.argv, { ...io.env, ...plan.env, ...(args.explain !== null ? { [ENV.seed]: String(firstSeed + made) } : {}), ...localBinsPath(io.env, io.cwd, [location.dir, io.cwd]) });
        made++;
        const written = kept ? moveRaceFiles(plan.outDir, kept) : 0;
        // a signal ended it or arrived since, or nothing was written by the first run (no test matched, or Playwright
        // did not start)
        if (made >= wanted || result.signal || (typeof result.code === "number" && result.code >= 128) || held?.signal()) break;
        if (made === 1 && written === 0) break;
      }
      try {
        notes = readFileSync(notesFile, "utf8").split("\n");
      } catch {
        /* no worker had anything to say */
      }
    } catch (e) {
      io.err(`genclass-playwright-run: could not start Playwright (${message(e)}).\n`);
      return 2;
    } finally {
      remove();
      held?.release();
    }
    // a signal that arrived while no child ran: the runs made are reported, and the exit code is the signal's
    const signalled = held?.signal() ?? null;
    const ended: SpawnResult = signalled && !result.signal && !(typeof result.code === "number" && result.code >= 128) ? { code: null, signal: signalled } : result;
    const dir = displayPath(plan.outDir, io.cwd);
    const report = `node ${quoted(displayPath(join(dirname(io.registerPath), "..", "bin", "genclass-playwright-report.mjs"), io.cwd))} ${quoted(dir)} --out -`;
    if (kept && stranded > 0) io.err(`\ngenclass-playwright-run: ${count(stranded, "race file")} could not be put back into ${dir} and ${stranded === 1 ? "is" : "are"} in ${kept} (read from there for the comparison below).\n`);
    const inputs = readRacesDirs(kept && stranded > 0 ? [plan.outDir, kept] : [plan.outDir], io.cwd).files;
    if (args.explain === null) {
      io.err(`\n${runSummary({ inputs, dir, notes, report })}`);
      return exitCodeOf(ended);
    }
    io.err(`\n${explainSummary({ inputs, dir, notes, report, wanted, made, firstSeed })}`);
    // failing runs are what this mode is for: Playwright's exit code only when a signal ended it or nothing ran
    const code = exitCodeOf(ended);
    return code >= 128 || inputs.length === 0 ? code : 0;
  } catch (e) {
    io.err(`genclass-playwright-run: ${message(e)}\n`);
    return 2;
  }
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Starts node with the arguments, on this process's terminal, and waits for it. A signal sent to this process is
 * passed on instead of ending it, so Playwright stops its workers and its reporters finish, and the generated config
 * is removed after that. A terminal's Ctrl+C reaches the child as well; Playwright ignores a second SIGINT within a
 * second. On Windows nothing is passed on (the console delivers it, and a kill there is not a signal).
 */
export function spawnNode(argv: string[], env: Record<string, string | undefined>): Promise<SpawnResult> {
  return new Promise<SpawnResult>((done, fail) => {
    const child = spawn(process.execPath, argv, { stdio: "inherit", env });
    const handlers = SIGNALS.map((signal) => {
      const handler = (): void => {
        if (process.platform === "win32") return;
        try {
          child.kill(signal);
        } catch {
          /* it ended already */
        }
      };
      process.on(signal, handler);
      return { signal, handler };
    });
    const release = (): void => {
      for (const h of handlers) process.off(h.signal, h.handler);
    };
    child.once("error", (e) => {
      release();
      fail(e);
    });
    child.once("exit", (code, signal) => {
      release();
      done({ code, signal });
    });
  });
}

/** The real process. */
export function processRunIo(): RunIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    registerPath: fileURLToPath(new URL("./register.js", import.meta.url)),
    id: process.pid,
    tmpdir: tmpdir(),
    findCli: findPlaywrightCli,
    onExit: (fn) => void process.on("exit", fn),
    spawn: spawnNode,
    hold: holdSignals,
  };
}

/**
 * Listens for the signals that would end this process and only notes the first: with a listener there, Node does not
 * end the process itself. `release` takes the listeners away again (a signal after that ends the process as usual).
 */
export function holdSignals(): { signal(): NodeJS.Signals | null; release(): void } {
  let got: NodeJS.Signals | null = null;
  const handlers = SIGNALS.map((signal) => {
    const handler = (): void => {
      got ??= signal;
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  return {
    signal: () => got,
    release: () => {
      for (const h of handlers) process.off(h.signal, h.handler);
    },
  };
}
