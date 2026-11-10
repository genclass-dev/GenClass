// The config genclass-playwright-run generates (src/wrapper.ts), as exact text, and how the user's own config is found
// and classified: the way Playwright does both. test/run.test.ts runs the generated file under a real Playwright.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_EXTENSIONS, isModuleFile, isWrapperConfigName, resolveConfig, wrapperConfigName, wrapperConfigSource } from "../src/wrapper.js";

const REGISTER = "file:///opt/genclass/node_modules/@genclass/playwright/dist/register.js";
const HEAD = [
  "// Written by genclass-playwright-run for one run and removed when the run ends. Safe to delete.",
  "// It loads GenClass's register entry, then hands Playwright your own config, unchanged.",
  `import "${REGISTER}";`,
];

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-wrapper-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("wrapper: the generated config, exactly", () => {
  it("a config Playwright imports (an ES module): imported, and reduced to its default export once", () => {
    expect(wrapperConfigSource({ registerUrl: REGISTER, config: "/repo/playwright.config.ts", module: true })).toBe(
      [...HEAD, 'import * as config from "./playwright.config.ts";', "", 'export default "default" in config ? config.default : config;', ""].join("\n"),
    );
  });

  it("a config Playwright requires (CommonJS): required, the same way", () => {
    expect(wrapperConfigSource({ registerUrl: REGISTER, config: "/repo/e2e/playwright.config.ts", module: false })).toBe(
      [
        ...HEAD,
        'import { createRequire } from "node:module";',
        "",
        'const config = createRequire(import.meta.url)("./playwright.config.ts");',
        'export default config && typeof config === "object" && "default" in config ? config.default : config;',
        "",
      ].join("\n"),
    );
  });

  it("no config at all: Playwright's defaults", () => {
    expect(wrapperConfigSource({ registerUrl: REGISTER, config: null, module: true })).toBe([...HEAD, "", "export default {};", ""].join("\n"));
    expect(wrapperConfigSource({ registerUrl: REGISTER, config: null, module: false })).toBe([...HEAD, "", "export default {};", ""].join("\n"));
  });

  it("a config with an unusual name is named safely: as a URL when imported, as a path when required", () => {
    expect(wrapperConfigSource({ registerUrl: REGISTER, config: '/repo/my config #2 "x".mjs', module: true })).toContain('import * as config from "./my%20config%20%232%20%22x%22.mjs";');
    expect(wrapperConfigSource({ registerUrl: REGISTER, config: '/repo/my config #2 "x".cjs', module: false })).toContain('createRequire(import.meta.url)("./my config #2 \\"x\\".cjs");');
  });

  it("its name: the user's config's name, a marker, the run's number, .mjs", () => {
    expect(wrapperConfigName("/repo/playwright.config.ts", 4242)).toBe("playwright.config.ts.genclass-4242.mjs");
    expect(wrapperConfigName(join("e2e", "pw.staging.cjs"), "7")).toBe("pw.staging.cjs.genclass-7.mjs");
    expect(wrapperConfigName(null, 1)).toBe("playwright.config.genclass-1.mjs");
    expect(isWrapperConfigName("playwright.config.ts.genclass-4242.mjs")).toBe(true);
    expect(isWrapperConfigName("playwright.config.genclass-1.mjs")).toBe(true);
    expect(isWrapperConfigName("playwright.config.mjs")).toBe(false);
    // not a name Playwright's default testMatch would take for a test file
    expect(wrapperConfigName("/repo/playwright.config.ts", 4242)).not.toMatch(/\.(spec|test)\.[cm]?[jt]sx?$/);
  });
});

describe("wrapper: where the user's config is, the way Playwright looks", () => {
  it("in the working directory: the first playwright.config in Playwright's order of extensions", () => {
    expect(CONFIG_EXTENSIONS).toEqual([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);
    expect(resolveConfig(root)).toEqual({ file: null, dir: root });
    for (const ext of [...CONFIG_EXTENSIONS].reverse()) {
      writeFileSync(join(root, `playwright.config${ext}`), "");
      expect(resolveConfig(root), ext).toEqual({ file: join(root, `playwright.config${ext}`), dir: root });
    }
  });

  it("--config with a file, a directory, a relative path, or something that is not there", () => {
    mkdirSync(join(root, "e2e"));
    writeFileSync(join(root, "e2e", "playwright.config.mjs"), "");
    writeFileSync(join(root, "e2e", "staging.config.ts"), "");
    expect(resolveConfig(root, "e2e")).toEqual({ file: join(root, "e2e", "playwright.config.mjs"), dir: join(root, "e2e") });
    expect(resolveConfig(root, join("e2e", "staging.config.ts"))).toEqual({ file: join(root, "e2e", "staging.config.ts"), dir: join(root, "e2e") });
    expect(resolveConfig(join(root, "e2e"), join("..", "e2e", "staging.config.ts"))).toEqual({ file: join(root, "e2e", "staging.config.ts"), dir: join(root, "e2e") });
    expect(resolveConfig(root, join(root, "e2e", "staging.config.ts"))).toEqual({ file: join(root, "e2e", "staging.config.ts"), dir: join(root, "e2e") });
    mkdirSync(join(root, "empty"));
    expect(resolveConfig(root, "empty")).toEqual({ file: null, dir: join(root, "empty") });
    // Playwright says "does not exist" itself
    expect(resolveConfig(root, "nowhere/playwright.config.ts")).toBeNull();
  });

  it("module or CommonJS: by extension, else by the nearest package.json's type", () => {
    expect(isModuleFile(join(root, "playwright.config.mjs"))).toBe(true);
    expect(isModuleFile(join(root, "playwright.config.mts"))).toBe(true);
    expect(isModuleFile(join(root, "playwright.config.cjs"))).toBe(false);
    expect(isModuleFile(join(root, "playwright.config.cts"))).toBe(false);
    mkdirSync(join(root, "esm", "deep", "er"), { recursive: true });
    mkdirSync(join(root, "cjs", "nested"), { recursive: true });
    mkdirSync(join(root, "broken"));
    writeFileSync(join(root, "esm", "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "cjs", "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(root, "cjs", "nested", "package.json"), JSON.stringify({ type: "commonjs" }));
    writeFileSync(join(root, "broken", "package.json"), "{ not json");
    expect(isModuleFile(join(root, "esm", "playwright.config.ts"))).toBe(true);
    expect(isModuleFile(join(root, "esm", "deep", "er", "playwright.config.js"))).toBe(true);
    // the extension wins over the package
    expect(isModuleFile(join(root, "esm", "playwright.config.cts"))).toBe(false);
    expect(isModuleFile(join(root, "cjs", "playwright.config.ts"))).toBe(false);
    expect(isModuleFile(join(root, "cjs", "nested", "playwright.config.js"))).toBe(false);
    expect(isModuleFile(join(root, "cjs", "playwright.config.mts"))).toBe(true);
    expect(isModuleFile(join(root, "broken", "playwright.config.ts"))).toBe(false);
  });
});
