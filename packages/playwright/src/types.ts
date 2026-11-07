// The files this package reads and writes, defined locally (no import from @genclass/runtime): the fixture
// (`@genclass/playwright/fixture`, src/fixture.ts) writes one JSON file per test to `test-results/genclass/` in the
// format "genclass-races/1", and the reporter, the summariser and the command read them. The reading side never
// injects anything into a page, never routes a request and never starts a runtime.
//
// Wording follows @genclass/runtime (src/types.ts): `trigger` is a TriggerKind ("request", "delivery", "failure",
// ...), `diagnosis` is the model's diagnosis label ("duplicate", "stale", "failing", ...) and `confidence` is the
// probability the model gave that diagnosis (Decision.diagnosisConfidence). `evidence` is the line the runtime
// printed for the decision. Three more triggers are the fixture's own, none of them the model's: "witness", for the
// two happens-before facts the runtime's agent entry computes without the model (diagnosis "overwrote-newer" or
// "identical-in-flight", confidence 1: a fact, not a probability); "page-error", for an uncaught error or unhandled
// rejection the agent entry recorded in the page (diagnosis: the error's name; never the runtime's own trigger
// "error", which the model's detections use); and "check", for a measured visual check (diagnosis: the check kind;
// with the fixture's `visual: true` only). Every field added after the first version is optional and written only
// when it has something to say, so a file of an older fixture reads as it always did.

/** The value of the `schema` field of every file this package reads. */
export const RACES_SCHEMA = "genclass-races/1";

/** The `trigger` of a page-error signature: an uncaught error the agent entry recorded (not the model's "error"). */
export const PAGE_ERROR_TRIGGER = "page-error";

/** The `trigger` of a measured visual check signature (the runtime's kind "check": a measurement, not the model). */
export const CHECK_TRIGGER = "check";

/** The order one file's chaos ran in, with `chaos.order: "systematic"`: repeat 0 natural, 1 reverse, later seeded. */
export type RaceChaosOrder = "natural" | "reverse" | "seeded";

/**
 * One burst of the reverse order: matched requests that left close together, held, then released newest first.
 * `keys` in the order the page sent them, `released` in the order they left (newest first, unless a hold ran out
 * first or the page went away); `more` counts requests of the burst not listed (a file lists at most 100 per burst).
 */
export interface RaceBurst {
  keys: string[];
  released: string[];
  more?: number;
}

/** One distinct race signature seen in a test: `sig` is "trigger|diagnosis|op" with ids normalised by the fixture. */
export interface RaceSignature {
  /** "trigger|diagnosis|op", e.g. "request|duplicate|POST /api/orders". The grouping key. */
  sig: string;
  /**
   * The trigger kind of the decision (runtime TriggerKind: "request", "delivery", "failure", ...), or "witness" for
   * a fact the runtime measured without the model, "page-error" for an uncaught error in the page, "check" for a
   * measured visual check.
   */
  trigger: string;
  /**
   * The model's diagnosis ("duplicate", "stale", "failing", "transient", "inconsistent", ...), the witness kind, the
   * page error's name ("TypeError") or the check kind ("text-invisible").
   */
  diagnosis: string;
  /**
   * The operation the decision was about, ids normalised ("POST /api/orders", "GET /api/items/:id"); for a page
   * error the request nearest to it in its causal chain, or "no request"; for a check the normalised route.
   */
  op: string;
  /**
   * The model's probability for `diagnosis`, in [0, 1] (the runtime's Decision.diagnosisConfidence); 1 for a witness,
   * a page error or a check (a fact or a measurement, not a probability).
   */
  confidence: number;
  /** The evidence line the runtime printed for this decision (one line, query values already replaced by "…"). */
  evidence: string;
  /** The seeds in which the fixture saw this signature for this test. */
  seeds: number[];
}

/** One file of `test-results/genclass/`: what the fixture saw in one test. */
export interface GenClassRacesFile {
  schema: typeof RACES_SCHEMA;
  /** The test, as the fixture names it (Playwright's title path, e.g. "checkout.spec.ts > checkout > places one order"). */
  test: string;
  /** The chaos seed of this run (with one file per seed) or the first seed (with one file per test). */
  seed: number;
  /** Distinct signatures the runtime flagged in the page under test. */
  signatures: RaceSignature[];
  /**
   * The fixture's shadow-mode record. Carried through and validated only as "present or absent"; this package
   * draws no conclusion from it (it says nothing about interventions).
   */
  shadow?: unknown;
  /** Optional: the mode the page's runtime ran in ("observe", "guard", ...), shown when present. */
  mode?: string;
  /**
   * Optional: the page's model status when the fixture collected (null: GenClass never started in the page). When a
   * file flagged nothing and its model was not "ready" (for example "loading"), the report notes that the run may
   * not have been checked. A file with detections is reported whatever the state: the runtime can unload an idle
   * model after it ran ("unloaded"). A file whose `fixture.model` is "skip" gets no model note (no model by choice);
   * the agent state decides instead.
   */
  model?: { state?: string; name?: string; version?: string; device?: string } | null;
  /**
   * Optional: the chaos the fixture applied (its `chaos` option: `latencyMs` is its `delayMs`), shown when present.
   * With `chaos.order: "systematic"` also `order`, the order this file's run used (the report shows it next to the
   * seed, and a "natural" run does not count toward reproducible), and for the reverse order `bursts` (at most 200;
   * `burstsLeftOut` counts the rest).
   */
  chaos?: { latencyMs?: [number, number]; reorder?: boolean; failRate?: number; routes?: unknown[]; order?: RaceChaosOrder; bursts?: RaceBurst[]; burstsLeftOut?: number } | null;
  /**
   * Optional, written by the fixture: what it could and could not do on the page, so the report can tell a run it
   * checked from one it could not. `model`: the fixture's model option. `agent`: null when the agent entry connected
   * (witnesses recorded), else why not. `chaosApplied`: how many requests chaos held (null: chaos off). `serviceWorker`:
   * a service worker controlled the page (page.route, and so chaos, does not see what it handles).
   * `modeOverridden`: the mode a URL or localStorage switch had asked for, set back to observe. With chaos on,
   * `settled`: whether the page reached a quiet point before the fixture collected. `thirdPartyErrors`: page errors
   * left out because they came from another origin's script. With `visual: true`, `visual`: null when the measured
   * checks ran, else why not.
   */
  fixture?: RacesFixtureInfo;
}

/** The fixture's own record in a race file (GenClassRacesFile.fixture). */
export interface RacesFixtureInfo {
  model: "skip" | "load";
  agent: string | null;
  chaosApplied: number | null;
  serviceWorker: boolean;
  modeOverridden?: string;
  /**
   * Written with chaos on: true when the page reached a quiet point (the agent entry's whenSettled: nothing in flight
   * or held, no short timer pending, no event for its settle time) within the fixture's 2 s wait after the test,
   * false when it did not, so what happened later was not recorded. A report note, never a signature.
   */
  settled?: boolean;
  /** Page errors left out because the top frame of their stack was on another origin (written when there were any). */
  thirdPartyErrors?: number;
  /** Written with `visual: true`: null when the measured checks ran, else why they did not ("dist/visual/index.js missing"). */
  visual?: string | null;
}

/** One input of the summariser: a file's name (shown in the report) and its content (JSON text or parsed). */
export interface RacesFileInput {
  name: string;
  content: string | unknown;
  /** Set when the file could not be read: it is listed as skipped with this reason and `content` is ignored. */
  error?: string;
}

/** Result of validating one file. */
export type RacesParseResult = { ok: true; file: GenClassRacesFile } | { ok: false; errors: string[] };
