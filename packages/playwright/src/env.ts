// The register entry's options, from environment variables: an unmodified playwright.config has no `use.genclass`,
// so what the fixture takes from the config comes from the environment here. Pure: it reads the object it is given
// (process.env in production), touches no file, and never throws: a value it cannot read is replaced by the default
// and reported as one line, so a typo in a workflow file never fails a test run.
//
//   GENCLASS_PLAYWRIGHT       off | 0 | false | no: the register entry does nothing (the off switch)
//   GENCLASS_CHAOS            on | off (1/0, true/false, yes/no): seeded network chaos. Off unless given; the command
//                             (genclass-playwright-run) turns it on when it is not set
//   GENCLASS_SEED             the chaos seed, a whole number from 0 (default 1); Playwright's repeat index is added
//   GENCLASS_CHAOS_DELAY_MS   "min,max": extra latency per matched request in ms (default 0,600; at most 10000)
//   GENCLASS_CHAOS_REORDER    on | off (default on); off: matched requests leave in order, latency only
//   GENCLASS_CHAOS_MATCH      comma-separated path prefixes ("/api") or URL prefixes ("https://api.example.com/")
//                             (default: same-origin /api* or an Accept header asking for JSON)
//   GENCLASS_OUT_DIR          where the race files go, against the working directory (default test-results/genclass)
//   GENCLASS_MODEL            skip (default) | load
//   GENCLASS_MODEL_URL        with GENCLASS_MODEL=load: a model directory URL
//   GENCLASS_RUNTIME_DIR      @genclass/runtime's dist/ directory, when it is not installed next to this package
//   GENCLASS_NOTES_FILE       set by the command: where the register entry appends the lines it remembers

import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_SEED, type ChaosOptions } from "./chaos.js";
import type { GenClassOptions } from "./session.js";

/** The variables' names. */
export const ENV = {
  off: "GENCLASS_PLAYWRIGHT",
  chaos: "GENCLASS_CHAOS",
  seed: "GENCLASS_SEED",
  delayMs: "GENCLASS_CHAOS_DELAY_MS",
  reorder: "GENCLASS_CHAOS_REORDER",
  match: "GENCLASS_CHAOS_MATCH",
  outDir: "GENCLASS_OUT_DIR",
  model: "GENCLASS_MODEL",
  modelUrl: "GENCLASS_MODEL_URL",
  runtimeDir: "GENCLASS_RUNTIME_DIR",
  notesFile: "GENCLASS_NOTES_FILE",
} as const;

/** Where the race files go when GENCLASS_OUT_DIR is not set, against the working directory. */
export const DEFAULT_OUT_DIR = join("test-results", "genclass");

export type Env = Readonly<Record<string, string | undefined>>;

export interface EnvOptions {
  /** The off switch is set: nothing is wrapped, nothing is written. */
  off: boolean;
  /** What the fixture would have taken from `use.genclass`. `outDir` and `runtimeDir` are absolute. */
  options: GenClassOptions;
  /** One line per value that could not be read (the default was used instead). */
  notes: string[];
}

const ON = new Set(["1", "true", "on", "yes"]);
const OFF = new Set(["0", "false", "off", "no"]);

function text(env: Env, name: string): string | undefined {
  const v = env[name];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** on/off, 1/0, true/false, yes/no (any case); undefined when unset; null when it is something else. */
export function flagOf(value: string | undefined): boolean | undefined | null {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "") return undefined;
  if (ON.has(v)) return true;
  if (OFF.has(v)) return false;
  return null;
}

/** True when the off switch (GENCLASS_PLAYWRIGHT) says off. Anything else, set or not, is on. */
export function isOff(env: Env): boolean {
  return flagOf(env[ENV.off]) === false;
}

/**
 * Reads the options. `cwd` is what relative directories are resolved against; `chaosDefault` is whether chaos is on
 * when GENCLASS_CHAOS is not set (off for the register entry alone, like the fixture).
 */
export function optionsFromEnv(env: Env, cwd: string, chaosDefault = false): EnvOptions {
  const notes: string[] = [];
  const bad = (name: string, expected: string, used: string): void => void notes.push(`${name}=${JSON.stringify(env[name])} is not ${expected}; using ${used}`);
  const flag = (name: string, fallback: boolean): boolean => {
    const f = flagOf(env[name]);
    if (f === null) bad(name, "on or off", fallback ? "on" : "off");
    return f ?? fallback;
  };
  const options: GenClassOptions = {};

  if (flag(ENV.chaos, chaosDefault)) {
    const chaos: ChaosOptions = {};
    const seed = text(env, ENV.seed);
    if (seed !== undefined) {
      if (/^\d+$/.test(seed) && Number.isSafeInteger(Number(seed))) chaos.seed = Number(seed);
      else bad(ENV.seed, "a whole number from 0", String(DEFAULT_SEED));
    }
    const delay = text(env, ENV.delayMs);
    if (delay !== undefined) {
      const m = /^(\d+)\s*,\s*(\d+)$/.exec(delay);
      if (m && Number(m[1]) <= Number(m[2])) chaos.delayMs = [Number(m[1]), Number(m[2])];
      else bad(ENV.delayMs, '"min,max" in ms with min not above max', "0,600");
    }
    if (!flag(ENV.reorder, true)) chaos.reorder = false;
    const match = text(env, ENV.match);
    if (match !== undefined) {
      const list = match.split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length) chaos.match = list;
    }
    options.chaos = Object.keys(chaos).length ? chaos : true;
  }

  const model = text(env, ENV.model);
  if (model === "load") options.model = "load";
  else if (model !== undefined && model !== "skip") bad(ENV.model, '"skip" or "load"', "skip");
  const modelUrl = text(env, ENV.modelUrl);
  if (modelUrl !== undefined) options.modelUrl = modelUrl;

  const outDir = text(env, ENV.outDir) ?? DEFAULT_OUT_DIR;
  options.outDir = isAbsolute(outDir) ? outDir : resolve(cwd, outDir);
  const runtimeDir = text(env, ENV.runtimeDir);
  if (runtimeDir !== undefined) options.runtimeDir = isAbsolute(runtimeDir) ? runtimeDir : resolve(cwd, runtimeDir);

  return { off: isOff(env), options, notes };
}
