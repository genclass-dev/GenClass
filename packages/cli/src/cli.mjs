// The `genclass` command's arguments: which command runs, and its help. Loaded by main.mjs after it has named this
// CLI to the runtime CLI's modules (packages/runtime/bin/lib), which every command here reuses.
//
// Invariants:
// - One way in: `genclass` with no command shows where the project stands and, on a terminal, walks the next step.
//   Every other command is a part of that walk that can also be run alone.
// - `login`, `logout`, `whoami`, `connect`, `init` and `scan` are the runtime CLI's own commands: this file hands
//   them their arguments. `genclass login` only signs in (the runtime login with --no-connect), then shows Pro for an
//   account without it, and offers to connect this folder's app once Pro is on. `remove` is the runtime CLI's,
//   followed by what this command's other steps wrote (remove.mjs). `dashboard` is this command's own view
//   (app.mjs); signed out, in a folder with an app's private link, it prints that link (the runtime CLI's own).
// - The command is Pro's (the owner's call, 2026-11-13): every command but FREE_COMMANDS passes paywall.mjs
//   requirePro first (signed out: the sign-in, then Pro with its free trial), the home's commands (ctx.nested)
//   included. The walk (`genclass`, `setup`) has Pro as its own step right after the sign-in (state.mjs).
// - Every opt-out keeps working without Pro (AGENTS.md rule 8): `init --no-telemetry` and `init --telemetry` on an
//   app that has GenClass change only that option, and pass without the gate.
// - A command's own usage errors come before the gate: nothing is asked of genclass.dev for words that are wrong.
// - Nothing here reads the network but that gate, and nothing reads a file but the two checks before it (whether
//   the app has GenClass, for the opt-out; its private dashboard link, signed out): it parses and dispatches.

import { hostConfig } from "../../runtime/bin/lib/host.mjs";
import { c, err, interactive, out } from "../../runtime/bin/lib/ui.mjs";
import { BUILD } from "./assets.mjs";
import { width, wrap } from "./tui.mjs";

/** The help's sections: [heading, [command, what it does]...]; usage() lays them out for the terminal's width. */
const HELP = [
  [null, [
    ["npx genclass", "where this project stands; on a terminal it walks you through the next step, then stays open for commands and questions"],
    ["npx genclass setup", "the guided setup (--yes: no questions, for a coding agent)"],
    ["npx genclass status", "what is done, what is next (--all: every part; --json)"],
  ]],
  ["See", [
    ["npx genclass dashboard", "your app, whole: problems found, checks, visitors, agent, GitHub App"],
    ["npx genclass problems", "every problem found, by kind and page, and what GenClass did about it"],
    ["npx genclass analytics", "visitors: visits, pages, time, where they come from, what they click (one part in full: analytics pages | sources | devices | clicks | paths | funnels)"],
    ["npx genclass events", "the latest events, one per line (--all: each one's mode and trigger)"],
    ["npx genclass health", "how GenClass itself runs on your pages (--all: every breakdown)"],
    ["npx genclass report", "the period as Markdown (--out report.md)"],
    ["npx genclass export", "every stored event, as a file (--from, --to, --format csv, --out)"],
  ]],
  ["Act", [
    ["npx genclass fix", "hand a problem to your coding agent (fix 2 | fix stale | fix all; --print, --copy, --agent claude | codex | cursor-agent | gemini)"],
    ['npx genclass ask "..."', "ask about your app in plain words; the model answers from its numbers"],
    ["npx genclass suggest [url]", "what your app is missing, most important first (--yes, --no-model, --all)"],
    ["npx genclass scan <url>", "23 visual checks on one page"],
  ]],
  ["Connect", [
    ["npx genclass connections", "where alerts go (Slack, Sentry, PostHog, Datadog, a webhook), GitHub, agent (connections add | test | on | off | remove <kind>)"],
    ["npx genclass agent", "your coding agent: is it connected, what it did (agent link: give it the live site's numbers)"],
    ["npx genclass funnels", 'funnels (funnels add "Name" /a /b /c | funnels remove "Name")'],
  ]],
  ["Account", [
    ["npx genclass apps", 'your apps (apps new "Name")'],
    ["npx genclass plan", "your plan, its limits and what is used (--open: billing in the browser)"],
    ["npx genclass upgrade", "start Pro (its free trial first), in the browser"],
    ["npx genclass profile", "your account and plan, as numbered choices"],
    ["npx genclass team", "who is on the plan (team invite)"],
    ["npx genclass login", "sign in (logout, whoami)"],
    ["npx genclass remove", "take GenClass out of this app again"],
  ]],
];

/**
 * The help, laid out for `cols` columns (the terminal's): a command and its words side by side on a wide terminal,
 * the words under the command on a narrow one (58 columns and up), every line within `cols`.
 */
export function usage(cols = width()) {
  const w = Math.max(40, cols - 2);
  const lines = [];
  const text = (t, indent = "") => {
    for (const l of wrap(t, w - indent.length)) lines.push(`${indent}${l}`);
  };
  text("genclass: GenClass in your terminal. Set it up, see what it finds, have it fixed.");
  lines.push("");
  text("The genclass command comes with Pro: 3 days free, then $15 / developer / month, with a card on Stripe. Without Pro: login, logout, whoami, status, plan, upgrade, profile, remove, help. Free is on the website: https://genclass.dev", "  ");
  const side = w >= 78;
  const col = 30;
  for (const [head, rows] of HELP) {
    lines.push("");
    if (head) lines.push(`  ${head}`);
    for (const [cmd, what] of rows) {
      if (side) {
        const words = wrap(what, w - col);
        lines.push(`  ${cmd.padEnd(col - 2)}${words[0] ?? ""}`);
        for (const l of words.slice(1)) lines.push(`${" ".repeat(col)}${l}`);
      } else {
        lines.push(`  ${cmd}`);
        for (const l of wrap(what, w - 6)) lines.push(`      ${l}`);
      }
    }
  }
  lines.push("");
  text("Options: --app <name>  --range 24h|7d|30d|90d|1y  --all  --json  --cwd <dir>  --yes  --no-browser  --help  --version", "  ");
  lines.push("");
  text('Run it in your web app\'s folder. npx runs it without installing; "npm install -g genclass" makes it just "genclass". Every part GenClass sets up is listed by "npx genclass status --all". Docs: https://genclass.dev/docs/cli', "  ");
  return lines.join("\n");
}

/** The help at the default width (80 columns), for tests and anything that wants it as one string. */
export const USAGE = usage(80);

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

  // the genclass command is Pro's: a command asks genclass.dev first (paywall.mjs requirePro), once its words are
  // known to be right. Not: signing in and out, the plan, help, the version, status (where things stand, Pro's step
  // included), remove, and the walk, whose own Pro step comes right after the sign-in. A command typed in the home
  // asks too: the home opens on q at any step, the sign-in's included (once Pro is seen, it is not asked again)
  const asksHelp = args.some((a) => ["--help", "-h", "--version", "-v"].includes(a));
  const paid = async () => {
    if (asksHelp || FREE_COMMANDS.includes(cmd)) return 0;
    const h = hostConfig();
    if (h.error) {
      err(`genclass: ${h.error}`);
      return 2;
    }
    return (await import("./paywall.mjs")).requirePro(parseArgs(args).o);
  };

  // the runtime CLI's own commands, with their own flags and help
  if (cmd === "login" && !args.some((a) => a === "--help" || a === "-h")) {
    // a sign-in from before the command could show dashboards: "already signed in" would be a dead end for
    // `genclass dashboard`, which sends people here, so it is approved once more instead
    const again = await (await import("./app.mjs")).signInAgain(parseArgs(args).o);
    if (again !== null) return again;
  }
  // an app that login, connect or init put in the account opens its plan page next (actions.mjs planNow)
  const i = args.indexOf("--cwd");
  const po = { cwd: i >= 0 ? args[i + 1] : undefined, yes: args.includes("--yes") || args.includes("-y"), json: args.includes("--json"), noBrowser: args.includes("--no-browser") };
  const thenPlan = async (code) => {
    if (code !== 0) return code;
    await (await import("./actions.mjs")).planNow(po).catch(() => "none");
    return code;
  };
  if (["logout", "whoami"].includes(cmd)) return (await import("../../runtime/bin/lib/login.mjs")).run(cmd, args);
  if (cmd === "login") {
    // the sign-in only; then Pro (paywall.mjs afterLogin) for an account without it; this folder's app is offered
    // to the account (the runtime login's own question) only once Pro is on, so nothing is written before Pro's card
    const login = await import("../../runtime/bin/lib/login.mjs");
    const noConnect = args.includes("--no-connect");
    const code = await login.run(cmd, noConnect || asksHelp ? args : [...args, "--no-connect"]);
    if (code !== 0 || asksHelp) return code;
    if (!(await (await import("./paywall.mjs")).afterLogin(po).catch(() => true))) return code;
    return thenPlan(noConnect ? code : await login.offerConnect(args).catch(() => 1));
  }
  if (cmd === "remove") return (await import("./remove.mjs")).remove(args);
  if (["connect", "init", "scan", "audit"].includes(cmd)) {
    // words the command does not take: its own usage error, before anything is asked of genclass.dev
    if (!asksHelp && !(await argsRight(cmd, args))) {
      if (cmd === "connect") return (await import("../../runtime/bin/lib/login.mjs")).run(cmd, args);
      if (cmd === "init") return (await import("../../runtime/bin/lib/init.mjs")).run(cmd, args);
      return (await import("../../runtime/bin/lib/scan.mjs")).run(cmd, args);
    }
    // the opt-out the setup prints works for everyone (AGENTS.md rule 8): on an app with GenClass in it, init
    // --no-telemetry (or --telemetry, to undo it) changes that one option, here on this machine
    const optOut = cmd === "init" && telemetryOnly(args) && !(await import("../../runtime/bin/lib/init.mjs")).inspectProject({ cwd: po.cwd }).fresh;
    const gate = optOut ? 0 : await paid();
    if (gate !== 0) {
      if (cmd !== "scan" && cmd !== "audit") return gate;
      // a scan's exit code 1 means "problems found": a scan that did not run ends with 2, and says where the page
      // check is free
      if (!po.json && gate === 1) {
        const { REPORT_PAGE } = await import("../../runtime/bin/lib/scan.mjs");
        out(`  ${c.gray("Free, without Pro: the page check on the website")}`);
        out(`    ${c.cyan(REPORT_PAGE)}`);
        out();
      }
      return 2;
    }
  }
  if (cmd === "connect") return thenPlan(await (await import("../../runtime/bin/lib/login.mjs")).run(cmd, args));
  if (cmd === "init") return thenPlan(await (await import("../../runtime/bin/lib/init.mjs")).run(cmd, args));
  if (cmd === "scan" || cmd === "audit") {
    // this command carries no copy of the runtime's script-tag build, so the page check runs on genclass.dev unless asked otherwise
    const withHost = args.includes("--local") || args.includes("--hosted") || args.includes("--help") ? args : [...args, "--hosted"];
    return (await import("../../runtime/bin/lib/scan.mjs")).run(cmd, withHost);
  }

  const { o, rest, error } = parseArgs(args);
  if (error) {
    err(`genclass: ${error}\n\n${usage()}`);
    return 2;
  }
  if (o.version || cmd === "version") {
    out(`genclass ${BUILD.version} (installs @genclass/runtime ${BUILD.runtimeVersion}, @genclass/mcp ${BUILD.mcpVersion})`);
    return 0;
  }
  if (o.help || cmd === "help") {
    out(usage());
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
      err(`genclass suggest: unknown option ${unknown[0]}\n\n${usage()}`);
      return 2;
    }
    const gate = await paid();
    if (gate !== 0) return gate;
    return upsold(runSuggest({ ...o, url }));
  }
  if (cmd !== null && !COMMANDS.includes(cmd)) {
    const near = nearest(cmd);
    err(`genclass: unknown command ${c.bold(cmd)}${near ? `. Did you mean ${c.cyan(`npx genclass ${near}`)}?` : ""}\n\n${usage()}`);
    return 2;
  }
  // the commands that take words after their name: sections, picks, subcommands, a question
  const words = rest.filter((a) => !a.startsWith("-"));
  const flags = rest.filter((a) => a.startsWith("-"));
  const WORDY = ["analytics", "fix", "ask", "connections", "agent", "funnels", "apps", "team"];
  if (flags.length || (words.length && !WORDY.includes(cmd))) {
    const bad = flags[0] ?? words[0];
    err(`genclass: unknown ${bad.startsWith("-") ? "option" : "command"} ${c.bold(bad)}\n\n${usage()}`);
    return 2;
  }
  // the words of the commands that take them, before anything is asked of genclass.dev
  const { ANALYTICS_SECTIONS } = cmd === "analytics" ? await import("./views.mjs") : { ANALYTICS_SECTIONS: [] };
  if (cmd === "analytics" && words[0] && !ANALYTICS_SECTIONS.includes(words[0])) {
    err(`genclass analytics: there is no part ${c.bold(words[0])}. The parts: ${ANALYTICS_SECTIONS.join(", ")}`);
    return 2;
  }
  if (cmd === "agent" && words[0] && words[0] !== "link") {
    err(`genclass agent: there is no ${c.bold(words[0])}. Try ${c.cyan("npx genclass agent")} or ${c.cyan("npx genclass agent link")}`);
    return 2;
  }
  // signed out, the runtime CLI's own command still knows an app's private dashboard link (.genclass.local): it is
  // printed as before, with no sign-in and no Pro (it is on this machine already)
  const fallback = async () => (await import("../../runtime/bin/lib/login.mjs")).run("dashboard", [...(o.cwd ? ["--cwd", o.cwd] : []), ...(o.open ? ["--open"] : [])]);
  if (cmd === "dashboard" && !o.json && !o.app && (await privateLinkHere(o.cwd))) return fallback();
  if (cmd !== null && !["setup", "status"].includes(cmd)) {
    const gate = await paid();
    if (gate !== 0) return gate;
  }
  if (cmd === "dashboard") return upsold((await import("./app.mjs")).dashboard(o, { fallback }));
  if (["problems", "events", "health", "report"].includes(cmd)) return upsold((await import("./views.mjs"))[cmd](o), cmd !== "report");
  if (cmd === "analytics") return upsold((await import("./views.mjs")).analytics({ ...o, section: words[0] ?? null }));
  if (cmd === "agent") {
    if (words[0] === "link") return (await import("./manage.mjs")).agentLink(o);
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

/** init's options that leave what it does at the telemetry switch: where, whether to ask, and what not to run. */
const TOGGLE_WITH = new Set(["--yes", "-y", "--dry-run", "--no-install", "--no-network"]);

/** Whether `init`'s arguments only turn the anonymous diagnostics off (--no-telemetry) or back on (--telemetry). */
export function telemetryOnly(args) {
  let toggle = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--cwd") i++;
    else if (a.startsWith("--cwd=")) continue;
    else if (a === "--no-telemetry" || a === "--telemetry") toggle = true;
    else if (!TOGGLE_WITH.has(a)) return false;
  }
  return toggle;
}

/** Whether a runtime command's words are ones it takes (a parse only: nothing is read or sent). */
async function argsRight(cmd, args) {
  try {
    if (cmd === "init") {
      const { parse } = await import("../../runtime/bin/lib/init.mjs");
      parse(args);
      return true;
    }
    if (cmd === "connect") return (await import("../../runtime/bin/lib/login.mjs")).argsError("connect", args) === null;
    // scan and audit: their flags, and one address that is a URL
    const { normaliseUrl } = await import("../../runtime/bin/lib/scan.mjs");
    const urls = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (["--json", "--phone", "--hosted", "--local"].includes(a) || /^--(timeout|cwd)=./.test(a)) continue;
      if (a === "--timeout" || a === "--cwd") {
        if (args[++i] === undefined) return false;
        continue;
      }
      if (a.startsWith("-")) return false;
      urls.push(a);
    }
    if (urls.length !== 1) return false;
    normaliseUrl(urls[0]);
    return true;
  } catch {
    return false;
  }
}

/** Signed out, in a folder whose app has a private dashboard link (init without an account wrote it). */
async function privateLinkHere(cwd) {
  try {
    const { readCredentialsFor } = await import("../../runtime/bin/lib/account.mjs");
    if (readCredentialsFor().creds) return false;
    const st = (await import("../../runtime/bin/lib/init.mjs")).inspectProject({ cwd });
    return !!st.local?.dashboardUrl && (!st.token || st.local.token === st.token);
  } catch {
    return false;
  }
}

/** The commands that work without Pro: signing in and out, the plan itself, where things stand, help, the version, and taking GenClass out. */
export const FREE_COMMANDS = ["login", "logout", "whoami", "plan", "upgrade", "profile", "status", "remove", "help", "version"];

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
