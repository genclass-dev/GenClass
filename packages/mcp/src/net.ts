// A page load's request timing log (genclass-agent/1 `net`, docs/runtime/AGENT.md section 5): each request's start
// index n (its position among the page load's requests, by start time), its send time s, its ready time r (its response
// reached the delivery gate, plus the emulated delay) and its delivery d. The page and the bridge share one overlap
// definition: for a and b with n(a) < n(b), a overlaps b in a run when s(b) < r(a), strictly (the page's lifo and ranked
// bound). An inversion of a run is an overlapping pair whose newer response was delivered first; it comes from that
// run's own timing, no baseline needed.
//
// Only schedulable keys take part: delivered through the schedule's gate (d and r), not released at once by pass()
// (protected requests, responses that reached the app without the gate), not a retry or a hedge (a "~retryN" or
// "~hedge" suffix right after the occurrence number; a "~" in a path, "/~alice/", is part of the path). Everything else
// is left out of overlaps, inversions, coverage, cover rows and probes, and counted. Send and ready times carry the
// page's fractions of a millisecond, so the overlap is the one the page's schedule used. Pure and deterministic (no
// clock, no randomness, no I/O); the numbers come from the page, validated (validate.ts netEntry), and are never
// trusted to be consistent: a bad log gives fewer pairs, never a crash.

import type { NetEntry, Run } from "./types.js";

/** At most this many overlapping pairs per run: a page with thousands of requests in flight together stays cheap. */
export const MAX_PAIRS = 20_000;

/**
 * A retry or a hedge of a keyed request ("GET /api/a#2~retry2", "GET /api/a#2~hedge"): the runtime's suffix always
 * follows the occurrence number, and a path cannot hold a "#", so "GET /~alice/search#1" is a plain key.
 */
export const suffixed = (key: string): boolean => /#\d+~/.test(key);

/** Delivered through the schedule (d and r), not passed at once, not a retry or a hedge. */
export function schedulable(e: NetEntry | undefined): e is NetEntry & { r: number; d: number } {
  return !!e && e.d !== undefined && e.r !== undefined && !e.pass && !suffixed(e.key);
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A run's schedulable entries in start order (start index, then send time, then key). */
export function startOrderOf(net: Record<string, NetEntry> | undefined): (NetEntry & { r: number; d: number })[] {
  return Object.values(net ?? {})
    .filter(schedulable)
    .sort((x, y) => x.n - y.n || x.s - y.s || byKey(x.key, y.key));
}

/**
 * The overlapping pairs [a, b] of one run (n(a) < n(b) and s(b) < r(a)), in start order, at most `max`. Requests are
 * numbered in start order, so for each a the requests sent before it was ready come right after it.
 */
export function overlapOf(net: Record<string, NetEntry> | undefined, max = MAX_PAIRS): [string, string][] {
  const es = startOrderOf(net);
  const out: [string, string][] = [];
  for (let i = 0; i < es.length; i++) {
    const a = es[i];
    for (let j = i + 1; j < es.length; j++) {
      const b = es[j];
      if (b.s >= a.r) break;
      out.push([a.key, b.key]);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Where each response of a run was delivered, as a rank: by delivery time from the timing log, ties by the delivery
 * order; a run without a log (an older page runtime) by its delivery order alone.
 */
export function deliveryRanks(run: Pick<Run, "order" | "net">): Map<string, number> {
  const at = new Map<string, number>();
  run.order.forEach((k, i) => {
    if (!at.has(k)) at.set(k, i);
  });
  if (!run.net) return at;
  const keys = Object.values(run.net)
    .filter((e) => e.d !== undefined)
    .sort((x, y) => x.d! - y.d! || (at.get(x.key) ?? Infinity) - (at.get(y.key) ?? Infinity) || byKey(x.key, y.key));
  return new Map(keys.map((e, i) => [e.key, i]));
}

/** Was `x` delivered before `y`? null when either was not delivered. */
export function deliveredBefore(ranks: Map<string, number>, x: string, y: string): boolean | null {
  const a = ranks.get(x);
  const b = ranks.get(y);
  return a === undefined || b === undefined ? null : a < b;
}

/** The inversions of a run: overlapping pairs [a, b] (a started first) whose b was delivered before a. */
export function inversionsOf(net: Record<string, NetEntry> | undefined, order: string[]): [string, string][] {
  if (!net) return [];
  const ranks = deliveryRanks({ order, net });
  return overlapOf(net).filter(([a, b]) => deliveredBefore(ranks, b, a) === true);
}

/** One string for a pair, in the order given. */
export const pairKey = (a: string, b: string): string => `${a}\n${b}`;

/** One string for a pair, whatever its order (overlaps another run numbered differently). */
export const unorderedKey = (a: string, b: string): string => (a < b ? pairKey(a, b) : pairKey(b, a));

/**
 * One start order for several runs of a scenario (the cover, the coverage): each schedulable key by its start index in
 * the first run that has it, then by that run's place, then by key. With the same requests in every run this is their
 * start order.
 */
export function keyOrder(nets: (Record<string, NetEntry> | undefined)[]): string[] {
  const first = new Map<string, [number, number]>();
  nets.forEach((net, i) => {
    for (const e of startOrderOf(net)) if (!first.has(e.key)) first.set(e.key, [e.n, i]);
  });
  return [...first.entries()].sort((x, y) => x[1][0] - y[1][0] || x[1][1] - y[1][1] || byKey(x[0], y[0])).map(([k]) => k);
}

/** A [string, string][] from stored evidence (a state file is not trusted either). */
export function pairsOf(v: unknown, max = 2000): [string, string][] {
  if (!Array.isArray(v)) return [];
  const out: [string, string][] = [];
  for (const p of v) {
    if (Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string") out.push([p[0], p[1]]);
    if (out.length >= max) break;
  }
  return out;
}
