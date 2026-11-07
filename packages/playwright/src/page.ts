// The part of the fixture that runs inside the page (install.ts puts it in page.addInitScript, serialised with
// Function.prototype.toString, so this file imports nothing and the function below references only its parameters
// and the page's globals). What it does, before any script of the app runs:
//
//   1. sets window.GENCLASS_CONFIG: observe mode, telemetry off, no devtools, the model as the fixture chose, and the
//      measured visual checks off unless the fixture's `visual: true` turned them on (report only: in observe mode
//      they never change the page; the runtime's reports stay silent, so they print nothing either);
//   2. runs the runtime's script-tag build (dist/genclass.global.js) with a stand-in for `document.currentScript`
//      (an init script has no tag, and the build reads `data-base` from its own tag: the stand-in points it at the
//      fixture's virtual path, so everything it loads later comes from the same place);
//   3. holds the runtime to observe: if the URL or localStorage switch (?genclass=heal, localStorage.genclass) raised
//      the mode, it is set back with rt.setMode("observe") and the file says so;
//   4. hands every likely detection to Node from the runtime's "decide" event, synchronously (with the model's
//      diagnosis confidence and the console line the runtime printed), and with the checks on every measured check
//      from its "check" event, reduced here to its kind, route, selector and numeric measurements (never the
//      element's text or the console line);
//   5. loads the agent entry (dist/agent.js) and connects it with every hold off, so the runtime records the two
//      happens-before witnesses (overwrote-newer, identical-in-flight) that need no model and the page's uncaught
//      errors, and hands each new witness and error to Node as it appears (an error with its name, message, stack,
//      causal chain and the page's origin: races.ts keeps only its name, message shape, request and origin verdict).
//      connectAgent binds the page's fetch once, when it is called: for that call only, fetch is a stand-in that
//      answers the agent's own URL with "null" without a request (so the link stays unconnected and sends nothing, no
//      console error, no failed request, no CSP report) and passes every other call to the real one;
//   6. reports the runtime's mode and model status, at start, on every status change, when the page goes away, and
//      on request (window.__GENCLASS_PLAYWRIGHT__.collect(settleMs, checkMs), which the fixture calls at the end of
//      the test: with `settleMs` it first waits, at most that long, for the agent entry's quiet point (chaos is still
//      on its plan meanwhile); with `checkMs` and the checks on it runs one more pass, at most that long), with
//      whether a service worker controls the page (page.route does not see what it handles).
//
// Observe only: nothing here holds, delays or changes anything in the page; the agent link is connected with
// `hold: false` and never reaches a bridge. The fixture's own waits use the page's timers as they were before the
// runtime and the agent entry wrapped them, so they never count as the app's. Top frame only, and only on http(s)
// pages (about:blank and page.setContent get nothing). Never throws into the page.

/** What install.ts passes to the page script. */
export interface PageScriptConfig {
  /** The virtual path the runtime's dist/ is served on ("/__genclass__/"). */
  base: string;
  /** The runtime's `model` option: false (skip) or its options (load). */
  model: false | { baseUrl?: string };
  /** The loopback URL the agent link is pointed at (the fixture aborts requests to it). */
  agentUrl: string;
  /** The name of the function Node exposed (page.exposeFunction) that receives every item. */
  binding: string;
  /** Report-only measured visual checks (the fixture's `visual: true`, with dist/visual/index.js present). */
  visual?: boolean;
}

/** The agent entry's connection, as far as this script uses it (errors and whenSettled may be missing in old builds). */
interface AgentConnection {
  reason: string | null;
  witnesses(): unknown[];
  errors?(): unknown[];
  whenSettled?(timeoutMs?: number): Promise<boolean>;
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
  // the page's timer as it is now, before the runtime's observers and the agent entry wrap it: the fixture's waits
  // must not look like the app's timers (they would keep the page from looking quiet)
  const nativeSetTimeout = w.setTimeout as (fn: () => void, ms: number) => unknown;
  const later = (fn: () => void, ms: number): void => {
    try {
      nativeSetTimeout.call(window, fn, ms);
    } catch {
      fn();
    }
  };

  // 1. the runtime's configuration (read by the script-tag build at init, before the app's own scripts run)
  w.GENCLASS_CONFIG = { mode: "observe", telemetry: false, visual: cfg.visual === true, analytics: false, devtools: false, report: "silent", model: cfg.model };

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

  // 5. witnesses and page errors through the agent entry (hands each new one over as it appears)
  let conn: AgentConnection | null = null;
  let handed = 0;
  let handedErrors = 0;
  let queued = false;
  const drain = (): void => {
    if (!conn) return;
    try {
      const list = conn.witnesses();
      for (; handed < list.length; handed++) push({ t: "witness", witness: list[handed] });
    } catch {
      /* ignore */
    }
    try {
      const errors = typeof conn.errors === "function" ? conn.errors() : [];
      for (; handedErrors < errors.length; handedErrors++) {
        const e = (errors[handedErrors] ?? {}) as { name?: unknown; message?: unknown; stack?: unknown; chain?: unknown };
        push({
          t: "error",
          error: { name: String(e.name ?? "Error"), message: String(e.message ?? ""), stack: typeof e.stack === "string" ? e.stack : undefined, chain: Array.isArray(e.chain) ? e.chain.slice(0, 10) : [] },
          pageOrigin: location.origin,
        });
      }
    } catch {
      /* ignore */
    }
  };
  // the measured checks' last pass (collect, with the checks on): did they run, and if not, why not
  let checksSeen = 0;
  const runChecks = (ms: number): Promise<string | null> =>
    new Promise((resolve) => {
      let done = false;
      const fin = (): void => {
        if (done) return;
        done = true;
        let ran = checksSeen > 0;
        try {
          const v = rt && typeof rt.summary === "function" ? ((rt.summary as () => { visual?: { passes?: number } }).call(rt).visual ?? null) : null;
          if (v && (v.passes ?? 0) > 0) ran = true;
        } catch {
          /* no summary */
        }
        resolve(ran ? null : "no pass ran");
      };
      later(fin, ms);
      try {
        const p = rt && typeof rt.checkNow === "function" ? (rt.checkNow as () => Promise<unknown>).call(rt) : null;
        if (p && typeof p.then === "function") p.then(fin, fin);
        else fin();
      } catch {
        fin();
      }
    });
  const api = {
    collect(settleMs?: number, checkMs?: number): Record<string, unknown> | Promise<Record<string, unknown>> {
      const result = (): Record<string, unknown> => {
        drain();
        return { mode: rt ? String(rt.mode) : null, model: status(), agent: conn ? conn.reason : "not-loaded", serviceWorker: serviceWorker() };
      };
      const c = conn;
      const settle = typeof settleMs === "number" && settleMs > 0 && !!c && c.reason === null && typeof c.whenSettled === "function";
      const check = typeof checkMs === "number" && checkMs > 0 && cfg.visual === true;
      if (!settle && !check) return result();
      // the quiet point first (chaos is still on its plan), then the checks' last pass, then what the page holds
      let settling: Promise<boolean | undefined> = Promise.resolve(undefined);
      if (settle)
        try {
          settling = Promise.resolve((c!.whenSettled as (ms: number) => Promise<boolean>).call(c, settleMs)).then(
            (ok) => ok === true,
            () => false,
          );
        } catch {
          settling = Promise.resolve(false);
        }
      return settling.then((ok) =>
        (check ? runChecks(checkMs as number) : Promise.resolve(undefined)).then((visual) => {
          const out = result();
          if (settle) out.settled = ok === true;
          if (check) out.visual = visual ?? null;
          return out;
        }),
      );
    },
  };
  w.__GENCLASS_PLAYWRIGHT__ = api;
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
  // 4. measured checks: the kind, the route, the selector and the numeric measurements only
  if (cfg.visual === true)
    try {
      on?.call(rt, "check", (v: unknown) => {
        try {
          const f = v as { kind?: unknown; route?: unknown; selector?: unknown; measured?: unknown };
          if (!f || typeof f.kind !== "string") return;
          const measured: Record<string, number> = {};
          const m = f.measured && typeof f.measured === "object" ? (f.measured as Record<string, unknown>) : {};
          for (const k of Object.keys(m)) {
            const n = m[k];
            if (typeof n === "number" && isFinite(n)) measured[k] = n;
          }
          checksSeen++;
          push({ t: "check", check: { kind: f.kind, route: typeof f.route === "string" ? f.route : "", selector: typeof f.selector === "string" ? f.selector.slice(0, 300) : "", measured } });
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
          conn = typeof m.connectAgent === "function" ? m.connectAgent(rt, { url: cfg.agentUrl, hold: false, anyHost: true, dom: false }) : null;
          push({ t: "agent", ok: !!conn && conn.reason === null, reason: conn ? conn.reason : "no-connectAgent" });
          drain();
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
      report();
    });
  } catch {
    /* ignore */
  }
}
