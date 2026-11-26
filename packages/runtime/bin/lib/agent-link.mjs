// The dev-only agent link `genclass-runtime init --agent-link` adds (owner, 2026-11-25: "the mcp setup leaves the app
// unwired"): the lines that connect a development build's pages to the local GenClass MCP bridge (src/agent,
// docs/runtime/AGENT.md), the same as the dashboard's snippet (telemetry-worker/src/pages.ts AGENT_LINK_HEAD):
//
//   import { GenClass } from "@genclass/runtime"; // genclass:init
//   import { connectAgent } from "@genclass/runtime/agent"; // genclass:init
//   if (import.meta.env.DEV && GenClass.runtime) connectAgent(GenClass.runtime); // genclass:init
//
// right after the import of @genclass/runtime/auto (init's, or one written by hand). An app that starts GenClass with
// its own top-level `const rt = GenClass.init(...)` gets the agent import and `if (...) connectAgent(rt);` right
// after that statement. Next.js and webpack builds test process.env.NODE_ENV === "development" instead.
//
// Invariants:
// - Pure: reads files, returns the changes ({ file, rel, kind, before, after }); init shows them, asks and writes.
// - Every line carries init's marker, or sits inside a block init created (whose own markers cover it), and is one of
//   the statements edit.mjs's removal recognises, so `remove` takes it out and leaves the app as it was.
// - Only development builds run it: the condition is the bundler's own (a production build drops the branch, and
//   with it the agent entry), and connectAgent itself runs only on pages served from this machine.
// - A project where the build's way to tell development is not known (Angular, Nuxt, Astro, plain HTML, an unknown
//   bundler) gets no edit: `manual` says why, and the lines are printed for the person to place.
// - An app that already imports @genclass/runtime/agent anywhere is linked: nothing is planned.

import { relative, sep } from "node:path";
import { readText } from "./detect.mjs";
import { MARK, codeStyle, indentOf, insertLineAt, linesOf } from "./edit.mjs";

const posix = (p) => p.split(sep).join("/");

/** The import of the zero-code entry, as init writes it or a person does (`import "@genclass/runtime/auto";`). */
const AUTO_LINE = /^\s*import\s+(?:genclass\s+from\s+)?["']@genclass\/runtime\/auto(?:\/(?:observe|guard|heal))?["']\s*;?\s*(?:\/\/.*)?$/;
/** A top-level GenClass.init() written by hand, and the name it is kept under (`const rt = GenClass.init(...)`). */
const INIT_CALL = /^(?:(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*)?GenClass\.init\s*\(/;
const HAS_AGENT = /["']@genclass\/runtime\/agent["']/;
const IMPORTS_GENCLASS = /\bimport\s*\{[^}]*\bGenClass\b[^}]*\}\s*from\s*["']@genclass\/runtime["']/;
const JS = /\.[cm]?[jt]sx?$/;

const VITE = "import.meta.env.DEV";
const NODE = 'process.env.NODE_ENV === "development"';

/**
 * How this project's build tells a development build apart, as code for an `if`, or null when it is not known here.
 * webpack, rspack/rsbuild and parcel replace process.env.NODE_ENV; another bundler may not define `process` at all.
 */
export function devCondition(project) {
  switch (project?.framework) {
    case "vite":
    case "sveltekit":
      return VITE;
    case "react-router":
    case "remix":
      return project.details?.vite ? VITE : NODE;
    case "next":
    case "cra":
      return NODE;
    case "webpack":
      return ["webpack", "@rspack/core", "@rsbuild/core", "parcel"].includes(project.details?.bundler) ? NODE : null;
    default:
      return null;
  }
}

/** The line where the statement that starts on line `i` with GenClass.init( ends (its parentheses close), or -1. */
function statementEnd(lines, i) {
  let depth = 0;
  for (let j = i; j < Math.min(lines.length, i + 40); j++) {
    const code = (j === i ? lines[j].slice(lines[j].indexOf("GenClass.init")) : lines[j]).replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "").replace(/\/\/.*$/, "");
    for (const ch of code) {
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return j;
    }
  }
  return -1;
}

/** Whether line `at` is inside a block init created (between a `genclass:init start` and its end). */
function inBlock(lines, at) {
  for (let j = at - 1; j >= 0; j--) {
    if (lines[j].includes(`${MARK} end`)) return false;
    if (lines[j].includes(`${MARK} start`)) return true;
  }
  return false;
}

/**
 * `text` with the agent link added (after the /auto import, else after a top-level GenClass.init() statement), or
 * null when the file has neither, or already imports the agent entry. `cond`: devCondition().
 */
export function linkText(text, cond) {
  if (!cond || HAS_AGENT.test(text)) return null;
  const { q, semi } = codeStyle(text);
  const imp = (name, spec) => `import { ${name} } from ${q}${spec}${q}${semi}`;
  const lines = linesOf(text);
  let at = lines.findIndex((l) => AUTO_LINE.test(l));
  let add;
  if (at >= 0) {
    add = [...(IMPORTS_GENCLASS.test(text) ? [] : [imp("GenClass", "@genclass/runtime")]), imp("connectAgent", "@genclass/runtime/agent"), `if (${cond} && GenClass.runtime) connectAgent(GenClass.runtime)${semi}`];
  } else {
    const i = lines.findIndex((l) => INIT_CALL.test(l));
    if (i < 0) return null;
    at = statementEnd(lines, i);
    if (at < 0) return null;
    const name = INIT_CALL.exec(lines[i])[1];
    add = [imp("connectAgent", "@genclass/runtime/agent"), name ? `if (${cond}) connectAgent(${name})${semi}` : `if (${cond} && GenClass.runtime) connectAgent(GenClass.runtime)${semi}`];
  }
  const block = inBlock(lines, at);
  const indent = indentOf(lines[at]);
  let out = text;
  add.forEach((l, k) => {
    out = insertLineAt(out, at + 1 + k, `${indent}${block ? l : `${l} // ${MARK}`}`);
  });
  return out;
}

/**
 * What --agent-link changes in a project that has GenClass (`files`: its source files, walkSources): { done, where }
 * when a file already imports the agent entry; else { changes: [one modify], entry } or { changes: [], manual: why }.
 */
export function planAgentLink(project, cwd, files) {
  const rel = (f) => posix(relative(cwd, f));
  const linked = files.find((f) => HAS_AGENT.test(readText(f) ?? ""));
  if (linked) return { done: true, where: rel(linked), changes: [] };
  const cond = devCondition(project);
  if (!cond) return { changes: [], manual: `${project?.label || project?.framework || "this project"}: no known way to tell its development builds here` };
  const js = files.filter((f) => JS.test(f));
  for (const re of [AUTO_LINE, INIT_CALL])
    for (const f of js) {
      const before = readText(f) ?? "";
      if (!linesOf(before).some((l) => re.test(l))) continue;
      const after = linkText(before, cond);
      if (after && after !== before) return { entry: f, changes: [{ file: f, rel: rel(f), kind: "modify", before, after }] };
    }
  return { changes: [], manual: "no import of @genclass/runtime/auto and no top-level GenClass.init() call in the app's modules" };
}

/**
 * init's own planned changes (a new setup) with the agent link added to the one that holds the /auto import: the new
 * list, or null when none can take it.
 */
export function withAgentLink(project, changes) {
  const cond = devCondition(project);
  if (!cond) return null;
  const at = changes.findIndex((ch) => JS.test(ch.file) && typeof ch.after === "string" && linesOf(ch.after).some((l) => AUTO_LINE.test(l)));
  if (at < 0) return null;
  const after = linkText(changes[at].after, cond);
  if (!after) return null;
  return changes.map((ch, i) => (i === at ? { ...ch, after } : ch));
}

/** The lines to add by hand where init cannot (printed by init and the setups that call it). */
export function agentLinkLines(cond = VITE) {
  return [`import { GenClass } from "@genclass/runtime";`, `import { connectAgent } from "@genclass/runtime/agent";`, `if (${cond} && GenClass.runtime) connectAgent(GenClass.runtime);`];
}
