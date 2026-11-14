// `genclass doctor`: is everything GenClass added to this project in place and current, and what to run when it is
// not. One line per part (this command, Node, the sign-in, the runtime and where it is imported, the MCP server's
// pin, the skill, the coding-agent link, the bridge, the site's Content-Security-Policy, the test workflow), each
// with its fix. `--fix` does the fixes that are GenClass's own files and lines, after showing them.
//
// Invariants:
// - Read only unless --fix, and then only GenClass's own: the version pin in its MCP server entry, the skill file
//   while it carries its marker, and the coding-agent link in a Vite entry, written between genclass:init markers so
//   `genclass remove` takes it out. Each is shown before it is written; a terminal is asked once, --yes is the yes,
//   and without a terminal and without --yes nothing is written.
// - Two requests at most, both to npm's public registry for dist-tags (this command's and the runtime's), each
//   timed out after 2.5 s and sending nothing about the project; --offline skips them. Nothing else leaves the machine.
// - Never throws: a part that cannot be read says so ("not checked") and the others still run.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, relative } from "node:path";
import { c, interactive, out, sym } from "../../runtime/bin/lib/ui.mjs";
import { SKILL_MARK, SKILL_PATH, skillText } from "./actions.mjs";
import { BUILD } from "./assets.mjs";
import { agree, clean, good, header, note, warn, width, wrap } from "./tui.mjs";

const AGENT_START = "// genclass:init start: the coding-agent link, development builds only: GenClass.init() returns the running runtime (genclass remove takes it out)";
const AGENT_END = "// genclass:init end";
const MCP_FILES = [".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json", ".gemini/settings.json"];
/** An import statement of the runtime's /auto entry (not a comment that names it, as the config file's does). */
const AUTO_IMPORT = /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?["']@genclass\/runtime\/auto(?:\/(?:observe|guard|heal))?["']/m;

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

/** The Content-Security-Policy strings a project sets in the files hosts and frameworks read them from. */
export function cspIn(dir) {
  const found = [];
  const files = ["index.html", "public/index.html", "src/app.html", "vercel.json", "netlify.toml", "public/_headers", "_headers", "static/_headers", "next.config.js", "next.config.mjs", "next.config.ts", "src/middleware.ts", "middleware.ts"];
  for (const f of files) {
    const t = read(join(dir, f));
    if (!t || !/content-security-policy/i.test(t)) continue;
    // a meta tag's content, a header's value, or a string in a config: the text after the header's name
    const m = /content-security-policy["']?\s*(?:content\s*=\s*|[:=,]\s*(?:value\s*[:=]\s*)?)["'`]([^"'`]{10,})["'`]/i.exec(t) ?? /content-security-policy\s*:\s*([^\n]{10,})/i.exec(t);
    if (m) found.push({ file: f, policy: m[1] });
  }
  return found;
}

/** What a policy blocks of what GenClass needs: [{ need, why }]. Pure. */
export function cspGaps(policy, s) {
  const dirs = {};
  for (const part of String(policy).split(";")) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) dirs[name.toLowerCase()] = vals;
  }
  const allows = (dir, origin) => {
    const v = dirs[dir] ?? dirs["default-src"];
    if (!v) return true;
    return v.includes("*") || v.some((x) => x.replace(/\/$/, "") === origin || (x.startsWith("https://*.") && origin.endsWith(x.slice(9))));
  };
  const gaps = [];
  if (s.telemetry === "on" && !allows("connect-src", "https://genclass.dev")) gaps.push({ need: "connect-src https://genclass.dev", why: "the diagnostics are blocked (or set telemetry: false)" });
  if (s.model === "cdn" && !allows("connect-src", "https://cdn.jsdelivr.net")) gaps.push({ need: "connect-src https://cdn.jsdelivr.net", why: "the model cannot download, so GenClass observes without a diagnosis (or self-host it: npx @genclass/runtime@beta fetch-model)" });
  const script = dirs["script-src"] ?? dirs["default-src"];
  if (s.model !== "off" && script && !script.includes("'wasm-unsafe-eval'") && !script.includes("'unsafe-eval'")) gaps.push({ need: "script-src 'wasm-unsafe-eval'", why: "the model's WebAssembly cannot start" });
  return gaps;
}

/**
 * The entry file's lines with the coding-agent link added after GenClass's own import: a block between
 * genclass:init markers (so `genclass remove` takes it out), for a Vite app (import.meta.env.DEV). Null when there
 * is no GenClass import marked by init to put it after, or the link is already there.
 */
export function withAgentLink(text) {
  const t = String(text ?? "");
  if (/connectAgent\s*\(/.test(t)) return null;
  const eol = t.includes("\r\n") ? "\r\n" : "\n";
  const lines = t.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?["']@genclass\/runtime\/auto(?:\/(?:observe|guard|heal))?["'];?.*genclass:init/.test(l));
  if (at < 0) return null;
  const block = [AGENT_START, 'import { GenClass } from "@genclass/runtime";', 'import { connectAgent } from "@genclass/runtime/agent";', "if (import.meta.env.DEV) connectAgent(GenClass.init());", AGENT_END];
  lines.splice(at + 1, 0, ...block);
  return lines.join(eol);
}

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

/**
 * Every check: [{ id, label, state: "ok" | "warn" | "bad" | "info", detail, fix?: string, apply?: { file, after, what } }].
 * `deps` for tests: inspect (inspectProject), creds, fetchFn, version (the PATH genclass's), listening, offline.
 */
export async function checks(o = {}, deps = {}) {
  const r = [];
  const add = (x) => r.push(x);
  const offline = !!o.offline || !!deps.offline;
  const [cliTags, rtTags] = offline ? [null, null] : await Promise.all([distTags("genclass", deps.fetchFn), distTags("@genclass/runtime", deps.fetchFn)]);

  // 1. this command, and the one `genclass` runs on this machine
  const latest = cliTags?.latest ?? null;
  add(
    latest && compareVersions(BUILD.version, latest) < 0
      ? { id: "cli", label: "This command", state: "warn", detail: `${BUILD.version}; ${latest} is out`, fix: "npm install -g genclass@latest" }
      : { id: "cli", label: "This command", state: "ok", detail: `${BUILD.version}${latest ? " (the newest)" : offline ? "" : " (npm not checked)"}` },
  );
  const onPath = deps.pathVersion !== undefined ? deps.pathVersion : pathVersion();
  if (onPath && compareVersions(onPath, BUILD.version) !== 0) {
    add({ id: "cli-path", label: "genclass on PATH", state: compareVersions(onPath, latest ?? BUILD.version) < 0 ? "warn" : "info", detail: `typing genclass runs ${onPath}, not ${BUILD.version}`, fix: compareVersions(onPath, latest ?? BUILD.version) < 0 ? "npm install -g genclass@latest" : undefined });
  }
  const major = Number(String(process.versions.node).split(".")[0]);
  add(major >= 20 ? { id: "node", label: "Node", state: "ok", detail: process.versions.node } : { id: "node", label: "Node", state: "bad", detail: `${process.versions.node}: GenClass needs Node 20 or later`, fix: "install Node 20 or later (nodejs.org)" });

  // 2. the sign-in
  try {
    const { readCredentialsFor } = await import("../../runtime/bin/lib/account.mjs");
    const got = deps.creds !== undefined ? { creds: deps.creds } : readCredentialsFor();
    add(got.creds ? { id: "account", label: "Signed in", state: "ok", detail: clean(got.creds.account?.email ?? got.creds.account?.github_login ?? "yes", 50) } : { id: "account", label: "Signed in", state: "info", detail: "no: the runtime and the agent tools work without an account", fix: "npx genclass login (for the dashboard)" });
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
  if (!st?.project?.framework) {
    add({ id: "runtime", label: "Runtime", state: "info", detail: "this folder is not a web app GenClass recognises", fix: "run it in your app's folder (or --cwd apps/web)" });
  } else if (st.fresh) {
    add({ id: "runtime", label: "Runtime", state: "bad", detail: `not added to this ${st.project.label}`, fix: "npx genclass setup" });
  } else {
    const pkg = read(join(cwd, "node_modules", "@genclass", "runtime", "package.json"));
    let have = null;
    try {
      have = pkg ? JSON.parse(pkg).version : null;
    } catch {
      /* unreadable */
    }
    const newest = rtTags?.beta && rtTags?.latest ? (compareVersions(rtTags.beta, rtTags.latest) > 0 ? rtTags.beta : rtTags.latest) : (rtTags?.beta ?? rtTags?.latest ?? null);
    if (!have) add({ id: "runtime", label: "Runtime", state: "warn", detail: "added, but @genclass/runtime is not installed in node_modules", fix: "npm install" });
    else if (newest && compareVersions(have, newest) < 0) add({ id: "runtime", label: "Runtime", state: "warn", detail: `@genclass/runtime ${have}; ${newest} is out`, fix: `npm install @genclass/runtime@${newest}` });
    else add({ id: "runtime", label: "Runtime", state: "ok", detail: `@genclass/runtime ${have}, ${setup?.mode ?? "observe"} mode` });
    // GenClass's import first in the entry
    const entry = (st.marked ?? []).find((f) => AUTO_IMPORT.test(read(f) ?? ""));
    if (entry && !importedFirst(read(entry))) add({ id: "order", label: "Import order", state: "warn", detail: `${relative(cwd, entry)} imports other code before GenClass, so it cannot see what that code does as it starts`, fix: `move the genclass:init lines to the top of ${relative(cwd, entry)}` });
    else if (entry) add({ id: "order", label: "Import order", state: "ok", detail: `first in ${relative(cwd, entry)}` });
    if (setup) add({ id: "privacy", label: "Diagnostics", state: "info", detail: setup.telemetry === "off" ? "off: nothing goes to genclass.dev" : setup.telemetry === "own" ? `to your own collector (${setup.endpoint})` : "on: anonymous counts to genclass.dev from public hosts", fix: "npx genclass privacy (what is sent and kept, and how to send nothing)" });
  }

  // 4. the coding agent: the MCP server's pin, the skill, the link from the dev page, the bridge
  const mcp = MCP_FILES.map((f) => ({ f, t: read(join(cwd, f)) })).filter((x) => x.t && /@genclass\/mcp/.test(x.t));
  if (!mcp.length) add({ id: "mcp", label: "MCP server", state: "warn", detail: "your coding agent has no GenClass tools in this project", fix: "npx genclass setup (the Coding agent step)" });
  for (const { f, t } of mcp) {
    const pin = /@genclass\/mcp@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(t)?.[1] ?? null;
    if (pin && compareVersions(pin, BUILD.mcpVersion) < 0) {
      add({ id: "mcp", label: "MCP server", state: "warn", detail: `${f} pins @genclass/mcp ${pin}; this command installs ${BUILD.mcpVersion}`, fix: "npx genclass doctor --fix", apply: { file: join(cwd, f), after: t.split(`@genclass/mcp@${pin}`).join(`@genclass/mcp@${BUILD.mcpVersion}`), what: `${f}: @genclass/mcp ${pin} to ${BUILD.mcpVersion}` } });
    } else add({ id: "mcp", label: "MCP server", state: "ok", detail: `${f}${pin ? ` (@genclass/mcp ${pin})` : " (unpinned)"}` });
  }
  const skill = read(join(cwd, SKILL_PATH));
  if (skill === null) add({ id: "skill", label: "Skill", state: mcp.length ? "warn" : "info", detail: "no GenClass skill for Claude Code in this project", fix: "npx genclass doctor --fix", apply: { file: join(cwd, SKILL_PATH), after: skillText(), what: `${SKILL_PATH}: the skill`, mkdir: true } });
  else if (!skill.includes(SKILL_MARK)) add({ id: "skill", label: "Skill", state: "ok", detail: `${SKILL_PATH} (yours: the marker was removed, so it is left alone)` });
  else if (skill !== skillText()) add({ id: "skill", label: "Skill", state: "warn", detail: `${SKILL_PATH} is from another version`, fix: "npx genclass doctor --fix", apply: { file: join(cwd, SKILL_PATH), after: skillText(), what: `${SKILL_PATH}: this version's skill` } });
  else add({ id: "skill", label: "Skill", state: "ok", detail: SKILL_PATH });
  if (st?.project?.framework && !st.fresh) {
    if (setup?.agentLink) add({ id: "link", label: "Agent link", state: "ok", detail: "the dev build connects to your coding agent (connectAgent)" });
    else {
      const entry = (st.marked ?? []).find((f) => AUTO_IMPORT.test(read(f) ?? ""));
      const vite = !!st.project.deps?.vite || /vite/i.test(st.project.label ?? "") || existsSync(join(cwd, "vite.config.ts")) || existsSync(join(cwd, "vite.config.js"));
      const after = entry && vite ? withAgentLink(read(entry)) : null;
      add({
        id: "link",
        label: "Agent link",
        state: "warn",
        detail: "the dev page does not connect to your coding agent, so genclass_status lists no page and explore and replay cannot run",
        fix: after ? "npx genclass doctor --fix" : "ask your agent \"is GenClass connected?\": genclass_setup prints the two dev-only lines for this app",
        ...(after ? { apply: { file: entry, after, what: `${relative(cwd, entry)}: the coding-agent link, development builds only` } } : {}),
      });
    }
  }
  const port = Number(process.env.GENCLASS_AGENT_PORT) || 47357;
  const up = await (deps.listening ?? listening)(port);
  add(up ? { id: "bridge", label: "Bridge", state: "ok", detail: `a GenClass MCP server listens on 127.0.0.1:${port}` } : { id: "bridge", label: "Bridge", state: "info", detail: `nothing on 127.0.0.1:${port} yet: it starts with your coding agent`, fix: "start your coding agent in this folder" });

  // 5. what the live site lets through
  if (setup && st?.project?.framework && !st.fresh) {
    const csps = cspIn(cwd);
    for (const { file, policy } of csps) {
      const gaps = cspGaps(policy, setup);
      if (gaps.length) add({ id: "csp", label: "Content policy", state: "bad", detail: `${file}: ${gaps.map((g) => `${g.need}: ${g.why}`).join("; ")}`, fix: `add ${gaps.map((g) => g.need).join(", ")} to the policy in ${file}` });
      else add({ id: "csp", label: "Content policy", state: "ok", detail: `${file} allows what GenClass needs` });
    }
  }

  // 6. the test workflow, for a project with Playwright
  const pkgText = read(join(cwd, "package.json")) ?? "";
  if (/@playwright\/test/.test(pkgText)) {
    add(existsSync(join(cwd, ".github", "workflows", "genclass.yml")) ? { id: "workflow", label: "Test workflow", state: "ok", detail: ".github/workflows/genclass.yml" } : { id: "workflow", label: "Test workflow", state: "info", detail: "your Playwright tests do not run with reordered responses on pull requests", fix: "npx genclass setup (the Test workflow step)" });
  }
  r.app = st?.project?.name ?? null;
  r.framework = st?.project?.label || null;
  return r;
}

/** The version of the `genclass` the shell runs, or null (not installed, or it did not answer in 4 s). */
function pathVersion() {
  try {
    const p = spawnSync(process.platform === "win32" ? "genclass.cmd" : "genclass", ["--version"], { encoding: "utf8", timeout: 4000, shell: process.platform === "win32", env: { ...process.env, GENCLASS_NO_INSTALL: "1" } });
    return /genclass (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(p.stdout ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
}

const MARK = { ok: () => c.green(sym.ok), warn: () => c.yellow(sym.warn), bad: () => c.red(sym.cross), info: () => c.gray(sym.dot) };

/** `genclass doctor [--fix] [--yes] [--json] [--offline]`. Exit 0 when nothing is wrong or warned about, else 1. */
export async function doctor(o = {}, deps = {}) {
  const list = await checks(o, deps);
  const wrong = list.filter((x) => x.state === "bad" || x.state === "warn");
  const fixable = list.filter((x) => x.apply);
  if (o.json && !o.fix) {
    out(JSON.stringify({ ok: wrong.length === 0, checks: list.map(({ apply, ...x }) => ({ ...x, fixable: !!apply })) }, null, 2));
    return wrong.length ? 1 : 0;
  }
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
    return wrong.length ? 1 : 0;
  }
  if (!fixable.length) {
    note("Nothing here is GenClass's own to fix: the lines above say what to run.");
    out();
    return wrong.length ? 1 : 0;
  }
  out(`  ${c.bold("To fix")}`);
  for (const x of fixable) out(`    ${sym.dot} ${x.apply.what}`);
  out();
  const yes = o.yes || (interactive() && (await agree("Write these?")));
  if (!yes) {
    note(interactive() ? "Nothing was written." : "Nothing was written: run it with --yes, or on a terminal.");
    out();
    return 1;
  }
  let failed = 0;
  for (const x of fixable) {
    try {
      if (x.apply.mkdir) (await import("node:fs")).mkdirSync(join(x.apply.file, ".."), { recursive: true });
      writeFileSync(x.apply.file, x.apply.after);
      good(`Wrote ${x.apply.what}`);
    } catch (e) {
      failed++;
      warn(`Could not write ${x.apply.what}: ${clean(e?.message ?? e, 100)}`);
    }
  }
  if (fixable.some((x) => x.id === "link")) note("Reload the dev page once, then ask your coding agent \"is GenClass connected?\": genclass_status lists the page.");
  if (fixable.some((x) => x.id === "mcp")) note("Restart your coding agent in this folder so it starts the new MCP server.");
  out();
  // what is left is the person's to do (the lines above say what): still exit 1 then
  return failed || wrong.some((x) => !x.apply) ? 1 : 0;
}
