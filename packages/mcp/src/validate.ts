// Validation of what pages send to the bridge (genclass-agent/1). A page is untrusted: every field is type-checked,
// every string and list capped, unknown fields dropped. Invalid parts are skipped, never half-stored.

import type { ActStep, DecisionRec, ErrorRec, ExplainRec, NetEntry, ScheduleOrder, ScheduleSpec, Snapshot, Step, Witness } from "./types.js";
import { num, str } from "./text.js";

const ORDERS: readonly ScheduleOrder[] = ["natural", "fifo", "seeded", "given", "lifo", "ranked"];
/** Timing entries kept per page load (the page keeps at most 2,000 too). */
export const MAX_NET = 2000;
/** Store fields kept per snapshot (the page sends at most 1,000: packages/runtime/src/agent/index.ts SNAPSHOT_FIELDS). */
const MAX_STATE = 1200;
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const int = (v: unknown, max: number): number | undefined => {
  const n = num(v);
  return n === undefined || n < 0 ? undefined : Math.min(Math.floor(n), max);
};
/** A time in ms, at least 0 and at most `max`, to the microsecond (net entries' send and ready times keep fractions). */
const ms = (v: unknown, max: number): number | undefined => {
  const n = num(v);
  return n === undefined || n < 0 ? undefined : Math.min(Math.round(n * 1000) / 1000, max);
};
const strs = (v: unknown, maxItems: number, maxLen: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, maxItems).map((s) => s.slice(0, maxLen)) : []);

export function spec(v: unknown): ScheduleSpec | null {
  const o = obj(v);
  if (!o || !ORDERS.includes(o.order as ScheduleOrder)) return null;
  const out: ScheduleSpec = { order: o.order as ScheduleOrder };
  const seed = int(o.seed, 2 ** 31);
  if (seed !== undefined) out.seed = seed;
  // only true is a reverse; anything else is ignored, not rejected (as the page's parseSpec)
  if (o.reverse === true) out.reverse = true;
  if (out.order === "given") out.given = strs(o.given, 2000, 300);
  // ranked without ranks is ranked over nothing: request order, as fifo
  if (out.order === "ranked") out.ranks = strs(o.ranks, 2000, 300);
  if (Array.isArray(o.focus)) out.focus = strs(o.focus, 20, 300);
  const d = obj(o.delay);
  if (d) {
    const lo = int(d.minMs, 10_000) ?? 0;
    out.delay = { minMs: lo, maxMs: Math.max(lo, int(d.maxMs, 10_000) ?? lo) };
  }
  const ds = int(o.delaySeed, 2 ** 31);
  if (ds !== undefined) out.delaySeed = ds;
  const mh = int(o.maxHoldMs, 30_000);
  if (mh !== undefined) out.maxHoldMs = mh;
  const gap = int(o.gapMs, 1000);
  if (gap !== undefined) out.gapMs = gap;
  const id = str(o.id, 100);
  if (id) out.id = id;
  const label = str(o.label, 200);
  if (label) out.label = label;
  return out;
}

/** A page load's hello, validated. */
export interface HelloInfo {
  url: string;
  route: string;
  title?: string;
  ua?: string;
  mode?: string;
  model?: string;
  /** The schedule the page set itself (a test, a URL), when the bridge knows its order. */
  schedule: ScheduleSpec | null;
  /** The page set a schedule of an order this bridge does not know: it gets no assignment. */
  scheduleUnknown?: boolean;
  /** What its runtime can run beyond the first four orders; absent from an older runtime. */
  caps?: string[];
}

export function hello(v: unknown): HelloInfo | null {
  const o = obj(v);
  const page = obj(o?.page);
  if (!o || !page) return null;
  const rt = obj(o.runtime);
  const out: HelloInfo = {
    url: str(page.url, 2000) ?? "",
    route: str(page.route, 500) ?? "/",
    schedule: spec(o.schedule),
  };
  if (o.schedule !== undefined && o.schedule !== null && !out.schedule) out.scheduleUnknown = true;
  if (Array.isArray(o.caps)) out.caps = strs(o.caps, 20, 40);
  const title = str(page.title, 200);
  if (title) out.title = title;
  const ua = str(o.ua, 300);
  if (ua) out.ua = ua;
  const mode = str(rt?.mode, 20);
  if (mode) out.mode = mode;
  const model = str(rt?.model, 20);
  if (model) out.model = model;
  return out;
}

export function step(v: unknown): Step | null {
  const o = obj(v);
  if (!o) return null;
  const t = num(o.t) ?? 0;
  const key = str(o.key, 300);
  switch (o.k) {
    case "act": {
      const a: ActStep = { k: "act", i: int(o.i, 1e6) ?? 0, t, kind: str(o.kind, 40) ?? "action" };
      const target = str(o.target, 200);
      if (target) a.target = target;
      const value = str(o.value, 500);
      if (value !== undefined) a.value = value;
      const k = str(o.key, 40);
      if (k) a.key = k;
      const clicks = int(o.clicks, 10);
      if (clicks !== undefined) a.clicks = clicks;
      const count = int(o.count, 1e6);
      if (count !== undefined) a.count = count;
      const dur = int(o.dur, 1e7);
      if (dur !== undefined) a.dur = dur;
      return a;
    }
    case "send": {
      if (!key) return null;
      const s: Step = { k: "send", t, key };
      const detail = str(o.detail, 200);
      if (detail) s.detail = detail;
      const act = int(o.act, 1e6);
      if (act !== undefined) s.act = act;
      const via = str(o.via, 160);
      if (via) s.via = via;
      return s;
    }
    case "recv": {
      if (!key) return null;
      const s: Step = { k: "recv", t, key };
      const held = int(o.held, 1e7);
      if (held !== undefined) s.held = held;
      if (o.forced === true) s.forced = true;
      const ready = int(o.ready, 1e9);
      if (ready !== undefined) s.ready = ready;
      if (o.pass === true) s.pass = true;
      return s;
    }
    case "end": {
      if (!key) return null;
      const s: Step = { k: "end", t, key, status: str(o.status, 20) ?? "error" };
      if (typeof o.code === "number" || typeof o.code === "string") s.code = typeof o.code === "string" ? o.code.slice(0, 40) : o.code;
      return s;
    }
    case "write": {
      const s: Step = { k: "write", t, store: str(o.store, 120) ?? "", paths: strs(o.paths, 12, 200) };
      const by = str(o.by, 300);
      if (by) s.by = by;
      const act = int(o.act, 1e6);
      if (act !== undefined) s.act = act;
      if (Array.isArray(o.summary)) s.summary = strs(o.summary, 3, 200);
      return s;
    }
    case "error": {
      const s: Step = { k: "error", t, message: str(o.message, 300) ?? "" };
      const by = str(o.by, 300);
      if (by) s.by = by;
      const act = int(o.act, 1e6);
      if (act !== undefined) s.act = act;
      return s;
    }
    default:
      return null;
  }
}

/**
 * One timing entry (the steps event's `net`): key, start index and send time required, the rest as sent and valid. The
 * send and ready times keep their fractions (to the microsecond): the overlap s(b) < r(a) is the page's own comparison.
 */
export function netEntry(v: unknown): NetEntry | null {
  const o = obj(v);
  const key = str(o?.key, 300);
  if (!o || !key) return null;
  const n = int(o.n, 1e6);
  const s = ms(o.s, 1e9);
  if (n === undefined || s === undefined) return null;
  const e: NetEntry = { key, n, s };
  const r = ms(o.r, 1e9);
  if (r !== undefined) e.r = r;
  for (const k of ["d", "held"] as const) {
    const x = int(o[k], 1e9);
    if (x !== undefined) e[k] = x;
  }
  if (o.forced === true) e.forced = true;
  if (o.pass === true) e.pass = true;
  const via = str(o.via, 300);
  if (via) e.via = via;
  const end = str(o.end, 20);
  if (end) e.end = end;
  return e;
}

/**
 * Merge timing entries into a run's log by key (full entries replace older ones). A log has at most MAX_NET keys;
 * returns how many new keys did not fit. The log has no prototype: a key is only ever a key.
 */
export function mergeNet(into: Record<string, NetEntry>, entries: unknown): number {
  if (!Array.isArray(entries)) return 0;
  let size = Object.keys(into).length;
  let dropped = 0;
  for (const x of entries.slice(0, MAX_NET)) {
    const e = netEntry(x);
    if (!e) continue;
    if (!Object.prototype.hasOwnProperty.call(into, e.key)) {
      if (size >= MAX_NET) {
        dropped++;
        continue;
      }
      size++;
    }
    into[e.key] = e;
  }
  return dropped;
}

export function witness(v: unknown): Witness | null {
  const o = obj(v);
  if (!o || (o.kind !== "overwrote-newer" && o.kind !== "identical-in-flight")) return null;
  const subject = str(o.subject, 300);
  const by = str(o.by, 300);
  const over = str(o.over, 300);
  if (!subject || !by || !over) return null;
  const w: Witness = { kind: o.kind, t: num(o.t) ?? 0, subject, by, over, overKind: o.overKind === "user" ? "user" : "request" };
  const bd = str(o.byDetail, 200);
  if (bd) w.byDetail = bd;
  const ba = int(o.byAct, 1e6);
  if (ba !== undefined) w.byAct = ba;
  const oa = int(o.overAct, 1e6);
  if (oa !== undefined) w.overAct = oa;
  const gap = int(o.gapMs, 1e8);
  if (gap !== undefined) w.gapMs = gap;
  const ch = str(o.change, 300);
  if (ch) w.change = ch;
  return w;
}

export function error(v: unknown): ErrorRec | null {
  const o = obj(v);
  if (!o) return null;
  const e: ErrorRec = { t: num(o.t) ?? 0, name: str(o.name, 80) ?? "Error", message: str(o.message, 300) ?? "", chain: strs(o.chain, 10, 200) };
  const source = str(o.source, 200);
  if (source) e.source = source;
  const stack = str(o.stack, 3000);
  if (stack) e.stack = stack;
  const act = int(o.act, 1e6);
  if (act !== undefined) e.act = act;
  return e;
}

export function snapshot(v: unknown): Snapshot | null {
  const o = obj(v);
  if (!o) return null;
  const rec = (x: unknown, maxItems: number): Record<string, string> => {
    const r = obj(x);
    const out: Record<string, string> = {};
    if (!r) return out;
    let n = 0;
    for (const [k, val] of Object.entries(r)) {
      if (n++ >= maxItems) break;
      if (typeof val === "string") out[k.slice(0, 200)] = val.slice(0, 200);
    }
    return out;
  };
  const requests: Record<string, number> = {};
  const rq = obj(o.requests);
  if (rq) for (const [k, n] of Object.entries(rq).slice(0, 200)) if (typeof n === "number") requests[k.slice(0, 200)] = n;
  const s: Snapshot = { t: num(o.t) ?? 0, state: rec(o.state, MAX_STATE), requests, witnesses: int(o.witnesses, 1e6) ?? 0, errors: int(o.errors, 1e6) ?? 0, forced: int(o.forced, 1e6) ?? 0 };
  const left = int(o.stateLeft, 1e7);
  if (left) {
    s.stateLeft = left;
    s.stateTotal = Math.max(left, int(o.stateTotal, 1e7) ?? 0);
  }
  if (Array.isArray(o.text)) s.text = strs(o.text, 300, 160);
  if (Array.isArray(o.live) && o.live.length) s.live = strs(o.live, 50, 160);
  if (o.fields !== undefined) s.fields = rec(o.fields, 100);
  return s;
}

export function decision(v: unknown): DecisionRec | null {
  const o = obj(v);
  if (!o) return null;
  const d: DecisionRec = {};
  for (const k of ["id", "trigger", "diagnosis", "action", "detection", "reason"] as const) {
    const s = str(o[k], 120);
    if (s) d[k] = s;
  }
  const subject = str(o.subject, 300);
  if (subject) d.subject = subject;
  for (const k of ["diagnosisConfidence", "confidence"] as const) {
    const n = num(o[k]);
    if (n !== undefined) d[k] = n;
  }
  if (typeof o.executed === "boolean") d.executed = o.executed;
  d.facts = strs(o.facts, 12, 300);
  return d;
}

export function explain(v: unknown): ExplainRec | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const e: ExplainRec = {};
  const m = str(o.message, 600);
  if (m) e.message = m;
  if (Array.isArray(o.timeline)) e.timeline = strs(o.timeline, 16, 200);
  const s = str(o.situation, 4000);
  if (s) e.situation = s;
  const c = str(o.changed, 400);
  if (c) e.changed = c;
  return e;
}

/** A small JSON value for checks, expectations and actions (depth and size bounded). */
export function small(v: unknown, depth = 3): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const o = obj(v);
  if (!o) return out;
  let n = 0;
  for (const [k, val] of Object.entries(o)) {
    if (n++ >= 30) break;
    if (typeof val === "string") out[k.slice(0, 60)] = val.slice(0, 300);
    else if (typeof val === "number" || typeof val === "boolean" || val === null) out[k.slice(0, 60)] = val;
    else if (Array.isArray(val)) out[k.slice(0, 60)] = val.slice(0, 10).map((x) => (typeof x === "string" ? x.slice(0, 200) : typeof x === "number" ? x : depth > 1 ? small(x, depth - 1) : null));
    else if (depth > 1 && obj(val)) out[k.slice(0, 60)] = small(val, depth - 1);
  }
  return out;
}

export function baselines(v: unknown): { sig: string; count: number; median?: number; p95?: number; errorRate: number; failStreak: number }[] {
  if (!Array.isArray(v)) return [];
  const out: { sig: string; count: number; median?: number; p95?: number; errorRate: number; failStreak: number }[] = [];
  for (const x of v.slice(0, 200)) {
    const o = obj(x);
    const sig = str(o?.sig, 200);
    if (!o || !sig) continue;
    const b: { sig: string; count: number; median?: number; p95?: number; errorRate: number; failStreak: number } = { sig, count: int(o.count, 1e9) ?? 0, errorRate: num(o.errorRate) ?? 0, failStreak: int(o.failStreak, 1e6) ?? 0 };
    const md = num(o.median);
    if (md !== undefined) b.median = md;
    const p = num(o.p95);
    if (p !== undefined) b.p95 = p;
    out.push(b);
  }
  return out;
}
