// The page script's hand-over of steps (src/page.ts), run here as the function it is, against a stand-in for the
// agent entry whose record keeps its newest 600 steps as the runtime's does (packages/runtime/src/agent/record.ts).
// What the page hands over goes into the real install.ts and steps.ts. The browser runs the same function from its
// source text; the end-to-end check covers that.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { install, type PageLike, type Session } from "../src/install.js";
import { genclassPageScript } from "../src/page.js";
import { encodeSteps, sequenceOf } from "../src/steps.js";

const RECORD_KEEPS = 600;
const g = globalThis as unknown as Record<string, unknown>;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let dir: string;
let saved: Record<string, PropertyDescriptor | undefined>;
const GLOBALS = ["window", "top", "location", "document", "navigator", "addEventListener", "GenClass", "GENCLASS_CONFIG", "__GENCLASS_PLAYWRIGHT__", "__bind", "__FAKE_RECORD__"];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "genclass-page-"));
  mkdirSync(join(dir, "runtime"), { recursive: true });
  writeFileSync(join(dir, "runtime", "genclass.global.js"), "");
  // the agent entry's stand-in: the page script imports it from the runtime's own directory
  writeFileSync(join(dir, "runtime", "agent.js"), "export function connectAgent() { const rec = globalThis.__FAKE_RECORD__; return { reason: null, witnesses: () => [], recorded: () => ({ steps: rec.steps.slice() }) }; }\n");
  saved = Object.fromEntries(GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
});

afterAll(() => {
  for (const k of GLOBALS) {
    if (saved[k]) Object.defineProperty(g, k, saved[k]);
    else delete g[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  session: Session;
  items: Record<string, unknown>[];
  /** Adds a step to the page's record, which keeps its newest RECORD_KEEPS. */
  record(step: Record<string, unknown>): void;
  /** What the runtime's "event" does: the page script looks at the record in a microtask. */
  event(): Promise<void>;
  api(): { collect(): unknown; open(): { id: string } | null };
}

/** One page load: the page script run against this process's globals, handing over to a real install(). */
async function pageLoad(): Promise<Harness> {
  const items: Record<string, unknown>[] = [];
  let take: (item: unknown) => void = () => undefined;
  const page = {
    route: async () => undefined,
    addInitScript: async () => undefined,
    exposeFunction: async (_name: string, fn: (item: unknown) => void) => void (take = fn),
    evaluate: async () => null,
    isClosed: () => false,
  } as unknown as PageLike;
  const session = await install(page, { runtimeDir: join(dir, "runtime"), model: "skip", chaos: null, waitForResponsesMs: 0 });
  const rec = { steps: [] as Record<string, unknown>[] };
  const handlers: Record<string, () => void> = {};
  const define = (k: string, value: unknown): void => void Object.defineProperty(g, k, { value, configurable: true, writable: true });
  define("__FAKE_RECORD__", rec);
  define("window", g);
  define("top", g);
  define("location", { protocol: "http:" });
  define("document", { createElement: () => ({ dataset: {} }) });
  define("navigator", { onLine: true });
  define("addEventListener", () => undefined);
  define("__GENCLASS_PLAYWRIGHT__", undefined);
  define("__bind", (item: Record<string, unknown>) => {
    items.push(item);
    take(item);
  });
  const rt = { mode: "observe", status: { state: "off" }, on: (type: string, fn: () => void) => ((handlers[type] = fn), () => undefined), setMode: () => undefined, explain: () => null };
  genclassPageScript({ base: `${pathToFileURL(join(dir, "runtime")).href}/`, model: false, agentUrl: "http://127.0.0.1:9", binding: "__bind" }, () => {
    define("GenClass", { runtime: rt });
  });
  for (let i = 0; i < 50 && session.snapshot().agent !== null; i++) await tick();
  expect(session.snapshot().agent).toBeNull();
  return {
    session,
    items,
    record(step) {
      rec.steps.push(step);
      if (rec.steps.length > RECORD_KEEPS) rec.steps.splice(0, rec.steps.length - RECORD_KEEPS);
    },
    async event() {
      handlers.event?.();
      await tick();
    },
    api: () => g.__GENCLASS_PLAYWRIGHT__ as { collect(): unknown; open(): { id: string } | null },
  };
}

describe("page: handing the record's steps over", () => {
  it("each step once and in order, through more steps than the record keeps, with the page's own time on every batch", async () => {
    const p = await pageLoad();
    const happened: string[] = [];
    let t = 0;
    for (let i = 1; i <= 300; i++) {
      p.record({ k: "act", t: t++, kind: "click", target: `button "B${i}"` });
      p.record({ k: "send", t: t++, key: `GET /api/q${i}#1` });
      p.record({ k: "recv", t: t++, key: `GET /api/q${i}#1` });
      // a store write is in the record too, and is no step
      p.record({ k: "write", t: t++, store: "s", paths: ["a"] });
      happened.push(`a:click button "B${i}"`, `s:GET /api/q${i}`, `r:GET /api/q${i}`);
      await p.event();
    }
    const streams = p.session.snapshot().streams;
    expect(streams).toHaveLength(1);
    expect(streams[0].gap).toBeUndefined();
    expect(sequenceOf(streams).events.map((e) => `${e.kind}:${e.label}`)).toEqual(happened);
    const batches = p.items.filter((x) => x.t === "steps");
    expect(batches).toHaveLength(300);
    // the page says what its clock reads with every batch: on one machine that is this side's clock
    for (const b of batches) expect(Math.abs(Date.now() - (b.now as number))).toBeLessThan(60_000);
    expect(batches.some((b) => "gap" in b)).toBe(false);
  });

  it("the page load's name is the time it began and a token of its own, the same in everything it hands over", async () => {
    const p = await pageLoad();
    p.record({ k: "send", t: 1, key: "GET /api/a#1" });
    await p.event();
    const id = p.session.snapshot().streams[0].id;
    // two frames or pages can begin in the same millisecond: the time alone would file their steps as one page load's
    expect(id).toMatch(/^\d+(\.\d+)?\.[0-9a-z]{2,}$/);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(p.api().open()?.id).toBe(id);
    expect(p.items.filter((x) => x.t === "body").map((x) => x.id)).toEqual([id]);
    const other = await pageLoad();
    other.record({ k: "send", t: 1, key: "GET /api/a#1" });
    await other.event();
    expect(other.session.snapshot().streams[0].id).not.toBe(id);
  });

  it("more recorded between two hand-overs than the record keeps: the page says steps were lost, and the test's steps stop before the loss", async () => {
    const p = await pageLoad();
    let t = 0;
    p.record({ k: "act", t: t++, kind: "click", target: 'button "Load"' });
    p.record({ k: "send", t: t++, key: "GET /api/rows#1" });
    await p.event();
    // one task: the response lands, its handler makes 700 store writes, and a request leaves; one hand-over after it
    p.record({ k: "recv", t: t++, key: "GET /api/rows#1" });
    for (let i = 0; i < 700; i++) p.record({ k: "write", t: t++, store: "rows", paths: [`row${i}`] });
    p.record({ k: "send", t: t++, key: "GET /api/next#1" });
    await p.event();
    p.record({ k: "recv", t: t++, key: "GET /api/next#1" });
    await p.event();
    const batches = p.items.filter((x) => x.t === "steps");
    expect(batches.map((b) => [b.from, (b.steps as unknown[]).length, b.gap === true])).toEqual([
      [0, 2, false],
      [2, 1, true],
      [3, 1, false],
    ]);
    const stream = p.session.snapshot().streams[0];
    expect(stream.gap).toBe(2);
    // the response that was lost is not made up, and what came after the loss is not listed as if nothing were missing
    const seq = sequenceOf([stream]);
    expect(seq.events.map((e) => `${e.kind}:${e.label}`)).toEqual(['a:click button "Load"', "s:GET /api/rows"]);
    // the two steps after the loss, and one for the loss itself
    expect(seq.lost).toBe(3);
    expect(encodeSteps(seq, { max: 300, bytes: 5000, more: seq.lost })?.cut).toBe(3);
  });
});
