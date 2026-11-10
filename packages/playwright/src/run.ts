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
// The command's parts are pure and tested as exact text and exact argv (parseRunArgs, planCommand, runSummary);
// runCommand takes its process (RunIo), so a test runs it without starting anything.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_OUT_DIR, ENV, flagOf, isOff, type Env } from "./env.js";
import { displayPath, readRacesDirs } from "./files.js";
import { findRuntimeDir } from "./install.js";
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

Options are environment variables:
  GENCLASS_CHAOS=off             no seeded network chaos (on by default here: matched API requests are held
                                 for a seeded time, so a suite that passes normally can fail under it)
  GENCLASS_SEED=<n>              the chaos seed (default 1; Playwright's repeat index is added)
  GENCLASS_CHAOS_DELAY_MS=a,b    extra latency per matched request, in ms (default 0,600)
  GENCLASS_CHAOS_REORDER=off     latency only: matched requests leave in the order they were sent
  GENCLASS_CHAOS_MATCH=/api,...  path or URL prefixes to hold (default: same-origin /api* or Accept: json)
  GENCLASS_OUT_DIR=<dir>         where the race files go (default test-results/genclass)
  GENCLASS_MODEL=load            load the runtime's model in the page (default skip: no download)
  GENCLASS_RUNTIME_DIR=<dir>     @genclass/runtime's dist/, when it is not installed next to this package
  GENCLASS_PLAYWRIGHT=off        run Playwright as it is

The exit code is Playwright's.
`;

/** How many seeds a first run gets (`--repeat-each`), unless the user passes one. */
export const DEFAULT_REPEAT_EACH = 2;
/** At most this many signature lines in the command's summary; the report has them all. */
export const MAX_SUMMARY_SIGNATURES = 10;

export interface RunArgs {
  /** --help or -h: print the usage and run nothing. */
  help: boolean;
  /** The value of the user's --config / -c (the last one), or undefined. */
  config: string | undefined;
  /** The user passed --repeat-each. */
  repeatEach: boolean;
  /** Every argument except --config and its value, in the order given. */
  rest: string[];
}

/**
 * Reads the command's arguments. It knows three of Playwright's (--config / -c in all their spellings, --repeat-each,
 * --help / -h) and passes everything else through; after a bare `--` nothing is read at all.
 */
export function parseRunArgs(argv: readonly string[]): RunArgs {
  const out: RunArgs = { help: false, config: undefined, repeatEach: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.rest.push(...argv.slice(i));
      break;
    }
    if (a === "--help" || a === "-h") out.help = true;
    else if ((a === "--config" || a === "-c") && i + 1 < argv.length) out.config = argv[++i];
    else if (a.startsWith("--config=")) out.config = a.slice("--config=".length);
    else if (/^-c./.test(a)) out.config = a.slice(2);
    else {
      if (a === "--repeat-each" || a.startsWith("--repeat-each=")) out.repeatEach = true;
      out.rest.push(a);
    }
  }
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
  return {
    argv: [i.cli, "test", "--config", wrapperPath, ...(i.args.repeatEach ? [] : ["--repeat-each", String(DEFAULT_REPEAT_EACH)]), ...i.args.rest],
    env,
    wrapper: { path: wrapperPath, source: wrapperConfigSource({ registerUrl: pathToFileURL(i.registerPath).href, config: i.location.file, module: i.module }) },
    outDir,
  };
}

/**
 * Removes the race files of an earlier run from the directory: the `*.json` files directly inside it whose `schema` is
 * "genclass-races/1", and nothing else, so a file of an earlier run is never read as another seed. Returns how many.
 */
export function removeRaceFiles(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      const value = JSON.parse(readFileSync(path, "utf8")) as { schema?: unknown } | null;
      if (!value || typeof value !== "object" || value.schema !== RACES_SCHEMA) continue;
      rmSync(path);
      removed++;
    } catch {
      /* not a race file, or not ours to remove */
    }
  }
  return removed;
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
    if (s.skipped.length) lines.push(`  ${count(s.skipped.length, "file")} in that directory could not be read as a race file`);
    lines.push(`  The report: ${i.report}`);
  }
  const notes = new Map<string, number>();
  for (const n of i.notes) if (n.trim()) notes.set(n.trim(), (notes.get(n.trim()) ?? 0) + 1);
  if (notes.size) {
    lines.push("GenClass notes:");
    for (const [line, n] of notes) lines.push(`  - ${line}${n > 1 ? ` (${n} workers)` : ""}`);
  }
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

/** Runs the command with `argv` (without node and the script). Returns the exit code. Never throws. */
export async function runCommand(argv: readonly string[], io: RunIo): Promise<number> {
  try {
    const args = parseRunArgs(argv);
    if (args.help) {
      io.out(RUN_USAGE);
      return 0;
    }
    const off = isOff(io.env);
    const location = resolveConfig(io.cwd, args.config);
    const cli = io.findCli(location ? [location.dir, io.cwd] : [io.cwd]);
    if (!cli) {
      io.err(`genclass-playwright-run: Playwright Test was not found from ${location?.dir ?? io.cwd}. Run this where "npx playwright test" works, after the project's dependencies are installed.\n`);
      return 2;
    }
    if (off || !location) {
      // nothing of GenClass: the off switch, or a --config path that does not exist (Playwright says that best itself)
      if (off) io.err(`GenClass is off (${ENV.off}=${io.env[ENV.off]}): running Playwright as it is.\n`);
      return exitCodeOf(await io.spawn([cli, "test", ...argv], { ...io.env }));
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
    const remove = (): void => {
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
      rmSync(notesFile, { force: true });
      writeFileSync(plan.wrapper.path, plan.wrapper.source);
    } catch (e) {
      io.err(
        `genclass-playwright-run: could not write ${plan.wrapper.path} (${message(e)}).\nNothing was run. Without a generated config, the register entry can be preloaded instead:\n  NODE_OPTIONS=${JSON.stringify(`--import ${pathToFileURL(io.registerPath).href}`)} npx playwright test\n`,
      );
      return 2;
    }
    io.onExit(remove);
    let result: SpawnResult;
    let notes: string[] = [];
    try {
      result = await io.spawn(plan.argv, { ...io.env, ...plan.env });
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
    }
    const dir = displayPath(plan.outDir, io.cwd);
    const report = `node ${quoted(displayPath(join(dirname(io.registerPath), "..", "bin", "genclass-playwright-report.mjs"), io.cwd))} ${quoted(dir)} --out -`;
    io.err(`\n${runSummary({ inputs: readRacesDirs([plan.outDir], io.cwd).files, dir, notes, report })}`);
    return exitCodeOf(result);
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
  };
}
