// How the command is typed on this machine: `genclass` once it is installed, `npx genclass` until then.
//
// Why: `npx genclass` runs the command without installing it, so a screen that says "genclass suggest" names a
// command that does not exist for that person. Every text this program prints is written with `npx genclass`, the
// form that always works; when `genclass` itself is on the PATH, what is printed says `genclass` instead (shorten).
//
// Invariants:
// - "On the PATH" means a folder the person's shell would search: the folder npx puts on the PATH for the run it
//   started (under _npx) and a project's own node_modules/.bin do not count, because the shell that comes back when
//   this command ends does not have them.
// - Installing is asked first, shown as the command it runs (`npm install -g genclass`), and asked once: the answer
//   is remembered next to the sign-in. Nothing is installed with --yes, without a terminal, or in CI.

import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { credentialsPath } from "../../runtime/bin/lib/account.mjs";

/** Whether this run was started by npx (a copy npx fetched for this run), not the installed `genclass`. */
export const viaNpx = (argv1 = process.argv[1] ?? "") => /[\\/]_npx[\\/]/.test(String(argv1));

/** The file typing `genclass` in the person's shell runs, or null. */
function shortNameFile(env = process.env, platform = process.platform) {
  const names = platform === "win32" ? ["genclass.cmd", "genclass.exe", "genclass.ps1"] : ["genclass"];
  for (const dir of String(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!dir || /[\\/]_npx[\\/]/.test(dir) || /node_modules[\\/]\.bin[\\/]?$/.test(dir)) continue;
    for (const n of names) {
      try {
        const file = join(dir, n);
        if (!statSync(file).isFile()) continue;
        if (platform !== "win32") accessSync(file, constants.X_OK);
        return file;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * The version of the installed `genclass` (the package its command links to), or null when it cannot be told (not
 * installed, a Windows shim, a copy that is not the npm package).
 */
export function installedVersion(env = process.env, platform = process.platform) {
  const file = shortNameFile(env, platform);
  if (!file || platform === "win32") return null;
  try {
    // <prefix>/bin/genclass links to <prefix>/lib/node_modules/genclass/bin/genclass.mjs
    const pkg = join(dirname(dirname(realpathSync(file))), "package.json");
    const j = JSON.parse(readFileSync(pkg, "utf8"));
    return j?.name === "genclass" && typeof j.version === "string" ? j.version : null;
  } catch {
    return null;
  }
}

/** a > b for versions like 0.3.9 (a prerelease sorts before its release). */
export function newer(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v ?? ""));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  if (x[3] === y[3]) return false;
  return x[3] === null ? true : y[3] === null ? false : x[3] > y[3];
}

/** The newest genclass on npm (`latest`), or null within `timeoutMs` (no network, an error): best effort. */
export async function latestOnNpm(fetchFn = globalThis.fetch, timeoutMs = 2000) {
  if (typeof fetchFn !== "function") return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn("https://registry.npmjs.org/genclass/latest", { headers: { accept: "application/json" }, signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j?.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(j.version) ? j.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Whether typing `genclass` in the person's shell runs this command. */
export function shortNameWorks(env = process.env, platform = process.platform) {
  return shortNameFile(env, platform) !== null;
}

/** `text` with every `npx genclass` said the short way. */
export const shorten = (text) => String(text).replace(/(^|[^\w-]|\u001b\[[0-9;]*m)npx genclass\b/g, "$1genclass");

let short = false;
let wrapped = false;

/** Whether this run prints `genclass` (true) or `npx genclass`. */
export const isShort = () => short;

/** For tests: this process has not decided yet how the command is typed (what is printed keeps its shortening). */
export const forgetShortName = () => {
  short = false;
};

/**
 * From now on everything this process prints says `genclass` (the name works here): the runtime CLI's modules are
 * told through the name they read, and what is written to the terminal is shortened on its way out.
 */
export function useShortName() {
  short = true;
  if (globalThis.__GENCLASS_CLI__) globalThis.__GENCLASS_CLI__.cmd = "genclass";
  if (wrapped) return;
  wrapped = true;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => write(typeof chunk === "string" ? shorten(chunk) : chunk, ...rest);
  }
}

const prefsFile = () => join(dirname(credentialsPath()), "prefs.json");

/** What this command remembers for the person, not for a project (best effort: unreadable is "nothing"). */
export function readPrefs() {
  try {
    const j = JSON.parse(readFileSync(prefsFile(), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

export function savePrefs(patch) {
  try {
    mkdirSync(dirname(prefsFile()), { recursive: true, mode: 0o700 });
    writeFileSync(prefsFile(), `${JSON.stringify({ ...readPrefs(), ...patch }, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Runs `npm install -g genclass@<version>`. Resolves { ok, text }: npm's last lines when it failed. */
export function installGlobally(version, run = spawn) {
  return new Promise((resolve) => {
    let text = "";
    let child;
    try {
      // on Windows npm is a .cmd file, which Node starts only through a shell; every argument here is this program's own
      const win = process.platform === "win32";
      child = run(win ? "npm.cmd" : "npm", ["install", "-g", `genclass@${/^[0-9A-Za-z.-]+$/.test(String(version)) ? version : "latest"}`, "--no-audit", "--no-fund"], { stdio: ["ignore", "pipe", "pipe"], shell: win });
    } catch (e) {
      resolve({ ok: false, text: String(e?.message ?? e) });
      return;
    }
    child.stdout?.on("data", (d) => (text += d));
    child.stderr?.on("data", (d) => (text += d));
    child.on("error", (e) => resolve({ ok: false, text: String(e?.message ?? e) }));
    child.on("close", (code) => resolve({ ok: code === 0, text: text.trim().split("\n").slice(-4).join("\n") }));
  });
}
