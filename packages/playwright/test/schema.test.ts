// Validation of "genclass-races/1" files: what is accepted, what is rejected and the exact messages a reader sees in
// the report's "Files skipped" section.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ERRORS, parseRaces, validateRaces } from "../src/schema.js";
import { RACES_LIMITS, RACES_SCHEMA } from "../src/types.js";
import { racesDir } from "./helpers.js";

const okSig = { sig: "request|duplicate|POST /api/orders", trigger: "request", diagnosis: "duplicate", op: "POST /api/orders", confidence: 0.9, evidence: "e", seeds: [1] };
const ok = { schema: RACES_SCHEMA, test: "t", seed: 1, signatures: [okSig], shadow: "guard" };

function errors(v: unknown): string[] {
  const r = validateRaces(v);
  return r.ok ? [] : r.errors;
}

describe("schema: accepted files", () => {
  it("accepts every fixture file", () => {
    for (const n of ["checkout-1.json", "checkout-2.json", "search-1.json", "search-2.json"]) {
      const r = parseRaces(readFileSync(join(racesDir, n), "utf8"));
      expect(r.ok, n).toBe(true);
    }
  });

  it("returns a normalised copy: known fields only, strings trimmed, seeds de-duplicated and sorted", () => {
    const r = validateRaces({ ...ok, test: "  t  ", extra: 1, signatures: [{ ...okSig, op: " POST /api/orders ", seeds: [3, 1, 3], more: true }] });
    expect(r).toEqual({ ok: true, file: { schema: RACES_SCHEMA, test: "t", seed: 1, signatures: [{ ...okSig, seeds: [1, 3] }], shadow: "guard" } });
  });

  it("shadow is carried as is and may be absent; the optional fields are kept when valid", () => {
    const { shadow: _drop, ...noShadow } = ok;
    void _drop;
    expect(validateRaces(noShadow)).toEqual({ ok: true, file: { schema: RACES_SCHEMA, test: "t", seed: 1, signatures: [okSig] } });
    const r = validateRaces({ ...ok, shadow: { decisions: 3 }, mode: "observe", model: { state: "ready", version: "2.0.0-rc4t", device: "wasm", other: 1 }, chaos: { latencyMs: [0, 600], reorder: true, failRate: 0.1, routes: ["/api/"], x: 1 } });
    expect(r.ok && r.file).toEqual({
      schema: RACES_SCHEMA,
      test: "t",
      seed: 1,
      signatures: [okSig],
      shadow: { decisions: 3 },
      mode: "observe",
      model: { state: "ready", version: "2.0.0-rc4t", device: "wasm" },
      chaos: { latencyMs: [0, 600], reorder: true, failRate: 0.1, routes: ["/api/"] },
    });
    expect(validateRaces({ ...ok, model: null, chaos: null })).toMatchObject({ ok: true, file: { model: null, chaos: null } });
  });

  it("an empty signature list and an empty seeds list are valid", () => {
    expect(validateRaces({ ...ok, signatures: [] }).ok).toBe(true);
    expect(validateRaces({ ...ok, signatures: [{ ...okSig, seeds: [] }] }).ok).toBe(true);
  });

  it("ignores a byte-order mark", () => {
    expect(parseRaces(`﻿${JSON.stringify(ok)}`).ok).toBe(true);
  });
});

describe("schema: rejected files and their messages", () => {
  it("another schema version is rejected on that field alone", () => {
    expect(errors({ schema: "genclass-races/2", whatever: true })).toEqual(['schema: expected "genclass-races/1", got "genclass-races/2"']);
    expect(errors({ ...ok, schema: 1 })).toEqual(['schema: expected "genclass-races/1", got 1']);
  });

  it("a missing schema field says so, with a hint when the file names it `format`", () => {
    expect(errors({ test: "t" })).toEqual(['schema: missing, expected "genclass-races/1"']);
    expect(errors({ format: RACES_SCHEMA, test: "t", seed: 1, signatures: ["request|duplicate|POST /a"] })).toEqual([
      'schema: missing, expected "genclass-races/1" (the file has "format": "genclass-races/1"; the field is named "schema")',
    ]);
  });

  it("not an object, not JSON", () => {
    expect(errors([ok])).toEqual(["expected a JSON object, got an array"]);
    expect(errors(null)).toEqual(["expected a JSON object, got null"]);
    expect(errors("x")).toEqual(['expected a JSON object, got "x"']);
    const r = parseRaces("{");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.length).toBe(1);
    expect(!r.ok && r.errors[0]).toMatch(/^not valid JSON \(.+\)$/);
  });

  it("names every bad field, in order", () => {
    expect(
      errors({
        schema: RACES_SCHEMA,
        test: "",
        seed: 1.5,
        signatures: [{ sig: "request|duplicate|POST /a", trigger: "request", diagnosis: "duplicate", op: "POST /a", confidence: 1.4, evidence: "e", seeds: "1" }, "request|duplicate|POST /a"],
      }),
    ).toEqual([
      'test: expected a non-empty string, got ""',
      "seed: expected an integer, got 1.5",
      "signatures[0].confidence: expected a number from 0 to 1, got 1.4",
      'signatures[0].seeds: expected an array of integers, got "1"',
      'signatures[1]: expected an object, got "request|duplicate|POST /a"',
    ]);
    expect(errors({ ...ok, signatures: [{ seeds: [1, "2"] }] })).toEqual([
      "signatures[0].sig: expected a non-empty string, got nothing",
      "signatures[0].trigger: expected a non-empty string, got nothing",
      "signatures[0].diagnosis: expected a non-empty string, got nothing",
      "signatures[0].op: expected a string, got nothing",
      "signatures[0].confidence: expected a number from 0 to 1, got nothing",
      "signatures[0].evidence: expected a string, got nothing",
      'signatures[0].seeds[1]: expected an integer, got "2"',
    ]);
    expect(errors({ ...ok, signatures: { a: 1 } })).toEqual(["signatures: expected an array, got an object"]);
    expect(errors({ ...ok, seed: "1" })).toEqual(['seed: expected an integer, got "1"']);
    expect(errors({ ...ok, signatures: [{ ...okSig, confidence: Number.NaN }] })).toEqual(["signatures[0].confidence: expected a number from 0 to 1, got NaN"]);
  });

  it("location: a path inside the repository and a line are kept; anything else rejects the file", () => {
    const r = validateRaces({ ...ok, location: { file: "tests/e2e/checkout.spec.ts", line: 12, column: 5 } });
    expect(r.ok && r.file.location).toEqual({ file: "tests/e2e/checkout.spec.ts", line: 12 });
    expect(validateRaces(ok).ok && "location" in (validateRaces(ok) as { file: object }).file).toBe(false);
    for (const file of ["/abs/a.spec.ts", "../a.spec.ts", "a/../../b.ts", "a//b.ts", "./a.ts", "C:/a.ts", "a\\b.ts", "", 3, "a\u0000b"]) {
      expect(errors({ ...ok, location: { file, line: 1 } }), String(file)).toEqual([expect.stringMatching(/^location\.file: expected a relative path with "\/" separators, got /)]);
    }
    expect(errors({ ...ok, location: { file: "a.ts", line: 0 } })).toEqual(["location.line: expected a line number from 1, got 0"]);
    expect(errors({ ...ok, location: { file: "a.ts", line: 1.5 } })).toEqual(["location.line: expected a line number from 1, got 1.5"]);
    expect(errors({ ...ok, location: "a.ts:1" })).toEqual(['location: expected an object when present, got "a.ts:1"']);
    expect(errors({ ...ok, location: { file: `${"a/".repeat(250)}x.ts`, line: 1 } })).toHaveLength(1);
  });

  it("checks the optional fields when present", () => {
    expect(errors({ ...ok, mode: 3, model: { state: 1 }, chaos: "fast" })).toEqual([
      "mode: expected a string when present, got 3",
      "model.state: expected a string when present, got 1",
      'chaos: expected an object or null when present, got "fast"',
    ]);
    expect(errors({ ...ok, model: [] })).toEqual(["model: expected an object or null when present, got an array"]);
  });

  it(`stops listing after ${MAX_ERRORS} messages`, () => {
    const e = errors({ ...ok, signatures: Array.from({ length: 12 }, () => 0) });
    expect(e).toHaveLength(MAX_ERRORS + 1);
    expect(e[0]).toBe("signatures[0]: expected an object, got 0");
    expect(e[MAX_ERRORS]).toBe("and 4 more errors");
  });

  it("cuts long values in messages", () => {
    expect(errors({ ...ok, schema: "x".repeat(60) })).toEqual([`schema: expected "genclass-races/1", got "${"x".repeat(39)}…"`]);
  });
});

describe("schema: the format's limits (RACES_LIMITS)", () => {
  const many = (n: number) => ({ ...ok, signatures: Array.from({ length: n }, (_, i) => ({ ...okSig, sig: `request|duplicate|POST /api/orders/${i}`, op: `POST /api/orders/${i}` })) });
  const long = (n: number) => "x".repeat(n);

  it("a file holds at most 200 signatures: one more rejects it on the count alone", () => {
    expect(RACES_LIMITS).toEqual({ signatures: 200, seeds: 64, test: 1000, evidence: 2000, text: 600, bytes: 65536 });
    expect(validateRaces(many(200)).ok).toBe(true);
    expect(errors(many(201))).toEqual(["signatures: expected at most 200 signatures, got 201"]);
    // over the limit the signatures are not looked at one by one: 100,000 that are no signatures give one message,
    // not the seven bad fields of each
    const junk = { ...ok, signatures: Array.from({ length: 100_000 }, () => ({})) };
    expect(errors(junk)).toEqual(["signatures: expected at most 200 signatures, got 100000"]);
    expect(parseRaces(JSON.stringify(junk))).toEqual({ ok: false, errors: ["signatures: expected at most 200 signatures, got 100000"] });
  });

  it("a signature lists at most 64 seeds: one more rejects the file on the count alone", () => {
    const seeded = (n: number, of: (i: number) => unknown = (i) => i) => ({ ...ok, signatures: [{ ...okSig, seeds: Array.from({ length: n }, (_, i) => of(i)) }] });
    const at = validateRaces(seeded(64));
    expect(at.ok && at.file.signatures[0]!.seeds).toHaveLength(64);
    expect(errors(seeded(65))).toEqual(["signatures[0].seeds: expected at most 64 seeds, got 65"]);
    // over the limit the seeds are not looked at one by one: 100,000 that are no integers give one message, not
    // one for each, and the same number repeated is over it too (the count is of what the file lists)
    expect(errors(seeded(100_000, () => "x"))).toEqual(["signatures[0].seeds: expected at most 64 seeds, got 100000"]);
    expect(errors(seeded(65, () => 7))).toEqual(["signatures[0].seeds: expected at most 64 seeds, got 65"]);
    expect(parseRaces(JSON.stringify(seeded(960)))).toEqual({ ok: false, errors: ["signatures[0].seeds: expected at most 64 seeds, got 960"] });
    // within it a bad seed is still named
    expect(errors(seeded(3, (i) => (i === 1 ? 1.5 : i)))).toEqual(["signatures[0].seeds[1]: expected an integer, got 1.5"]);
  });

  it("a string longer than its limit rejects the file, like any other bad field", () => {
    const fixture = { model: "skip", agent: long(600), chaosApplied: null, serviceWorker: false, modeOverridden: long(600) };
    const atLimit = { ...ok, test: long(1000), signatures: [{ ...okSig, sig: long(600), trigger: long(600), diagnosis: long(600), op: long(600), evidence: long(2000) }], mode: long(600), model: { state: long(600), name: long(600), version: long(600), device: long(600) }, fixture };
    expect(validateRaces(atLimit).ok).toBe(true);
    expect(errors({ ...ok, test: long(1001) })).toEqual(["test: expected at most 1000 characters, got 1001"]);
    expect(errors({ ...ok, signatures: [{ ...okSig, sig: long(601), trigger: long(601), diagnosis: long(601), op: long(601), evidence: long(2001) }] })).toEqual([
      "signatures[0].sig: expected at most 600 characters, got 601",
      "signatures[0].trigger: expected at most 600 characters, got 601",
      "signatures[0].diagnosis: expected at most 600 characters, got 601",
      "signatures[0].op: expected at most 600 characters, got 601",
      "signatures[0].evidence: expected at most 2000 characters, got 2001",
    ]);
    expect(errors({ ...ok, mode: long(601), model: { state: long(601), device: long(700) }, fixture: { ...fixture, agent: long(601), modeOverridden: long(601) } })).toEqual([
      "mode: expected at most 600 characters, got 601",
      "model.state: expected at most 600 characters, got 601",
      "model.device: expected at most 600 characters, got 700",
      "fixture.agent: expected at most 600 characters, got 601",
      "fixture.modeOverridden: expected at most 600 characters, got 601",
    ]);
    // a wrong type is still the type's message, once
    expect(errors({ ...ok, test: 5 })).toEqual(["test: expected a non-empty string, got 5"]);
  });

  it("dropped: a whole number, kept when present", () => {
    const r = validateRaces({ ...ok, dropped: 4 });
    expect(r.ok && r.file.dropped).toBe(4);
    expect(validateRaces(ok).ok && "dropped" in (validateRaces(ok) as { file: object }).file).toBe(false);
    expect(errors({ ...ok, dropped: -1 })).toEqual(["dropped: expected a whole number when present, got -1"]);
    expect(errors({ ...ok, dropped: 1.5 })).toEqual(["dropped: expected a whole number when present, got 1.5"]);
    expect(errors({ ...ok, dropped: "3" })).toEqual(['dropped: expected a whole number when present, got "3"']);
  });
});
