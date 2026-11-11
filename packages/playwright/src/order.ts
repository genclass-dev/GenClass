// Which difference in the order of things separates the failing runs of a test from its passing ones. Pure: no I/O and
// no clock; the only randomness is a seeded generator for the shuffles, so the same runs give the same answer.
//
// A measured comparison, never a diagnosis. It reads the steps a race file carries (steps.ts: user actions, each
// request's send, the delivery of its response to the app), which the runtime records the same way on every framework,
// and it reads no app state. It says "this order is in 7 of 7 failing runs and in none of 29 passing runs" and how
// often shuffled outcomes give as much. Whether that order is the cause, a consequence of the cause or a coincidence
// that survived the shuffles is for the reader: nothing here maps a pattern to a bug.
//
// What is compared. A step is the same step in two runs when its kind, label and number are the same ("the response
// to the 2nd POST /api/orders"). Two kinds of statement are looked at:
//   pair     "X came before Y", for two steps;
//   between  "X came between A and B", for three steps where A comes before B in every run that has both and the
//            order of X against each of them differs from run to run. One pair cannot say it: when the passing runs
//            have X before A in some runs and after B in others, neither "A before X" nor "X before B" is theirs alone.
// A statement is judged in a run only when the run recorded every step it names, in the part of the run that counts:
//   - a failing run stops early, so a step it never reached is unknown there, never "after" and never evidence;
//   - a passing run goes on where the failing runs stopped. What it did after the first user action that no failing
//     run reached (and at least half the passing runs did) has no counterpart in a failing run, so that action and
//     everything after it are unknown in the passing run too: a late response that lands there, harmlessly, would
//     otherwise read as "the passing runs have this order as well";
//   - a step that landed after the test's own code had finished (the fixture waits for late responses) cannot have
//     changed the result, so it is unknown, in passing and in failing runs alike.
// A difference is a statement true in at least one failing run and in next to no passing run, known in enough runs of
// each kind (`minFailing` failing ones; `minPassing` passing ones and at least half of them). "Next to no": at most
// one in twenty of the passing runs that recorded its steps, rounded down, so none at all below twenty. Where a test's
// code ends is measured, not known exactly, and a run can pass with the failing order when the app repairs itself in
// time; one such run among many must not hide an order every failing run has. Each difference is given with both
// counts. The ones true in every failing run separate the two groups; the others are orders some failing runs have.
//
// How they are ranked: more failing runs first; then fewer passing runs; then a response against a user action or
// another response before statements about a request's send, before two user actions; then a pair before a between;
// then the steps nearest each other in the sequence. The list is then built so that each line adds failing runs the
// lines above it do not have, which is what tells "one cause" from "the failing runs differ among themselves". A
// difference is listed only when its own count of failing runs is one that shuffled outcomes rarely reach (below).
//
// Chance. Two runs under different delays differ in many orders for no reason, so some statement is always "only in
// failing runs" when there are few of them. The same search is therefore run with the outcomes shuffled (every way of
// choosing which runs failed when there are at most EXACT_WAYS of them, else `shuffles` seeded random ways), and the
// answer says in how many of them some statement did as well (true in as many "failing" runs, under the same rule for
// the "passing" ones), and how many statements separated the groups on average. Above `alpha` the verdict is "chance"
// and no difference is called an explanation; and the count of failing runs that at most `alpha` of the shuffles
// reach (`needed`) is the least a difference must have to be listed at all, so the lines after the first are held to
// the same measure as the first. The shuffles are made on the runs as they are compared (cut as above). Below the
// minimum of failing and passing runs nothing is compared at all.

import { mulberry32 } from "./chaos.js";
import { decodeSteps, type StepEvent, type StepKind } from "./steps.js";
import type { GenClassRacesFile } from "./types.js";

/** The fewest failing runs, and the fewest passing runs, the comparison is made with. */
export const DEFAULT_MIN_RUNS = 3;
/** How many times the outcomes are shuffled when there are too many ways to try them all. */
export const DEFAULT_SHUFFLES = 1000;
/** With at most this many ways to choose which runs failed, every one is tried. */
export const EXACT_WAYS = 2000;
/** The share of shuffles that may do as well before the verdict is "chance". */
export const DEFAULT_ALPHA = 0.05;
/** How many differences are listed. */
export const DEFAULT_MAX_DIFFERENCES = 5;
/** A difference may be in one of this many passing runs that recorded its steps (rounded down: in none below this many). */
export const PASSING_PER_EXCEPTION = 20;
/** Runs and distinct steps compared at most (the first runs given; the steps met first). */
export const MAX_RUNS = 400;
export const MAX_STEPS = 1200;
/** A bound on the work of comparing every pair of steps in every run (steps squared times runs, halved). */
const MAX_WORK = 120_000_000;
/** For "between": the steps nearest a step whose order against it varies, at most. */
const NEIGHBOURS = 24;

/** One run of a test: whether it failed, and its steps in order. */
export interface OrderRun {
  failed: boolean;
  events: readonly StepEvent[];
}

export interface ExplainOptions {
  /** The fewest failing runs compared. Default 3. */
  minFailing?: number;
  /** The fewest passing runs compared. Default 3. */
  minPassing?: number;
  /** Shuffles of the outcomes when not every way is tried. Default 1000. */
  shuffles?: number;
  /** The share of shuffles that may do as well. Default 0.05. */
  alpha?: number;
  /** Differences listed at most. Default 5. */
  maxDifferences?: number;
  /** The seed of the shuffles. Default 1. */
  seed?: number;
}

/** A step, as a difference names it. `many`: the test has more than one step of this kind and label, so `n` is said. */
export interface StepRef {
  kind: StepKind;
  label: string;
  n: number;
  many: boolean;
}

/** A statement about the order of steps. pair: [first, second]. between: [before, the one in between, after]. */
export interface OrderStatement {
  form: "pair" | "between";
  steps: StepRef[];
}

/** An order that failing runs have and next to no passing run has. */
export interface OrderDifference extends OrderStatement {
  /** Failing runs that have this order, and failing runs that recorded every step it names. */
  failing: { with: number; recorded: number };
  /**
   * Passing runs that have this order all the same (at most one in PASSING_PER_EXCEPTION of those that recorded its
   * steps), and passing runs that recorded every step it names. For a between: in how many of those the step came
   * before the first of the two, and in how many after the second.
   */
  passing: { with: number; recorded: number; before?: number; after?: number };
  /**
   * Median ms between the steps in the failing runs that have this order. pair: [first to second]. between: [the
   * first of the two to the step, the step to the second].
   */
  ms: number[];
  /** Failing runs that have this order and none of the differences listed above it. */
  adds: number;
  /** How many other statements are true in exactly the same runs, and the first of them. */
  alike: number;
  also: OrderStatement[];
}

export interface OrderChance {
  /** How many ways of choosing which runs failed were tried, and whether that was every way there is. */
  ways: number;
  exact: boolean;
  /** In how many of them some statement was a difference with at least `strongest` failing runs. */
  asStrong: number;
  /** That as a share (with shuffles, one is added to both counts: the real outcomes are a way too). */
  share: number;
  /** The mean number of statements that separated every "failing" run from every "passing" one. */
  separating: number;
  /**
   * The fewest failing runs a difference must have for at most `alpha` of the ways to reach it: what a difference
   * needs to be listed. One more than there are failing runs when no count is rare enough.
   */
  needed: number;
}

export type OrderVerdict = "explained" | "chance" | "no-difference" | "too-few-runs";

export interface OrderExplanation {
  /**
   * "explained": the differences listed are not what shuffled outcomes give. "chance": there are differences, and
   * shuffled outcomes give as much too often. "no-difference": no order is the failing runs' alone. "too-few-runs":
   * fewer failing or passing runs than the minimum, nothing compared.
   */
  verdict: OrderVerdict;
  /** Runs compared, of each kind. */
  failing: number;
  passing: number;
  minimum: { failing: number; passing: number };
  /** The differences, ranked (see the header). Listed only when the verdict is "explained". */
  differences: OrderDifference[];
  /** Failing runs that have at least one of the differences listed. */
  covered: number;
  /**
   * Differences not listed. "explained": the ones with enough failing runs to be listed (`chance.needed`) that add no
   * failing run to the list or are over its length. "chance": all of them.
   */
  more: number;
  /** The most failing runs any one difference has. */
  strongest: number;
  /** Differences that every failing run has. */
  separating: number;
  /** What shuffled outcomes give (null when nothing was compared). */
  chance: OrderChance | null;
  /** More runs or steps were given than are compared (MAX_RUNS, MAX_STEPS). */
  capped: boolean;
}

// ------------------------------------------------------------------------------------------------ bit sets of runs

function pop(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** How many ways there are to choose k of n, or Infinity past `limit`. */
function ways(n: number, k: number, limit: number): number {
  k = Math.min(k, n - k);
  let c = 1;
  for (let i = 1; i <= k; i++) {
    c = (c * (n - k + i)) / i;
    if (c > limit) return Infinity;
  }
  return Math.round(c);
}

function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// ------------------------------------------------------------------------------------------------ the comparison

interface Statement {
  /** 0: pair, 1: between. */
  form: 0 | 1;
  /** Step indexes: pair [first, second]; between [before, in between, after]. */
  at: number[];
  /** 0: a response against a user action or another response. 1: a request's send or end is involved. 2: user actions only. */
  group: number;
  /** Mean distance in the sequence between the outermost steps, over the runs that have them. */
  near: number;
}

interface Pattern {
  /** The runs where the statement is true, and the runs that recorded every step it names. */
  t: Int32Array;
  k: Int32Array;
  /** The best statements with this pattern (at most 3), and how many there are. */
  best: Statement[];
  count: number;
}

/** A pattern that is a difference under one labelling of the runs: how many failing and how many passing runs have it. */
interface Hit {
  p: Pattern;
  with: number;
  passing: number;
}

function rank(a: Statement, b: Statement): number {
  return a.group - b.group || a.form - b.form || a.near - b.near || a.at.length - b.at.length || a.at[0] - b.at[0] || a.at[1] - b.at[1] || (a.at[2] ?? 0) - (b.at[2] ?? 0);
}

const id = (e: StepEvent): string => `${e.kind}${e.n} ${e.label}`;

function groupOf(kinds: StepKind[]): number {
  if (kinds.every((k) => k === "a")) return 2;
  return kinds.every((k) => k === "a" || k === "r") ? 0 : 1;
}

function nothing(verdict: OrderVerdict, failing: number, passing: number, minimum: { failing: number; passing: number }, capped: boolean): OrderExplanation {
  return { verdict, failing, passing, minimum, differences: [], covered: 0, more: 0, strongest: 0, separating: 0, chance: null, capped };
}

/**
 * Compares the order of steps in the failing runs of one test with the order in its passing runs (see the header).
 * Runs without a step are not counted. Never throws.
 */
export function explainOrder(given: readonly OrderRun[], options: ExplainOptions = {}): OrderExplanation {
  const whole = (v: number | undefined, fallback: number, least: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(least, Math.floor(v)) : fallback);
  const minimum = { failing: whole(options.minFailing, DEFAULT_MIN_RUNS, 1), passing: whole(options.minPassing, DEFAULT_MIN_RUNS, 1) };
  const alpha = typeof options.alpha === "number" && options.alpha > 0 && options.alpha <= 1 ? options.alpha : DEFAULT_ALPHA;
  const maxDifferences = whole(options.maxDifferences, DEFAULT_MAX_DIFFERENCES, 1);
  const shuffles = whole(options.shuffles, DEFAULT_SHUFFLES, 1);

  // the part of each run that counts: its steps up to the end of the test's own code, each step once
  let capped = false;
  const usable = given.filter((r) => r.events.some((e) => !e.late));
  if (usable.length > MAX_RUNS) capped = true;
  const runs = usable.slice(0, MAX_RUNS).map((r) => {
    const order: StepEvent[] = [];
    const seen = new Set<string>();
    for (const e of r.events) {
      if (e.late) continue;
      const key = id(e);
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(e);
    }
    return { failed: r.failed, order };
  });
  const R = runs.length;
  const F = runs.filter((r) => r.failed).length;
  const P = R - F;
  if (F < minimum.failing || P < minimum.passing) return nothing("too-few-runs", F, P, minimum, capped);

  // a passing run is compared up to the first user action no failing run reached (see the header)
  const reached = new Set<string>();
  const done = new Map<string, number>();
  for (const r of runs) {
    for (const e of r.order) {
      if (e.kind !== "a") continue;
      if (r.failed) reached.add(id(e));
      else done.set(id(e), (done.get(id(e)) ?? 0) + 1);
    }
  }
  for (const r of runs) {
    if (r.failed) continue;
    const beyond = r.order.findIndex((e) => e.kind === "a" && !reached.has(id(e)) && (done.get(id(e)) ?? 0) * 2 >= P);
    if (beyond >= 0) r.order.length = beyond;
  }

  // the steps enough runs have to be judged in both groups, whichever runs those are
  const inRuns = new Map<string, number>();
  for (const r of runs) for (const e of r.order) inRuns.set(id(e), (inRuns.get(id(e)) ?? 0) + 1);
  const limit = Math.max(2, Math.min(MAX_STEPS, Math.floor(Math.sqrt((2 * MAX_WORK) / R))));
  const steps: StepEvent[] = [];
  const index = new Map<string, number>();
  for (const r of runs) {
    for (const e of r.order) {
      const key = id(e);
      if (index.has(key) || (inRuns.get(key) ?? 0) < minimum.failing + minimum.passing) continue;
      if (steps.length >= limit) {
        capped = true;
        continue;
      }
      index.set(key, steps.length);
      steps.push(e);
    }
  }
  const n = steps.length;
  // by step: its place in each run (-1: not there) and its time
  const place: Int32Array[] = steps.map(() => new Int32Array(R).fill(-1));
  const time: Int32Array[] = steps.map(() => new Int32Array(R));
  runs.forEach((r, ri) => {
    r.order.forEach((e, pi) => {
      const i = index.get(id(e));
      if (i === undefined) return;
      place[i][ri] = pi;
      time[i][ri] = e.t;
    });
  });

  const W = (R + 31) >>> 5;
  const patterns = new Map<string, Pattern>();
  const add = (t: Int32Array, k: Int32Array, s: Statement): void => {
    const key = `${t.join(",")}|${k.join(",")}`;
    let p = patterns.get(key);
    if (!p) {
      p = { t: t.slice(), k: k.slice(), best: [], count: 0 };
      patterns.set(key, p);
    }
    p.count++;
    p.best.push(s);
    p.best.sort(rank);
    if (p.best.length > 3) p.best.length = 3;
  };

  // pairs: every two steps, in every run that has both. A pair whose order never varies says nothing.
  /** 0: no run has both. 1: the lower index always first. 2: the higher always first. 3: it varies. */
  const relation = new Uint8Array(n * n);
  const varying = new Map<number, { t: Int32Array; k: Int32Array }>();
  const neighbours: { other: number; near: number }[][] = steps.map(() => []);
  const tw = new Int32Array(W);
  const kw = new Int32Array(W);
  const rev = new Int32Array(W);
  for (let i = 0; i < n; i++) {
    const pi = place[i];
    for (let j = i + 1; j < n; j++) {
      const pj = place[j];
      tw.fill(0);
      kw.fill(0);
      let first = 0;
      let second = 0;
      let distance = 0;
      for (let r = 0; r < R; r++) {
        const a = pi[r];
        const b = pj[r];
        if (a < 0 || b < 0) continue;
        kw[r >>> 5] |= 1 << (r & 31);
        if (a < b) {
          tw[r >>> 5] |= 1 << (r & 31);
          first++;
          distance += b - a;
        } else {
          second++;
          distance += a - b;
        }
      }
      relation[i * n + j] = first && second ? 3 : first ? 1 : second ? 2 : 0;
      if (!first || !second) continue;
      const near = distance / (first + second);
      const group = groupOf([steps[i].kind, steps[j].kind]);
      for (let w = 0; w < W; w++) rev[w] = kw[w] & ~tw[w];
      add(tw, kw, { form: 0, at: [i, j], group, near });
      add(rev, kw, { form: 0, at: [j, i], group, near });
      varying.set(i * n + j, { t: tw.slice(), k: kw.slice() });
      neighbours[i].push({ other: j, near });
      neighbours[j].push({ other: i, near });
    }
  }

  // between: a step whose order against two others varies, those two in one order wherever both are
  const before = (a: number, b: number): { t: Int32Array; k: Int32Array } | null => {
    const v = varying.get(a < b ? a * n + b : b * n + a);
    if (!v) return null;
    if (a < b) return v;
    const t = new Int32Array(W);
    for (let w = 0; w < W; w++) t[w] = v.k[w] & ~v.t[w];
    return { t, k: v.k };
  };
  for (let x = 0; x < n; x++) {
    const near = neighbours[x].sort((a, b) => a.near - b.near || a.other - b.other).slice(0, NEIGHBOURS);
    for (let p = 0; p < near.length; p++) {
      for (let q = p + 1; q < near.length; q++) {
        const lo = Math.min(near[p].other, near[q].other);
        const hi = Math.max(near[p].other, near[q].other);
        const rel = relation[lo * n + hi];
        if (rel !== 1 && rel !== 2) continue;
        const [left, right] = rel === 1 ? [lo, hi] : [hi, lo];
        const one = before(left, x);
        const two = before(x, right);
        if (!one || !two) continue;
        let any = 0;
        let span = 0;
        let known = 0;
        for (let w = 0; w < W; w++) {
          tw[w] = one.t[w] & two.t[w];
          kw[w] = one.k[w] & two.k[w];
          any |= tw[w];
        }
        if (!any) continue;
        for (let r = 0; r < R; r++) {
          if (!(kw[r >>> 5] & (1 << (r & 31)))) continue;
          known++;
          span += Math.abs(place[right][r] - place[left][r]);
        }
        add(tw, kw, { form: 1, at: [left, x, right], group: groupOf([steps[left].kind, steps[x].kind, steps[right].kind]), near: known ? span / known : 0 });
      }
    }
  }

  // one labelling of the runs: the most failing runs any statement has that no passing run has, and how many
  // statements have every failing run
  const list = [...patterns.values()];
  const all = new Int32Array(W);
  for (let r = 0; r < R; r++) all[r >>> 5] |= 1 << (r & 31);
  const needPassing = Math.max(minimum.passing, Math.ceil(P / 2));
  const judge = (fail: Int32Array, hits?: Hit[]): { strongest: number; separating: number } => {
    let strongest = 0;
    let separating = 0;
    for (const p of list) {
      let failingWith = 0;
      let failingKnown = 0;
      let passingWith = 0;
      let passingKnown = 0;
      for (let w = 0; w < W; w++) {
        const passing = ~fail[w] & all[w];
        failingWith += pop(p.t[w] & fail[w]);
        failingKnown += pop(p.k[w] & fail[w]);
        passingWith += pop(p.t[w] & passing);
        passingKnown += pop(p.k[w] & passing);
      }
      if (failingWith === 0 || failingKnown < minimum.failing || passingKnown < needPassing) continue;
      if (passingWith > Math.floor(passingKnown / PASSING_PER_EXCEPTION)) continue;
      if (failingWith > strongest) strongest = failingWith;
      if (failingWith === F) separating += p.count;
      hits?.push({ p, with: failingWith, passing: passingWith });
    }
    return { strongest, separating };
  };

  const real = new Int32Array(W);
  runs.forEach((r, ri) => {
    if (r.failed) real[ri >>> 5] |= 1 << (ri & 31);
  });
  const hits: Hit[] = [];
  const found = judge(real, hits);
  const out = nothing("no-difference", F, P, minimum, capped);
  out.strongest = found.strongest;
  out.separating = found.separating;

  // the same search with the outcomes shuffled
  const total = ways(R, F, EXACT_WAYS);
  const chance: OrderChance = { ways: 0, exact: total !== Infinity, asStrong: 0, share: 1, separating: 0, needed: F + 1 };
  let separatingSum = 0;
  /** By count of failing runs: in how many ways the strongest statement had exactly that many. */
  const reachedBy = new Array<number>(F + 1).fill(0);
  const tryOne = (fail: Int32Array): void => {
    const j = judge(fail);
    chance.ways++;
    reachedBy[j.strongest]++;
    if (found.strongest > 0 && j.strongest >= found.strongest) chance.asStrong++;
    separatingSum += j.separating;
  };
  const fail = new Int32Array(W);
  if (chance.exact) {
    // every way of choosing which F of the R runs failed (the real one is among them)
    const pick = Array.from({ length: F }, (_, i) => i);
    for (;;) {
      fail.fill(0);
      for (const r of pick) fail[r >>> 5] |= 1 << (r & 31);
      tryOne(fail);
      let i = F - 1;
      while (i >= 0 && pick[i] === R - F + i) i--;
      if (i < 0) break;
      pick[i]++;
      for (let j = i + 1; j < F; j++) pick[j] = pick[j - 1] + 1;
    }
    chance.share = chance.ways ? chance.asStrong / chance.ways : 1;
  } else {
    const random = mulberry32(typeof options.seed === "number" && Number.isFinite(options.seed) ? Math.floor(options.seed) : 1);
    const order = Array.from({ length: R }, (_, i) => i);
    for (let s = 0; s < shuffles; s++) {
      for (let i = 0; i < F; i++) {
        const j = i + Math.floor(random() * (R - i));
        const swap = order[i];
        order[i] = order[j];
        order[j] = swap;
      }
      fail.fill(0);
      for (let i = 0; i < F; i++) fail[order[i] >>> 5] |= 1 << (order[i] & 31);
      tryOne(fail);
    }
    chance.share = (chance.asStrong + 1) / (chance.ways + 1);
  }
  chance.separating = chance.ways ? Math.round((separatingSum / chance.ways) * 100) / 100 : 0;
  // the fewest failing runs that at most alpha of the ways reach (with shuffles, the real outcomes count as one more way)
  for (let c = F, atLeast = 0; c >= 1; c--) {
    atLeast += reachedBy[c];
    if ((chance.exact ? atLeast / chance.ways : (atLeast + 1) / (chance.ways + 1)) > alpha) break;
    chance.needed = c;
  }
  out.chance = chance;
  if (found.strongest === 0) return out;
  if (chance.share > alpha) {
    // not told apart from chance: how many there are is said, and none is listed as if it explained anything
    out.verdict = "chance";
    out.more = hits.reduce((sum, h) => sum + h.p.count, 0);
    return out;
  }
  out.verdict = "explained";

  // the list: the strongest first, then whichever adds the most failing runs not yet covered
  hits.sort((a, b) => b.with - a.with || a.passing - b.passing || rank(a.p.best[0], b.p.best[0]));
  const strong = hits.filter((h) => h.with >= chance.needed);
  const covered = new Int32Array(W);
  const many = new Map<string, boolean>();
  for (const r of runs) for (const e of r.order) if (e.n > 1) many.set(`${e.kind === "a" ? "a" : "q"} ${e.label}`, true);
  const ref = (i: number): StepRef => ({ kind: steps[i].kind, label: steps[i].label, n: steps[i].n, many: many.get(`${steps[i].kind === "a" ? "a" : "q"} ${steps[i].label}`) === true });
  const statement = (s: Statement): OrderStatement => ({ form: s.form === 0 ? "pair" : "between", steps: s.at.map(ref) });
  const left = strong.slice();
  while (out.differences.length < maxDifferences && left.length) {
    let best = -1;
    let bestAdds = 0;
    left.forEach((h, i) => {
      let adds = 0;
      for (let w = 0; w < W; w++) adds += pop(h.p.t[w] & real[w] & ~covered[w]);
      if (adds > bestAdds) {
        best = i;
        bestAdds = adds;
      }
    });
    if (best < 0) break;
    const h = left.splice(best, 1)[0];
    const s = h.p.best[0];
    const d: OrderDifference = { ...statement(s), failing: { with: h.with, recorded: 0 }, passing: { with: h.passing, recorded: 0 }, ms: [], adds: bestAdds, alike: h.p.count - 1, also: h.p.best.slice(1).map(statement) };
    const gaps: number[][] = s.form === 0 ? [[]] : [[], []];
    let beforeIt = 0;
    let afterIt = 0;
    for (let r = 0; r < R; r++) {
      const bit = 1 << (r & 31);
      if (!(h.p.k[r >>> 5] & bit)) continue;
      if (real[r >>> 5] & bit) {
        d.failing.recorded++;
        if (!(h.p.t[r >>> 5] & bit)) continue;
        gaps[0].push(time[s.at[1]][r] - time[s.at[0]][r]);
        if (s.form === 1) gaps[1].push(time[s.at[2]][r] - time[s.at[1]][r]);
      } else {
        d.passing.recorded++;
        if (s.form === 1 && !(h.p.t[r >>> 5] & bit)) {
          if (place[s.at[1]][r] < place[s.at[0]][r]) beforeIt++;
          else afterIt++;
        }
      }
    }
    d.ms = gaps.map(median);
    if (s.form === 1) {
      d.passing.before = beforeIt;
      d.passing.after = afterIt;
    }
    for (let w = 0; w < W; w++) covered[w] |= h.p.t[w] & real[w];
    out.differences.push(d);
  }
  for (let w = 0; w < W; w++) out.covered += pop(covered[w]);
  out.more = strong.reduce((sum, h) => sum + h.p.count, 0) - out.differences.length;
  return out;
}

// ------------------------------------------------------------------------------------------------ from race files

/** A test's runs, from its race files: which failed, which passed, and which cannot be compared. */
export interface TestRuns {
  runs: OrderRun[];
  /** Files whose test failed or timed out, and files whose test passed (with or without steps). */
  failed: number;
  passed: number;
  /** Files of a failed or passed test that carry no steps. */
  withoutSteps: number;
  /** Files with another status (interrupted) or none (written by an older fixture). */
  other: number;
  /** Files whose steps were cut (the test had more than the file holds). */
  cut: number;
}

/** The runs of one test, from its race files (one file per run). A failed or timed-out test is a failing run. */
export function runsOf(files: readonly Pick<GenClassRacesFile, "status" | "steps">[]): TestRuns {
  const out: TestRuns = { runs: [], failed: 0, passed: 0, withoutSteps: 0, other: 0, cut: 0 };
  for (const f of files) {
    const failed = f.status === "failed" || f.status === "timedOut";
    if (!failed && f.status !== "passed") {
      out.other++;
      continue;
    }
    if (failed) out.failed++;
    else out.passed++;
    const events = f.steps ? decodeSteps(f.steps) : [];
    if (events.length === 0) {
      out.withoutSteps++;
      continue;
    }
    if (f.steps?.cut) out.cut++;
    out.runs.push({ failed, events });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ in words

const ORDINALS = ["th", "st", "nd", "rd"];

function ordinal(n: number): string {
  const v = n % 100;
  return `${n}${ORDINALS[(v - 20) % 10] ?? ORDINALS[v] ?? ORDINALS[0]}`;
}

/** A step as a noun phrase: 'the response to the 2nd `POST /api/orders`', 'the action `click button "Apply"`'. */
export function stepText(s: StepRef, quote: (label: string) => string): string {
  const which = s.many ? `the ${ordinal(s.n)} ` : "";
  const name = `${which}${quote(s.label)}`;
  if (s.kind === "a") return s.many ? `${name} action` : `the action ${name}`;
  if (s.kind === "s") return `the sending of ${name}`;
  if (s.kind === "r") return `the response to ${name}`;
  return `the end of ${name} without a response`;
}

/** A statement as a clause: "X came before Y", "X came between A and B". */
export function statementText(s: OrderStatement, quote: (label: string) => string): string {
  const [a, b, c] = s.steps.map((x) => stepText(x, quote));
  return s.form === "pair" ? `${a} came before ${b}` : `${b} came between ${a} and ${c}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** One difference as a sentence, with its counts. */
export function differenceText(d: OrderDifference, x: Pick<OrderExplanation, "failing" | "passing">, quote: (label: string) => string): string {
  const unrecorded = x.passing - d.passing.recorded;
  const others = d.passing.with > 0 ? "in the other passing runs" : "there";
  const where =
    d.form === "between" && d.passing.before !== undefined && d.passing.after !== undefined
      ? `${others} it came before the first of the two in ${d.passing.before} and after the second in ${d.passing.after}`
      : `${others} the order was the other way round`;
  const rest = unrecorded > 0 ? `; ${count(unrecorded, "passing run")} left out, where one of these steps came after the point the failing runs reach, or not at all` : "";
  const gap = d.form === "pair" ? `${d.ms[0]} ms apart` : `${d.ms[0]} ms after the first and ${d.ms[1]} ms before the second`;
  const passing = d.passing.with > 0 ? `in ${d.passing.with} of the ${count(d.passing.recorded, "passing run")}` : `in none of the ${count(d.passing.recorded, "passing run")}`;
  return `In ${d.failing.with} of ${count(x.failing, "failing run")} and ${passing} that recorded these steps, ${statementText(d, quote)} (median ${gap}; ${where}${rest}).`;
}

/** What shuffled outcomes gave, as a sentence. */
export function chanceText(x: OrderExplanation): string {
  const c = x.chance;
  if (!c) return "";
  const tried = c.exact ? `Of the ${count(c.ways, "way")} to choose which ${x.failing} of these ${x.failing + x.passing} runs failed` : `With the outcomes shuffled ${c.ways} times`;
  const each = c.exact ? "over those ways" : "per shuffle";
  // with fewer passing runs than it takes to allow one exception, "next to no" is "no"
  const none = `${x.passing >= PASSING_PER_EXCEPTION ? "next to no" : "no"} passing run has`;
  if (x.strongest === 0) return `${tried}, an order that every failing run has and ${none} turns up ${c.separating} times on average ${each}; here there is none.`;
  const who = x.strongest === x.failing ? "every failing run has" : `at least ${x.strongest} failing run${x.strongest === 1 ? " has" : "s have"}`;
  const strong = `${c.asStrong} ${c.exact ? (c.asStrong === 1 ? "gives" : "give") : "gave"} an order that ${who} and ${none}`;
  const real = c.exact ? " (the real outcomes are one of them)" : "";
  return `${tried}, ${strong}${real}. Orders that every failing run has and ${none}: ${x.separating} here, ${c.separating} on average ${each}.`;
}

/** The verdict as a sentence (without the differences). */
export function verdictText(x: OrderExplanation): string {
  if (x.verdict === "too-few-runs")
    return `Not compared: ${count(x.failing, "failing run")} and ${count(x.passing, "passing run")} with recorded steps, and the comparison needs at least ${x.minimum.failing} failing and ${x.minimum.passing} passing.`;
  if (x.verdict === "no-difference") return `Compared ${count(x.failing, "failing run")} with ${count(x.passing, "passing run")}: no order of steps is the failing runs' alone.`;
  const total = x.differences.length + x.more;
  if (x.verdict === "chance")
    return `Compared ${count(x.failing, "failing run")} with ${count(x.passing, "passing run")}: ${count(total, "order")} of steps ${total === 1 ? "is" : "are"} the failing runs' alone, the most frequent in ${x.strongest} of ${x.failing}, and shuffled outcomes give as much too often to call any of them an explanation. More runs would tell.`;
  const all = x.covered === x.failing ? "every failing run has" : `${x.covered} of the ${x.failing} failing runs have`;
  const none = x.differences.every((d) => d.passing.with === 0) ? "no passing run does" : "next to no passing run does";
  return `Compared ${count(x.failing, "failing run")} with ${count(x.passing, "passing run")}: ${all} ${x.differences.length === 1 ? "this order of steps" : "one of these orders of steps"}, and ${none}.`;
}
