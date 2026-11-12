// The `genclass` command's arguments: which command runs, and its help. Loaded by main.mjs after it has named this
// CLI to the runtime CLI's modules (packages/runtime/bin/lib), which every command here reuses.
//
// Invariants:
// - One way in: `genclass` with no command shows where the project stands and, on a terminal, walks the next step.
//   Every other command is a part of that walk that can also be run alone.
// - `login`, `logout`, `whoami`, `connect`, `init` and `scan` are the runtime CLI's own commands, unchanged: this
//   file hands them their arguments. `remove` is the runtime CLI's, followed by what this command's other steps wrote
//   (remove.mjs). `dashboard` is this command's own view (app.mjs); signed out it falls back to the runtime CLI's,
//   which knows an app's private dashboard link.
// - Nothing here reads a file or the network: it parses and dispatches.

import { hostConfig } from "../../runtime/bin/lib/host.mjs";
import { c, err, out } from "../../runtime/bin/lib/ui.mjs";
import { BUILD } from "./assets.mjs";

export const USAGE = `genclass: one way to set up GenClass, and what your app needs next

  npx genclass                where this project stands; on a terminal it walks you through the next step
  npx genclass setup          the guided setup  (--yes: no questions, for a coding agent)
  npx genclass status         what is done, what is next  (--all: every part; --json: for a coding agent)
  npx genclass suggest [url]  what your app is missing, most important first  (--json, --yes, --no-model, --all)
  npx genclass dashboard      your app, whole: problems found, checks, visitors, agent, GitHub App
                              (--range 24h|7d|30d, --all, --app <name>, --open, --json)
  npx genclass scan <url>     23 visual checks on one page
  npx genclass login          sign in  (logout, whoami)
  npx genclass remove         take GenClass out of this app again

  Options: --cwd <dir>   --yes   --json   --no-browser   --help   --version

  Run it in your web app's folder. npx runs it without installing; "npm install -g genclass" makes it just "genclass".
  Every part GenClass sets up is listed by "npx genclass status --all". Docs: https://genclass.dev/docs/cli`;

const BOOL = { yes: "yes", y: "yes", json: "json", "no-browser": "noBrowser", "no-model": "noModel", all: "all", help: "help", h: "help", version: "version", v: "version", open: "open" };
const VALUE = { cwd: "cwd", url: "url", app: "app", range: "range" };

/** The flags this file knows, and what is left ({ o, rest }); an unknown flag stays in `rest` for the command it is for. */
export function parseArgs(argv) {
  const o = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const key = a.startsWith("-") ? (eq > 0 ? a.slice(0, eq) : a).replace(/^--?/, "") : null;
    if (key && BOOL[key] && eq < 0) o[BOOL[key]] = true;
    else if (key && VALUE[key]) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v === "") return { o, rest, error: `--${key} needs a value` };
      o[VALUE[key]] = v;
    } else rest.push(a);
  }
  return { o, rest };
}

/** Runs the command line. Returns the exit code. */
export async function run(argv) {
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
  const args = cmd ? argv.slice(1) : argv;

  // the runtime CLI's own commands, with their own flags and help
  if (cmd === "login" && !args.some((a) => a === "--help" || a === "-h")) {
    // a sign-in from before the command could show dashboards: "already signed in" would be a dead end for
    // `genclass dashboard`, which sends people here, so it is approved once more instead
    const again = await (await import("./app.mjs")).signInAgain(parseArgs(args).o);
    if (again !== null) return again;
  }
  if (["login", "logout", "whoami", "connect"].includes(cmd)) return (await import("../../runtime/bin/lib/login.mjs")).run(cmd, args);
  if (cmd === "remove") return (await import("./remove.mjs")).remove(args);
  if (cmd === "init") return (await import("../../runtime/bin/lib/init.mjs")).run(cmd, args);
  if (cmd === "scan" || cmd === "audit") {
    // this command carries no copy of the runtime's script-tag build, so the page check runs on genclass.dev unless asked otherwise
    const withHost = args.includes("--local") || args.includes("--hosted") || args.includes("--help") ? args : [...args, "--hosted"];
    return (await import("../../runtime/bin/lib/scan.mjs")).run(cmd, withHost);
  }

  const { o, rest, error } = parseArgs(args);
  if (error) {
    err(`genclass: ${error}\n\n${USAGE}`);
    return 2;
  }
  if (o.version || cmd === "version") {
    out(`genclass ${BUILD.version} (installs @genclass/runtime ${BUILD.runtimeVersion}, @genclass/mcp ${BUILD.mcpVersion})`);
    return 0;
  }
  if (o.help || cmd === "help") {
    out(USAGE);
    return 0;
  }
  const h = hostConfig();
  if (h.error) {
    err(`genclass: ${h.error}`);
    return 2;
  }
  const runSuggest = async (so) => (await import("./suggest/index.mjs")).suggest(so);
  if (cmd === "suggest") {
    const url = o.url ?? rest.find((a) => !a.startsWith("-")) ?? null;
    const unknown = rest.filter((a) => a.startsWith("-"));
    if (unknown.length) {
      err(`genclass suggest: unknown option ${unknown[0]}\n\n${USAGE}`);
      return 2;
    }
    return runSuggest({ ...o, url });
  }
  if (rest.length) {
    err(`genclass: unknown ${rest[0].startsWith("-") ? "option" : "command"} ${c.bold(rest[0])}\n\n${USAGE}`);
    return 2;
  }
  if (cmd === "dashboard") {
    // signed out, the runtime CLI's own command still knows an app's private dashboard link
    const fallback = async () => (await import("../../runtime/bin/lib/login.mjs")).run("dashboard", args);
    return (await import("./app.mjs")).dashboard(o, { fallback });
  }
  const { setup, status } = await import("./setup.mjs");
  if (cmd === "status") return status(o);
  if (cmd === "setup" || cmd === null) return setup(o, { runSuggest });
  const near = nearest(cmd);
  err(`genclass: unknown command ${c.bold(cmd)}${near ? `. Did you mean ${c.cyan(`npx genclass ${near}`)}?` : ""}\n\n${USAGE}`);
  return 2;
}

const COMMANDS = ["setup", "status", "suggest", "dashboard", "scan", "login", "logout", "whoami", "connect", "init", "remove", "help", "version"];

/** The command a mistyped one is closest to (at most two edits away), or null. */
export function nearest(word) {
  const w = String(word).toLowerCase();
  let best = null;
  let bestD = 3;
  for (const cmd of COMMANDS) {
    const d = edits(w, cmd);
    if (d < bestD) {
      best = cmd;
      bestD = d;
    }
  }
  return best;
}

/** Levenshtein distance. */
function edits(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
