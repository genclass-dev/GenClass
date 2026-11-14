// The dev-only coding-agent link for a project GenClass's init set up: `connectAgent` from @genclass/runtime/agent
// (docs/runtime/AGENT.md section 1), which lets the coding agent's MCP server see the page the developer runs on
// localhost (each click, request and response, the order they arrived) and run it again in another order. Used by
// the setup walk's Coding agent step (actions.mjs connectAgent), its state (state.mjs, step "agent") and
// `genclass doctor --fix` (doctor.mjs).
//
// Invariants:
// - Pure: reads files and returns the changes ({ file, rel, kind: "create" | "modify", before, after, what }); nothing
//   is written here. The caller shows them, asks first, and writes them in their order: the link's file before the
//   line that imports it.
// - The person's code is never parsed or edited. The link is a file of its own next to the entry (genclass.agent.ts,
//   or genclass.agent.js beside a JavaScript entry; beside Next.js's pages/_app the folder above, as init does for
//   genclass.config), one genclass:init block from its first line to its last. The entry gets one marked line,
//   `import "./genclass.agent"; // genclass:init` (".js" on a JavaScript file's), right after init's own marked /auto
//   import, or after the block of a file init created. Imports stay first (ESLint's import/first, an error in Create
//   React App's build), and a module's imports run in their order before its own code, so the link runs right after
//   /auto and before the app's code (an entry that throws while the page loads, or awaits at the top, is linked
//   before it does). The line follows a whole line of init's, and an import declaration ends at a line break before
//   anything but `with {`, so it never joins the line after it, whatever the app's own code is.
// - Every form written here is one `genclass remove` takes out (packages/runtime/bin/lib/edit.mjs LINE_RE and
//   BLOCK_RE): the import line, and the file, whose first line is init's created-file header, so remove deletes it as
//   it does genclass.config; in Astro one marked <script> line after init's. The runtime package's own `remove`
//   knows them from the release after 0.3.0-beta.6 (beta.6's refuses a linked file).
// - Only where the installed @genclass/runtime has the agent entry (its package.json exports "./agent", 0.3.0-beta.1
//   and later): an older one (0.2.x, npm's latest) or none installed gets the upgrade to run instead, never a link
//   that would stop the dev server and the build from resolving @genclass/runtime/agent. Plug'n'Play installs (Yarn's
//   default, pnpm's node-linker=pnp) have no node_modules: there the lockfile next to .pnp.cjs gives the version.
// - Development builds only, with the check init itself uses for the framework's devtools line: import.meta.env.DEV
//   (Vite, SvelteKit, Astro, React Router and Remix on Vite), process.env.NODE_ENV === "development" (Next.js, Create
//   React App, webpack, rspack, rsbuild, parcel), with `typeof window !== "undefined"` where the entry also runs on
//   the server. A production build drops the branch and, with it, the agent entry. In Next.js the file starts with
//   "use client", as init's genclass-init component does.
// - A framework it cannot plan safely (Angular, Nuxt's plugin, a plain HTML script tag, a bundler that may not define
//   process.env.NODE_ENV) gets no change: the lines to add by hand, and where (for Nuxt, a marked block remove takes
//   out with the plugin). So does a project with a genclass.agent file of its own where the link's file would go.

import { dirname, join, relative, resolve, sep } from "node:path";
import { isFile, readText } from "../../runtime/bin/lib/detect.mjs";
import { codeStyle, eolOf } from "../../runtime/bin/lib/edit.mjs";
import { channelOf, compareVersions, VERSION } from "../../runtime/bin/lib/version.mjs";
import { lockVersion } from "./suggest/repo.mjs";

/**
 * The first line of the link's file: init's created-file header ("genclass:init start: GenClass Runtime"), so
 * `remove` deletes the file once its block is out, as it does the files init creates.
 */
export const AGENT_FILE_START = "// genclass:init start: GenClass Runtime's coding-agent link, development builds only, imported right after GenClass's import (npx genclass remove deletes this file)";
/** The start of a marked block holding the link, as the lines to add for Nuxt's plugin are. */
export const AGENT_START = "// genclass:init start: the coding-agent link, development builds only: GenClass.init() returns the running runtime (npx genclass remove takes it out)";
export const AGENT_END = "// genclass:init end";
/** The link's file next to the entry, without its extension. */
export const AGENT_FILE = "genclass.agent";
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
/** The entry's marked import of the link's file; group 1 is its specifier. */
const LINK_IMPORT = /^\s*import\s+["']((?:\.{1,2}\/)+(?:[\w.-]+\/)*genclass\.agent(?:\.[cm]?[jt]s)?)["'];?\s*\/\/\s*genclass:init\s*$/;
/** Tests, fixtures and end-to-end specs: a generated regression test names connectAgent without being the link. */
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|e2e|fixtures?|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** The link in a file: a call of connectAgent, in a file that names the agent entry. */
const LINKED = (t) => /@genclass\/runtime\/agent/.test(t) && /connectAgent\s*\(/.test(t);

const posix = (p) => p.split(sep).join("/");
/** Lines with their terminators: "a\nb" -> ["a\n", "b"]. */
const partsOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const linesOf = (text) => partsOf(text).map((p) => p.replace(/\r?\n$/, ""));
const indentOf = (line) => (/^[ \t]*/.exec(line) ?? [""])[0];
/** Whether `text` is the link's file as this command writes it: its header first, and the link in it. */
const isLinkFile = (text) => String(text ?? "").replace(/^﻿/, "").startsWith(AGENT_FILE_START) && LINKED(String(text));

/** The text with `line` (no terminator) inserted after line `i`, ended as that line is. */
function insertAfter(text, i, line) {
  const parts = partsOf(text);
  const own = /\r\n$/.test(parts[i]) ? "\r\n" : parts[i].endsWith("\n") ? "\n" : null;
  if (own) {
    parts.splice(i + 1, 0, `${line}${own}`);
    return parts.join("");
  }
  // the last line had no line break: the line goes after one, and the file still ends without one
  return `${parts.join("")}${eolOf(text)}${line}`;
}

/**
 * Where init's own /auto import is in an entry's lines: its marked line, else the end of the block of a file init
 * created that holds it; -1 when there is none.
 */
function autoLine(lines) {
  const at = lines.findIndex((l) => MARKED_AUTO.test(l));
  if (at >= 0) return at;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("genclass:init start")) start = i;
    else if (lines[i].includes("genclass:init end")) {
      if (start >= 0 && lines.slice(start + 1, i).some((l) => AUTO_IMPORT.test(l))) return i;
      start = -1;
    }
  }
  return -1;
}

/**
 * Where the link's file goes for `entry`: next to it, except beside Next.js's pages/_app, where pages/ is routed (a
 * file there would be a page): then the folder above, as init's genclass.config. genclass.agent.ts beside a
 * TypeScript entry, else genclass.agent.js.
 */
export function linkFileFor(project, entry) {
  const ts = /\.[cm]?tsx?$/.test(entry);
  let dir = dirname(entry);
  if (project?.framework === "next" && /[\\/]pages[\\/]_app\.[cm]?[jt]sx?$/.test(entry)) dir = dirname(dir);
  return join(dir, `${AGENT_FILE}.${ts ? "ts" : "js"}`);
}

/**
 * How `entry` imports the link's `file`: a relative specifier, with ".js" for a JavaScript file (Node's ESM and
 * webpack's fully specified imports need it, and every bundler takes it) and none for TypeScript (as init imports
 * genclass.config).
 */
export function linkSpecifier(entry, file) {
  let r = posix(relative(dirname(entry), file));
  if (/\.ts$/.test(r)) r = r.slice(0, -3);
  return r.startsWith(".") ? r : `./${r}`;
}

/**
 * The link's file: one genclass:init block, its header first. `cond`: the development-build check; `client`: "use
 * client" first (Next.js, as init's genclass-init component); `bound`: init bound `genclass` in the entry (Next.js's
 * devtools line), and the agent entry is imported as that line imports the devtools, dynamically behind the check;
 * else the two static imports and the call. `q`, `semi`: the entry's quote and semicolon style; `eol`: its line end.
 */
export function agentFileText(cond, { q = '"', semi = ";", bound = false, client = false, eol = "\n" } = {}) {
  const from = (name, spec) => `import { ${name} } from ${q}${spec}${q}${semi}`;
  const lines = [
    AGENT_FILE_START,
    ...(client ? [`${q}use client${q}${semi}`, ""] : []),
    from("GenClass", "@genclass/runtime"),
    ...(bound ? [] : [from("connectAgent", "@genclass/runtime/agent")]),
    "",
    bound ? `if (${cond}) import(${q}@genclass/runtime/agent${q}).then(({ connectAgent }) => connectAgent(GenClass.init()))${semi}` : `if (${cond}) connectAgent(GenClass.init())${semi}`,
    AGENT_END,
  ];
  return `${lines.join(eol)}${eol}`;
}

/** The specifiers of the link's file that a text's marked lines import. */
const linkImportsIn = (text) => linesOf(String(text ?? "")).flatMap((l) => LINK_IMPORT.exec(l)?.[1] ?? []);

/**
 * The entry's text with one marked line importing the link's file (`spec`, default "./genclass.agent.js") right
 * after GenClass's own import: init's marked /auto import line, or the end of the block of a file init created. The
 * rest of the file is not read: the line goes after a whole line of init's, in the file's quote and semicolon style.
 * Null when there is no such import to put it after, or the file imports the link's file or calls connectAgent
 * already.
 */
export function withAgentLink(text, o = {}) {
  const t = String(text ?? "");
  if (/connectAgent\s*\(/.test(t) || linkImportsIn(t).length) return null;
  const lines = linesOf(t);
  const at = autoLine(lines);
  if (at < 0) return null;
  const { q, semi } = codeStyle(t);
  const spec = o.spec ?? `./${AGENT_FILE}.js`;
  return insertAfter(t, at, `${indentOf(lines[at])}import ${q}${spec}${q}${semi} // genclass:init`);
}

/** Astro: the layout's text with a second marked <script> line, the link's, right after init's. Null otherwise. */
export function withAstroAgentLink(text) {
  const t = String(text ?? "");
  if (/connectAgent\s*\(/.test(t)) return null;
  const lines = linesOf(t);
  const at = lines.findIndex((l) => ASTRO_SCRIPT.test(l));
  if (at < 0) return null;
  const code = `import { GenClass } from "@genclass/runtime"; import { connectAgent } from "@genclass/runtime/agent"; if (${DEV.vite}) connectAgent(GenClass.init());`;
  return insertAfter(t, at, `${indentOf(lines[at])}<script>${code} // genclass:init</script>`);
}

/**
 * The development-build check for the link of entry `file` of `project` (detectProject's), as init writes it there
 * for the devtools line; null for a framework where the link is not planned (see the header).
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
      return { where: "src/main.ts: the imports right after GenClass's import, the if line right after the file's last import (before bootstrapApplication)", lines: ['import { isDevMode } from "@angular/core";', ...imports, "if (isDevMode()) connectAgent(GenClass.init());"] };
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
      return { where: "the app's browser entry: the imports right after GenClass's import, the if line right after the file's last import (imports stay first, and it runs before the app's code)", lines: [...imports, `if (${cond}) connectAgent(GenClass.init());`] };
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

/** Plug'n'Play's resolver (Yarn 2 wrote .pnp.js; Yarn 3 and later, and pnpm's node-linker=pnp, write .pnp.cjs). */
const PNP_FILES = [".pnp.cjs", ".pnp.js"];
const PNP_LOCKS = [
  ["yarn", "yarn.lock"],
  ["pnpm", "pnpm-lock.yaml"],
];
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
/** Whether `version` has the agent entry; null when it does not say (a workspace's own "0.0.0-use.local"). */
const agentIn = (version) => (version === null || /-use\.local$/.test(version) ? null : (compareVersions(version, AGENT_SINCE) ?? -1) >= 0);

/**
 * A Plug'n'Play install rooted at `root` (no node_modules: .pnp.cjs resolves packages from the cache): the version
 * of @genclass/runtime its lockfile gives the app in `cwd`, as { version, agent } (`agent` null when the lockfile
 * holds it but not which version this app gets), or null when the lockfile does not hold it (not installed).
 */
function pnpRuntime(root, cwd, read) {
  const pkg = parse(read(join(cwd, "package.json")) ?? "");
  const range = ["dependencies", "devDependencies", "optionalDependencies"].map((k) => pkg?.[k]?.["@genclass/runtime"]).find((r) => typeof r === "string");
  const importer = posix(relative(root, resolve(cwd)));
  for (const [kind, file] of PNP_LOCKS) {
    const text = read(join(root, file));
    if (typeof text !== "string") continue;
    const version = lockVersion(kind, text, "@genclass/runtime", { importer, range, workspace: typeof pkg?.name === "string" ? pkg.name : undefined });
    if (version) return { version, agent: agentIn(version) };
    // there, but several versions and not one this app's range names
    if (/(?:^|["'\s/,])@genclass\/runtime@/m.test(text)) return { version: null, agent: null };
  }
  return null;
}

/**
 * The @genclass/runtime installed for the project in `cwd`, as Node finds it (its node_modules, else a parent's):
 * { version, agent } (`agent`: it has the agent entry, exports["./agent"]; a package.json without `exports` goes by
 * its version), or null when none is installed. A Plug'n'Play install (.pnp.cjs, no node_modules) goes by the
 * version its lockfile gives; `agent` is null when that cannot be told. `read`: a file's text or null; `exists`:
 * whether a file is there.
 */
export function installedRuntime(cwd, read = readText, exists = isFile) {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const text = read(join(d, "node_modules", "@genclass", "runtime", "package.json"));
    if (typeof text === "string") {
      const pkg = parse(text);
      const version = typeof pkg?.version === "string" ? pkg.version : null;
      const ex = pkg?.exports;
      const agent = ex && typeof ex === "object" && !Array.isArray(ex) ? Object.prototype.hasOwnProperty.call(ex, "./agent") : ex === undefined && version !== null && (compareVersions(version, AGENT_SINCE) ?? -1) >= 0;
      return { version, agent };
    }
    if (PNP_FILES.some((f) => exists(join(d, f)))) return pnpRuntime(d, cwd, read);
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
 * - "linked": the app's code calls connectAgent already (`files`); the link's own file counts once a marked line
 *   imports it;
 * - "planned": `changes` add it (the link's file, then the line in the entry that imports it; shown and asked before
 *   they are written, in that order);
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
  const marked = st.marked ?? [];
  const files = [...new Set([...marked, ...(st.files ?? [])])];
  // the link's files the marked lines import (an extensionless specifier names the .ts file)
  const imported = new Set(marked.flatMap((m) => linkImportsIn(read(m)).map((s) => resolve(dirname(m), /\.[cm]?[jt]s$/.test(s) ? s : `${s}.ts`))));
  const linked = [];
  for (const f of files) {
    if (TEST_FILE.test(rel(f))) continue;
    const t = read(f);
    if (!t || !t.includes("connectAgent") || !LINKED(t)) continue;
    // the link's own file whose import line was taken out by hand links nothing: planned again (the line alone)
    if (isLinkFile(t) && !imported.has(resolve(f))) continue;
    linked.push(rel(f));
  }
  if (linked.length) return { state: "linked", changes: null, lines: null, files: linked };
  if (st.fresh) return { state: "none", changes: null, lines: null, why: "GenClass is not added to this app yet" };
  // the agent entry must be there to import: 0.2.x (npm's latest) has none, and a link to it stops the dev server
  // and the build; the script tag needs no package
  // (a Plug'n'Play install whose lockfile does not say which version this app gets: planned, as it cannot be told)
  const rt = project.framework === "html" ? { agent: true } : installedRuntime(cwd, read, deps.exists ?? isFile);
  const upgrade = rt && rt.agent !== false ? null : runtimeUpgrade(project.pm);
  const needs = !upgrade ? null : rt ? `the installed @genclass/runtime${rt.version ? ` ${rt.version}` : ""} has no agent entry (it came in ${AGENT_SINCE}): first run ${upgrade}` : `@genclass/runtime is not installed: first run ${upgrade}`;
  const manual = (why, file = null) => {
    const by = linkLines(project, file);
    return { state: "manual", changes: null, ...by, why: needs && by.lines.length ? `${why}; ${needs}` : why, ...(upgrade ? { upgrade } : {}) };
  };
  if (st.handWritten || !marked.length) return manual("GenClass was added by hand, so its lines are yours to change");
  const plugin = project.framework === "nuxt" ? (marked.find((f) => /(?:^|\/)plugins\/genclass\.client\.[cm]?[jt]s$/.test(posix(f))) ?? null) : null;
  if (project.framework !== "astro" && devCondition(project, "entry.client.js") === null) return manual(notPlannedWhy(project), plugin);
  if (upgrade) return { state: "manual", changes: null, ...linkLines(project), why: needs, upgrade };
  const made = [];
  const edits = [];
  let taken = null;
  for (const f of marked) {
    const before = read(f);
    if (before === null) continue;
    if (project.framework === "astro") {
      const after = /\.astro$/.test(f) ? withAstroAgentLink(before) : null;
      if (after !== null && after !== before) edits.push({ file: f, rel: rel(f), kind: "modify", before, after, what: `${rel(f)}: the coding-agent link, development builds only` });
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(f) || autoLine(linesOf(before)) < 0) continue;
    const file = linkFileFor(project, f);
    const own = read(file);
    // a file of the person's own by that name (or one of GenClass's that was edited) is left alone
    if (own !== null && !isLinkFile(own)) {
      taken = rel(file);
      continue;
    }
    if (own === null && !made.some((ch) => ch.file === file)) {
      const { q, semi } = codeStyle(before);
      const after = agentFileText(devCondition(project, f), { q, semi, eol: eolOf(before), client: project.framework === "next", bound: project.framework === "next" && BOUND.test(before) });
      made.push({ file, rel: rel(file), kind: "create", before: "", after, what: `${rel(file)}: the coding-agent link, development builds only` });
    }
    const after = withAgentLink(before, { spec: linkSpecifier(f, file) });
    if (after !== null && after !== before) edits.push({ file: f, rel: rel(f), kind: "modify", before, after, what: `${rel(f)}: the line that imports ${rel(file)}, right after GenClass's import` });
  }
  const changes = [...made, ...edits];
  if (!changes.length) {
    if (taken) return manual(`${taken} is there already and is not GenClass's link, so it was left alone`);
    return manual(project.framework === "astro" ? "GenClass's script shares its line with other code in <head>" : notPlannedWhy(project));
  }
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
