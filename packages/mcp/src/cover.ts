// Cover rows for the explore plan "systematic" (docs/runtime/AGENT.md section 5): sequence covering arrays (Kuhn et al.
// 2012; Chee, Colbourn, Horsley and Zhou 2013) over the responses that overlap in the baselines.
//
// Request order (fifo) and its reverse (lifo) deliver every overlapping pair in both orders. For triples a row pi and its
// reverse put the same element in the middle of every 3-set, each with the outer two both ways round; rows built in
// (pi, reverse(pi)) pairs such that every 3-set has had each of its elements as the middle therefore hold every ordering
// of every triple. sequenceCover builds them by insertion greedy: elements 0..n-1 inserted in turn, each where it gives
// the most 3-sets a middle they have not had (lowest position on ties); a pair that adds nothing is built from one
// uncovered (set, middle) directly. A page's request keys become a row: ranked by the row, a response is delivered after
// every overlapping response ranked above it (the page's ranked order, packages/runtime/src/agent/schedule.ts).
//
// Pure and deterministic (no clock, no randomness, no I/O), zero dependencies; the work is bounded (16 keys permuted per
// overlapping group, rows capped) so the bridge answers a page's hello long before its 600 ms timeout.

import { deliveredBefore, deliveryRanks, keyOrder, overlapOf, pairKey } from "./net.js";
import { sigOf } from "./text.js";
import type { NetEntry, Run } from "./types.js";

/** Keys permuted per group of overlapping responses: the rest keep their start-order places. */
export const MAX_PERMUTED = 16;

export interface SequenceCover {
  /** Permutations of 0..n-1: rows[0] the identity, rows[1] its reverse, then (pi, reverse(pi)) pairs. */
  rows: number[][];
  /** Every ordering of every 3-set appears in some row. */
  complete: boolean;
  /** 3-sets of 0..n-1 (each has 6 orderings). */
  triples: number;
  /** 3-sets all of whose 6 orderings appear in some row. */
  covered: number;
}

/**
 * Rows over 0..n-1 that hold every ordering of every 3-set (complete), or as many as `maxRows` rows (at least the
 * identity and its reverse) hold. The same n and maxRows always give the same rows.
 */
export function sequenceCover(n: number, maxRows: number): SequenceCover {
  const size = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
  const limit = Math.max(2, Math.floor(Number.isFinite(maxRows) ? maxRows : 2));
  const sets = size >= 3 ? (size * (size - 1) * (size - 2)) / 6 : 0;
  // per 3-set {a < b < c}, the orderings seen: bit 2m + o, m the middle's place in (a, b, c), o = 1 when the larger
  // outer element came first
  const seen = new Uint8Array(sets);
  const rank = (a: number, b: number, c: number): number => a + (b * (b - 1)) / 2 + (c * (c - 1) * (c - 2)) / 6;
  const sorted = (x: number, y: number, z: number): [number, number, number] => {
    const s = [x, y, z].sort((p, q) => p - q);
    return [s[0], s[1], s[2]];
  };
  /** Has the middle m of {x, y, z} been seen with its outer two both ways round? */
  const hasMiddle = (x: number, y: number, z: number, m: number): boolean => {
    const t = sorted(x, y, z);
    const i = t.indexOf(m);
    return ((seen[rank(t[0], t[1], t[2])] >> (2 * i)) & 3) === 3;
  };
  const rows: number[][] = [];
  const mark = (row: number[]): void => {
    rows.push(row);
    const pos = new Array<number>(size);
    row.forEach((e, i) => (pos[e] = i));
    for (let c = 2; c < size; c++)
      for (let b = 1; b < c; b++)
        for (let a = 0; a < b; a++) {
          const t = [a, b, c].sort((p, q) => pos[p] - pos[q]);
          const i = t[1] === a ? 0 : t[1] === b ? 1 : 2;
          const outer = t[0] < t[2] ? 0 : 1;
          seen[rank(a, b, c)] |= 1 << (2 * i + outer);
        }
  };
  /** 3-sets whose middle under `pi` is new. */
  const gainOf = (pi: number[]): number => {
    let g = 0;
    for (let i = 0; i < pi.length; i++) for (let j = i + 1; j < pi.length; j++) for (let k = j + 1; k < pi.length; k++) if (!hasMiddle(pi[i], pi[j], pi[k], pi[j])) g++;
    return g;
  };
  const greedy = (): number[] => {
    const pi: number[] = [];
    for (let e = 0; e < size; e++) {
      let best = 0;
      let bestGain = -1;
      for (let p = 0; p <= pi.length; p++) {
        let gain = 0;
        for (let i = 0; i < pi.length; i++)
          for (let j = i + 1; j < pi.length; j++) {
            // e before both, between them, or after both: the middle of {pi[i], pi[j], e}
            const m = p <= i ? pi[i] : p <= j ? e : pi[j];
            if (!hasMiddle(pi[i], pi[j], e, m)) gain++;
          }
        if (gain > bestGain) {
          bestGain = gain;
          best = p;
        }
      }
      pi.splice(best, 0, e);
    }
    return pi;
  };
  /** x, m, z, then the rest in order, for the first 3-set (by rank) and middle not seen both ways yet. */
  const direct = (): number[] | null => {
    for (let c = 2; c < size; c++)
      for (let b = 1; b < c; b++)
        for (let a = 0; a < b; a++)
          for (const m of [a, b, c]) {
            if (hasMiddle(a, b, c, m)) continue;
            const [x, z] = [a, b, c].filter((v) => v !== m);
            return [x, m, z, ...Array.from({ length: size }, (_, i) => i).filter((v) => v !== x && v !== m && v !== z)];
          }
    return null;
  };
  const done = (): boolean => seen.every((v) => v === 63);
  const identity = Array.from({ length: size }, (_, i) => i);
  mark(identity);
  mark(identity.slice().reverse());
  while (rows.length < limit && !done()) {
    let pi = greedy();
    if (gainOf(pi) === 0) {
      const d = direct();
      if (!d) break;
      pi = d;
    }
    mark(pi);
    if (rows.length < limit) mark(pi.slice().reverse());
  }
  let covered = 0;
  for (const v of seen) if (v === 63) covered++;
  return { rows, complete: covered === sets, triples: sets, covered };
}

/** sequenceCover rows by size and row limit, kept once computed (pure: the same arguments give the same rows). */
const memo = new Map<string, number[][]>();
function coverRows(n: number, maxRows: number): number[][] {
  const k = `${n}|${maxRows}`;
  let rows = memo.get(k);
  if (!rows) {
    rows = sequenceCover(n, maxRows).rows;
    if (memo.size > 2000) memo.clear();
    memo.set(k, rows);
  }
  return rows;
}

type Timed = Pick<Run, "net" | "order">;

export interface CoverInput {
  /** The settled baselines (their timing logs and delivery orders). */
  baselines: Timed[];
  /** The settled lifo load, if any: each baseline-overlapping pair it did not deliver the other way gets a row first. */
  lifo?: Timed;
  /** How many rows are wanted (the plan's cover slots). */
  rows: number;
  /** Request signatures ("PUT /api/notes/:id") delivered last in every row. */
  focus?: string[];
}

export interface Cover {
  /** Request keys from highest to lowest rank, one row per cover slot (fewer when the baselines need fewer). */
  rows: string[][];
  /** Schedulable keys the baselines saw (every row lists them all). */
  keys: number;
  /** Pairs overlapping in at least one baseline. */
  pairs: number;
  /** Groups of overlapping responses (connected components of the overlap graph). */
  components: number;
  /** Keys past the first 16 of a group, kept in their start-order places. */
  kept: number;
  /** Rows for pairs the lifo load did not deliver the other way. */
  lifoRows: number;
}

/**
 * The cover rows of an explore session from its settled baselines' timing: the overlap graph is the union of the
 * baselines' overlaps; its components, in order of first send, each permuted by sequenceCover (without its first two
 * rows: request order and its reverse are the baselines and the lifo load), the first 16 keys of a component permuted
 * and the rest kept in their start-order places. Every row lists every key the baselines saw, components contiguous; a
 * component with fewer rows gives its start order; focus keys go last. Null when no baseline has a timing log.
 */
export function buildCover(o: CoverInput): Cover | null {
  const timed = o.baselines.filter((b) => b.net);
  if (!timed.length) return null;
  const want = Math.max(0, Math.floor(o.rows));
  const keys = keyOrder(timed.map((b) => b.net as Record<string, NetEntry>));
  const place = new Map(keys.map((k, i) => [k, i]));
  // the overlap graph: union of the baselines' overlaps, each pair in the common start order
  const pairs = new Map<string, [string, string]>();
  for (const b of timed)
    for (const [x, y] of overlapOf(b.net)) {
      const [a, c] = (place.get(x) ?? 0) <= (place.get(y) ?? 0) ? [x, y] : [y, x];
      pairs.set(pairKey(a, c), [a, c]);
    }
  // components (union-find by start place), in order of first send
  const parent = keys.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const [a, c] of pairs.values()) {
    const [x, y] = [find(place.get(a)!), find(place.get(c)!)];
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  }
  const groups = new Map<number, string[]>();
  keys.forEach((k, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(k);
    else groups.set(r, [k]);
  });
  const comps = [...groups.entries()].sort((x, y) => x[0] - y[0]).map(([, g]) => g);
  const focus = new Set(o.focus ?? []);
  const last = (row: string[]): string[] => (focus.size ? [...row.filter((k) => !focus.has(sigOf(k))), ...row.filter((k) => focus.has(sigOf(k)))] : row);
  const identity = comps.flat();
  const rows: string[][] = [];
  // first, each overlapping pair the lifo load did not deliver the other way: start order with a moved just after b
  let lifoRows = 0;
  if (o.lifo?.net) {
    const ranks = deliveryRanks(o.lifo);
    const sortedPairs = [...pairs.values()].sort((x, y) => place.get(x[0])! - place.get(y[0])! || place.get(x[1])! - place.get(y[1])!);
    for (const [a, b] of sortedPairs) {
      if (rows.length >= want) break;
      if (deliveredBefore(ranks, b, a) === true) continue;
      const row = identity.filter((k) => k !== a);
      row.splice(row.indexOf(b) + 1, 0, a);
      rows.push(last(row));
      lifoRows++;
    }
  }
  // then the cover rows of each component, merged by index
  const need = want - rows.length;
  let kept = 0;
  const perComp = comps.map((g) => {
    const m = Math.min(MAX_PERMUTED, g.length);
    kept += g.length - m;
    if (m < 3 || need <= 0) return [] as string[][];
    const head = g.slice(0, m);
    const tail = g.slice(m);
    return coverRows(m, need + 2)
      .slice(2)
      .map((perm) => [...perm.map((i) => head[i]), ...tail]);
  });
  const count = Math.min(need, Math.max(0, ...perComp.map((r) => r.length)));
  for (let k = 0; k < count; k++) rows.push(last(comps.flatMap((g, i) => perComp[i][k] ?? g)));
  return { rows, keys: keys.length, pairs: pairs.size, components: comps.length, kept, lifoRows };
}
