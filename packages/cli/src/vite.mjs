// Two build settings an app on Vite 7 or earlier needs once GenClass is in it, and the change that writes them.
//
// Why: before version 8, Vite bundles a worker as one classic script unless told otherwise. The model's worker loads
// one of two ONNX Runtime builds on demand, which one classic script cannot hold, so `vite build` stops with
// 'Invalid value "iife" for option "worker.format"', and the dev server's pre-bundle has no worker file, so the model
// runs on the page's main thread with a warning on every load. `worker: { format: "es" }` fixes the build and
// `optimizeDeps: { exclude: ["@genclass/runtime"] }` the dev server (measured on Vite 7.3.8, 2026-11-12: build
// fails without the first and passes with it; the worker starts in dev with the second). Vite 8 needs neither.
//
// Invariants:
// - Only a config this can edit without guessing is edited: one `defineConfig({` or `export default {`, with no
//   `worker` or `optimizeDeps` key of its own, in an app with no workers of its own (the first setting changes how
//   every worker is bundled). Anything else gets the two lines to add by hand, and why.
// - What is written carries its own marker (not the runtime CLI's, whose remove knows only its own lines), so
//   `genclass remove` takes out exactly these lines, or the file when this command created it.
// - Nothing is written without being shown first.

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { firstFile, versionOf, walkSources } from "../../runtime/bin/lib/detect.mjs";

export const VITE_MARK = "genclass:vite";
const WORKER = 'worker: { format: "es" }';
const DEPS = 'optimizeDeps: { exclude: ["@genclass/runtime"] }';
const CONFIGS = ["ts", "js", "mjs", "mts", "cjs", "cts"].map((e) => `vite.config.${e}`);
/** The whole file this command writes when the app has no Vite config. */
export const VITE_FILE = `// ${VITE_MARK}: two settings GenClass needs on Vite 7 and earlier (npx genclass remove takes this file out)\nexport default { ${WORKER}, ${DEPS} };\n`;
const LINE = new RegExp(`^[ \\t]*(?:${[WORKER, DEPS].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}),[ \\t]*// ${VITE_MARK}[ \\t]*\\r?\\n`, "gm");

const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * What the app at `cwd` needs: null (not a Vite app, Vite 8 or later, or the settings are there), `{ change }` (the
 * edit or the new file, `{ file, path, kind, before, after }`), or `{ note }` (the lines to add by hand, and why).
 * @param {string} cwd
 * @param {{ framework?: string | null, deps?: Record<string, string> }} project the runtime CLI's detected project
 */
export function planViteSettings(cwd, project) {
  if (project?.framework !== "vite") return null;
  const v = versionOf(cwd, "vite", project.deps?.vite);
  if (!v || v.major >= 8) return null;
  const byHand = (why) => ({ major: v.major, note: `Vite ${v.major} needs two settings for GenClass's model worker, or "vite build" fails. Add ${WORKER} and ${DEPS} to your Vite config (${why}).` });
  const path = firstFile(cwd, CONFIGS);
  if (!path) return { major: v.major, change: { file: "vite.config.js", path: join(cwd, "vite.config.js"), kind: "create", before: "", after: VITE_FILE } };
  const file = relative(cwd, path).split(sep).join("/");
  const before = read(path) ?? "";
  // the build setting is the one that matters: with it there, by this command or by hand, nothing is missing
  if (before.includes(VITE_MARK) || /\bworker\s*:\s*\{[^}]*\bformat\s*:\s*["']es["']/.test(before)) return null;
  if (/\bworker\s*:/.test(before) || /\boptimizeDeps\s*:/.test(before)) return byHand(`${file} already sets worker or optimizeDeps, so it was left alone`);
  const opens = [...before.matchAll(/(?:defineConfig\(\s*|export\s+default\s+)\{/g)];
  if (opens.length !== 1) return byHand(`${file} is not a shape this command edits`);
  const src = join(cwd, "src");
  const own = walkSources(firstFile(cwd, ["src/main.ts", "src/main.tsx", "src/main.js", "src/main.jsx", "src/index.ts", "src/index.tsx", "src/index.js", "src/index.jsx"]) ? src : cwd, 4000).some(
    (f) => f !== path && /new\s+(?:Shared)?Worker\s*\(|\?worker\b|\?sharedworker\b/.test(read(f) ?? ""),
  );
  if (own) return byHand("this app has workers of its own, and the first setting changes how they are bundled too");
  const at = opens[0].index + opens[0][0].length;
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const rest = before.slice(at);
  const lineEnd = /^[ \t]*\r?\n/.exec(rest);
  // the indentation of the config's first key when it is on a line of its own, else two spaces
  const indent = (lineEnd && /^([ \t]+)\S/.exec(rest.slice(lineEnd[0].length))?.[1]) || "  ";
  const lines = `${indent}${WORKER}, // ${VITE_MARK}${eol}${indent}${DEPS}, // ${VITE_MARK}${eol}`;
  const after = lineEnd ? `${before.slice(0, at)}${lineEnd[0]}${lines}${rest.slice(lineEnd[0].length)}` : `${before.slice(0, at)}${eol}${lines}${indent}${rest.replace(/^[ \t]+/, "")}`;
  return { major: v.major, change: { file, path, kind: "modify", before, after } };
}

/**
 * The reverse, for `genclass remove`: `{ file, path, kind: "delete" | "modify", after? }` for the Vite config this
 * command wrote or edited, or null when there is nothing of it.
 */
export function planViteRemoval(cwd) {
  const path = firstFile(cwd, CONFIGS);
  if (!path) return null;
  const text = read(path) ?? "";
  if (!text.includes(VITE_MARK)) return null;
  const file = relative(cwd, path).split(sep).join("/");
  if (text === VITE_FILE) return { file, path, kind: "delete" };
  const after = text.replace(LINE, "");
  return after === text ? null : { file, path, kind: "modify", after };
}
