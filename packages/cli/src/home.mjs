// The command's home: what `genclass` typed alone opens, straight away, and what `npx genclass` opens once the folder
// is set up (before that it walks the setup first; `genclass setup` walks it any time). It stays open. Type a
// command, or a question about your app, as often as you like; q leaves.
//
// Invariants:
// - Everything here is also a command of its own (`genclass dashboard`, `genclass analytics`, ...): the home only
//   saves typing the name in front, and keeps the folder that was chosen at the start.
// - Simple first: the list of commands is short numbered lines, shown once and again on an empty Enter or `help`.
//   A number runs that command. A mistyped command names the nearest one. A line that is not a command and reads
//   like a sentence is a question (ask.mjs).
// - After every command, an app on Free that can have a paid plan here is told so in one line (the owner's call,
//   2026-11-12: every query says it), with the way up: upgrade.
// - It never opens without someone at a terminal: piped, in CI or with --yes the command prints and ends as before.
// - A command that fails does not end the home: its message is printed and the prompt comes back.

import { c, interactive, out } from "../../runtime/bin/lib/ui.mjs";
import { BUILD } from "./assets.mjs";
import { installedVersion, installGlobally, latestOnNpm, newer, readPrefs, savePrefs, shortNameWorks, useShortName, viaNpx } from "./name.mjs";
import { planName } from "./state.mjs";
import { clean, header, inHome, note, PROMPT, rule, spinner, typed, warn } from "./tui.mjs";

/** The commands of the home, in the order they are listed: [what is typed, what it is, shown in the short list]. */
export const COMMANDS = [
  ["dashboard", "what GenClass found on your live site", true],
  ["problems", "every problem, by kind and page", true],
  ["analytics", "visitors, pages, sources, clicks", true],
  ["events", "the latest events, one per line", true],
  ["fix", "hand a problem to your coding agent", true],
  ["ask", "ask about your app (or just type it)", true],
  ["connections", "alerts, GitHub, your coding agent", true],
  ["suggest", "what your app is missing", true],
  ["profile", "your account and plan, and upgrade", true],
  ["health", "how GenClass runs on your pages", false],
  ["report", "the period as Markdown", false],
  ["export", "every stored event, as a file", false],
  ["agent", "your coding agent and what it did", false],
  ["funnels", "funnels through your pages", false],
  ["scan <url>", "check one page", false],
  ["site <url>", "check your whole site, signed in too", false],
  ["apps", "the apps in your account", false],
  ["plan", "your plan and what it includes", false],
  ["upgrade", "start Pro, or see what your plan has", false],
  ["team", "the people on your plan", false],
  ["status", "where the setup stands", false],
  ["setup", "walk the setup again", false],
  ["login", "sign in (logout, whoami)", false],
  ["remove", "take GenClass out of this app", false],
];

const NAMES = [...COMMANDS.map(([n]) => n.split(" ")[0]), "logout", "whoami", "version", "connect", "init", "audit"];

/** The short list on Free (the account has no Pro): the commands that work there, numbered on their own. */
export const FREE_MENU = [
  ["upgrade", "start Pro: its free trial first"],
  ["setup", "set this app up (free)"],
  ["fix <url>", "fix a page's 3 worst problems (free)"],
  ["scan <url>", "check a page's score (free)"],
  ["profile", "your account and plan"],
  ["plan", "your plan and its limits"],
  ["status", "where the setup stands"],
];

/** Words in front of a command that change nothing ("show problems", "open dashboard"). */
const VERBS = new Set(["show", "open", "see", "run", "view", "go", "list"]);

/** A typed line as arguments: spaces separate, single or double quotes keep words together. */
export function words(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line)))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * What a typed line is: { quit }, { help }, { command: argv }, { question: text } or { unknown: word } ({ number }
 * too for a number no command has). `numbered`: the list the numbers are of (the short one on Free).
 */
export function read(line, known = NAMES, numbered = COMMANDS) {
  const text = String(line ?? "").trim();
  if (!text) return { help: true };
  let argv = words(text);
  // a command typed whole, as a screen printed it (npx genclass fix), is that command
  if (argv[0] === "npx" && argv[1] === "genclass") argv = argv.slice(2);
  else if (argv[0] === "genclass") argv = argv.slice(1);
  if (!argv.length) return { help: true };
  const head = argv[0].toLowerCase();
  if (["q", "quit", "exit", "bye"].includes(head)) return { quit: true };
  // a number is the command listed with it
  if (/^\d+$/.test(head) && argv.length === 1) {
    const cmd = numbered[Number(head) - 1];
    return cmd ? { command: [cmd[0].split(" ")[0]] } : { unknown: head, number: true };
  }
  if (head === "help" || head === "?" || head === "commands") return { help: true, all: true };
  if (known.includes(head)) return { command: [head, ...argv.slice(1)] };
  // "show problems": a verb in front of a command is that command
  if (VERBS.has(head) && argv[1] && known.includes(argv[1].toLowerCase())) return { command: [argv[1].toLowerCase(), ...argv.slice(2)] };
  // a sentence, or anything ending in a question mark, is a question about the app
  if (argv.length >= 3 || /\?\s*$/.test(text)) return { question: text };
  return { unknown: argv[0] };
}

/**
 * The list of commands: the short one, or every command. On Free (`free`) the short one is FREE_MENU, the commands
 * that work without Pro, and every command is listed by name only.
 */
export function menu(all = false, free = false) {
  out();
  if (free) {
    out(`  ${c.bold("What next?")} ${c.gray(all ? "Every command:" : "A number or a command.")}`);
    if (all) {
      const names = COMMANDS.map(([n]) => n);
      for (let i = 0; i < names.length; i += 4) out(`    ${c.cyan(names.slice(i, i + 4).map((n) => n.padEnd(13)).join(""))}`);
      note("All but setup, apps, upgrade, profile, plan, status, login, remove, scan <url> and fix <url> come with Pro.");
      return;
    }
    const pad = Math.max(...FREE_MENU.map(([n]) => n.length)) + 2;
    FREE_MENU.forEach(([name, what], i) => out(`  ${c.gray(String(i + 1).padStart(2))}  ${c.cyan(name.padEnd(pad))}${c.gray(what)}`));
    out(`      ${c.cyan("help".padEnd(pad))}${c.gray("every command")}   ${c.cyan("q")} ${c.gray("leave")}`);
    note("You are on Free: the other commands come with Pro.");
    return;
  }
  out(`  ${c.bold("What next?")} ${c.gray("A number, a command, or a question.")}`);
  const list = COMMANDS.map((x, i) => [...x, i + 1]).filter(([, , short]) => all || short);
  const pad = Math.max(...list.map(([n]) => n.length)) + 2;
  for (const [name, what, , i] of list) out(`  ${c.gray(String(i).padStart(2))}  ${c.cyan(name.padEnd(pad))}${c.gray(what)}`);
  out(`      ${c.cyan((all ? "q" : "help").padEnd(pad))}${c.gray(all ? "leave" : "every command")}${all ? "" : `   ${c.cyan("q")} ${c.gray("leave")}`}`);
}

const DAY = 24 * 60 * 60_000;

let keptCurrent = false;

/**
 * Keeps the installed `genclass` current, after any command on a terminal and when the home opens (the 2026-11-25
 * sandbox run: a copy installed by an earlier run never asked npm, because the check sat behind the test for a command
 * that is not installed yet, which is always false once it is). A run through npx that is newer than the installed copy
 * replaces it; the installed copy asks npm at most once a day and updates to what npm has. A failed update is tried
 * again a day later and the screen says how by hand. Not with --json, without a terminal, in CI, or with
 * GENCLASS_NO_INSTALL=1; once per process. Returns "updated", "failed" or "skipped".
 */
export async function keepCurrent(deps = {}) {
  if (keptCurrent || process.env.CI || process.env.GENCLASS_NO_INSTALL || !(deps.interactive ?? interactive)()) return "skipped";
  keptCurrent = true;
  const p = readPrefs();
  const now = deps.now ?? Date.now();
  const install = deps.install ?? installGlobally;
  const have = (deps.installedVersion ?? installedVersion)();
  if (!have) return "skipped";
  const npx = (deps.viaNpx ?? viaNpx)();
  let want = null;
  // npx ran the newest it knows: only an older installed copy is replaced; the installed copy itself asks npm
  if (npx) want = newer(BUILD.version, have) ? BUILD.version : null;
  else if (!(p.updateCheckedAt && now - Date.parse(p.updateCheckedAt) < DAY)) {
    savePrefs({ updateCheckedAt: new Date(now).toISOString() });
    const latest = await (deps.latest ?? latestOnNpm)();
    want = latest && newer(latest, have) && newer(latest, BUILD.version) ? latest : null;
  }
  if (want && p.updateFailedAt && now - Date.parse(p.updateFailedAt) < DAY) want = null;
  if (!want) return "skipped";
  out();
  const sp = spinner(`A newer genclass is out: updating ${have} to ${want}`);
  const r = await install(want);
  if (r.ok) {
    savePrefs({ updateFailedAt: null });
    sp.stop("ok", npx ? `Updated to ${want}.` : `Updated to ${want}: the next genclass you type runs it.`);
    return "updated";
  }
  savePrefs({ updateFailedAt: new Date(now).toISOString() });
  sp.stop("warn", `genclass ${want} is out, and this one is ${have}. It could not update itself.`);
  note("By hand: npm install -g genclass@latest");
  return "failed";
}

/** For tests: this process has not checked for a newer genclass yet. */
export const forgetKeptCurrent = () => {
  keptCurrent = false;
};

/**
 * Makes `genclass` alone work in the terminal: a run through npx on a terminal installs the command (npm install
 * -g genclass@<this version>) and says so (the owner's call, 2026-11-12: it installs itself). Not with --yes, without
 * a terminal, in CI, or with GENCLASS_NO_INSTALL=1; after a failure it is tried again a day later, and the screen
 * says how to do it by hand. npm uninstall -g genclass takes it out. Once it is installed, keepCurrent keeps it
 * current.
 */
export async function installShortName(deps = {}) {
  if (process.env.CI || process.env.GENCLASS_NO_INSTALL || !(deps.interactive ?? interactive)()) return "skipped";
  const p = readPrefs();
  const now = deps.now ?? Date.now();
  const install = deps.install ?? installGlobally;
  if ((deps.works ?? shortNameWorks)()) {
    const r = await keepCurrent(deps);
    useShortName();
    return r === "updated" ? "updated" : "skipped";
  }
  if (p.installFailedAt && now - Date.parse(p.installFailedAt) < DAY) return "skipped";
  out();
  const sp = spinner("Adding the genclass command to your terminal");
  const r = await install(BUILD.version);
  if (!r.ok) {
    savePrefs({ installFailedAt: new Date(now).toISOString() });
    sp.stop("warn", "Could not add the genclass command. npx genclass keeps working.");
    if (r.text) note(r.text);
    note("By hand: npm install -g genclass (some systems need sudo in front).");
    return "failed";
  }
  savePrefs({ installFailedAt: null, installedAt: new Date(now).toISOString() });
  if ((deps.works ?? shortNameWorks)()) {
    useShortName();
    sp.stop("ok", "Added: type genclass from now on.");
    // zsh remembers where commands are: a window that was open before the install may not see the new one yet
    if (/zsh$/.test(process.env.SHELL ?? "")) note("If this window says command not found, run rehash once, or open a new window.");
  } else sp.stop("ok", "Added. Open a new terminal window and type genclass.");
  note("npm install -g genclass ran. npm uninstall -g genclass takes it out.");
  return "installed";
}

/**
 * Where the command stands in this folder, above its prompt when `genclass` opens straight on it: the app, the account
 * and its plan, and what setup has left (or that setup has not run here). Nothing is asked or done.
 */
export function opening(state) {
  header({ app: state.app?.name, framework: state.app?.framework, account: state.account?.label, plan: planName(state), host: state.host });
  const cli = state.account?.cli;
  const trial = cli && !cli.paid ? `${cli.trialDays ? `your ${cli.trialDays}-day free trial of ` : ""}${clean(cli.plan, 20)}` : null;
  // what setup has left; without Pro, the parts before Pro's step (Pro and what comes with it are said on their own)
  const at = trial ? state.steps.findIndex((x) => x.id === "plan") : -1;
  const left = state.steps.filter((x, i) => (at < 0 || i < at) && x.state !== "done" && x.state !== "optional" && x.blocking !== false && x.state !== "waiting");
  // signed out (logout, an expired session) in a folder that is set up: the app is still set up, only the sign-in is
  // missing (the 0.3.9 user stories: after logout it said "not set up")
  // on Free the setup comes first and Pro after it (the owner's call, 2026-11-24): what setup has left, else Pro
  if (state.signedIn && trial && state.app?.token && !left.length) note(`Your app is set up. Type upgrade to start ${trial}: the dashboard, problems, fixes and suggestions come with it.`);
  else if (state.signedIn && trial && state.app?.token) note(`Set up. ${left.length} more step${left.length === 1 ? "" : "s"} you can add (${left.map((x) => x.title).join(", ")}): type setup. Then ${trial}.`);
  else if (!state.signedIn && state.app?.token) note(state.sessionProblem === "expired" ? "Your sign-in expired. Type login to sign in again." : "Not signed in. Type login to sign in again.");
  else if (!state.signedIn) note("Not signed in, and GenClass is not in this app yet. Type setup: it starts with the sign-in.");
  else if (!state.app?.token) note("GenClass is not set up in this folder yet. Type setup to do it, one step at a time.");
  else if (left.length) note(`Set up. ${left.length} more step${left.length === 1 ? "" : "s"} you can add (${left.map((x) => x.title).join(", ")}): type setup.`);
  else note("Everything is set up. Type setup any time to change something.");
}

/**
 * The home. `deps.runCommand(argv)` runs one command and resolves its exit code (cli.mjs run); `deps.ask(text)`
 * answers a question. Returns 0.
 * @param {{ cwd?: string }} o
 */
export async function home(o = {}, deps = {}) {
  if (!interactive()) return 0;
  await installShortName(deps);
  // on Free the short list is what works there; once Pro is on (upgrade, here), the whole list
  let free = !!o.free;
  const pro = async () => (await import("./paywall.mjs")).proSeen();
  menu(false, free);
  inHome(o.app ?? "");
  // the command a "Did you mean" named: y (or yes) runs it
  let meant = null;
  for (;;) {
    out();
    const line = await typed(`  ${PROMPT()} `);
    if (line === null) break;
    const yes = meant && /^\s*(y|yes)\s*$/i.test(line);
    const got = yes ? { command: [meant] } : read(line, NAMES, free ? FREE_MENU : COMMANDS);
    meant = null;
    if (got.quit) break;
    if (got.help) {
      menu(!!got.all, free);
      continue;
    }
    if (got.unknown) {
      if (got.number) {
        warn(`No command has the number ${got.unknown}.`);
        note(`The numbers are the ones in the list: ${free ? "1 to " + FREE_MENU.length : "help shows them all"}.`);
        continue;
      }
      const near = deps.nearest?.(got.unknown);
      meant = near;
      warn(`There is no command "${got.unknown}".${near ? ` Did you mean ${c.cyan(near)}? (y runs it)` : ""}`);
      note("help lists them all.");
      continue;
    }
    let argv = got.command ?? ["ask", got.question];
    // a page's command picked by its number, or typed alone: its address is asked for (on Free, fix alone is the
    // page's fix, the one that works there)
    if (argv.length === 1 && (argv[0] === "scan" || (free && argv[0] === "fix"))) {
      const page = await typed(`  ${PROMPT()} ${c.gray("Which page? Its address, like shop.example.com:")} `);
      if (page === null || !page.trim() || /^q$/i.test(page.trim())) continue;
      argv = [argv[0], page.trim()];
    }
    // the folder chosen at the start stays the folder
    const withCwd = o.cwd && !argv.includes("--cwd") ? [...argv, "--cwd", o.cwd] : argv;
    try {
      await deps.runCommand?.(withCwd);
    } catch (e) {
      warn(`That did not work: ${e?.message ?? e}`);
    }
    // on Free: one line, every time, with the way up (not after the gate's own line for the same thing)
    let stopped = false;
    try {
      const paywall = await import("./paywall.mjs");
      stopped = paywall.wasRefused();
      paywall.resetRefused();
    } catch {
      /* nothing to read */
    }
    // (not after the commands that say where the plan stands themselves: status and setup show Pro's step)
    if (!stopped && !["upgrade", "profile", "plan", "login", "logout", "remove", "status", "setup"].includes(argv[0])) {
      try {
        await deps.afterCommand?.();
      } catch {
        /* the line is best effort */
      }
    }
    // Pro started here (upgrade, or the card after a command): every command works now
    if (free && (await pro().catch(() => false))) {
      free = false;
      menu(false, false);
    }
    rule();
  }
  inHome(null);
  out();
  note("Bye. Run npx genclass any time to come back here.");
  out();
  return 0;
}
