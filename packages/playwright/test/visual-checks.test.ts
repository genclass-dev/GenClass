// Measured visual checks with `visual: true` (src/fixture.ts, install.ts, races.ts, schema.ts, summarize.ts): opt-in,
// report only; each check the page reports becomes a "check|<kind>|<route>" signature whose evidence is the kind, the
// element's selector and the measured numbers (never the element's text or the console line); without the runtime's
// dist/visual/index.js the checks stay off and the file says they did not run. In the report they are a group of
// their own, titled as measured checks, with no confidence and their own footer paragraph; they never hide what the
// model or the agent entry could not check. Off by default: nothing of this appears.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGenClass, type TestInfoLike } from "../src/fixture.js";
import { BINDING, CHECK_WAIT_MS, VISUAL_MISSING, VISUAL_NO_PASS, install, type PageLike } from "../src/install.js";
import { checkSignature } from "../src/races.js";
import { validateRaces } from "../src/schema.js";
import { CATEGORY_TITLES, buildSummary, categoryOf, summarize } from "../src/summarize.js";
import { CHECK_TRIGGER, type GenClassRacesFile, type RaceSignature } from "../src/types.js";

class FakePage implements PageLike {
  initScripts: string[] = [];
  evaluated: string[] = [];
  exposed = new Map<string, (item: unknown) => unknown>();
  evaluateResult: unknown = null;
  closed = false;
  async route(): Promise<void> {}
  async addInitScript(s: { content: string }): Promise<void> {
    this.initScripts.push(s.content);
  }
  async exposeFunction(name: string, fn: (item: unknown) => unknown): Promise<void> {
    this.exposed.set(name, fn);
  }
  async evaluate(expression: string): Promise<unknown> {
    this.evaluated.push(expression);
    return this.evaluateResult;
  }
  isClosed(): boolean {
    return this.closed;
  }
  push(item: unknown): void {
    this.exposed.get(BINDING)!(item);
  }
}

let root = "";
let runtimeDir = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-visual-"));
  runtimeDir = join(root, "rt");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "genclass.global.js"), "/* build */\n");
  writeFileSync(join(runtimeDir, "agent.js"), "export function connectAgent() {}\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const withChunk = () => {
  mkdirSync(join(runtimeDir, "visual"), { recursive: true });
  writeFileSync(join(runtimeDir, "visual", "index.js"), "export function startVisual() {}\n");
};

const finding = { kind: "text-invisible", route: "/checkout", selector: "main > p.lead", measured: { ratio: 1.0412345, fontPx: 16, fg: "#fafafa", ok: false, inf: Infinity } };

describe("checks: what a signature keeps", () => {
  it("the kind, the route, the selector and the measured numbers; never text, colours or flags", () => {
    expect(checkSignature(finding, 3)).toEqual({
      sig: "check|text-invisible|/checkout",
      trigger: CHECK_TRIGGER,
      diagnosis: "text-invisible",
      op: "/checkout",
      confidence: 1,
      evidence: "text-invisible at main > p.lead: ratio 1.041, fontPx 16",
      seeds: [3],
    });
    // a target or a message handed over by mistake is not read
    const s = checkSignature({ ...finding, target: 'paragraph "Hello Jane"', message: "[GenClass] Check (measured): Hello Jane" }, 1)!;
    expect(JSON.stringify(s)).not.toContain("Jane");
    expect(checkSignature({ kind: "page-blank" }, 1)).toMatchObject({ sig: "check|page-blank|(unknown route)", evidence: "page-blank" });
    expect(checkSignature({ route: "/x" }, 1)).toBeNull();
    expect(checkSignature(null, 1)).toBeNull();
  });
});

describe("install: the checks on a page", () => {
  it("without dist/visual/index.js the checks stay off and the run says why", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null, visual: true });
    expect(page.initScripts[0]).not.toContain('"visual":true');
    page.evaluateResult = { mode: "observe", model: { state: "off" }, agent: null, visual: null };
    const c = await session.finish();
    expect(page.evaluated[0]).toContain("a.collect()");
    expect(c.visual).toBe(VISUAL_MISSING);
  });

  it("with the chunk: the page config turns them on, collect runs a last pass, and the findings are kept", async () => {
    withChunk();
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null, visual: true });
    expect(page.initScripts[0]).toContain('"visual":true');
    page.push({ t: "check", check: finding });
    page.evaluateResult = { mode: "observe", model: { state: "off" }, agent: null, visual: null };
    const c = await session.finish();
    expect(page.evaluated).toEqual([`(function () { var a = window.__GENCLASS_PLAYWRIGHT__; return a ? a.collect(0, ${CHECK_WAIT_MS}) : null; })()`]);
    expect(c.visual).toBeNull();
    expect(c.checks).toEqual([finding]);
  });

  it("a page that never answers: the checks ran if they reported something", async () => {
    withChunk();
    const quiet = new FakePage();
    quiet.closed = true;
    expect((await (await install(quiet, { runtimeDir, model: "skip", chaos: null, visual: true })).finish()).visual).toBe(VISUAL_NO_PASS);
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null, visual: true });
    page.push({ t: "check", check: finding });
    page.closed = true;
    expect((await session.finish()).visual).toBeNull();
  });

  it("off by default: no checks in the page config, no visual record", async () => {
    withChunk();
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    expect(page.initScripts[0]).not.toContain('"visual":true');
    expect("visual" in (await session.finish())).toBe(false);
  });
});

function info(): TestInfoLike {
  return {
    titlePath: ["", "chromium", "checkout.spec.ts", "checkout", "renders"],
    file: join(root, "tests", "checkout.spec.ts"),
    testId: "id1",
    repeatEachIndex: 0,
    project: { name: "chromium", testDir: join(root, "tests"), outputDir: join(root, "test-results") },
    config: { configFile: join(root, "playwright.config.ts"), rootDir: join(root, "tests") },
  };
}

describe("fixture: visual: true", () => {
  it("writes check signatures and fixture.visual null when they ran", async () => {
    withChunk();
    const page = new FakePage();
    page.evaluateResult = { mode: "observe", model: { state: "off" }, agent: null, visual: null };
    const run = await startGenClass(page, { runtimeDir, visual: true }, info());
    page.push({ t: "check", check: finding });
    const file = (await run.finish()).file!;
    expect(file.signatures.map((s) => s.sig)).toEqual(["check|text-invisible|/checkout"]);
    expect(file.fixture).toEqual({ model: "skip", agent: null, chaosApplied: null, serviceWorker: false, visual: null });
    expect(validateRaces(JSON.parse(JSON.stringify(file)))).toEqual({ ok: true, file });
  });

  it("says the checks did not run without the chunk, and refuses a visual value that is not a boolean", async () => {
    const run = await startGenClass(new FakePage(), { runtimeDir, visual: true }, info());
    expect((await run.finish()).file!.fixture).toMatchObject({ visual: VISUAL_MISSING });
    const page = new FakePage();
    await expect(startGenClass(page, { runtimeDir, visual: "yes" as unknown as boolean }, info())).rejects.toThrow(/genclass\.visual must be true or false/);
    expect(page.initScripts).toEqual([]);
  });

  it("the validator: fixture.visual is a string or null", () => {
    const base = { schema: "genclass-races/1", test: "t", seed: 1, signatures: [], fixture: { model: "skip", agent: null, chaosApplied: null, serviceWorker: false } };
    expect(validateRaces({ ...base, fixture: { ...base.fixture, visual: null } })).toMatchObject({ ok: true, file: { fixture: { visual: null } } });
    const bad = validateRaces({ ...base, fixture: { ...base.fixture, visual: 1 } });
    expect(!bad.ok && bad.errors).toEqual(["fixture.visual: expected a string or null when present, got 1"]);
  });
});

const fx = { model: "skip" as const, agent: null, chaosApplied: null, serviceWorker: false };
const check = (seed: number, kind = "text-invisible", route = "/checkout"): RaceSignature => ({ sig: `check|${kind}|${route}`, trigger: "check", diagnosis: kind, op: route, confidence: 1, evidence: `${kind} at main > p.lead: ratio 1.04`, seeds: [seed] });
const file = (test: string, seed: number, signatures: RaceSignature[], extra: Partial<GenClassRacesFile> = {}): GenClassRacesFile => ({ schema: "genclass-races/1", test, seed, signatures, mode: "observe", model: { state: "off" }, fixture: fx, ...extra });

describe("report: measured checks", () => {
  it("their own group titled as measured checks, a row, no confidence and their own footer paragraph", () => {
    expect(categoryOf("text-invisible", "check")).toBe("check");
    expect(CATEGORY_TITLES.check).toBe("Measured checks (visual measurements, not the model)");
    const md = summarize([
      { name: "a1.json", content: file("checkout", 1, [check(1)]) },
      { name: "a2.json", content: file("checkout", 2, [check(2)]) },
    ]);
    expect(md).toContain("| Other detections | 0 | 0 |\n| Measured checks (visual measurements, not the model) | 1 | 1 |\n\n");
    expect(md).toContain("**Measured checks (visual measurements, not the model)**\n\n- **Reproducible**: 2 of 2 seeds (1, 2) · `/checkout` · `check:text-invisible`\n  > text-invisible at main > p.lead: ratio 1.04\n");
    expect(md).not.toContain("· confidence");
    expect(md).not.toContain("diagnosis by GenClass's on-device model");
    expect(md).toContain('\n---\n\nLines under "Measured checks (visual measurements, not the model)" are the runtime\'s measured visual checks');
    expect(Object.keys(buildSummary([{ name: "a.json", content: file("t", 1, [check(1)]) }]).totals.byCategory)).toEqual(["duplicate", "stale", "failing", "other", "check", "witness"]);
  });

  it("a check does not hide that the witnesses were not recorded, and the note says what was flagged", () => {
    const md = summarize([{ name: "a.json", content: file("t", 1, [check(1)], { fixture: { ...fx, agent: "not-loaded" } }) }]);
    expect(md).toContain("Note: in 1 of 1 file for this test nothing but the model's detections or measured checks was flagged and the fixture could not check the page (witnesses not recorded: not-loaded), so those runs may not have been checked.\n");
  });

  it("checks that did not run: a note under a flagged test and in the nothing-flagged list", () => {
    const md = summarize([
      { name: "a1.json", content: file("flagged", 1, [check(1)], { fixture: { ...fx, visual: null } }) },
      { name: "a2.json", content: file("flagged", 2, [], { fixture: { ...fx, visual: "no pass ran" } }) },
      { name: "b.json", content: file("quiet", 1, [], { fixture: { ...fx, visual: VISUAL_MISSING } }) },
    ]);
    expect(md).toContain("Note: in 1 of 2 files for this test the measured checks did not run (no pass ran).\n");
    expect(md).toContain("- quiet (1 seed: 1; measured checks did not run in 1 of 1 file (dist/visual/index.js missing))\n");
  });
});
