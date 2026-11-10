// Validation of "genclass-races/1" files. Pure (no Node APIs): it runs in the reporter, in a CI script and in tests.
// A file that fails validation is never half-read: the summariser lists it under "Files skipped" with these
// messages, so a change of format on the fixture's side shows up in the pull-request comment instead of silently
// producing an empty report. A file with another `schema` value is rejected on that field alone (its other fields
// may legitimately differ).
//
// The format's limits (RACES_LIMITS in types.ts) are checked here too, so that whoever reads a file after this
// validator knows how much it can hold: a file with more signatures than the limit is rejected on that count alone
// (its signatures are not looked at one by one), and a string longer than its limit rejects the file like any other
// bad field. The fixture writes within them (src/races.ts).

import { RACES_LIMITS, RACES_SCHEMA, type GenClassRacesFile, type RaceSignature, type RacesParseResult } from "./types.js";

/** At most this many messages per file; the rest are counted. */
export const MAX_ERRORS = 8;

function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "object") return "an object";
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 39)}…` : v);
  return String(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * A path inside a repository: relative, "/" separators, no "." or ".." segment, no control character, at most 400
 * characters. Exported for the fixture, which leaves out a `location` this would refuse.
 */
export function isRepoPath(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 400 || v.startsWith("/") || v.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v) || /^[A-Za-z]:/.test(v)) return false;
  return v.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** Adds a message when `v` is a string longer than `max` characters (another type is some other check's message). */
function within(v: unknown, max: number, at: string, errors: string[]): void {
  if (typeof v === "string" && v.length > max) errors.push(`${at}: expected at most ${max} characters, got ${v.length}`);
}

function fail(errors: string[]): RacesParseResult {
  if (errors.length > MAX_ERRORS) {
    const more = errors.length - MAX_ERRORS;
    errors = [...errors.slice(0, MAX_ERRORS), `and ${more} more error${more === 1 ? "" : "s"}`];
  }
  return { ok: false, errors };
}

function signature(v: unknown, at: string, errors: string[]): RaceSignature | null {
  if (!isObject(v)) {
    errors.push(`${at}: expected an object, got ${describe(v)}`);
    return null;
  }
  const before = errors.length;
  if (typeof v.sig !== "string" || v.sig.trim() === "") errors.push(`${at}.sig: expected a non-empty string, got ${describe(v.sig)}`);
  for (const k of ["trigger", "diagnosis"] as const)
    if (typeof v[k] !== "string" || (v[k] as string).trim() === "") errors.push(`${at}.${k}: expected a non-empty string, got ${describe(v[k])}`);
  if (typeof v.op !== "string") errors.push(`${at}.op: expected a string, got ${describe(v.op)}`);
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1)
    errors.push(`${at}.confidence: expected a number from 0 to 1, got ${describe(v.confidence)}`);
  if (typeof v.evidence !== "string") errors.push(`${at}.evidence: expected a string, got ${describe(v.evidence)}`);
  for (const k of ["sig", "trigger", "diagnosis", "op"] as const) within(v[k], RACES_LIMITS.text, `${at}.${k}`, errors);
  within(v.evidence, RACES_LIMITS.evidence, `${at}.evidence`, errors);
  if (!Array.isArray(v.seeds)) errors.push(`${at}.seeds: expected an array of integers, got ${describe(v.seeds)}`);
  else
    v.seeds.forEach((s, i) => {
      if (!isInt(s)) errors.push(`${at}.seeds[${i}]: expected an integer, got ${describe(s)}`);
    });
  if (errors.length > before) return null;
  return {
    sig: (v.sig as string).trim(),
    trigger: (v.trigger as string).trim(),
    diagnosis: (v.diagnosis as string).trim(),
    op: (v.op as string).trim(),
    confidence: v.confidence as number,
    evidence: v.evidence as string,
    seeds: [...new Set(v.seeds as number[])].sort((a, b) => a - b),
  };
}

/**
 * Validates a parsed "genclass-races/1" value. On success the file is a normalised copy: only the fields of the
 * format, strings trimmed, each signature's seeds de-duplicated and sorted. Never throws.
 */
export function validateRaces(value: unknown): RacesParseResult {
  if (!isObject(value)) return fail([`expected a JSON object, got ${describe(value)}`]);
  if (value.schema !== RACES_SCHEMA) {
    if (value.schema !== undefined) return fail([`schema: expected "${RACES_SCHEMA}", got ${describe(value.schema)}`]);
    const hint = value.format === RACES_SCHEMA ? ` (the file has "format": "${RACES_SCHEMA}"; the field is named "schema")` : "";
    return fail([`schema: missing, expected "${RACES_SCHEMA}"${hint}`]);
  }
  const errors: string[] = [];
  if (typeof value.test !== "string" || value.test.trim() === "") errors.push(`test: expected a non-empty string, got ${describe(value.test)}`);
  within(value.test, RACES_LIMITS.test, "test", errors);
  if (!isInt(value.seed)) errors.push(`seed: expected an integer, got ${describe(value.seed)}`);
  const signatures: RaceSignature[] = [];
  if (!Array.isArray(value.signatures)) errors.push(`signatures: expected an array, got ${describe(value.signatures)}`);
  // over the limit, the count is the whole answer: the signatures are not looked at one by one
  else if (value.signatures.length > RACES_LIMITS.signatures) errors.push(`signatures: expected at most ${RACES_LIMITS.signatures} signatures, got ${value.signatures.length}`);
  else
    value.signatures.forEach((s, i) => {
      const r = signature(s, `signatures[${i}]`, errors);
      if (r) signatures.push(r);
    });
  if (value.dropped !== undefined && !(isInt(value.dropped) && value.dropped >= 0)) errors.push(`dropped: expected a whole number when present, got ${describe(value.dropped)}`);
  if (value.mode !== undefined && typeof value.mode !== "string") errors.push(`mode: expected a string when present, got ${describe(value.mode)}`);
  within(value.mode, RACES_LIMITS.text, "mode", errors);
  if (value.model !== undefined && value.model !== null) {
    if (!isObject(value.model)) errors.push(`model: expected an object or null when present, got ${describe(value.model)}`);
    else
      for (const k of ["state", "name", "version", "device"]) {
        if (value.model[k] !== undefined && typeof value.model[k] !== "string") errors.push(`model.${k}: expected a string when present, got ${describe(value.model[k])}`);
        within(value.model[k], RACES_LIMITS.text, `model.${k}`, errors);
      }
  }
  if (value.chaos !== undefined && value.chaos !== null && !isObject(value.chaos)) errors.push(`chaos: expected an object or null when present, got ${describe(value.chaos)}`);
  if (value.fixture !== undefined) {
    const x = value.fixture;
    if (!isObject(x)) errors.push(`fixture: expected an object when present, got ${describe(x)}`);
    else {
      if (x.model !== "skip" && x.model !== "load") errors.push(`fixture.model: expected "skip" or "load", got ${describe(x.model)}`);
      if (x.agent !== null && typeof x.agent !== "string") errors.push(`fixture.agent: expected a string or null, got ${describe(x.agent)}`);
      if (x.chaosApplied !== null && !(isInt(x.chaosApplied) && x.chaosApplied >= 0)) errors.push(`fixture.chaosApplied: expected a whole number or null, got ${describe(x.chaosApplied)}`);
      if (typeof x.serviceWorker !== "boolean") errors.push(`fixture.serviceWorker: expected true or false, got ${describe(x.serviceWorker)}`);
      if (x.modeOverridden !== undefined && typeof x.modeOverridden !== "string") errors.push(`fixture.modeOverridden: expected a string when present, got ${describe(x.modeOverridden)}`);
      within(x.agent, RACES_LIMITS.text, "fixture.agent", errors);
      within(x.modeOverridden, RACES_LIMITS.text, "fixture.modeOverridden", errors);
    }
  }
  if (value.location !== undefined) {
    const l = value.location;
    if (!isObject(l)) errors.push(`location: expected an object when present, got ${describe(l)}`);
    else {
      if (!isRepoPath(l.file)) errors.push(`location.file: expected a relative path with "/" separators, got ${describe(l.file)}`);
      if (!(isInt(l.line) && l.line >= 1)) errors.push(`location.line: expected a line number from 1, got ${describe(l.line)}`);
    }
  }
  if (errors.length) return fail(errors);

  const file: GenClassRacesFile = { schema: RACES_SCHEMA, test: (value.test as string).trim(), seed: value.seed as number, signatures };
  if (typeof value.dropped === "number") file.dropped = value.dropped;
  if ("shadow" in value) file.shadow = value.shadow;
  if (typeof value.mode === "string") file.mode = value.mode;
  if (value.model === null) file.model = null;
  else if (isObject(value.model)) {
    const m: NonNullable<GenClassRacesFile["model"]> = {};
    for (const k of ["state", "name", "version", "device"] as const) if (typeof value.model[k] === "string") m[k] = value.model[k] as string;
    file.model = m;
  }
  if (value.chaos === null) file.chaos = null;
  else if (isObject(value.chaos)) {
    const c = value.chaos;
    const out: NonNullable<GenClassRacesFile["chaos"]> = {};
    if (Array.isArray(c.latencyMs) && c.latencyMs.length === 2 && c.latencyMs.every((n) => typeof n === "number" && Number.isFinite(n)))
      out.latencyMs = [c.latencyMs[0] as number, c.latencyMs[1] as number];
    if (typeof c.reorder === "boolean") out.reorder = c.reorder;
    if (typeof c.failRate === "number" && Number.isFinite(c.failRate)) out.failRate = c.failRate;
    if (Array.isArray(c.routes)) out.routes = c.routes.slice();
    file.chaos = out;
  }
  if (isObject(value.fixture)) {
    const x = value.fixture;
    file.fixture = { model: x.model as "skip" | "load", agent: x.agent as string | null, chaosApplied: x.chaosApplied as number | null, serviceWorker: x.serviceWorker as boolean };
    if (typeof x.modeOverridden === "string") file.fixture.modeOverridden = x.modeOverridden;
  }
  if (isObject(value.location)) file.location = { file: value.location.file as string, line: value.location.line as number };
  return { ok: true, file };
}

/** Parses and validates the text of one file (a leading byte-order mark is ignored). Never throws. */
export function parseRaces(text: string): RacesParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return fail([`not valid JSON (${e instanceof Error ? e.message : String(e)})`]);
  }
  return validateRaces(value);
}
