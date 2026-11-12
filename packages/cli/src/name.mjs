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
import { accessSync, constants, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { credentialsPath } from "../../runtime/bin/lib/account.mjs";

/** Whether typing `genclass` in the person's shell runs this command. */
export function shortNameWorks(env = process.env, platform = process.platform) {
  const names = platform === "win32" ? ["genclass.cmd", "genclass.exe", "genclass.ps1"] : ["genclass"];
  for (const dir of String(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!dir || /[\\/]_npx[\\/]/.test(dir) || /node_modules[\\/]\.bin[\\/]?$/.test(dir)) continue;
    for (const n of names) {
      try {
        const file = join(dir, n);
        if (!statSync(file).isFile()) continue;
        if (platform !== "win32") accessSync(file, constants.X_OK);
        return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

/** `text` with every `npx genclass` said the short way. */
export const shorten = (text) => String(text).replace(/\bnpx genclass\b/g, "genclass");

let short = false;
let wrapped = false;

/** Whether this run prints `genclass` (true) or `npx genclass`. */
export const isShort = () => short;

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
      child = run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "-g", `genclass@${version}`, "--no-audit", "--no-fund"], { stdio: ["ignore", "pipe", "pipe"] });
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
