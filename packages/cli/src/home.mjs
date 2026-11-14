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
import { installedVersion, installGlobally, isShort, latestOnNpm, newer, readPrefs, savePrefs, shortNameWorks, useShortName, viaNpx } from "./name.mjs";
import { planName } from "./state.mjs";
import { header, inHome, note, PROMPT, rule, spinner, typed, warn } from "./tui.mjs";

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

/** A typed line as arguments: spaces separate, single or double quotes keep words together. */
export function words(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line)))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** What a typed line is: { quit }, { help }, { command: argv }, { question: text } or { unknown: word }. */
export function read(line, known = NAMES) {
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
  if (/^\d{1,2}$/.test(head) && argv.length === 1) {
    const cmd = COMMANDS[Number(head) - 1];
    return cmd ? { command: [cmd[0].split(" ")[0]] } : { unknown: head };
  }
  if (head === "help" || head === "?" || head === "commands") return { help: true, all: true };
  if (known.includes(head)) return { command: [head, ...argv.slice(1)] };
  // a sentence, or anything ending in a question mark, is a question about the app
  if (argv.length >= 3 || /\?\s*$/.test(text)) return { question: text };
  return { unknown: argv[0] };
}

/** The list of commands: the short one, or every command. */
export function menu(all = false) {
  out();
  out(`  ${c.bold("What next?")} ${c.gray("A number, a command, or a question.")}`);
  const list = COMMANDS.map((x, i) => [...x, i + 1]).filter(([, , short]) => all || short);
  const pad = Math.max(...list.map(([n]) => n.length)) + 2;
  for (const [name, what, , i] of list) out(`  ${c.gray(String(i).padStart(2))}  ${c.cyan(name.padEnd(pad))}${c.gray(what)}`);
  out(`      ${c.cyan((all ? "q" : "help").padEnd(pad))}${c.gray(all ? "leave" : "every command")}${all ? "" : `   ${c.cyan("q")} ${c.gray("leave")}`}`);
}

const DAY = 24 * 60 * 60_000;

/**
 * Makes `genclass` alone work in the terminal: a run through npx on a terminal installs the command (npm install
 * -g genclass@<this version>) and says so (the owner's call, 2026-11-12: it installs itself). Not with --yes, without
 * a terminal, in CI, or with GENCLASS_NO_INSTALL=1; after a failure it is tried again a day later, and the screen
 * says how to do it by hand. npm uninstall -g genclass takes it out.
 */
export async function installShortName(deps = {}) {
  if (isShort() || process.env.CI || process.env.GENCLASS_NO_INSTALL || !(deps.interactive ?? interactive)()) return "skipped";
  const p = readPrefs();
  const now = deps.now ?? Date.now();
  const install = deps.install ?? installGlobally;
  if ((deps.works ?? shortNameWorks)()) {
    // the installed command stays current (the 0.3.7 walk: a Mac stayed on its first version): a run through npx,
    // which runs the newest, replaces an older installed copy; the installed copy asks npm once a day
    const have = (deps.installedVersion ?? installedVersion)();
    const npx = (deps.viaNpx ?? viaNpx)();
    let want = null;
    if (have && npx) want = newer(BUILD.version, have) ? BUILD.version : null;
    else if (have && !(p.updateCheckedAt && now - Date.parse(p.updateCheckedAt) < DAY)) {
      savePrefs({ updateCheckedAt: new Date(now).toISOString() });
      const latest = await (deps.latest ?? latestOnNpm)();
      want = latest && newer(latest, have) ? latest : null;
    }
    if (want && p.updateFailedAt && now - Date.parse(p.updateFailedAt) < DAY) want = null;
    let updated = false;
    if (want) {
      out();
      const sp = spinner(`Updating the genclass command, ${have} to ${want}`);
      const r = await install(want);
      if (r.ok) {
        savePrefs({ updateFailedAt: null });
        sp.stop("ok", npx ? `Updated to ${want}.` : `Updated to ${want}: the next genclass you type runs it.`);
        updated = true;
      } else {
        savePrefs({ updateFailedAt: new Date(now).toISOString() });
        sp.stop("warn", `Could not update the genclass command: it stays ${have}.`);
        note("By hand: npm install -g genclass@latest");
      }
    }
    useShortName();
    return updated ? "updated" : "skipped";
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
  const left = state.steps.filter((x) => x.state !== "done" && x.state !== "optional" && x.blocking !== false && x.state !== "waiting");
  if (!state.signedIn || !state.app?.token) note("GenClass is not set up in this folder yet. Type setup to do it, one step at a time.");
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
  menu();
  inHome(o.app ?? "");
  for (;;) {
    out();
    const line = await typed(`  ${PROMPT()} `);
    if (line === null) break;
    const got = read(line);
    if (got.quit) break;
    if (got.help) {
      menu(!!got.all);
      continue;
    }
    if (got.unknown) {
      const near = deps.nearest?.(got.unknown);
      warn(`There is no command "${got.unknown}".${near ? ` Did you mean ${c.cyan(near)}?` : ""}`);
      note("help lists them all.");
      continue;
    }
    const argv = got.command ?? ["ask", got.question];
    // the folder chosen at the start stays the folder
    const withCwd = o.cwd && !argv.includes("--cwd") ? [...argv, "--cwd", o.cwd] : argv;
    try {
      await deps.runCommand?.(withCwd);
    } catch (e) {
      warn(`That did not work: ${e?.message ?? e}`);
    }
    // on Free: one line, every time, with the way up
    if (!["upgrade", "profile", "plan", "login", "logout", "remove"].includes(argv[0])) {
      try {
        await deps.afterCommand?.();
      } catch {
        /* the line is best effort */
      }
    }
    rule();
  }
  inHome(null);
  out();
  note("Bye. Run npx genclass any time to come back here.");
  out();
  return 0;
}
