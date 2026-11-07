// The quiet point (src/install.ts finish, fixture.ts, schema.ts, summarize.ts): with chaos on, the fixture asks the
// page to wait (at most SETTLE_WAIT_MS) for the agent entry's quiet point before it collects, with chaos still on its
// plan; only then does it release what chaos holds. The answer's wait is raised above that bound. The file says
// whether the page settled (`fixture.settled`), and an unsettled run is a report note, never a signature. Without
// chaos nothing of this happens and the file is what it was. No browser.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveChaos } from "../src/chaos.js";
import { startGenClass, type TestInfoLike } from "../src/fixture.js";
import { COLLECT_TIMEOUT_MS, SETTLE_WAIT_MS, install, type PageLike, type RequestLike, type RouteLike } from "../src/install.js";
import { validateRaces } from "../src/schema.js";
import { buildSummary, summarize } from "../src/summarize.js";
import type { GenClassRacesFile, RaceSignature } from "../src/types.js";

type Handler = (route: RouteLike, request: RequestLike) => Promise<void> | void;

class FakePage implements PageLike {
  routes: { pattern: string; handler: Handler }[] = [];
  evaluated: string[] = [];
  answer: () => Promise<unknown> = async () => null;
  async route(pattern: string, handler: Handler): Promise<void> {
    this.routes.push({ pattern, handler });
  }
  async addInitScript(): Promise<void> {}
  async exposeFunction(): Promise<void> {}
  evaluate(expression: string): Promise<unknown> {
    this.evaluated.push(expression);
    return this.answer();
  }
  isClosed(): boolean {
    return false;
  }
}

let root = "";
let runtimeDir = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-settle-"));
  runtimeDir = join(root, "rt");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "genclass.global.js"), "/* build */\n");
  writeFileSync(join(runtimeDir, "agent.js"), "export function connectAgent() {}\n");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const request = (url: string): RequestLike => ({ url: () => url, method: () => "GET", resourceType: () => "fetch", headers: () => ({}), frame: () => ({ url: () => "http://app.test/page" }) });

describe("install: the quiet point before collecting (chaos on)", () => {
  it("asks the page to wait for its quiet point first, and keeps what it answers", async () => {
    const page = new FakePage();
    page.answer = async () => ({ mode: "observe", model: { state: "off" }, agent: null, settled: true });
    const session = await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [0, 0] }) });
    const c = await session.finish();
    expect(page.evaluated).toEqual([`(function () { var a = window.__GENCLASS_PLAYWRIGHT__; return a ? a.collect(${SETTLE_WAIT_MS}, 0) : null; })()`]);
    expect(c.settled).toBe(true);
    page.answer = async () => ({ mode: "observe", model: { state: "off" }, agent: null, settled: false });
    const again = await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [0, 0] }) });
    expect((await again.finish()).settled).toBe(false);
  });

  it("without chaos: the call is today's, nothing waits and settled stays unset", async () => {
    const page = new FakePage();
    page.answer = async () => ({ mode: "observe", model: { state: "off" }, agent: null, settled: true });
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    const c = await session.finish();
    expect(page.evaluated).toEqual(["(function () { var a = window.__GENCLASS_PLAYWRIGHT__; return a ? a.collect() : null; })()"]);
    expect("settled" in c).toBe(false);
  });

  it("chaos keeps its plan while the page settles: a held request leaves only after the answer", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [10_000, 10_000] }) });
    const order: string[] = [];
    const route: RouteLike = { fulfill: async () => undefined, fallback: async () => void order.push("request left"), abort: async () => undefined };
    const held = page.routes.find((r) => r.pattern === "**/*")!.handler(route, request("http://app.test/api/slow"));
    page.answer = async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("page answered");
      return { mode: "observe", model: { state: "off" }, agent: null, settled: false };
    };
    await session.finish();
    await held;
    expect(order).toEqual(["page answered", "request left"]);
  });

  it("the wait for the answer is raised above the bound; a page that never answers counts as not settled", async () => {
    vi.useFakeTimers();
    const page = new FakePage();
    page.answer = () => new Promise(() => undefined);
    const session = await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [0, 0] }) });
    let done = false;
    const finished = session.finish().then((c) => {
      done = true;
      return c;
    });
    await vi.advanceTimersByTimeAsync(SETTLE_WAIT_MS + 100);
    // still waiting: the page may answer up to COLLECT_TIMEOUT_MS after its own wait
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(COLLECT_TIMEOUT_MS);
    const c = await finished;
    expect(c.settled).toBe(false);
  });
});

function info(): TestInfoLike {
  return {
    titlePath: ["", "chromium", "search.spec.ts", "search", "settles"],
    file: join(root, "tests", "search.spec.ts"),
    testId: "id1",
    repeatEachIndex: 0,
    project: { name: "chromium", testDir: join(root, "tests"), outputDir: join(root, "test-results") },
    config: { configFile: join(root, "playwright.config.ts"), rootDir: join(root, "tests") },
  };
}

describe("fixture and validator: fixture.settled", () => {
  it("is written with chaos on (true or false) and never without chaos", async () => {
    const page = new FakePage();
    page.answer = async () => ({ mode: "observe", model: { state: "off" }, agent: null, settled: false });
    const run = await startGenClass(page, { runtimeDir, chaos: { seed: 1, delayMs: [0, 0] } }, info());
    const file = (await run.finish()).file!;
    expect(file.fixture).toEqual({ model: "skip", agent: null, chaosApplied: 0, serviceWorker: false, settled: false });
    expect(file.signatures).toEqual([]);
    const quiet = new FakePage();
    quiet.answer = async () => ({ mode: "observe", model: { state: "off" }, agent: null, settled: true });
    const plain = await startGenClass(quiet, { runtimeDir }, info());
    expect((await plain.finish()).file!.fixture).toEqual({ model: "skip", agent: null, chaosApplied: null, serviceWorker: false });
  });

  it("the validator keeps a boolean and refuses anything else", () => {
    const base = { schema: "genclass-races/1", test: "t", seed: 1, signatures: [], fixture: { model: "skip", agent: null, chaosApplied: 2, serviceWorker: false } };
    const ok = validateRaces({ ...base, fixture: { ...base.fixture, settled: false } });
    expect(ok.ok && ok.file.fixture).toEqual({ model: "skip", agent: null, chaosApplied: 2, serviceWorker: false, settled: false });
    const bad = validateRaces({ ...base, fixture: { ...base.fixture, settled: "no" } });
    expect(!bad.ok && bad.errors).toEqual(['fixture.settled: expected true or false when present, got "no"']);
  });
});

const fixture = { model: "skip" as const, agent: null, chaosApplied: 2, serviceWorker: false };
const witness: RaceSignature = { sig: "witness|overwrote-newer|GET /api/search", trigger: "witness", diagnosis: "overwrote-newer", op: "GET /api/search", confidence: 1, evidence: "e", seeds: [1] };
const file = (test: string, seed: number, signatures: RaceSignature[], settled?: boolean): GenClassRacesFile => ({
  schema: "genclass-races/1",
  test,
  seed,
  signatures,
  mode: "observe",
  model: { state: "off" },
  chaos: { latencyMs: [0, 600], reorder: true },
  fixture: settled === undefined ? fixture : { ...fixture, settled },
});

describe("report: a page that had not settled", () => {
  it("is a note under a flagged test and in the nothing-flagged list, never a signature", () => {
    const md = summarize([
      { name: "a1.json", content: file("flagged", 1, [witness], false) },
      { name: "a2.json", content: file("flagged", 2, [], true) },
      { name: "b1.json", content: file("quiet", 1, [], false) },
    ]);
    expect(md).toContain(
      "Note: in 1 of 2 files for this test the page had not settled when the fixture collected, 2 s after the test (a request in flight or held, a short timer pending, or events still coming), so what happened after that was not recorded.\n",
    );
    expect(md).toContain("- quiet (1 seed: 1; not settled when collected in 1 of 1 file)\n");
    expect(md).toContain("**1 signature** in 1 test");
    const s = buildSummary([{ name: "b1.json", content: file("quiet", 1, [], false) }]);
    expect(s.tests[0]).toMatchObject({ unsettled: 1, signatures: [] });
  });

  it("settled true, or no record of it, adds nothing: the report is byte for byte the same", () => {
    const md = summarize([
      { name: "a.json", content: file("t", 1, [witness], true) },
      { name: "b.json", content: file("t", 2, [witness]) },
      { name: "c.json", content: file("quiet", 1, [], true) },
    ]);
    expect(md).not.toContain("settled");
    expect(md).toBe(
      summarize([
        { name: "a.json", content: file("t", 1, [witness]) },
        { name: "b.json", content: file("t", 2, [witness]) },
        { name: "c.json", content: file("quiet", 1, []) },
      ]),
    );
    expect(buildSummary([{ name: "a.json", content: file("t", 1, [], true) }]).tests[0].unsettled).toBeUndefined();
  });
});
