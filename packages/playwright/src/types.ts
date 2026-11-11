// The files this package reads and writes, defined locally (no import from @genclass/runtime): the fixture
// (`@genclass/playwright/fixture`, src/fixture.ts) writes one JSON file per test to `test-results/genclass/` in the
// format "genclass-races/1", and the reporter, the summariser and the command read them. The reading side never
// injects anything into a page, never routes a request and never starts a runtime.
//
// Wording follows @genclass/runtime (src/types.ts): `trigger` is a TriggerKind ("request", "delivery", "failure",
// ...), `diagnosis` is the model's diagnosis label ("duplicate", "stale", "failing", ...) and `confidence` is the
// probability the model gave that diagnosis (Decision.diagnosisConfidence). `evidence` is the line the runtime
// printed for the decision. One more trigger is the fixture's own: "witness", for the two happens-before facts the
// runtime's agent entry computes without the model (diagnosis "overwrote-newer" or "identical-in-flight",
// confidence 1: a fact, not a probability).

/** The value of the `schema` field of every file this package reads. */
export const RACES_SCHEMA = "genclass-races/1";

/**
 * The format's limits. A real file is a few KB with a handful of signatures; the limits are what lets a reader that
 * takes files from anyone (genclass-dev[bot] reads a pull request's artifacts, also from forks) bound its work.
 * - `signatures`: signatures in one file. `seeds`: seeds in one signature's `seeds` list (the fixture writes one
 *   file per seed, so it writes one). `test`, `evidence`, `text`: characters (JavaScript string length) of the
 *   test's name, of an evidence line, and of any other string (`sig`, `trigger`, `diagnosis`, `op`, `mode`, the
 *   `model` and `fixture` strings). The validator refuses a file over any of these, like any other bad field.
 * - `bytes`: the file's size as UTF-8. The validator sees parsed values, so it cannot check this one: the fixture
 *   leaves out signatures to keep a file within it, and genclass-dev[bot] reads files up to it. A reader's own size
 *   limit must never be lower, or it would refuse files a released fixture writes.
 * The fixture (src/races.ts) writes within them: it cuts strings, and when a test has more signatures than fit, by
 * count or by size, it leaves out the least confident and says how many in `dropped`.
 */
export const RACES_LIMITS = { signatures: 200, seeds: 64, test: 1000, evidence: 2000, text: 600, bytes: 64 * 1024 } as const;

/**
 * The limits of a file's optional `steps` (RacesSteps): `steps` is the most steps one file lists, `labels` the most
 * distinct labels, `label` the characters of one label. A file stays within RACES_LIMITS.bytes whatever its steps:
 * the fixture lists fewer steps before it leaves out a signature. A reader that does not know `steps` ignores it.
 */
export const STEPS_LIMITS = { steps: 2000, labels: 400, label: 160 } as const;

/** The largest `retry` a race file carries (GenClassRacesFile.retry). */
export const RETRY_LIMIT = 1000;

/** The statuses of a test a race file can carry (Playwright's TestInfo.status, without "skipped": no file is written then). */
export const RACES_STATUSES = ["passed", "failed", "timedOut", "interrupted"] as const;
export type RacesStatus = (typeof RACES_STATUSES)[number];

/**
 * The order of things on the page during one test (GenClassRacesFile.steps): user actions, and each request's send
 * and the delivery of its response to the app, named so that a step is the same step in every run of the test. It
 * holds no value a user typed, no query string and no request or response body. Only the comparison of a test's
 * passing and failing runs reads it (src/order.ts).
 */
export interface RacesSteps {
  /**
   * What the steps are about, in order of first appearance: a user action as the runtime describes it
   * ('click button "Apply"'), or a request as its method and path with ids written ":id" ("POST /api/orders"; a
   * request to another host starts with the host name, without the port). At most STEPS_LIMITS.labels, each at most
   * STEPS_LIMITS.label characters.
   */
  labels: string[];
  /**
   * The steps in order, separated by single spaces, each `<kind><label>.<n>+<ms>`: `kind` is "a" (a user action), "s"
   * (a request was sent), "r" (its response was delivered to the app) or "x" (it ended without one: it failed or was
   * aborted); `label` is an index into `labels`; `n` says which one, counted from 1 in the order they were done or
   * sent (the 2nd POST /api/orders); `ms` is the time since the step before it. "a0.1+0 s1.1+4 r1.1+38": a click,
   * 4 ms later the first POST /api/orders leaves, 38 ms later its response reaches the app. At most
   * STEPS_LIMITS.steps steps.
   */
  order: string;
  /**
   * How many of the steps listed happened while the test's own code ran; the ones after them landed while the
   * fixture waited for responses at the end of the test, and cannot have changed its result. Absent: not known.
   */
  body?: number;
  /** How many more steps the test had after the ones listed (left out to keep the file small). */
  cut?: number;
}

/** One distinct race signature seen in a test: `sig` is "trigger|diagnosis|op" with ids normalised by the fixture. */
export interface RaceSignature {
  /** "trigger|diagnosis|op", e.g. "request|duplicate|POST /api/orders". The grouping key. */
  sig: string;
  /**
   * The trigger kind of the decision (runtime TriggerKind: "request", "delivery", "failure", ...), or "witness" for
   * a fact the runtime measured without the model.
   */
  trigger: string;
  /** The model's diagnosis ("duplicate", "stale", "failing", "transient", "inconsistent", ...), or the witness kind. */
  diagnosis: string;
  /** The operation the decision was about, ids normalised ("POST /api/orders", "GET /api/items/:id"). */
  op: string;
  /** The model's probability for `diagnosis`, in [0, 1] (the runtime's Decision.diagnosisConfidence); 1 for a witness. */
  confidence: number;
  /** The evidence line the runtime printed for this decision (one line, query values already replaced by "…"). */
  evidence: string;
  /** The seeds in which the fixture saw this signature for this test (at most RACES_LIMITS.seeds). */
  seeds: number[];
}

/** One file of `test-results/genclass/`: what the fixture saw in one test. */
export interface GenClassRacesFile {
  schema: typeof RACES_SCHEMA;
  /** The test, as the fixture names it (Playwright's title path, e.g. "checkout.spec.ts > checkout > places one order"). */
  test: string;
  /** The chaos seed of this run (with one file per seed) or the first seed (with one file per test). */
  seed: number;
  /** Distinct signatures the runtime flagged in the page under test (at most RACES_LIMITS.signatures). */
  signatures: RaceSignature[];
  /**
   * Optional, written by the fixture: how many more distinct signatures the test had than this file holds. The
   * fixture leaves out the least confident ones to keep a file within RACES_LIMITS (signatures, bytes); the report
   * says so under the test, so a list that is not complete never reads as complete.
   */
  dropped?: number;
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
  /** Optional: the chaos the fixture applied (its `chaos` option: `latencyMs` is its `delayMs`), shown when present. */
  chaos?: { latencyMs?: [number, number]; reorder?: boolean; failRate?: number; routes?: unknown[] } | null;
  /**
   * Optional, written by the fixture: what it could and could not do on the page, so the report can tell a run it
   * checked from one it could not. `model`: the fixture's model option. `agent`: null when the agent entry connected
   * (witnesses recorded), else why not. `chaosApplied`: how many requests chaos held (null: chaos off). `serviceWorker`:
   * a service worker controlled the page (page.route, and so chaos, does not see what it handles).
   * `modeOverridden`: the mode a URL or localStorage switch had asked for, set back to observe.
   */
  fixture?: RacesFixtureInfo;
  /**
   * Optional, written by the fixture: where the test is declared. `file` is a path with "/" separators relative to the
   * repository root (the directory in GITHUB_WORKSPACE on GitHub Actions, else the Playwright config's directory),
   * `line` its 1-based line. It lets a pull-request review (genclass-dev[bot]) put a finding next to the test when that
   * line is part of the diff; the summariser and the report do not use it.
   */
  location?: RacesLocation;
  /**
   * Optional, written by the fixture: the test's own status when the file was written, as Playwright reports it. It is
   * what tells a test's failing runs from its passing ones (src/order.ts); a finding never depends on it. A test
   * marked as expected to fail (`test.fail()`) gets none: its failing is not a failing run.
   */
  status?: RacesStatus;
  /**
   * Optional, written by the fixture: the order of user actions, requests and responses on the page (RacesSteps),
   * bounded by STEPS_LIMITS. A value this version cannot read is left out, never a reason to skip the file.
   */
  steps?: RacesSteps;
  /**
   * Optional, written by the fixture for a retried attempt only: which attempt the file is of (Playwright's
   * TestInfo.retry, from 1 to RETRY_LIMIT; a first attempt has none). The comparison of a test's failing and passing
   * runs leaves retried attempts out (src/order.ts): an attempt made after a failure, under the same seed, is not one
   * more run. Read leniently, like `status` and `steps`.
   */
  retry?: number;
}

/** Where a test is declared (GenClassRacesFile.location). */
export interface RacesLocation {
  file: string;
  line: number;
}

/** The fixture's own record in a race file (GenClassRacesFile.fixture). */
export interface RacesFixtureInfo {
  model: "skip" | "load";
  agent: string | null;
  chaosApplied: number | null;
  serviceWorker: boolean;
  modeOverridden?: string;
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
