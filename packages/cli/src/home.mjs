// The command's home: what `genclass` is on a terminal once the setup is walked. It stays open. Type a command, or a
// question about your app, as often as you like; q leaves.
//
// Invariants:
// - Everything here is also a command of its own (`genclass dashboard`, `genclass analytics`, ...): the home only
//   saves typing the name in front, and keeps the folder that was chosen at the start.
// - Simple first: the list of commands is short lines, shown once and again on an empty Enter or `help`. A mistyped
//   command names the nearest one. A line that is not a command and reads like a sentence is a question (ask.mjs).
// - It never opens without someone at a terminal: piped, in CI or with --yes the command prints and ends as before.
// - A command that fails does not end the home: its message is printed and the prompt comes back.

import { c, interactive, out } from "../../runtime/bin/lib/ui.mjs";
import { BUILD } from "./assets.mjs";
import { installGlobally, isShort, readPrefs, savePrefs, shortNameWorks, useShortName } from "./name.mjs";
import { agree, note, PROMPT, rule, spinner, typed, warn } from "./tui.mjs";

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
  ["health", "how GenClass runs on your pages", false],
  ["report", "the period as Markdown", false],
  ["export", "every stored event, as a file", false],
  ["agent", "your coding agent and what it did", false],
  ["funnels", "funnels through your pages", false],
  ["scan <url>", "check one page", false],
  ["apps", "the apps in your account", false],
  ["plan", "your plan and what it includes", false],
  ["team", "the people on your plan", false],
  ["status", "where the setup stands", false],
  ["setup", "walk the setup again", false],
  ["login", "sign in (logout, whoami)", false],
  ["remove", "take GenClass out of this app", false],
];

const NAMES = [...COMMANDS.map(([n]) => n.split(" ")[0]), "logout", "whoami", "version"];

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
  const argv = words(text);
  const head = argv[0].toLowerCase();
  if (["q", "quit", "exit", "bye"].includes(head)) return { quit: true };
  if (head === "help" || head === "?" || head === "commands") return { help: true, all: true };
  if (known.includes(head)) return { command: [head, ...argv.slice(1)] };
  // a sentence, or anything ending in a question mark, is a question about the app
  if (argv.length >= 3 || /\?\s*$/.test(text)) return { question: text };
  return { unknown: argv[0] };
}

/** The list of commands: the short one, or every command. */
export function menu(all = false) {
  out();
  out(`  ${c.bold("What next?")} ${c.gray("A command, or a question about your app.")}`);
  const list = COMMANDS.filter(([, , short]) => all || short);
  const pad = Math.max(...list.map(([n]) => n.length)) + 2;
  for (const [name, what] of list) out(`    ${c.cyan(name.padEnd(pad))}${c.gray(what)}`);
  out(`    ${c.cyan((all ? "q" : "help").padEnd(pad))}${c.gray(all ? "leave" : "every command")}${all ? "" : `   ${c.cyan("q")} ${c.gray("leave")}`}`);
}

/** Offers, once, to install the command so that `genclass` alone works. Nothing is installed without a yes. */
export async function offerInstall(deps = {}) {
  if (isShort() || process.env.CI || readPrefs().installAsked) return "skipped";
  savePrefs({ installAsked: true });
  out();
  out(`  ${c.bold("Type just")} ${c.cyan("genclass")} ${c.bold("from now on?")}`);
  note("Right now this command runs through npx and is not installed. Installing it runs: npm install -g genclass");
  if (!(await agree("Install it?"))) {
    note("No problem: npx genclass keeps working. To install it later: npm install -g genclass");
    return "declined";
  }
  const sp = spinner("Installing the genclass command");
  const r = await (deps.install ?? installGlobally)(BUILD.version);
  if (!r.ok) {
    sp.stop("bad", "Could not install it.");
    if (r.text) note(r.text);
    note("By hand: npm install -g genclass (some systems need sudo in front).");
    return "failed";
  }
  if ((deps.works ?? shortNameWorks)()) {
    useShortName();
    sp.stop("ok", "Installed. From now on, type genclass.");
  } else sp.stop("warn", "Installed, but its folder is not on your PATH in this window. Open a new terminal and type genclass.");
  return "installed";
}

/**
 * The home. `deps.runCommand(argv)` runs one command and resolves its exit code (cli.mjs run); `deps.ask(text)`
 * answers a question. Returns 0.
 * @param {{ cwd?: string }} o
 */
export async function home(o = {}, deps = {}) {
  if (!interactive()) return 0;
  await offerInstall(deps);
  menu();
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
    rule();
  }
  out();
  note("Bye. Run npx genclass any time to come back here.");
  out();
  return 0;
}
