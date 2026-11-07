// The bridge's state (docs/runtime/AGENT.md section 4): page loads (runs) and what they sent, the findings derived
// from them, explore sessions and armed replays. Findings are deduplicated by a key made of their kind, route and
// signatures (state paths by shape: a new record's id does not make a new bug), and ranked by kind, then count, then
// recency. Persisted as one JSON file in the state directory (which ignores itself in git) so a new agent session sees
// what the last one found; runs a finding needs are always kept.
//
// Findings name facts the page recorded (a response that overwrote newer data, identical requests from two clicks, an
// uncaught error, an explore run whose final state differs from the request-order baseline) or the on-device model's
// own detections, labelled as such. The bridge adds no judgement of its own. Every page string in a title is quoted.
//
// A run belongs to the page that registered it: events must come from the same origin with the token it got at hello.
//
// Schedules a page's runtime cannot run (its hello `caps`) are never sent to it: an explore slot gets a stand-in it can
// run (labelled), a replay its finding's recorded delivery order, and a minimise probe waits for a page that can. The
// systematic plan's cover rows are computed when a baseline (or the lifo load) settles, never at hello, and fixed from
// the first cover row handed out.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareRuns, endedDifferently, fieldValue, nameDifference, sameScenario, sameValue, settledAfterActs, shownField, stateValue, strongestFirst, type FieldDiff, type GroupReport, type RunDiff, multiset } from "./compare.js";
import { buildCover, type Cover } from "./cover.js";
import { inversionsOf, pairKey, pairsOf, startOrderOf } from "./net.js";
import { agesIn, clean, pathShape, q, routeShape, sameAges, shape, sigOf, type Elapsed } from "./text.js";
import type { ExploreSession, Finding, FindingKind, MinimizeArm, NetEntry, PlanSlot, Probe, ReplayArm, Run, ScheduleSpec, Step } from "./types.js";
import * as V from "./validate.js";

const MAX_RUNS = 300;
const MAX_FINDINGS = 500;
const MAX_STEPS = 3000;
const SAVED_RUNS = 80;
/** Armed explores and replays expire: a page load hours later is not given a held schedule by surprise. */
export const ARM_TTL_MS = 30 * 60_000;
const RANK: Record<FindingKind, number> = { race: 0, "stale-write": 1, error: 2, "duplicate-request": 3, detection: 4, check: 5, expectation: 6, intervention: 7 };

export interface StoreOptions {
  /** Directory for state.json (default: none, in memory only). */
  dir?: string;
  now?: () => number;
}

export interface FindingEvent {
  finding: Finding;
  fresh: boolean;
}

export interface Hello {
  run: string;
  token: string;
  schedule: ScheduleSpec | null;
}

/** Minimise probes armed at once (the smallest reorderings first). */
export const MAX_PROBES = 12;

/** One probe's verdict (minimizeResult). */
export interface ProbeResult {
  index: number;
  label: string;
  a: string;
  b: string;
  between: number;
  variant: 1 | 2;
  run?: string;
  /** pending: not run or not settled yet; rejected: its page could not run it; inconclusive: see the note; done. */
  state: "pending" | "rejected" | "inconclusive" | "done";
  reproduced: boolean | null;
  /** Ran the intended order (and nothing else) and the verdict is yes or no. */
  conclusive: boolean;
  note: string;
  /** The inversions its run delivered (at most 50). */
  realised?: [string, string][];
}

/** Which minimise probes of a race finding reproduced it, and the smallest reordering that does. */
export interface MinimizeResult {
  finding: string;
  route?: string;
  probes: ProbeResult[];
  /** Probes past the first 12 that were not armed. */
  leftOut: number;
  /** Probes still waiting for a page load (or for one to settle). */
  pending: number;
  /** The first reproducing probe, every earlier one conclusive: the finding now replays it. */
  minimal?: { run: string; label: string; a: string; b: string; between: number; variant: 1 | 2; exact: boolean; inverted: [string, string][] };
  /** Every probe was conclusive, none was left out and none reproduced it. */
  none?: boolean;
}

/** The cover of a systematic session, and whether it is fixed (one of its rows was handed out). */
type CoverState = Cover & { frozen: boolean };

/** The caps a schedule needs beyond natural, fifo, seeded and given. */
export function capsNeeded(spec: ScheduleSpec): string[] {
  const out: string[] = [];
  if (spec.order === "lifo" || spec.order === "ranked") out.push(spec.order);
  if (spec.reverse) out.push("reverse");
  if (spec.delaySeed !== undefined) out.push("delaySeed");
  return out;
}

const lacking = (spec: ScheduleSpec, caps: string[] | undefined): string[] => capsNeeded(spec).filter((c) => !(caps ?? []).includes(c));

/**
 * Without delaySeed, an order whose priorities do not come from its seed (all but seeded) takes the delay seed as its
 * seed: a runtime without delaySeed hashes the delays from the seed, so they stay the same.
 */
function seedForDelays(spec: ScheduleSpec): ScheduleSpec {
  const s: ScheduleSpec = { ...spec };
  if (s.delaySeed === undefined) return s;
  if (s.order !== "seeded") s.seed = s.delaySeed;
  delete s.delaySeed;
  return s;
}

/** A note on a run (bridge text, at most 20 per run). */
function note(run: Run, text: string): void {
  const notes = run.notes ?? (run.notes = []);
  const t = text.slice(0, 300);
  if (!notes.includes(t) && notes.length < 20) notes.push(t);
}

export class Store {
  runs = new Map<string, Run>();
  findings = new Map<string, Finding>();
  byKey = new Map<string, string>();
  explores = new Map<string, ExploreSession>();
  replays: ReplayArm[] = [];
  /** Armed minimise probes (in memory only, like replay arms). */
  minimizes: MinimizeArm[] = [];
  /** Cover rows of systematic explore sessions, by session id (never saved: a restored session is stopped). */
  private covers = new Map<string, CoverState>();
  private nextRun = 1;
  private nextFinding = 1;
  private nextExplore = 1;
  private saveTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(e: FindingEvent) => void>();
  readonly now: () => number;
  /** This store's identity for digest cursors (a cursor from another process means "from the start"). */
  readonly epoch = randomUUID();
  /** Monotonic counter of finding changes (digest cursors). */
  version = 0;
  private changedAt = new Map<string, number>();

  constructor(private readonly opts: StoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    if (opts.dir) this.load();
  }

  onFinding(fn: (e: FindingEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------------------------------- page side

  /**
   * A page load said hello: a run, and the schedule the agent armed for it (a replay first, then a minimise probe, then
   * an explore plan), fitted to what its runtime can run.
   */
  hello(body: unknown, origin?: string): Hello | null {
    const h = V.hello(body);
    if (!h) return null;
    const id = `r${this.nextRun++}`;
    const now = this.now();
    const run: Run = {
      id,
      started: now,
      lastSeen: now,
      page: { url: h.url, route: h.route, ...(h.title ? { title: h.title } : {}) },
      schedule: h.schedule,
      steps: [],
      lost: 0,
      order: [],
      forced: 0,
      witnesses: [],
      errors: [],
      detections: [],
      interventions: [],
      checks: [],
      expectations: [],
      snapshots: 0,
      ended: false,
      token: randomBytes(16).toString("hex"),
    };
    if (origin) run.origin = origin;
    if (h.ua) run.ua = h.ua;
    if (h.mode || h.model) run.runtime = { ...(h.mode ? { mode: h.mode } : {}), ...(h.model ? { model: h.model } : {}) };
    if (h.caps) run.caps = h.caps;
    // a schedule the page set itself (a regression test, a URL, hold: false) wins; otherwise what the agent armed. One
    // of an order this bridge does not know is the page's own too: nothing is assigned over it.
    if (h.scheduleUnknown) note(run, "page-set schedule of an unknown order");
    else if (!h.schedule) {
      // one page to a schedule, even when it has a new path on every load (/session/<id>)
      const here = routeShape(h.route);
      if (!this.assignReplay(run, here, now) && !this.assignProbe(run, here, now)) this.assignExplore(run, h.route, here, now);
    }
    this.runs.set(id, run);
    if (this.runs.size > MAX_RUNS) {
      const pin = this.pinnedIds();
      const old = [...this.runs.values()].filter((r) => !pin.has(r.id)).sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (old) this.runs.delete(old.id);
    }
    this.saveSoon();
    return { run: id, token: run.token!, schedule: run.schedule };
  }

  /** The replay armed for this page's route, if its runtime can run it (or its recorded order stands in). */
  private assignReplay(run: Run, here: string, now: number): boolean {
    const arm = this.replays.find((r) => r.remaining > 0 && now - r.created < ARM_TTL_MS && (!r.route || routeShape(r.route) === here));
    if (!arm) return false;
    const fit = this.fitReplay(arm, run.caps);
    if (!fit) {
      note(run, `this page's runtime cannot run ${lacking(arm.spec, run.caps).join(", ")}, which the replay of ${arm.finding} needs, and the run that recorded it is gone: the replay waits for a page with a newer @genclass/runtime`);
      return false;
    }
    arm.remaining--;
    arm.runs.push(run.id);
    run.schedule = { ...fit.spec, id: arm.finding, label: fit.label };
    run.assignment = { kind: "replay", ref: arm.finding, index: arm.runs.length - 1, label: fit.label };
    if (fit.missing.length) note(run, `this page's runtime cannot run ${fit.missing.join(", ")}: it ran ${fit.label}`);
    return true;
  }

  /**
   * A replay for a page's runtime: as armed when it can run it; without delaySeed alone, the same delays from the seed;
   * otherwise the finding run's recorded delivery order. Null when that run is gone too.
   */
  private fitReplay(arm: ReplayArm, caps: string[] | undefined): { spec: ScheduleSpec; label: string; missing: string[] } | null {
    const label = `replay of ${arm.finding}`;
    const missing = lacking(arm.spec, caps);
    if (!missing.length) return { spec: arm.spec, label, missing };
    if (missing.length === 1 && missing[0] === "delaySeed" && arm.spec.order !== "seeded") {
      const spec = seedForDelays(arm.spec);
      return { spec, label: `${label} (page runtime has no delaySeed: delays from seed ${spec.seed})`, missing };
    }
    const f = this.findings.get(arm.finding);
    const fr = f?.run ? this.runs.get(f.run) : undefined;
    if (!fr || !fr.order.length) return null;
    return { spec: { order: "given", given: fr.order.slice() }, label: `${label} (page runtime has no ${missing.join(", ")}: recorded order)`, missing };
  }

  /** The next minimise probe for this page's route; only a runtime that runs the ranked order gets one. */
  private assignProbe(run: Run, here: string, now: number): boolean {
    if (!(run.caps ?? []).includes("ranked")) return false;
    for (const m of this.minimizes) {
      if (now - m.created >= ARM_TTL_MS || (m.route && routeShape(m.route) !== here)) continue;
      const i = m.probes.findIndex((p) => !p.run && !p.rejected);
      if (i < 0) continue;
      const p = m.probes[i];
      const missing = lacking(p.spec, run.caps);
      const spec = missing.includes("delaySeed") ? seedForDelays(p.spec) : p.spec;
      const label = `${p.spec.label ?? `minimise ${i + 1}`}${missing.length ? ` (page runtime has no ${missing.join(", ")})` : ""}`;
      p.run = run.id;
      run.schedule = { ...spec, id: m.finding, label };
      run.assignment = { kind: "minimize", ref: m.finding, index: i, label };
      if (missing.length) note(run, `this page's runtime cannot run ${missing.join(", ")}: it ran ${label}`);
      return true;
    }
    return false;
  }

  /** The next position of the explore session armed for this page's route, resolved and fitted to its runtime. */
  private assignExplore(run: Run, route: string, here: string, now: number): void {
    const x = [...this.explores.values()].find((s) => s.state === "armed" && now - s.created < ARM_TTL_MS && (!s.route || routeShape(s.route) === here));
    if (!x) return;
    // an explore armed without a route belongs to the page of its first load: other pages and tabs keep out
    if (!x.route) x.route = route;
    const pos = x.next;
    this.resolveSlot(x, pos);
    const fit = this.fitExplore(x, pos, run.caps);
    const label = fit.spec.label ?? `explore ${pos + 1}`;
    run.schedule = { ...fit.spec, id: x.id, label };
    run.assignment = { kind: "explore", ref: x.id, index: pos, label };
    if (fit.missing.length) note(run, `this page's runtime cannot run ${fit.missing.join(", ")}: it ran ${label}`);
    x.runs.push(run.id);
    x.next++;
    if (x.next >= x.plan.length) x.state = "collecting";
  }

  /**
   * A pending cover slot gets its schedule at its page load: cover row k when the baselines gave one, else its seeded
   * stand-in. The plan holds the resolved schedule from then on (a slot given back re-queues it as it is), and the
   * cover rows are fixed from the first row handed out (a stand-in handed out before the baselines settled fixes
   * nothing: later slots still get their rows).
   */
  private resolveSlot(x: ExploreSession, pos: number): void {
    const slot = x.slots?.[pos];
    if (!slot || slot.kind !== "cover" || !slot.pending) return;
    const cover = this.covers.get(x.id);
    const row = cover?.rows[slot.k];
    if (cover && row) cover.frozen = true;
    x.plan[pos] = row ? { order: "ranked", ranks: row.slice(), ...(x.shared ?? {}), label: `cover row ${slot.k + 1}` } : this.coverStandIn(x, slot.k, true);
    x.slots![pos] = { ...slot, pending: false };
  }

  /** A seeded schedule of the session (its focus and shared fields): "seed N" or "seed N reversed". */
  private standIn(x: ExploreSession, seed: number, reverse: boolean): ScheduleSpec {
    return { order: "seeded", seed, ...(reverse ? { reverse: true } : {}), ...(x.focus?.length ? { focus: x.focus.slice(0, 20) } : {}), ...(x.shared ?? {}), label: reverse ? `seed ${seed} reversed` : `seed ${seed}` };
  }

  /** Cover slot k without a cover row: seed seed0 + 1 + floor(k / 2), reversed when k is odd; without reverse, seed0 + 1 + k. */
  private coverStandIn(x: ExploreSession, k: number, reverse: boolean): ScheduleSpec {
    const seed0 = x.seed0 ?? 1;
    return reverse ? this.standIn(x, seed0 + 1 + Math.floor(k / 2), k % 2 === 1) : this.standIn(x, seed0 + 1 + k, false);
  }

  /**
   * An explore position for a page's runtime: as planned when it can run it; otherwise the lifo load becomes seed seed0,
   * a cover row its seeded stand-in, a reversed seed seed0 + 1 + k, and delaySeed the seed of the delays (labelled).
   */
  private fitExplore(x: ExploreSession, pos: number, caps: string[] | undefined): { spec: ScheduleSpec; missing: string[] } {
    const spec = x.plan[pos];
    const missing = lacking(spec, caps);
    if (!missing.length) return { spec, missing };
    const has = (c: string) => (caps ?? []).includes(c);
    const slot = x.slots?.[pos] ?? null;
    const k = slot?.kind === "cover" ? slot.k : 0;
    let s: ScheduleSpec = { ...spec };
    if (s.order === "lifo" && !has("lifo")) s = this.standIn(x, x.seed0 ?? 1, false);
    else if (s.order === "ranked" && !has("ranked")) s = this.coverStandIn(x, k, has("reverse"));
    if (s.reverse && !has("reverse")) {
      if (slot?.kind === "cover") s = this.coverStandIn(x, k, false);
      else delete s.reverse;
    }
    if (s.delaySeed !== undefined && !has("delaySeed")) s = seedForDelays(s);
    return { spec: { ...s, label: `${s.label ?? spec.label ?? `explore ${pos + 1}`} (page runtime has no ${missing.join(", ")})` }, missing };
  }

  /** Runs a finding, a live explore session, an armed replay or a minimise probe refers to: never dropped, always saved. */
  private pinnedIds(): Set<string> {
    const pin = new Set<string>();
    for (const f of this.findings.values()) {
      if (f.run) pin.add(f.run);
      for (const r of f.replays) pin.add(r.run);
      const m = (f.evidence as { minimal?: unknown }).minimal as { run?: unknown } | undefined;
      if (m && typeof m === "object" && typeof m.run === "string") pin.add(m.run);
    }
    for (const x of this.explores.values()) if (x.state !== "stopped") for (const r of x.runs) pin.add(r);
    for (const a of this.replays) for (const r of a.runs) pin.add(r);
    for (const m of this.minimizes) for (const p of m.probes) if (p.run) pin.add(p.run);
    return pin;
  }

  /**
   * A batch of events from a page. Only the page that registered the run may send them (same origin, its token).
   * Invalid events are skipped. Returns how many were applied.
   */
  events(body: unknown, origin?: string): number {
    const o = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const run = o && typeof o.run === "string" ? this.runs.get(o.run) : undefined;
    if (!run || !Array.isArray(o?.events)) return 0;
    if (run.origin !== undefined && run.origin !== origin) return 0;
    if (run.token !== undefined && o!.token !== run.token) return 0;
    run.lastSeen = this.now();
    let n = 0;
    for (const ev of (o!.events as unknown[]).slice(0, 200)) {
      if (!ev || typeof ev !== "object") continue;
      try {
        if (this.apply(run, ev as Record<string, unknown>)) n++;
      } catch {
        /* skip a bad event */
      }
    }
    this.saveSoon();
    return n;
  }

  private apply(run: Run, e: Record<string, unknown>): boolean {
    const route = run.page.route;
    switch (e.t) {
      case "steps": {
        for (const s of Array.isArray(e.steps) ? e.steps.slice(0, 1000) : []) {
          const st = V.step(s);
          if (!st) continue;
          // a typing burst sent again with its latest value replaces the earlier copy of that action
          if (st.k === "act") {
            const i = run.steps.findIndex((x) => x.k === "act" && x.i === st.i);
            if (i >= 0) {
              run.steps[i] = st;
              continue;
            }
          }
          run.steps.push(st);
        }
        if (run.steps.length > MAX_STEPS) run.steps.splice(0, run.steps.length - MAX_STEPS);
        if (Array.isArray(e.order)) {
          const order = e.order.filter((k): k is string => typeof k === "string").slice(-400).map((k) => k.slice(0, 300));
          // the page sends its newest keys; keep the full order by appending what is new
          run.order = mergeOrder(run.order, order);
        }
        if (typeof e.forced === "number") run.forced = Math.max(0, Math.floor(e.forced));
        if (typeof e.lost === "number") run.lost += Math.max(0, Math.floor(e.lost));
        // the timing log: entries new or changed since the page's last send, merged by key
        if (Array.isArray(e.net)) {
          const net = run.net ?? (Object.create(null) as Record<string, NetEntry>);
          const dropped = V.mergeNet(net, e.net);
          run.net = net;
          if (dropped) run.netLost = (run.netLost ?? 0) + dropped;
        }
        if (typeof e.netLost === "number" && Number.isFinite(e.netLost) && e.netLost > 0) run.netLost = Math.max(run.netLost ?? 0, Math.min(1e9, Math.floor(e.netLost)));
        return true;
      }
      case "snapshot":
      case "end": {
        const s = V.snapshot(e.snapshot);
        if (s) {
          run.snapshot = s;
          run.snapshots++;
          this.coverAfter(run);
        }
        if (e.t === "end") run.ended = true;
        return true;
      }
      case "schedule": {
        const spec = V.spec(e.spec);
        if (!spec) return false;
        // the page's runtime rejected the schedule the bridge sent and delivers as responses arrive
        if (e.fallback === true) this.fellBack(run, typeof e.rejected === "string" ? e.rejected.slice(0, 20) : "?");
        // or it applied another schedule than the bridge assigned (its hello reply came too late)
        else this.unassign(run);
        run.schedule = spec;
        return true;
      }
      case "witness": {
        const w = V.witness(e.witness);
        if (!w || run.witnesses.length >= 200) return false;
        run.witnesses.push(w);
        if (w.kind === "overwrote-newer") {
          const over = w.overKind === "user" ? `the user's ${q(w.over, 80)}` : `a newer ${q(sigOf(w.over), 120)}`;
          this.upsert(`stale|${route}|${pathShape(w.subject)}|${sigOf(w.by)}`, "stale-write", route, run, {
            title: `The response to ${q(sigOf(w.by), 120)}${w.byDetail ? ` ${q(w.byDetail, 60)}` : ""} overwrote ${q(w.subject, 80)} after ${over} had already written it`,
            evidence: { ...w },
          });
        } else {
          this.upsert(`dup|${route}|${w.subject}`, "duplicate-request", route, run, {
            title: `${q(w.subject, 100)} was sent twice, ${w.gapMs ?? "?"} ms apart, by two separate user actions while the first was in flight`,
            evidence: { ...w },
          });
        }
        return true;
      }
      case "error": {
        const er = V.error(e.error);
        if (!er || run.errors.length >= 200) return false;
        run.errors.push(er);
        const top = er.stack?.split("\n").find((l) => /\bat\b|@/.test(l))?.trim() ?? er.source ?? "";
        this.upsert(`err|${route}|${er.name}|${shape(er.message)}|${shape(top)}`, "error", route, run, {
          title: `Uncaught ${q(er.message, 120)}${er.chain.length ? ` after ${q(er.chain[0], 80)}` : ""}`,
          evidence: { ...er, stack: er.stack?.split("\n").slice(0, 12).join("\n") },
        });
        return true;
      }
      case "detection": {
        const d = V.decision(e.decision);
        if (!d) return false;
        const x = V.explain(e.explain);
        run.detections.push({ at: Number(e.at) || 0, decision: d, ...(x ? { explain: x } : {}) });
        if (run.detections.length > 200) run.detections.shift();
        const subj = d.subject ?? "";
        this.upsert(`det|${route}|${d.trigger}|${d.diagnosis}|${shape(subj)}`, "detection", route, run, {
          title: `The on-device model diagnosed ${q(d.diagnosis, 30)} (${Math.round((d.diagnosisConfidence ?? 0) * 100)}%, ${q(d.detection, 20)}) at the ${q(d.trigger, 20)} of ${q(subj, 100)}`,
          evidence: { decision: d, ...(x ? { explain: x } : {}) },
        });
        return true;
      }
      case "intervention": {
        const a = V.small(e.action);
        const x = V.explain(e.explain);
        run.interventions.push({ at: Number(e.at) || 0, action: a, ...(x ? { explain: x } : {}) });
        if (run.interventions.length > 200) run.interventions.shift();
        this.upsert(`act|${route}|${clean(a.action, 30)}|${shape(String(a.subject ?? ""))}`, "intervention", route, run, {
          title: `GenClass ran ${q(a.action, 30)} on ${q(a.subject, 100)}: ${q(a.changed, 160)}`,
          evidence: { action: a, ...(x ? { explain: x } : {}) },
        });
        return true;
      }
      case "check": {
        const c = V.small(e.check);
        run.checks.push({ at: Number(e.at) || 0, check: c });
        if (run.checks.length > 200) run.checks.shift();
        this.upsert(`check|${route}|${clean(c.kind, 40)}|${shape(String(c.selector ?? c.message ?? ""))}`, "check", route, run, {
          title: `Visual check ${q(c.kind, 40)}: ${q(c.message ?? c.selector, 160)}`,
          evidence: { check: c },
        });
        return true;
      }
      case "expectation": {
        const x = V.small(e.expectation);
        run.expectations.push({ at: Number(e.at) || 0, expectation: x });
        if (run.expectations.length > 200) run.expectations.shift();
        this.upsert(`exp|${route}|${clean(x.kind, 40)}|${shape(String(x.signature ?? x.field ?? ""))}`, "expectation", route, run, {
          title: `A learned step did not happen: ${q(x.message ?? x.signature ?? x.field, 160)}`,
          evidence: { expectation: x },
        });
        return true;
      }
      case "learned": {
        run.learned = V.small(e.learned, 4);
        run.baselines = V.baselines(e.baselines);
        return true;
      }
      default:
        return false;
    }
  }

  /** Give a run's explore slot, replay or minimise probe back: the page did not run what it was assigned. */
  private unassign(run: Run): void {
    const a = run.assignment;
    if (!a) return;
    if (a.kind === "explore") {
      const x = this.explores.get(a.ref);
      if (x) {
        x.runs = x.runs.filter((r) => r !== run.id);
        const spec = x.plan[a.index];
        if (spec && x.state !== "stopped") {
          // a resolved schedule goes back as it is (no cover slot is resolved twice)
          x.plan.push({ ...spec });
          if (x.slots) x.slots.push(this.slotCopy(x, a.index));
          if (x.state === "collecting") x.state = "armed";
        }
      }
    } else if (a.kind === "minimize") {
      const p = this.minimizes.find((m) => m.finding === a.ref)?.probes[a.index];
      if (p && p.run === run.id) delete p.run;
    } else {
      const arm = this.replays.find((r) => r.finding === a.ref && r.runs.includes(run.id));
      if (arm) {
        arm.runs = arm.runs.filter((r) => r !== run.id);
        arm.remaining++;
      }
    }
    delete run.assignment;
  }

  private slotCopy(x: ExploreSession, index: number): PlanSlot | null {
    const s = x.slots?.[index];
    return !s ? null : s.kind === "cover" ? { kind: "cover", k: s.k, pending: false } : { kind: s.kind };
  }

  /**
   * The page's runtime rejected the schedule the bridge sent (it runs natural). The rejected schedule is not queued
   * again: an explore position comes back once as a stand-in any runtime runs (labelled), a replay is not re-armed for
   * it, and a probe is not assigned again. Nothing loops.
   */
  private fellBack(run: Run, rejected: string): void {
    note(run, `its runtime rejected the schedule ${JSON.stringify(clean(rejected, 20))} the bridge sent: responses were delivered as they arrived`);
    const a = run.assignment;
    if (!a) return;
    if (a.kind === "explore") {
      const x = this.explores.get(a.ref);
      if (x) {
        x.runs = x.runs.filter((r) => r !== run.id);
        const subs = x.substituted ?? (x.substituted = []);
        if (x.plan[a.index] && x.state !== "stopped" && !subs.includes(a.index)) {
          const { spec } = this.fitExplore(x, a.index, []);
          x.plan.push({ ...spec, label: `${spec.label ?? `explore ${a.index + 1}`} (again, after a page fell back)` });
          if (x.slots) x.slots.push(this.slotCopy(x, a.index));
          subs.push(x.plan.length - 1);
          if (x.state === "collecting") x.state = "armed";
        }
      }
    } else if (a.kind === "minimize") {
      const p = this.minimizes.find((m) => m.finding === a.ref)?.probes[a.index];
      if (p && p.run === run.id) {
        delete p.run;
        p.rejected = true;
      }
    } else {
      const arm = this.replays.find((r) => r.finding === a.ref && r.runs.includes(run.id));
      if (arm) arm.runs = arm.runs.filter((r) => r !== run.id);
    }
    delete run.assignment;
  }

  /**
   * After a snapshot: a settled baseline or lifo load of a systematic session refreshes its cover rows, until one of
   * them was handed out (never at hello: that answer stays fast).
   */
  private coverAfter(run: Run): void {
    const a = run.assignment;
    if (a?.kind !== "explore") return;
    const x = this.explores.get(a.ref);
    if (!x || x.strategy !== "systematic" || x.state === "stopped" || this.covers.get(x.id)?.frozen) return;
    const order = x.plan[a.index]?.order;
    if ((order !== "fifo" && order !== "lifo") || !settledAfterActs(run)) return;
    const mine = x.runs.map((id) => this.runs.get(id)).filter((r): r is Run => !!r && r.assignment?.kind === "explore" && r.assignment.ref === x.id && settledAfterActs(r) && !!r.net);
    const at = (r: Run) => x.plan[r.assignment!.index]?.order;
    const cover = buildCover({ baselines: mine.filter((r) => at(r) === "fifo"), lifo: mine.find((r) => at(r) === "lifo"), rows: x.coverSlots ?? 0, ...(x.focus?.length ? { focus: x.focus } : {}) });
    if (cover) this.covers.set(x.id, { ...cover, frozen: false });
  }

  private upsert(key: string, kind: FindingKind, route: string, run: Run, o: { title: string; evidence: Record<string, unknown>; replay?: ScheduleSpec; replace?: boolean }): Finding {
    const now = this.now();
    const id = this.byKey.get(key);
    let f = id ? this.findings.get(id) : undefined;
    const fresh = !f;
    if (!f) {
      f = { id: `f${this.nextFinding++}`, key, kind, title: o.title, route, count: 0, runs: [], first: now, last: now, evidence: o.evidence, replays: [] };
      if (o.replay) f.replay = o.replay;
      f.run = run.id;
      this.findings.set(f.id, f);
      this.byKey.set(key, f.id);
      if (this.findings.size > MAX_FINDINGS) this.dropOldest();
    } else if (o.replace) {
      // the newest failing run, its evidence and its replay belong together
      f.title = o.title;
      f.evidence = o.evidence;
      f.run = run.id;
      if (o.replay) f.replay = o.replay;
    }
    f.count++;
    f.last = now;
    if (!f.runs.includes(run.id)) {
      f.runs.push(run.id);
      if (f.runs.length > 20) f.runs.shift();
    }
    this.version++;
    this.changedAt.set(f.id, this.version);
    for (const fn of this.listeners) {
      try {
        fn({ finding: f, fresh });
      } catch {
        /* a listener never breaks ingestion */
      }
    }
    return f;
  }

  private dropOldest(): void {
    const old = [...this.findings.values()].sort((a, b) => a.last - b.last)[0];
    if (!old) return;
    this.findings.delete(old.id);
    this.byKey.delete(old.key);
    this.changedAt.delete(old.id);
  }

  private noteReplay(f: Finding, run: Run, reproduced: boolean | null, note: string): void {
    const prev = f.replays.find((r) => r.run === run.id);
    if (prev) {
      Object.assign(prev, { reproduced, note, at: this.now() });
      return;
    }
    f.replays.push({ run: run.id, at: this.now(), reproduced, note });
    if (f.replays.length > 20) f.replays.shift();
  }

  // ------------------------------------------------------------------------------------------- agent side

  ranked(o: { kind?: string; route?: string; sinceMs?: number; limit?: number } = {}): Finding[] {
    const now = this.now();
    return [...this.findings.values()]
      .filter((f) => (!o.kind || f.kind === o.kind) && (!o.route || f.route === o.route) && (!o.sinceMs || now - f.last <= o.sinceMs))
      .sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.count - a.count || b.last - a.last)
      .slice(0, Math.max(1, Math.min(o.limit ?? 20, 100)));
  }

  /** Findings changed since a digest cursor (the prompt hook, a shared bridge's followers). Another epoch: from 0. */
  since(cursor: number, epoch?: string): { epoch: string; cursor: number; findings: Finding[] } {
    const from = epoch !== undefined && epoch !== this.epoch ? 0 : cursor;
    const out: Finding[] = [];
    for (const [id, v] of this.changedAt)
      if (v > from) {
        const f = this.findings.get(id);
        if (f) out.push(f);
      }
    out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.last - a.last);
    return { epoch: this.epoch, cursor: this.version, findings: out };
  }

  /**
   * Arm an explore session: two fifo baselines, then `runs` seeded orders, all with the same extra latency when asked
   * (so timing alone never separates the baselines from the seeded runs). With extra latency, a third baseline without it
   * comes after the two: a bug that needs only a slow response has something to differ from (AGENT.md section 5.1).
   *
   * plan "systematic" (opt-in; its false-report rate is not measured yet): two fifo baselines, a lifo load (every pair
   * that overlaps in it delivered the other way), `runs` - 1 cover slots (rows chosen at their page loads from the
   * baselines' timing, so the orderings of overlapping triples get tried) and a third fifo baseline last: `runs` + 3
   * loads, every one with the same added latency and delay seed. slowMode "fixed" adds slow_ms to every response (the
   * systematic default), "uniform" 0 to slow_ms (the seeded default).
   */
  armExplore(o: { runs?: number; route?: string; focus?: string[]; delay?: { minMs: number; maxMs: number }; seed?: number; plan?: "seeded" | "systematic"; slowMode?: "uniform" | "fixed" }): ExploreSession {
    for (const x of this.explores.values())
      if (x.state === "armed") {
        x.state = "stopped";
        this.covers.delete(x.id);
      }
    const id = `x${this.nextExplore++}`;
    const n = Math.max(1, Math.min(o.runs ?? 6, 50));
    const seed0 = o.seed ?? 1;
    const fixed = (o.slowMode ?? (o.plan === "systematic" ? "fixed" : "uniform")) === "fixed";
    const delay = o.delay && fixed ? { minMs: o.delay.maxMs, maxMs: o.delay.maxMs } : o.delay;
    if (o.plan === "systematic") return this.armSystematic(id, n, seed0, delay, o);
    // a blocker may sit in its own emulated delay: the hold limit grows by the largest delay, so waiting behind it is
    // never cut short (1500 is the page's default maxHoldMs; 30 s its cap)
    const slow = (spec: ScheduleSpec): ScheduleSpec => (delay ? { ...spec, delay, maxHoldMs: Math.min(30_000, 1500 + delay.maxMs) } : spec);
    const plan: ScheduleSpec[] = [slow({ order: "fifo", label: "baseline 1 (responses in request order)" }), slow({ order: "fifo", label: "baseline 2 (responses in request order)" })];
    if (delay) plan.push({ order: "fifo", label: "baseline without added delay" });
    for (let i = 0; i < n; i++) {
      const spec: ScheduleSpec = slow({ order: "seeded", seed: seed0 + i, label: `seed ${seed0 + i}` });
      if (o.focus?.length) spec.focus = o.focus.slice(0, 20);
      plan.push(spec);
    }
    const x: ExploreSession = { id, created: this.now(), plan, next: 0, runs: [], state: "armed", counted: [] };
    if (o.route) x.route = o.route;
    if (o.focus?.length) x.focus = o.focus.slice(0, 20);
    this.explores.set(id, x);
    this.saveSoon();
    return x;
  }

  /** The systematic plan: positions 0, 1 fifo; 2 lifo; 3 .. runs + 1 cover slots; runs + 2 fifo, the last baseline. */
  private armSystematic(id: string, n: number, seed0: number, delay: { minMs: number; maxMs: number } | undefined, o: { route?: string; focus?: string[] }): ExploreSession {
    const shared: Pick<ScheduleSpec, "delay" | "delaySeed" | "maxHoldMs"> = delay ? { delay, delaySeed: seed0, maxHoldMs: Math.min(30_000, 1500 + delay.maxMs) } : {};
    const x: ExploreSession = { id, created: this.now(), plan: [], next: 0, runs: [], state: "armed", counted: [], strategy: "systematic", slots: [], seed0, shared, coverSlots: n - 1 };
    if (o.route) x.route = o.route;
    if (o.focus?.length) x.focus = o.focus.slice(0, 20);
    const add = (spec: ScheduleSpec, slot: PlanSlot | null) => {
      x.plan.push(spec);
      x.slots!.push(slot);
    };
    add({ order: "fifo", ...shared, label: "baseline 1 (responses in request order)" }, null);
    add({ order: "fifo", ...shared, label: "baseline 2 (responses in request order)" }, null);
    add({ order: "lifo", ...shared, label: "lifo (every overlapping pair the other way)" }, { kind: "lifo" });
    // a pending cover slot holds its seeded stand-in until its page load: the plan never holds a placeholder
    for (let k = 0; k < n - 1; k++) add({ ...this.coverStandIn(x, k, true), label: `cover row ${k + 1} (chosen from the baselines)` }, { kind: "cover", k, pending: true });
    add({ order: "fifo", ...shared, label: "baseline 3 (last)" }, null);
    this.explores.set(id, x);
    this.saveSoon();
    return x;
  }

  latestExplore(): ExploreSession | undefined {
    return [...this.explores.values()].sort((a, b) => b.created - a.created)[0];
  }

  /**
   * Compare an explore session's runs; a group with two baselines and a run whose difference reached the page (its
   * text, form values, writes or errors) becomes (or refreshes) a race finding, and so does a slow baseline that ended
   * differently from the baseline with no added delay (what a slow response alone does; replays its slow schedule).
   * Differences in store values only, and overwrites a later response repaired, are reported in the groups but make no
   * finding. A run already counted for a finding is not counted again when the same session is reported twice.
   */
  reportExplore(id?: string): { session: ExploreSession; groups: GroupReport[]; findings: Finding[] } | null {
    const x = id ? this.explores.get(id) : this.latestExplore();
    if (!x) return null;
    const runs = x.runs.map((r) => this.runs.get(r)).filter((r): r is Run => !!r);
    const groups = compareRuns(runs);
    const findings: Finding[] = [];
    const counted = new Set(x.counted ?? []);
    for (const g of groups) {
      if (g.insufficientBaselines) continue;
      const races = strongestFirst(g.diffs.filter((y) => y.tier === "visible"));
      const finding = (d: RunDiff, tag: string, title: string, extra: Record<string, unknown>): void => {
        const run = this.runs.get(d.run);
        if (!run) return;
        // keyed by what the page showed or sent (store values that differ along with it are evidence, not identity)
        const shown = d.fields.filter(shownField);
        const kindOfDiff = shown.length ? `fields:${shown.map((f) => f.name).sort().join(",")}` : d.errors.length ? `error:${shape(d.errors[0])}` : "text";
        const key = `race|${routeShape(g.route)}|${g.scenarioKey.slice(0, 600)}|${tag}${kindOfDiff}`;
        const replay: ScheduleSpec = run.schedule ? { ...run.schedule } : { order: "given", given: run.order.slice() };
        delete replay.id;
        delete replay.label;
        // the run's inversions as pairs (below), not their count
        const { inversions: _count, ...diff } = d;
        const evidence = { session: x.id, scenario: g.scenario, baselines: g.baselines, noise: g.noise, ...diff, endedDifferently: endedDifferently(d), ...extra, ...this.orderEvidence(run, g.baselines) };
        const existing = this.byKey.get(key);
        if (existing && counted.has(`${run.id}|${key}`)) {
          const f = this.findings.get(existing);
          if (f) findings.push(f);
          return;
        }
        findings.push(this.upsert(key, "race", g.route, run, { title, evidence, replay, replace: true }));
        counted.add(`${run.id}|${key}`);
      };
      if (g.delay) finding(g.delay, "slow|", delayTitle(g.delay, g.delay.oneLoad), { delayOnly: true, plainBaseline: g.plainBaseline, failingRuns: [{ run: g.delay.run, label: g.delay.label, endedDifferently: true }], of: g.delay.of, differing: g.delay.differing });
      const d = races[0];
      if (d) finding(d, "", raceTitle(d), { failingRuns: races.map((y) => ({ run: y.run, label: y.label, endedDifferently: endedDifferently(y) })), of: g.compared });
    }
    x.counted = [...counted].slice(-500);
    if (x.state === "collecting" && x.runs.length >= x.plan.length) x.state = "stopped";
    this.saveSoon();
    return { session: x, groups, findings };
  }

  /**
   * What minimisation and replays need from a race, kept with it so no baseline run has to still exist: the failing
   * run's inversions (at most 50, [a, b]: b delivered before a) and how many, the first baseline's keys by start index,
   * and the keys that ended without a delivery in the failing run but were delivered in a baseline. Nothing without a
   * timing log (an older page runtime).
   */
  private orderEvidence(run: Run, baselines: string[]): Record<string, unknown> {
    const base = baselines.map((id) => this.runs.get(id)).filter((r): r is Run => !!r && !!r.net);
    if (!run.net && !base.length) return {};
    const inv = inversionsOf(run.net, run.order);
    const startOrder = base[0] ? startOrderOf(base[0].net).slice(0, 2000).map((e) => e.key) : [];
    const delivered = new Set(base.flatMap((b) => Object.values(b.net ?? {}).filter((e) => e.d !== undefined).map((e) => e.key)));
    const endedWithout = Object.values(run.net ?? {})
      .filter((e) => e.end !== undefined && e.d === undefined && delivered.has(e.key))
      .sort((p, q) => p.n - q.n)
      .slice(0, 20)
      .map((e) => e.key);
    return { inversions: inv.slice(0, 50), inversionsTotal: inv.length, startOrder, endedWithout };
  }

  stopExplore(): ExploreSession | null {
    let last: ExploreSession | null = null;
    for (const x of this.explores.values())
      if (x.state !== "stopped") {
        x.state = "stopped";
        this.covers.delete(x.id);
        last = x;
      }
    this.saveSoon();
    return last;
  }

  /** Arm the next page loads of a finding's page with the order that produced it; an error when nothing replays it. */
  armReplay(findingId: string, times = 1): ReplayArm | { error: string } | null {
    const f = this.findings.get(findingId);
    if (!f) return null;
    const spec = replaySpecOf(f, f.run ? this.runs.get(f.run) : undefined);
    if (!spec) return { error: `the run that recorded ${f.id} is gone (cleared or expired), so its order cannot be replayed: record the bug again, or reproduce it with genclass_explore` };
    this.replays = this.replays.filter((r) => r.finding !== findingId || (r.remaining <= 0 && this.now() - r.created < ARM_TTL_MS));
    const arm: ReplayArm = { finding: f.id, spec, route: f.route, remaining: Math.max(1, Math.min(times, 10)), created: this.now(), runs: [] };
    this.replays.push(arm);
    if (this.replays.length > 50) this.replays.shift();
    this.saveSoon();
    return arm;
  }

  /**
   * Arm minimise probes for a race finding: for each inversion (a, b) of its failing run, the first baseline's start
   * order with a moved to just after b (an older response delivered late), then with b moved to just before a (the
   * same probe when nothing started between them). The smallest moves first (fewest requests between, then by a's start
   * index), at most 12; each probe is one page load with the ranked order, the failing run's delays and hold limit.
   */
  armMinimize(findingId: string): MinimizeArm | { error: string } | null {
    const f = this.findings.get(findingId);
    if (!f) return null;
    if (f.kind !== "race") return { error: "only race findings from genclass_explore can be minimised" };
    const ev = f.evidence as Record<string, unknown>;
    const inv = pairsOf(ev.inversions, 50);
    const start = Array.isArray(ev.startOrder) ? ev.startOrder.filter((k): k is string => typeof k === "string").slice(0, 2000) : [];
    if (!inv.length || !start.length) return { error: "its failing run delivered no overlapping response out of request order by its own timing log (or its page's @genclass/runtime keeps no net timing log), so there is no reordering to minimise" };
    const failing: ScheduleSpec = f.replay ?? (f.run ? this.runs.get(f.run)?.schedule : null) ?? { order: "natural" };
    const at = new Map(start.map((k, i) => [k, i]));
    const moves = inv
      .map(([a, b]) => ({ a, b, ia: at.get(a), ib: at.get(b) }))
      .filter((m): m is { a: string; b: string; ia: number; ib: number } => m.ia !== undefined && m.ib !== undefined && m.ia < m.ib)
      .sort((x, y) => x.ib - x.ia - (y.ib - y.ia) || x.ia - y.ia || x.ib - y.ib);
    if (!moves.length) return { error: "the failing run's inversions are not in its first baseline's start order (requests renumbered), so no probe can be built" };
    const shared: ScheduleSpec = {
      order: "ranked",
      ...(failing.delay ? { delay: { ...failing.delay } } : {}),
      delaySeed: failing.delaySeed ?? failing.seed ?? (failing.order === "seeded" ? 1 : 0),
      ...(failing.maxHoldMs !== undefined ? { maxHoldMs: failing.maxHoldMs } : {}),
    };
    const probes: Probe[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const m of moves) {
      const between = start.slice(m.ia + 1, m.ib);
      for (const variant of between.length ? ([1, 2] as const) : ([1] as const)) {
        const rest = start.filter((k) => k !== (variant === 1 ? m.a : m.b));
        if (variant === 1) rest.splice(rest.indexOf(m.b) + 1, 0, m.a);
        else rest.splice(rest.indexOf(m.a), 0, m.b);
        const sig = rest.join("\n");
        if (seen.has(sig)) continue;
        seen.add(sig);
        total++;
        if (probes.length >= MAX_PROBES) continue;
        const intended: [string, string][] = [[m.a, m.b], ...between.map((c): [string, string] => (variant === 1 ? [m.a, c] : [c, m.b]))];
        const label = (variant === 1 ? `minimise: ${m.a} after ${m.b}` : `minimise: ${m.b} before ${m.a}`).slice(0, 200);
        probes.push({ spec: { ...shared, ranks: rest, label }, intended, a: m.a, b: m.b, between: between.length, variant });
      }
    }
    this.minimizes = this.minimizes.filter((x) => x.finding !== f.id);
    const arm: MinimizeArm = { finding: f.id, route: f.route, created: this.now(), probes, leftOut: total - probes.length };
    this.minimizes.push(arm);
    if (this.minimizes.length > 20) this.minimizes.shift();
    return arm;
  }

  /**
   * The minimise probes' verdicts. A probe counts when its run settled after the same steps as the failing run and
   * delivered the inversion it was built for and no other outside its intended ones (its own timing log); then the
   * failing run's evidence decides, as for a replay. The minimal reproduction is the first reproducing probe, chosen
   * only when every probe before it is conclusive; the finding then replays it (and its version moves on).
   */
  minimizeResult(findingId: string): MinimizeResult | null {
    const f = this.findings.get(findingId);
    const arm = f ? this.minimizes.find((m) => m.finding === f.id) : undefined;
    if (!f || !arm) return null;
    const orig = f.run ? this.runs.get(f.run) : undefined;
    const ev = f.evidence as Record<string, unknown>;
    const probes = arm.probes.map((p, i) => this.probeResult(ev, orig, p, i));
    let minimal: ProbeResult | undefined;
    for (const p of probes) {
      if (!p.conclusive) break;
      if (p.reproduced === true) {
        minimal = p;
        break;
      }
    }
    const out: MinimizeResult = { finding: f.id, ...(arm.route ? { route: arm.route } : {}), probes, leftOut: arm.leftOut, pending: probes.filter((p) => p.state === "pending").length };
    if (minimal) {
      const p = arm.probes[minimal.index];
      out.minimal = { run: minimal.run!, label: minimal.label, a: p.a, b: p.b, between: p.between, variant: p.variant, exact: p.between === 0, inverted: minimal.realised ?? [[p.a, p.b]] };
      this.setMinimal(f, p, out.minimal);
    } else if (probes.length && probes.every((p) => p.conclusive) && arm.leftOut === 0) out.none = true;
    return out;
  }

  private probeResult(ev: Record<string, unknown>, orig: Run | undefined, p: Probe, index: number): ProbeResult {
    const base = { index, label: p.spec.label ?? `probe ${index + 1}`, a: p.a, b: p.b, between: p.between, variant: p.variant, ...(p.run ? { run: p.run } : {}) };
    const res = (state: ProbeResult["state"], reproduced: boolean | null, note: string, realised?: [string, string][]): ProbeResult => ({ ...base, state, reproduced, conclusive: state === "done" && reproduced !== null, note, ...(realised ? { realised: realised.slice(0, 50) } : {}) });
    if (p.rejected) return res("rejected", null, "its page's runtime rejected this schedule (the run's notes say so): it is not tried again");
    if (!p.run) return res("pending", null, "no page load has run it yet");
    const r = this.runs.get(p.run);
    if (!r) return res("inconclusive", null, "its run is gone");
    if (!orig) return res("inconclusive", null, "the failing run is gone, so the steps cannot be compared: record the bug again");
    if (orig.steps.some((s) => s.k === "act") && !r.steps.some((s) => s.k === "act")) return res("pending", null, "no user actions were recorded in this run yet: do the steps, await whenSettled(), then ask again");
    if (!settledAfterActs(r)) return res("pending", null, "the run has not reached a quiet point after its steps yet: wait for whenSettled(), then ask again");
    if (!sameScenario(orig, r)) return res("inconclusive", null, "its user actions differ from the failing run's: do the same steps");
    if (!r.net) return res("inconclusive", null, "its page sent no net timing log, so which responses it delivered out of order cannot be checked");
    if ((r.netLost ?? 0) > 0 || r.lost > 0) return res("inconclusive", null, "its page could not keep its whole timing log, so which responses it delivered out of order cannot be checked");
    const realised = inversionsOf(r.net, r.order);
    const got = new Set(realised.map(([x, y]) => pairKey(x, y)));
    if (!got.has(pairKey(p.a, p.b))) return res("inconclusive", null, `${q(p.b, 80)} was not delivered before ${q(p.a, 80)} (no longer overlapping, or renumbered)`, realised);
    const allowed = new Set(p.intended.map(([x, y]) => pairKey(x, y)));
    const extra = realised.filter(([x, y]) => !allowed.has(pairKey(x, y)));
    if (extra.length) return res("inconclusive", null, `it also delivered ${extra.slice(0, 3).map(([x, y]) => `${q(y, 60)} before ${q(x, 60)}`).join(", ")}${extra.length > 3 ? `, and ${extra.length - 3} more pair(s) out of order` : ""}`, realised);
    const v = raceVerdict(ev, r, { min: r.started - orig.started - (orig.snapshot?.t ?? 0), max: r.started + (r.snapshot?.t ?? 0) - orig.started });
    return res("done", v.reproduced, v.note, realised);
  }

  /** The finding now replays its minimal reproduction: the evidence names it and the version moves on (once). */
  private setMinimal(f: Finding, p: Probe, m: NonNullable<MinimizeResult["minimal"]>): void {
    const ev = f.evidence as Record<string, unknown>;
    const minimal = { inverted: m.inverted, exact: m.exact, run: m.run, label: m.label, a: m.a, b: m.b, between: m.between, variant: m.variant };
    if (JSON.stringify(ev.minimal) === JSON.stringify(minimal)) return;
    f.evidence = { ...ev, minimal };
    const spec: ScheduleSpec = { ...p.spec };
    delete spec.id;
    delete spec.label;
    f.replay = spec;
    this.version++;
    this.changedAt.set(f.id, this.version);
    this.saveSoon();
  }

  /**
   * Did the latest replay runs of a finding reproduce it? Stale-write and duplicate findings: the same witness (field
   * by shape, signature). Error: the same error. Race: the failing run's values, page text, error or witness again;
   * the baseline's = not reproduced. Inconclusive (null) when the run has not settled or done the steps yet, when its
   * steps differ from the original run's, or when the original run is gone.
   */
  replayResult(findingId: string): { finding: Finding; results: { run: string; reproduced: boolean | null; note: string; scenarioMatches: boolean }[] } | null {
    const f = this.findings.get(findingId);
    if (!f) return null;
    const orig = f.run ? this.runs.get(f.run) : undefined;
    const runs = [...this.runs.values()].filter((r) => r.assignment?.kind === "replay" && r.assignment.ref === f.id);
    const ev = f.evidence as Record<string, unknown>;
    const results = runs.map((r) => {
      const scenarioMatches = !!orig && sameScenario(orig, r);
      const origActs = orig ? orig.steps.some((s) => s.k === "act") : false;
      const acted = r.steps.some((s) => s.k === "act");
      let reproduced: boolean | null = null;
      let note = "";
      if (!orig) note = "the original run is gone, so the steps cannot be compared: record the bug again before trusting a replay";
      else if (origActs && !acted) note = "no user actions were recorded in this run yet: do the steps, await whenSettled(), then ask again";
      else if (!settledAfterActs(r)) note = "the run has not reached a quiet point after its steps yet (or never connected): wait for whenSettled(), then ask again";
      else if (f.kind === "stale-write" || f.kind === "duplicate-request") {
        const want = f.kind === "stale-write" ? "overwrote-newer" : "identical-in-flight";
        const hit = r.witnesses.some((w) => w.kind === want && pathShape(w.subject) === pathShape(String(ev.subject)) && sigOf(w.by) === sigOf(String(ev.by)));
        reproduced = hit;
        note = hit ? "the same fact was recorded again under the replayed order" : "not recorded under the replayed order";
      } else if (f.kind === "error") {
        const hit = r.errors.some((e) => e.name === ev.name && shape(e.message) === shape(String(ev.message)));
        reproduced = hit;
        note = hit ? "the same error was thrown again" : "the error did not recur";
      } else if (f.kind === "race") {
        const missed = harmfulOrderMissed(ev, r);
        if (missed) {
          // a run that did not deliver the harmful order says nothing about the fix, either way
          reproduced = null;
          note = `the harmful order did not happen in this run (${q(missed[0], 80)} was not delivered after ${q(missed[1], 80)}: requests renumbered or no longer overlapping). If the fix cancels or no longer sends the older request, the race cannot occur: run explore again to check other orders.`;
        } else {
          // an age in a line of the finding has moved on by as long as has passed since
          const v = raceVerdict(ev, r, { min: r.started - orig!.started - (orig!.snapshot?.t ?? 0), max: r.started + (r.snapshot?.t ?? 0) - orig!.started });
          reproduced = scenarioMatches ? v.reproduced : null;
          note = v.note;
        }
      } else note = "replays verify stale-write, duplicate-request, error and race findings";
      if (orig && !scenarioMatches && note) note += " (the replay's user actions differ from the original run's: do the same steps)";
      if (r.forced) note += ` (${r.forced} response(s) were delivered only when their hold ran out: the run did not follow the order exactly)`;
      this.noteReplay(f, r, reproduced, note);
      return { run: r.id, reproduced, note, scenarioMatches };
    });
    this.saveSoon();
    return { finding: f, results };
  }

  clear(what: "all" | "findings" | "runs" = "all"): void {
    if (what !== "runs") {
      this.findings.clear();
      this.byKey.clear();
      this.changedAt.clear();
      // probes of a finding that is gone would hold page loads for nothing
      this.minimizes = [];
    }
    if (what !== "findings") {
      // runs the remaining findings need stay (a finding without its run cannot be replayed)
      const pin = what === "runs" ? this.pinnedIds() : new Set<string>();
      for (const id of [...this.runs.keys()]) if (!pin.has(id)) this.runs.delete(id);
      this.explores.clear();
      this.covers.clear();
      this.replays = [];
      this.minimizes = [];
    }
    this.version++;
    this.saveSoon();
  }

  // ------------------------------------------------------------------------------------------- persistence

  private file(): string | null {
    return this.opts.dir ? join(this.opts.dir, "state.json") : null;
  }

  saveSoon(): void {
    if (!this.opts.dir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1000);
    this.saveTimer.unref?.();
  }

  save(): void {
    const file = this.file();
    if (!file) return;
    const dir = this.opts.dir!;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // the state directory ignores itself (and only itself), so recorded runs are never committed by accident
      try {
        writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
      } catch {
        /* exists */
      }
      const pin = this.pinnedIds();
      const all = [...this.runs.values()];
      const keep = [...all.filter((r) => pin.has(r.id)), ...all.filter((r) => !pin.has(r.id)).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, SAVED_RUNS)];
      const runs = keep.map((r) => {
        const { token: _t, ...rest } = r;
        return rest;
      });
      const data = { schema: "genclass-mcp-state/1", nextRun: this.nextRun, nextFinding: this.nextFinding, nextExplore: this.nextExplore, runs, findings: [...this.findings.values()], explores: [...this.explores.values()].slice(-20) };
      // a fresh temporary name (never an existing file or a planted link), then an atomic rename
      const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
      try {
        renameSync(tmp, file);
      } catch {
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* state is a convenience; never fail a request over it */
    }
  }

  /** Load state.json, keeping only well-formed entries. Armed explores and replays are not restored (they expire). */
  private load(): void {
    const file = this.file();
    if (!file) return;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      return; // no state yet, or unreadable: start empty
    }
    if (!d || d.schema !== "genclass-mcp-state/1") return;
    const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1);
    this.nextRun = int(d.nextRun);
    this.nextFinding = int(d.nextFinding);
    this.nextExplore = int(d.nextExplore);
    for (const r of Array.isArray(d.runs) ? d.runs : []) {
      const run = loadRun(r);
      if (run) this.runs.set(run.id, run);
    }
    for (const x of Array.isArray(d.findings) ? d.findings : []) {
      const f = loadFinding(x);
      if (!f || this.byKey.has(f.key)) continue;
      this.findings.set(f.id, f);
      this.byKey.set(f.key, f.id);
    }
    for (const x of Array.isArray(d.explores) ? d.explores : []) {
      const o = x as ExploreSession;
      if (!o || typeof o.id !== "string" || !Array.isArray(o.plan) || !Array.isArray(o.runs)) continue;
      const plan = o.plan.map((p) => V.spec(p)).filter((p): p is ScheduleSpec => !!p);
      this.explores.set(o.id, { id: o.id, created: Number(o.created) || 0, plan, next: Math.min(Number(o.next) || 0, plan.length), runs: o.runs.filter((r) => typeof r === "string"), state: "stopped", ...(typeof o.route === "string" ? { route: o.route } : {}), counted: Array.isArray(o.counted) ? o.counted.filter((c) => typeof c === "string") : [], ...(o.strategy === "systematic" ? { strategy: "systematic" as const } : {}) });
    }
  }
}

/** A run from state.json, re-validated (steps, witnesses, errors, snapshot); null when malformed. */
function loadRun(v: unknown): Run | null {
  const r = v as Run;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.page || typeof r.page.route !== "string") return null;
  const steps = (Array.isArray(r.steps) ? r.steps : []).map((s) => V.step(s)).filter((s): s is Step => !!s);
  const run: Run = {
    id: r.id.slice(0, 20),
    started: Number(r.started) || 0,
    lastSeen: Number(r.lastSeen) || 0,
    page: { url: String(r.page.url ?? "").slice(0, 2000), route: r.page.route.slice(0, 500), ...(typeof r.page.title === "string" ? { title: r.page.title.slice(0, 200) } : {}) },
    schedule: V.spec(r.schedule),
    steps,
    lost: Number(r.lost) || 0,
    order: (Array.isArray(r.order) ? r.order : []).filter((k): k is string => typeof k === "string").slice(-4000),
    forced: Number(r.forced) || 0,
    witnesses: (Array.isArray(r.witnesses) ? r.witnesses : []).map((w) => V.witness(w)).filter((w): w is NonNullable<typeof w> => !!w),
    errors: (Array.isArray(r.errors) ? r.errors : []).map((e) => V.error(e)).filter((e): e is NonNullable<typeof e> => !!e),
    detections: [],
    interventions: [],
    checks: [],
    expectations: [],
    snapshots: Number(r.snapshots) || 0,
    ended: true,
  };
  const snap = V.snapshot(r.snapshot);
  if (snap) run.snapshot = snap;
  if (typeof r.origin === "string") run.origin = r.origin.slice(0, 300);
  run.token = randomBytes(16).toString("hex"); // a restored run takes no more events: no page knows this token
  if (r.assignment && typeof r.assignment === "object" && (r.assignment.kind === "explore" || r.assignment.kind === "replay" || r.assignment.kind === "minimize")) run.assignment = { kind: r.assignment.kind, ref: String(r.assignment.ref).slice(0, 20), index: Number(r.assignment.index) || 0, label: clean(r.assignment.label, 100) };
  const strs = (v: unknown, items: number, len: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, items).map((x) => x.slice(0, len)) : null);
  const caps = strs(r.caps, 20, 40);
  if (caps) run.caps = caps;
  if (r.net && typeof r.net === "object") {
    const net = Object.create(null) as Record<string, NetEntry>;
    V.mergeNet(net, Object.values(r.net));
    run.net = net;
  }
  if (typeof r.netLost === "number" && Number.isFinite(r.netLost) && r.netLost > 0) run.netLost = Math.min(1e9, Math.floor(r.netLost));
  const notes = strs(r.notes, 20, 300);
  if (notes?.length) run.notes = notes;
  return run;
}

const KINDS = new Set(Object.keys(RANK));

/** A finding from state.json; its title is cleaned again (printed as one line whatever the file holds). */
function loadFinding(v: unknown): Finding | null {
  const f = v as Finding;
  if (!f || typeof f !== "object" || typeof f.id !== "string" || typeof f.key !== "string" || !KINDS.has(f.kind)) return null;
  const out: Finding = {
    id: f.id.slice(0, 20),
    key: f.key.slice(0, 2000),
    kind: f.kind,
    title: clean(f.title, 400),
    route: clean(f.route, 500),
    count: Number(f.count) || 1,
    runs: (Array.isArray(f.runs) ? f.runs : []).filter((r): r is string => typeof r === "string").slice(-20),
    first: Number(f.first) || 0,
    last: Number(f.last) || 0,
    evidence: f.evidence && typeof f.evidence === "object" ? f.evidence : {},
    replays: (Array.isArray(f.replays) ? f.replays : []).filter((r) => r && typeof r.run === "string").slice(-20),
  };
  if (typeof f.run === "string") out.run = f.run;
  const rp = V.spec(f.replay);
  if (rp) out.replay = rp;
  return out;
}

/** What a race title says when the failing run delivered no overlapping pair newer first (its own timing log). */
const TIMING = "The final state depends on response timing (no response was delivered out of request order)";

/** A race finding's title, by what differed, the most telling evidence first (page strings quoted). */
function raceTitle(d: RunDiff): string {
  const timing = d.reordered === false;
  if (d.fields.some(shownField) || d.errors.length || d.textOnlyRun.length || d.textOnlyBaseline.length) return `${timing ? `${TIMING}:` : "The page depends on response order:"} under ${q(d.label, 30)} ${nameDifference(d)}`;
  if (d.fields.length) return `${timing ? TIMING : "The final state depends on response order"}: ${d.fields.slice(0, 2).map((f) => `${f.where} ${q(f.name, 60)} (${q(f.baseline, 40)} in request order, ${q(f.run, 40)} under ${q(d.label, 30)})`).join("; ")}`;
  const w = d.witnesses[0] ?? "";
  if (w.startsWith("identical-in-flight")) return `The same request was sent twice under ${q(d.label, 30)}, not in request order (the final state matched the baseline): ${q(w, 160)}`;
  return `An older response overwrote newer data under ${q(d.label, 30)} (the final state matched the baseline; users would see it flicker): ${q(w, 160)}`;
}

/** The title of what a slow response alone does: the "baseline" in nameDifference() is the run with no added delay. */
function delayTitle(d: RunDiff, oneLoad?: boolean): string {
  const said = nameDifference(d).replace(/the baseline/g, "the run with no added delay");
  return oneLoad ? `With added latency the page ends differently from the one load with no added delay, the only load that differs (it may be the odd one out): ${said}` : `The page depends on a slow response, no reordering needed: with added latency ${said}`;
}

/**
 * Did a replay run miss the order that made the race? Checked only when the finding knows it (its minimal reproduction,
 * else the failing run's inversions) and the run has a timing log: every pair of the minimal one, else at least one of
 * the failing run's, must be an inversion of the replay. The first pair it missed, or null (delivered, or not checked).
 */
function harmfulOrderMissed(ev: Record<string, unknown>, r: Run): [string, string] | null {
  const m = ev.minimal && typeof ev.minimal === "object" ? pairsOf((ev.minimal as { inverted?: unknown }).inverted, 50) : [];
  const inv = pairsOf(ev.inversions, 50);
  if ((!m.length && !inv.length) || !r.net) return null;
  const got = new Set(inversionsOf(r.net, r.order).map(([a, b]) => pairKey(a, b)));
  if (m.length) return m.find(([a, b]) => !got.has(pairKey(a, b))) ?? null;
  return inv.some(([a, b]) => got.has(pairKey(a, b))) ? null : inv[0];
}

/** Does a replay run show the race finding's difference again? From the evidence of the failing run. */
function raceVerdict(ev: Record<string, unknown>, r: Run, later: Elapsed): { reproduced: boolean | null; note: string } {
  const snap = r.snapshot!;
  const all = (ev.fields as { where: string; name: string; baseline: string; run: string; except?: string[] }[] | undefined) ?? [];
  const val = (d: { where: string; name: string; except?: string[] }) => (d.where === "state" ? stateValue(snap.state, d.name) : d.where === "field" ? fieldValue(snap.fields, d.name, d.except) : snap.requests[d.name] !== undefined ? String(snap.requests[d.name]) : undefined) ?? "(absent)";
  const byValues = (fields: typeof all): { reproduced: boolean | null; note: string } => {
    const same = fields.every((d) => sameValue(val(d), d.run));
    const fixed = fields.every((d) => sameValue(val(d), d.baseline));
    return same ? { reproduced: true, note: "ended with the same wrong values as the failing run" } : fixed ? { reproduced: false, note: "ended with the values of the request-order baseline" } : { reproduced: null, note: `ended with other values: ${fields.map((d) => `${clean(d.name, 40)} = ${q(val(d), 40)}`).join(", ")}` };
  };
  // what the page showed or sent decides; store values only for a finding that has nothing else
  const shownFields = all.filter((d) => shownField(d as FieldDiff));
  if (shownFields.length) return byValues(shownFields);
  const errors = (ev.errors as string[] | undefined) ?? [];
  if (errors.length) {
    const hit = errors.some((m) => r.errors.some((e) => shape(e.message) === shape(m)));
    return { reproduced: hit, note: hit ? "the same error was thrown again" : "the error did not recur" };
  }
  // lines count: a line the page always shows once (a product card) and the failing run showed twice (a stale result
  // too) reproduces only when the replay shows it as many times as the failing run did
  // compared as the comparison did: a line that says "5 minutes ago" is the same line a minute later
  const lines = snap.text ?? [];
  const counts = (ev.textCounts as Record<string, { baseline: number; run: number }> | undefined) ?? {};
  const seen = (l: string) => {
    const x = agesIn(l);
    return lines.filter((o) => {
      if (o === l) return true;
      const y = x && agesIn(o);
      return !!x && !!y && y.form === x.form && sameAges(x.ages, y.ages, later);
    }).length;
  };
  const onlyRun = (ev.textOnlyRun as string[] | undefined) ?? [];
  const onlyBase = (ev.textOnlyBaseline as string[] | undefined) ?? [];
  if (onlyRun.length || onlyBase.length) {
    const again = onlyRun.some((l) => seen(l) >= Math.max(1, counts[l]?.run ?? 1));
    const missing = onlyBase.filter((l) => seen(l) < Math.max(1, counts[l]?.baseline ?? 1));
    if (again || (!onlyRun.length && missing.length === onlyBase.length)) return { reproduced: true, note: "the page shows the failing run's text again" };
    if (!missing.length) return { reproduced: false, note: "the page shows the baseline's text" };
    return { reproduced: null, note: `the page shows neither the failing run's text nor all of the baseline's (missing ${q(missing[0], 60)})` };
  }
  if (all.length) return byValues(all);
  const wits = (ev.witnesses as string[] | undefined) ?? [];
  if (wits.length) {
    const have = new Set(r.witnesses.map((w) => `${w.kind} ${pathShape(w.subject)} by ${sigOf(w.by)}`));
    const hit = wits.some((w) => have.has(w));
    return { reproduced: hit, note: hit ? "the older response overwrote newer data again" : "no older response overwrote newer data" };
  }
  return { reproduced: null, note: "nothing comparable was recorded" };
}

/**
 * The schedule that reproduces a finding: an explore race replays its run's seeded schedule; anything recorded in a
 * natural run replays that run's delivery order (read now, so it includes deliveries sent after the finding). Null
 * when the run is gone and the finding has no schedule of its own.
 */
export function replaySpecOf(f: Finding, run: Run | undefined): ScheduleSpec | null {
  const spec: ScheduleSpec | null = f.kind === "race" && f.replay ? { ...f.replay } : run && run.order.length ? { order: "given", given: run.order.slice() } : null;
  if (!spec) return null;
  delete spec.id;
  delete spec.label;
  return spec;
}

/** Append the keys of `next` that are not yet at the end of `prev` (pages resend their newest keys). Linear. */
export function mergeOrder(prev: string[], next: string[]): string[] {
  if (!prev.length) return next.slice(-4000);
  if (!next.length) return prev;
  // keys are unique in a page load ("SIG#n"): find where next's first key sits in prev's tail
  const tail = prev.slice(-next.length);
  const pos = tail.lastIndexOf(next[0]);
  if (pos >= 0) {
    const k = tail.length - pos;
    let ok = k <= next.length;
    for (let i = 0; ok && i < k; i++) if (tail[pos + i] !== next[i]) ok = false;
    if (ok) return prev.concat(next.slice(k)).slice(-4000);
  }
  return prev.concat(next).slice(-4000);
}
