// The checks of the end-to-end run of the unmodified suite (test/e2e/unmodified.mjs), on race files written here by
// the real writer (the register entry's wrapper on fake contexts) in the shape that run produces. The end-to-end run
// itself needs a browser and runs in CI only; this keeps what it requires honest: the checks accept what the entry
// writes for the expected outcome, and refuse each way it can go wrong. Needs dist/ (the checker reads race files
// with the built validator): CI builds before the tests; a local run without dist/ skips it. Then the child process
// both halves of the end-to-end run start (test/e2e/child.mjs), on real processes: it always comes back, also from a
// child that never ends.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRacesDirs } from "../src/files.js";
import { runSummary } from "../src/run.js";
import type { TestInfoLike } from "../src/session.js";
import { Wrapper } from "../src/wrap.js";
import { fakePlaywright, fakeRuntimeDir, fakeTestInfo, here } from "./helpers.js";

const built = existsSync(join(here, "..", "dist", "summarize.js"));

interface RaceFile {
  name: string;
  file: { test: string; seed: number; signatures: { sig: string }[] };
}
interface Checker {
  SIG: string;
  readRaces(dir: string): RaceFile[];
  checkLatencyOnly(files: RaceFile[]): Record<string, unknown>;
  checkDefaults(files: RaceFile[]): Record<string, unknown>;
  leftovers(dir: string): string[];
  removeGenerated(dir: string): string[];
  summaryOf(out: string): string;
  notesOf(out: string): string[];
  latencyLines(): string[];
  defaultsLines(n: number): string[];
}
interface ChildResult {
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  error?: string;
  out: string;
  ms: number;
}
interface Child {
  DRAIN_MS: number;
  runNode(args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; graceMs?: number }): Promise<ChildResult>;
  ending(r: Partial<ChildResult>, timeoutMs: number): string;
}

let root = "";
let runtimeDir = "";
const workspace = process.env.GITHUB_WORKSPACE;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-e2e-check-"));
  runtimeDir = fakeRuntimeDir();
  process.env.GITHUB_WORKSPACE = root;
});
afterEach(() => {
  if (workspace === undefined) delete process.env.GITHUB_WORKSPACE;
  else process.env.GITHUB_WORKSPACE = workspace;
  rmSync(root, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
});

const WITNESS = { kind: "overwrote-newer", subject: "search.results", by: "GET /api/search#1", over: "GET /api/search#4", overKind: "request", gapMs: 260 };

/**
 * Writes the race files of one run of the unmodified suite, as the register entry writes them: for each test and each
 * of the two seeds, a context with one page whose agent entry connected, one held search request, and the witnesses
 * `witnesses(test, seed)` says the page handed over.
 */
async function writeRunFiles(outDir: string, tests: string[], reorder: boolean, witnesses: (test: string, seed: number) => unknown[]): Promise<void> {
  const pw = fakePlaywright();
  let current: TestInfoLike | null = null;
  const wrapper = new Wrapper({ testInfo: () => current!, options: { runtimeDir, outDir, chaos: reorder ? true : { reorder: false } }, note: (l) => void expect.fail(l) });
  wrapper.wrapBrowserType(pw.chromium);
  const browser = await pw.chromium.launch();
  for (const title of tests) {
    for (const repeat of [0, 1]) {
      current = fakeTestInfo(root, { titlePath: ["search.spec.ts", "search", title], file: join(root, "search.spec.ts"), line: title.startsWith("buggy") ? 33 : 37, testId: `${title.slice(0, 5)}-${repeat}`, repeatEachIndex: repeat, project: { name: "", testDir: root, outputDir: join(root, "test-results") }, config: { configFile: join(root, "playwright.config.ts"), rootDir: root } });
      const context = await browser.newContext();
      await context.newPage();
      // one search request goes through the chaos route (it is released when the context closes)
      const route = { fulfill: async () => undefined, fallback: async () => undefined, abort: async () => undefined };
      const request = { url: () => "http://127.0.0.1:47432/api/search?q=r", method: () => "GET", resourceType: () => "fetch", headers: () => ({}), frame: () => ({ url: () => "http://127.0.0.1:47432/" }) };
      void context.routes[0].handler(route, request);
      for (const w of witnesses(title, 1 + repeat)) context.push({ t: "witness", witness: w });
      await context.close();
    }
  }
}

const BUGGY = "buggy page: results of the last query";
const FIXED = "fixed page: results of the last query";

describe.runIf(built || Boolean(process.env.CI))("e2e check: what the end-to-end run of the unmodified suite requires", () => {
  const load = async (): Promise<Checker> => (await import(join(here, "e2e", "unmodified.mjs"))) as Checker;

  it("accepts the expected outcome: the witness on the buggy page under reordering, nothing on the fixed page, nothing in the latency-only run", async () => {
    const c = await load();
    const defaults = join(root, "test-results", "genclass");
    const latency = join(root, "races-latency-only");
    await writeRunFiles(defaults, [BUGGY, FIXED], true, (test) => (test === BUGGY ? [WITNESS] : []));
    await writeRunFiles(latency, [BUGGY], false, () => []);
    expect(c.checkDefaults(c.readRaces(defaults))).toEqual({
      files: 4,
      seeds: { buggy: [1, 2], fixed: [1, 2] },
      buggy: {
        staleSeeds: [1, 2],
        otherSignatures: [],
        evidence: Array(2).fill("The response of GET /api/search#1 wrote search.results over what newer GET /api/search#4, started 0.26s after GET /api/search#1, had written."),
      },
      fixed: { signatures: [] },
      tests: [`search.spec.ts > search > ${BUGGY}`, `search.spec.ts > search > ${FIXED}`],
      locations: ["search.spec.ts:33", "search.spec.ts:37"],
    });
    expect(c.checkLatencyOnly(c.readRaces(latency))).toEqual({ files: 2, seeds: [1, 2], signatures: [] });
    // what the command prints for these files is what the run looks for in its output
    const print = (dir: string, shown: string): string => runSummary({ inputs: readRacesDirs([dir], root).files, dir: shown, notes: [], report: "node report" });
    for (const line of c.defaultsLines(2)) expect(print(defaults, "test-results/genclass")).toContain(line);
    for (const line of c.latencyLines()) expect(print(latency, "races-latency-only")).toContain(line);
  });

  it("accepts the witness in one seed of two, and says so in the line it looks for", async () => {
    const c = await load();
    const defaults = join(root, "test-results", "genclass");
    await writeRunFiles(defaults, [BUGGY, FIXED], true, (test, seed) => (test === BUGGY && seed === 2 ? [WITNESS] : []));
    expect(c.checkDefaults(c.readRaces(defaults))).toMatchObject({ buggy: { staleSeeds: [2], otherSignatures: [] } });
    const printed = runSummary({ inputs: readRacesDirs([defaults], root).files, dir: "test-results/genclass", notes: [], report: "node report" });
    for (const line of c.defaultsLines(1)) expect(printed).toContain(line);
    expect(c.defaultsLines(1)[0]).toContain("0 reproducible");
    expect(c.defaultsLines(2)[0]).toContain("1 reproducible");
  });

  it("refuses: no witness on the buggy page, a signature on the fixed page, another signature, a missing seed or test", async () => {
    const c = await load();
    const dir = (n: string): string => join(root, n);
    await writeRunFiles(dir("none"), [BUGGY, FIXED], true, () => []);
    expect(() => c.checkDefaults(c.readRaces(dir("none")))).toThrow("no overwrote-newer witness on the buggy page in either seed (expected witness|overwrote-newer|GET /api/search in at least 1 of 2 seeds; the buggy page's files hold no signature)");
    await writeRunFiles(dir("false-report"), [BUGGY, FIXED], true, () => [WITNESS]);
    expect(() => c.checkDefaults(c.readRaces(dir("false-report")))).toThrow(/signatures on the fixed page \(false reports\): seed 1: witness\|overwrote-newer\|GET \/api\/search/);
    await writeRunFiles(dir("other"), [BUGGY, FIXED], true, (test) => (test === BUGGY ? [WITNESS, { kind: "identical-in-flight", by: "GET /api/search#2", over: "GET /api/search#1", gapMs: 80 }] : []));
    expect(() => c.checkDefaults(c.readRaces(dir("other")))).toThrow(/other signatures on the buggy page: seed 1: witness\|identical-in-flight\|GET \/api\/search/);
    await writeRunFiles(dir("one-test"), [BUGGY], true, () => [WITNESS]);
    expect(() => c.checkDefaults(c.readRaces(dir("one-test")))).toThrow(/expected 4 race files \(2 tests × 2 seeds\), found buggy 2, fixed 0 of 2/);
    expect(() => c.checkDefaults([])).toThrow(/found buggy 0, fixed 0 of 0: none/);
    // the latency-only settings where reordering was expected, and the reverse
    await writeRunFiles(dir("fifo"), [BUGGY, FIXED], false, (test) => (test === BUGGY ? [WITNESS] : []));
    expect(() => c.checkDefaults(c.readRaces(dir("fifo")))).toThrow(/chaos settings missing or wrong: .*expected latency 0 to 600 ms, reorder true/);
    await writeRunFiles(dir("reordered"), [BUGGY], true, () => []);
    expect(() => c.checkLatencyOnly(c.readRaces(dir("reordered")))).toThrow(/expected latency 0 to 600 ms, reorder false/);
    await writeRunFiles(dir("overtaken"), [BUGGY], false, () => [WITNESS]);
    expect(() => c.checkLatencyOnly(c.readRaces(dir("overtaken")))).toThrow(/signatures on the buggy page with reorder off/);
    await writeRunFiles(dir("both-tests"), [BUGGY, FIXED], false, () => []);
    expect(() => c.checkLatencyOnly(c.readRaces(dir("both-tests")))).toThrow(/expected 2 race files of the buggy page/);
  });

  it("refuses a file that does not validate, and sees a generated config left behind", async () => {
    const c = await load();
    mkdirSync(join(root, "bad"));
    writeFileSync(join(root, "bad", "x-1-s1.json"), JSON.stringify({ schema: "genclass-races/1", test: "t", seed: "one", signatures: [] }));
    expect(() => c.readRaces(join(root, "bad"))).toThrow(/x-1-s1\.json does not validate: seed: expected an integer/);
    expect(c.readRaces(join(root, "nowhere"))).toEqual([]);
    const project = join(root, "project");
    mkdirSync(join(project, "test-results"), { recursive: true });
    for (const f of ["playwright.config.ts", "search.spec.ts", ".DS_Store"]) writeFileSync(join(project, f), "");
    expect(c.leftovers(project)).toEqual([]);
    writeFileSync(join(project, "playwright.config.ts.genclass-4242.mjs"), "");
    expect(c.leftovers(project)).toEqual(["playwright.config.ts.genclass-4242.mjs"]);
    // the check removes what a killed run left, and only that
    writeFileSync(join(project, "playwright.config.genclass-77.mjs"), "");
    writeFileSync(join(project, "notes.genclass.mjs"), "");
    expect(c.removeGenerated(project)).toEqual(["playwright.config.genclass-77.mjs", "playwright.config.ts.genclass-4242.mjs"]);
    expect(readdirSync(project).sort()).toEqual([".DS_Store", "notes.genclass.mjs", "playwright.config.ts", "search.spec.ts", "test-results"]);
    expect(c.removeGenerated(project)).toEqual([]);
  });

  it("reads the command's own summary and the lines the register entry remembered out of a run's output", async () => {
    const c = await load();
    const clean = runSummary({ inputs: [], dir: "test-results/genclass", notes: [], report: "node report" });
    expect(c.notesOf(`  2 passed (4.1s)\n\n${clean}`)).toEqual([]);
    expect(c.summaryOf(`  2 passed (4.1s)\n\n${clean}`)).toBe("GenClass: no race file in test-results/genclass. One is written for each test that opens a browser context while GenClass is on.");
    const noted = runSummary({ inputs: [], dir: "out", notes: ["could not put GenClass on a browser context: Target closed", "putting GenClass on a browser context took more than 15s; the test went on without waiting"], report: "node report" });
    expect(c.notesOf(`Running 2 tests using 1 worker\n${noted}`)).toEqual(["could not put GenClass on a browser context: Target closed", "putting GenClass on a browser context took more than 15s; the test went on without waiting"]);
    expect(c.summaryOf(`Running 2 tests using 1 worker\n${noted}`)).toContain("GenClass notes: /   - could not put GenClass on a browser context: Target closed");
    expect(c.summaryOf("Error: browserType.launch: Executable doesn't exist")).toBe("no line starting with GenClass");
  });

  it("the suite it runs is an ordinary one: it imports only @playwright/test and names GenClass nowhere in its code", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const project = join(here, "e2e-unmodified");
    expect(readdirSync(project).filter((n) => !n.startsWith(".") && n !== "test-results" && n !== "races-latency-only").sort()).toEqual(["playwright.config.ts", "search.spec.ts"]);
    for (const f of ["playwright.config.ts", "search.spec.ts"]) {
      const code = readFileSync(join(project, f), "utf8")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//"))
        .join("\n");
      expect([...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]), f).toEqual(["@playwright/test"]);
      // GENCLASS_E2E_UNMODIFIED_PORT, the port's variable, is the one mention
      expect(code.replace("GENCLASS_E2E_UNMODIFIED_PORT", "").toLowerCase(), f).not.toContain("genclass");
    }
  });
});

describe.skipIf(process.platform === "win32")("e2e check: the child process both halves start cannot hang the check", () => {
  const load = async (): Promise<Child> => (await import(join(here, "e2e", "child.mjs"))) as Child;

  it("a child that ends comes back with its exit code and everything it wrote", async () => {
    const c = await load();
    const r = await c.runNode(["-e", "console.log('to stdout'); console.error('to stderr'); process.exit(3)"], { cwd: root, env: process.env, timeoutMs: 30_000 });
    expect(r).toMatchObject({ status: 3, signal: null, timedOut: false });
    expect(r.error).toBeUndefined();
    expect(r.out).toContain("to stdout");
    expect(r.out).toContain("to stderr");
    expect(c.ending(r, 30_000)).toBe("exit code 3");
  });

  it("a child that never ends is stopped at the limit: SIGTERM first, SIGKILL when it does not listen", async () => {
    const c = await load();
    const hung = await c.runNode(["-e", "setInterval(() => {}, 1000)"], { cwd: root, env: process.env, timeoutMs: 400 });
    expect(hung).toMatchObject({ status: null, signal: "SIGTERM", timedOut: true });
    expect(hung.ms).toBeLessThan(10_000);
    expect(c.ending(hung, 400)).toBe("ended by SIGTERM after the 0 s limit");
    expect(c.ending({ status: 143, signal: null, timedOut: true }, 180_000)).toBe("exit code 143 after the 180 s limit");
    expect(c.ending({ status: null, signal: null, error: "spawn ENOENT" }, 180_000)).toBe("could not be started (spawn ENOENT)");
    // the two seconds are for node to start and install its handler before the limit
    const deaf = await c.runNode(["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { cwd: root, env: process.env, timeoutMs: 2000, graceMs: 300 });
    expect(deaf).toMatchObject({ status: null, signal: "SIGKILL", timedOut: true });
    expect(deaf.ms).toBeLessThan(12_000);
  });

  it("a child that has exited while something it started still holds its output is not waited for beyond the drain time", async () => {
    const c = await load();
    const holder = "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'inherit', detached: true }).unref(); console.log('started'); process.exit(0)";
    const r = await c.runNode(["-e", holder], { cwd: root, env: process.env, timeoutMs: 30_000 });
    expect(r).toMatchObject({ status: 0, signal: null, timedOut: false });
    expect(r.out).toContain("started");
    expect(r.ms).toBeGreaterThanOrEqual(c.DRAIN_MS - 200);
    expect(r.ms).toBeLessThan(7500);
  });
});
