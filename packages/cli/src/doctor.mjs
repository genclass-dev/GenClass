// `genclass doctor`: is everything GenClass added to this project in place and current, and what to run when it is
// not. One line per part (this command, Node, the sign-in, the runtime and where it is imported, the MCP server's
// pin, the skill, the coding-agent link, the bridge, the site's Content-Security-Policy, the test workflow), each
// with its fix. `--fix` does the fixes that are GenClass's own files and lines, after showing them.
//
// Invariants:
// - Read only unless --fix, and then only GenClass's own: the version pin in its MCP server entry, the skill file
//   while it carries its marker, and the coding-agent link where agentlink.mjs plans it (after init's import, in the
//   frameworks whose development builds it can tell apart), written between genclass:init markers so
//   `genclass remove` takes it out. Each change is shown (its diff; a new skill file by name and size) before it is
//   written, with --yes too; a terminal is asked once, --yes is the yes, and without a terminal and without --yes
//   nothing is written. With --json, stdout is one JSON object only (the report and the changes go to stderr) and
//   nothing is asked: --fix writes with --yes only.
// - The project is found the way the tools that use it find it: the runtime where Node resolves it from the app's
//   folder (its node_modules or a parent's, as workspaces hoist it), or the script tag's version on a plain HTML
//   site; the MCP configuration in the same files `genclass status` reads (state.mjs agentConfigs), in the app's
//   folder and at the repository's root.
// - Two requests at most, both to npm's public registry for dist-tags (this command's and the runtime's), each
//   timed out after 2.5 s and sending nothing about the project; --offline skips them. This command is compared with
//   the newer of `latest` and the dist-tag of the line it is on (`alpha` for 0.4.0-alpha.N). Locally: `git rev-parse`
//   for the repository's root, and `genclass --version` with the PATH a shell has (npx's folders left out). Nothing
//   else leaves the machine.
// - Never throws: a part that cannot be read says so ("not checked") and the others still run.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { delimiter, dirname, join, relative } from "node:path";
import { c, interactive, out, printChange, sym } from "../../runtime/bin/lib/ui.mjs";
import { channelOf, cmdFor, installedVersion } from "../../runtime/bin/lib/version.mjs";
import { SKILL_MARK, SKILL_PATH, skillText } from "./actions.mjs";
import { planAgentLink, withAgentLink } from "./agentlink.mjs";
import { BUILD } from "./assets.mjs";
import { runGit } from "./git.mjs";
import { agentConfigs } from "./state.mjs";
import { agree, clean, good, header, note, warn, width, wrap } from "./tui.mjs";

/** An import statement of the runtime's /auto entry (not a comment that names it, as the config file's does). */
const AUTO_IMPORT = /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?["']@genclass\/runtime\/auto(?:\/(?:observe|guard|heal))?["']/m;
const VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/** "1.2.3" or "1.2.3-beta.4" compared: negative when a is older. Prereleases sort before their release. */
export function compareVersions(a, b) {
  const p = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? ""));
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const x = p(a);
  const y = p(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const xs = x.pre.split(".");
  const ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const xn = /^\d+$/.test(xs[i]);
    const yn = /^\d+$/.test(ys[i]);
    if (xn && yn && Number(xs[i]) !== Number(ys[i])) return Number(xs[i]) - Number(ys[i]);
    if (xs[i] !== ys[i]) return xs[i] < ys[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The newest release for someone on `current`, from a package's dist-tags: the newer of `latest` and the tag named
 * after current's prerelease line (`alpha` for 0.4.0-alpha.0, as the release workflows publish it), with the tag to
 * install it by. { version: null } when the tags say nothing. Pure.
 */
export function newestFor(current, tags) {
  const ok = (v) => (typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : null);
  const latest = ok(tags?.latest);
  const line = channelOf(current);
  const pre = line && line !== "latest" ? ok(tags?.[line]) : null;
  if (pre && (!latest || compareVersions(pre, latest) > 0)) return { version: pre, tag: line };
  return { version: latest, tag: "latest" };
}

/** npm's dist-tags for a package ({ latest, beta, ... }), or null: offline, slow (2.5 s), or not JSON. */
async function distTags(name, fetchFn = globalThis.fetch) {
  if (typeof fetchFn !== "function") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetchFn(`https://registry.npmjs.org/-/package/${name.replace("/", "%2f")}/dist-tags`, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Whether something listens on 127.0.0.1:port (GenClass's bridge, when an MCP server owns it). */
function listening(port, timeoutMs = 400) {
  return new Promise((done) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const end = (v) => {
      s.destroy();
      done(v);
    };
    s.setTimeout(timeoutMs, () => end(false));
    s.on("connect", () => end(true));
    s.on("error", () => end(false));
  });
}

// ------------------------------------------------------------------------------------- Content-Security-Policy

/** The files hosts and frameworks read a Content-Security-Policy from, relative to the app's folder. */
const CSP_FILES = [
  "index.html",
  "public/index.html",
  "src/app.html",
  "vercel.json",
  "firebase.json",
  "staticwebapp.config.json",
  "public/staticwebapp.config.json",
  "netlify.toml",
  "public/_headers",
  "_headers",
  "static/_headers",
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "src/middleware.ts",
  "src/middleware.js",
  "middleware.ts",
  "middleware.js",
  "src/proxy.ts",
  "src/proxy.js",
  "proxy.ts",
  "proxy.js",
  "src/hooks.server.ts",
  "src/hooks.server.js",
];

const ESC = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0", "\n": "" };
const isQuote = (ch) => ch === '"' || ch === "'" || ch === "`";
const skipWs = (t, i) => {
  while (i < t.length && /\s/.test(t[i])) i++;
  return i;
};

/**
 * The string literal that opens at t[i] (JS, JSON or TOML: ", ' or `, and TOML's """ and '''): [value, end], or
 * null when there is none or it does not close. A template literal's ${...} parts become their own text (without its
 * quotes), so a source they add is still seen.
 */
function stringAt(t, i, toml = false) {
  const q = t[i];
  if (!isQuote(q) || (toml && q === "`")) return null;
  if (toml && t.startsWith(q.repeat(3), i)) {
    const close = t.indexOf(q.repeat(3), i + 3);
    if (close < 0) return null;
    let v = t.slice(i + 3, close).replace(/^\r?\n/, "");
    if (q === '"') v = v.replace(/\\\r?\n\s*/g, "").replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, e) => (e[0] === "u" ? String.fromCharCode(parseInt(e.slice(1), 16)) : (ESC[e] ?? e)));
    return [v, close + 3];
  }
  let v = "";
  for (let j = i + 1; j < t.length; j++) {
    const ch = t[j];
    if (ch === "\\" && !(toml && q === "'")) {
      const e = t[j + 1] ?? "";
      if (e === "u" && /^[0-9a-fA-F]{4}$/.test(t.slice(j + 2, j + 6))) {
        v += String.fromCharCode(parseInt(t.slice(j + 2, j + 6), 16));
        j += 5;
      } else if (e === "\r" && t[j + 2] === "\n") j += 2;
      else {
        v += ESC[e] ?? e;
        j++;
      }
      continue;
    }
    if (ch === q) return [v, j + 1];
    if (q === "`" && ch === "$" && t[j + 1] === "{") {
      let depth = 0;
      let k = j + 1;
      for (; k < t.length; k++) {
        if (t[k] === "{") depth++;
        else if (t[k] === "}" && --depth === 0) break;
      }
      v += ` ${t.slice(j + 2, k).replace(/["`]/g, " ")} `;
      j = k;
      continue;
    }
    if (ch === "\n" && q !== "`") return null;
    v += ch;
  }
  return null;
}

/** Where the parenthesis that opens at t[i] closes (after it), skipping strings. */
function closeParen(t, i) {
  let depth = 0;
  for (let j = i; j < t.length; j++) {
    if (isQuote(t[j])) {
      const s = stringAt(t, j);
      if (s) {
        j = s[1] - 1;
        continue;
      }
    }
    if (t[j] === "(") depth++;
    else if (t[j] === ")" && --depth === 0) return j + 1;
  }
  return t.length;
}

/** Past the calls and members after a value (`.replace(/\s{2,}/g, " ").trim()`, `as const`): they leave its sources. */
function skipCalls(t, i) {
  for (;;) {
    const m = /^\s*\??\.\s*[A-Za-z_$][\w$]*\s*/.exec(t.slice(i, i + 200));
    if (m) {
      i += m[0].length;
      if (t[i] === "(") i = closeParen(t, i);
      continue;
    }
    const a = /^\s+as\s+const\b/.exec(t.slice(i, i + 20));
    if (a) {
      i += a[0].length;
      continue;
    }
    return i;
  }
}

/** One operand of a JS string expression at t[i]: [value, end, known]; a name nothing here defines is its own text. */
function jsAtom(t, i, depth) {
  const s = stringAt(t, i);
  if (s) return [s[0], s[1], true];
  if (t[i] === "(") {
    const v = jsValue(t, i + 1, depth);
    const j = v ? skipWs(t, v[1]) : -1;
    return v && t[j] === ")" ? [v[0], j + 1, true] : null;
  }
  if (t[i] === "[") {
    // an array of strings with .join(sep), the form `[ "default-src 'self'", ... ].join("; ")`
    const parts = [];
    let j = skipWs(t, i + 1);
    while (t[j] !== "]") {
      const v = jsValue(t, j, depth);
      if (!v) return null;
      parts.push(v[0]);
      j = skipWs(t, v[1]);
      if (t[j] === ",") j = skipWs(t, j + 1);
      else if (t[j] !== "]") return null;
    }
    const join = /^\s*\.\s*join\s*\(\s*/.exec(t.slice(j + 1, j + 40));
    if (!join) return null;
    const k = j + 1 + join[0].length;
    const sep = t[k] === ")" ? [",", k] : stringAt(t, k);
    if (!sep) return null;
    const close = skipWs(t, sep[1]);
    return [parts.join(sep[0]), t[close] === ")" ? close + 1 : close, true];
  }
  const id = /^[A-Za-z_$][\w$]*/.exec(t.slice(i, i + 100))?.[0];
  if (!id || /^(?:true|false|null|undefined|new|await|function)$/.test(id)) return null;
  if (depth < 4) {
    const decl = new RegExp(`(?:^|[^\\w$.])(?:const|let|var)\\s+${id.replace(/\$/g, "\\$")}\\s*(?::[^=\\n]+)?=\\s*`).exec(t);
    const v = decl ? jsValue(t, decl.index + decl[0].length, depth + 1) : null;
    if (v) return [v[0], i + id.length, true];
  }
  return [` ${id} `, i + id.length, false];
}

/**
 * The string a JS or TS expression at t[i] comes to, as far as the file's text tells: string and template literals,
 * joined with +, an array of strings with .join(sep), or a const that holds one of these. [value, end] or null
 * (nothing in it could be read).
 */
function jsValue(t, i, depth = 0) {
  const parts = [];
  let known = false;
  let at = skipWs(t, i);
  for (;;) {
    const one = jsAtom(t, at, depth);
    if (!one) break;
    parts.push(one[0]);
    known ||= one[2];
    const j = skipWs(t, skipCalls(t, one[1]));
    at = j;
    if (t[j] !== "+") break;
    at = skipWs(t, j + 1);
  }
  return known ? [parts.join(""), at] : null;
}

const decodeHtml = (s) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(quot|apos|amp|lt|gt));/gi, (m, d, x, n) => (d ? String.fromCharCode(Number(d)) : x ? String.fromCharCode(parseInt(x, 16)) : { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">" }[n.toLowerCase()]));

/** The policies a file sets, by its kind: [{ policy, route }] (`route`: the path pattern it is set for, if any). */
function policiesIn(file, t) {
  const found = [];
  const NAME = /^content-security-policy$/i;
  if (/\.html?$/i.test(file)) {
    for (const tag of t.matchAll(/<meta\b[^>]*>/gi)) {
      const attrs = {};
      for (const a of tag[0].matchAll(/([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4];
      if (NAME.test(String(attrs["http-equiv"] ?? "").trim()) && attrs.content) found.push({ policy: decodeHtml(attrs.content), route: null });
    }
    return found;
  }
  if (/_headers$/.test(file)) {
    // Netlify's and Cloudflare Pages' file: a path line, then its headers indented under it
    let route = null;
    for (const line of t.split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      if (!/^\s/.test(line)) route = line.trim();
      else {
        const m = /^\s+content-security-policy\s*:\s*(.+)$/i.exec(line);
        if (m) found.push({ policy: m[1].trim(), route });
      }
    }
    return found;
  }
  if (/\.toml$/.test(file)) {
    for (const m of t.matchAll(/(?:^|[\s{,])(?:"content-security-policy"|'content-security-policy'|content-security-policy)\s*=\s*/gim)) {
      const s = stringAt(t, m.index + m[0].length, true);
      if (!s) continue;
      const before = t.slice(0, m.index);
      const table = before.lastIndexOf("[[headers]]");
      const route = table < 0 ? null : (/(?:^|\n)\s*for\s*=\s*["']([^"'\n]*)["']/.exec(before.slice(table))?.[1] ?? null);
      found.push({ policy: s[0], route });
    }
    return found;
  }
  if (/\.json$/.test(file)) {
    let j;
    try {
      j = JSON.parse(t);
    } catch {
      j = undefined;
    }
    if (j !== undefined) {
      // vercel.json and firebase.json: { source, headers: [{ key, value }] }; Azure's: globalHeaders, routes[].headers
      const walk = (v, route) => {
        if (Array.isArray(v)) return v.forEach((x) => walk(x, route));
        if (!v || typeof v !== "object") return;
        const here = [v.source, v.src, v.route].find((x) => typeof x === "string") ?? route;
        const name = v.key ?? v.name;
        if (typeof name === "string" && NAME.test(name.trim()) && typeof v.value === "string") found.push({ policy: v.value, route: here });
        for (const [k, x] of Object.entries(v)) {
          if (NAME.test(k.trim()) && typeof x === "string") found.push({ policy: x, route: here });
          else walk(x, here);
        }
      };
      walk(j, null);
      return found;
    }
  }
  // JS and TS: { key: "Content-Security-Policy", value: ... }, { "Content-Security-Policy": ... },
  // headers.set("Content-Security-Policy", ...), with the value read as far as the text tells (jsValue)
  for (const m of t.matchAll(/(["'`])content-security-policy\1/gi)) {
    let j = skipWs(t, m.index + m[0].length);
    if (t[j] === ":") j++;
    else if (t[j] === ",") {
      j = skipWs(t, j + 1);
      const v = /^["']?value["']?\s*:/.exec(t.slice(j, j + 20));
      if (v) j += v[0].length;
    } else continue;
    const r = jsValue(t, j);
    if (!r || !r[0].trim()) continue;
    const sources = [...t.slice(0, m.index).matchAll(/\bsource\s*:\s*(["'`])([^"'`\n]*)\1/g)];
    found.push({ policy: r[0], route: sources.length ? sources[sources.length - 1][2] : null });
  }
  return found;
}

/**
 * Whether a header's path pattern takes in the site's home page: Netlify's and Cloudflare's `/*`, Vercel's and
 * Next's `/(.*)`, `/:path*` and `/((?!api).*)`, Firebase's `**`. A pattern that cannot be read counts.
 */
export function routeHasRoot(route) {
  if (route == null) return true;
  const r = String(route).trim();
  if (!r || r === "*" || r === "**") return true;
  try {
    const src = r
      .replace(/:\w+(\([^)]*\))?([*?+])?/g, (m, group, q) => (group ? `${group}${q ?? ""}` : q === "*" ? ".*" : q === "?" ? "[^/]*" : q === "+" ? ".+" : "[^/]+"))
      .replace(/(?<![.\\)\]])\*+/g, ".*");
    const re = new RegExp(`^${src}$`);
    return re.test("/") || re.test("");
  } catch {
    return true;
  }
}

/** Whether a policy's text names a directive at all (else it was not read, as a value built at run time). */
const readable = (policy) =>
  String(policy)
    .split(/[;,]/)
    .some((part) => /^(?:[a-z-]+-src|base-uri|sandbox|form-action|frame-ancestors|report-uri|report-to|require-trusted-types-for|trusted-types|upgrade-insecure-requests|block-all-mixed-content|navigate-to|plugin-types|webrtc)$/i.test(part.trim().split(/\s+/)[0] ?? ""));

/**
 * The Content-Security-Policy strings a project sets for its pages, in the files hosts and frameworks read them
 * from (and `extra`, more files relative to `dir`, as a plain HTML site's pages): [{ file, policy, route }]. A
 * policy set only for other paths (`/api/*`) is left out, and so is one whose text could not be read (built at run time);
 * a report-only policy is not read (it blocks nothing).
 */
export function cspIn(dir, extra = []) {
  const found = [];
  for (const f of [...new Set([...CSP_FILES, ...extra])]) {
    const t = read(join(dir, f));
    if (!t || !/content-security-policy/i.test(t)) continue;
    for (const p of policiesIn(f, t)) if (routeHasRoot(p.route) && readable(p.policy)) found.push({ file: f, ...p });
  }
  return found;
}

/** A policy's directives: { name: [source, lower case] }; the first of a repeated directive is the one that counts. */
function directives(policy) {
  const dirs = {};
  for (const part of String(policy).split(";")) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (!name) continue;
    const k = name.toLowerCase();
    if (!(k in dirs)) dirs[k] = vals.filter(Boolean).map((v) => v.toLowerCase());
  }
  return dirs;
}

/** The directive that governs `d` when it is not set: CSP's fallback lists. */
const FALLBACK = {
  "connect-src": ["connect-src", "default-src"],
  "script-src": ["script-src", "default-src"],
  "script-src-elem": ["script-src-elem", "script-src", "default-src"],
  "worker-src": ["worker-src", "child-src", "script-src", "default-src"],
};
const listFor = (dirs, d) => {
  for (const n of FALLBACK[d]) if (dirs[n]) return dirs[n];
  return null;
};

/** What the default model setup fetches from jsDelivr: the model's files and ONNX Runtime's wasm. */
const CDN_FILES = ["https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.2.0/files/model.onnx", "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.wasm"];

const schemeMatches = (a, b) => a === b || (a === "http" && b === "https") || (a === "ws" && /^(?:wss|https?)$/.test(b)) || (a === "wss" && b === "https");

/**
 * Whether a source list lets `url` load (CSP 3's matching, for a page on https): `*`, `'self'` (when `self`: the URL
 * is the page's own origin), scheme sources (`https:`, `blob:`), host sources with or without a scheme, a `*.`
 * wildcard, a port and a path; `'strict-dynamic'` lets in what a trusted script starts (`dynamic`). Null list: no
 * policy for it, so allowed. Pure.
 */
export function sourceAllows(list, url, { self = false, dynamic = false } = {}) {
  if (!list) return true;
  if (dynamic && list.includes("'strict-dynamic'")) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1);
  const network = /^(?:https?|wss?)$/.test(scheme);
  const port = u.port || (/^(?:https|wss)$/.test(scheme) ? "443" : "80");
  for (const s of list) {
    if (s === "*") {
      if (network) return true;
      continue;
    }
    if (s === "'self'") {
      if (self) return true;
      continue;
    }
    if (s.startsWith("'")) continue; // 'none', a nonce, a hash, a keyword
    const sm = /^([a-z][a-z0-9+.-]*):$/.exec(s);
    if (sm) {
      if (schemeMatches(sm[1], scheme)) return true;
      continue;
    }
    const hm = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^:/]+|[^:/*]+)(?::(\d+|\*))?(\/[^?#]*)?$/.exec(s);
    if (!hm || !network) continue;
    if (hm[1] ? !schemeMatches(hm[1], scheme) : !/^(?:https|wss)$/.test(scheme)) continue;
    const host = u.hostname.toLowerCase();
    if (hm[2] !== "*" && (hm[2].startsWith("*.") ? !host.endsWith(hm[2].slice(1)) : host !== hm[2])) continue;
    if (hm[3] !== "*" && (hm[3] ?? (hm[1] === "http" || hm[1] === "ws" ? "80" : "443")) !== port && !(hm[3] === undefined && hm[1] === "http" && port === "443")) continue;
    if (hm[4] && hm[4] !== "/" && !(hm[4].endsWith("/") ? u.pathname.startsWith(hm[4]) : u.pathname === hm[4])) continue;
    return true;
  }
  return false;
}

/** The folder a framework serves as-is, where a self-hosted model goes (init's publicDir). */
export function publicDirOf(project) {
  if (!project) return "public";
  if (project.framework === "sveltekit") return "static";
  if (project.framework === "angular" && existsSync(join(project.dir ?? ".", "src", "assets")) && !existsSync(join(project.dir ?? ".", "public"))) return "src/assets";
  if (project.framework === "html") return existsSync(join(project.dir ?? ".", "public", "index.html")) ? "public" : "";
  return "public";
}

/**
 * What a policy blocks of what GenClass needs: [{ need, why }]. `policy` may hold several policies (a header's
 * comma-separated list): each is enforced, so what any of them blocks is a gap. `o.script`: the script tag's src
 * on a script-tag setup (its worker starts from a blob: URL; the tag needs script-src); `o.publicDir`: where a
 * self-hosted model would go. Pure.
 */
export function cspGaps(policy, s, o = {}) {
  const gaps = [];
  const need = (g) => {
    if (!gaps.some((x) => x.need === g.need)) gaps.push(g);
  };
  const rt = cmdFor(BUILD.runtimeVersion);
  const pub = o.publicDir ?? "public";
  const modelDir = pub ? `${pub}/genclass-model` : "genclass-model";
  const selfHost = `${rt} fetch-model ${modelDir}, then ${rt} init --model-url /genclass-model/`;
  const tag = typeof o.script === "string" && o.script ? o.script : null;
  const tagUrl = (() => {
    try {
      return tag ? new URL(/^\/\//.test(tag) ? `https:${tag}` : tag, "https://site.invalid/").href : null;
    } catch {
      return null;
    }
  })();
  for (const one of String(policy ?? "").split(",")) {
    if (!one.trim()) continue;
    const dirs = directives(one);
    const lets = (d, url, opts) => sourceAllows(listFor(dirs, d), url, opts);
    if (s.telemetry === "on" && !lets("connect-src", "https://genclass.dev/api/v1/events")) need({ need: "connect-src https://genclass.dev", why: "the diagnostics are blocked (or set telemetry: false)" });
    if (s.telemetry === "own" && s.endpoint && !lets("connect-src", `https://${s.endpoint}/`)) need({ need: `connect-src https://${s.endpoint}`, why: "the diagnostics cannot reach your collector" });
    if (s.model === "cdn" && !CDN_FILES.every((u) => lets("connect-src", u))) need({ need: "connect-src https://cdn.jsdelivr.net", why: `the model cannot download, so GenClass observes without a diagnosis (or self-host it: ${selfHost})` });
    if (s.model === "other" && s.modelHost && !lets("connect-src", `https://${s.modelHost}/`)) need({ need: `connect-src https://${s.modelHost}`, why: "the model cannot download, so GenClass observes without a diagnosis" });
    for (const h of s.sinks ?? []) if (typeof h === "string" && h && !lets("connect-src", `https://${h}/`)) need({ need: `connect-src https://${h}`, why: "the sink cannot send" });
    if (tagUrl) {
      const elem = listFor(dirs, "script-src-elem");
      const own = tagUrl.startsWith("https://site.invalid/");
      if (!elem?.includes("'strict-dynamic'") && !sourceAllows(elem, tagUrl, { self: own })) need({ need: `script-src ${own ? "'self'" : new URL(tagUrl).origin}`, why: "the script tag cannot load, so GenClass does not run" });
    }
    if (s.model !== "off") {
      const script = listFor(dirs, "script-src");
      if (script && !script.includes("'wasm-unsafe-eval'") && !script.includes("'unsafe-eval'")) need({ need: "script-src 'wasm-unsafe-eval'", why: "the model's WebAssembly cannot start" });
      // the model's worker: the script tag starts it from a blob: URL, a bundled app from its own origin
      const worker = tag ? "blob:https://site.invalid/0" : "https://site.invalid/assets/worker.js";
      if (!lets("worker-src", worker, { self: !tag, dynamic: true })) need({ need: tag ? "worker-src blob:" : "worker-src 'self'", why: "the model's worker cannot start, so the model runs on the main thread (about 180 ms per decision; model: { inlineFallback: false } skips it instead)" });
    }
  }
  return gaps;
}

// ------------------------------------------------------------------------------------------------ the checks

/** The entry file's text with the coding-agent link after GenClass's own import (agentlink.mjs), Vite's check by default. */
export { withAgentLink };

/** Whether an entry file imports other code before GenClass's (GenClass must load first to see the app start). */
export function importedFirst(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (const l of lines) {
    if (!/^\s*import\b/.test(l)) continue;
    if (/@genclass\/runtime|genclass\.config|genclass:init/.test(l)) return true;
    return false;
  }
  return true;
}

/** GenClass's script tag in the marked files: { src, rel, version } (version null when the src names none), or null. */
function scriptTagIn(st, cwd) {
  for (const f of st?.marked ?? []) {
    const t = read(f) ?? "";
    for (const m of t.matchAll(/<script\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const src = m[1] ?? m[2];
      if (!/genclass[^/]*\.global|@genclass\/runtime/i.test(src)) continue;
      const version = new RegExp(`@genclass/runtime@(${VERSION_RE.source})(?:/|$)`).exec(src)?.[1] ?? null;
      return { src, rel: relative(cwd, f), version };
    }
  }
  return null;
}

/** The command that adds GenClass's MCP server and its skill to a project without an account. */
const MCP_INIT = () => `npx -y @genclass/mcp@${BUILD.mcpVersion} init`;
/** The skill without its marker line (each command writes its own) and with \n line ends. */
const skillBody = (t) => String(t).replace(/\r\n/g, "\n").replace(/^<!-- genclass:init[^\n]*-->\n/m, "");

/**
 * Every check: [{ id, label, state: "ok" | "warn" | "bad" | "info", detail, fix?: string, apply?: { what, file,
 * after, writes: [{ file, rel, kind, before, after, mkdir? }] } }].
 * `deps` for tests: inspect (inspectProject), creds, fetchFn, pathVersion (the PATH genclass's), listening, offline,
 * runGit (git, for the repository's root).
 */
export async function checks(o = {}, deps = {}) {
  const r = [];
  const add = (x) => r.push(x);
  const offline = !!o.offline || !!deps.offline;
  const [cliTags, rtTags] = offline ? [null, null] : await Promise.all([distTags("genclass", deps.fetchFn), distTags("@genclass/runtime", deps.fetchFn)]);

  // 1. this command, and the one `genclass` runs on this machine: against the newest of the line it is on
  const { version: latest, tag: cliTag } = newestFor(BUILD.version, cliTags);
  add(
    latest && compareVersions(BUILD.version, latest) < 0
      ? { id: "cli", label: "This command", state: "warn", detail: `${BUILD.version}; ${latest} is out`, fix: `npm install -g genclass@${cliTag}` }
      : { id: "cli", label: "This command", state: "ok", detail: `${BUILD.version}${latest ? " (the newest)" : offline ? "" : " (npm not checked)"}` },
  );
  const onPath = deps.pathVersion !== undefined ? deps.pathVersion : pathVersion();
  if (onPath && compareVersions(onPath, BUILD.version) !== 0) {
    const older = compareVersions(onPath, latest ?? BUILD.version) < 0;
    const tag = latest ? cliTag : (channelOf(BUILD.version) ?? "latest");
    add({ id: "cli-path", label: "genclass on PATH", state: older ? "warn" : "info", detail: `typing genclass runs ${onPath}, not ${BUILD.version}`, fix: older ? `npm install -g genclass@${tag}` : undefined });
  }
  const major = Number(String(process.versions.node).split(".")[0]);
  add(major >= 20 ? { id: "node", label: "Node", state: "ok", detail: process.versions.node } : { id: "node", label: "Node", state: "bad", detail: `${process.versions.node}: GenClass needs Node 20 or later`, fix: "install Node 20 or later (nodejs.org)" });

  // 2. the sign-in: the runtime and the MCP server need none; this command's setup steps need a sign-in and Pro
  const rtInit = `${cmdFor(BUILD.runtimeVersion)} init`;
  try {
    const { readCredentialsFor } = await import("../../runtime/bin/lib/account.mjs");
    const got = deps.creds !== undefined ? { creds: deps.creds } : readCredentialsFor();
    add(got.creds ? { id: "account", label: "Signed in", state: "ok", detail: clean(got.creds.account?.email ?? got.creds.account?.github_login ?? "yes", 50) } : { id: "account", label: "Signed in", state: "info", detail: "no: the runtime and the MCP server work without an account; npx genclass setup needs a sign-in and Pro", fix: "npx genclass login" });
  } catch {
    add({ id: "account", label: "Signed in", state: "info", detail: "not checked" });
  }

  // 3. the runtime in the app
  const inspect = deps.inspect ?? (await import("../../runtime/bin/lib/init.mjs")).inspectProject;
  let st = null;
  try {
    st = inspect({ cwd: o.cwd });
  } catch {
    /* not a project */
  }
  const cwd = st?.cwd ?? o.cwd ?? process.cwd();
  const { readSetup } = await import("./privacy.mjs");
  const setup = await readSetup({ cwd }, { inspect: () => st ?? { cwd, files: [], marked: [] } }).catch(() => null);
  const html = st?.project?.framework === "html";
  const tag = st?.project?.framework && !st.fresh ? scriptTagIn(st, cwd) : null;
  if (!st?.project?.framework) {
    add({ id: "runtime", label: "Runtime", state: "info", detail: "this folder is not a web app GenClass recognises", fix: "run it in your app's folder (or --cwd apps/web)" });
  } else if (st.fresh) {
    add({ id: "runtime", label: "Runtime", state: "bad", detail: `not added to this ${st.project.label}`, fix: `npx genclass setup (with Pro), or without an account: ${rtInit}` });
  } else {
    const newest = rtTags?.beta && rtTags?.latest ? (compareVersions(rtTags.beta, rtTags.latest) > 0 ? rtTags.beta : rtTags.latest) : (rtTags?.beta ?? rtTags?.latest ?? null);
    const mode = setup?.mode ?? "observe";
    if (html) {
      // a plain HTML site loads the runtime from its script tag: no package, no node_modules
      if (tag?.version && newest && compareVersions(tag.version, newest) < 0) add({ id: "runtime", label: "Runtime", state: "warn", detail: `the script tag in ${tag.rel} loads @genclass/runtime ${tag.version}; ${newest} is out`, fix: `put ${newest} in the script tag's src in ${tag.rel}, and update its integrity attribute (or take it out)` });
      else add({ id: "runtime", label: "Runtime", state: "ok", detail: `script tag${tag?.version ? `, @genclass/runtime ${tag.version}` : ""}${tag ? ` in ${tag.rel}` : ""}, ${mode} mode` });
    } else {
      // where Node finds it from the app's folder: its node_modules or a parent's (workspaces hoist it to the root)
      const have = installedVersion(cwd);
      if (!have) add({ id: "runtime", label: "Runtime", state: "warn", detail: "added, but @genclass/runtime is not installed (in node_modules here or in a parent folder)", fix: `${st.project.pm ?? "npm"} install` });
      else if (newest && compareVersions(have, newest) < 0) add({ id: "runtime", label: "Runtime", state: "warn", detail: `@genclass/runtime ${have}; ${newest} is out`, fix: `npm install @genclass/runtime@${newest}` });
      else add({ id: "runtime", label: "Runtime", state: "ok", detail: `@genclass/runtime ${have}, ${mode} mode` });
    }
    // GenClass's import first in the entry
    const entry = (st.marked ?? []).find((f) => AUTO_IMPORT.test(read(f) ?? ""));
    if (entry && !importedFirst(read(entry))) add({ id: "order", label: "Import order", state: "warn", detail: `${relative(cwd, entry)} imports other code before GenClass, so it cannot see what that code does as it starts`, fix: `move the genclass:init lines to the top of ${relative(cwd, entry)}` });
    else if (entry) add({ id: "order", label: "Import order", state: "ok", detail: `first in ${relative(cwd, entry)}` });
    if (setup) add({ id: "privacy", label: "Diagnostics", state: "info", detail: setup.telemetry === "off" ? "off: nothing goes to genclass.dev" : setup.telemetry === "own" ? `to your own collector (${setup.endpoint})` : "on: anonymous counts to genclass.dev from public hosts", fix: "npx genclass privacy (what is sent and kept, and how to send nothing)" });
  }

  // 4. the coding agent: the MCP server's pin, the skill, the link from the dev page, the bridge. The configurations
  // are the ones `genclass status` reads, here and at the repository's root (where a monorepo's agent starts).
  const here = real(cwd);
  const root = (() => {
    try {
      const top = (deps.runGit ?? runGit)(["rev-parse", "--show-toplevel"], cwd);
      return top ? real(top) : null;
    } catch {
      return null;
    }
  })();
  const dirs = [here, ...(root && root !== here ? [root] : [])];
  const mcp = [];
  for (const d of dirs) {
    for (const f of agentConfigs(d)) {
      const file = join(d, f);
      const t = read(file);
      if (t !== null && !mcp.some((x) => real(x.file) === real(file))) mcp.push({ file, rel: relative(here, file), t });
    }
  }
  const pinOf = (t) => new RegExp(`@genclass/mcp@(${VERSION_RE.source})`).exec(t)?.[1] ?? null;
  if (!mcp.length) add({ id: "mcp", label: "MCP server", state: "warn", detail: "your coding agent has no GenClass tools in this project", fix: `npx genclass setup (the Coding agent step, with Pro), or without an account: ${MCP_INIT()}` });
  for (const { file, rel, t } of mcp) {
    const pin = pinOf(t);
    if (pin && compareVersions(pin, BUILD.mcpVersion) < 0) {
      const after = t.split(`@genclass/mcp@${pin}`).join(`@genclass/mcp@${BUILD.mcpVersion}`);
      const what = `${rel}: @genclass/mcp ${pin} to ${BUILD.mcpVersion}`;
      add({ id: "mcp", label: "MCP server", state: "warn", detail: `${rel} pins @genclass/mcp ${pin}; this command installs ${BUILD.mcpVersion}`, fix: "npx genclass doctor --fix", apply: { what, file, after, writes: [{ file, rel, kind: "modify", before: t, after }] } });
    } else add({ id: "mcp", label: "MCP server", state: "ok", detail: `${rel}${pin ? ` (@genclass/mcp ${pin})` : " (unpinned)"}` });
  }
  // the skill: here, else at the root; a missing one is written here, as the Coding agent step does
  const skillFile = dirs.map((d) => join(d, SKILL_PATH)).find((f) => existsSync(f)) ?? join(here, SKILL_PATH);
  const skillRel = relative(here, skillFile);
  const skill = read(skillFile);
  const mine = skillText();
  const crlf = /\r\n/.test(skill ?? "");
  const skillApply = (what) => ({ what, file: skillFile, after: crlf ? mine.replace(/\n/g, "\r\n") : mine, writes: [{ file: skillFile, rel: skillRel, kind: skill === null ? "create" : "modify", before: skill ?? "", after: crlf ? mine.replace(/\n/g, "\r\n") : mine, mkdir: true, skill: true }] });
  const markLine = skill === null ? null : (/^<!-- genclass:init[^\n]*-->$/m.exec(skill.replace(/\r\n/g, "\n"))?.[0] ?? null);
  const markedBy = markLine ? pinOf(markLine) : null;
  const newerPin = mcp.map((x) => pinOf(x.t)).find((p) => p && compareVersions(p, BUILD.mcpVersion) > 0) ?? null;
  if (skill === null) add({ id: "skill", label: "Skill", state: mcp.length ? "warn" : "info", detail: "no GenClass skill for Claude Code in this project", fix: "npx genclass doctor --fix", apply: skillApply(`${skillRel}: the skill`) });
  else if (!skill.includes(SKILL_MARK)) add({ id: "skill", label: "Skill", state: "ok", detail: `${skillRel} (yours: the marker was removed, so it is left alone)` });
  else if (skillBody(skill) === skillBody(mine)) add({ id: "skill", label: "Skill", state: "ok", detail: skillRel });
  else if (markedBy && compareVersions(markedBy, BUILD.mcpVersion) > 0) add({ id: "skill", label: "Skill", state: "ok", detail: `${skillRel} (from @genclass/mcp ${markedBy}, newer than this command's ${BUILD.mcpVersion}: left as it is)` });
  else if (newerPin) add({ id: "skill", label: "Skill", state: "info", detail: `${skillRel} differs from this command's (@genclass/mcp ${BUILD.mcpVersion}), and the project pins the newer ${newerPin}`, fix: `npx -y @genclass/mcp@${newerPin} init (writes that version's skill)` });
  else add({ id: "skill", label: "Skill", state: "warn", detail: `${skillRel} is from another version${markedBy ? ` (@genclass/mcp ${markedBy})` : ""}`, fix: "npx genclass doctor --fix", apply: skillApply(`${skillRel}: this version's skill`) });
  if (st?.project?.framework && !st.fresh) {
    let link = null;
    try {
      link = planAgentLink(st);
    } catch {
      link = null;
    }
    if (setup?.agentLink || link?.state === "linked") add({ id: "link", label: "Agent link", state: "ok", detail: "the dev build connects to your coding agent (connectAgent)" });
    else if (link?.state === "manual" && !link.lines?.length) {
      // nothing to add for this setup (the script tag): the agent's other tools still work
      add({ id: "link", label: "Agent link", state: "info", detail: `not available here: ${link.why}; your coding agent's GenClass tools still audit any page you name (genclass_scan)` });
    } else {
      const planned = link?.state === "planned" ? link.changes : null;
      const by = `${link?.state === "manual" ? `not added here (${link.why}): ` : ""}ask your agent "is GenClass connected?": genclass_setup prints the dev-only lines for this app`;
      add({
        id: "link",
        label: "Agent link",
        state: "warn",
        detail: "the dev page does not connect to your coding agent, so genclass_status lists no page and explore and replay cannot run",
        fix: planned ? "npx genclass doctor --fix" : by,
        ...(planned ? { apply: { what: planned.map((ch) => ch.what).join("; "), file: planned[0].file, after: planned[0].after, writes: planned.map((ch) => ({ file: ch.file, rel: ch.rel, kind: ch.kind ?? "modify", before: ch.before, after: ch.after })) } } : {}),
      });
    }
  }
  const port = Number(process.env.GENCLASS_AGENT_PORT) || 47357;
  const up = await (deps.listening ?? listening)(port);
  add(up ? { id: "bridge", label: "Bridge", state: "ok", detail: `a GenClass MCP server listens on 127.0.0.1:${port}` } : { id: "bridge", label: "Bridge", state: "info", detail: `nothing on 127.0.0.1:${port} yet: it starts with your coding agent`, fix: "start your coding agent in this folder" });

  // 5. what the live site lets through: every policy each file sets for the pages
  if (setup && st?.project?.framework && !st.fresh) {
    const pages = html ? (st.marked ?? []).filter((f) => /\.html?$/i.test(f)).map((f) => relative(cwd, f).split("\\").join("/")) : [];
    try {
      const byFile = new Map();
      for (const { file, policy } of cspIn(cwd, pages)) byFile.set(file, [...(byFile.get(file) ?? []), policy]);
      for (const [file, policies] of byFile) {
        const gaps = [];
        for (const p of policies) for (const g of cspGaps(p, setup, { script: tag?.src ?? null, publicDir: publicDirOf(st.project) })) if (!gaps.some((x) => x.need === g.need)) gaps.push(g);
        if (gaps.length) add({ id: "csp", label: "Content policy", state: "bad", detail: `${file}: ${gaps.map((g) => `without ${g.need}, ${g.why}`).join("; ")}`, fix: `add ${gaps.map((g) => g.need).join(", ")} to the policy in ${file}` });
        else add({ id: "csp", label: "Content policy", state: "ok", detail: `${file} allows what GenClass needs` });
      }
    } catch {
      add({ id: "csp", label: "Content policy", state: "info", detail: "not checked" });
    }
  }

  // 6. the test workflow, for a project with Playwright
  const pkgText = read(join(cwd, "package.json")) ?? "";
  if (/@playwright\/test/.test(pkgText)) {
    add(existsSync(join(cwd, ".github", "workflows", "genclass.yml")) ? { id: "workflow", label: "Test workflow", state: "ok", detail: ".github/workflows/genclass.yml" } : { id: "workflow", label: "Test workflow", state: "info", detail: "your Playwright tests do not run with reordered responses on pull requests", fix: "npx genclass setup (the Test workflow step, with Pro)" });
  }
  r.app = st?.project?.name ?? null;
  r.framework = st?.project?.label || null;
  return r;
}

/**
 * The PATH a shell has, for `genclass --version`: without npx's folders and node_modules/.bin, which `npx genclass`
 * puts first (name.mjs shortNameWorks skips the same). { key, value }: the variable's name (PATH, or Path on
 * Windows) and the list.
 */
export function userPath(env = process.env, platform = process.platform) {
  const sep = platform === "win32" ? ";" : delimiter;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const kept = String(env[key] ?? "")
    .split(sep)
    .filter((d) => d && !/[\\/]_npx[\\/]/.test(d) && !/node_modules[\\/]\.bin[\\/]?$/.test(d));
  return { key, value: kept.join(sep) };
}

/** The version of the `genclass` the shell runs, or null (not installed, or it did not answer in 4 s). */
function pathVersion() {
  try {
    const p = userPath();
    const env = { ...process.env, GENCLASS_NO_INSTALL: "1" };
    for (const k of Object.keys(env)) if (k.toUpperCase() === "PATH") delete env[k];
    env[p.key] = p.value;
    const r = spawnSync(process.platform === "win32" ? "genclass.cmd" : "genclass", ["--version"], { encoding: "utf8", timeout: 4000, shell: process.platform === "win32", env });
    return new RegExp(`genclass (${VERSION_RE.source})`).exec(r.stdout ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
}

const MARK = { ok: () => c.green(sym.ok), warn: () => c.yellow(sym.warn), bad: () => c.red(sym.cross), info: () => c.gray(sym.dot) };

/**
 * `genclass doctor [--fix] [--yes] [--json] [--offline]`. Exit 0 when nothing is wrong or warned about, else 1.
 * --json prints one object: { ok, checks } and, with --fix, { fixed, failed, skipped } (what was written, what could
 * not be, and what was not because --yes was not given); the report and the changes go to stderr then.
 */
export async function doctor(o = {}, deps = {}) {
  const list = await checks(o, deps);
  const wrong = list.filter((x) => x.state === "bad" || x.state === "warn");
  const shown = () => list.map(({ apply, ...x }) => ({ ...x, fixable: !!apply }));
  if (o.json && !o.fix) {
    out(JSON.stringify({ ok: wrong.length === 0, checks: shown() }, null, 2));
    return wrong.length ? 1 : 0;
  }
  if (!o.json) return (await report(list, o)).code;
  // --json --fix: the report and each change on stderr, so stdout is the JSON alone and parses; nothing is asked
  const write = process.stdout.write;
  let r;
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    r = await report(list, { ...o, ask: false });
  } finally {
    process.stdout.write = write;
  }
  out(JSON.stringify({ ok: r.code === 0, checks: shown(), fixed: r.fixed, failed: r.failed, skipped: r.skipped }, null, 2));
  return r.code;
}

/** Shows one planned write: its diff, or a new skill file by name and size. */
function showWrite(w) {
  if (w.kind === "create" && w.skill) {
    out(`  ${c.bold(w.rel)} ${c.gray("(")}${c.green("new file")}${c.gray(")")}`);
    out(`    ${c.gray(`${w.after.replace(/\r?\n$/, "").split("\n").length} lines: the procedure your coding agent follows with GenClass's tools (@genclass/mcp ${BUILD.mcpVersion}'s skill)`)}`);
    out();
    return;
  }
  printChange({ file: w.rel ?? w.file, kind: w.kind ?? "modify", before: w.before ?? "", after: w.after });
}

/** The human report, and with --fix the writes: { code, fixed, failed, skipped } (each a list of `what`). */
async function report(list, o) {
  const wrong = list.filter((x) => x.state === "bad" || x.state === "warn");
  const fixable = list.filter((x) => x.apply);
  const done = { fixed: [], failed: [], skipped: [] };
  header({ app: list.app, framework: list.framework });
  out();
  const wLabel = Math.max(...list.map((x) => x.label.length));
  for (const x of list) {
    const lines = wrap(x.detail, width() - 9 - wLabel);
    out(`  ${MARK[x.state]()}  ${x.label.padEnd(wLabel)}  ${x.state === "ok" ? c.gray(lines[0] ?? "") : (lines[0] ?? "")}`);
    for (const l of lines.slice(1)) out(`     ${" ".repeat(wLabel)}  ${x.state === "ok" ? c.gray(l) : l}`);
    if (x.fix && x.state !== "ok") for (const l of wrap(`${sym.arrow ?? "->"} ${x.fix}`, width() - 9 - wLabel)) out(`     ${" ".repeat(wLabel)}  ${c.cyan(l)}`);
  }
  out();
  if (!o.fix) {
    if (fixable.length) note(`${fixable.length === 1 ? "One of these is" : `${fixable.length} of these are`} GenClass's own files and lines: npx genclass doctor --fix does ${fixable.length === 1 ? "it" : "them"}, after showing ${fixable.length === 1 ? "it" : "them"}.`);
    else if (!wrong.length) good("Everything GenClass added is in place.");
    out();
    return { code: wrong.length ? 1 : 0, ...done };
  }
  if (!fixable.length) {
    note("Nothing here is GenClass's own to fix: the lines above say what to run.");
    out();
    return { code: wrong.length ? 1 : 0, ...done };
  }
  out(`  ${c.bold("To fix")}`);
  for (const x of fixable) out(`    ${sym.dot} ${x.apply.what}`);
  out();
  // each change itself, before anything is written (with --yes too, so an agent that ran it sees what changed)
  for (const x of fixable) for (const w of x.apply.writes ?? [x.apply]) showWrite(w);
  const ask = o.ask !== false && interactive();
  const yes = o.yes || (ask && (await agree("Write these?")));
  if (!yes) {
    note(ask ? "Nothing was written." : o.ask === false ? "Nothing was written: run it with --yes." : "Nothing was written: run it with --yes, or on a terminal.");
    out();
    done.skipped = fixable.map((x) => x.apply.what);
    return { code: 1, ...done };
  }
  for (const x of fixable) {
    try {
      for (const w of x.apply.writes ?? [x.apply]) {
        if (w.mkdir) mkdirSync(dirname(w.file), { recursive: true });
        writeFileSync(w.file, w.after);
      }
      good(`Wrote ${x.apply.what}`);
      done.fixed.push(x.apply.what);
    } catch (e) {
      done.failed.push(x.apply.what);
      warn(`Could not write ${x.apply.what}: ${clean(e?.message ?? e, 100)}`);
    }
  }
  const wrote = (id) => fixable.some((x) => x.id === id && done.fixed.includes(x.apply.what));
  // the agent can list the page only once its configuration names GenClass's server
  const agentHasTools = list.some((x) => x.id === "mcp" && (x.state === "ok" || x.apply));
  if (wrote("link"))
    note(
      agentHasTools
        ? 'Reload the dev page once, then ask your coding agent "is GenClass connected?": genclass_status lists the page.'
        : `Reload the dev page once. Your coding agent has no GenClass tools in this project yet: ${MCP_INIT()} adds GenClass's server (or npx genclass setup, the Coding agent step, with Pro); restart the agent, then ask it "is GenClass connected?".`,
    );
  if (wrote("mcp")) note("Restart your coding agent in this folder so it starts the new MCP server.");
  out();
  // what is left is the person's to do (the lines above say what): still exit 1 then
  return { code: done.failed.length || wrong.some((x) => !x.apply) ? 1 : 0, ...done };
}
