// The dev-only coding-agent link for a project GenClass's init set up: `connectAgent` from @genclass/runtime/agent
// (docs/runtime/AGENT.md section 1), which lets the coding agent's MCP server see the page the developer runs on
// localhost (each click, request and response, the order they arrived) and run it again in another order. Used by
// the setup walk's Coding agent step (actions.mjs connectAgent), its state (state.mjs, step "agent") and
// `genclass doctor --fix` (doctor.mjs).
//
// Invariants:
// - Pure: reads files and returns the changes ({ file, rel, kind: "modify", before, after, what }); nothing is written
//   here. The caller shows them and asks first.
// - Only next to init's own lines: right after the /auto import init marked, or after the block of a file init
//   created, never in code the person wrote (a setup by hand gets the lines to add instead). Imports stay in the
//   import section (ESLint's import/first, an error in Create React App's build): when the app's own code follows
//   that place, only the two imports go there and the call goes at the end of the file, as init's devtools line does.
// - Every form written here is one `genclass remove` takes out (packages/runtime/bin/lib/edit.mjs LINE_RE and
//   BLOCK_RE): blocks between genclass:init markers, or in Astro one marked <script> line after init's. The runtime
//   package's own `remove` knows them from the release after 0.3.0-beta.6 (beta.6's refuses a linked file).
// - Only where the installed @genclass/runtime has the agent entry (its package.json exports "./agent", 0.3.0-beta.1
//   and later): an older one (0.2.x, npm's latest) or none installed gets the upgrade to run instead, never a link
//   that would stop the dev server and the build from resolving @genclass/runtime/agent.
// - Development builds only, with the check init itself uses for the framework's devtools line: import.meta.env.DEV
//   (Vite, SvelteKit, Astro, React Router and Remix on Vite), process.env.NODE_ENV === "development" (Next.js, Create
//   React App, webpack, rspack, rsbuild, parcel), with `typeof window !== "undefined"` in a file that also runs on the
//   server. A production build drops the branch and, with it, the agent entry.
// - A framework it cannot plan safely (Angular, Nuxt's plugin, a plain HTML script tag, a bundler that may not define
//   process.env.NODE_ENV) gets no change: the lines to add by hand, and where (for Nuxt, a marked block remove takes
//   out with the plugin).

import { dirname, join, relative, resolve, sep } from "node:path";
import { readText } from "../../runtime/bin/lib/detect.mjs";
import { appendEnd, codeStyle } from "../../runtime/bin/lib/edit.mjs";
import { channelOf, compareVersions, VERSION } from "../../runtime/bin/lib/version.mjs";

export const AGENT_START = "// genclass:init start: the coding-agent link, development builds only: GenClass.init() returns the running runtime (npx genclass remove takes it out)";
export const AGENT_START_BOUND = "// genclass:init start: the coding-agent link, development builds only: genclass is the running runtime (npx genclass remove takes it out)";
/** The block of the link's two imports when its call is at the end of the file (the app's own code is in between). */
export const AGENT_IMPORTS_START = "// genclass:init start: the coding-agent link's imports; its call is at the end of this file (npx genclass remove takes both out)";
export const AGENT_END = "// genclass:init end";
/** The first runtime release with the agent entry (@genclass/runtime/agent). */
export const AGENT_SINCE = "0.3.0-beta.1";

const DEV = {
  vite: "import.meta.env.DEV",
  node: 'process.env.NODE_ENV === "development"',
};
const BROWSER = 'typeof window !== "undefined"';
/** Bundlers that replace process.env.NODE_ENV (plan.mjs planWebpack's list). */
const NODE_ENV_BUNDLERS = ["webpack", "@rspack/core", "@rsbuild/core", "parcel"];

/** init's marked import of the /auto entry, on one line ("import ... "@genclass/runtime/auto"; // genclass:init"). */
const MARKED_AUTO = /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?["']@genclass\/runtime\/auto(?:\/(?:observe|guard|heal))?["'];?.*genclass:init/;
/** An /auto import statement (a marked line, or one inside a block init created). */
const AUTO_IMPORT = /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?["']@genclass\/runtime\/auto(?:\/(?:observe|guard|heal))?["']/;
/** The `genclass` binding init writes when it adds the devtools line (`import genclass from "@genclass/runtime/auto"`). */
const BOUND = /^\s*import\s+genclass\s+from\s+["']@genclass\/runtime\/auto(?:\/(?:observe|guard|heal))?["']/m;
/** Astro: init's marked <script> line in a layout's <head>. */
const ASTRO_SCRIPT = /^\s*<script>\s*import\s+(?:genclass\s+from\s+)?["']@genclass\/runtime\/auto(?:\/(?:observe|guard|heal))?["'].*\/\/\s*genclass:init\s*<\/script>\s*$/;
/** Tests, fixtures and end-to-end specs: a generated regression test names connectAgent without being the link. */
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|e2e|fixtures?|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** The link in a file: a call of connectAgent, in a file that names the agent entry. */
const LINKED = (t) => /@genclass\/runtime\/agent/.test(t) && /connectAgent\s*\(/.test(t);

const posix = (p) => p.split(sep).join("/");
/** Lines with their terminators: "a\nb" -> ["a\n", "b"]. */
const partsOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const indentOf = (line) => (/^[ \t]*/.exec(line) ?? [""])[0];

/** The text with `block` (lines, no terminators) inserted after line `i`, each line ended like that line. */
function insertAfter(text, i, block) {
  const parts = partsOf(text);
  const own = /\r\n$/.test(parts[i]) ? "\r\n" : parts[i].endsWith("\n") ? "\n" : null;
  if (own) {
    parts.splice(i + 1, 0, block.map((l) => `${l}${own}`).join(""));
    return parts.join("");
  }
  // the last line had no line break: the block goes after one, and the file still ends without one
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return `${parts.join("")}${eol}${block.join(eol)}`;
}

/**
 * The lines of the link, in a file's quote and semicolon style. `bound`: the file has init's `genclass` binding, and
 * the link is the dynamic import that mirrors init's devtools line (Next.js); else the two static imports and the
 * call (`GenClass.init()` returns the runtime /auto started).
 */
export function linkBlock(cond, { q = '"', semi = ";", bound = false } = {}) {
  if (bound) return [AGENT_START_BOUND, `if (${cond}) import(${q}@genclass/runtime/agent${q}).then(({ connectAgent }) => connectAgent(genclass))${semi}`, AGENT_END];
  return [AGENT_START, ...linkImports({ q, semi }), linkCall(cond, { semi }), AGENT_END];
}

const linkImports = ({ q = '"', semi = ";" } = {}) => [`import { GenClass } from ${q}@genclass/runtime${q}${semi}`, `import { connectAgent } from ${q}@genclass/runtime/agent${q}${semi}`];
const linkCall = (cond, { semi = ";" } = {}) => `if (${cond}) connectAgent(GenClass.init())${semi}`;

/**
 * The entry file's text with the coding-agent link added after GenClass's own import: right after init's marked
 * /auto import line, or after the end of the block init created around it. When the app's own code follows that
 * place, the import section stays imports only (import/first): the two imports go there in a block of their own and
 * the call in a second block at the end of the file (the dynamic form, one statement, goes there whole). Null when
 * there is no such import to put it after, or the file has the link already. `cond`: the development-build check
 * (default Vite's); `bound`: use the dynamic form when the file has init's `genclass` binding.
 */
export function withAgentLink(text, o = {}) {
  const t = String(text ?? "");
  if (/connectAgent\s*\(/.test(t)) return null;
  const cond = o.cond ?? DEV.vite;
  const lines = partsOf(t).map((p) => p.replace(/\r?\n$/, ""));
  let at = lines.findIndex((l) => MARKED_AUTO.test(l));
  if (at < 0) {
    // a file init created: the import is inside its block; the link goes after the block's end
    let start = -1;
    for (let i = 0; i < lines.length && at < 0; i++) {
      if (lines[i].includes("genclass:init start")) start = i;
      else if (lines[i].includes("genclass:init end")) {
        if (start >= 0 && lines.slice(start + 1, i).some((l) => AUTO_IMPORT.test(l))) at = i;
        start = -1;
      }
    }
  }
  if (at < 0) return null;
  const { q, semi } = codeStyle(t);
  const bound = !!o.bound && BOUND.test(t);
  const indent = indentOf(lines[at]);
  // nothing of the app's after that place: the whole link there, in one block
  if (lines.slice(at + 1).every((l) => l.trim() === "")) return insertAfter(t, at, linkBlock(cond, { q, semi, bound }).map((l) => `${indent}${l}`));
  if (bound) return appendEnd(t, linkBlock(cond, { q, semi, bound }));
  const imports = insertAfter(t, at, [AGENT_IMPORTS_START, ...linkImports({ q, semi }), AGENT_END].map((l) => `${indent}${l}`));
  return appendEnd(imports, [AGENT_START, linkCall(cond, { semi }), AGENT_END]);
}

/** Astro: the layout's text with a second marked <script> line, the link's, right after init's. Null otherwise. */
export function withAstroAgentLink(text) {
  const t = String(text ?? "");
  if (/connectAgent\s*\(/.test(t)) return null;
  const lines = partsOf(t).map((p) => p.replace(/\r?\n$/, ""));
  const at = lines.findIndex((l) => ASTRO_SCRIPT.test(l));
  if (at < 0) return null;
  const code = `import { GenClass } from "@genclass/runtime"; import { connectAgent } from "@genclass/runtime/agent"; if (${DEV.vite}) connectAgent(GenClass.init());`;
  return insertAfter(t, at, [`${indentOf(lines[at])}<script>${code} // genclass:init</script>`]);
}

/**
 * The development-build check for the link in `file` of `project` (detectProject's), as init writes it there for the
 * devtools line; null for a framework where the link is not planned (see the header).
 */
export function devCondition(project, file = "") {
  const f = posix(String(file));
  const both = (cond) => `${cond} && ${BROWSER}`;
  switch (project?.framework) {
    case "vite":
    case "sveltekit":
    case "astro":
      return DEV.vite;
    case "remix":
    case "react-router": {
      const cond = project.details?.vite ? DEV.vite : DEV.node;
      // root runs on the server too (init's devtools line has the same check there)
      return /(?:^|\/)entry\.client\.[cm]?[jt]sx?$/.test(f) ? cond : both(cond);
    }
    case "next":
      // instrumentation-client runs in the browser only; genclass-init and pages/_app render on the server too
      return /(?:^|\/)instrumentation-client\.[cm]?[jt]s$/.test(f) ? DEV.node : both(DEV.node);
    case "cra":
      return DEV.node;
    case "webpack":
      return NODE_ENV_BUNDLERS.includes(project.details?.bundler) ? DEV.node : null;
    default:
      return null;
  }
}

/** Nuxt: GenClass's plugin as init names it (<srcDir>/plugins/genclass.client.ts), relative to the project. */
function nuxtPlugin(project, file) {
  if (file) return posix(relative(project?.dir ?? ".", file));
  const src = project?.details?.srcDir && project?.dir ? posix(relative(project.dir, project.details.srcDir)) : "";
  return `${src ? `${src}/` : ""}plugins/genclass.client.ts`;
}

/**
 * The lines to add by hand where the link is not planned: { where, lines } (lines empty when there is nothing to
 * add, as for the script tag, which has no agent entry yet). `file`: GenClass's own file for the link, where known
 * (Nuxt's plugin).
 */
export function linkLines(project, file = null) {
  const imports = ['import { GenClass } from "@genclass/runtime";', 'import { connectAgent } from "@genclass/runtime/agent";'];
  switch (project?.framework) {
    case "angular":
      return { where: "src/main.ts: the imports right after GenClass's import, the if line at the end of the file", lines: ['import { isDevMode } from "@angular/core";', ...imports, "if (isDevMode()) connectAgent(GenClass.init());"] };
    case "nuxt":
      // a block of its own after the plugin's: remove takes both out, and the file init created with them
      return {
        where: `the end of GenClass's plugin (${nuxtPlugin(project, file)}), after its "// genclass:init end" line, markers included`,
        lines: [AGENT_START, ...imports, "if (import.meta.dev) connectAgent(GenClass.init());", AGENT_END],
      };
    case "html":
      return { where: "", lines: [] };
    default: {
      // a bundler that may not define `process`: a check that is false there instead of a ReferenceError
      const cond = devCondition(project, "entry.client.js") ?? 'typeof process !== "undefined" && process.env.NODE_ENV === "development"';
      return { where: "the app's browser entry: the imports right after GenClass's import, the if line at the end of the file (imports stay first)", lines: [...imports, `if (${cond}) connectAgent(GenClass.init());`] };
    }
  }
}

/** Why the link is not planned for this project, in a few words. */
function notPlannedWhy(project) {
  switch (project?.framework) {
    case "angular":
      return "an Angular app tells development builds apart with isDevMode()";
    case "nuxt":
      return "in Nuxt the link goes at the end of GenClass's plugin, by hand";
    case "html":
      return "a page with GenClass's script tag has no development build, and the agent entry is a module (ESM) only";
    case "webpack":
      return `${project.details?.bundler ?? "this bundler"} may not define process.env.NODE_ENV`;
    default:
      return "GenClass's import here is not one init marked";
  }
}

/**
 * The @genclass/runtime installed for the project in `cwd`, as Node finds it (its node_modules, else a parent's):
 * { version, agent } (`agent`: it has the agent entry, exports["./agent"]; a package.json without `exports` goes by
 * its version), or null when none is installed. `read`: a file's text or null.
 */
export function installedRuntime(cwd, read = readText) {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const text = read(join(d, "node_modules", "@genclass", "runtime", "package.json"));
    if (typeof text === "string") {
      let pkg = null;
      try {
        pkg = JSON.parse(text);
      } catch {
        pkg = null;
      }
      const version = typeof pkg?.version === "string" ? pkg.version : null;
      const ex = pkg?.exports;
      const agent = ex && typeof ex === "object" && !Array.isArray(ex) ? Object.prototype.hasOwnProperty.call(ex, "./agent") : ex === undefined && version !== null && (compareVersions(version, AGENT_SINCE) ?? -1) >= 0;
      return { version, agent };
    }
    if (dirname(d) === d) return null;
  }
}

/** The command that installs the newest runtime line (`npm install @genclass/runtime@beta` while it is a prerelease). */
export function runtimeUpgrade(pm) {
  const ch = channelOf(VERSION);
  const spec = ch ? `@genclass/runtime@${ch}` : "@genclass/runtime";
  if (pm === "pnpm") return `pnpm add ${spec}`;
  if (pm === "yarn") return `yarn add ${spec}`;
  if (pm === "bun") return `bun add ${spec}`;
  return `npm install ${spec}`;
}

/**
 * The link for a project, from the runtime CLI's inspectProject (`st`): `state` is
 * - "linked": the app's code calls connectAgent already (`files`);
 * - "planned": `changes` add it (a file each, shown and asked before they are written);
 * - "manual": it is not planned here (`why`), and `lines` are what to add by hand, `where`; `upgrade`, when the
 *   installed runtime has no agent entry (or none is installed), is the command to run first;
 * - "none": there is no GenClass setup in this folder to link (not a web app, or GenClass not added yet).
 * Only "planned" has changes; the others have `changes: null`.
 */
export function planAgentLink(st, deps = {}) {
  const read = deps.read ?? readText;
  const project = st?.project ?? null;
  const cwd = st?.cwd ?? project?.dir ?? ".";
  const rel = (f) => posix(relative(cwd, f));
  if (!project?.framework || project.refused) return { state: "none", changes: null, lines: null, why: "no web app in this folder" };
  const files = [...new Set([...(st.marked ?? []), ...(st.files ?? [])])];
  const linked = [];
  for (const f of files) {
    if (TEST_FILE.test(rel(f))) continue;
    const t = read(f);
    if (t && t.includes("connectAgent") && LINKED(t)) linked.push(rel(f));
  }
  if (linked.length) return { state: "linked", changes: null, lines: null, files: linked };
  if (st.fresh) return { state: "none", changes: null, lines: null, why: "GenClass is not added to this app yet" };
  // the agent entry must be there to import: 0.2.x (npm's latest) has none, and a link to it stops the dev server
  // and the build; the script tag needs no package
  const rt = project.framework === "html" ? { agent: true } : installedRuntime(cwd, read);
  const upgrade = rt?.agent ? null : runtimeUpgrade(project.pm);
  const needs = !upgrade ? null : rt ? `the installed @genclass/runtime${rt.version ? ` ${rt.version}` : ""} has no agent entry (it came in ${AGENT_SINCE}): first run ${upgrade}` : `@genclass/runtime is not installed in node_modules: first run ${upgrade}`;
  const manual = (why, file = null) => {
    const by = linkLines(project, file);
    return { state: "manual", changes: null, ...by, why: needs && by.lines.length ? `${why}; ${needs}` : why, ...(upgrade ? { upgrade } : {}) };
  };
  if (st.handWritten || !(st.marked ?? []).length) return manual("GenClass was added by hand, so its lines are yours to change");
  const plugin = project.framework === "nuxt" ? (st.marked.find((f) => /(?:^|\/)plugins\/genclass\.client\.[cm]?[jt]s$/.test(posix(f))) ?? null) : null;
  if (project.framework !== "astro" && devCondition(project, "entry.client.js") === null) return manual(notPlannedWhy(project), plugin);
  if (upgrade) return { state: "manual", changes: null, ...linkLines(project), why: needs, upgrade };
  const changes = [];
  for (const f of st.marked) {
    const before = read(f);
    if (before === null) continue;
    let after = null;
    if (project.framework === "astro") after = /\.astro$/.test(f) ? withAstroAgentLink(before) : null;
    else if (/\.[cm]?[jt]sx?$/.test(f)) after = withAgentLink(before, { cond: devCondition(project, f), bound: project.framework === "next" });
    if (after !== null && after !== before) changes.push({ file: f, rel: rel(f), kind: "modify", before, after, what: `${rel(f)}: the coding-agent link, development builds only` });
  }
  if (!changes.length) return manual(project.framework === "astro" ? "GenClass's script shares its line with other code in <head>" : notPlannedWhy(project));
  return { state: "planned", changes, lines: null };
}

/** The command that starts the project's dev server ("npm run dev"), from its package.json scripts; null if none. */
export function devCommand(project) {
  const scripts = project?.pkg?.scripts ?? {};
  const name = ["dev", "start", "serve", "develop"].find((s) => typeof scripts[s] === "string");
  if (!name) return null;
  const pm = project.pm ?? "npm";
  if (pm === "npm") return name === "start" ? "npm start" : `npm run ${name}`;
  if (pm === "bun") return `bun run ${name}`;
  return `${pm} ${name}`;
}

/**
 * How to see GenClass work right now, before any deploy, in one sentence: the dev server, the page, its [GenClass]
 * lines in the browser console, and the question for the coding agent (`agent`: its MCP server is configured here;
 * else once it is, by the Coding agent step).
 */
export function seeItNow(project, { agent = true } = {}) {
  const dev = devCommand(project);
  const start = dev ? `start your dev server (${dev}) and open the page` : "start your dev server and open the page";
  const ask = '"is GenClass connected?" or to explore a flow for races';
  const tail = agent ? `, and ask your coding agent ${ask}` : `; once your coding agent is connected (the Coding agent step), ask it ${ask}`;
  return `To see GenClass work now, before any deploy: ${start}; GenClass prints [GenClass] lines in the browser console${tail}.`;
}
