// The two build settings an app on Vite 7 or earlier needs with GenClass (src/vite.mjs): written only where it is
// safe, shown first, and taken out again.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../../runtime/bin/lib/detect.mjs";
import { addViteSettings } from "../src/actions.mjs";
import { planLeftovers, remove } from "../src/remove.mjs";
import { planViteRemoval, planViteSettings, VITE_FILE, VITE_MARK } from "../src/vite.mjs";
import { isolate, printed, tempDir, viteApp, write } from "./helpers.js";

isolate();

const app = (vite: string, files: Record<string, string> = {}) => {
  const dir = tempDir();
  viteApp(dir, { devDependencies: { vite, "@vitejs/plugin-react": "^5.0.0" } });
  write(dir, files);
  return dir;
};
const plan = (dir: string) => planViteSettings(dir, detectProject(dir));
const MULTI = 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n  server: { port: 3000 },\n});\n';
const noGit = () => null;

describe("genclass: Vite 7 and earlier need two settings (src/vite.mjs)", () => {
  it("Vite 8 needs nothing; neither does another kind of project, or a config that already has the build setting", () => {
    expect(plan(app("^8.3.4", { "vite.config.js": MULTI }))).toBeNull();
    expect(plan(app("^7.0.0", { "vite.config.js": MULTI.replace("plugins: [react()],", 'plugins: [react()],\n  worker: { format: "es" },') }))).toBeNull();
    expect(planViteSettings(tempDir(), { framework: "next", deps: { vite: "^7" } })).toBeNull();
    expect(planViteSettings(tempDir(), { framework: "vite", deps: {} })).toBeNull();
  });

  it("an app with no Vite config gets one, and remove deletes it", () => {
    const dir = app("^7.0.0");
    const p = plan(dir)!;
    expect(p.major).toBe(7);
    expect(p.change).toMatchObject({ file: "vite.config.js", kind: "create", before: "", after: VITE_FILE });
    expect(VITE_FILE).toContain('worker: { format: "es" }');
    expect(VITE_FILE).toContain('optimizeDeps: { exclude: ["@genclass/runtime"] }');
    writeFileSync(p.change!.path, p.change!.after);
    expect(plan(dir)).toBeNull();
    expect(planViteRemoval(dir)).toMatchObject({ file: "vite.config.js", kind: "delete" });
  });

  it("a config in the usual shape gets the two lines as its first keys, in its own indentation, and remove restores it byte for byte", () => {
    for (const [name, text] of [
      ["vite.config.js", MULTI],
      ["vite.config.ts", MULTI.replace(/\n/g, "\r\n")],
      ["vite.config.mjs", 'export default {\n\tplugins: [],\n};\n'],
    ] as const) {
      const dir = app("^6.2.0", { [name]: text });
      const p = plan(dir)!;
      expect(p.change, name).toMatchObject({ file: name, kind: "modify", before: text });
      const after = p.change!.after;
      const lines = after.split(/\r?\n/);
      const i = lines.findIndex((l) => l.includes(VITE_MARK));
      expect(lines[i], name).toMatch(/^\s+worker: \{ format: "es" \}, \/\/ genclass:vite$/);
      expect(lines[i + 1], name).toMatch(/^\s+optimizeDeps: \{ exclude: \["@genclass\/runtime"\] \}, \/\/ genclass:vite$/);
      // same indentation as the key that was first
      expect(/^\s+/.exec(lines[i])![0], name).toBe(/^\s+/.exec(lines[i + 2])![0]);
      expect(after.includes("\r\n"), name).toBe(text.includes("\r\n"));
      writeFileSync(p.change!.path, after);
      expect(plan(dir), name).toBeNull();
      const back = planViteRemoval(dir)!;
      expect(back, name).toMatchObject({ file: name, kind: "modify", after: text });
    }
    // a config on one line still ends up valid, and the lines come out again
    const one = 'import { defineConfig } from "vite";\nexport default defineConfig({ plugins: [] });\n';
    const dir = app("^7.0.0", { "vite.config.js": one });
    const after = plan(dir)!.change!.after;
    expect(after).toBe('import { defineConfig } from "vite";\nexport default defineConfig({\n  worker: { format: "es" }, // genclass:vite\n  optimizeDeps: { exclude: ["@genclass/runtime"] }, // genclass:vite\n  plugins: [] });\n');
    writeFileSync(join(dir, "vite.config.js"), after);
    expect(planViteRemoval(dir)!.after).toBe('import { defineConfig } from "vite";\nexport default defineConfig({\n  plugins: [] });\n');
  });

  it("a config it cannot edit without guessing is left alone, with the lines to add and why", () => {
    const fn = app("^7.0.0", { "vite.config.js": 'import { defineConfig } from "vite";\nexport default defineConfig(({ mode }) => ({ plugins: [] }));\n' });
    expect(plan(fn)).toMatchObject({ major: 7 });
    expect(plan(fn)!.change).toBeUndefined();
    expect(plan(fn)!.note).toContain("not a shape this command edits");
    expect(plan(fn)!.note).toContain('worker: { format: "es" }');
    const own = app("^7.0.0", { "vite.config.js": MULTI.replace("server: { port: 3000 },", 'worker: { plugins: () => [] },') });
    expect(plan(own)!.note).toContain("already sets worker or optimizeDeps");
    const workers = app("^7.0.0", { "vite.config.js": MULTI, "src/thumbs.js": 'export const w = new Worker(new URL("./resize.js", import.meta.url));\n' });
    expect(plan(workers)!.note).toContain("workers of its own");
  });

  it("the step shows the change and writes it on a yes; remove takes it out with the rest", async () => {
    const dir = app("^7.0.0", { "vite.config.js": MULTI });
    const state = { cwd: dir, steps: [] };
    // not a terminal and no --yes: shown, not written
    const shown = await printed(async () => expect(await addViteSettings(state, {})).toBe("skipped"));
    expect(shown).toContain('Without them "vite build" fails.');
    expect(shown).toContain("vite.config.js");
    expect(readFileSync(join(dir, "vite.config.js"), "utf8")).toBe(MULTI);
    const said = await printed(async () => expect(await addViteSettings(state, { yes: true })).toBe("done"));
    expect(said).toContain("Updated vite.config.js");
    expect(readFileSync(join(dir, "vite.config.js"), "utf8")).toContain(VITE_MARK);
    // nothing more to do the second time
    expect(await printed(async () => expect(await addViteSettings(state, { yes: true })).toBe("done"))).toBe("");
    expect(planLeftovers(dir, { runGit: noGit }).changes.map((ch) => `${ch.kind} ${ch.file}`)).toEqual(["modify vite.config.js"]);
    await printed(async () => expect(await remove(["--cwd", dir, "--yes"], { runtime: async () => 0, runGit: noGit })).toBe(0));
    expect(readFileSync(join(dir, "vite.config.js"), "utf8")).toBe(MULTI);
    // a config the command created is deleted
    const bare = app("^7.0.0");
    await printed(async () => expect(await addViteSettings({ cwd: bare, steps: [] }, { yes: true })).toBe("done"));
    expect(readFileSync(join(bare, "vite.config.js"), "utf8")).toBe(VITE_FILE);
    await printed(async () => expect(await remove(["--cwd", bare, "--yes"], { runtime: async () => 0, runGit: noGit })).toBe(0));
    expect(existsSync(join(bare, "vite.config.js"))).toBe(false);
  });
});
