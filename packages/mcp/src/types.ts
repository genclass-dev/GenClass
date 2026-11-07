// Wire and store types of the GenClass MCP bridge (docs/runtime/AGENT.md). The page side is
// @genclass/runtime/agent (packages/runtime/src/agent/*); these types mirror its messages (genclass-agent/1) and its
// recorded schedules (genclass-schedule/1) on purpose, without importing the runtime: the server stays a
// zero-dependency Node package, and everything a page sends is validated here as untrusted input.

export const AGENT_SCHEMA = "genclass-agent/1";
export const SCHEDULE_SCHEMA = "genclass-schedule/1";
export const DEFAULT_PORT = 47357;

export type ScheduleOrder = "natural" | "fifo" | "seeded" | "given" | "lifo" | "ranked";

/**
 * A page load's delivery schedule (the page's ScheduleSpec, packages/runtime/src/agent/schedule.ts). lifo, ranked,
 * `reverse` and `delaySeed` need a page runtime that lists them in its hello `caps`.
 */
export interface ScheduleSpec {
  order: ScheduleOrder;
  seed?: number;
  /** seeded: the priorities turned around, so every overlapping pair goes the other way of the same seed (only true is kept). */
  reverse?: boolean;
  given?: string[];
  /** ranked: request keys from highest to lowest priority; unlisted keys rank below them, in request order. */
  ranks?: string[];
  focus?: string[];
  delay?: { minMs: number; maxMs: number };
  /** Seeds the emulated delays instead of `seed`, so every order of a session gets the same per-key delays. */
  delaySeed?: number;
  maxHoldMs?: number;
  gapMs?: number;
  id?: string;
  label?: string;
}

/** What a page runtime can run beyond natural, fifo, seeded and given (hello `caps`, genclass-agent/1). */
export type Cap = "lifo" | "ranked" | "reverse" | "delaySeed" | "net";

/**
 * One request of a page load in its timing log (the steps event's `net`, merged by key). Times are ms since the run's
 * start. ready = when its response reached the delivery gate plus its emulated delay.
 */
export interface NetEntry {
  key: string;
  /** Start index: the request's position among this page load's requests, by start time. */
  n: number;
  /** Send (start) time, to the microsecond (the page's own value, so the overlap is the one its schedule used). */
  s: number;
  /** Ready time, to the microsecond: arrived at the delivery gate, plus the emulated delay. */
  r?: number;
  /** Delivered to the app. */
  d?: number;
  /** How long the schedule held it. */
  held?: number;
  /** Released only because its hold ran out. */
  forced?: true;
  /** Released at once without scheduling (a protected request, a route in mode "off"). */
  pass?: true;
  /** The key of the request whose chain started this one. */
  via?: string;
  /** Ended without a delivery: the op status ("aborted", "error", ...). */
  end?: string;
}

export interface ActStep {
  k: "act";
  i: number;
  t: number;
  kind: string;
  target?: string;
  value?: string;
  key?: string;
  clicks?: number;
  count?: number;
  dur?: number;
}

export type Step =
  | ActStep
  | { k: "send"; t: number; key: string; detail?: string; act?: number; via?: string }
  | { k: "recv"; t: number; key: string; held?: number; forced?: boolean; ready?: number; pass?: boolean }
  | { k: "end"; t: number; key: string; status: string; code?: number | string }
  | { k: "write"; t: number; store: string; paths: string[]; by?: string; act?: number; summary?: string[] }
  | { k: "error"; t: number; message: string; by?: string; act?: number };

export interface Witness {
  kind: "overwrote-newer" | "identical-in-flight";
  t: number;
  subject: string;
  by: string;
  byDetail?: string;
  over: string;
  overKind: "request" | "user";
  byAct?: number;
  overAct?: number;
  gapMs?: number;
  change?: string;
}

export interface ErrorRec {
  t: number;
  name: string;
  message: string;
  source?: string;
  stack?: string;
  chain: string[];
  act?: number;
}

export interface Snapshot {
  t: number;
  state: Record<string, string>;
  /** Store fields the page left out of `state` (its budget), and how many it had. */
  stateLeft?: number;
  stateTotal?: number;
  text?: string[];
  /** The lines of `text` inside ARIA live regions (announcements: status messages, alerts, toasts). */
  live?: string[];
  fields?: Record<string, string>;
  requests: Record<string, number>;
  witnesses: number;
  errors: number;
  forced: number;
}

export interface DecisionRec {
  id?: string;
  trigger?: string;
  subject?: string;
  diagnosis?: string;
  diagnosisConfidence?: number;
  action?: string;
  confidence?: number;
  executed?: boolean;
  detection?: string;
  reason?: string;
  facts?: string[];
}

export interface ExplainRec {
  message?: string;
  timeline?: string[];
  situation?: string;
  changed?: string;
}

/** Why a run got its schedule. */
export interface Assignment {
  kind: "explore" | "replay" | "minimize";
  /** Explore session id or finding id. */
  ref: string;
  /** Position in the explore plan (0-based), the replay attempt, or the minimise probe. */
  index: number;
  label: string;
}

/** One page load connected to the bridge. */
export interface Run {
  id: string;
  /** The page origin that registered it; events from another origin are refused. */
  origin?: string;
  /** A secret the page got at hello and sends with its events (never persisted). */
  token?: string;
  /** Wall-clock ms (the bridge's own clock). */
  started: number;
  lastSeen: number;
  page: { url: string; route: string; title?: string };
  ua?: string;
  runtime?: { mode?: string; model?: string };
  schedule: ScheduleSpec | null;
  assignment?: Assignment;
  /** What its runtime can run beyond the first four orders (hello `caps`); absent: a runtime older than them. */
  caps?: string[];
  steps: Step[];
  /** Steps the page dropped before sending (its buffer is bounded). */
  lost: number;
  /** The request timing log by key (merged from steps events; at most 2,000 keys). */
  net?: Record<string, NetEntry>;
  /** Timing entries the page (or the bridge, past 2,000 keys) could not keep. */
  netLost?: number;
  /** What the bridge noted about this page load ("this page's runtime cannot run lifo"). */
  notes?: string[];
  order: string[];
  forced: number;
  witnesses: Witness[];
  errors: ErrorRec[];
  detections: { at: number; decision: DecisionRec; explain?: ExplainRec }[];
  interventions: { at: number; action: Record<string, unknown>; explain?: ExplainRec }[];
  checks: { at: number; check: Record<string, unknown> }[];
  expectations: { at: number; expectation: Record<string, unknown> }[];
  /** The latest snapshot at a quiet point (and the page's last one on exit). */
  snapshot?: Snapshot;
  snapshots: number;
  learned?: unknown;
  baselines?: { sig: string; count: number; median?: number; p95?: number; errorRate: number; failStreak: number }[];
  ended: boolean;
}

export type FindingKind = "race" | "stale-write" | "error" | "duplicate-request" | "detection" | "intervention" | "check" | "expectation";

export interface Finding {
  id: string;
  key: string;
  kind: FindingKind;
  /** One line, built by the bridge from recorded fields (page text inside it is quoted). */
  title: string;
  route: string;
  count: number;
  runs: string[];
  first: number;
  last: number;
  /** The replay that reproduces it (a recorded order or an explore seed), when there is one. */
  replay?: ScheduleSpec;
  /** The run to replay from (its steps are the scenario). */
  run?: string;
  evidence: Record<string, unknown>;
  /** Replay results, newest last. */
  replays: { run: string; at: number; reproduced: boolean | null; note: string }[];
}

/**
 * What a systematic plan position is: the lifo load, or cover slot `k` (0-based among the cover slots), `pending` until
 * its page load resolves it (a cover row from the baselines, or its seeded stand-in). Fifo positions are null.
 */
export type PlanSlot = { kind: "lifo" } | { kind: "cover"; k: number; pending: boolean };

export interface ExploreSession {
  id: string;
  created: number;
  route?: string;
  plan: ScheduleSpec[];
  next: number;
  runs: string[];
  state: "armed" | "collecting" | "stopped";
  focus?: string[];
  /** "runId|findingKey" pairs already counted, so reporting twice does not count a race twice. */
  counted?: string[];
  /** plan "systematic" (absent: the seeded plan). */
  strategy?: "systematic";
  /** systematic: what each plan position is (pending cover slots live here, never in a ScheduleSpec). */
  slots?: (PlanSlot | null)[];
  /** systematic: the first seed (the baselines' delaySeed, the seeded stand-ins count from it). */
  seed0?: number;
  /** systematic: what every entry shares (the added latency, its delaySeed and the hold limit). */
  shared?: Pick<ScheduleSpec, "delay" | "delaySeed" | "maxHoldMs">;
  /** systematic: how many cover slots the plan has. */
  coverSlots?: number;
  /** Plan positions re-queued as a schedule any runtime runs after a page fell back: never re-queued again. */
  substituted?: number[];
}

export interface ReplayArm {
  finding: string;
  spec: ScheduleSpec;
  route?: string;
  remaining: number;
  created: number;
  runs: string[];
}

/**
 * One minimise probe: the failing run's start order with one response moved, so exactly the inversion (a, b) (b
 * delivered before a) and the pairs it carries along happen.
 */
export interface Probe {
  spec: ScheduleSpec;
  /** [older, newer] pairs this probe may deliver newer first; (a, b) is the one it must. */
  intended: [string, string][];
  a: string;
  b: string;
  /** Requests that started between a and b (the first baseline's start order). */
  between: number;
  /** 1: a moved to just after b (an older response delivered late); 2: b moved to just before a. */
  variant: 1 | 2;
  /** The page load that ran it (the latest, when one did not get to a result and it went to another). */
  run?: string;
  /** How many page loads it went to (at most store.ts MAX_PROBE_LOADS). */
  loads?: number;
  /** Its page's runtime rejected it (a fallback): it is not assigned again. */
  rejected?: boolean;
}

/** Armed minimise probes of a race finding (in memory only, like replay arms). */
export interface MinimizeArm {
  finding: string;
  route?: string;
  created: number;
  probes: Probe[];
  /** Probes beyond the first 12 that were not armed. */
  leftOut: number;
  /**
   * Inversions of the failing run that gave no probe: their keys are not in the first baseline's start order, or start
   * the other way round there, or they were past the 50 the finding keeps. Set when not 0.
   */
  skipped?: number;
}
