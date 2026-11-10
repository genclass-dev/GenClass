// The register entry's options from environment variables (src/env.ts): an unmodified config has no `use.genclass`,
// so chaos, its seed, the output directory, the model, the runtime's directory and the off switch come from here. A
// value that cannot be read becomes the default and one line, never a throw.

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_OUT_DIR, ENV, flagOf, isOff, optionsFromEnv } from "../src/env.js";

const cwd = resolve("/work/project");

describe("env: the off switch", () => {
  it("GENCLASS_PLAYWRIGHT=off (0, false, no, any case) is off; anything else, or nothing, is on", () => {
    for (const v of ["off", "OFF", "0", "false", "no", " off "]) expect(isOff({ GENCLASS_PLAYWRIGHT: v }), v).toBe(true);
    for (const v of ["on", "1", "true", "yes", "", "maybe"]) expect(isOff({ GENCLASS_PLAYWRIGHT: v }), v).toBe(false);
    expect(isOff({})).toBe(false);
    expect(optionsFromEnv({ GENCLASS_PLAYWRIGHT: "off" }, cwd).off).toBe(true);
    expect(optionsFromEnv({}, cwd).off).toBe(false);
  });

  it("flagOf: true, false, undefined for unset, null for something else", () => {
    expect([flagOf("on"), flagOf("1"), flagOf("TRUE"), flagOf("yes")]).toEqual([true, true, true, true]);
    expect([flagOf("off"), flagOf("0"), flagOf("False"), flagOf("no")]).toEqual([false, false, false, false]);
    expect([flagOf(undefined), flagOf(""), flagOf("  ")]).toEqual([undefined, undefined, undefined]);
    expect(flagOf("latency")).toBeNull();
  });
});

describe("env: the options", () => {
  it("nothing set: no chaos, the model skipped, the files in test-results/genclass under the working directory", () => {
    expect(optionsFromEnv({}, cwd)).toEqual({ off: false, options: { outDir: join(cwd, DEFAULT_OUT_DIR) }, notes: [] });
    expect(DEFAULT_OUT_DIR).toBe(join("test-results", "genclass"));
  });

  it("the names", () => {
    expect(ENV).toEqual({
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
    });
  });

  it("chaos on with nothing else is the fixture's `chaos: true`; the command's default (chaos on when unset) is the third argument", () => {
    expect(optionsFromEnv({ GENCLASS_CHAOS: "on" }, cwd).options.chaos).toBe(true);
    expect(optionsFromEnv({ GENCLASS_CHAOS: "1" }, cwd).options.chaos).toBe(true);
    expect(optionsFromEnv({}, cwd, true).options.chaos).toBe(true);
    expect(optionsFromEnv({ GENCLASS_CHAOS: "off" }, cwd, true).options.chaos).toBeUndefined();
    expect(optionsFromEnv({ GENCLASS_CHAOS: "" }, cwd).options.chaos).toBeUndefined();
  });

  it("chaos with its seed, latency, order and filter", () => {
    const r = optionsFromEnv({ GENCLASS_CHAOS: "on", GENCLASS_SEED: "7", GENCLASS_CHAOS_DELAY_MS: "50, 300", GENCLASS_CHAOS_REORDER: "off", GENCLASS_CHAOS_MATCH: "/api, /graphql ,https://api.example.com/," }, cwd);
    expect(r).toEqual({ off: false, options: { chaos: { seed: 7, delayMs: [50, 300], reorder: false, match: ["/api", "/graphql", "https://api.example.com/"] }, outDir: join(cwd, DEFAULT_OUT_DIR) }, notes: [] });
    expect(optionsFromEnv({ GENCLASS_CHAOS: "on", GENCLASS_SEED: "0", GENCLASS_CHAOS_REORDER: "on" }, cwd).options.chaos).toEqual({ seed: 0 });
  });

  it("the seed and the rest of chaos are read only when chaos is on", () => {
    expect(optionsFromEnv({ GENCLASS_SEED: "7", GENCLASS_CHAOS_REORDER: "off", GENCLASS_CHAOS_DELAY_MS: "nonsense" }, cwd)).toEqual({ off: false, options: { outDir: join(cwd, DEFAULT_OUT_DIR) }, notes: [] });
  });

  it("the model, its URL, the output directory and the runtime's directory (relative ones against the working directory)", () => {
    const r = optionsFromEnv({ GENCLASS_MODEL: "load", GENCLASS_MODEL_URL: "https://models.example.com/r17/", GENCLASS_OUT_DIR: "out/races", GENCLASS_RUNTIME_DIR: "../rt/dist" }, cwd);
    expect(r.options).toEqual({ model: "load", modelUrl: "https://models.example.com/r17/", outDir: join(cwd, "out", "races"), runtimeDir: resolve(cwd, "..", "rt", "dist") });
    const abs = optionsFromEnv({ GENCLASS_MODEL: "skip", GENCLASS_OUT_DIR: resolve("/elsewhere/races"), GENCLASS_RUNTIME_DIR: resolve("/opt/runtime/dist") }, cwd);
    expect(abs.options).toEqual({ outDir: resolve("/elsewhere/races"), runtimeDir: resolve("/opt/runtime/dist") });
    expect(abs.notes).toEqual([]);
  });

  it("a value that cannot be read: the default, and one line saying so; never a throw", () => {
    const r = optionsFromEnv({ GENCLASS_CHAOS: "maybe", GENCLASS_MODEL: "cdn" }, cwd, true);
    expect(r.options).toEqual({ chaos: true, outDir: join(cwd, DEFAULT_OUT_DIR) });
    expect(r.notes).toEqual(['GENCLASS_CHAOS="maybe" is not on or off; using on', 'GENCLASS_MODEL="cdn" is not "skip" or "load"; using skip']);
    const c = optionsFromEnv({ GENCLASS_CHAOS: "on", GENCLASS_SEED: "-3", GENCLASS_CHAOS_DELAY_MS: "600,0", GENCLASS_CHAOS_REORDER: "sometimes" }, cwd);
    expect(c.options.chaos).toBe(true);
    expect(c.notes).toEqual([
      'GENCLASS_SEED="-3" is not a whole number from 0; using 1',
      'GENCLASS_CHAOS_DELAY_MS="600,0" is not "min,max" in ms with min not above max; using 0,600',
      'GENCLASS_CHAOS_REORDER="sometimes" is not on or off; using on',
    ]);
    expect(optionsFromEnv({ GENCLASS_CHAOS: "on", GENCLASS_SEED: "1.5" }, cwd).notes).toHaveLength(1);
    expect(optionsFromEnv({ GENCLASS_CHAOS: "on", GENCLASS_SEED: "99999999999999999999" }, cwd).notes).toHaveLength(1);
    expect(optionsFromEnv({ GENCLASS_CHAOS: "maybe" }, cwd).options.chaos).toBeUndefined();
  });
});
