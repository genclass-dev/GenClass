// The consent gate's lazy chunk (InitOptions.consent, Runtime.consent; TELEMETRY.md "Consent"; CONTRACT section 17).
//
// The first load carries only the gates (runtime.ts `cs`: storage(), noModel(); index.ts: telemetry and the model's
// lazy preload; analytics/start.ts: the "consent" reason). This chunk turns a choice into changes, imported the first
// time the app calls runtime.consent() (or right after start, to apply the option itself). It imports types only, so
// an app's bundler keeps it out of the first load (test/bundle.test.ts).
//
// Invariants:
// - A part that is not granted starts nothing: no request, no read or write of GenClass's own storage entries, no
//   worker, no download. A grant starts it from that point, as at start without the gate; a denial withdraws it now.
// - Every opt-out still wins over a grant: diagnostics start through startTelemetry (resolveTelemetry checks
//   `telemetry: false`, the URL, localStorage, Global Privacy Control, local hosts, sampling) as at start, and never
//   after a URL opt-out the page started with (reason "url"), whatever the URL is by then.
// - Consent never turns on what the app did not ask for: analytics only when the app turned them on, learned state
//   only where it would be stored without the gate, the model only when the app has one.
// - GenClass's own storage reads and writes here set rt.selfStorage: the storage observer does not record them, so
//   no consent state reaches a situation.
// - Never throws into the app. Timers come from the runtime's Clock; the model host schedules its own idle start.

import type { RuntimeImpl } from "./runtime.js";
import type { ConsentChoices, ConsentState, DecisionProvider, ModelStatus, SessionSummary, TelemetryStatus } from "./types.js";

export const CONSENT_PARTS = ["diagnostics", "analytics", "storage", "model"] as const;

/** analytics/index.ts VISIT_KEY (not imported: that chunk stays out of this one), then the token or "endpoint". */
const VISIT_KEY = "genclass.analytics.";

/**
 * Each part: true granted, false denied, undefined unchanged (pending at start). "granted" and true grant every part,
 * "denied" and false deny every part, an object sets the parts it names with a boolean; anything else ("pending", an
 * unknown value) changes nothing, the cautious reading.
 */
export function consentOf(c: unknown): ConsentChoices {
  const all = c === "granted" || c === true ? true : c === "denied" || c === false ? false : undefined;
  const o: ConsentChoices = {};
  for (const k of CONSENT_PARTS) {
    const v = c && typeof c == "object" ? (c as ConsentChoices)[k] : all;
    if (typeof v == "boolean") o[k] = v;
  }
  return o;
}

/** Runtime.consent()'s answer: "granted", "denied" or "pending" per part. */
export function consentState(cs: ConsentChoices): ConsentState {
  const o = {} as Record<keyof ConsentChoices, ConsentState["model"]>;
  for (const k of CONSENT_PARTS) o[k] = cs[k] ? "granted" : cs[k] === false ? "denied" : "pending";
  return o;
}

/** runtime.telemetry while diagnostics wait for consent (as telemetryOff, which this chunk does not import). */
const waiting = (): TelemetryStatus => ({ enabled: false, reason: "consent", flush: () => Promise.resolve() });

/** Apply a choice to the runtime (RuntimeImpl.consent): the parts that change, then each part's state. */
export function applyConsent(rt: RuntimeImpl, c: unknown): ConsentState {
  try {
    const cs = rt.cs;
    const changed: ConsentChoices = {};
    if (!rt["destroyed"])
      for (const [k, v] of Object.entries(consentOf(c)) as [keyof ConsentChoices, boolean][])
        if (v !== cs[k]) changed[k] = cs[k] = v;
    // diagnostics and analytics: a withdrawal stops both first (analytics are sent as diagnostics). Analytics the app
    // turned on (start() was called: any reason but "option" and "stopped") are held, so a later grant starts them
    const a = rt.analytics as { enabled: boolean; reason?: string; start(): boolean; stop(): void } | undefined;
    const wanted = !!a && (a.enabled || (a.reason != "option" && a.reason != "stopped"));
    if (changed.diagnostics === false || changed.analytics === false) {
      a?.stop();
      if (wanted) a!.reason = "consent";
    }
    const t = rt.telemetry as (TelemetryStatus & { stop?: (withdrawn?: boolean) => void }) | undefined;
    if (changed.diagnostics === false && t?.enabled) {
      t.stop?.(true);
      rt.telemetry = waiting();
    }
    // reason "url": ?genclass=no-telemetry as the page started (index.ts), kept for the page load
    if (changed.diagnostics && !t?.enabled && t?.reason != "url" && rt.cx?.tel) diagnostics(rt, rt.cx.tel);
    if ((changed.diagnostics || changed.analytics) && wanted && !a!.enabled) a!.start();
    if (changed.storage !== undefined) storage(rt, changed.storage);
    // the analytics visit entry goes with any part it needs, also one an earlier visit left while the analytics chunk
    // never started on this page (its stop() removes it only when it runs)
    if (changed.diagnostics === false || changed.analytics === false || changed.storage === false) remove(rt, [[VISIT_KEY + (rt.cx?.token ?? "endpoint"), "local"]]);
    if (changed.model !== undefined) model(rt, changed.model);
  } catch (e) {
    rt["log"]("consent could not be applied", e);
  }
  return consentState(rt.cs);
}

/**
 * Diagnostics granted: telemetry starts now, through the same code as at start. A session that starts after the page
 * did counts the runtime from here too (TelemetryClient.since): the summary's `runtime` block (decisions, latency,
 * holds, denials, errors) leaves out what happened before the grant.
 */
function diagnostics(rt: RuntimeImpl, tel: () => TelemetryStatus): void {
  const t = (rt.telemetry = tel()) as TelemetryStatus & { since?: { summary(): SessionSummary } };
  if (!t.enabled) return;
  const b = rt.summary();
  const at = rt.clock.now();
  // the summary tracker (decide/summary.ts): its latest latencies, and the longest hold since this grant, which only
  // a wrapper of its held() can know (installed once per runtime, here, so the first load carries nothing for it)
  const tr = rt["sum"] as unknown as { lat: number[]; held(ms: number): void; sinceMax?: number };
  if (tr.sinceMax === undefined) {
    const held = tr.held;
    tr.held = (ms: number) => {
      held.call(tr, ms);
      tr.sinceMax = Math.max(tr.sinceMax ?? 0, ms);
    };
  }
  tr.sinceMax = 0;
  const minus = (x: Record<string, number>, y: Record<string, number>) => {
    const o: Record<string, number> = {};
    for (const k in x) if (x[k] - (y[k] ?? 0) > 0) o[k] = x[k] - (y[k] ?? 0);
    return o;
  };
  const since = (s: SessionSummary): SessionSummary => {
    try {
      // the decisions since the grant are the last ones the tracker keeps (it keeps 200)
      const n = s.model.decisions - b.model.decisions;
      const lat = n > 0 ? tr.lat.slice(-n).sort((x, y) => x - y) : [];
      const q = (p: number) => lat[Math.min(lat.length - 1, Math.max(0, Math.ceil(p * lat.length) - 1))];
      const { p50Ms: _p50, p95Ms: _p95, ...m } = s.model;
      return {
        ...s,
        startedAt: at,
        durationMs: Math.max(0, s.durationMs - (at - s.startedAt)),
        detections: minus(s.detections, b.detections),
        possibleDetections: minus(s.possibleDetections, b.possibleDetections),
        interventions: minus(s.interventions, b.interventions),
        undos: s.undos - b.undos,
        lateReverts: s.lateReverts - b.lateReverts,
        denied: minus(s.denied, b.denied),
        shadow: minus(s.shadow, b.shadow),
        model: { ...m, decisions: n, dropped: s.model.dropped - b.model.dropped, hiddenSkipped: s.model.hiddenSkipped - b.model.hiddenSkipped, ...(lat.length ? { p50Ms: q(0.5), p95Ms: q(0.95) } : {}) },
        heldMs: { total: s.heldMs.total - b.heldMs.total, max: tr.sinceMax ?? 0 },
        errors: s.errors - b.errors,
      };
    } catch {
      // the counts since the grant could not be made: none are sent (never the page load's)
      return undefined as never;
    }
  };
  t.since = { summary: () => since(rt.summary()) };
}

/** Remove GenClass's own entries (always allowed, even before storage consent), as GenClass's own writes. */
function remove(rt: RuntimeImpl, entries: readonly (readonly [string, "local" | "session"])[]): void {
  rt.selfStorage = true;
  for (const [k, kind] of entries) {
    try {
      rt["storage"](kind, true)?.removeItem(k);
    } catch {
      /* ignore */
    }
  }
  rt.selfStorage = false;
}

/**
 * Storage granted: learned state from earlier visits is read and kept from now on (only where it would be stored
 * without the gate: learn.persist, learn.expectations), and the session's act/observe bucket and breaker trip are read
 * or stored as at start. Withdrawn: nothing more is written and GenClass's own entries are removed; what was learned
 * stays in memory for the page. Either way a flow layer that waited for the choice loads.
 */
function storage(rt: RuntimeImpl, on: boolean): void {
  const want = rt["learnWant"];
  if (on) {
    let works = false;
    if (want && !rt["learnStore"]) {
      rt.selfStorage = true;
      works = rt["storageWorks"](want);
      rt.selfStorage = false;
    }
    if (works && want) {
      rt["learnStore"] = want;
      rt["persistProfiles"] = rt["learnOpts"]?.persist !== undefined;
      rt["loadLearn"]();
      // a flow layer that loaded in memory (storage denied first) takes what earlier visits learned, and the
      // thresholds of a stored layer
      if (rt.flows) {
        rt.flows.load(rt["storedFlows"]);
        rt["storedFlows"] = undefined;
        if (want === "local") rt.flows.persisted?.(rt["learnOpts"]);
      }
    }
    session(rt);
  } else {
    if (rt["persistTimer"] !== null) rt.clock.clearTimeout(rt["persistTimer"]);
    rt["persistTimer"] = null;
    rt["learnStore"] = null;
    rt["persistProfiles"] = false;
    const key = rt["learnKey"];
    remove(rt, [
      [key, "local"],
      [key, "session"],
      [`${key}:session`, "session"],
      ["genclass:bucket", "session"],
      ["genclass:breaker", "session"],
    ]);
  }
  if (rt["flowsWanted"]) rt["loadFlows"]();
}

/**
 * The session's act/observe bucket (`sample`, OPTIONS-SPEC 4.2) and the breaker's trip (OPTIONS-SPEC 4.5) once
 * storage is granted, as without the gate: what this session stored is read (a trip caps the mode from now; a stored
 * bucket is the session's), otherwise what this page decided is stored. A trip reset on this page stays cleared.
 */
function session(rt: RuntimeImpl): void {
  const ss = rt["storage"]("session");
  const p = rt["bucketP"];
  let moved = false;
  rt.selfStorage = true;
  try {
    if (p) {
      const v = ss?.getItem("genclass:bucket");
      if (v === `act@${p}` || v === `observe@${p}`) {
        moved = rt["sampled"] !== (v === `act@${p}`);
        rt["sampled"] = v === `act@${p}`;
      } else ss?.setItem("genclass:bucket", `${rt["sampled"] ? "act" : "observe"}@${p}`);
    }
  } catch {
    /* this page's bucket stays */
  }
  try {
    const b = rt["breakerImpl"];
    if (b?.cfg.persist) {
      if (b.tripped) ss?.setItem("genclass:breaker", JSON.stringify(b.tripped));
      else if (b.tripped === null) ss?.removeItem("genclass:breaker");
      else {
        const raw = ss?.getItem("genclass:breaker");
        if (raw) {
          b.tripped = JSON.parse(raw);
          // a trip caps the mode: what is held is released, as at a trip on this page
          rt["releaseHolds"]();
          moved = true;
        }
      }
    }
  } catch {
    /* memory only */
  } finally {
    rt.selfStorage = false;
  }
  if (moved) rt["fire"]("status", rt.status);
}

/**
 * Model granted: a host that never started (lazy until now, or unloaded meanwhile) is made again as the options say, so it loads as
 * `model.preload` and `model.loadIf` say from this point (idle: once the page has loaded and the browser is idle).
 * Withdrawn: it is no longer consulted (runtime.ts noModel); a host waiting to start or loading is stopped now (its
 * worker ends, so no request and no Cache Storage write follows) with a lazy one in its place for a later grant, and
 * the Cache Storage copy is deleted (src/model/loader.ts DEFAULT_CACHE_NAME). A model in memory stays, unused.
 */
function model(rt: RuntimeImpl, on: boolean): void {
  // a `ready` asked for while the model waited is asked again
  rt["_ready"] = null;
  // none without the built-in model (model: false, or its own decider)
  const m = rt.cx?.model;
  const host = rt.cx?.host;
  if (!rt["ownsDecider"] || !m || !host) return;
  const st = rt["decider"]?.status.state;
  if (on) {
    // "unloaded": model.unloadAfterIdleMs tore down the lazy host while the model waited
    if (st === "off" || st === "unloaded") swap(rt, host());
    return;
  }
  if (st === "off" || st === "loading") swap(rt, host(true));
  const g = rt.global as { caches?: CacheStorage };
  void Promise.resolve(m.cacheName || "genclass-runtime-v1")
    .then((n) => g.caches?.delete(n))
    .catch(() => undefined);
}

/**
 * Put a new host in the runtime's place for the old one (disposed), listened to as the old one was. What waits for the
 * old host's load (an app's `await rt.ready`, an ask()) is not rejected by its disposal: it waits on as `rt.ready` says
 * now (resolved at once while the model is withdrawn, as with no model; a granted host's load otherwise).
 */
function swap(rt: RuntimeImpl, next: DecisionProvider): void {
  const old = rt["decider"];
  if (old === next) return;
  // src/model/host.ts ModelHost: the ready() and load() promises it has not settled (it rejects them when disposed);
  // with model.unloadAfterIdleMs, on the host the IdleUnloadProvider wraps (index.ts: its ready() is that host's)
  type Held = { readyWaiters?: { resolve(): void; reject(e: unknown): void }[]; host?: Held | null };
  const o = old as Held | null;
  const waiting = (o?.readyWaiters ?? o?.host?.readyWaiters)?.splice(0) ?? [];
  old?.dispose?.();
  rt["decider"] = next;
  const f = rt.onModel as ((s: ModelStatus) => void) | undefined;
  if (f && next.onStatus) {
    next.onStatus(f);
    // what it did while being made (an eager start) is heard too
    f(next.status);
  }
  // after the choice is in rt.cs and `ready` was reset (model()); read only when something waits, as reading it starts
  // a lazy load
  if (waiting.length) {
    const p = rt.ready;
    for (const w of waiting) p.then(w.resolve, w.reject);
  }
}
