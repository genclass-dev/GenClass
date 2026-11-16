// The file edits behind `npx sv add @genclass`, as pure functions of a file's text (no file system: index.ts reads
// and writes through sv's API). They write what `npx @genclass/runtime init` writes for SvelteKit, with the same
// `genclass:init` marker, so `npx @genclass/runtime remove` takes it out again and `init` recognises the setup:
//   - a new src/hooks.client.(ts|js) is one marked block (remove deletes the file);
//   - an existing one gets the /auto import first, marked on its line;
//   - nothing that draws on the page: the devtools overlay is never added (owner, 2026-11-16; a developer can add it
//     by hand, see the README);
//   - the telemetry opt-out is one marked `<meta name="genclass" content="telemetry=off" />` line in src/app.html.
// Every edit is idempotent: a second run with the same options returns `false` (nothing to write).

import { minimizeDiff, transforms, type AstTypes } from "@sveltejs/sv-utils";

/** The modes the add-on offers: observe (the runtime's default) and guard. heal stays a hand edit (experimental). */
export type Mode = "observe" | "guard";

export const RUNTIME = "@genclass/runtime";
/**
 * What `npm install @genclass/runtime@beta` writes for the release the GenClass README documents
 * (`0.3.0-beta.1`). The caret also takes later 0.3.0 betas and 0.3.x.
 */
export const RUNTIME_RANGE = "^0.3.0-beta.1";
/** @genclass/runtime's CLI marker (packages/runtime/bin/lib/edit.mjs): `remove` deletes exactly the marked code. */
export const MARK = "genclass:init";

const AUTO_RE = /^@genclass\/runtime\/auto(?:\/(observe|guard|heal))?$/;
const META_RE = /<meta\b[^>]*\bname\s*=\s*["']genclass["'][^>]*>/i;
const CONTENT_RE = /\bcontent\s*=\s*(["'])(.*?)\1/i;
const OFF = new Set(["false", "0", "off", "no", "none"]);

/** `@genclass/runtime/auto` (observe) or `@genclass/runtime/auto/guard`. */
export const autoSpecifier = (mode: Mode): string => (mode === "guard" ? "@genclass/runtime/auto/guard" : "@genclass/runtime/auto");

/** The mode an /auto specifier starts (no suffix = observe), or null for another module. */
export function modeOf(specifier: string): string | null {
  const m = AUTO_RE.exec(specifier);
  return m ? (m[1] ?? "observe") : null;
}

/** The client hooks file when the app has none: one marked block, as `init` creates it. */
export function newHooksFile(mode: Mode): string {
  return [
    `// ${MARK} start: GenClass Runtime, added by \`npx sv add @genclass\` (\`npx @genclass/runtime remove\` takes it out)`,
    `import "${autoSpecifier(mode)}";`,
    `// ${MARK} end`,
    "",
  ].join("\n");
}

/**
 * An existing client hooks file with GenClass added: the /auto import as the first statement, or, if the file
 * already imports /auto, that import re-pointed at `mode` (its bindings kept). Nothing else: the devtools overlay is
 * never added, and a devtools line the developer wrote stays as it is. `false` when there is nothing to change.
 */
export function editHooks(content: string, mode: Mode): string | false {
  let addedTop = false;
  const out = transforms.script(({ ast, comments, js }) => {
    let changed = false;
    const auto = js.imports.findAll(ast, { from: AUTO_RE }).find((f) => f.kind === "static");
    if (!auto) {
      // addEmpty inserts at the top of the module, so GenClass is installed before the app's other imports run
      js.imports.addEmpty(ast, { from: autoSpecifier(mode) });
      comments.add(ast.body[0] as AstTypes.Node, { type: "Line", value: ` ${MARK}` }, { position: "trailing" });
      changed = addedTop = true;
    } else if (modeOf(auto.source) !== mode) {
      js.imports.setSource(auto, autoSpecifier(mode));
      changed = true;
    }
    if (!changed) return false;
  })(content);
  if (out === false) return false;
  // the printer reformats the whole module; keep the developer's lines as they were (sv's engine does the same)
  return tighten(minimizeDiff(content, out), content, addedTop);
}

/**
 * The printer sets the line it added apart from the developer's code with a blank line and drops the final line
 * break. `init` adds no blank line, and `remove` takes out only the marked line, so that blank line goes and the
 * file's final line break stays: remove then gives the file back byte for byte.
 */
function tighten(out: string, original: string, top: boolean): string {
  const eol = out.includes("\r\n") ? "\r\n" : "\n";
  const lines = out.split(eol);
  const orig = original.split(/\r?\n/);
  if (top && lines[0].includes(MARK) && lines[1] === "" && orig[0] !== "") lines.splice(1, 1);
  const text = lines.join(eol);
  // the printer ends the module without a line break; keep the file's own
  return original.endsWith("\n") && !text.endsWith("\n") ? text + eol : text;
}

/** The content of a `<meta name="genclass">` tag as ordered key/value pairs (`telemetry=off, mode=guard`). */
function metaPairs(content: string): Array<[string, string]> {
  return content
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [p, ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    });
}

const isTelemetryKey = (k: string) => k.toLowerCase() === "telemetry";
const withContent = (line: string, pairs: Array<[string, string]>) =>
  line.replace(CONTENT_RE, (_m, q: string) => `content=${q}${pairs.map(([k, v]) => (v ? `${k}=${v}` : k)).join(", ")}${q}`);

/**
 * src/app.html with the telemetry choice written as GenClass's documented page configuration:
 *   - `telemetry: false`: a `<meta name="genclass" content="telemetry=off" />` line (marked) before
 *     `%sveltekit.head%`, or `telemetry=off` added to a genclass meta tag the page already has;
 *   - `telemetry: true`: `telemetry=off` taken out of the marked line this add-on (or `init`) wrote, the line
 *     dropped when nothing else is left in it. An opt-out written by hand stays.
 * `false` when there is nothing to change, or when the file has no `<head>` (index.ts refuses that case first).
 */
export function editAppHtml(content: string, telemetry: boolean): string | false {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(eol);
  const metaAt = lines.findIndex((l) => META_RE.test(l));
  if (metaAt >= 0) {
    const line = lines[metaAt];
    const pairs = metaPairs(CONTENT_RE.exec(line)?.[2] ?? "");
    const off = pairs.some(([k, v]) => isTelemetryKey(k) && OFF.has(v.toLowerCase()));
    if (!telemetry) {
      if (off) return false;
      const next = [...pairs.filter(([k]) => !isTelemetryKey(k)), ["telemetry", "off"] as [string, string]];
      lines[metaAt] = CONTENT_RE.test(line) ? withContent(line, next) : line.replace(/\s*\/?>$/, ` content="telemetry=off" />`);
      return lines.join(eol);
    }
    if (!off || !line.includes(MARK)) return false;
    const rest = pairs.filter(([k]) => !isTelemetryKey(k));
    if (rest.length) lines[metaAt] = withContent(line, rest);
    else lines.splice(metaAt, 1);
    return lines.join(eol);
  }
  if (telemetry) return false;
  const at = headSlot(lines);
  if (at < 0) return false;
  const indent = (/^[ \t]*/.exec(lines[at]) ?? [""])[0];
  // before `</head>`: one level deeper than the closing tag
  const pad = /^\s*<\/head>/i.test(lines[at]) ? indent + (indent.startsWith(" ") ? "  " : "\t") : indent;
  lines.splice(at, 0, `${pad}<meta name="genclass" content="telemetry=off" /> <!-- ${MARK} -->`);
  return lines.join(eol);
}

/** The line to insert the meta tag before: the one starting with `%sveltekit.head%`, else with `</head>`; or -1. */
function headSlot(lines: string[]): number {
  const at = lines.findIndex((l) => /^\s*%sveltekit\.head%/.test(l));
  return at >= 0 ? at : lines.findIndex((l) => /^\s*<\/head>/i.test(l));
}

/** Whether src/app.html has a genclass meta tag or a line the add-on can put one before. */
export function hasHeadSlot(content: string): boolean {
  return META_RE.test(content) || headSlot(content.split(/\r?\n/)) >= 0;
}
