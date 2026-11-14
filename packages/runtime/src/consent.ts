// The consent gate's lazy chunk (InitOptions.consent, Runtime.consent; TELEMETRY.md "Consent"; CONTRACT section 17).
//
// The first load carries only the gates (runtime.ts `cs`: storage(), noModel(); index.ts: telemetry and the model's
// lazy preload; analytics/start.ts: the "consent" reason). This chunk turns a choice into changes, imported the first
// time the app calls runtime.consent() (or right after start, to apply the option itself). It imports types only, so
// an app's bundler keeps it out of the first load (test/bundle.test.ts).
//
// Invariants:
// - A part that is not granted starts nothing: no request, no read or write of GenClass's own storage entries, no
//   worker, no download. A grant starts it from that point; a denial withdraws it now.
// - Every opt-out still wins over a grant: diagnostics start through startTelemetry (resolveTelemetry checks
//   `telemetry: false`, the URL, localStorage, Global Privacy Control, local hosts, sampling) as at start.
// - Consent never turns on what the app did not ask for: analytics only when the app turned them on, learned state
//   only where it would be stored without the gate, the model only when the app has one.
// - Never throws into the app. Timers come from the runtime's Clock; idle callbacks from the runtime's global.

import type { RuntimeImpl } from "./runtime.js";
import type { ConsentChoices, ConsentState, TelemetryStatus } from "./types.js";

export const CONSENT_PARTS = ["diagnostics", "analytics", "storage", "model"] as const;

/** The model starts when the browser is idle (model.preload "idle"), at most this long after the grant. */
export const IDLE_LOAD_MS = 2000;

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
    if (changed.diagnostics && !t?.enabled && rt.cx?.tel) rt.telemetry = rt.cx.tel();
    if ((changed.diagnostics || changed.analytics) && wanted && !a!.enabled) a!.start();
    if (changed.storage !== undefined) storage(rt, changed.storage);
    if (changed.model !== undefined) model(rt, changed.model);
  } catch (e) {
    rt["log"]("consent could not be applied", e);
  }
  return consentState(rt.cs);
}

/**
 * Storage granted: learned state from earlier visits is read and kept from now on (only where it would be stored
 * without the gate: learn.persist, learn.expectations). Withdrawn: nothing more is written and GenClass's own entries
 * are removed; what was learned stays in memory for the page. Either way a flow layer that waited for the choice loads.
 */
function storage(rt: RuntimeImpl, on: boolean): void {
  const want = rt["learnWant"];
  if (on) {
    if (want && !rt["learnStore"] && rt["storageWorks"](want)) {
      rt["learnStore"] = want;
      rt["persistProfiles"] = rt["learnOpts"]?.persist !== undefined;
      rt["loadLearn"]();
      // a flow layer that loaded in memory (storage denied first) takes what earlier visits learned
      if (rt.flows) {
        rt.flows.load(rt["storedFlows"]);
        rt["storedFlows"] = undefined;
      }
    }
  } else {
    if (rt["persistTimer"] !== null) rt.clock.clearTimeout(rt["persistTimer"]);
    rt["persistTimer"] = null;
    rt["learnStore"] = null;
    rt["persistProfiles"] = false;
    const key = rt["learnKey"];
    rt.selfStorage = true;
    for (const [k, kind] of [
      [key, "local"],
      [key, "session"],
      [`${key}:session`, "session"],
      ["genclass:bucket", "session"],
      ["genclass:breaker", "session"],
    ] as const) {
      try {
        rt["storage"](kind, true)?.removeItem(k);
      } catch {
        /* ignore */
      }
    }
    rt.selfStorage = false;
  }
  if (rt["flowsWanted"]) rt["loadFlows"]();
}

/**
 * Model granted: it loads as `model.preload` says (it was created lazy, so nothing was downloaded). Withdrawn: it is no
 * longer consulted (runtime.ts noModel) and its Cache Storage copy is deleted (src/model/loader.ts DEFAULT_CACHE_NAME).
 */
function model(rt: RuntimeImpl, on: boolean): void {
  // a `ready` asked for while the model waited is asked again
  rt["_ready"] = null;
  // the app's model.preload; none without the built-in model (model: false, or its own decider)
  const m = rt.cx?.model;
  if (!rt["ownsDecider"] || !m) return;
  const load = m.preload ?? "idle";
  const g = rt.global as { caches?: CacheStorage; requestIdleCallback?: (f: () => void, o: { timeout: number }) => unknown };
  if (!on) {
    void Promise.resolve(m.cacheName || "genclass-runtime-v1")
      .then((n) => g.caches?.delete(n))
      .catch(() => undefined);
    return;
  }
  const start = () => void (rt.cs.model && !rt["destroyed"] && rt.ready);
  if (load === "eager") start();
  else if (load === "idle") {
    if (typeof g.requestIdleCallback == "function") g.requestIdleCallback(start, { timeout: IDLE_LOAD_MS });
    else rt.clock.setTimeout(start, IDLE_LOAD_MS / 2);
  }
}
