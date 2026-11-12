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
import { c, err, interactive, out } from "../../runtime/bin/lib/ui.mjs";
import { BUILD } from "./assets.mjs";

export const USAGE = `genclass: GenClass in your terminal. Set it up, see what it finds, have it fixed.

  npx genclass                where this project stands; on a terminal it walks you through the
                              next step, then stays open for commands and questions
  npx genclass setup          the guided setup  (--yes: no questions, for a coding agent)
  npx genclass status         what is done, what is next  (--all: every part; --json)

  See
  npx genclass dashboard      your app, whole: problems found, checks, visitors, agent, GitHub App
  npx genclass problems       every problem found, by kind and page, and what GenClass did about it
  npx genclass analytics      visitors: visits, pages, time, where they come from, what they click
                              (one part in full: analytics pages | sources | devices | clicks | paths | funnels)
  npx genclass events         the latest events, one per line  (--all: each one's mode and trigger)
  npx genclass health         how GenClass itself runs on your pages  (--all: every breakdown)
  npx genclass report         the period as Markdown  (--out report.md)
  npx genclass export         every stored event, as a file  (--from, --to, --format csv, --out)

  Act
  npx genclass fix            hand a problem to your coding agent  (fix 2 | fix stale | fix all;
                              --print, --copy, --agent claude | codex | cursor-agent | gemini)
  npx genclass ask "..."      ask about your app in plain words; the model answers from its numbers
  npx genclass suggest [url]  what your app is missing, most important first  (--yes, --no-model, --all)
  npx genclass scan <url>     23 visual checks on one page

  Connect
  npx genclass connections    where alerts go (Slack, Sentry, PostHog, Datadog, a webhook), GitHub, agent
                              (connections add | test | on | off | remove <kind>)
  npx genclass agent          your coding agent: is it connected, what it did  (agent link: give it
                              the live site's numbers)
  npx genclass funnels        funnels  (funnels add "Name" /a /b /c | funnels remove "Name")

  Account
  npx genclass apps           your apps  (apps new "Name")
  npx genclass plan           your plan, its limits and what is used; start the paid plan  (--open)
  npx genclass team           who is on the plan  (team invite)
  npx genclass login          sign in  (logout, whoami)
  npx genclass remove         take GenClass out of this app again

  Options: --app <name>   --range 24h|7d|30d|90d|1y   --all   --json   --cwd <dir>   --yes
           --no-browser   --help   --version

  Run it in your web app's folder. npx runs it without installing; "npm install -g genclass" makes it just "genclass".
  Every part GenClass sets up is listed by "npx genclass status --all". Docs: https://genclass.dev/docs/cli`;

const BOOL = { yes: "yes", y: "yes", json: "json", "no-browser": "noBrowser", "no-model": "noModel", all: "all", help: "help", h: "help", version: "version", v: "version", open: "open", print: "print", copy: "copy" };
const VALUE = { cwd: "cwd", url: "url", app: "app", range: "range", from: "from", to: "to", format: "format", out: "out", agent: "agent" };

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

/**
 * Runs the command line. Returns the exit code. `ctx.nested`: called from the home (home.mjs), so the setup walk
 * does not open a second home when it ends.
 */
export async function run(argv, ctx = {}) {
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
  // on Free, a command run on its own ends with one line saying so, and the way up (the home says it after each)
  const upsold = async (code, line = true) => {
    const c0 = await code;
    if (line && !ctx.nested && !o.json && !o.yes && interactive()) {
      try {
        await (await import("./manage.mjs")).freeLine(o);
      } catch {
        /* best effort */
      }
    }
    return c0;
  };
  if (cmd === "suggest") {
    const url = o.url ?? rest.find((a) => !a.startsWith("-")) ?? null;
    const unknown = rest.filter((a) => a.startsWith("-"));
    if (unknown.length) {
      err(`genclass suggest: unknown option ${unknown[0]}\n\n${USAGE}`);
      return 2;
    }
    return upsold(runSuggest({ ...o, url }));
  }
  if (cmd !== null && !COMMANDS.includes(cmd)) {
    const near = nearest(cmd);
    err(`genclass: unknown command ${c.bold(cmd)}${near ? `. Did you mean ${c.cyan(`npx genclass ${near}`)}?` : ""}\n\n${USAGE}`);
    return 2;
  }
  // the commands that take words after their name: sections, picks, subcommands, a question
  const words = rest.filter((a) => !a.startsWith("-"));
  const flags = rest.filter((a) => a.startsWith("-"));
  const WORDY = ["analytics", "fix", "ask", "connections", "agent", "funnels", "apps", "team"];
  if (flags.length || (words.length && !WORDY.includes(cmd))) {
    const bad = flags[0] ?? words[0];
    err(`genclass: unknown ${bad.startsWith("-") ? "option" : "command"} ${c.bold(bad)}\n\n${USAGE}`);
    return 2;
  }
  if (cmd === "dashboard") {
    // signed out, the runtime CLI's own command still knows an app's private dashboard link
    const fallback = async () => (await import("../../runtime/bin/lib/login.mjs")).run("dashboard", [...(o.cwd ? ["--cwd", o.cwd] : []), ...(o.open ? ["--open"] : [])]);
    return upsold((await import("./app.mjs")).dashboard(o, { fallback }));
  }
  if (["problems", "events", "health", "report"].includes(cmd)) return upsold((await import("./views.mjs"))[cmd](o), cmd !== "report");
  if (cmd === "analytics") {
    const { analytics, ANALYTICS_SECTIONS } = await import("./views.mjs");
    if (words[0] && !ANALYTICS_SECTIONS.includes(words[0])) {
      err(`genclass analytics: there is no part ${c.bold(words[0])}. The parts: ${ANALYTICS_SECTIONS.join(", ")}`);
      return 2;
    }
    return upsold(analytics({ ...o, section: words[0] ?? null }));
  }
  if (cmd === "agent") {
    if (words[0] === "link") return (await import("./manage.mjs")).agentLink(o);
    if (words[0]) {
      err(`genclass agent: there is no ${c.bold(words[0])}. Try ${c.cyan("npx genclass agent")} or ${c.cyan("npx genclass agent link")}`);
      return 2;
    }
    return (await import("./views.mjs")).agent(o);
  }
  if (cmd === "fix") return upsold((await import("./fix.mjs")).fix({ ...o, what: words.join(" ") || null }));
  if (cmd === "ask") return upsold((await import("./ask.mjs")).ask({ ...o, question: words.join(" ") }));
  if (["apps", "plan", "team", "connections", "funnels", "profile", "upgrade"].includes(cmd)) return upsold((await import("./manage.mjs"))[cmd]({ ...o, args: words }), ["apps", "connections", "funnels"].includes(cmd));
  if (cmd === "export") return (await import("./manage.mjs")).exportEvents(o);
  const { setup, status } = await import("./setup.mjs");
  if (cmd === "status") return status(o);
  if (cmd === "setup" || cmd === null) {
    // on a terminal the command stays open when the walk ends: a prompt for commands and questions (home.mjs)
    const home = async (ho) => (await import("./home.mjs")).home(ho, { runCommand: (a) => run(a, { nested: true }), nearest, afterCommand: async () => (await import("./manage.mjs")).freeLine({ cwd: ho.cwd }) });
    // `genclass` alone works from the first run on (home.mjs installShortName)
    if (!ctx.nested && !o.yes && !o.json) await (await import("./home.mjs")).installShortName();
    return setup({ ...o, ...(ctx.nested ? { home: false } : {}) }, { runSuggest, home });
  }
  return 2;
}

/** Every command, for the "did you mean" of a mistyped one. */
export const COMMANDS = [
  "setup", "status", "suggest", "dashboard", "problems", "analytics", "events", "health", "report", "export", "fix", "ask", "scan", "connections", "agent", "funnels",
  "apps", "plan", "upgrade", "profile", "team", "login", "logout", "whoami", "connect", "init", "remove", "help", "version",
];

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
