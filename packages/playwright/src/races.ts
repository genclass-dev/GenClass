// What one test collected -> one "genclass-races/1" file (the format in types.ts, which the reporter and the
// summariser read). Pure: no I/O here except the one writer at the bottom, no clock, no randomness; the same input
// gives the same bytes.
//
// Two sources, told apart by `trigger`:
//   - the runtime's likely detections (sink records of kind "detection"): trigger is the runtime's trigger kind,
//     diagnosis and confidence are the model's, evidence is the console line the runtime printed. Only with a model
//     on the page (`model: "load"`).
//   - the agent entry's witnesses (overwrote-newer, identical-in-flight): trigger "witness", diagnosis the witness
//     kind, confidence 1 (a fact that happened, not a probability; the summariser shows no confidence for them) and
//     an evidence line written here from the witness's fields. These need no model, so they are what the default
//     (`model: "skip"`) carries. A witness is a fact, never a diagnosis: nothing here maps one to "stale" or
//     "duplicate", and the report keeps them in their own group.
//   - the page's uncaught errors and unhandled rejections, as the agent entry recorded them: trigger "page-error"
//     (never the runtime's trigger "error", which the model's detections use), diagnosis the error's name, op the
//     signature of the request nearest to the error in its causal chain ("no request" without one), confidence 1 (a
//     fact). Of each error the file keeps its name, its message's shape (quoted values and numbers replaced, as
//     @genclass/mcp's shape() does), that request and whether it came from the page's own origin; nothing else of
//     its message, its stack or its chain. An error whose top stack frame is on another origin (a third-party
//     script, an extension) is left out and counted in `fixture.thirdPartyErrors`; one without a stack frame naming
//     a script is kept (origin unknown).
//   - with the fixture's `visual: true`, the runtime's measured visual checks: trigger "check", diagnosis the check
//     kind, op the normalised route, confidence 1 (a measurement against a fixed threshold, not a probability), and an
//     evidence line from the kind, the element's selector and the measured numbers only (never the element's text or
//     the console line).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_TRIGGER, PAGE_ERROR_TRIGGER, RACES_SCHEMA, type GenClassRacesFile, type RaceBurst, type RaceSignature, type RacesFixtureInfo } from "./types.js";

/** The `trigger` of a witness signature. */
export const WITNESS_TRIGGER = "witness";
export { CHECK_TRIGGER, PAGE_ERROR_TRIGGER };
/** The `op` of a page error with no request in its causal chain. */
export const NO_REQUEST = "no request";

/** A sink record of kind "detection", as far as the file reads it (the runtime's SinkRecord, by shape). */
export interface DetectionRecord {
  kind?: string;
  trigger?: string;
  diagnosis?: string;
  p?: number;
  detection?: string;
  evidence?: { message?: string; subject?: string };
}

/** An agent witness, as far as the file reads it (the runtime's agent Witness, by shape). */
export interface WitnessRecord {
  kind?: string;
  subject?: string;
  by?: string;
  over?: string;
  overKind?: string;
  gapMs?: number;
  change?: string;
}

/** A page error as the page hands it over: the agent entry's ErrorRec, by shape, and the page's origin. */
export interface PageErrorRecord {
  name?: string;
  message?: string;
  stack?: string;
  /** The causal chain at the error, newest first: request keys ("GET /api/search#3") and other operations. */
  chain?: unknown[];
  /** The page's origin (location.origin) when the error was handed over. */
  pageOrigin?: string;
}

/** What a race file keeps of one page error, and nothing else. */
export interface PageErrorFacts {
  /** The error's name ("TypeError"), at most 80 characters. */
  name: string;
  /** Its message's shape (messageShape): quoted values as "…", numbers as "N". */
  shape: string;
  /** The signature of the request nearest to the error in its causal chain ("GET /api/search"), or "no request". */
  op: string;
  /** The top frame of its stack is on the page's origin; "unknown" when no frame names a script (or there is no stack). */
  sameOrigin: boolean | "unknown";
}

/** A measured check as the page hands it over (the runtime's CheckFinding, reduced in the page). */
export interface CheckRecord {
  kind?: string;
  route?: string;
  selector?: string;
  measured?: Record<string, unknown>;
}

export interface RacesInput {
  test: string;
  seed: number;
  mode: string | null;
  model: GenClassRacesFile["model"];
  chaos: GenClassRacesFile["chaos"];
  records: readonly unknown[];
  witnesses: readonly unknown[];
  /** The page's uncaught errors (PageErrorRecord): page-error signatures, third-party ones counted and left out. */
  errors?: readonly unknown[];
  /** Measured visual checks (CheckRecord): check signatures. */
  checks?: readonly unknown[];
  /** What the fixture could and could not do on the page (written as the file's `fixture`). */
  fixture?: RacesFixtureInfo;
}

const METHOD_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([^\s()?#]+)/;

/**
 * "GET /api/search?q=… (#21)" or "GET /api/search#3~retry2" -> "GET /api/search". Anything else is kept with the
 * runtime's per-run op ids ("#12", "(#12)") taken out, so the same detection gives one signature in every seed.
 */
export function opOf(text: string | undefined): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  const m = METHOD_RE.exec(t);
  if (m) return `${m[1]} ${m[2]}`;
  return t.replace(/\s*\(#\d+\)/g, "").replace(/#\d+(~\w+)?/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function secs(ms: number | undefined): string {
  return `${((ms ?? 0) / 1000).toFixed(2)}s`;
}

/** The evidence line for a witness, from its fields (request keys as the agent names them: "GET /api/search#3"). */
export function witnessLine(w: WitnessRecord): string {
  const by = w.by ?? "?";
  if (w.kind === "overwrote-newer") {
    const change = w.change ? ` (${w.change})` : "";
    // gapMs: for a newer request, how long after `by` it started; for the user, how long after `by` they wrote
    if (w.overKind === "user") return `The response of ${by} wrote ${w.subject ?? "?"} over what the user (${w.over ?? "?"}) had written ${secs(w.gapMs)} after ${by} started${change}.`;
    return `The response of ${by} wrote ${w.subject ?? "?"} over what newer ${w.over ?? "?"}, started ${secs(w.gapMs)} after ${by}, had written${change}.`;
  }
  if (w.kind === "identical-in-flight") return `${by} was sent while the identical ${w.over ?? "?"} was still in flight (${secs(w.gapMs)} earlier), from a separate user action.`;
  return `${w.kind ?? "witness"}: ${w.subject ?? ""} by ${by} over ${w.over ?? "?"}`.trim();
}

function clamp01(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

// what @genclass/mcp's clean() removes (packages/mcp/src/text.ts): ANSI escapes, control and bidirectional characters,
// and invisible characters that can carry hidden text
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const INVISIBLE = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\u{FE00}-\u{FE0F}\u{00AD}\u{180E}\p{Co}]/gu;

/** Page text made printable: escapes and control characters out, whitespace collapsed. */
function printable(s: string): string {
  return s.replace(ANSI, "").replace(CONTROL, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

/**
 * A message's shape, for grouping and for the file: quoted values as "…", numbers as "N", whitespace collapsed, at
 * most 160 characters. The same function as @genclass/mcp's shape() (packages/mcp/src/text.ts), copied so this
 * package imports nothing of it; test/page-errors.test.ts checks that the two agree.
 */
export function messageShape(s: string): string {
  return s
    .replace(/"[^"]*"|'[^']*'/g, "…")
    .replace(/\b\d+(\.\d+)?\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** A request key as the agent entry names requests: "GET /api/search#3", "POST /api/orders#1~retry2". */
const REQUEST_KEY = /^([A-Z][A-Z0-9_-]*) (\S+)#\d+(?:~\w+)*$/;

/** The signature of the first request key in a causal chain (newest first: the nearest request), or "no request". */
export function requestOf(chain: unknown): string {
  if (Array.isArray(chain))
    for (const c of chain) {
      if (typeof c !== "string") continue;
      const m = REQUEST_KEY.exec(c.trim());
      if (m) return `${m[1]} ${m[2]}`.slice(0, 120);
    }
  return NO_REQUEST;
}

/** A stack frame line: V8's "    at fn (url:1:2)", SpiderMonkey's and JavaScriptCore's "fn@url:1:2". */
const FRAME = /^\s*at\s|^[^\s@]*@/;
const URL_IN = /[a-z][a-z0-9+.-]*:\/\/[^\s()]+/i;
/** A browser extension's script (its URL has no origin Node's URL can serialise, but it is never the page's). */
const EXTENSION = /^(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i;

/**
 * Whether an error comes from the page's own origin: the origin of the URL in the top frame of its stack, compared
 * with the page's (a browser extension's script is another origin). "unknown" when there is no stack, no frame, or
 * the top frame names no script with an origin (native code, eval, a bundler's own scheme).
 */
export function sameOriginOf(stack: unknown, pageOrigin: unknown): boolean | "unknown" {
  if (typeof stack !== "string" || typeof pageOrigin !== "string" || !pageOrigin || pageOrigin === "null") return "unknown";
  const top = stack.split("\n").find((l) => FRAME.test(l));
  const m = top ? URL_IN.exec(top) : null;
  if (!m) return "unknown";
  if (EXTENSION.test(m[0])) return false;
  let origin: string;
  try {
    origin = new URL(m[0]).origin;
  } catch {
    return "unknown";
  }
  return !origin || origin === "null" ? "unknown" : origin === pageOrigin;
}

/**
 * What the file keeps of a page error the page handed over (null when it is not one). The runtime records an error's
 * message as "<name>: <message>" (src/runtime.ts reportError): the name is taken off, so the line names it once.
 */
export function pageErrorFacts(x: unknown): PageErrorFacts | null {
  if (!x || typeof x !== "object") return null;
  const e = x as PageErrorRecord;
  const name = printable(String(e.name ?? "")).slice(0, 80) || "Error";
  let message = printable(typeof e.message === "string" ? e.message : String(e.message ?? ""));
  if (message === name || message === `${name}:`) message = "";
  else if (message.startsWith(`${name}: `)) message = message.slice(name.length + 2);
  return { name, shape: messageShape(message), op: requestOf(e.chain), sameOrigin: sameOriginOf(e.stack, e.pageOrigin) };
}

/** The evidence line of a page error, from what the file keeps of it. */
export function pageErrorLine(f: PageErrorFacts): string {
  const what = f.shape ? `${f.name}: ${f.shape}` : `${f.name} (no message)`;
  const chain = f.op === NO_REQUEST ? "no request in its causal chain" : `causal chain: ${f.op}`;
  const origin = f.sameOrigin === "unknown" ? "; origin unknown: no script URL in its stack" : "";
  return `${what} (${chain}${origin})`;
}

/** How many of the page errors came from another origin's script (they are left out of the signatures). */
export function thirdPartyErrors(errors: readonly unknown[] | undefined): number {
  let n = 0;
  for (const e of errors ?? []) if (pageErrorFacts(e)?.sameOrigin === false) n++;
  return n;
}

/** A check signature from what the page handed over: kind, route, selector, numeric measurements (null: not a check). */
export function checkSignature(x: unknown, seed: number): RaceSignature | null {
  if (!x || typeof x !== "object") return null;
  const c = x as CheckRecord;
  const kind = printable(String(c.kind ?? "")).replace(/\s+/g, "").slice(0, 60);
  if (!kind) return null;
  const route = printable(String(c.route ?? "")).slice(0, 200) || "(unknown route)";
  const selector = printable(String(c.selector ?? "")).slice(0, 300);
  const m = c.measured && typeof c.measured === "object" ? c.measured : {};
  const nums: string[] = [];
  for (const k of Object.keys(m)) {
    const v = m[k];
    if (typeof v !== "number" || !Number.isFinite(v) || nums.length >= 12) continue;
    nums.push(`${printable(k).slice(0, 40)} ${Math.round(v * 1000) / 1000}`);
  }
  const evidence = `${kind}${selector ? ` at ${selector}` : ""}${nums.length ? `: ${nums.join(", ")}` : ""}`;
  return { sig: `${CHECK_TRIGGER}|${kind}|${route}`, trigger: CHECK_TRIGGER, diagnosis: kind, op: route, confidence: 1, evidence, seeds: [seed] };
}

/** At most this many bursts in a file (`burstsLeftOut` counts the rest), and this many keys of each. */
export const MAX_FILE_BURSTS = 200;
export const MAX_BURST_KEYS = 100;

/** The reverse order's bursts as a file carries them: capped, with what was left out counted. */
export function fileBursts(bursts: readonly { keys: readonly string[]; released: readonly string[] }[]): { bursts: RaceBurst[]; burstsLeftOut?: number } {
  const list = bursts.slice(0, MAX_FILE_BURSTS).map((b) => {
    const out: RaceBurst = { keys: b.keys.slice(0, MAX_BURST_KEYS).map((k) => String(k).slice(0, 300)), released: b.released.slice(0, MAX_BURST_KEYS).map((k) => String(k).slice(0, 300)) };
    const more = Math.max(b.keys.length, b.released.length) - MAX_BURST_KEYS;
    if (more > 0) out.more = more;
    return out;
  });
  return bursts.length > MAX_FILE_BURSTS ? { bursts: list, burstsLeftOut: bursts.length - MAX_FILE_BURSTS } : { bursts: list };
}

function add(map: Map<string, RaceSignature>, s: RaceSignature): void {
  const prev = map.get(s.sig);
  if (!prev) map.set(s.sig, s);
  else if (s.confidence > prev.confidence) {
    prev.confidence = s.confidence;
    prev.evidence = s.evidence;
  }
}

/**
 * The distinct signatures of a test, sorted by `sig`: detections (likely, not `expected`), witnesses, and when given,
 * page errors (not those from another origin) and measured checks.
 */
export function signaturesOf(records: readonly unknown[], witnesses: readonly unknown[], seed: number, more: { errors?: readonly unknown[]; checks?: readonly unknown[] } = {}): RaceSignature[] {
  const out = new Map<string, RaceSignature>();
  for (const x of records) {
    if (!x || typeof x !== "object") continue;
    const r = x as DetectionRecord;
    if (r.kind !== undefined && r.kind !== "detection") continue;
    const diagnosis = String(r.diagnosis ?? "").trim();
    if (!diagnosis || diagnosis === "expected") continue;
    const trigger = String(r.trigger ?? "unknown").trim() || "unknown";
    const op = opOf(r.evidence?.subject);
    add(out, { sig: `${trigger}|${diagnosis}|${op}`, trigger, diagnosis, op, confidence: clamp01(r.p), evidence: String(r.evidence?.message ?? "").replace(/\s+/g, " ").trim(), seeds: [seed] });
  }
  for (const x of witnesses) {
    if (!x || typeof x !== "object") continue;
    const w = x as WitnessRecord;
    const diagnosis = String(w.kind ?? "").trim();
    if (!diagnosis) continue;
    const op = opOf(w.by);
    add(out, { sig: `${WITNESS_TRIGGER}|${diagnosis}|${op}`, trigger: WITNESS_TRIGGER, diagnosis, op, confidence: 1, evidence: witnessLine(w), seeds: [seed] });
  }
  for (const x of more.errors ?? []) {
    const f = pageErrorFacts(x);
    // a third-party script's error is not the app's: counted in the file (thirdPartyErrors), never a signature
    if (!f || f.sameOrigin === false) continue;
    add(out, { sig: `${PAGE_ERROR_TRIGGER}|${f.name}|${f.op}`, trigger: PAGE_ERROR_TRIGGER, diagnosis: f.name, op: f.op, confidence: 1, evidence: pageErrorLine(f), seeds: [seed] });
  }
  for (const x of more.checks ?? []) {
    const s = checkSignature(x, seed);
    if (s) add(out, s);
  }
  return [...out.values()].sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
}

/** The file for one test run. Validates against the reporter's schema by construction. */
export function buildRacesFile(i: RacesInput): GenClassRacesFile {
  const file: GenClassRacesFile = { schema: RACES_SCHEMA, test: i.test, seed: i.seed, signatures: signaturesOf(i.records, i.witnesses, i.seed, { errors: i.errors, checks: i.checks }) };
  if (i.mode) file.mode = i.mode;
  file.model = i.model ?? null;
  if (i.chaos !== undefined) file.chaos = i.chaos;
  if (i.fixture) {
    file.fixture = { ...i.fixture };
    const third = thirdPartyErrors(i.errors);
    if (third > 0) file.fixture.thirdPartyErrors = third;
  }
  return file;
}

/** A file name for a test: a slug of its title (at most 80 characters), its id, its seed and, for a retry, its attempt. */
export function racesFileName(test: string, id: string, seed: number, retry = 0): string {
  const slug = test
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  const safeId = id.replace(/[^A-Za-z0-9_-]+/g, "");
  const attempt = Number.isInteger(retry) && retry > 0 ? `-r${retry}` : "";
  return `${slug || "test"}-${safeId || "0"}-s${seed}${attempt}.json`;
}

/** Writes the file (creating the directory) and returns its path. */
export function writeRacesFile(dir: string, name: string, file: GenClassRacesFile): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}
