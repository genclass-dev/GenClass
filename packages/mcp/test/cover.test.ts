// Cover rows for the systematic explore plan (AGENT.md section 5): sequence covering arrays over the responses that
// overlap in the baselines, and the request timing log they are read from (net.ts).
import { describe, expect, it } from "vitest";
import { MAX_PERMUTED, buildCover, sequenceCover } from "../src/cover.js";
import { inversionsOf, overlapOf, schedulable, startOrderOf } from "../src/net.js";
import type { NetEntry } from "../src/types.js";

/** Every ordered triple (x, y, z) of 0..n-1 that no row holds in that order (brute force). */
function missingTriples(n: number, rows: number[][]): number {
  const pos = rows.map((r) => {
    const p = new Array<number>(n);
    r.forEach((e, i) => (p[e] = i));
    return p;
  });
  let missing = 0;
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++)
      for (let z = 0; z < n; z++) {
        if (x === y || y === z || x === z) continue;
        if (!pos.some((p) => p[x] < p[y] && p[y] < p[z])) missing++;
      }
  return missing;
}

/** The rows sequenceCover needs for every ordering of every triple, n = 3..16 (deterministic, so pinned). */
const ROWS: Record<number, number> = { 3: 6, 4: 10, 5: 12, 6: 12, 7: 14, 8: 14, 9: 14, 10: 16, 11: 16, 12: 16, 13: 18, 14: 18, 15: 18, 16: 18 };
const TABLE = Object.entries(ROWS)
  .map(([n, r]) => `${n}:${r}`)
  .join(" ");

describe("cover: sequenceCover (AGENT.md section 5, plan systematic)", () => {
  it(`every ordering of every triple appears, n = 3..16 (rows per n ${TABLE})`, () => {
    const counts: Record<number, number> = {};
    for (let n = 3; n <= 16; n++) {
      const c = sequenceCover(n, 1000);
      expect(c.complete, `n=${n}`).toBe(true);
      expect(c.triples).toBe((n * (n - 1) * (n - 2)) / 6);
      expect(c.covered).toBe(c.triples);
      expect(missingTriples(n, c.rows), `n=${n}`).toBe(0);
      // each row a permutation of 0..n-1, in (pi, reverse(pi)) pairs after the identity and its reverse
      for (const r of c.rows) expect([...r].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
      expect(c.rows.length % 2).toBe(0);
      for (let i = 0; i < c.rows.length; i += 2) expect(c.rows[i + 1]).toEqual([...c.rows[i]].reverse());
      counts[n] = c.rows.length;
    }
    expect(counts).toEqual(ROWS);
  });

  it("rows[0] is request order and rows[1] its reverse; the same call gives the same rows", () => {
    const c = sequenceCover(7, 1000);
    expect(c.rows[0]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(c.rows[1]).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(sequenceCover(7, 1000)).toEqual(c);
    // the insertion greedy for 3: the middle 2, then the middle 0
    expect(sequenceCover(3, 1000).rows).toEqual([
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
      [0, 2, 1],
      [1, 0, 2],
      [2, 0, 1],
    ]);
  });

  it("stops at maxRows (never below the identity and its reverse), and says it is incomplete", () => {
    const c = sequenceCover(10, 5);
    expect(c.rows).toHaveLength(5);
    expect(c.complete).toBe(false);
    expect(c.covered).toBeLessThan(c.triples);
    expect(sequenceCover(10, 0).rows).toHaveLength(2);
    expect(sequenceCover(2, 10)).toEqual({ rows: [[0, 1], [1, 0]], complete: true, triples: 0, covered: 0 });
    expect(sequenceCover(0, 10).rows).toEqual([[], []]);
  });
});

/** A timing log: key → entry. */
function log(...entries: NetEntry[]): Record<string, NetEntry> {
  return Object.fromEntries(entries.map((e) => [e.key, e]));
}
const e = (key: string, n: number, s: number, r?: number, d?: number, extra: Partial<NetEntry> = {}): NetEntry => ({ key, n, s, ...(r !== undefined ? { r } : {}), ...(d !== undefined ? { d } : {}), ...extra });

describe("cover: the timing log (net.ts, the overlap shared with the page)", () => {
  it("a overlaps b when b was sent before a was ready, strictly; passed, retried and undelivered requests are left out", () => {
    const net = log(
      e("GET /a#1", 0, 0, 100, 100),
      e("GET /a#2", 1, 50, 150, 150),
      e("GET /b#1", 2, 100, 200, 200), // sent exactly when /a#1 was ready: no overlap with it
      e("GET /a#2~retry2", 3, 120, 220, 220),
      e("POST /login#1", 4, 130, 230, 230, { pass: true }),
      e("GET /c#1", 5, 140, undefined, undefined, { end: "aborted" }),
    );
    expect(startOrderOf(net).map((x) => x.key)).toEqual(["GET /a#1", "GET /a#2", "GET /b#1"]);
    expect(overlapOf(net)).toEqual([
      ["GET /a#1", "GET /a#2"],
      ["GET /a#2", "GET /b#1"],
    ]);
    expect(schedulable(net["GET /a#2~retry2"])).toBe(false);
    // delivered newer first: an inversion of the run, from its own timing
    const flipped = { ...net, "GET /a#1": e("GET /a#1", 0, 0, 100, 160) };
    expect(inversionsOf(flipped, ["GET /a#2", "GET /a#1", "GET /b#1"])).toEqual([["GET /a#1", "GET /a#2"]]);
    expect(inversionsOf(net, ["GET /a#1", "GET /a#2", "GET /b#1"])).toEqual([]);
    expect(inversionsOf(undefined, [])).toEqual([]);
  });

  it("buildCover: every key in every row, components contiguous in order of first send, focus last, lifo pairs first", () => {
    // three searches overlap; a lone config request; two saves overlap each other
    const base = log(e("GET /config#1", 0, 0, 5, 5), e("GET /s#1", 1, 10, 110, 110), e("GET /s#2", 2, 30, 130, 140), e("GET /s#3", 3, 50, 150, 170), e("PUT /save#1", 4, 400, 500, 500), e("PUT /save#2", 5, 450, 550, 550));
    const c = buildCover({ baselines: [{ net: base, order: [] }, { net: base, order: [] }], rows: 6, focus: ["PUT /save"] })!;
    expect(c).toMatchObject({ keys: 6, pairs: 4, components: 3, kept: 0, lifoRows: 0 });
    // the triple's four rows past request order and its reverse; the other components in start order, focus last
    expect(c.rows).toEqual([
      ["GET /config#1", "GET /s#2", "GET /s#3", "GET /s#1", "PUT /save#1", "PUT /save#2"],
      ["GET /config#1", "GET /s#1", "GET /s#3", "GET /s#2", "PUT /save#1", "PUT /save#2"],
      ["GET /config#1", "GET /s#2", "GET /s#1", "GET /s#3", "PUT /save#1", "PUT /save#2"],
      ["GET /config#1", "GET /s#3", "GET /s#1", "GET /s#2", "PUT /save#1", "PUT /save#2"],
    ]);
    // the lifo load delivered /s#1 before /s#2 (it did not invert that pair): a row for it comes first
    const lifo = { net: log(e("GET /config#1", 0, 0, 5, 5), e("GET /s#1", 1, 10, 110, 150), e("GET /s#2", 2, 30, 130, 180), e("GET /s#3", 3, 50, 150, 120), e("PUT /save#1", 4, 400, 500, 560), e("PUT /save#2", 5, 450, 550, 551)), order: [] };
    const l = buildCover({ baselines: [{ net: base, order: [] }], lifo, rows: 2 })!;
    expect(l.lifoRows).toBe(1);
    expect(l.rows).toEqual([
      ["GET /config#1", "GET /s#2", "GET /s#1", "GET /s#3", "PUT /save#1", "PUT /save#2"],
      ["GET /config#1", "GET /s#2", "GET /s#3", "GET /s#1", "PUT /save#1", "PUT /save#2"],
    ]);
    expect(buildCover({ baselines: [{ order: [] }], rows: 3 })).toBeNull();
  });

  it(`buildCover permutes the first ${MAX_PERMUTED} keys of a group and keeps the rest in their start-order places`, () => {
    const many = log(...Array.from({ length: 20 }, (_, i) => e(`GET /i#${i + 1}`, i, i, 1000, 1000 + i)));
    const c = buildCover({ baselines: [{ net: many, order: [] }], rows: 3 })!;
    expect(c).toMatchObject({ keys: 20, components: 1, kept: 4 });
    expect(c.rows).toHaveLength(3);
    for (const r of c.rows) {
      expect(r.slice(16)).toEqual(["GET /i#17", "GET /i#18", "GET /i#19", "GET /i#20"]);
      expect([...r].sort()).toEqual(Object.keys(many).sort());
    }
  });
});
