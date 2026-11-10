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
//
// A file is written within the format's limits (RACES_LIMITS in types.ts), so the fixture never writes a file the
// validator refuses for them: strings are cut to their limit (a cut one ends with "…"), a `location` the validator
// would refuse is left out, and when a test has more signatures than a file holds, by count or by size, the least
// confident are left out and counted in `dropped`, which the report shows under the test. Leaving signatures out is
// the only way a file is made smaller: one that is over the size limit without any signature is written as it is.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRepoPath } from "./schema.js";
import { RACES_LIMITS, RACES_SCHEMA, type GenClassRacesFile, type RaceSignature, type RacesFixtureInfo, type RacesLocation } from "./types.js";

/** The `trigger` of a witness signature. */
export const WITNESS_TRIGGER = "witness";

/** The longest `trigger` or `diagnosis`, and the longest `op`, written: `sig` ("trigger|diagnosis|op") then fits RACES_LIMITS.text. */
const MAX_LABEL = 100;
const MAX_OP = 300;

/** `s` in at most `max` characters: a longer one is cut (never inside a surrogate pair) and ends with "…". */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${s.slice(0, end)}…`;
}

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

export interface RacesInput {
  test: string;
  seed: number;
  mode: string | null;
  model: GenClassRacesFile["model"];
  chaos: GenClassRacesFile["chaos"];
  records: readonly unknown[];
  witnesses: readonly unknown[];
  /** What the fixture could and could not do on the page (written as the file's `fixture`). */
  fixture?: RacesFixtureInfo;
  /** Where the test is declared (written as the file's `location`), when the fixture could tell. */
  location?: RacesLocation;
}

const METHOD_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([^\s()?#]+)/;

/**
 * "GET /api/search?q=… (#21)" or "GET /api/search#3~retry2" -> "GET /api/search". Anything else is kept with the
 * runtime's per-run op ids ("#12", "(#12)") taken out, so the same detection gives one signature in every seed.
 * At most 300 characters (a longer path is cut the same way in every seed).
 */
export function opOf(text: string | undefined): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  const m = METHOD_RE.exec(t);
  if (m) return cut(`${m[1]} ${m[2]}`, MAX_OP);
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

function add(map: Map<string, RaceSignature>, s: RaceSignature): void {
  const prev = map.get(s.sig);
  if (!prev) map.set(s.sig, s);
  else if (s.confidence > prev.confidence) {
    prev.confidence = s.confidence;
    prev.evidence = s.evidence;
  }
}

function bySig(a: RaceSignature, b: RaceSignature): number {
  return a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0;
}

/**
 * Every distinct signature of a test, sorted by `sig`: detections (likely, not `expected`) and witnesses. Each
 * string is within the format's limits; how many a file holds is buildRacesFile's business.
 */
export function signaturesOf(records: readonly unknown[], witnesses: readonly unknown[], seed: number): RaceSignature[] {
  const out = new Map<string, RaceSignature>();
  for (const x of records) {
    if (!x || typeof x !== "object") continue;
    const r = x as DetectionRecord;
    if (r.kind !== undefined && r.kind !== "detection") continue;
    const diagnosis = cut(String(r.diagnosis ?? "").trim(), MAX_LABEL);
    if (!diagnosis || diagnosis === "expected") continue;
    const trigger = cut(String(r.trigger ?? "unknown").trim() || "unknown", MAX_LABEL);
    const op = opOf(r.evidence?.subject);
    const evidence = cut(String(r.evidence?.message ?? "").replace(/\s+/g, " ").trim(), RACES_LIMITS.evidence);
    add(out, { sig: `${trigger}|${diagnosis}|${op}`, trigger, diagnosis, op, confidence: clamp01(r.p), evidence, seeds: [seed] });
  }
  for (const x of witnesses) {
    if (!x || typeof x !== "object") continue;
    const w = x as WitnessRecord;
    const diagnosis = cut(String(w.kind ?? "").trim(), MAX_LABEL);
    if (!diagnosis) continue;
    const op = opOf(w.by);
    add(out, { sig: `${WITNESS_TRIGGER}|${diagnosis}|${op}`, trigger: WITNESS_TRIGGER, diagnosis, op, confidence: 1, evidence: cut(witnessLine(w), RACES_LIMITS.evidence), seeds: [seed] });
  }
  return [...out.values()].sort(bySig);
}

/** The text of a file as the fixture writes it: two-space JSON and a final newline. */
export function racesFileText(file: GenClassRacesFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

const MODEL_KEYS = ["state", "name", "version", "device"] as const;

/**
 * The file for one test run, within the format's limits (RACES_LIMITS), so the reporter's validator accepts it and a
 * reader with those limits reads it: the test's name, the mode and the model and fixture strings are cut to their
 * limit, a `location` the validator would refuse is left out, and when the test has more signatures than a file
 * holds (RACES_LIMITS.signatures of them, or RACES_LIMITS.bytes of text) the least confident are left out, the rest
 * stay sorted by `sig`, and `dropped` says how many were left out. Pure: the same input gives the same file.
 */
export function buildRacesFile(i: RacesInput): GenClassRacesFile {
  const all = signaturesOf(i.records, i.witnesses, i.seed);
  // what stays when not everything fits: the most confident first (a witness is a fact, confidence 1), then by `sig`
  const ranked = [...all].sort((a, b) => b.confidence - a.confidence || bySig(a, b));
  const make = (keep: number): GenClassRacesFile => {
    const file: GenClassRacesFile = { schema: RACES_SCHEMA, test: cut(i.test, RACES_LIMITS.test), seed: i.seed, signatures: keep >= all.length ? all : ranked.slice(0, keep).sort(bySig) };
    if (keep < all.length) file.dropped = all.length - keep;
    if (i.mode) file.mode = cut(i.mode, RACES_LIMITS.text);
    if (i.model) {
      const model = { ...i.model };
      for (const k of MODEL_KEYS) {
        const v = model[k];
        if (typeof v === "string") model[k] = cut(v, RACES_LIMITS.text);
      }
      file.model = model;
    } else file.model = null;
    if (i.chaos !== undefined) file.chaos = i.chaos;
    if (i.fixture) {
      file.fixture = { ...i.fixture };
      if (typeof file.fixture.agent === "string") file.fixture.agent = cut(file.fixture.agent, RACES_LIMITS.text);
      if (typeof file.fixture.modeOverridden === "string") file.fixture.modeOverridden = cut(file.fixture.modeOverridden, RACES_LIMITS.text);
    }
    if (i.location && isRepoPath(i.location.file) && Number.isInteger(i.location.line) && i.location.line >= 1) file.location = { file: i.location.file, line: i.location.line };
    return file;
  };
  const fits = (file: GenClassRacesFile): boolean => new TextEncoder().encode(racesFileText(file)).length <= RACES_LIMITS.bytes;
  let keep = Math.min(all.length, RACES_LIMITS.signatures);
  let file = make(keep);
  if (keep > 0 && !fits(file)) {
    // the largest number of signatures that fits (taking one out always makes the file smaller)
    let lo = 0;
    let hi = keep - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fits(make(mid))) lo = mid;
      else hi = mid - 1;
    }
    keep = lo;
    file = make(keep);
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
  writeFileSync(path, racesFileText(file));
  return path;
}
