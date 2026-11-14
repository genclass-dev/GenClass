// `genclass privacy`: what this project's GenClass setup sends from its visitors' browsers, to whom, what it keeps on
// their devices and for how long, read from the project's own files. The answer to "is it compliant?" is "you choose
// how GenClass runs"; this command says what the current choice is, in words a privacy policy or a record of
// processing can take, and the exact lines that make GenClass send and keep nothing.
//
// Invariants:
// - Read only, and local: it reads the project's files and nothing else. No request is made, nothing is written but
//   the --out file the person names, and it needs no sign-in and no plan (a privacy answer is never paywalled).
// - Every sentence about what is sent is a fact from packages/runtime/TELEMETRY.md and the README's
//   Content-Security-Policy section, chosen by the options found in the project. The setup is read from text, so it
//   says when a value could not be read (the "Not read" row: set by code) instead of guessing a safe answer.
// - Options are read only from GenClass's own places, with comments taken out: the window.GENCLASS_CONFIG object, the
//   GenClass.init({...}) argument, the Nuxt module's `genclass: {...}` options, the Astro integration's genclass({...})
//   call, the <meta name="genclass"> tag, the script tag and its data-* attributes, and the /auto import's path. Each
//   key is read inside its own object (telemetry.endpoint, model.baseUrl, learn.persist, breaker.persist), never from
//   any code that happens to share a file with GenClass. Tests, test setup files and fixtures never count.
// - The consent gate is described as working only where the project's runtime has it: 0.3.0-beta.6 and earlier
//   ignore the option, and the map says so.
// - It is not legal advice and says so: the guidance names the rules and the regulators' readings, and leaves the
//   call to the person.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { c, out } from "../../runtime/bin/lib/ui.mjs";
import { compareVersions } from "../../runtime/bin/lib/version.mjs";
import { clean, good, header, note, para, warn, width, wrap } from "./tui.mjs";

const TELEMETRY_DOC = "https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/TELEMETRY.md";
const PRIVACY_DOC = "https://github.com/genclass-dev/GenClass/blob/main/PRIVACY.md";
const CSP_DOC = "https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/README.md#content-security-policy-and-self-hosting";
const CONSENT_DOC = "https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/TELEMETRY.md#consent";
/** The call a consent banner makes (the runtime's InitOptions.consent): GenClass.consent(...) or a runtime's consent(...). */
const CONSENT_CALL = "GenClass.consent({ diagnostics, analytics, storage, model })";
/** The last runtime release without the consent gate (TELEMETRY.md "Consent": "0.3.0-beta.6 and earlier"). */
export const LAST_WITHOUT_CONSENT = "0.3.0-beta.6";
/** The four parts the consent gate holds (the runtime's CONSENT_PARTS). */
const PARTS = ["diagnostics", "analytics", "storage", "model"];
const MODES = ["observe", "guard", "heal"];
const JSDELIVR = "cdn.jsdelivr.net";

/** Text that sets GenClass up: an import or script tag of the runtime, its init, its config, its meta tag, an integration. */
const REF = /@genclass\/(?:runtime|nuxt|astro)\b|GenClass\.init\s*\(|GENCLASS_CONFIG|<meta[^>]+name=["']genclass["']|genclass\.global(?:\.min)?\.js/;

/** Tests, test setup and test-runner files, fixtures, stories: they import GenClass without shipping it. */
const TEST_FILE =
  /(?:^|\/)(?:tests?|__tests__|e2e|specs?|fixtures?|__fixtures__|__mocks__|cypress|playwright|testing)\/|\.(?:test|spec|cy|e2e|stories)\.[cm]?[jt]sx?$|(?:^|\/)(?:setupTests|setup-tests|test-setup|test|(?:vitest|jest|playwright|cypress|karma|wdio)[.-](?:setup|config|conf|workspace)(?:\.[\w-]+)?)\.[cm]?[jt]sx?$/;

/** Whether a project-relative path is a test's (TEST_FILE), with Windows separators read as "/". */
export const isTestFile = (rel) => TEST_FILE.test(String(rel ?? "").replace(/\\/g, "/"));

// ------------------------------------------------------------------------- reading source text, without running it

/** Index just after the string literal that starts at s[i]; a ' or " string ends at its line's end when unclosed. */
function stringEnd(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (ch === "\\") j++;
    else if (ch === q) return j + 1;
    else if (ch === "\n" && q !== "`") return j;
  }
  return s.length;
}

/** Index just after the regular expression literal at s[i] (on one line, with its flags), or -1 when it is not one. */
function regexEnd(s, i) {
  let cls = false;
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (ch === "\n") return -1;
    if (ch === "\\") j++;
    else if (cls) cls = ch !== "]";
    else if (ch === "[") cls = true;
    else if (ch === "/") {
      let k = j + 1;
      while (/[a-z]/i.test(s[k] ?? "")) k++;
      return k;
    }
  }
  return -1;
}

/**
 * `text` without its comments: `//` and block comments and `<!-- -->`, outside strings and regular expressions, so a
 * commented-out option (or a template's note "switch to /auto/guard") is never read as set. A `//` right after `:`
 * or `=` (a URL, `src=//host`) is kept.
 */
export function stripComments(text) {
  const s = String(text ?? "");
  let res = "";
  let prev = "";
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    const nx = s[i + 1];
    if (ch === "<" && s.startsWith("<!--", i)) {
      const e = s.indexOf("-->", i + 4);
      i = e < 0 ? s.length : e + 3;
      res += " ";
      continue;
    }
    if (ch === "/" && nx === "*") {
      const e = s.indexOf("*/", i + 2);
      i = e < 0 ? s.length : e + 2;
      res += " ";
      continue;
    }
    if (ch === "/" && nx === "/" && !/[:=\\]/.test(s[i - 1] ?? "")) {
      const e = s.indexOf("\n", i);
      i = e < 0 ? s.length : e;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const e = stringEnd(s, i);
      res += s.slice(i, e);
      prev = ch;
      i = e;
      continue;
    }
    if (ch === "/" && /^$|[(,=:[!&|?{};+\-*%~^]/.test(prev)) {
      const e = regexEnd(s, i);
      if (e > 0) {
        res += s.slice(i, e);
        prev = "/";
        i = e;
        continue;
      }
    }
    res += ch;
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return res;
}

/** A value set by code (a variable, a call, a computed template): its source, not read further. */
class Code {
  constructor(src) {
    this.src = src;
  }
}
const SPREAD = Symbol("spread");
const isObj = (v) => !!v && typeof v === "object" && !(v instanceof Code) && !Array.isArray(v);

/** Index just after the bracket that closes the one at s[i] ("{", "[" or "("), skipping strings; s.length if unclosed. */
function closeOf(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch === '"' || ch === "'" || ch === "`") j = stringEnd(s, j) - 1;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth <= 0) return j + 1;
    }
  }
  return s.length;
}

/** Where the expression that starts at s[i] ends: the next "," or closing bracket at its own depth (before `end`). */
function exprEnd(s, i, end) {
  for (let j = i; j < end; j++) {
    const ch = s[j];
    if (ch === '"' || ch === "'" || ch === "`") j = stringEnd(s, j) - 1;
    else if (ch === "{" || ch === "[" || ch === "(") j = closeOf(s, j) - 1;
    else if (ch === "," || ch === "}" || ch === "]" || ch === ")") return j;
  }
  return end;
}

const skipSpace = (s, i) => {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};
const unescape = (raw) => raw.replace(/\\(.)/gs, "$1");
const STRING = /^(["'`])((?:\\.|(?!\1)[^\\])*)\1$/s;

/** One value's source read as data: a literal, an object, an array, or Code. */
function valueOf(src) {
  const t = src
    .trim()
    .replace(/\s+(?:as\s+const|as\s+[\w$.<>[\], ]+|satisfies\s+[\w$.<>[\], ]+)$/, "")
    .replace(/!$/, "")
    .trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "undefined" || t === "") return undefined;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(t)) return Number(t);
  const m = STRING.exec(t);
  if (m && !(m[1] === "`" && m[2].includes("${"))) return unescape(m[2]);
  if (t[0] === "{" && closeOf(t, 0) === t.length) return objectOf(t, 0, t.length);
  if (t[0] === "[" && closeOf(t, 0) === t.length) return arrayOf(t, 0, t.length);
  if (t[0] === "(" && closeOf(t, 0) === t.length) return valueOf(t.slice(1, -1));
  return new Code(t);
}

/** The object literal s[start..end) ("{" to "}") as data; keys it cannot read are left out, spreads are noted. */
function objectOf(s, start, end) {
  const o = Object.create(null);
  const stop = Math.max(start + 1, end - 1);
  for (let i = start + 1; i < stop; ) {
    i = skipSpace(s, i);
    if (i >= stop) break;
    if (s[i] === ",") {
      i++;
      continue;
    }
    if (s.startsWith("...", i)) {
      const e = exprEnd(s, i + 3, stop);
      (o[SPREAD] ??= []).push(new Code(s.slice(i + 3, e).trim()));
      i = Math.max(e, i + 3);
      continue;
    }
    let key = null;
    let j;
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      j = stringEnd(s, i);
      key = unescape(s.slice(i + 1, j - 1));
    } else if (ch === "[") j = closeOf(s, i);
    else {
      const m = /^[\w$]+/.exec(s.slice(i, i + 256));
      if (!m) {
        i = Math.max(exprEnd(s, i + 1, stop), i + 1);
        continue;
      }
      key = m[0];
      j = i + key.length;
    }
    j = skipSpace(s, j);
    if (s[j] === ":") {
      const e = exprEnd(s, j + 1, stop);
      if (key !== null) o[key] = valueOf(s.slice(j + 1, e));
      i = Math.max(e, j + 1);
    } else {
      // shorthand (`{ token }`), a method, a getter: set by code
      const e = exprEnd(s, j, stop);
      if (key !== null) o[key] = new Code(`${key}${s.slice(j, e)}`.trim());
      i = Math.max(e, i + 1);
    }
  }
  return o;
}

/** The array literal s[start..end) as data. */
function arrayOf(s, start, end) {
  const a = [];
  const stop = Math.max(start + 1, end - 1);
  for (let i = start + 1; i < stop; ) {
    i = skipSpace(s, i);
    if (i >= stop) break;
    if (s[i] === ",") {
      i++;
      continue;
    }
    const spread = s.startsWith("...", i);
    const from = spread ? i + 3 : i;
    const e = exprEnd(s, from, stop);
    a.push(spread ? new Code(s.slice(from, e).trim()) : valueOf(s.slice(from, e)));
    i = Math.max(e, i + 1);
  }
  return a;
}

/** The object literal that starts at t[at] (which is "{"), or null. */
const objectAt = (t, at) => (t[at] === "{" ? objectOf(t, at, closeOf(t, at)) : null);

/** A tag's attributes, names lowercased: `<script src="x" data-mode=guard defer>` -> { src: "x", "data-mode": "guard", defer: "" }. */
function attrsOf(tag) {
  const a = {};
  const body = tag.replace(/^<[\w:-]+/, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) a[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return a;
}

// the runtime's own reading of the meta tag and data-* attributes (src/cdn/config.ts parsePairs and fromPairs)
const isOff = (v) => v === "false" || v === "0" || v === "off" || v === "no" || v === "none";
const isOn = (v) => v === "" || v === "true" || v === "1" || v === "on" || v === "yes";
const normKey = (k) => k.trim().toLowerCase().replace(/[-_\s]/g, "");
const isAbsolute = (u) => /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(String(u ?? "").trim());

/** `"mode=observe, telemetry=off"` -> { mode: "observe", telemetry: "off" } (keys normalised). */
function parsePairs(s) {
  const o = {};
  for (const part of String(s ?? "").split(/[,;\s]+/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = normKey(eq < 0 ? part : part.slice(0, eq));
    if (k) o[k] = eq < 0 ? "" : part.slice(eq + 1).trim();
  }
  return o;
}

/**
 * Key/value pairs (meta content, data-* attributes) as options, the way the runtime takes them. `sameOrigin`: the
 * meta tag, where the runtime ignores a model, ONNX Runtime or webhook URL on another origin.
 */
function fromPairs(pairs, sameOrigin = false) {
  const o = {};
  const model = {};
  let modelOff = false;
  const url = (v) => (sameOrigin && isAbsolute(v) ? null : v);
  for (const [k, raw] of Object.entries(pairs)) {
    const v = String(raw ?? "").trim();
    const lv = v.toLowerCase();
    if (k === "mode" && MODES.includes(lv)) o.mode = lv;
    else if (k === "model") {
      if (isOff(lv)) modelOff = true;
      else if (!isOn(lv) && url(v)) model.baseUrl = v;
    } else if ((k === "modelurl" || k === "baseurl") && v && url(v)) model.baseUrl = v;
    else if ((k === "ort" || k === "ortwasmpaths") && v && url(v)) model.ortWasmPaths = v;
    else if (k === "telemetry" && isOff(lv)) o.telemetry = false;
    else if (k === "token" && v) o.token = v;
    else if (k === "sink" || k === "sinks") o.sinks = isOff(lv) ? [] : v.split(/[,+|\s]+/).filter((x) => x && !(sameOrigin && isAbsolute(webhookOf(x) ?? "")));
    else if (k === "analytics") o.analytics = !isOff(lv);
    else if (k === "consent" && (lv === "pending" || lv === "denied")) o.consent = lv;
    else if (k === "visual") o.visual = isOff(lv) ? false : lv === "local" ? "local" : lv === "fix" ? { on: true, fix: true } : true;
  }
  if (modelOff) o.model = false;
  else if (Object.keys(model).length) o.model = model;
  return o;
}

/** A sink name's webhook URL ("webhook:<url>", "webhook=<url>"), or null (src/cdn/sinks.ts webhookUrl). */
const webhookOf = (s) => /^\s*webhook\s*[:=]\s*(\S+)/i.exec(String(s))?.[1] ?? null;
const esc = (s) => s.replace(/[$\\]/g, "\\$&");

/**
 * GenClass's own option sources in one file's text (comments already out), each with its precedence (`rank`, lowest
 * first, as the zero-code entries merge them: the import's mode, the meta tag, the script tag, GENCLASS_CONFIG, the
 * integrations' options, GenClass.init). `unread` names the ones set by code.
 */
export function genclassRegions(t) {
  const regions = [];
  const unread = [];
  // the zero-code entry's import names the mode (/auto/guard, /auto/heal); any other runtime import names none
  for (const m of t.matchAll(/(["'`])@genclass\/runtime(\/[\w./-]*)?\1/g)) {
    const sub = m[2] ?? "";
    regions.push({ rank: 0, kind: "import", mode: /^\/auto\/(guard|heal)\b/.exec(sub)?.[1] ?? null, opts: {} });
  }
  for (const m of t.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    if ((a.name ?? "").toLowerCase() === "genclass") regions.push({ rank: 1, kind: "meta", opts: fromPairs(parsePairs(a.content), true) });
  }
  for (const m of t.matchAll(/<script\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    const src = a.src ?? "";
    if (!/genclass[^/"'\s]*\.global(?:\.min)?\.js|\/@genclass\/runtime(?:@[^/"'\s]*)?\/?(?:$|[?#])/.test(src)) continue;
    const pairs = {};
    for (const [k, v] of Object.entries(a)) if (k.startsWith("data-")) pairs[normKey(k.slice(5))] = v;
    regions.push({ rank: 2, kind: "script", opts: fromPairs(pairs), src, base: pairs.base || null });
  }
  for (const m of t.matchAll(/\bGENCLASS_CONFIG\s*=(?!=)\s*/g)) {
    const o = objectAt(t, m.index + m[0].length);
    if (o) regions.push({ rank: 3, kind: "config", opts: o });
    else unread.push("window.GENCLASS_CONFIG");
  }
  // @genclass/nuxt: the `genclass` key of nuxt.config, or the module's tuple; it reads mode, token and telemetry only
  if (/(["'`])@genclass\/nuxt\1/.test(t)) {
    const found = [];
    for (const m of t.matchAll(/(["'`])@genclass\/nuxt\1\s*,\s*(?=\{)/g)) found.push(objectAt(t, m.index + m[0].length));
    for (const m of t.matchAll(/(?:^|[\s,{])genclass\s*:\s*(?=\{)/g)) found.push(objectAt(t, m.index + m[0].length));
    for (const o of found.length ? found : [{}]) regions.push({ rank: 4, kind: "nuxt", opts: integration(o, ["observe", "guard"]) });
  }
  // @genclass/astro: the integration's call in astro.config (`import genclass from "@genclass/astro"`)
  const astro = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+(["'`])@genclass\/astro\2/.exec(t);
  if (astro) {
    for (const m of t.matchAll(new RegExp(`(?<![\\w$.])${esc(astro[1])}\\s*\\(\\s*`, "g"))) {
      const at = m.index + m[0].length;
      if (t[at] === "{") regions.push({ rank: 4, kind: "astro", opts: integration(objectAt(t, at), ["observe", "guard"]) });
      else if (t[at] === ")") regions.push({ rank: 4, kind: "astro", opts: {} });
      else unread.push("the options passed to the Astro integration");
    }
  }
  for (const m of t.matchAll(/\bGenClass\s*\??\.\s*init\s*\(\s*/g)) {
    const at = m.index + m[0].length;
    if (t[at] === "{") regions.push({ rank: 5, kind: "init", opts: objectAt(t, at) });
    else if (t[at] === ")") regions.push({ rank: 5, kind: "init", opts: {} });
    else {
      // GenClass.init(options): the object the same file declares under that name
      const id = /^[A-Za-z_$][\w$]*/.exec(t.slice(at))?.[0];
      const decl = id && new RegExp(`\\b(?:const|let|var)\\s+${esc(id)}\\s*(?::[^=;]+)?=\\s*(?=\\{)`).exec(t);
      if (decl) regions.push({ rank: 5, kind: "init", opts: objectAt(t, decl.index + decl[0].length) });
      else unread.push("the options passed to GenClass.init(...)");
    }
  }
  return { regions, unread };
}

/** The options an integration passes on (mode, token, telemetry); its other keys never reach the runtime. */
function integration(o, modes) {
  const r = {};
  if (!isObj(o)) return r;
  if (o.mode instanceof Code || modes.includes(o.mode)) r.mode = o.mode;
  if (o.token !== undefined) r.token = o.token;
  if (o.telemetry === false || o.telemetry instanceof Code) r.telemetry = o.telemetry;
  return r;
}

/** Later wins; two `model` objects are merged (the runtime's mergeConfig). */
function mergeOptions(sources) {
  const o = Object.create(null);
  for (const x of sources) {
    if (!isObj(x)) continue;
    for (const [k, v] of Object.entries(x)) {
      if (v === undefined) continue;
      o[k] = k === "model" && isObj(v) && isObj(o[k]) ? { ...o[k], ...v } : v;
    }
  }
  return o;
}

const hostOf = (u) => {
  try {
    const h = new URL(String(u).trim(), "https://site.invalid").host;
    return h && h !== "site.invalid" ? h : null;
  } catch {
    return null;
  }
};
/** Where a URL option points: { at: "self" } for a path on the site, { at: "other", host } for another origin. */
const whereOf = (u) => (isAbsolute(u) ? { at: "other", host: hostOf(u) } : { at: "self", host: null });

/** The setup the regions describe (see readSetupText for the fields). `t` is the files' text, comments out. */
function setupFrom(regions, unreadIn, t) {
  const unread = [...unreadIn];
  const code = (name, v) => {
    if (v instanceof Code) unread.push(name);
    return v instanceof Code;
  };
  const ranked = [...regions].sort((a, b) => a.rank - b.rank);
  const o = mergeOptions(ranked.map((r) => r.opts));
  for (const r of ranked) if (r.opts?.[SPREAD]) unread.push(`options spread in from code (...${r.opts[SPREAD][0].src})`);
  // the mode: the import names it (the strongest of them), a mode option wins over it
  const imported = ranked.filter((r) => r.kind === "import").map((r) => r.mode ?? "observe");
  let mode = imported.includes("heal") ? "heal" : imported.includes("guard") ? "guard" : "observe";
  if (MODES.includes(o.mode)) mode = o.mode;
  else code("mode", o.mode);
  // diagnostics: off, to genclass.dev, or to the app's own collector (telemetry.endpoint)
  let telemetry = "on";
  let endpoint = null;
  let situation = false;
  const tel = o.telemetry;
  if (tel === false) telemetry = "off";
  else if (isObj(tel)) {
    if (typeof tel.endpoint === "string" && tel.endpoint.trim()) {
      telemetry = "own";
      endpoint = isAbsolute(tel.endpoint) ? hostOf(tel.endpoint) : null;
    } else if (code("telemetry.endpoint", tel.endpoint)) telemetry = "own";
    if (isObj(tel.include)) situation = tel.include.situation === true;
    else code("telemetry.include", tel.include);
  } else code("telemetry", tel);
  if (telemetry === "off") situation = false;
  const analytics = o.analytics === true || isObj(o.analytics);
  code("analytics", o.analytics);
  // the visual checks: "local" by default; on (true or { on: true }), with fixes (fix: true or a list), or off
  const vis = o.visual;
  const visOn = vis === true || (isObj(vis) && vis.on === true);
  const visFix = isObj(vis) && vis.on === true && (vis.fix === true || (Array.isArray(vis.fix) && vis.fix.length > 0));
  const visual = visOn ? (visFix ? "on, with fixes" : "on") : vis === false || (isObj(vis) && vis.on === false) ? "off" : "local";
  // the model's files (model.baseUrl) and ONNX Runtime's wasm (model.ortWasmPaths): jsDelivr unless set
  let model = "cdn";
  let modelHost = null;
  let ort = "cdn";
  let ortHost = null;
  if (o.model === false) {
    model = "off";
    ort = null;
  } else if (isObj(o.model)) {
    if (typeof o.model.baseUrl === "string" && o.model.baseUrl.trim()) {
      const w = whereOf(o.model.baseUrl);
      model = w.at;
      modelHost = w.host;
    } else code("model.baseUrl", o.model.baseUrl);
    if (typeof o.model.ortWasmPaths === "string" && o.model.ortWasmPaths.trim()) {
      const w = whereOf(o.model.ortWasmPaths);
      ort = w.at;
      ortHost = w.host;
    } else code("model.ortWasmPaths", o.model.ortWasmPaths);
  } else code("model", o.model);
  // learned state, as runtime.ts decides it: nothing by default; flows in localStorage with learn.expectations
  // (opt-in) or learn.persist true / "local"; in sessionStorage with persist "session"; nothing with persist false
  let learn = "none";
  let learnKey = "genclass:learn";
  if (isObj(o.learn)) {
    const p = o.learn.persist;
    if (p === false) learn = "none";
    else if (p === "session") learn = "session";
    else if (p === true || p === "local") learn = "local";
    else if (code("learn.persist", p)) learn = "local";
    else learn = o.learn.expectations === true ? "local" : "none";
    if (typeof o.learn.key === "string" && o.learn.key) learnKey = o.learn.key;
  } else code("learn", o.learn);
  // the safety breaker (guard and heal): its trip in sessionStorage, in memory with persist: false, none with false
  const breaker = o.breaker === false ? "off" : isObj(o.breaker) && o.breaker.persist === false ? "memory" : "session";
  code("breaker", o.breaker);
  // the top-level sample option (act/observe per session, frozen in sessionStorage); telemetry.sample stores nothing
  const sampled = typeof o.sample === "number" && o.sample > 0 && o.sample < 1;
  code("sample", o.sample);
  // sinks: "webhook:<url>" names, the webhook() adapter (here or in this file's code), others set up in code
  const urls = [];
  let sinkCode = 0;
  const named = Array.isArray(o.sinks) ? o.sinks : [];
  if (o.sinks instanceof Code) sinkCode++;
  const calls = [];
  if (/(["'`])@genclass\/runtime\/sinks(?:\/webhook)?\1/.test(t))
    for (const m of t.matchAll(/\bwebhook\s*\(\s*(?=\{)/g)) {
      const u = objectAt(t, m.index + m[0].length)?.url;
      if (typeof u === "string") calls.push(u);
    }
  for (const x of named) {
    if (typeof x === "string") {
      const u = webhookOf(x);
      if (u) urls.push(u);
    } else if (x instanceof Code) {
      const u = /\bwebhook\s*\(/.test(x.src) ? objectAt(x.src, x.src.indexOf("{"))?.url : undefined;
      if (typeof u === "string") urls.push(u);
      else if (!(calls.length && /^[A-Za-z_$][\w$]*$/.test(x.src))) sinkCode++;
    } else sinkCode++;
  }
  // an identifier in `sinks` that names a webhook() call of the same files: that call's URL
  if (named.some((x) => x instanceof Code && /^[A-Za-z_$][\w$]*$/.test(x.src))) urls.push(...calls);
  const sinks = [];
  const sinkPaths = [];
  for (const u of urls) {
    if (isAbsolute(u)) {
      const h = hostOf(u);
      if (h) sinks.push(h);
    } else sinkPaths.push(u.startsWith("/") ? u : `/${u}`);
  }
  // the consent gate (the runtime's InitOptions.consent): "pending", "denied", "granted" or an object of parts (the
  // parts it leaves out are pending); consentParts says each part's state at start
  let consent = null;
  let consentParts = null;
  const cv = o.consent;
  if (typeof cv === "string" || typeof cv === "boolean") {
    const st = cv === true || cv === "granted" ? "granted" : cv === false || cv === "denied" ? "denied" : "pending";
    consentParts = Object.fromEntries(PARTS.map((p) => [p, st]));
  } else if (isObj(cv)) {
    consentParts = Object.fromEntries(PARTS.map((p) => [p, cv[p] === true ? "granted" : cv[p] === false ? "denied" : "pending"]));
    for (const p of PARTS) code(`consent.${p}`, cv[p]);
  } else code("consent", cv);
  if (consentParts) {
    const st = PARTS.map((p) => consentParts[p]);
    consent = st.includes("pending") ? "pending" : st.includes("denied") ? "denied" : "granted";
  }
  // the script tag: where the browser gets GenClass from (a CDN, another host, or the site itself)
  const tag = ranked.find((r) => r.kind === "script");
  const script = tag
    ? {
        host: isAbsolute(tag.src) ? hostOf(tag.src) : null,
        version: /@genclass\/runtime@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\//.exec(tag.src)?.[1] ?? null,
        base: tag.base,
        baseHost: tag.base && isAbsolute(tag.base) ? hostOf(tag.base) : null,
      }
    : null;
  return {
    mode,
    telemetry,
    endpoint,
    analytics,
    situation,
    visual,
    model,
    modelHost,
    ort,
    ortHost,
    learn,
    learnKey,
    breaker,
    sampled,
    sinks: [...new Set(sinks)],
    sinkPaths: [...new Set(sinkPaths)],
    sinkCode,
    agentLink: /\bconnectAgent\s*\(/.test(t),
    consent,
    consentParts,
    // where the visitor's choice is passed on (a consent banner's callback): GenClass.consent(...) or rt.consent(...)
    consentCall: /\b(?:GenClass|runtime|rt|genclass)\s*\??\.\s*consent\s*\(/.test(t),
    script,
    tokenInOptions: typeof o.token === "string" && o.token !== "",
    unread: [...new Set(unread)],
  };
}

/**
 * The options that decide what is sent and kept, read from text (not executed): GenClass's own places in it (see the
 * module header), comments out. Text with none of them is read as the inside of an options object
 * (`telemetry: false, model: false`).
 */
export function readSetupText(text) {
  const t = stripComments(text);
  let { regions, unread } = genclassRegions(t);
  if (!regions.length && t.trim()) regions = [{ rank: 3, kind: "text", opts: objectOf(`{${t}}`, 0, t.length + 2) }];
  return setupFrom(regions, unread, t);
}

/**
 * The @genclass/runtime the project runs, and whether it has the consent gate: true, false, or null (not known). A
 * script tag from a CDN runs the version in its URL; otherwise the installed package (node_modules, here or above),
 * whose dist/ has the consent chunk when it has the gate.
 */
export function runtimeOf(dir, script) {
  const older = (v) => compareVersions(v, LAST_WITHOUT_CONSENT) !== null && compareVersions(v, LAST_WITHOUT_CONSENT) <= 0;
  if (script?.host) return { version: script.version, consent: script.version && older(script.version) ? false : null, source: "script tag" };
  for (let d = resolve(dir); ; d = dirname(d)) {
    const pkg = join(d, "node_modules", "@genclass", "runtime");
    let version = null;
    try {
      version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
    } catch {
      /* not here */
    }
    if (typeof version === "string") {
      let consent = null;
      try {
        const files = readdirSync(join(pkg, "dist"));
        consent = files.some((n) => /^consent-[\w-]+\.js$/.test(n)) || /\bConsentChoices\b/.test(readFileSync(join(pkg, "dist", "index.d.ts"), "utf8"));
      } catch {
        /* not built, or no types: the version decides */
      }
      if (consent !== true && older(version)) consent = false;
      return { version, consent, source: "node_modules" };
    }
    if (dirname(d) === d) return { version: null, consent: null, source: null };
  }
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
/** Where a self-hosted model goes: the folder the framework serves as-is (the runtime CLI's init.mjs publicDir). */
const publicDirOf = (p) =>
  p?.framework === "sveltekit" ? "static" : p?.framework === "angular" && p.dir && isDir(join(p.dir, "src", "assets")) && !isDir(join(p.dir, "public")) ? "src/assets" : "public";

/**
 * The project's setup: where GenClass is added, the options found, the app's token (whether it reports to a
 * dashboard), the runtime it runs (and whether that has the consent gate). `deps.inspect` is the runtime CLI's
 * inspectProject, `deps.runtime` stands in for runtimeOf (tests pass their own).
 */
export async function readSetup(o = {}, deps = {}) {
  const inspect = deps.inspect ?? (await import("../../runtime/bin/lib/init.mjs")).inspectProject;
  const st = inspect({ cwd: o.cwd });
  const cwd = st.cwd ?? resolve(o.cwd ?? ".");
  const files = [...new Set([...(st.marked ?? []), ...(st.files ?? [])])];
  const used = [];
  const regions = [];
  const unread = [];
  let text = "";
  for (const f of files) {
    // a test, its setup or a fixture does not ship to visitors: only the app's own files say what they run
    const rel = relative(cwd, f).split(sep).join("/");
    if (isTestFile(rel)) continue;
    let raw;
    try {
      raw = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (!REF.test(raw)) continue;
    // a file that names GenClass only in a comment does not set it up
    const t = stripComments(raw);
    if (!REF.test(t)) continue;
    used.push(rel || f);
    const r = genclassRegions(t);
    regions.push(...r.regions);
    unread.push(...r.unread);
    text += `\n${t}`;
    if (used.length >= 20) break;
  }
  const setup = setupFrom(regions, unread, text);
  const rt = deps.runtime ?? runtimeOf(st.project?.dir ?? cwd, setup.script);
  return {
    cwd,
    app: st.project?.name ?? null,
    framework: st.project?.label || null,
    installed: used.length > 0,
    files: used,
    ...setup,
    token: !!st.token || setup.tokenInOptions,
    runtimeVersion: rt.version ?? null,
    consentSupported: rt.consent ?? null,
    runtimeSource: rt.source ?? null,
    publicDir: publicDirOf(st.project),
  };
}

// ------------------------------------------------------------------------------------------------------ the map

const PART_NAME = { diagnostics: "diagnostics", analytics: "analytics", storage: "storage", model: "the model" };
const list = (xs) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * What the setup means, as rows of plain sentences: what leaves the visitor's browser and where it goes, what stays on
 * their device, the opt-outs, the guidance per region, the lines that make it send and keep nothing, and the
 * Content-Security-Policy it needs. Pure.
 */
export function dataMap(s) {
  const sent = [];
  const kept = [];
  const sinkPaths = s.sinkPaths ?? [];
  const sinkCount = s.sinks.length + sinkPaths.length + (s.sinkCode ?? 0);
  // the consent gate: each part's state at start. A runtime without the gate (consentSupported false) ignores the
  // option, so every part runs as without it; undefined means not checked (text only), null not known
  const support = s.consentSupported;
  const ignored = !!s.consent && support === false;
  const state = (p) => (!s.consent || ignored ? "granted" : s.consentParts?.[p] ?? s.consent);
  const held = (p) => state(p) !== "granted";
  const uniform = !s.consentParts || PARTS.every((p) => s.consentParts[p] === s.consentParts.diagnostics);
  const after = (...ps) => {
    const h = ps.filter(held);
    if (!h.length) return "";
    const how = uniform ? `consent: "${s.consent}" holds it` : state(h[0]) === "denied" ? "the consent option denies it at start" : "the consent option leaves it pending";
    return ` Only after the visitor grants ${list(h.map((p) => PART_NAME[p]))} (${how} until GenClass.consent(...) grants it).`;
  };
  const rtName = `@genclass/runtime${s.runtimeVersion ? ` ${s.runtimeVersion}` : ""}${s.runtimeSource === "script tag" ? " (the script tag's version)" : ""}`;
  const script = s.script?.host ? s.script : null;

  if (script)
    sent.push({
      to: `${script.host} (${/(?:^|\.)jsdelivr\.net$|^unpkg\.com$/.test(script.host) ? "a public CDN" : "another host"} serving GenClass's script tag)`,
      what: `Nothing about the visitor: the browser downloads GenClass's script from it on every page load${script.base ? `; the parts it loads later come from ${script.baseHost ?? "your own site"} (data-base)` : ", and the parts it loads later from the same place (the model's worker and ONNX Runtime's code, the devtools overlay, the visual checks, named sinks, analytics)"}, so it receives the visitor's IP address and user agent, as any CDN does.`,
      why: `To run GenClass on the page.${s.consent && !ignored ? " The consent gate cannot hold it: the tag loads before GenClass runs." : ""}`,
      keep: `${script.host}'s own logs.`,
      gate: false,
    });
  if (s.telemetry === "on") {
    sent.push({
      to: "genclass.dev (GenClass's collector, a Cloudflare Worker; stored in Cloudflare R2)",
      what: `Diagnostics about GenClass's own decisions: the site's hostname, the page route with ids replaced (no query or fragment), the mode, each decision's kind, confidence and outcome, counts and timings, a random id that is new on every page load, and the device class (CPU cores, memory, GPU, connection type). The collector adds the visitor's country from the request and stores no IP address, user agent, cookie or header.${s.situation ? " Situation text is on (include: { situation: true }): it can hold query strings, the page title, error messages, the first 40 characters typed into ordinary inputs and short state values, after the redactor." : " No page text."}${s.visual === "on" || s.visual === "on, with fixes" ? " With the visual checks on: counts per check and page, never selectors, text, colours or URLs." : ""}`,
      why: `Model evaluation and training by GenClass's maintainers${s.token ? ", and this app's dashboard. For an app in a genclass.dev account, also what its owner turns on there: an export of its stored batches, and forwarding of each likely detection (problem type, confidence, trigger, page route, versions, time; never page text) to the services chosen (Sentry, PostHog, Datadog, Slack or a webhook). On a paid plan, genclass ask and the email reports pass the dashboard's numbers (page paths, problem kinds, counts) to OpenAI's API (PRIVACY.md)" : ""}.${after("diagnostics")}`,
      keep: "90 days (1 year for an app on a plan with a year of history).",
    });
    if (s.analytics && s.token) {
      sent.push({
        to: "genclass.dev, for this app's dashboard only (never used for training)",
        what: "Interaction analytics: per page view the route, engaged time, scroll milestones, clicks, rage and dead clicks per element (named from markup, never its text); per visit a random visit id, the referring host and utm values, device class, browser and OS families, and whether the browser visited before.",
        why: `This app's visitor analytics.${after("analytics", "diagnostics")}`,
        keep: "90 days.",
      });
    }
  } else if (s.telemetry === "own") {
    sent.push({
      to: `${s.endpoint ?? "your own endpoint"} (your own collector: telemetry.endpoint)`,
      what: `The same diagnostics batches GenClass's collector would get${s.analytics ? ", and the interaction analytics" : ""}. Nothing reaches genclass.dev.`,
      why: `Whatever your collector does with them.${after("diagnostics")}`,
      keep: "As your collector keeps them.",
    });
  }
  // the model's files (model.baseUrl) and ONNX Runtime's wasm (ortWasmPaths) each come from jsDelivr unless set
  const filesHost = s.model === "cdn" ? JSDELIVR : s.model === "other" ? s.modelHost : null;
  const ortHost = s.model === "off" ? null : (s.ort ?? "cdn") === "cdn" ? JSDELIVR : s.ort === "other" ? s.ortHost : null;
  const modelHosts = [...new Set([filesHost, ortHost].filter(Boolean))];
  for (const h of modelHosts) {
    const both = h === filesHost && h === ortHost;
    const what = both ? "the model files and ONNX Runtime's wasm" : h === filesHost ? "the model files" : "ONNX Runtime's wasm";
    sent.push({
      to: h === JSDELIVR ? `${JSDELIVR} (a public CDN)` : `${h} (${both ? "model.baseUrl and ortWasmPaths" : h === filesHost ? "model.baseUrl" : "model.ortWasmPaths"})`,
      what: `Nothing about the visitor: the browser downloads ${what} from it${h === JSDELIVR && !both && h === ortHost ? " (no model.ortWasmPaths is set, so the wasm comes from jsDelivr even with the model files elsewhere)" : ""}, so it receives the visitor's IP address and user agent, as any CDN does.`,
      why: `To run the on-device model.${after("model")}`,
      keep: h === JSDELIVR ? "jsDelivr's own logs." : "That host's logs.",
    });
  }
  const sinkNote = `Telemetry opt-outs and GPC do not turn sinks off${s.consent && !ignored ? ", and neither does the consent gate: sinks are your configuration, so hold them yourself" : ""}.`;
  const sinkWhat = `Each finding's route, diagnosis and action, with the redacted evidence text by default (it can hold short fragments of what users typed). ${sinkNote}`;
  for (const h of s.sinks) sent.push({ to: `${h} (a webhook sink)`, what: sinkWhat, why: "Your own alerting.", keep: "As that endpoint keeps it.", gate: false, sink: true });
  for (const p of sinkPaths) sent.push({ to: `your own site, ${p} (a webhook sink)`, what: sinkWhat, why: "Your own alerting.", keep: "As your site keeps it.", gate: false, sink: true, own: true });
  if (s.sinkCode) sent.push({ to: "a sink set up in code (its recipient is not read from the files)", what: `Whatever that sink does with each finding's record (route, diagnosis, action, redacted evidence). ${sinkNote}`, why: "Your own sink.", keep: "As its recipient keeps it.", gate: false, sink: true });
  if (s.agentLink) sent.push({ to: "127.0.0.1 on the developer's machine (the coding-agent link)", what: "Development builds only, on development hosts: the recording goes to GenClass's MCP server on the same machine. Inert on any page not served from the developer's machine.", why: "Debugging with a coding agent.", keep: "On the developer's machine.", gate: false, dev: true });

  const lk = s.learnKey ?? "genclass:learn";
  if (s.learn === "local") kept.push({ part: "storage", short: "learned flows in localStorage", where: `localStorage (${lk}) and sessionStorage (${lk}:session)`, what: `Learned flows behind GenClass's expectation reports: request signatures, routes, field names, hashed action labels, counts and timings; never element text or values. The sessionStorage entry holds the tab's session number. It never leaves the browser.${after("storage")}`, off: "learn: { persist: false }" });
  else if (s.learn === "session") kept.push({ part: "storage", short: "learned flows in sessionStorage", where: `sessionStorage (${lk})`, what: `Learned flows and transition profiles for the tab's session, never element text or values. It never leaves the browser.${after("storage")}`, off: "learn: { persist: false }" });
  if (s.mode !== "observe" && (s.breaker ?? "session") === "session") kept.push({ part: "storage", short: "the safety breaker's state in sessionStorage", where: "sessionStorage (genclass:breaker)", what: `Only after GenClass's safety breaker trips in ${s.mode} mode: when and why it stopped acting, so the tab stays downgraded for its session. Never page data.${after("storage")}`, off: "breaker: { persist: false } (kept in memory only)" });
  if (s.sampled) kept.push({ part: "storage", short: "the session's act or observe bucket in sessionStorage", where: "sessionStorage (genclass:bucket)", what: `Whether this tab's session is one that may act or only observes (the sample option), drawn once per session.${after("storage")}`, off: "no sample option (every session acts the same)" });
  if (s.analytics && (s.token || s.telemetry === "own")) kept.push({ part: "analytics", short: "an analytics visit id in localStorage", where: "localStorage (genclass.analytics.*)", what: `One entry with no expiry: a random visit id, the time of the last page view or event, and a flag that the browser visited before. A page view more than 30 minutes after that time, or a visit from another site or a campaign link, replaces the id; runtime.analytics.stop() removes the entry.${after("analytics", "diagnostics")}`, off: "analytics: false" });
  if (s.model !== "off") kept.push({ part: "model", short: "the model's files in Cache Storage", where: "Cache Storage", what: `The model's files and ONNX Runtime's wasm (cache "genclass-runtime-v1"), so they are not downloaded again.${after("model")}`, off: "model: false (no model: GenClass then only observes without a diagnosis)" });
  for (const x of kept) x.held = held(x.part);

  // what the opt-outs stop: diagnostics and analytics (TELEMETRY.md "Opting out"), nothing else
  const still = [];
  if (sinkCount) still.push("webhook sinks still post findings");
  if (modelHosts.length) still.push(`the model still downloads from ${list(modelHosts)}`);
  if (script) still.push(`the script still loads from ${script.host}`);
  if (kept.some((x) => x.part === "storage")) still.push("GenClass's own storage entries are still kept");
  const optOuts = [
    `Global Privacy Control (navigator.globalPrivacyControl): no diagnostics or analytics are sent from that browser${still.length ? ` (it stops nothing else: ${still.join("; ")})` : ""}`,
    "?genclass=no-telemetry in the address: no diagnostics or analytics for one page load (?genclass=off turns GenClass off)",
    'localStorage "genclass.telemetry" = "off": no diagnostics or analytics, per browser and site',
  ];

  const sendsToGenClass = s.telemetry === "on";
  const notKnown = support === null && !!s.consent ? `Whether ${s.runtimeVersion ? `this project's ${rtName}` : "the runtime this project ships"} has the consent gate could not be told from its files: 0.3.0-beta.6 and earlier ignore the option, so check the release you ship before relying on it.` : null;
  const gateUnknown = support === null ? ' (consent: "pending" needs a runtime with the consent gate: 0.3.0-beta.6 and earlier ignore it)' : "";
  const eu = [];
  if (ignored)
    eu.push(`consent: "${s.consent}" is set, but this project's ${rtName} has no consent gate: it ignores the option, so everything listed here starts with the page, and GenClass.consent is not a function there${s.consentCall ? " (your banner's call to it throws)" : ""}. Until the project runs a release with the gate, start GenClass with telemetry: false where consent is needed (TELEMETRY.md), and serve the model from your own site.`);
  else if (s.consent === "pending" || (s.consent && !uniform)) {
    const named = (st) => PARTS.filter((p) => state(p) === st).map((p) => PART_NAME[p]);
    const waiting = PARTS.filter(held).map((p) => PART_NAME[p]);
    const before = uniform
      ? 'GenClass waits for consent (consent: "pending"): before the visitor answers it sends nothing, stores nothing on the device (of its own storage it only reads its off switch, localStorage "genclass") and downloads no model'
      : `GenClass waits for consent per part (the consent option: ${[["granted", named("granted")], ["denied", named("denied")], ["pending", named("pending")]].filter(([, xs]) => xs.length).map(([st, xs]) => `${list(xs)} ${st}`).join(", ")} at start): ${list(waiting)} ${waiting.length > 1 ? "are" : "is"} not sent, stored or downloaded until GenClass.consent(...) grants ${waiting.length > 1 ? "them" : "it"}`;
    const extra = [
      sinkCount ? " Your webhook sinks are not gated: hold them yourself." : "",
      script ? ` GenClass's script itself, and the parts it loads that the gate does not hold (the devtools overlay, the visual checks, sink adapters), still come from ${script.host}.` : "",
      s.agentLink ? " The coding-agent link still runs in development builds (to the developer's own machine)." : "",
    ].join("");
    eu.push(`${before}; afterwards only what they granted runs, and a later denial withdraws it. Pass the choice from your consent banner with ${CONSENT_CALL} (recipes for Google Consent Mode v2 and IAB TCF: ${CONSENT_DOC}). Every telemetry opt-out, Global Privacy Control included, still wins over a grant of diagnostics or analytics.${extra}`);
    if (!s.consentCall) eu.push(`No call to GenClass.consent(...) was found in the project's GenClass files. Until your consent banner makes one, ${list(waiting)} never start${held("diagnostics") ? " (and the dashboard stays empty)" : ""}.`);
    if (notKnown) eu.push(notKnown);
    if (held("model") && modelHosts.length) eu.push(`Once the visitor grants the model, it comes from ${list(modelHosts)}, which receives their IP address: name ${modelHosts.length > 1 ? "them" : "it"} as a recipient, or serve the model and ONNX Runtime's wasm from your own site.`);
  } else if (s.consent === "denied") {
    eu.push(`GenClass starts with consent: "denied": it sends, stores and downloads nothing of its own unless your code grants a part with GenClass.consent(...).${sinkCount ? " Your webhook sinks are not gated: hold them yourself." : ""}${script ? ` GenClass's script itself, and the parts it loads that the gate does not hold, still come from ${script.host}.` : ""}`);
    if (notKnown) eu.push(notKnown);
  } else if (s.consent === "granted") {
    eu.push('consent: "granted" grants every part at start: everything listed runs, a moment after the page starts, and GenClass.consent(false) withdraws it later. Grant only what the visitor agreed to.');
    if (notKnown) eu.push(notKnown);
  } else if (sendsToGenClass)
    eu.push(
      support === false
        ? `Telemetry is on: the runtime reads facts from the visitor's device and sends them to GenClass, which also uses them to improve its model. Regulators read ePrivacy Article 5(3) as covering scripts that send device information, not only cookies (EDPB Guidelines 2/2023), and the audience-measurement exemptions (CNIL, ICO) do not cover a recipient that reuses data for itself. The careful choice for EU, EEA and UK visitors is telemetry off: this project's ${rtName} has no consent gate (consent: "pending" needs a release with it).`
        : `Telemetry is on: the runtime reads facts from the visitor's device and sends them to GenClass, which also uses them to improve its model. Regulators read ePrivacy Article 5(3) as covering scripts that send device information, not only cookies (EDPB Guidelines 2/2023), and the audience-measurement exemptions (CNIL, ICO) do not cover a recipient that reuses data for itself. The careful choice for EU, EEA and UK visitors is consent: "pending" with your consent banner calling GenClass.consent(...), or telemetry off.${gateUnknown}`,
    );
  if (s.telemetry === "own" && !held("diagnostics")) eu.push(`Diagnostics go to your own collector (${s.endpoint ?? "telemetry.endpoint"}): the runtime reads facts from the visitor's device and sends them there, which regulators read as within ePrivacy Article 5(3) (EDPB Guidelines 2/2023). Get consent, or rely on an exemption you have checked, and name the collector's operator as a recipient if it is not you.`);
  if (s.analytics && (s.token || s.telemetry === "own") && !held("analytics")) eu.push("Analytics are on: they are not strictly necessary for the service, so start them off there and call runtime.analytics.start() after consent, unless you rely on an exemption you have checked.");
  if (!held("model") && modelHosts.includes(JSDELIVR)) eu.push(`${filesHost === JSDELIVR ? "The model" : "ONNX Runtime's wasm"} comes from jsDelivr, which receives visitors' IP addresses. A German court awarded damages over an IP address sent to a font CDN without consent (LG Munich I, 3 O 17493/20, 2022). Serving ${filesHost === JSDELIVR ? "the model" : "the wasm"} from your own site removes that recipient.`);
  for (const h of modelHosts.filter((x) => x !== JSDELIVR)) if (!held("model")) eu.push(`The model is downloaded from ${h}, which receives visitors' IP addresses: name it as a recipient, or serve the model from your own site.`);
  if (script) eu.push(`GenClass's script comes from ${script.host} on every page load, before GenClass runs (no consent option can hold it), so ${script.host} receives visitors' IP addresses: name it as a recipient, or serve the file from your own site.`);
  if (s.sinks.length || s.sinkCode) eu.push(`Your webhook sinks send findings (with redacted evidence that can hold short fragments of what visitors typed) to ${s.sinks.length ? list(s.sinks) : "the recipient your sink code names"}: name whoever runs ${s.sinks.length + (s.sinkCode ?? 0) > 1 ? "them" : "it"} as a recipient if it is not you, and hold sinks yourself where consent is needed.`);
  if (!eu.length && !sent.some((x) => !x.dev))
    eu.push("In this setup GenClass sends nothing from the visitor's browser and stores nothing beyond what is listed. Name it in your privacy policy as code that runs in the page; there is no recipient to disclose.");
  else if (!eu.length && !sent.some((x) => !x.dev && !x.own))
    eu.push("In this setup GenClass sends nothing from the visitor's browser to anyone but your own site (your webhook sink) and stores nothing beyond what is listed. Name it in your privacy policy as code that runs in the page; there is no other recipient to disclose.");
  // anything GenClass keeps on the device (learned flows, the breaker's state, the model's files in Cache Storage):
  // storing is in Article 5(3)'s scope as well as reading, even when nothing leaves the browser
  const stored = kept.filter((x) => !x.held);
  if (stored.length)
    eu.push(
      `GenClass stores ${list(stored.map((x) => x.short))} on the device (listed above). Storing is in Article 5(3)'s scope as well as reading, even when nothing leaves the browser; ${
        support === false
          ? `this project's ${rtName} has no consent gate, so where consent is needed start GenClass only after it, or turn these off`
          : s.consent
            ? "your consent option grants it at start: grant it only once the visitor has agreed"
            : `consent: "pending" holds all of it until the visitor agrees${gateUnknown ? " (on a runtime with the consent gate)" : ""}`
      }.`,
    );

  const us = [
    "Global Privacy Control turns GenClass's diagnostics and analytics off for every visitor, wherever they are. GenClass does not sell or share data for advertising.",
    sendsToGenClass ? "Under the CCPA, a vendor that receives personal information needs a service-provider contract; GenClass's data processing terms are not published yet, so if you need one before they are, use telemetry off." : "Nothing reaches GenClass, so there is no vendor to contract with for the runtime.",
    "Health, finance and children's sites: use telemetry off (TELEMETRY.md says the same). There is no business associate agreement for HIPAA.",
  ];

  const strict = [];
  // for sites that need consent: everything waits for the visitor, and what they grant still works afterwards; only
  // where the runtime can have the gate, and only for what the gate holds (not sinks, the script tag, the agent link)
  if (!s.consent && support !== false && (sent.some((x) => x.gate !== false) || kept.some((x) => x.where !== "Cache Storage")))
    strict.push([
      'consent: "pending"',
      `for sites that need consent (EU, EEA, UK): GenClass observes on the page and sends, stores and downloads nothing of its own until your consent banner calls ${CONSENT_CALL}; what the visitor grants then runs as described above${sinkCount ? " (your sinks are not gated)" : ""}${support === null ? ". It needs a runtime with the consent gate: 0.3.0-beta.6 and earlier ignore it" : ""}`,
      null,
    ]);
  if (s.telemetry === "on") strict.push(["telemetry: false", "nothing goes to genclass.dev (the dashboard stays empty)", "npx genclass init --no-telemetry"]);
  if (s.analytics) strict.push(["analytics: false", "no visitor analytics, and no visit id in localStorage", null]);
  if (modelHosts.length) strict.push(['model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" }', "the model and ONNX Runtime's wasm are served from your own site: no CDN sees your visitors for them", `npx @genclass/runtime@beta fetch-model ${s.publicDir ?? "public"}/genclass-model`]);
  if (s.learn !== "none") strict.push(["learn: { persist: false }", "no learned state is kept on the device", null]);
  if (s.situation) strict.push(["telemetry: { include: { situation: false } }", "no page text, even with telemetry on", null]);

  const csp = [];
  if (s.telemetry === "on") csp.push("connect-src https://genclass.dev");
  if (s.telemetry === "own" && s.endpoint) csp.push(`connect-src https://${s.endpoint}`);
  for (const h of modelHosts) csp.push(`connect-src https://${h}`);
  if (s.model !== "off") csp.push("script-src 'wasm-unsafe-eval'", "worker-src 'self' (blob: for the script tag)");
  for (const h of s.sinks) csp.push(`connect-src https://${h}`);
  if (script) csp.push(`script-src https://${script.host}`);
  if (script?.baseHost && script.baseHost !== script.host) csp.push(`script-src https://${script.baseHost}`);

  return { sent, kept, optOuts, eu, us, strict, csp };
}

/** The data map as Markdown, for a privacy policy, a record of processing or a vendor questionnaire. */
export function markdown(s, m, today = new Date().toISOString().slice(0, 10)) {
  const L = [];
  L.push(`# GenClass in ${s.app ?? "this app"}: what it sends and keeps`, "");
  L.push(`Generated by \`genclass privacy\` on ${today} from the project's files (${s.files.length ? s.files.map((f) => `\`${f}\``).join(", ") : "none found"}). Not legal advice.`, "");
  L.push("## Setup", "");
  L.push(`| | |`, `|---|---|`);
  for (const [k, v] of setupRows(s, m)) L.push(`| ${k} | ${v} |`);
  L.push("", "## What leaves the visitor's browser", "");
  if (!m.sent.length) L.push("Nothing.", "");
  else {
    L.push("| Recipient | What | Why | Kept |", "|---|---|---|---|");
    for (const x of m.sent) L.push(`| ${x.to} | ${x.what} | ${x.why} | ${x.keep} |`);
    L.push("");
  }
  L.push(
    "Never in what GenClass sends, in any setting: typed values of password, payment, one-time-code or secret-named inputs, cookies, the app's request or response headers and bodies, storage contents. Every server the browser contacts (each recipient above) receives the visitor's IP address and user agent with the request itself; genclass.dev's collector uses the IP address only to limit request rates and for the country, and stores neither.",
    "",
  );
  L.push("## What stays on the visitor's device", "");
  if (!m.kept.length) L.push("Nothing.", "");
  else {
    L.push("| Where | What | Turn off |", "|---|---|---|");
    for (const x of m.kept) L.push(`| ${x.where} | ${x.what} | \`${x.off}\` |`);
    L.push("");
  }
  L.push("## Opt-outs GenClass honours", "", ...m.optOuts.map((x) => `- ${x}`), "");
  L.push("## EU, EEA and UK", "", ...m.eu.map((x) => `- ${x}`), "");
  L.push("## United States", "", ...m.us.map((x) => `- ${x}`), "");
  if (m.strict.length) {
    L.push("## To send and keep nothing", "", "Options for `GenClass.init()` or `window.GENCLASS_CONFIG` (the file `genclass init` wrote):", "");
    for (const [opt, what, cmd] of m.strict) L.push(`- \`${opt}\`: ${what}${cmd ? ` (\`${cmd}\`)` : ""}`);
    L.push("");
  }
  if (m.csp.length) L.push("## Content-Security-Policy", "", ...m.csp.map((x) => `- \`${x}\``), "");
  L.push("## Sources", "", `- What is sent, field by field: ${TELEMETRY_DOC}`, `- Consent (consent: "pending", GenClass.consent): ${CONSENT_DOC}`, `- GenClass's privacy policy: ${PRIVACY_DOC}`, `- Content-Security-Policy and self-hosting: ${CSP_DOC}`, "");
  return L.join("\n");
}

function setupRows(s, m = dataMap(s)) {
  const ortWhere = s.ort === "self" ? "your own site" : s.ort === "other" ? s.ortHost : JSDELIVR;
  const filesWhere = s.model === "cdn" ? JSDELIVR : s.model === "self" ? "your own site" : s.modelHost;
  const rtName = `@genclass/runtime${s.runtimeVersion ? ` ${s.runtimeVersion}` : ""}`;
  const rows = [
    ["GenClass", s.installed ? `added (${s.files.slice(0, 3).join(", ")}${s.files.length > 3 ? ", ..." : ""})` : "not found in the project's files"],
    ["Mode", s.mode === "observe" ? "observe: reports only, changes nothing" : `${s.mode}: may change how the page handles responses`],
  ];
  if (s.script) rows.push(["Script tag", s.script.host ? `from ${s.script.host}${s.script.version ? ` (@genclass/runtime ${s.script.version})` : ""}` : "from your own site"]);
  rows.push(
    ["Diagnostics", s.telemetry === "off" ? "off" : s.telemetry === "own" ? `to your own collector (${s.endpoint ?? "telemetry.endpoint"})` : "on (the default), to genclass.dev"],
    ["Dashboard", s.token ? "this app's key is set: diagnostics also fill its dashboard" : "no app key"],
    ["Page text", s.situation ? "on (include: { situation: true })" : "off (the default)"],
    ["Analytics", s.analytics ? (s.token || s.telemetry === "own" ? "on" : "asked for, but they need the app's key or your own endpoint") : "off (the default)"],
    ["Visual checks", s.visual === "local" ? "on localhost only (the default)" : s.visual],
    [
      "Model",
      s.model === "off"
        ? "off"
        : `${s.model === "cdn" ? `from ${JSDELIVR} (the default)` : `from ${filesWhere}`}${ortWhere !== filesWhere ? `; ONNX Runtime's wasm from ${ortWhere}${(s.ort ?? "cdn") === "cdn" ? " (no model.ortWasmPaths)" : ""}` : ""}`,
    ],
    ["Stored on the device", m.kept.length ? m.kept.map((x) => `${x.short}${x.held ? " (after consent)" : ""}`).join(", ") : "nothing"],
    ["Consent", consentRow(s, rtName)],
  );
  if (s.unread?.length) rows.push(["Not read", `${list(s.unread)}: set by code, so this map shows what the files say without them`]);
  return rows;
}

/** The Setup table's Consent row: the gate as set, whether the runtime here can honour it, and what it never holds. */
function consentRow(s, rtName) {
  if (!s.consent) return "no consent gate (the default): what is listed starts with the page";
  if (s.consentSupported === false) return `set (consent: "${s.consent}"), but ${rtName} here has no consent gate and ignores it: what is listed starts with the page`;
  const parts = s.consentParts;
  const uniform = !parts || PARTS.every((p) => parts[p] === parts.diagnostics);
  let row;
  if (!uniform) row = `per part (the consent option): ${PARTS.map((p) => `${PART_NAME[p]} ${parts[p]}`).join(", ")} at start; what is not granted waits for GenClass.consent(...)`;
  else if (s.consent === "pending") row = 'waits for the visitor (consent: "pending"): nothing is sent, stored or downloaded until GenClass.consent(...) grants it';
  else if (s.consent === "denied") row = 'denied at start (consent: "denied"): nothing runs until your code grants a part';
  else row = 'granted at start (consent: "granted"): what is listed starts a moment after the page';
  const waits = s.consent !== "granted";
  if (waits && (s.sinks.length || s.sinkPaths?.length || s.sinkCode)) row += "; your webhook sinks still send";
  if (waits && s.script?.host) row += `; the script still loads from ${s.script.host}`;
  if (waits && !s.consentCall) row += "; no GenClass.consent(...) call found in these files";
  if (s.consentSupported === null) row += "; whether the runtime here has the gate is not known (0.3.0-beta.6 and earlier ignore it)";
  return row;
}

/**
 * `genclass privacy [--md] [--out file] [--json]`. Exit 0; 1 when GenClass is not in the project (the map is still
 * printed: it shows what the defaults would do).
 */
export async function privacy(o = {}, deps = {}) {
  const s = await readSetup(o, deps);
  const m = dataMap(s);
  if (o.json) {
    out(JSON.stringify({ ok: true, setup: s, ...m }, null, 2));
    return s.installed ? 0 : 1;
  }
  if (o.md || o.out) {
    const md = markdown(s, m, deps.today);
    if (o.out) {
      try {
        writeFileSync(resolve(o.out), md);
      } catch (e) {
        warn(`Could not write ${clean(o.out, 80)}: ${clean(e?.message ?? e, 120)}`);
        return 1;
      }
      good(`Wrote ${clean(o.out, 80)}: the data map as Markdown, for your privacy policy or a vendor questionnaire.`);
      return s.installed ? 0 : 1;
    }
    out(md);
    return s.installed ? 0 : 1;
  }
  header({ app: s.app, framework: s.framework });
  out();
  note("What GenClass sends from your visitors' browsers, and what it keeps there, read from this project's files. Not legal advice.");
  if (!s.installed) {
    out();
    warn("GenClass is not in this project's files yet. This is what the defaults do once it is added.");
  }
  out();
  const rows = setupRows(s, m);
  const wKey = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    const lines = wrap(v, width() - 6 - wKey);
    out(`  ${c.gray(k.padEnd(wKey))}  ${lines[0]}`);
    for (const l of lines.slice(1)) out(`  ${" ".repeat(wKey)}  ${l}`);
  }
  section("What leaves your visitors' browsers");
  if (!m.sent.length) out(`    ${c.green("Nothing.")}`);
  for (const x of m.sent) {
    para(x.to, "    ", c.bold);
    para(x.what, "      ");
    para(`Why: ${x.why} Kept: ${x.keep}`, "      ", c.gray);
  }
  section("What stays on their device");
  if (!m.kept.length) out(`    ${c.green("Nothing.")}`);
  for (const x of m.kept) {
    para(x.where, "    ", c.bold);
    para(`${x.what} Off: ${x.off}`, "      ");
  }
  section("Opt-outs it honours");
  for (const x of m.optOuts) bullet(x);
  section("EU, EEA and UK visitors");
  for (const x of m.eu) bullet(x);
  section("US visitors");
  for (const x of m.us) bullet(x);
  if (m.strict.length) {
    section("To send and keep nothing");
    para("Add these options to the file genclass init wrote (window.GENCLASS_CONFIG) or to GenClass.init():", "    ", c.gray);
    for (const [opt, what, cmd] of m.strict) {
      para(opt, "    ", c.cyan);
      para(`${what}${cmd ? `. Run: ${cmd}` : ""}`, "      ", c.gray);
    }
  }
  if (m.csp.length) {
    section("If your site has a Content-Security-Policy");
    for (const x of m.csp) para(x, "    ");
  }
  out();
  note(`For your privacy policy or a vendor questionnaire: npx genclass privacy --out genclass-privacy.md. Every field, one by one: ${TELEMETRY_DOC}`);
  out();
  return s.installed ? 0 : 1;
}

/** A list item: its first line behind a dash, the rest under its first word. */
function bullet(text) {
  const lines = wrap(text, width() - 8);
  out(`    - ${lines[0] ?? ""}`);
  for (const l of lines.slice(1)) out(`      ${l}`);
}

function section(title) {
  out();
  out(`  ${c.bold(title)}`);
}
