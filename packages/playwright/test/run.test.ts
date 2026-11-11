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
import { DEFAULT_REPEAT_EACH, MAX_SUMMARY_SIGNATURES, RUN_USAGE, findPlaywrightCli, parseRunArgs, planCommand, removeRaceFiles, runCommand, runSummary, type RunIo, type SpawnResult, localBinsPath } from "../src/run.js";
import { isWrapperConfigName, wrapperConfigSource } from "../src/wrapper.js";
import { fakeRuntimeDir, fixtureInputs, here } from "./helpers.js";

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
    expect(parseRunArgs([])).toEqual({ help: false, config: undefined, repeatEach: false, rest: [] });
    expect(parseRunArgs(["--project", "chromium", "-g", "checkout", "tests/a.spec.ts:12", "--workers=2", "-x"])).toEqual({
      help: false,
      config: undefined,
      repeatEach: false,
      rest: ["--project", "chromium", "-g", "checkout", "tests/a.spec.ts:12", "--workers=2", "-x"],
    });
    for (const argv of [["--config", "e2e/pw.config.ts", "--headed"], ["-c", "e2e/pw.config.ts", "--headed"], ["--config=e2e/pw.config.ts", "--headed"], ["-ce2e/pw.config.ts", "--headed"], ["--headed", "-c", "e2e/pw.config.ts"]])
      expect(parseRunArgs(argv), argv.join(" ")).toEqual({ help: false, config: "e2e/pw.config.ts", repeatEach: false, rest: ["--headed"] });
    // the last one wins, as in Playwright's own parser
    expect(parseRunArgs(["-c", "a.ts", "--config=b.ts"]).config).toBe("b.ts");
    expect(parseRunArgs(["--repeat-each", "5", "a.spec.ts"])).toEqual({ help: false, config: undefined, repeatEach: true, rest: ["--repeat-each", "5", "a.spec.ts"] });
    expect(parseRunArgs(["--repeat-each=3"])).toEqual({ help: false, config: undefined, repeatEach: true, rest: ["--repeat-each=3"] });
    expect(parseRunArgs(["--help"]).help).toBe(true);
    expect(parseRunArgs(["-h"]).help).toBe(true);
  });

  it("a --config with nothing after it is Playwright's to complain about; nothing is read after a bare --", () => {
    expect(parseRunArgs(["--headed", "--config"])).toEqual({ help: false, config: undefined, repeatEach: false, rest: ["--headed", "--config"] });
    expect(parseRunArgs(["-c"])).toEqual({ help: false, config: undefined, repeatEach: false, rest: ["-c"] });
    expect(parseRunArgs(["--grep", "x", "--", "-c", "--repeat-each", "--help"])).toEqual({ help: false, config: undefined, repeatEach: false, rest: ["--grep", "x", "--", "-c", "--repeat-each", "--help"] });
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
