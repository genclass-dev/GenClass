// The command genclass-playwright-run (src/run.ts): its arguments and what it starts, as exact argv and exact text;
// the whole command on a fake process (the generated config is there while Playwright runs and gone afterwards,
// whatever ends the run); and, with the package built, real Playwright runs of an unedited project
// (test/register-smoke: no page, so no browser) that prove the generated config is loaded in the worker and the
// register entry patches Playwright's prototype there, and a real process forked the way a test forks a helper, in
// which the preloaded entry must do nothing.

import { fork, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_REPEAT_EACH, EXPLAIN_STEPS, MAX_EXPLAIN_RUNS, MAX_SUMMARY_SIGNATURES, RUN_USAGE, explainSummary, findPlaywrightCli, localBinsPath, moveRaceFiles, parseRunArgs, planCommand, removeRaceFiles, runCommand, runSummary, type RunIo, type SpawnResult } from "../src/run.js";
import { isWrapperConfigName, wrapperConfigSource } from "../src/wrapper.js";
import { bulkEditSteps, fakeRuntimeDir, fixtureInputs, here, raceFileWithSteps } from "./helpers.js";

const pkgDir = join(here, "..");
const CLI = join("/project", "node_modules", "@playwright", "test", "cli.js");

let root = "";
let project = "";
let runtimeDir = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-run-"));
  project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  writeFileSync(join(project, "playwright.config.ts"), "export default {};\n");
  runtimeDir = fakeRuntimeDir();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
});

describe("run: the command's arguments", () => {
  it("knows --config, --repeat-each and --help; everything else is passed through in order", () => {
    expect(parseRunArgs([])).toEqual({ help: false, config: undefined, repeatEach: false, explain: null, rest: [] });
    expect(parseRunArgs(["--project", "chromium", "-g", "checkout", "tests/a.spec.ts:12", "--workers=2", "-x"])).toEqual({
      help: false,
      config: undefined,
      repeatEach: false,
      explain: null,
      rest: ["--project", "chromium", "-g", "checkout", "tests/a.spec.ts:12", "--workers=2", "-x"],
    });
    for (const argv of [["--config", "e2e/pw.config.ts", "--headed"], ["-c", "e2e/pw.config.ts", "--headed"], ["--config=e2e/pw.config.ts", "--headed"], ["-ce2e/pw.config.ts", "--headed"], ["--headed", "-c", "e2e/pw.config.ts"]])
      expect(parseRunArgs(argv), argv.join(" ")).toEqual({ help: false, config: "e2e/pw.config.ts", repeatEach: false, explain: null, rest: ["--headed"] });
    // the last one wins, as in Playwright's own parser
    expect(parseRunArgs(["-c", "a.ts", "--config=b.ts"]).config).toBe("b.ts");
    expect(parseRunArgs(["--repeat-each", "5", "a.spec.ts"])).toEqual({ help: false, config: undefined, repeatEach: true, explain: null, rest: ["--repeat-each", "5", "a.spec.ts"] });
    expect(parseRunArgs(["--repeat-each=3"])).toEqual({ help: false, config: undefined, repeatEach: true, explain: null, rest: ["--repeat-each=3"] });
    expect(parseRunArgs(["--help"]).help).toBe(true);
    expect(parseRunArgs(["-h"]).help).toBe(true);
  });

  it("a --config with nothing after it is Playwright's to complain about; nothing is read after a bare --", () => {
    expect(parseRunArgs(["--headed", "--config"])).toEqual({ help: false, config: undefined, repeatEach: false, explain: null, rest: ["--headed", "--config"] });
    expect(parseRunArgs(["-c"])).toEqual({ help: false, config: undefined, repeatEach: false, explain: null, rest: ["-c"] });
    expect(parseRunArgs(["--grep", "x", "--", "-c", "--repeat-each", "--help"])).toEqual({ help: false, config: undefined, repeatEach: false, explain: null, rest: ["--grep", "x", "--", "-c", "--repeat-each", "--help"] });
  });
});

describe("run: what the command starts", () => {
  const registerPath = join("/opt", "genclass", "node_modules", "@genclass", "playwright", "dist", "register.js");
  const base = { cwd: "/project", cli: CLI, registerPath, runtimeDir: "/opt/rt/dist", id: 4242, notesFile: "/tmp/notes" };

  it("the project's Playwright, on the generated config, with two seeds and every other argument as given", () => {
    const plan = planCommand({ ...base, args: parseRunArgs(["--project", "chromium", "tests/a.spec.ts"]), env: {}, location: { file: join("/project", "playwright.config.ts"), dir: "/project" }, module: true });
    const wrapperPath = join("/project", "playwright.config.ts.genclass-4242.mjs");
    expect(plan.argv).toEqual([CLI, "test", "--config", wrapperPath, "--repeat-each", "2", "--project", "chromium", "tests/a.spec.ts"]);
    expect(plan.env).toEqual({ GENCLASS_OUT_DIR: join("/project", "test-results", "genclass"), GENCLASS_RUNTIME_DIR: "/opt/rt/dist", GENCLASS_NOTES_FILE: "/tmp/notes", GENCLASS_CHAOS: "on" });
    expect(plan.outDir).toBe(join("/project", "test-results", "genclass"));
    expect(plan.wrapper).toEqual({ path: wrapperPath, source: wrapperConfigSource({ registerUrl: pathToFileURL(registerPath).href, config: "playwright.config.ts", module: true }) });
    expect(plan.wrapper.source).toContain(`import "${pathToFileURL(registerPath).href}";`);
    expect(DEFAULT_REPEAT_EACH).toBe(2);
  });

  it("the user's --config is replaced by the generated one next to it; their --repeat-each and their chaos choice are kept", () => {
    const location = { file: join("/project", "e2e", "pw.staging.cjs"), dir: join("/project", "e2e") };
    const plan = planCommand({ ...base, args: parseRunArgs(["-c", "e2e/pw.staging.cjs", "--repeat-each", "5", "--", "checkout"]), env: { GENCLASS_CHAOS: "off", GENCLASS_OUT_DIR: "out/races" }, location, module: false });
    expect(plan.argv).toEqual([CLI, "test", "--config", join("/project", "e2e", "pw.staging.cjs.genclass-4242.mjs"), "--repeat-each", "5", "--", "checkout"]);
    expect(plan.env).toEqual({ GENCLASS_OUT_DIR: join("/project", "out", "races"), GENCLASS_RUNTIME_DIR: "/opt/rt/dist", GENCLASS_NOTES_FILE: "/tmp/notes" });
    expect(plan.wrapper.source).toContain('createRequire(import.meta.url)("./pw.staging.cjs")');
  });

  it("no config file: a generated one in the directory Playwright would have used, on Playwright's defaults", () => {
    const plan = planCommand({ ...base, args: parseRunArgs([]), env: { GENCLASS_CHAOS: " ", GENCLASS_OUT_DIR: "/elsewhere/races" }, location: { file: null, dir: "/project" }, module: true });
    expect(plan.argv).toEqual([CLI, "test", "--config", join("/project", "playwright.config.genclass-4242.mjs"), "--repeat-each", "2"]);
    expect(plan.env.GENCLASS_CHAOS).toBe("on");
    expect(plan.outDir).toBe("/elsewhere/races");
    expect(plan.wrapper.source.endsWith("\nexport default {};\n")).toBe(true);
  });
});

describe("run: the project's own Playwright", () => {
  it("is found from the project's directory, and nowhere else", () => {
    const require = createRequire(import.meta.url);
    expect(findPlaywrightCli([here])).toBe(require.resolve("@playwright/test/cli"));
    expect(findPlaywrightCli([root, here])).toBe(require.resolve("@playwright/test/cli"));
    expect(findPlaywrightCli([root])).toBeNull();
    expect(findPlaywrightCli([])).toBeNull();
    // a project with the playwright package alone: its own command
    mkdirSync(join(project, "node_modules", "playwright"), { recursive: true });
    writeFileSync(join(project, "node_modules", "playwright", "package.json"), JSON.stringify({ name: "playwright", version: "1.63.0", bin: { playwright: "cli.js" } }));
    writeFileSync(join(project, "node_modules", "playwright", "cli.js"), "");
    expect(findPlaywrightCli([project])).toContain(join("project", "node_modules", "playwright", "cli.js"));
  });
});

describe("run: race files of an earlier run", () => {
  it("are removed from the directory; nothing else is", () => {
    const dir = join(root, "races");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "old-1-s1.json"), JSON.stringify({ schema: "genclass-races/1", test: "t", seed: 1, signatures: [] }));
    writeFileSync(join(dir, "old-broken.json"), JSON.stringify({ schema: "genclass-races/1" }));
    writeFileSync(join(dir, "results.json"), JSON.stringify({ suites: [] }));
    writeFileSync(join(dir, "notes.txt"), "genclass-races/1");
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "sub", "deeper.json"), JSON.stringify({ schema: "genclass-races/1" }));
    expect(removeRaceFiles(dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["broken.json", "notes.txt", "results.json", "sub"]);
    expect(readdirSync(join(dir, "sub"))).toEqual(["deeper.json"]);
    expect(removeRaceFiles(join(root, "nowhere"))).toBe(0);
  });
});

describe("run: what the command prints at the end", () => {
  const report = "node /opt/genclass/bin/genclass-playwright-report.mjs test-results/genclass --out -";

  it("where the race files are and what they hold", () => {
    expect(runSummary({ inputs: fixtureInputs(), dir: "test-results/genclass", notes: [], report })).toBe(
      [
        "GenClass: 4 race files in test-results/genclass (2 tests): 2 signatures in 2 tests, 1 reproducible (flagged in 2 or more seeds of the same test).",
        "  checkout.spec.ts > checkout > places one order",
        "    request:duplicate · POST /api/orders · 2 of 2 seeds (1, 2) · reproducible",
        "  search.spec.ts > search > shows the results of the last query",
        "    delivery:stale · GET /api/search · 1 of 2 seeds (2)",
        `  The report: ${report}`,
        "",
      ].join("\n"),
    );
  });

  it("at most ten signature lines; the rest is one line that says how many more, and the totals count them all", () => {
    const sig = (n: number): Record<string, unknown> => ({ sig: `witness|overwrote-newer|GET /api/r${n}`, trigger: "witness", diagnosis: "overwrote-newer", op: `GET /api/r${n}`, confidence: 1, evidence: "e", seeds: [1] });
    const file = (test: string, from: number, to: number): { name: string; content: string } => ({ name: `${test}-s1.json`, content: JSON.stringify({ schema: "genclass-races/1", test, seed: 1, signatures: Array.from({ length: to - from + 1 }, (_, i) => sig(from + i)) }) });
    // 13 signatures in three tests: 6 + 6 + 1
    const printed = runSummary({ inputs: [file("a.spec.ts > a", 1, 6), file("b.spec.ts > b", 7, 12), file("c.spec.ts > c", 13, 13)], dir: "races", notes: [], report });
    const lines = printed.split("\n");
    expect(lines[0]).toBe("GenClass: 3 race files in races (3 tests): 13 signatures in 3 tests, 0 reproducible (flagged in 2 or more seeds of the same test).");
    expect(MAX_SUMMARY_SIGNATURES).toBe(10);
    expect(lines.filter((l) => l.startsWith("    witness:overwrote-newer · "))).toHaveLength(10);
    // the second test is cut after its fourth line, the third test is not named at all
    expect(lines.filter((l) => /^  \S/.test(l))).toEqual(["  a.spec.ts > a", "  b.spec.ts > b", "  and 3 more signatures", `  The report: ${report}`]);
    expect(printed).not.toContain("c.spec.ts");
    // exactly ten: no such line; eleven: the singular
    const ten = runSummary({ inputs: [file("a.spec.ts > a", 1, 10)], dir: "races", notes: [], report });
    expect(ten).not.toContain("more signature");
    expect(runSummary({ inputs: [file("a.spec.ts > a", 1, 11)], dir: "races", notes: [], report })).toContain("\n  and 1 more signature\n");
  });

  it("says when chaos held no request, with the variable to set; says nothing of it when chaos was off or held some", () => {
    const file = (test: string, seed: number, chaosApplied: number | null): { name: string; content: string } => ({
      name: `${test}-s${seed}.json`,
      content: JSON.stringify({
        schema: "genclass-races/1",
        test,
        seed,
        signatures: [],
        mode: "observe",
        model: { state: "off" },
        chaos: chaosApplied === null ? null : { latencyMs: [0, 600], reorder: true, routes: ["same host /api* or Accept: json"] },
        fixture: { model: "skip", agent: null, chaosApplied, serviceWorker: false },
      }),
    });
    const idle = runSummary({ inputs: [file("a.spec.ts > a", 1, 0), file("a.spec.ts > a", 2, 0), file("b.spec.ts > b", 1, 7)], dir: "races", notes: [], report });
    expect(idle).toContain("\n  Chaos held no request in 2 of 3 race files: ");
    expect(idle).toContain("GENCLASS_CHAOS_MATCH=/graphql,https://api.example.com/");
    expect(idle.split("\n").filter((l) => l.includes("Chaos held no request"))).toHaveLength(1);
    expect(runSummary({ inputs: [file("a.spec.ts > a", 1, 4), file("b.spec.ts > b", 1, 7)], dir: "races", notes: [], report })).not.toContain("Chaos held no request");
    expect(runSummary({ inputs: [file("a.spec.ts > a", 1, null)], dir: "races", notes: [], report })).not.toContain("Chaos held no request");
  });

  it("nothing written, what the workers remembered, and files that are not race files", () => {
    expect(runSummary({ inputs: [], dir: "test-results/genclass", notes: [], report })).toBe("GenClass: no race file in test-results/genclass. One is written for each test that opens a browser context while GenClass is on.\n");
    expect(runSummary({ inputs: [], dir: "out", notes: ["could not put GenClass on a browser context: Target closed", "", "could not put GenClass on a browser context: Target closed", " GENCLASS_SEED=\"x\" is not a whole number from 0; using 1 "], report })).toBe(
      [
        "GenClass: no race file in out. One is written for each test that opens a browser context while GenClass is on.",
        "GenClass notes:",
        "  - could not put GenClass on a browser context: Target closed (2 workers)",
        '  - GENCLASS_SEED="x" is not a whole number from 0; using 1',
        "",
      ].join("\n"),
    );
    const clean = { name: "a-1-s1.json", content: JSON.stringify({ schema: "genclass-races/1", test: "a.spec.ts > a", seed: 1, signatures: [] }) };
    expect(runSummary({ inputs: [clean, { name: "x.json", content: "{}" }], dir: "races", notes: [], report })).toBe(
      ["GenClass: 1 race file in races (1 test): 0 signatures in 0 tests, 0 reproducible (flagged in 2 or more seeds of the same test).", "  1 file in that directory could not be read as a race file", `  The report: ${report}`, ""].join("\n"),
    );
  });
});

interface FakeIo extends RunIo {
  env: Record<string, string | undefined>;
  stdout: string;
  stderr: string;
  exits: (() => void)[];
  spawned: { argv: string[]; env: Record<string, string | undefined>; wrapper: string | null }[];
  /** What Playwright "does" while it runs, and how it ends. */
  during: (argv: string[], env: Record<string, string | undefined>) => SpawnResult | Promise<SpawnResult>;
}

function fakeIo(env: Record<string, string | undefined> = {}): FakeIo {
  const io: FakeIo = {
    cwd: project,
    env: { GENCLASS_RUNTIME_DIR: runtimeDir, ...env },
    stdout: "",
    stderr: "",
    exits: [],
    spawned: [],
    during: () => ({ code: 0, signal: null }),
    out: (s) => void (io.stdout += s),
    err: (s) => void (io.stderr += s),
    registerPath: join(root, "pkg", "dist", "register.js"),
    id: 77,
    tmpdir: root,
    findCli: () => CLI,
    onExit: (fn) => void io.exits.push(fn),
    async spawn(argv, childEnv) {
      const at = argv.indexOf("--config");
      const wrapper = at >= 0 && existsSync(argv[at + 1]) && isWrapperConfigName(argv[at + 1]) ? readFileSync(argv[at + 1], "utf8") : null;
      io.spawned.push({ argv, env: childEnv, wrapper });
      return io.during(argv, childEnv);
    },
  };
  return io;
}

const leftovers = (dir: string): string[] => readdirSync(dir).filter((n) => isWrapperConfigName(n));
const raceFile = (test: string, seed: number, signatures: unknown[] = []): string => JSON.stringify({ schema: "genclass-races/1", test, seed, signatures });

describe("run: --explain-flaky, a test's failing runs against its passing ones", () => {
  const BULK = "list.spec.ts > bulk edit";
  const DELAYS = { chaos: { latencyMs: [0, 600], reorder: true }, fixture: { model: "skip", agent: null, chaosApplied: 4, serviceWorker: false } };
  /**
   * The test fails under seeds 3, 7, 11 and 15 (the response lands between the two clicks) and passes under the others:
   * four with the response before the first click, eight with it after the second. So of the 1820 ways to call four of
   * sixteen runs failing, two have an order of their own: the real one, and the four "before" runs.
   */
  const failsUnder = (seed: number): boolean => seed % 4 === 3;
  const writeRun = (dir: string, seed: number, test = BULK): void => {
    const failed = failsUnder(seed);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${test.replace(/[^a-z]+/gi, "-")}-s${seed}.json`), raceFileWithSteps(test, seed, failed ? "failed" : "passed", bulkEditSteps(failed ? "between" : seed % 2 ? "before" : "after"), DELAYS));
  };

  it("is read in its three spellings and taken out of what goes to Playwright; a number that is not one, or --repeat-each next to it, is an error", () => {
    expect(parseRunArgs(["--explain-flaky", "tests/a.spec.ts:12"])).toEqual({ help: false, config: undefined, repeatEach: false, explain: 30, rest: ["tests/a.spec.ts:12"] });
    expect(parseRunArgs(["--explain-flaky=64", "-g", "bulk edit"])).toEqual({ help: false, config: undefined, repeatEach: false, explain: 64, rest: ["-g", "bulk edit"] });
    expect(parseRunArgs(["-c", "e2e/pw.config.ts", "--explain-flaky", "12", "--project=chromium"])).toEqual({ help: false, config: "e2e/pw.config.ts", repeatEach: false, explain: 12, rest: ["--project=chromium"] });
    // a number after the flag is its number of runs; a file name is not
    expect(parseRunArgs(["--explain-flaky", "2024.spec.ts"])).toMatchObject({ explain: 30, rest: ["2024.spec.ts"] });
    expect(parseRunArgs(["--", "--explain-flaky"])).toMatchObject({ explain: null, rest: ["--", "--explain-flaky"] });
    expect(parseRunArgs(["--explain-flaky=2"]).explain).toBe(2);
    expect(parseRunArgs([`--explain-flaky=${MAX_EXPLAIN_RUNS}`]).explain).toBe(MAX_EXPLAIN_RUNS);
    for (const bad of ["--explain-flaky=1", "--explain-flaky=0", `--explain-flaky=${MAX_EXPLAIN_RUNS + 1}`, "--explain-flaky=many", "--explain-flaky=", "--explain-flaky=3.5"])
      expect(parseRunArgs([bad]).error, bad).toBe(`--explain-flaky takes a number of runs from 2 to 400, got ${JSON.stringify(bad.slice("--explain-flaky=".length))}`);
    expect(parseRunArgs(["--explain-flaky", "1"]).error).toBe('--explain-flaky takes a number of runs from 2 to 400, got "1"');
    expect(parseRunArgs(["--explain-flaky", "--repeat-each", "3"]).error).toBe("--explain-flaky gives each seed a run of its own: leave out --repeat-each");
    expect(parseRunArgs(["--repeat-each=3", "--explain-flaky=8"]).error).toBe("--explain-flaky gives each seed a run of its own: leave out --repeat-each");
  });

  it("plans a run of one seed: --repeat-each 1 and no retries, the HTML report told not to open, more steps kept; what the user set stands", () => {
    const base = { cwd: project, cli: CLI, location: { file: join(project, "playwright.config.ts"), dir: project }, module: true, registerPath: join(root, "pkg", "dist", "register.js"), runtimeDir, id: 77, notesFile: join(root, "notes") };
    const plan = planCommand({ ...base, args: parseRunArgs(["--explain-flaky", "tests/a.spec.ts:12", "--project=chromium"]), env: {} });
    // no retries: an attempt made after a failure has its first attempt's seed, and is not one more run
    expect(plan.argv).toEqual([CLI, "test", "--config", join(project, "playwright.config.ts.genclass-77.mjs"), "--repeat-each", "1", "--retries=0", "tests/a.spec.ts:12", "--project=chromium"]);
    // a --retries of the user's comes after it on the line, so it is the one Playwright takes
    expect(planCommand({ ...base, args: parseRunArgs(["--explain-flaky", "--retries=2"]), env: {} }).argv.slice(4)).toEqual(["--repeat-each", "1", "--retries=0", "--retries=2"]);
    expect(plan.env).toMatchObject({ GENCLASS_CHAOS: "on", PLAYWRIGHT_HTML_OPEN: "never", GENCLASS_STEPS: String(EXPLAIN_STEPS) });
    expect(EXPLAIN_STEPS).toBe(1000);
    const own = planCommand({ ...base, args: parseRunArgs(["--explain-flaky"]), env: { GENCLASS_CHAOS: "off", PLAYWRIGHT_HTML_OPEN: "always", GENCLASS_STEPS: "200" } });
    expect("GENCLASS_CHAOS" in own.env || "PLAYWRIGHT_HTML_OPEN" in own.env || "GENCLASS_STEPS" in own.env).toBe(false);
    // the usual run touches neither
    const usual = planCommand({ ...base, args: parseRunArgs([]), env: {} });
    expect("PLAYWRIGHT_HTML_OPEN" in usual.env || "GENCLASS_STEPS" in usual.env).toBe(false);
  });

  it("runs Playwright once per seed, each seed the next, keeps every run's files, prints the comparison, and exits 0 whatever the tests did", async () => {
    const io = fakeIo();
    const outDir = join(project, "test-results", "genclass");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "stale-0-s9.json"), raceFileWithSteps("an earlier run", 9, "failed", bulkEditSteps("between")));
    io.during = (_argv, env) => {
      const seed = Number(env.GENCLASS_SEED);
      // Playwright empties its output directory when a run starts, and the race files are in it by default: the
      // earlier runs' files are not there to lose, the command has set them aside
      expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
      rmSync(join(project, "test-results"), { recursive: true, force: true });
      writeRun(env.GENCLASS_OUT_DIR!, seed);
      return { code: failsUnder(seed) ? 1 : 0, signal: null };
    };
    const code = await runCommand(["--explain-flaky=16", "e2e/list.spec.ts:140", "--project=chromium"], io);
    expect(code).toBe(0);
    expect(io.spawned).toHaveLength(16);
    expect(io.spawned.map((s) => s.env.GENCLASS_SEED)).toEqual(Array.from({ length: 16 }, (_, i) => String(i + 1)));
    for (const s of io.spawned) {
      expect(s.argv).toEqual([CLI, "test", "--config", join(project, "playwright.config.ts.genclass-77.mjs"), "--repeat-each", "1", "--retries=0", "e2e/list.spec.ts:140", "--project=chromium"]);
      expect(s.env).toMatchObject({ GENCLASS_CHAOS: "on", PLAYWRIGHT_HTML_OPEN: "never", GENCLASS_STEPS: "1000", GENCLASS_OUT_DIR: outDir });
      expect(s.wrapper).toContain("register.js");
      // each run with the project's local bins first on PATH, as a single run has them
      expect(String(s.env.PATH).split(delimiter)[0]).toBe(join(project, "node_modules", ".bin"));
    }
    // every run's file is back where the report looks for it, and nothing is left where they waited
    expect(readdirSync(outDir)).toHaveLength(16);
    expect(readdirSync(root).filter((n) => n.startsWith("genclass-playwright-"))).toEqual([]);
    expect(leftovers(project)).toEqual([]);
    expect(io.stdout).toBe("");
    const printed = io.stderr.split("\n");
    expect(printed.filter((l) => l.startsWith("GenClass: run "))).toEqual(Array.from({ length: 16 }, (_, i) => `GenClass: run ${i + 1} of 16 (seed ${i + 1})`));
    expect(printed.slice(printed.indexOf("GenClass: 16 runs, each a Playwright run of its own (seeds 1 to 16): 16 race files in test-results/genclass (1 test)."))).toEqual([
      "GenClass: 16 runs, each a Playwright run of its own (seeds 1 to 16): 16 race files in test-results/genclass (1 test).",
      "  The order of steps, failing against passing: a measured comparison, not a diagnosis. An order that sets the failing runs apart may be the cause, a consequence of the cause, or neither.",
      "    list.spec.ts > bulk edit · failed in 4 of 16 runs (under the delays)",
      "      Compared 4 failing runs with 12 passing runs: every failing run has this order of steps, and no passing run does.",
      '      1. In 4 of 4 failing runs and in none of the 12 passing runs that recorded these steps, the response to `POST /api/selection` came between the action `click menuitem "Urgent"` and the action `click button "Apply"` (median 10 ms after the first and 10 ms before the second; there it came before the first of the two in 4 and after the second in 8).',
      "      Of the 1820 ways to choose which 4 of these 16 runs failed, 2 give a difference as strong as the strongest here (the real outcomes are one of them). Orders that every failing run has and no passing run has: 1 here, 0 on average over those ways.",
      "",
    ]);
  });

  it("starts at GENCLASS_SEED when it is set, and leaves the delays off when the user turned them off", async () => {
    const io = fakeIo({ GENCLASS_SEED: "40", GENCLASS_CHAOS: "off" });
    io.during = (_argv, env) => {
      writeRun(env.GENCLASS_OUT_DIR!, Number(env.GENCLASS_SEED));
      return { code: 0, signal: null };
    };
    expect(await runCommand(["--explain-flaky=3"], io)).toBe(0);
    expect(io.spawned.map((s) => [s.env.GENCLASS_SEED, s.env.GENCLASS_CHAOS])).toEqual([
      ["40", "off"],
      ["41", "off"],
      ["42", "off"],
    ]);
    expect(io.stderr).toContain("GenClass: run 3 of 3 (seed 42)");
    expect(io.stderr).toContain("GenClass: 3 runs, each a Playwright run of its own (seeds 40 to 42): 3 race files");
  });

  it("stops when a signal ends a run, with that exit code, and when the first run writes no race file, with Playwright's", async () => {
    const interrupted = fakeIo();
    interrupted.during = (_argv, env) => {
      const seed = Number(env.GENCLASS_SEED);
      writeRun(env.GENCLASS_OUT_DIR!, seed);
      return seed === 3 ? { code: null, signal: "SIGINT" } : { code: 0, signal: null };
    };
    expect(await runCommand(["--explain-flaky=10"], interrupted)).toBe(130);
    expect(interrupted.spawned).toHaveLength(3);
    // the runs that were made are not lost: their files are back in the directory
    expect(readdirSync(join(project, "test-results", "genclass"))).toHaveLength(3);
    expect(readdirSync(root).filter((n) => n.startsWith("genclass-playwright-"))).toEqual([]);
    expect(interrupted.stderr).toContain("GenClass: 3 of 10 runs, each a Playwright run of its own (seeds 1 to 3): 3 race files");
    expect(leftovers(project)).toEqual([]);

    const nothing = fakeIo();
    nothing.during = () => ({ code: 1, signal: null });
    expect(await runCommand(["--explain-flaky=10", "-g", "no such test"], nothing)).toBe(1);
    expect(nothing.spawned).toHaveLength(1);
    expect(nothing.stderr).toContain("GenClass: 1 of 10 runs, each a Playwright run of its own (seed 1): 0 race files in test-results/genclass (0 tests).\n  No race file was written, so there is nothing to compare.");

    const code130 = fakeIo();
    code130.during = (_argv, env) => {
      writeRun(env.GENCLASS_OUT_DIR!, Number(env.GENCLASS_SEED));
      return { code: 130, signal: null };
    };
    expect(await runCommand(["--explain-flaky=10"], code130)).toBe(130);
    expect(code130.spawned).toHaveLength(1);
  });

  it("a start that fails partway, and the process's own exit, put the files of the runs made back too", async () => {
    const io = fakeIo();
    const outDir = join(project, "test-results", "genclass");
    io.during = (_argv, env) => {
      const seed = Number(env.GENCLASS_SEED);
      if (seed === 3) throw new Error("spawn ENOMEM");
      writeRun(env.GENCLASS_OUT_DIR!, seed);
      return { code: 0, signal: null };
    };
    expect(await runCommand(["--explain-flaky=5"], io)).toBe(2);
    expect(io.stderr).toContain("could not start Playwright (spawn ENOMEM)");
    expect(readdirSync(outDir)).toHaveLength(2);
    // what the exit handler does when the command is ended from outside: the same, and safe to do twice
    for (const fn of io.exits) fn();
    expect(readdirSync(outDir)).toHaveLength(2);
    expect(readdirSync(root).filter((n) => n.startsWith("genclass-playwright-"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a run's files that cannot be put back are never deleted: they stay where they waited, are read from there, and the command says where", async () => {
    const io = fakeIo();
    const outDir = join(project, "test-results", "genclass");
    io.during = (_argv, env) => {
      const seed = Number(env.GENCLASS_SEED);
      writeRun(env.GENCLASS_OUT_DIR!, seed);
      // from the last run on, nothing can be made in the output directory (or taken out of it)
      if (seed === 4) chmodSync(outDir, 0o555);
      return { code: failsUnder(seed) ? 1 : 0, signal: null };
    };
    const waiting = join(root, "genclass-playwright-77.runs");
    try {
      expect(await runCommand(["--explain-flaky=4"], io)).toBe(0);
      // the three earlier runs could not be put back: they are still where they waited, and the comparison read all four
      expect(readdirSync(waiting)).toHaveLength(3);
      expect(readdirSync(outDir)).toHaveLength(1);
      expect(io.stderr).toContain(`genclass-playwright-run: 3 race files could not be put back into test-results/genclass and are in ${waiting} (read from there for the comparison below).`);
      expect(io.stderr).toContain("GenClass: 4 runs, each a Playwright run of its own (seeds 1 to 4): 4 race files");
      // the exit handler does not delete them either
      for (const fn of io.exits) fn();
      expect(readdirSync(waiting)).toHaveLength(3);
    } finally {
      chmodSync(outDir, 0o755);
    }
  });

  it("a signal between two runs stops the runs, puts the files back and gives the signal's exit code", async () => {
    const io = fakeIo();
    let got: NodeJS.Signals | null = null;
    let released = 0;
    io.hold = () => ({ signal: () => got, release: () => void released++ });
    io.during = (_argv, env) => {
      const seed = Number(env.GENCLASS_SEED);
      writeRun(env.GENCLASS_OUT_DIR!, seed);
      // Ctrl+C lands just after the second run has ended normally, before the third is started
      if (seed === 2) queueMicrotask(() => void (got = "SIGINT"));
      return { code: 0, signal: null };
    };
    expect(await runCommand(["--explain-flaky=10"], io)).toBe(130);
    expect(io.spawned).toHaveLength(2);
    expect(released).toBe(1);
    expect(readdirSync(join(project, "test-results", "genclass"))).toHaveLength(2);
    expect(readdirSync(root).filter((n) => n.startsWith("genclass-playwright-"))).toEqual([]);
    expect(leftovers(project)).toEqual([]);
    expect(io.stderr).toContain("GenClass: 2 of 10 runs, each a Playwright run of its own (seeds 1 to 2): 2 race files");
    // the usual run holds signals too, while the generated config is written and removed
    const usual = fakeIo();
    let usualReleased = 0;
    usual.hold = () => ({ signal: () => null, release: () => void usualReleased++ });
    expect(await runCommand([], usual)).toBe(0);
    expect(usualReleased).toBe(1);
  });

  it("with GenClass switched off, or a config that is not there, the mode says so and runs nothing: Playwright does not know the option", async () => {
    const off = fakeIo({ GENCLASS_PLAYWRIGHT: "off" });
    expect(await runCommand(["--explain-flaky=8", "-g", "bulk edit"], off)).toBe(2);
    expect(off.spawned).toEqual([]);
    expect(off.stderr).toBe("genclass-playwright-run: --explain-flaky compares what GenClass records, and GenClass is off (GENCLASS_PLAYWRIGHT=off).\nNothing was run.\n");
    const missing = fakeIo();
    expect(await runCommand(["--explain-flaky", "--config", "nowhere/playwright.config.ts"], missing)).toBe(2);
    expect(missing.spawned).toEqual([]);
    expect(missing.stderr).toBe("genclass-playwright-run: the config nowhere/playwright.config.ts was not found.\nNothing was run.\n");
  });

  it("moves race files and nothing else", () => {
    const from = join(root, "from");
    const to = join(root, "deep", "to");
    mkdirSync(join(from, "sub"), { recursive: true });
    writeFileSync(join(from, "a-s1.json"), raceFile("a", 1));
    writeFileSync(join(from, "b-s2.JSON"), raceFile("b", 2));
    writeFileSync(join(from, "report.json"), JSON.stringify({ stats: {} }));
    writeFileSync(join(from, "broken.json"), "{");
    writeFileSync(join(from, "notes.txt"), "keep");
    writeFileSync(join(from, "sub", "c-s3.json"), raceFile("c", 3));
    expect(moveRaceFiles(from, to)).toBe(2);
    expect(readdirSync(to).sort()).toEqual(["a-s1.json", "b-s2.JSON"]);
    expect(readdirSync(from).sort()).toEqual(["broken.json", "notes.txt", "report.json", "sub"]);
    expect(readFileSync(join(to, "a-s1.json"), "utf8")).toBe(raceFile("a", 1));
    // a file of the same name is replaced; nothing to move makes no directory
    writeFileSync(join(from, "a-s1.json"), raceFile("a again", 1));
    expect(moveRaceFiles(from, to)).toBe(1);
    expect(readFileSync(join(to, "a-s1.json"), "utf8")).toBe(raceFile("a again", 1));
    expect(moveRaceFiles(join(root, "nowhere"), join(root, "never"))).toBe(0);
    expect(existsSync(join(root, "never"))).toBe(false);
  });

  it("an argument it cannot read: exit code 2, why, and nothing is run", async () => {
    const io = fakeIo();
    expect(await runCommand(["--explain-flaky=1"], io)).toBe(2);
    expect(io.spawned).toEqual([]);
    expect(io.stderr).toBe('genclass-playwright-run: --explain-flaky takes a number of runs from 2 to 400, got "1".\nNothing was run.\n');
    const both = fakeIo();
    expect(await runCommand(["--explain-flaky", "--repeat-each", "4"], both)).toBe(2);
    expect(both.stderr).toBe("genclass-playwright-run: --explain-flaky gives each seed a run of its own: leave out --repeat-each.\nNothing was run.\n");
    expect(leftovers(project)).toEqual([]);
  });

  it("what it says when there is nothing to compare: a test that always passed, one that always failed, one with too few of a kind, files without a status", () => {
    const input = (test: string, seed: number, status: string | undefined, extra: Record<string, unknown> = DELAYS) => ({ name: `${test}-${seed}.json`, content: raceFileWithSteps(test, seed, status, bulkEditSteps(status === "failed" ? "between" : "before"), extra) });
    const inputs = [
      ...[1, 2, 3, 4].map((s) => input("a.spec.ts > always passes", s, "passed")),
      ...[1, 2, 3, 4].map((s) => input("b.spec.ts > always fails", s, "failed")),
      ...[1, 2, 3, 4].map((s) => input("c.spec.ts > fails once", s, s === 2 ? "failed" : "passed")),
      ...[1, 2, 3, 4].map((s) => input("d.spec.ts > older files", s, undefined)),
      ...[1, 2].map((s) => input("e.spec.ts > fails without delays", s, "failed", {})),
    ];
    expect(explainSummary({ inputs, dir: "races", notes: ["one worker's line"], report: "", wanted: 4, made: 4, firstSeed: 1 })).toBe(
      [
        "GenClass: 4 runs, each a Playwright run of its own (seeds 1 to 4): 18 race files in races (5 tests).",
        "  The order of steps, failing against passing: a measured comparison, not a diagnosis. An order that sets the failing runs apart may be the cause, a consequence of the cause, or neither.",
        "    a.spec.ts > always passes · passed in all 4 runs: nothing to compare.",
        "    b.spec.ts > always fails · failed in all 4 runs: there is no passing run to compare with. GENCLASS_CHAOS=off makes the runs without the delays.",
        "    c.spec.ts > fails once · failed in 1 of 4 runs: too few of one kind to compare (it takes 3 failing and 3 passing). More runs: --explain-flaky=40",
        "    d.spec.ts > older files · its race files do not say whether it passed (written by an older @genclass/playwright): nothing to compare.",
        "    e.spec.ts > fails without delays · failed in all 2 runs: there is no passing run to compare with.",
        "GenClass notes:",
        "  - one worker's line",
        "",
      ].join("\n"),
    );
  });

  it("the usual run says the same about a test that failed in some of its runs, under its signatures", () => {
    const inputs = Array.from({ length: 16 }, (_, i) => ({ name: `bulk-${i + 1}.json`, content: raceFileWithSteps(BULK, i + 1, failsUnder(i + 1) ? "failed" : "passed", bulkEditSteps(failsUnder(i + 1) ? "between" : (i + 1) % 2 ? "before" : "after"), DELAYS) }));
    const two = [{ name: "cart-1.json", content: raceFileWithSteps("cart.spec.ts > adds two", 1, "failed", bulkEditSteps("between"), { ...DELAYS, location: { file: "e2e/cart.spec.ts", line: 12 } }) }, { name: "cart-2.json", content: raceFileWithSteps("cart.spec.ts > adds two", 2, "passed", bulkEditSteps("before"), DELAYS) }];
    const printed = runSummary({ inputs: [...inputs, ...two], dir: "races", notes: [], report: "REPORT" }).split("\n");
    expect(printed).toEqual([
      "GenClass: 18 race files in races (2 tests): 0 signatures in 0 tests, 0 reproducible (flagged in 2 or more seeds of the same test).",
      "  Failed in some runs (the order of steps, failing against passing: a measured comparison, not a diagnosis):",
      "    list.spec.ts > bulk edit · failed in 4 of 16 runs (under the delays)",
      "      Compared 4 failing runs with 12 passing runs: every failing run has this order of steps, and no passing run does.",
      '      1. In 4 of 4 failing runs and in none of the 12 passing runs that recorded these steps, the response to `POST /api/selection` came between the action `click menuitem "Urgent"` and the action `click button "Apply"` (median 10 ms after the first and 10 ms before the second; there it came before the first of the two in 4 and after the second in 8).',
      "      Of the 1820 ways to choose which 4 of these 16 runs failed, 2 give a difference as strong as the strongest here (the real outcomes are one of them). Orders that every failing run has and no passing run has: 1 here, 0 on average over those ways.",
      "    cart.spec.ts > adds two · failed in 1 of 2 runs (under the delays), and no witness was recorded in a failing run. That is too few runs to compare (it takes 3 failing and 3 passing). This runs the test 30 times, each run on its own, and compares the order of steps in its failing and passing runs: `npx genclass-playwright-run --explain-flaky e2e/cart.spec.ts:12`",
      "  The report: REPORT",
      "",
    ]);
    // nothing of it for files that carry no status
    expect(runSummary({ inputs: fixtureInputs(), dir: "races", notes: [], report: "REPORT" })).not.toContain("Failed in some runs");
  });

  it("the usage names the mode and the new variable", () => {
    expect(RUN_USAGE).toContain("genclass-playwright-run --explain-flaky[=N] [arguments that select the test ...]");
    expect(RUN_USAGE).toContain("GENCLASS_STEPS=<n>");
  });
});

describe("run: the command, on a fake process", () => {
  it("writes the generated config next to the user's, runs Playwright on it, removes it, says where the race files are, and exits with Playwright's code", async () => {
    const io = fakeIo();
    const outDir = join(project, "test-results", "genclass");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "stale-0-s9.json"), raceFile("an earlier run", 9));
    io.during = (_argv, env) => {
      // the earlier run's files are gone before Playwright starts; the workers write this run's
      expect(readdirSync(outDir)).toEqual([]);
      const sig = { sig: "witness|overwrote-newer|GET /api/search", trigger: "witness", diagnosis: "overwrote-newer", op: "GET /api/search", confidence: 1, evidence: "e", seeds: [1] };
      writeFileSync(join(env.GENCLASS_OUT_DIR!, "search-1-s1.json"), raceFile("search.spec.ts > search", 1, [sig]));
      writeFileSync(join(env.GENCLASS_OUT_DIR!, "search-1-s2.json"), raceFile("search.spec.ts > search", 2, [{ ...sig, seeds: [2] }]));
      writeFileSync(env.GENCLASS_NOTES_FILE!, "one worker's line\n");
      return { code: 1, signal: null };
    };
    const code = await runCommand(["--project", "chromium", "tests/a.spec.ts"], io);
    expect(code).toBe(1);
    const wrapperPath = join(project, "playwright.config.ts.genclass-77.mjs");
    expect(io.spawned).toHaveLength(1);
    expect(io.spawned[0].argv).toEqual([CLI, "test", "--config", wrapperPath, "--repeat-each", "2", "--project", "chromium", "tests/a.spec.ts"]);
    expect(io.spawned[0].wrapper).toBe(wrapperConfigSource({ registerUrl: pathToFileURL(io.registerPath).href, config: "playwright.config.ts", module: true }));
    expect(io.spawned[0].env).toMatchObject({ GENCLASS_CHAOS: "on", GENCLASS_OUT_DIR: outDir, GENCLASS_RUNTIME_DIR: runtimeDir, GENCLASS_NOTES_FILE: join(root, "genclass-playwright-77.notes") });
    expect(leftovers(project)).toEqual([]);
    expect(existsSync(join(root, "genclass-playwright-77.notes"))).toBe(false);
    expect(readdirSync(project).sort()).toEqual(["package.json", "playwright.config.ts", "test-results"]);
    expect(io.stdout).toBe("");
    expect(io.stderr).toBe(
      [
        "",
        "GenClass: 2 race files in test-results/genclass (1 test): 1 signature in 1 test, 1 reproducible (flagged in 2 or more seeds of the same test).",
        "  search.spec.ts > search",
        "    witness:overwrote-newer · GET /api/search · 2 of 2 seeds (1, 2) · reproducible",
        `  The report: node ${join(root, "pkg", "dist", "..", "bin", "genclass-playwright-report.mjs")} test-results/genclass --out -`,
        "GenClass notes:",
        "  - one worker's line",
        "",
      ].join("\n"),
    );
  });

  it("a CommonJS project gets the config that requires; --config names where it goes; the user's choices are kept", async () => {
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app" }));
    mkdirSync(join(project, "e2e"));
    writeFileSync(join(project, "e2e", "pw.config.js"), "module.exports = {};\n");
    const io = fakeIo({ GENCLASS_CHAOS: "off", GENCLASS_OUT_DIR: "out/races", GENCLASS_SEED: "9" });
    expect(await runCommand(["--repeat-each=4", "-c", "e2e/pw.config.js", "--headed"], io)).toBe(0);
    expect(io.spawned[0].argv).toEqual([CLI, "test", "--config", join(project, "e2e", "pw.config.js.genclass-77.mjs"), "--repeat-each=4", "--headed"]);
    expect(io.spawned[0].wrapper).toContain('createRequire(import.meta.url)("./pw.config.js")');
    expect(io.spawned[0].env).toMatchObject({ GENCLASS_CHAOS: "off", GENCLASS_OUT_DIR: join(project, "out", "races"), GENCLASS_SEED: "9" });
    expect(leftovers(join(project, "e2e"))).toEqual([]);
    expect(io.stderr).toBe("\nGenClass: no race file in out/races. One is written for each test that opens a browser context while GenClass is on.\n");
  });

  it("the generated config is removed whatever ends the run: a failed start, a signal, the process's own exit", async () => {
    const failing = fakeIo();
    failing.during = () => {
      throw new Error("spawn ENOENT");
    };
    expect(await runCommand([], failing)).toBe(2);
    expect(failing.spawned[0].wrapper).not.toBeNull();
    expect(leftovers(project)).toEqual([]);
    expect(failing.stderr).toBe("genclass-playwright-run: could not start Playwright (spawn ENOENT).\n");

    const interrupted = fakeIo();
    interrupted.during = () => ({ code: null, signal: "SIGINT" });
    expect(await runCommand([], interrupted)).toBe(130);
    expect(leftovers(project)).toEqual([]);
    const terminated = fakeIo();
    terminated.during = () => ({ code: null, signal: "SIGTERM" });
    expect(await runCommand([], terminated)).toBe(143);
    // Playwright's own code for an interrupted run is passed on as it is
    const stopped = fakeIo();
    stopped.during = () => ({ code: 130, signal: null });
    expect(await runCommand([], stopped)).toBe(130);

    // the process ends while Playwright runs (an uncaught error, process.exit): the exit hook removes the file
    const dying = fakeIo();
    let seen: string[] = [];
    dying.during = () => {
      seen = leftovers(project);
      dying.exits[0]();
      expect(leftovers(project)).toEqual([]);
      return { code: 0, signal: null };
    };
    await runCommand([], dying);
    expect(seen).toEqual(["playwright.config.ts.genclass-77.mjs"]);
    expect(dying.exits).toHaveLength(1);
  });

  it("Playwright gets the project's node_modules/.bin on PATH, as npx gives it: a webServer command that names a local bin starts", async () => {
    // the workflow file starts this command with `node <path>`, which adds no .bin: on a public Next.js starter the
    // web server's command was "pglite-server ..." and the run ended with exit 127 before any test
    const bin = (d: string) => join(d, "node_modules", ".bin");
    const added = localBinsPath({ PATH: ["/usr/bin", bin("/repo")].join(delimiter) }, "/repo/apps/web", ["/repo/apps/web/e2e", "/repo/apps/web"]);
    // nearest first: the config's directory, its parents, then the working directory's (already listed, so once);
    // one already on PATH stays where it was; what was there stays last
    const parts = added.PATH.split(delimiter);
    expect(parts.slice(0, 3)).toEqual([bin(join("/repo", "apps", "web", "e2e")), bin(join("/repo", "apps", "web")), bin(join("/repo", "apps"))]);
    expect(parts.slice(-2)).toEqual(["/usr/bin", bin("/repo")]);
    expect(parts.filter((p) => p === bin("/repo"))).toHaveLength(1);
    expect(new Set(parts).size).toBe(parts.length);
    // Windows names it "Path": the same name is kept, and no second variable appears
    expect(Object.keys(localBinsPath({ Path: "C:\\Windows" }, "/p", ["/p"]))).toEqual(["Path"]);
    // a relative directory counts from the working directory; with no PATH at all there are only the bins
    expect(localBinsPath({}, "/repo", ["e2e"]).PATH.split(delimiter)[0]).toBe(bin(join("/repo", "e2e")));

    const io = fakeIo({ PATH: "/usr/bin" });
    expect(await runCommand([], io)).toBe(0);
    const path = String(io.spawned[0].env.PATH).split(delimiter);
    expect(path[0]).toBe(bin(project));
    expect(path[path.length - 1]).toBe("/usr/bin");
  });

  it("the off switch, and a --config that is not there: Playwright as it is, with the arguments as given", async () => {
    const off = fakeIo({ GENCLASS_PLAYWRIGHT: "off" });
    off.during = () => ({ code: 3, signal: null });
    expect(await runCommand(["-c", "playwright.config.ts", "--grep", "x"], off)).toBe(3);
    // the environment as it is, plus the project's local bins on PATH, as `npx playwright test` has them
    expect(off.spawned).toEqual([{ argv: [CLI, "test", "-c", "playwright.config.ts", "--grep", "x"], env: { ...off.env, ...localBinsPath(off.env, project, [project]) }, wrapper: null }]);
    expect(off.stderr).toBe("GenClass is off (GENCLASS_PLAYWRIGHT=off): running Playwright as it is.\n");
    expect(leftovers(project)).toEqual([]);

    const missing = fakeIo();
    missing.during = () => ({ code: 1, signal: null });
    expect(await runCommand(["--config", "nowhere/playwright.config.ts"], missing)).toBe(1);
    expect(missing.spawned[0].argv).toEqual([CLI, "test", "--config", "nowhere/playwright.config.ts"]);
    expect(missing.stderr).toBe("");
  });

  it("nothing is run without the project's Playwright or without the runtime: exit code 2 and why", async () => {
    const noPlaywright = fakeIo();
    noPlaywright.findCli = () => null;
    expect(await runCommand([], noPlaywright)).toBe(2);
    expect(noPlaywright.spawned).toEqual([]);
    expect(noPlaywright.stderr).toBe(`genclass-playwright-run: Playwright Test was not found from ${project}. Run this where "npx playwright test" works, after the project's dependencies are installed.\n`);

    const noRuntime = fakeIo({ GENCLASS_RUNTIME_DIR: join(root, "nowhere") });
    expect(await runCommand([], noRuntime)).toBe(2);
    expect(noRuntime.spawned).toEqual([]);
    expect(noRuntime.stderr).toMatch(/^genclass-playwright-run: @genclass\/playwright: runtimeDir .*nowhere has no genclass\.global\.js/);
    expect(noRuntime.stderr).toContain("Nothing was run. Install @genclass/runtime@beta next to @genclass/playwright, or set GENCLASS_RUNTIME_DIR to its dist/ directory.\n");
    expect(leftovers(project)).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a config directory that cannot be written to: nothing is run, and the preload is named as the way around", async () => {
    mkdirSync(join(project, "ro"));
    writeFileSync(join(project, "ro", "playwright.config.ts"), "export default {};\n");
    chmodSync(join(project, "ro"), 0o555);
    try {
      const io = fakeIo();
      expect(await runCommand(["-c", "ro"], io)).toBe(2);
      expect(io.spawned).toEqual([]);
      expect(io.stderr).toContain(`genclass-playwright-run: could not write ${join(project, "ro", "playwright.config.ts.genclass-77.mjs")} (`);
      expect(io.stderr).toContain(`  NODE_OPTIONS="--import ${pathToFileURL(io.registerPath).href}" npx playwright test\n`);
    } finally {
      chmodSync(join(project, "ro"), 0o755);
    }
  });

  it("--help prints the usage and runs nothing", async () => {
    const io = fakeIo();
    expect(await runCommand(["--grep", "x", "--help"], io)).toBe(0);
    expect(io.stdout).toBe(RUN_USAGE);
    expect(io.spawned).toEqual([]);
    for (const name of ["GENCLASS_CHAOS", "GENCLASS_SEED", "GENCLASS_CHAOS_DELAY_MS", "GENCLASS_CHAOS_REORDER", "GENCLASS_CHAOS_MATCH", "GENCLASS_OUT_DIR", "GENCLASS_MODEL", "GENCLASS_RUNTIME_DIR", "GENCLASS_PLAYWRIGHT"]) expect(RUN_USAGE, name).toContain(name);
  });
});

// Real Playwright, no browser: the project in test/register-smoke is an ordinary one (its config and spec import only
// @playwright/test). These need dist/ (the command imports dist/run.js, the generated config imports
// dist/register.js): CI builds before the tests and fails here if it did not; a local run without dist/ skips them.
const built = existsSync(join(pkgDir, "dist", "run.js")) && existsSync(join(pkgDir, "dist", "register.js"));

describe.runIf(built || Boolean(process.env.CI))("run: an unedited project under a real Playwright (no browser)", () => {
  const smoke = join(here, "register-smoke");
  const bin = join(pkgDir, "bin", "genclass-playwright-run.mjs");
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  const registerUrl = pathToFileURL(join(pkgDir, "dist", "register.js")).href;

  /** The environment of this test run, without what would steer the entry or Playwright's workers. */
  function environment(env: Record<string, string>): Record<string, string | undefined> {
    const clean: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GENCLASS_") && !k.startsWith("VITEST") && k !== "NODE_OPTIONS" && k !== "TEST_WORKER_INDEX" && k !== "TEST_PARALLEL_INDEX") clean[k] = v;
    return { ...clean, CI: "1", GENCLASS_RUNTIME_DIR: runtimeDir, ...env };
  }

  function run(args: string[], env: Record<string, string>): { status: number | null; out: string; err: string } {
    const r = spawnSync(process.execPath, args, { cwd: smoke, encoding: "utf8", timeout: 120_000, env: environment(env) });
    return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
  }

  it("through the command: the generated config is loaded in the worker, the prototype is patched there, and the file is gone afterwards", () => {
    const r = run([bin], { GENCLASS_SMOKE: "command" });
    expect(r.out + r.err).toContain("2 passed");
    expect(r.status).toBe(0);
    expect(r.err).toContain("GenClass: no race file in test-results/genclass.");
    expect(leftovers(smoke)).toEqual([]);
  }, 120_000);

  it("through the command, with a config Playwright requires (--config commonjs.config.cts)", () => {
    const r = run([bin, "--config", "commonjs.config.cts", "--repeat-each", "1"], { GENCLASS_SMOKE: "command", GENCLASS_SMOKE_CONFIG: "commonjs.config.cts" });
    expect(r.out + r.err).toContain("1 passed");
    expect(r.status).toBe(0);
    expect(leftovers(smoke)).toEqual([]);
  }, 120_000);

  it("without the command: the entry preloaded with NODE_OPTIONS=--import starts in the worker, on the project's own config", () => {
    const r = run([cli, "test"], { GENCLASS_SMOKE: "preload", NODE_OPTIONS: `--import ${registerUrl}` });
    expect(r.out + r.err).toContain("1 passed");
    expect(r.status).toBe(0);
  }, 120_000);

  it("the off switch: Playwright as it is; and Playwright's exit code is the command's", () => {
    const off = run([bin], { GENCLASS_SMOKE: "off", GENCLASS_PLAYWRIGHT: "off" });
    expect(off.out + off.err).toContain("1 passed");
    expect(off.status).toBe(0);
    expect(off.err).toContain("GenClass is off (GENCLASS_PLAYWRIGHT=off)");
    // a spec that fails under the command fails the command: the expectation about how it was run does not hold
    const failed = run([bin], { GENCLASS_SMOKE: "preload" });
    expect(failed.out + failed.err).toContain("2 failed");
    expect(failed.status).toBe(1);
    expect(leftovers(smoke)).toEqual([]);
  }, 240_000);

  it("a helper a test forks, with the preload, TEST_WORKER_INDEX and a channel inherited from the worker: the entry does nothing there and Playwright is not loaded", async () => {
    // what child_process.fork from a test or a worker fixture gives its child (a mock server, say). The helper is
    // started where @playwright/test can be resolved, as a suite's helpers are
    const script = join(root, "helper.mjs");
    writeFileSync(
      script,
      [
        'import { createRequire } from "node:module";',
        'const state = globalThis[Symbol.for("@genclass/playwright/register")];',
        "const playwrightModules = Object.keys(createRequire(import.meta.url).cache).filter((f) => /[\\\\/]node_modules[\\\\/](playwright|playwright-core|@playwright)[\\\\/]/.test(f)).length;",
        "process.send({ channel: typeof process.send, index: process.env.TEST_WORKER_INDEX, state: state?.state, wrapped: state?.wrapped, notes: state?.notes, playwrightModules }, () => process.exit(0));",
        "",
      ].join("\n"),
    );
    const child = fork(script, [], { cwd: here, env: environment({ TEST_WORKER_INDEX: "0", NODE_OPTIONS: `--import ${registerUrl}`, GENCLASS_CHAOS: "on" }), stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let err = "";
    child.stderr?.on("data", (d: Buffer) => void (err += d.toString()));
    try {
      const said = await new Promise<unknown>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`the helper said nothing in 30 s: ${err}`)), 30_000);
        child.once("message", (m) => {
          clearTimeout(timer);
          done(m);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          fail(new Error(`the helper exited with ${code} before it said anything: ${err}`));
        });
      });
      expect(said).toEqual({ channel: "function", index: "0", state: "idle", wrapped: [], notes: [], playwrightModules: 0 });
      expect(err).toBe("");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 60_000);

  it.skipIf(process.platform === "win32")("interrupted (SIGINT to the command while a test runs): Playwright stops its own run, the generated config is removed, the exit code is Playwright's", async () => {
    const dir = join(here, "interrupt-smoke");
    const child = spawn(process.execPath, [bin, "--repeat-each", "1"], { cwd: dir, env: environment({}), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => void (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => void (out += d.toString()));
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) => child.on("exit", (code, signal) => done({ code, signal })));
    try {
      // the test is running in a worker (the line reporter has named it), on the generated config
      const deadline = Date.now() + 60_000;
      while (!(out.includes("[1/1]") && leftovers(dir).length === 1) && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(out).toContain("[1/1]");
      expect(leftovers(dir)).toHaveLength(1);
      child.kill("SIGINT");
      expect(await exited).toEqual({ code: 130, signal: null });
      expect(out).toContain("1 interrupted");
      expect(out).toContain("GenClass: no race file in test-results/genclass.");
      expect(leftovers(dir)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 120_000);
});
