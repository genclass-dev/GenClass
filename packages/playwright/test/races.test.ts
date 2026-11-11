// The race-file builder (src/races.ts): what the fixture collected -> a "genclass-races/1" file the reporter's own
// validator accepts, with the signatures the summariser groups on.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRacesFile, opOf, racesFileName, racesFileText, signaturesOf, witnessLine, writeRacesFile } from "../src/races.js";
import { parseRaces, validateRaces } from "../src/schema.js";
import { buildSummary } from "../src/summarize.js";
import { RACES_LIMITS } from "../src/types.js";

const detection = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  kind: "detection",
  id: "s1",
  ts: 1,
  sessionId: "x",
  tags: {},
  mode: "observe",
  sampled: true,
  trigger: "delivery",
  diagnosis: "stale",
  p: 0.91,
  detection: "likely",
  evidence: { message: "The response of GET /api/search (#21) arrives after a newer GET /api/search (#23) was answered.", subject: "response to GET /api/search?q=… (#21)" },
  ...over,
});
const overwrote = { kind: "overwrote-newer", t: 1200, subject: "search.results", by: "GET /api/search#1", over: "GET /api/search#4", overKind: "request", gapMs: 260, change: "2 items → 2 items" };
const identical = { kind: "identical-in-flight", t: 900, subject: "POST /api/orders", by: "POST /api/orders#2", over: "POST /api/orders#1", overKind: "request", gapMs: 30 };

describe("races: operations and evidence lines", () => {
  it("opOf keeps the method and path, drops the query, the id and the suffix", () => {
    expect(opOf("response to GET /api/search?q=… (#21)")).toBe("GET /api/search");
    expect(opOf("GET /api/search#3~retry2")).toBe("GET /api/search");
    expect(opOf("POST /api/orders (network error)")).toBe("POST /api/orders");
    expect(opOf("write to cart.items")).toBe("write to cart.items");
    expect(opOf(undefined)).toBe("");
    expect(opOf(`x${"y".repeat(200)}`)).toHaveLength(120);
    // per-run op ids come out, so one detection is one signature across seeds
    expect(opOf("relation total == sum(items) (#12)")).toBe("relation total == sum(items)");
    expect(opOf("write to cart.items (#7)")).toBe(opOf("write to cart.items (#31)"));
  });

  it("opOf writes the ids in a path as :id, so a record a test created is the same operation in every run", () => {
    expect(opOf("GET /api/items/7#1")).toBe("GET /api/items/:id");
    expect(opOf("GET /api/items/7#1")).toBe(opOf("response to GET /api/items/1042?expand=1 (#9)"));
    expect(opOf("PUT /api/notes/3f2b8c1e-9d4a-4c6b-8e1f-0a2b3c4d5e6f/title#2")).toBe("PUT /api/notes/:id/title");
    expect(opOf("DELETE /api/docs/V1StGXR8_Z5jdHi6B-myT#1")).toBe("DELETE /api/docs/:id");
    // a host in front of the path (a request to another origin) and words that are not ids stay as they are
    expect(opOf("POST localhost:8001/api/documents/42/notes/#1")).toBe("POST localhost:8001/api/documents/:id/notes/");
    expect(opOf("GET /api/v2/items/lamp#1")).toBe("GET /api/v2/items/lamp");
  });

  it("one race on two records is one signature, and its evidence keeps the requests as they were", () => {
    const a = { ...overwrote, by: "GET /api/items/7#1", over: "GET /api/items/8#1" };
    const b = { ...overwrote, by: "GET /api/items/1041#1", over: "GET /api/items/1042#1" };
    const first = signaturesOf([], [a], 1);
    const second = signaturesOf([], [b], 2);
    expect(first.map((s) => s.sig)).toEqual(["witness|overwrote-newer|GET /api/items/:id"]);
    expect(second.map((s) => s.sig)).toEqual(first.map((s) => s.sig));
    expect(first[0]!.evidence).toContain("GET /api/items/7#1");
    expect(signaturesOf([], [a, b], 1)).toHaveLength(1);
  });

  it("witnessLine says what happened, in the agent's request keys", () => {
    expect(witnessLine(overwrote)).toBe("The response of GET /api/search#1 wrote search.results over what newer GET /api/search#4, started 0.26s after GET /api/search#1, had written (2 items → 2 items).");
    expect(witnessLine({ ...overwrote, overKind: "user", over: 'type textbox "Title"', change: undefined })).toBe('The response of GET /api/search#1 wrote search.results over what the user (type textbox "Title") had written 0.26s after GET /api/search#1 started.');
    expect(witnessLine(identical)).toBe("POST /api/orders#2 was sent while the identical POST /api/orders#1 was still in flight (0.03s earlier), from a separate user action.");
    expect(witnessLine({ kind: "other", by: "A", over: "B" })).toBe("other:  by A over B");
  });
});

describe("races: signatures and the file", () => {
  it("detections become signatures with the model's confidence; witnesses get trigger witness and confidence 1", () => {
    const sigs = signaturesOf([detection()], [overwrote, identical], 3);
    expect(sigs.map((s) => s.sig)).toEqual(["delivery|stale|GET /api/search", "witness|identical-in-flight|POST /api/orders", "witness|overwrote-newer|GET /api/search"]);
    expect(sigs[0]).toMatchObject({ trigger: "delivery", diagnosis: "stale", op: "GET /api/search", confidence: 0.91, seeds: [3] });
    expect(sigs[0].evidence).toContain("arrives after a newer");
    expect(sigs[2]).toMatchObject({ trigger: "witness", diagnosis: "overwrote-newer", op: "GET /api/search", confidence: 1, seeds: [3] });
  });

  it("drops expected diagnoses, records of other kinds and junk; merges repeats keeping the most confident evidence", () => {
    const sigs = signaturesOf(
      [detection({ diagnosis: "expected" }), detection({ kind: "intervention" }), null, 5, detection({ p: 0.5, evidence: { message: "low", subject: "GET /api/search" } }), detection({ p: 0.95, evidence: { message: "high", subject: "GET /api/search" } }), detection({ p: 2 })],
      [overwrote, overwrote, {}, "x"],
      1,
    );
    expect(sigs).toHaveLength(2);
    expect(sigs[0]).toMatchObject({ sig: "delivery|stale|GET /api/search", confidence: 1, evidence: "The response of GET /api/search (#21) arrives after a newer GET /api/search (#23) was answered." });
    expect(sigs[1].sig).toBe("witness|overwrote-newer|GET /api/search");
  });

  it("buildRacesFile validates against the reporter's schema and carries mode, model, chaos and the seed", () => {
    const file = buildRacesFile({
      test: "search.spec.ts > search > results of the last query",
      seed: 2,
      mode: "observe",
      model: { state: "off", name: "none" },
      chaos: { latencyMs: [0, 600], reorder: true, routes: ["same-origin /api* or JSON responses"] },
      records: [detection()],
      witnesses: [overwrote],
    });
    const r = validateRaces(file);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file).toEqual(file);
    expect(file.model).toEqual({ state: "off", name: "none" });
    expect(file.chaos).toEqual({ latencyMs: [0, 600], reorder: true, routes: ["same-origin /api* or JSON responses"] });
    const s = buildSummary([{ name: "a.json", content: file }]);
    expect(s.tests[0].signatures.map((x) => [x.category, x.sig])).toEqual([
      ["stale", "delivery|stale|GET /api/search"],
      ["witness", "witness|overwrote-newer|GET /api/search"],
    ]);
  });

  it("carries the fixture's record and validates it; a bad record is reported, not half-read", () => {
    const fixture = { model: "skip" as const, agent: null, chaosApplied: 3, serviceWorker: false, modeOverridden: "heal" };
    const file = buildRacesFile({ test: "t", seed: 1, mode: "observe", model: { state: "off" }, chaos: null, records: [], witnesses: [], fixture });
    const r = validateRaces(file);
    expect(r.ok && r.file.fixture).toEqual(fixture);
    const bad = validateRaces({ ...file, fixture: { model: "maybe", agent: 1, chaosApplied: -1, serviceWorker: "no" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toEqual([
      'fixture.model: expected "skip" or "load", got "maybe"',
      "fixture.agent: expected a string or null, got 1",
      "fixture.chaosApplied: expected a whole number or null, got -1",
      'fixture.serviceWorker: expected true or false, got "no"',
    ]);
  });

  it("carries where the test is declared when the fixture could tell, and nothing otherwise", () => {
    const base = { test: "t", seed: 1, mode: "observe", model: { state: "off" }, chaos: null, records: [], witnesses: [] };
    const file = buildRacesFile({ ...base, location: { file: "tests/a.spec.ts", line: 7 } });
    expect(file.location).toEqual({ file: "tests/a.spec.ts", line: 7 });
    const r = validateRaces(file);
    expect(r.ok && r.file.location).toEqual({ file: "tests/a.spec.ts", line: 7 });
    expect("location" in buildRacesFile({ ...base, location: undefined })).toBe(false);
  });

  it("a page where GenClass never started: model null, no mode, no signatures (still a valid file)", () => {
    const file = buildRacesFile({ test: "t", seed: 1, mode: null, model: null, chaos: null, records: [], witnesses: [] });
    expect(file).toEqual({ schema: "genclass-races/1", test: "t", seed: 1, signatures: [], model: null, chaos: null });
    expect(validateRaces(file).ok).toBe(true);
    expect(buildSummary([{ name: "a.json", content: file }]).tests[0].modelNotReady).toEqual({ files: 1, states: ["not started"] });
  });

  it("racesFileName: a slug of the title, the test id and the seed", () => {
    expect(racesFileName("[chromium] checkout.spec.ts > checkout > places one order", "a1b2-c3d4", 2)).toBe("chromium-checkout-spec-ts-checkout-places-one-order-a1b2-c3d4-s2.json");
    expect(racesFileName("x".repeat(200), "id", 1)).toBe(`${"x".repeat(80)}-id-s1.json`);
    expect(racesFileName("", "../../etc", 1)).toBe("test-etc-s1.json");
    // a retry gets a file of its own, so the failing first attempt is kept
    expect(racesFileName("t", "id", 2, 1)).toBe("t-id-s2-r1.json");
    expect(racesFileName("t", "id", 2, 0)).toBe("t-id-s2.json");
  });
});

describe("races: a file is written within the format's limits (RACES_LIMITS), so no reader refuses what the fixture wrote", () => {
  const base = { test: "t", seed: 1, mode: "observe", model: { state: "ready" }, chaos: null };
  // n distinct operations (routes named r0, r1, ...: a number alone would be an id, and every one the same operation)
  const many = (n: number, message: (i: number) => string = (i) => `m${i}`) =>
    Array.from({ length: n }, (_, i) => detection({ p: 0.5 + (i % 50) / 100, evidence: { message: message(i), subject: `response to GET /api/items/r${i} (#${i})` } }));
  const bytes = (file: Parameters<typeof racesFileText>[0]) => Buffer.byteLength(racesFileText(file), "utf8");

  it("a test with more signatures than a file holds: the most confident stay, and dropped says how many were left out", () => {
    const records = many(230);
    const all = signaturesOf(records, [overwrote], 1);
    expect(all).toHaveLength(231);
    const file = buildRacesFile({ ...base, records, witnesses: [overwrote] });
    expect(file.signatures).toHaveLength(RACES_LIMITS.signatures);
    expect(file.dropped).toBe(31);
    // the reader's validator takes it, as it would not take all 231
    expect(validateRaces(file)).toEqual({ ok: true, file });
    expect(validateRaces({ ...file, signatures: all }).ok).toBe(false);
    // the witness, a fact, stays; every signature left out is no more confident than any that stayed
    expect(file.signatures.some((s) => s.sig === "witness|overwrote-newer|GET /api/search")).toBe(true);
    const stayed = new Set(file.signatures.map((s) => s.sig));
    const out = all.filter((s) => !stayed.has(s.sig));
    expect(out).toHaveLength(31);
    expect(Math.max(...out.map((s) => s.confidence))).toBeLessThanOrEqual(Math.min(...file.signatures.map((s) => s.confidence)));
    // still sorted by sig, and the same input gives the same bytes
    expect(file.signatures.map((s) => s.sig)).toEqual([...stayed].sort());
    expect(racesFileText(buildRacesFile({ ...base, records: [...records].reverse(), witnesses: [overwrote] }))).toBe(racesFileText(file));
    // the report says the list is not complete
    expect(buildSummary([{ name: "a.json", content: file }]).tests[0].dropped).toEqual({ files: 1, signatures: 31 });
    // at the limit nothing is left out and nothing is said
    const full = buildRacesFile({ ...base, records: many(200), witnesses: [] });
    expect(full.signatures).toHaveLength(200);
    expect("dropped" in full).toBe(false);
  });

  it("a file is kept within 64 KB by leaving out the least confident signatures", () => {
    // 150 signatures with evidence lines of 1500 characters: about 250 KB if all were written
    const records = many(150, (i) => `${i} ${"e".repeat(1500)}`);
    const file = buildRacesFile({ ...base, records, witnesses: [] });
    expect(bytes(file)).toBeLessThanOrEqual(RACES_LIMITS.bytes);
    expect(file.signatures.length).toBeGreaterThan(30);
    expect(file.signatures.length).toBeLessThan(45);
    expect(file.dropped).toBe(150 - file.signatures.length);
    expect(validateRaces(file)).toEqual({ ok: true, file });
    // as many as fit: one more of the same size would not
    expect(bytes(file) + bytes(file) / file.signatures.length).toBeGreaterThan(RACES_LIMITS.bytes);
    const all = signaturesOf(records, [], 1);
    const stayed = new Set(file.signatures.map((s) => s.sig));
    expect(Math.max(...all.filter((s) => !stayed.has(s.sig)).map((s) => s.confidence))).toBeLessThanOrEqual(Math.min(...file.signatures.map((s) => s.confidence)));
    // characters that take several bytes count as bytes
    const wide = buildRacesFile({ ...base, records: many(150, (i) => `${i} ${"日".repeat(1500)}`), witnesses: [] });
    expect(bytes(wide)).toBeLessThanOrEqual(RACES_LIMITS.bytes);
    expect(wide.signatures.length).toBeLessThan(file.signatures.length);
    // a small file is as before
    expect("dropped" in buildRacesFile({ ...base, records: many(5), witnesses: [overwrote] })).toBe(false);
  });

  it("strings are cut to their limits, and a location the validator would refuse is left out", () => {
    const long = (n: number) => "x".repeat(n);
    const file = buildRacesFile({
      test: `spec.ts > ${long(1500)}`,
      seed: 1,
      mode: long(700),
      model: { state: long(700), name: "none" },
      chaos: null,
      records: [detection({ trigger: long(300), diagnosis: long(300), evidence: { message: long(5000), subject: `GET /${long(900)} (#3)` } }), detection({ evidence: { message: "short", subject: long(900) } })],
      witnesses: [{ ...overwrote, kind: long(300), by: `POST /${long(900)}#1`, change: long(5000) }],
      fixture: { model: "skip", agent: long(700), chaosApplied: null, serviceWorker: false, modeOverridden: long(700) },
      location: { file: "tests\\windows\\a.spec.ts", line: 3 },
    });
    expect(validateRaces(file)).toEqual({ ok: true, file });
    expect(file.test).toHaveLength(RACES_LIMITS.test);
    expect(file.test.endsWith("x…")).toBe(true);
    expect(file.mode).toHaveLength(RACES_LIMITS.text);
    expect(file.model).toEqual({ state: `${long(599)}…`, name: "none" });
    expect(file.fixture).toMatchObject({ agent: `${long(599)}…`, modeOverridden: `${long(599)}…` });
    expect("location" in file).toBe(false);
    for (const s of file.signatures) {
      expect(s.sig.length).toBeLessThanOrEqual(RACES_LIMITS.text);
      expect(s.sig).toBe(`${s.trigger}|${s.diagnosis}|${s.op}`);
      expect(s.evidence.length).toBeLessThanOrEqual(RACES_LIMITS.evidence);
    }
    const cut = file.signatures.find((s) => s.trigger !== "delivery" && s.trigger !== "witness")!;
    expect([cut.trigger.length, cut.diagnosis.length, cut.op.length, cut.evidence.length]).toEqual([100, 100, 300, 2000]);
    expect(cut.evidence.endsWith("x…")).toBe(true);
    expect(opOf(`GET /${long(900)} (#3)`)).toBe(`GET /${long(294)}…`);
    // the same long path is cut the same way in every seed, so it is still one signature
    expect(opOf(`GET /${long(900)} (#3)`)).toBe(opOf(`response to GET /${long(900)}?q=… (#77)`));
    // a cut never ends inside a surrogate pair
    const pair = buildRacesFile({ ...base, test: `${long(998)}😀 more`, records: [], witnesses: [] });
    expect(pair.test).toBe(`${long(998)}…`);
    // other bad locations: too long, absolute, above the repository, no line
    for (const location of [{ file: `${"a/".repeat(250)}x.ts`, line: 1 }, { file: "/abs/a.spec.ts", line: 1 }, { file: "../a.spec.ts", line: 1 }, { file: "tests/a.spec.ts", line: 0 }]) {
      expect("location" in buildRacesFile({ ...base, records: [], witnesses: [], location }), location.file).toBe(false);
    }
  });
});

describe("races: writing", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "genclass-races-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a file the reporter reads, creating the directory", () => {
    const file = buildRacesFile({ test: "t", seed: 4, mode: "observe", model: { state: "off" }, chaos: null, records: [], witnesses: [identical] });
    const path = writeRacesFile(join(dir, "test-results", "genclass"), racesFileName(file.test, "id", 4), file);
    expect(path).toBe(join(dir, "test-results", "genclass", "t-id-s4.json"));
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const r = parseRaces(text);
    expect(r.ok && r.file).toEqual(file);
  });
});
