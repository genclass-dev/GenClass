// Cover rows for the explore plan "systematic" (docs/runtime/AGENT.md section 5): sequence covering arrays (Kuhn et al.
// 2012; Chee, Colbourn, Horsley and Zhou 2013) over the responses that overlap in the baselines.
//
// Request order (fifo) and its reverse (lifo) deliver every overlapping pair in both orders. For triples a row pi and its
// reverse put the same element in the middle of every 3-set, each with the outer two both ways round; rows built in
// (pi, reverse(pi)) pairs such that every 3-set has had each of its elements as the middle therefore hold every ordering
// of every triple, in at least 6 rows (a 3-set needs three different middles). Seen from an element x, each pi puts
// every other element before or after x, one bit per pi: x is the middle of {x, y, z} in some pi exactly when the bits
// of y and z differ, so the pairs are complete when, for every x, the other n - 1 elements all have different bits.
//
// For 4..MAX_PERMUTED elements sequenceCover finds such pis by local search. A step takes a pi and an element at random
// and moves the element to the place that leaves the least weight of (x, {y, z}) with x never between y and z, ties at
// random; a step that changes nothing is taken half the time, one that adds weight never, and after (pairs - 1) n steps
// without a gain every (x, {y, z}) still unsolved weighs one more (breakout), which moves the search out of a local
// minimum. It starts at ceil(log2 n) + 4 pairs and after each cover tries one pair fewer from a fresh start, all tries
// sharing n^6 / 120 steps, at most 40,000 (on an Apple M1 about 25 ms for 16 elements and under 3 ms for 8; 36 and 6 ms
// as a process's first call); the last cover wins, its pis ordered by the 3-sets each gives a new middle (one that
// gives none is left out). The choices come from xorshift32 seeded by n and the pair count. 3 elements (6 rows
// already), more than MAX_PERMUTED, and a search that ends without a cover use the insertion greedy: elements 0..n-1
// inserted in turn, each where it gives the most 3-sets a middle they have not had (lowest position on ties); a pair
// that adds nothing is built from one uncovered (set, middle) directly. A page's request keys become a row: ranked by
// the row, a response is delivered after every overlapping response ranked above it (the page's ranked order,
// packages/runtime/src/agent/schedule.ts).
//
// Pure and deterministic (no clock, no Math.random, integer arithmetic only, no I/O: the same n and maxRows always give
// the same rows), zero dependencies; the work is bounded (16 keys permuted per overlapping group, the search's steps
// capped and each size searched once, rows capped) and runs when a baseline settles, never at a page's hello.

import { deliveredBefore, deliveryRanks, keyOrder, overlapOf, pairKey } from "./net.js";
import { sigOf } from "./text.js";
import type { NetEntry, Run } from "./types.js";

/** Keys permuted per group of overlapping responses: the rest keep their start-order places. */
export const MAX_PERMUTED = 16;

/** The search's steps for n elements, shared by all its tries: n^6 / 120, at most 40,000. */
const searchSteps = (n: number): number => Math.min(Math.floor((n * n * n * n * n * n) / 120), 40_000);

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
 * Rows over 0..n-1 that hold every ordering of every 3-set (complete), or the first `maxRows` of them (at least the
 * identity and its reverse) and what those hold. The same n and maxRows always give the same rows.
 */
export function sequenceCover(n: number, maxRows: number): SequenceCover {
  const size = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
  const limit = Math.max(2, Math.floor(Number.isFinite(maxRows) ? maxRows : 2));
  const identity = Array.from({ length: size }, (_, i) => i);
  const rows =
    size < 3 || limit === 2
      ? [identity, identity.slice().reverse()]
      : size > 3 && size <= MAX_PERMUTED
        ? searchedRows(size)
            .slice(0, limit)
            .map((r) => r.slice())
        : greedyRows(size, limit);
  const triples = triplesOf(size);
  const covered = coveredSets(size, rows);
  return { rows, complete: covered === triples, triples, covered };
}

const triplesOf = (size: number): number => (size >= 3 ? (size * (size - 1) * (size - 2)) / 6 : 0);

/**
 * Per 3-set {a < b < c} (rank a + b(b-1)/2 + c(c-1)(c-2)/6), the ordering `row` holds as one bit 2m + o: m the middle's
 * place in (a, b, c), o = 1 when the larger outer element comes first.
 */
function orderings(size: number, row: number[]): Uint8Array {
  const pos = new Int32Array(size);
  row.forEach((e, i) => (pos[e] = i));
  const out = new Uint8Array(triplesOf(size));
  let s = 0;
  for (let c = 2; c < size; c++)
    for (let b = 1; b < c; b++)
      for (let a = 0; a < b; a++, s++) {
        const pa = pos[a];
        const pb = pos[b];
        const pc = pos[c];
        const bit = pa < pb === pb < pc ? 2 + (pc < pa ? 1 : 0) : pb < pa === pa < pc ? (pc < pb ? 1 : 0) : 4 + (pb < pa ? 1 : 0);
        out[s] = 1 << bit;
      }
  return out;
}

/** 3-sets all of whose 6 orderings appear in some row. */
function coveredSets(size: number, rows: number[][]): number {
  const seen = new Uint8Array(triplesOf(size));
  for (const row of rows) {
    const o = orderings(size, row);
    for (let s = 0; s < seen.length; s++) seen[s] |= o[s];
  }
  let covered = 0;
  for (const v of seen) if (v === 63) covered++;
  return covered;
}

/** Complete rows by size (4..MAX_PERMUTED), searched once: the search's cover, else the insertion greedy's. */
const searched = new Map<number, number[][]>();
function searchedRows(size: number): number[][] {
  let rows = searched.get(size);
  if (!rows) {
    const pis = searchPairs(size);
    const found = pis ? pairRows(size, pis) : null;
    rows = found && coveredSets(size, found) === triplesOf(size) ? found : greedyRows(size, Infinity);
    searched.set(size, rows);
  }
  return rows;
}

/**
 * The identity and its reverse, then each pi (its first element below its last) and its reverse: first the pi that
 * gives the most 3-sets a middle they have not had (the earlier pi on ties), and so on; a pi that gives none is left out.
 */
function pairRows(size: number, pis: number[][]): number[][] {
  const identity = Array.from({ length: size }, (_, i) => i);
  // per 3-set, its middle under a row as bit m (the middle's place in a < b < c)
  const middles = (row: number[]): Uint8Array => orderings(size, row).map((v) => (v & 3 ? 1 : v & 12 ? 2 : 4));
  const had = middles(identity);
  const gives = pis.map(middles);
  const used = pis.map(() => false);
  const rows = [identity, identity.slice().reverse()];
  for (;;) {
    let pick = -1;
    let most = 0;
    gives.forEach((g, j) => {
      if (used[j]) return;
      let gain = 0;
      for (let s = 0; s < g.length; s++) if (!(had[s] & g[s])) gain++;
      if (gain > most) {
        pick = j;
        most = gain;
      }
    });
    if (pick < 0) return rows;
    used[pick] = true;
    gives[pick].forEach((m, s) => (had[s] |= m));
    const pi = pis[pick][0] < pis[pick][size - 1] ? pis[pick].slice() : pis[pick].slice().reverse();
    rows.push(pi, pi.slice().reverse());
  }
}

/**
 * The pis (without the identity) of the fewest pairs the local search completed for n elements: from ceil(log2 n) + 4
 * pairs down, one pair fewer after each cover, all tries drawing on searchSteps(n) steps; null when none completed.
 */
function searchPairs(n: number): number[][] | null {
  if (n > 32) return null;
  let log = 0;
  while (1 << log < n) log++;
  let found: number[][] | null = null;
  let left = searchSteps(n);
  for (let pairs = log + 4; pairs >= 3 && left > 0; pairs--) {
    const run = middleSearch(n, pairs, left);
    left -= run.steps;
    if (!run.pis) break;
    found = run.pis;
  }
  return found;
}

/** xorshift32 from `seed` mixed by murmur3's finalizer (never 0): the search's only source of choices. */
function xorshift(seed: number): () => number {
  let s = Math.imul(seed ^ (seed >>> 16), 0x85ebca6b);
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35);
  s = (s ^ (s >>> 16)) >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>>= 0);
  };
}

/**
 * Local search for k - 1 pis that, with the identity, give the other n - 1 elements of every x different bits (n <= 32:
 * the elements with one code are a 32-bit mask). The pis, or null when `maxSteps` steps did not get there, and the
 * steps taken.
 */
function middleSearch(n: number, k: number, maxSteps: number): { pis: number[][] | null; steps: number } {
  const next = xorshift(n * 64 + k);
  const M = 1 << k;
  const perm = new Int32Array(k * n); // perm[i * n + p]: the element at place p of pi i (pi 0 the identity)
  const pos = new Int32Array(k * n); // pos[i * n + e]: the place of e in pi i
  const code = new Int32Array(n * n); // code[x * n + y]: bit i set when y comes after x in pi i
  const count = new Int32Array(n * M); // count[x * M + c]: the elements y with code[x * n + y] = c
  const mask = new Int32Array(n * M); // the same elements as a bit mask
  const weight = new Int32Array(n * n * n).fill(1); // weight[(x * n + y) * n + z]: of x never between y and z
  for (let i = 0; i < k; i++) {
    const o = i * n;
    for (let p = 0; p < n; p++) perm[o + p] = p;
    for (let p = i > 0 ? n - 1 : 0; p > 0; p--) {
      const j = next() % (p + 1);
      [perm[o + p], perm[o + j]] = [perm[o + j], perm[o + p]];
    }
    for (let p = 0; p < n; p++) pos[o + perm[o + p]] = p;
  }
  // (x, {y, z}) with x never between y and z: pairs of elements with the same code from x
  let unsolved = 0;
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++) {
      if (y === x) continue;
      let c = 0;
      for (let i = 0; i < k; i++) if (pos[i * n + y] > pos[i * n + x]) c |= 1 << i;
      code[x * n + y] = c;
      unsolved += count[x * M + c]++;
      mask[x * M + c] |= 1 << y;
    }
  // the best place for u in pi i (bestAt) and its change in weight (bestBy)
  let bestAt = -1;
  let bestBy = 0;
  const best = (i: number, u: number): void => {
    const o = i * n;
    const p = pos[o + u];
    const bit = 1 << i;
    const hu = u * M;
    bestAt = -1;
    bestBy = 0x7fffffff;
    let ties = 0;
    for (let dir = 1; dir >= -1; dir -= 2) {
      let by = 0;
      let passed = 0;
      for (let q = p + dir; q >= 0 && q < n; q += dir) {
        // u passes w: bit i flips in u's code from w (the elements passed before w with w's code have moved on with
        // it) and in w's code from u. The weight of each z that w joins or leaves (from u), and that u joins or leaves
        // (from w), is added or taken off; the sums are written out, as this loop is the search's cost.
        const w = perm[o + q];
        const a = code[u * n + w];
        const had = mask[hu + a];
        const uw = (u * n + w) * n;
        for (let m = mask[hu + (a ^ bit)] | (had & passed); m !== 0; m &= m - 1) by += weight[uw + 31 - Math.clz32(m & -m)];
        for (let m = had & ~passed & ~(1 << w); m !== 0; m &= m - 1) by -= weight[uw + 31 - Math.clz32(m & -m)];
        passed |= 1 << w;
        const hw = w * M;
        const c = code[w * n + u];
        const wu = (w * n + u) * n;
        for (let m = mask[hw + (c ^ bit)]; m !== 0; m &= m - 1) by += weight[wu + 31 - Math.clz32(m & -m)];
        for (let m = mask[hw + c] & ~(1 << u); m !== 0; m &= m - 1) by -= weight[wu + 31 - Math.clz32(m & -m)];
        if (by < bestBy) {
          bestAt = q;
          bestBy = by;
          ties = 1;
        } else if (by === bestBy && next() % ++ties === 0) bestAt = q;
      }
    }
  };
  /** y's code from x flips bit `bit`. */
  const flip = (x: number, y: number, bit: number): void => {
    const h = x * M;
    const a = code[x * n + y];
    code[x * n + y] = a ^ bit;
    unsolved += count[h + (a ^ bit)] - count[h + a] + 1;
    mask[h + a] &= ~(1 << y);
    mask[h + (a ^ bit)] |= 1 << y;
    count[h + a]--;
    count[h + (a ^ bit)]++;
  };
  /** Moves u to place q of pi i. */
  const move = (i: number, u: number, q: number): void => {
    const o = i * n;
    const p = pos[o + u];
    const dir = q > p ? 1 : -1;
    for (let t = p + dir; t !== q + dir; t += dir) {
      const w = perm[o + t];
      flip(u, w, 1 << i);
      flip(w, u, 1 << i);
      perm[o + t - dir] = w;
      pos[o + w] = t - dir;
    }
    perm[o + q] = u;
    pos[o + u] = q;
  };
  /** Every (x, {y, z}) still unsolved weighs one more. */
  const bump = (): void => {
    for (let h = 0; h < n * M; h++) {
      if (count[h] < 2) continue;
      const x = h >> k;
      for (let r = mask[h]; r !== 0; r &= r - 1) {
        const y = 31 - Math.clz32(r & -r);
        for (let t = r & (r - 1); t !== 0; t &= t - 1) {
          const z = 31 - Math.clz32(t & -t);
          weight[(x * n + y) * n + z]++;
          weight[(x * n + z) * n + y]++;
        }
      }
    }
  };
  let steps = 0;
  let idle = 0;
  while (unsolved > 0 && steps < maxSteps) {
    steps++;
    const i = 1 + (next() % (k - 1));
    const u = next() % n;
    best(i, u);
    if (bestBy < 0 || (bestBy === 0 && (next() & 1) === 0)) {
      move(i, u, bestAt);
      idle = bestBy < 0 ? 0 : idle + 1;
    } else idle++;
    if (idle >= (k - 1) * n) {
      bump();
      idle = 0;
    }
  }
  if (unsolved > 0) return { pis: null, steps };
  return { pis: Array.from({ length: k - 1 }, (_, i) => Array.from(perm.subarray((i + 1) * n, (i + 2) * n))), steps };
}

/** The insertion greedy's rows (at most `limit`, at least 2) over 0..size-1, size >= 3: complete unless cut. */
function greedyRows(size: number, limit: number): number[][] {
  const sets = triplesOf(size);
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
    const o = orderings(size, row);
    for (let s = 0; s < sets; s++) seen[s] |= o[s];
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
  return rows;
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
