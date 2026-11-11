// Package invariants: no runtime dependencies (the fixture's needs, @playwright/test and @genclass/runtime, are
// optional peer dependencies), nothing but the fixture imports Playwright (the register entry least of all: it finds
// the Playwright that runs it, and a second copy would stop the run), the pure entries use no Node APIs, the page
// script imports nothing at all, the exports map names what tsup builds, the README shows the fixture's exact
// report.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";
import * as summarizeEntry from "../src/summarize.js";
import { FIXTURE_REPORT, here } from "./helpers.js";

const pkgDir = join(here, "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
const src = (f: string) => readFileSync(join(pkgDir, "src", f), "utf8");
const imports = (text: string) => [...text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);

describe("package: dependencies and imports", () => {
  it("has no runtime dependencies; Playwright and the runtime are optional peer dependencies (the fixture's)", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
    expect(pkg.peerDependencies).toEqual({ "@genclass/runtime": ">=0.3.0-beta.1", "@playwright/test": ">=1.40.0" });
    expect(pkg.peerDependenciesMeta).toEqual({ "@genclass/runtime": { optional: true }, "@playwright/test": { optional: true } });
    expect(pkg.license).toBe("Apache-2.0");
  });

  it("imports only its own modules and Node built-ins (the pure entries not even those); only the fixture imports Playwright", () => {
    for (const f of ["index.ts", "summarize.ts", "schema.ts", "types.ts", "chaos.ts", "page.ts", "steps.ts", "order.ts", "explain.ts"]) for (const i of imports(src(f))) expect(i, `${f}: ${i}`).toMatch(/^\.\/[a-z]+\.js$/);
    expect(imports(src("page.ts"))).toEqual([]);
    const node = ["reporter.ts", "files.ts", "cli.ts", "install.ts", "races.ts", "session.ts", "env.ts", "wrap.ts", "worker.ts", "register.ts", "wrapper.ts", "run.ts"];
    for (const f of node) for (const i of imports(src(f))) expect(i, `${f}: ${i}`).toMatch(/^(\.\/[a-z]+\.js|node:[a-z_]+)$/);
    for (const i of imports(src("fixture.ts"))) expect(i, `fixture.ts: ${i}`).toMatch(/^(\.\/[a-z]+\.js|node:[a-z]+|@playwright\/test)$/);
    // every module of src/ is in one of the lists above
    expect(readdirSync(join(pkgDir, "src")).sort()).toEqual([...node, "index.ts", "summarize.ts", "schema.ts", "types.ts", "chaos.ts", "page.ts", "steps.ts", "order.ts", "explain.ts", "fixture.ts"].sort());
    // the two modules a reader bundles from source to summarise race files (genclass-dev[bot] does) import nothing of
    // the comparison of failing and passing runs: the summariser nothing but the validator and the types, the
    // validator nothing but the types
    expect([...new Set(imports(src("summarize.ts")))].sort()).toEqual(["./schema.js", "./types.js"]);
    expect([...new Set(imports(src("schema.ts")))]).toEqual(["./types.js"]);
    // the runtime is never imported: the fixture reads its dist/ from disk and the page loads it from there
    for (const f of ["fixture.ts", "install.ts", "page.ts", "races.ts", "chaos.ts", "session.ts", "wrap.ts", "worker.ts", "register.ts", "run.ts"]) expect(src(f)).not.toMatch(/from "@genclass\/runtime/);
  });

  it("the register entry and the command never import Playwright, in the source or in the build's text: they find the project's own at run time", () => {
    for (const f of ["register.ts", "worker.ts", "wrap.ts", "session.ts", "env.ts", "install.ts", "run.ts", "wrapper.ts"]) expect(src(f), f).not.toMatch(/(?:from|import)\s*\(?\s*"(?:@playwright\/test|playwright(?:-core)?)(?:\/[^"]*)?"/);
    // sideEffects names the one entry that is one (importing it starts it)
    expect(pkg.sideEffects).toEqual(["./dist/register.js"]);
    expect(src("register.ts")).toMatch(/^startRegister\(\);$/m);
  });

  it("the exports map and the bin name what tsup builds; every entry also has a default condition", () => {
    // "default" because Playwright resolves a reporter id with CommonJS require.resolve, which never matches "import"
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
      "./summarize": { types: "./dist/summarize.d.ts", import: "./dist/summarize.js", default: "./dist/summarize.js" },
      "./reporter": { types: "./dist/reporter.d.ts", import: "./dist/reporter.js", default: "./dist/reporter.js" },
      "./fixture": { types: "./dist/fixture.d.ts", import: "./dist/fixture.js", default: "./dist/fixture.js" },
      "./register": { types: "./dist/register.d.ts", import: "./dist/register.js", default: "./dist/register.js" },
      "./package.json": "./package.json",
    });
    expect(pkg.typesVersions).toEqual({ "*": { fixture: ["./dist/fixture.d.ts"], register: ["./dist/register.d.ts"], reporter: ["./dist/reporter.d.ts"], summarize: ["./dist/summarize.d.ts"] } });
    expect(pkg.bin).toEqual({ "genclass-playwright-report": "bin/genclass-playwright-report.mjs", "genclass-playwright-run": "bin/genclass-playwright-run.mjs" });
    for (const [name, file] of Object.entries(pkg.bin as Record<string, string>)) {
      const text = readFileSync(join(pkgDir, file), "utf8");
      expect(text.startsWith("#!/usr/bin/env node\n"), name).toBe(true);
      expect(text, name).toMatch(/from "\.\.\/dist\/(cli|run)\.js"/);
    }
    const tsup = readFileSync(join(pkgDir, "tsup.config.ts"), "utf8");
    // dist/explain.js is built for the end-to-end check and the bench, and is no public entry: the exports map above has none for it
    expect(tsup).toContain('entry: { index: "src/index.ts", summarize: "src/summarize.ts", reporter: "src/reporter.ts", fixture: "src/fixture.ts", register: "src/register.ts", cli: "src/cli.ts", run: "src/run.ts", explain: "src/explain.ts" }');
    expect(tsup).toContain('external: ["@playwright/test", "@genclass/runtime"]');
  });

  it("the root entry and /summarize export the same pure API", () => {
    expect(Object.keys(root).sort()).toEqual(Object.keys(summarizeEntry).sort());
    for (const k of ["summarize", "buildSummary", "renderMarkdown", "parseRaces", "validateRaces", "RACES_SCHEMA", "REPORT_MARKER"]) expect(Object.keys(root)).toContain(k);
  });

  it("the root package-lock.json has the workspace entry, matching package.json", () => {
    const lock = JSON.parse(readFileSync(join(pkgDir, "..", "..", "package-lock.json"), "utf8")) as { packages: Record<string, Record<string, unknown>> };
    expect(lock.packages["node_modules/@genclass/playwright"]).toEqual({ resolved: "packages/playwright", link: true });
    const entry = lock.packages["packages/playwright"];
    expect(entry.name).toBe(pkg.name);
    expect(entry.version).toBe(pkg.version);
    expect(entry.dependencies).toBeUndefined();
    expect(entry.devDependencies).toEqual(pkg.devDependencies);
    expect(entry.peerDependencies).toEqual(pkg.peerDependencies);
    expect(entry.peerDependenciesMeta).toEqual(pkg.peerDependenciesMeta);
    // The lock mirrors the package's commands. `genclass-playwright-run` came with the register entry, in a change
    // that could not touch the root lockfile: the next `npm install` at the root adds its line there (npm ci does not
    // compare commands, so nothing waits on it). Until then it is the one name the lock may be missing; everything
    // else must match, in both directions.
    expect({ ...(entry.bin as Record<string, string>), "genclass-playwright-run": "bin/genclass-playwright-run.mjs" }).toEqual(pkg.bin);
  });
});

// Playwright loads a reporter named by module id with require.resolve(id, { paths: [configDir] }) (CommonJS
// conditions: require, node, default) and then import()s the file it found. This needs the build: CI builds before
// the tests (and fails here if it did not); a local run without dist/ skips it. playwright-reporter.yml also runs
// a real Playwright run that loads the reporter this way (test/playwright-smoke).
const built = existsSync(join(pkgDir, "dist", "reporter.js"));

describe("package: how Playwright finds the reporter and the fixture", () => {
  it.runIf(built || Boolean(process.env.CI))("require.resolve from the repository root finds dist/reporter.js, whose default export is the reporter", async () => {
    const require = createRequire(import.meta.url);
    const repoRoot = join(pkgDir, "..", "..");
    const resolved = require.resolve("@genclass/playwright/reporter", { paths: [repoRoot] });
    expect(realpathSync(resolved)).toBe(realpathSync(join(pkgDir, "dist", "reporter.js")));
    const mod = (await import(pathToFileURL(resolved).href)) as { default: unknown };
    expect(typeof mod.default).toBe("function");
    const reporter = new (mod.default as new (o: object) => { printsToStdio(): boolean; onEnd(): void })({ quiet: true, outputFile: false });
    expect(reporter.printsToStdio()).toBe(false);
    expect(typeof reporter.onEnd).toBe("function");
    for (const id of ["@genclass/playwright", "@genclass/playwright/summarize", "@genclass/playwright/fixture", "@genclass/playwright/register"]) expect(realpathSync(require.resolve(id, { paths: [repoRoot] }))).toMatch(/[\\/]dist[\\/](index|summarize|fixture|register)\.js$/);
  });

  it.runIf(built || Boolean(process.env.CI))("dist/register.js and dist/run.js import nothing but Node built-ins, and the entry carries the page script as source text", () => {
    for (const f of ["register.js", "run.js"]) {
      const text = readFileSync(join(pkgDir, "dist", f), "utf8");
      const from = [...text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      expect(from.length, f).toBeGreaterThan(0);
      for (const i of from) expect(builtinModules, `${f}: ${i}`).toContain(i.replace(/^node:/, ""));
      expect(text, f).not.toMatch(/\bimport\s*\(\s*["'`](?:@playwright|playwright)/);
    }
    const register = readFileSync(join(pkgDir, "dist", "register.js"), "utf8");
    expect(register).toContain("function genclassPageScript(cfg, runGlobal)");
    // each wrapped method calls the original through super, under its own name (see src/wrap.ts)
    for (const m of ["launch", "launchPersistentContext", "connect", "connectOverCDP", "newContext", "close"]) expect(register, m).toContain(`super.${m}(...args)`);
    expect(readFileSync(join(pkgDir, "dist", "run.js"), "utf8")).toContain('new URL("./register.js", import.meta.url)');
  });

  it.runIf(built || Boolean(process.env.CI))("dist/fixture.js exports test and expect, and carries the page script as source text", async () => {
    const mod = (await import(pathToFileURL(join(pkgDir, "dist", "fixture.js")).href)) as Record<string, unknown>;
    expect(typeof mod.test).toBe("function");
    expect(typeof mod.expect).toBe("function");
    expect(typeof mod.startGenClass).toBe("function");
    const text = readFileSync(join(pkgDir, "dist", "fixture.js"), "utf8");
    // the page script is serialised with toString() at run time: the bundle must keep it a plain function
    expect(text).toContain("function genclassPageScript(cfg, runGlobal)");
    expect(text).toContain("__GENCLASS_PLAYWRIGHT__");
  });
});

describe("README", () => {
  it("shows the exact report of the unit-test fixture", () => {
    const readme = readFileSync(join(pkgDir, "README.md"), "utf8");
    expect(readme).toContain("```markdown\n" + FIXTURE_REPORT + "```\n");
  });
});
