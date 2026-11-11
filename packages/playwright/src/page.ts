// The part of the fixture that runs inside the page (install.ts puts it in page.addInitScript, serialised with
// Function.prototype.toString, so this file imports nothing and the function below references only its parameters
// and the page's globals). What it does, before any script of the app runs:
//
//   1. sets window.GENCLASS_CONFIG: observe mode, telemetry off, no visual checks, no devtools, the model as the
//      fixture chose;
//   2. runs the runtime's script-tag build (dist/genclass.global.js) with a stand-in for `document.currentScript`
//      (an init script has no tag, and the build reads `data-base` from its own tag: the stand-in points it at the
//      fixture's virtual path, so everything it loads later comes from the same place);
//   3. holds the runtime to observe: if the URL or localStorage switch (?genclass=heal, localStorage.genclass) raised
//      the mode, it is set back with rt.setMode("observe") and the file says so;
//   4. hands every likely detection to Node from the runtime's "decide" event, synchronously (with the model's
//      diagnosis confidence and the console line the runtime printed);
//   5. loads the agent entry (dist/agent.js) and connects it with every hold off, so the runtime records the two
//      happens-before witnesses (overwrote-newer, identical-in-flight) that need no model, and hands each new one to
//      Node as it appears. connectAgent binds the page's fetch once, when it is called: for that call only, fetch is
//      a stand-in that answers the agent's own URL with "null" without a request (so the link stays unconnected and
//      sends nothing, no console error, no failed request, no CSP report) and passes every other call to the real one;
//   6. reports the runtime's mode and model status, at start, on every status change, when the page goes away, and
//      on request (window.__GENCLASS_PLAYWRIGHT__.collect(), which the fixture calls at the end of the test), with
//      whether a service worker controls the page (page.route does not see what it handles);
//   7. answers which requests of this page load are still unanswered (window.__GENCLASS_PLAYWRIGHT__.open()), read from
//      the agent entry's record. The fixture asks at the end of a test and waits, on its own side and for a bounded
//      time, for the ones sent a moment ago: a response that lands after the test's last assertion is still seen;
//   8. says when the page goes offline and comes back online (the fixture's chaos holds nothing while it is offline);
//   9. hands over the order of things on this page, from the agent entry's record, as it grows: each user action
//      (its kind and the runtime's description of its target, never a value that was typed), each request's send, and
//      the delivery of its response to the app or its end without one, each with its time. The first time the fixture
//      asks anything at the end of a test (open() or collect()), it also says how many steps there were by then: what
//      comes after landed after the test's last line. The fixture names the steps and keeps a bounded number of them
//      in the race file (steps.ts); only the comparison of a test's passing and failing runs reads them.
//
// Observe only: nothing here holds, delays or changes anything in the page; the agent link is connected with
// `hold: false` and never reaches a bridge. Top frame only, and only on http(s) pages (about:blank and
// page.setContent get nothing). Never throws into the page.

/** What install.ts passes to the page script. */
export interface PageScriptConfig {
  /** The virtual path the runtime's dist/ is served on ("/__genclass__/"). */
  base: string;
  /** The runtime's `model` option: false (skip) or its options (load). */
  model: false | { baseUrl?: string };
  /** The loopback URL the agent link is pointed at (the fixture aborts requests to it). */
  agentUrl: string;
  /** The name of the function Node exposed (page.exposeFunction; context.exposeBinding for the register entry) that receives every item. */
  binding: string;
}

/** The agent entry's connection, as far as this script uses it. */
interface AgentConnection {
  reason: string | null;
  witnesses(): unknown[];
  /**
   * The record of this page load, oldest first (the newest 600 steps): each user action with its kind and target,
   * each request's send, and its delivery or its end without one, by key. For an action, `key` is the key pressed.
   */
  recorded?(): { steps?: { k?: string; key?: string; t?: number; kind?: string; target?: string }[] };
}

/**
 * The page script. `runGlobal` is the runtime's script-tag build wrapped in a function (install.ts builds the
 * source text). Serialised with toString(): keep it free of imports, closures over module scope and TypeScript-only
 * runtime features.
 */
export function genclassPageScript(cfg: PageScriptConfig, runGlobal: () => void): void {
  const w = window as unknown as Record<string, unknown>;
  try {
    if (window.top !== window) return;
  } catch {
    return;
  }
  if (!/^https?:$/.test(location.protocol)) return;
  if (w.__GENCLASS_PLAYWRIGHT__) return;

  const push = (item: Record<string, unknown>): void => {
    try {
      const f = w[cfg.binding];
      if (typeof f === "function") void (f as (x: unknown) => unknown)(item);
    } catch {
      /* never into the page */
    }
  };

  // 1. the runtime's configuration (read by the script-tag build at init, before the app's own scripts run)
  w.GENCLASS_CONFIG = { mode: "observe", telemetry: false, visual: false, analytics: false, devtools: false, report: "silent", model: cfg.model };

  // 2. the script-tag build, with a tag of its own to read data-base from
  let rt: Record<string, unknown> | null = null;
  try {
    const tag = document.createElement("script");
    tag.dataset.base = cfg.base;
    Object.defineProperty(document, "currentScript", { configurable: true, get: () => tag });
    try {
      runGlobal();
    } finally {
      delete (document as unknown as Record<string, unknown>).currentScript;
    }
    const g = w.GenClass as { runtime?: Record<string, unknown> | null } | undefined;
    rt = g && g.runtime ? g.runtime : null;
  } catch (e) {
    push({ t: "status", mode: null, model: null, error: String((e as Error)?.message ?? e) });
    return;
  }

  const status = (): Record<string, string> | null => {
    if (!rt) return null;
    const s = (rt.status ?? {}) as Record<string, unknown>;
    const m: Record<string, string> = { state: String(s.state ?? "off") };
    if (typeof s.model === "string") m.name = s.model;
    if (typeof s.version === "string") m.version = s.version;
    if (typeof s.device === "string") m.device = s.device;
    return m;
  };
  let overridden: string | null = null;
  const report = (): void => push({ t: "status", mode: rt ? String(rt.mode) : null, model: status(), ...(overridden ? { overridden } : {}) });
  const serviceWorker = (): boolean => {
    try {
      return !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    } catch {
      return false;
    }
  };

  // 5. witnesses through the agent entry (hands each new one over as it appears)
  let conn: AgentConnection | null = null;
  let handed = 0;
  let queued = false;
  const drain = (): void => {
    if (!conn) return;
    try {
      const list = conn.witnesses();
      for (; handed < list.length; handed++) push({ t: "witness", witness: list[handed] });
    } catch {
      /* ignore */
    }
  };
  // when the agent entry connected, on this page's own clock: its record counts every step's time from then
  let connectedAt = 0;
  // just before it was asked to connect: where the record's own clock starts, to the millisecond
  let recordStart = 0;
  // 9. the order of things on this page. The record's list only grows at its end (and drops its oldest past 600), so
  //    what is new is what comes after the last step handed over; a step is handed over once, with its place among
  //    this page load's steps, so the fixture puts it where it belongs whatever order the batches arrive in.
  const loadId = String(performance.timeOrigin);
  let lastStep: unknown = null;
  let handedSteps = 0;
  let bodyEnded = false;
  const handSteps = (): void => {
    try {
      if (!conn || typeof conn.recorded !== "function") return;
      const steps = conn.recorded().steps ?? [];
      if (steps.length === 0) return;
      const at = lastStep === null ? -1 : steps.lastIndexOf(lastStep as (typeof steps)[number]);
      if (at === steps.length - 1) return;
      // on the wall clock (Date.now(), which the fixture's side reads too), so that the page loads and pages of one
      // test fall into one order and the fixture can tell what landed after the test's own code had finished
      const base = Date.now() - performance.now() + recordStart;
      const out: unknown[] = [];
      for (let i = at + 1; i < steps.length; i++) {
        const s = steps[i];
        const when = Math.round(base + (typeof s.t === "number" ? s.t : 0));
        if (s.k === "act") out.push(["a", when, String(s.kind ?? ""), typeof s.target === "string" ? s.target : "", typeof s.key === "string" ? s.key : ""]);
        else if ((s.k === "send" || s.k === "recv" || s.k === "end") && typeof s.key === "string") out.push([s.k === "send" ? "s" : s.k === "recv" ? "r" : "x", when, s.key]);
      }
      lastStep = steps[steps.length - 1];
      if (out.length === 0) return;
      push({ t: "steps", id: loadId, from: handedSteps, steps: out });
      handedSteps += out.length;
    } catch {
      /* never into the page */
    }
  };
  // the test's own code has finished (the fixture asks only then): everything handed over from here on landed after it
  const endBody = (): void => {
    if (bodyEnded) return;
    bodyEnded = true;
    handSteps();
    push({ t: "body", id: loadId, n: handedSteps });
  };
  const api = {
    collect(): Record<string, unknown> {
      drain();
      endBody();
      handSteps();
      return { mode: rt ? String(rt.mode) : null, model: status(), agent: conn ? conn.reason : "not-loaded", serviceWorker: serviceWorker() };
    },
    /**
     * The requests this page load sent that were neither answered nor ended yet, each with how long ago it was sent
     * (ms), from the agent entry's record. `id` names the page load, so a caller that asks again can tell a later
     * document's requests from this one's. Null when there is no record to read. Reads only: nothing is held or waited
     * for here (the fixture does the waiting, on Node's clock, so a test that controls the page's clock is not stuck).
     */
    open(): { id: string; open: [string, number][] } | null {
      endBody();
      try {
        if (!conn || typeof conn.recorded !== "function") return null;
        const steps = conn.recorded().steps ?? [];
        const sent = new Map<string, number>();
        for (const s of steps) {
          if (typeof s.key !== "string") continue;
          if (s.k === "send") sent.set(s.key, typeof s.t === "number" ? s.t : 0);
          else if (s.k === "recv" || s.k === "end") sent.delete(s.key);
        }
        const now = performance.now() - connectedAt;
        const open: [string, number][] = [];
        sent.forEach((t, key) => open.push([key, Math.max(0, Math.round(now - t))]));
        return { id: String(performance.timeOrigin), open };
      } catch {
        return null;
      }
    },
  };
  w.__GENCLASS_PLAYWRIGHT__ = api;
  // 8. says when the page loses the network and gets it back: chaos holds no request meanwhile (a request sent offline
  //    fails at once; held until the network is back it would get through)
  try {
    const net = (): void => push({ t: "net", online: navigator.onLine !== false });
    addEventListener("offline", net);
    addEventListener("online", net);
    if (navigator.onLine === false) net();
  } catch {
    /* ignore */
  }
  if (!rt) {
    report();
    return;
  }
  // 3. observe only, whatever a URL or localStorage switch asked for
  try {
    if (String(rt.mode) !== "observe" && typeof rt.setMode === "function") {
      overridden = String(rt.mode);
      (rt.setMode as (m: string) => void).call(rt, "observe");
    }
  } catch {
    /* ignore */
  }
  report();
  const on = rt.on as ((type: string, fn: (v: unknown) => void) => () => void) | undefined;
  // 4. likely detections, with the model's diagnosis confidence (a sink record's `p` is the action's probability)
  try {
    on?.call(rt, "decide", (v: unknown) => {
      try {
        const d = v as { id?: string; trigger?: string; diagnosis?: string; diagnosisConfidence?: number; detection?: string; subject?: string };
        if (!d || d.detection !== "likely") return;
        let message = "";
        try {
          const x = (rt!.explain as (id: string) => { message?: string } | null).call(rt, String(d.id));
          message = x && typeof x.message === "string" ? x.message : "";
        } catch {
          /* no explanation */
        }
        push({ t: "record", record: { kind: "detection", trigger: d.trigger, diagnosis: d.diagnosis, p: d.diagnosisConfidence, detection: d.detection, evidence: { message, subject: d.subject } } });
      } catch {
        /* never into the page */
      }
    });
  } catch {
    /* an older runtime without this event */
  }
  try {
    on?.call(rt, "status", report);
    // a witness is computed inside the runtime's event dispatch: look after it, once per burst
    on?.call(rt, "event", () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        drain();
        handSteps();
      });
    });
  } catch {
    /* an older runtime without these events */
  }
  try {
    import(/* @vite-ignore */ /* webpackIgnore: true */ `${cfg.base}agent.js`).then(
      (m: { connectAgent?: (r: unknown, o: Record<string, unknown>) => AgentConnection }) => {
        // connectAgent binds the page's fetch now: a stand-in for this call answers the agent URL without a request
        const realFetch = w.fetch as ((u: unknown, i?: unknown) => Promise<unknown>) | undefined;
        const own = (u: unknown): boolean => {
          try {
            const s = typeof u === "string" ? u : u instanceof URL ? u.href : String((u as { url?: string })?.url ?? "");
            return s === cfg.agentUrl || s.indexOf(cfg.agentUrl + "/") === 0;
          } catch {
            return false;
          }
        };
        const standIn = function (this: unknown, u: unknown, i?: unknown): Promise<unknown> {
          if (own(u)) return Promise.resolve(new Response("null", { status: 200, headers: { "content-type": "application/json" } }));
          return (realFetch as (u: unknown, i?: unknown) => Promise<unknown>).call(this, u, i);
        };
        try {
          if (typeof realFetch === "function") w.fetch = standIn;
          recordStart = performance.now();
          conn = typeof m.connectAgent === "function" ? m.connectAgent(rt, { url: cfg.agentUrl, hold: false, anyHost: true, dom: false }) : null;
          connectedAt = performance.now();
          push({ t: "agent", ok: !!conn && conn.reason === null, reason: conn ? conn.reason : "no-connectAgent" });
          drain();
          // what happened before the agent entry connected is in its record already
          handSteps();
        } catch (e) {
          push({ t: "agent", ok: false, reason: String((e as Error)?.message ?? e) });
        } finally {
          if (w.fetch === standIn) w.fetch = realFetch;
        }
      },
      (e: unknown) => push({ t: "agent", ok: false, reason: String((e as Error)?.message ?? e) }),
    );
  } catch (e) {
    push({ t: "agent", ok: false, reason: String((e as Error)?.message ?? e) });
  }

  // 6. when the page goes away
  try {
    addEventListener("pagehide", () => {
      drain();
      handSteps();
      report();
    });
  } catch {
    /* ignore */
  }
}
