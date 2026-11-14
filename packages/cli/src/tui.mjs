// How the `genclass` command looks: the header, the checklist, the "Next" block, a spinner and text helpers.
//
// Invariants:
// - No dependencies. Colours, symbols and questions are the runtime CLI's own (packages/runtime/bin/lib/ui.mjs), so
//   NO_COLOR, FORCE_COLOR, a dumb terminal and piped output behave the same in every command.
// - Nothing here moves the cursor except the spinner, and the spinner only draws on a terminal: piped output (a log,
//   a coding agent reading it) gets plain lines, one per event, in the order things happened.
// - Text that did not come from this program (a server's answer, a model's words, a page's title) goes through
//   clean() before it is printed: control characters and escape sequences are removed, so nothing a site or a model
//   writes can move the cursor, recolour the terminal or hide a line.

import { homedir } from "node:os";
import { ask, c, choose, confirm, inputClosed, out, sym, useColor } from "../../runtime/bin/lib/ui.mjs";
import { brand, markRows } from "./art.mjs";

const tty = () => !!process.stdout.isTTY;
const unicode = process.platform !== "win32" || !!process.env.WT_SESSION || !!process.env.TERM_PROGRAM;

// Built from strings so that this file holds no control character itself.
const ESC = String.fromCharCode(27);
const CSI = String.fromCharCode(155);
/** Terminal escape sequences: CSI (from ESC [ or the one-byte CSI) and the two-character ESC sequences. */
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[@-Z\\\\-_]|${CSI}[0-9;?]*[ -/]*[@-~]`, "g");
/** C0 and C1 control characters, DEL and the two Unicode line separators. */
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+", "g");
/** Colour codes (SGR). */
const COLOUR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/**
 * The width text is wrapped to: the terminal's (else COLUMNS, as a coding agent or a pipe sets it), kept between 60
 * and 96 columns. Screens draw within width() - 2, so the narrowest is 58 columns, the window every screen is checked at.
 */
export const width = () => Math.max(60, Math.min(96, Number(process.stdout.columns) || Number(process.env.COLUMNS) || 80));

/** `text` without control characters and terminal escape sequences, whitespace collapsed, at most `max` characters. */
export function clean(text, max = 400) {
  const s = String(text ?? "")
    .replace(ANSI, "")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The visible length of a string that may hold colour codes. */
export const visible = (s) => String(s).replace(COLOUR, "").length;

/** The words that follow `genclass` (or npm) in a command: its commands and their subcommands. */
const SUBCOMMANDS = new Set(
  "setup status suggest dashboard problems analytics events health report export fix ask scan audit connections agent funnels apps plan upgrade profile team login logout whoami connect init remove help version new add invite link test on off pages sources devices clicks paths stale all install uninstall".split(" "),
);
/** The options of a command that take the word after them. */
const VALUED = /^--?(cwd|app|range|out|from|to|format|agent|name|mode|token|url|model-url|sink|variant|ort)$/;
const plainWord = (w) => w.replace(COLOUR, "");
/** A word that ends a sentence or a clause (a URL's own last character does not). */
const closes = (p) => /[.,;:!?)]$/.test(p) && !/^https?:\/\//.test(p);

/**
 * The words of one paragraph grouped so that a command is one unit: `npx genclass init --no-telemetry`,
 * `npx genclass --cwd <folder>`, `npm install -g genclass`, `npx genclass apps new "My shop"`. A unit is never
 * longer than `cols` because of the grouping: a command that would be is left to break as words do.
 */
function units(words, cols) {
  const list = [];
  let cmd = false;
  let quote = false;
  let valueNext = false;
  for (const w of words) {
    const p = plainWord(w);
    const last = list.length ? plainWord(list[list.length - 1].at(-1)) : "";
    let join = false;
    if (list.length && cmd) {
      join =
        quote ||
        valueNext ||
        last === "npx" ||
        (/^(genclass|@genclass\/)/.test(p) && /^(install|uninstall|-g)$/.test(last)) ||
        /^-{1,2}[A-Za-z][\w-]*/.test(p) ||
        /^<[^>]*>/.test(p) ||
        /^"/.test(p) ||
        /^https?:\/\//.test(p) ||
        /^\d+[.,;:)]?$/.test(p) ||
        SUBCOMMANDS.has(p.replace(/[.,;:)]$/, ""));
      if (join && visible(list[list.length - 1].join(" ")) + 1 + visible(w) > cols) join = false;
    }
    if (join) list[list.length - 1].push(w);
    else {
      list.push([w]);
      cmd = /^(npx|npm)$/.test(p) || /^(genclass|@genclass\/\S+?)[.,;:)]?$/.test(p);
      quote = false;
      valueNext = false;
      if (!cmd) continue;
    }
    if (!quote && /^"/.test(p) && !/.["][.,;:)]?$/.test(p)) quote = true;
    else if (quote && /"[.,;:)]?$/.test(p)) quote = false;
    valueNext = !quote && VALUED.test(p);
    if (!quote && closes(p)) cmd = false;
  }
  return list.map((u) => u.join(" "));
}

/**
 * `text` wrapped to `cols` columns: an array of lines. A word longer than a line is left whole, and a command (npx
 * genclass ...) is never broken across lines: it moves to the next line whole, so it can be copied as typed.
 */
export function wrap(text, cols = width() - 4) {
  const lines = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of units(para.split(/[ \t\r\f\v]+/).filter(Boolean), cols)) {
      if (line && visible(line) + 1 + visible(word) > cols) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

/** Prints `text` wrapped, every line behind `indent`, none longer than the narrowest window the command draws for (width() less 2). */
export function para(text, indent = "  ", paint = (s) => s) {
  for (const l of wrap(text, width() - 2 - indent.length)) out(`${indent}${paint(l)}`);
}

/** "  Label  url": on one line when it fits the window, else the link on its own line under the label. */
export function linkLine(label, url) {
  if (2 + visible(label) + 2 + visible(url) <= width() - 2) out(`  ${c.gray(label)}  ${c.cyan(url)}`);
  else {
    out(`  ${c.gray(label)}`);
    out(`    ${c.cyan(url)}`);
  }
}

/** A horizontal rule as wide as the text. */
export const rule = () => out(`  ${c.gray((unicode ? "─" : "-").repeat(width() - 4))}`);

let homeApp = null;
/** While the command's home is open on `app` ("" when it has none), views are not headed again; null ends it. */
export const inHome = (app) => {
  homeApp = app === null ? null : clean(app ?? "", 40);
};
/** Whether the command's home is open (its card was shown once, at the top). */
export const homeOpen = () => homeApp !== null;

/**
 * The header: the product, this app and its framework on one line, the account and its plan under it.
 * @param {{ app?: string | null, framework?: string | null, account?: string | null, plan?: string | null, host?: string | null }} h
 */
export function header(h = {}) {
  // in the command's home the card and the account were shown once, at the top: a view starts with a blank line,
  // and names its app only when it is not the one the home is open on
  if (homeApp !== null) {
    out();
    if (h.app && clean(h.app, 40) !== homeApp) out(`  ${c.bold(clean(h.app, 40))}`);
    return;
  }
  const left = `${c.bold(c.magenta("GenClass"))}${h.app ? ` ${c.gray(sym.dot)} ${c.bold(clean(h.app, 40))}` : ""}`;
  const right = h.framework ? c.gray(clean(h.framework, 40)) : "";
  const gap = Math.max(2, width() - 4 - visible(left) - visible(right));
  out();
  out(`  ${left}${" ".repeat(gap)}${right}`);
  const who = [h.account ? clean(h.account, 50) : "not signed in", h.plan ? `${clean(h.plan, 20)} plan` : null].filter(Boolean).join(` ${sym.dot} `);
  out(`  ${c.gray(who)}`);
  if (h.host) out(`  ${c.yellow(sym.warn)} ${c.gray(`talking to ${clean(h.host, 60)} (GENCLASS_HOST is set: for tests only)`)}`);
  rule();
}

/** `text` (which may hold colour codes) in the middle of `cols` columns. */
const centre = (text, cols) => {
  const pad = Math.max(0, cols - visible(text));
  const left = Math.floor(pad / 2);
  return `${" ".repeat(left)}${text}${" ".repeat(pad - left)}`;
};

/** A folder as a person writes it: the home folder as ~, and only its end when it is longer than `max`. */
export function folderName(dir, max = 48, home = homedir()) {
  const d = String(dir ?? "");
  const short = home && (d === home || d.startsWith(`${home}/`)) ? `~${d.slice(home.length)}` : d;
  return short.length > max ? `…${short.slice(short.length - max + 1)}` : short;
}

/**
 * What to call the person on the card: their GitHub name, else nothing. The start of an email address is not a name
 * ("walk58@..." would be greeted as "Walk58"), so an account known by its email is welcomed without one.
 */
export function firstName(label) {
  const l = clean(label ?? "", 80);
  const raw = /^GitHub (\S+)$/.exec(l)?.[1] ?? "";
  const name = raw.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 24);
  return name ? name[0].toUpperCase() + name.slice(1) : null;
}

/**
 * The welcome card, the first thing the command shows on a terminal: the product's name in the border with the
 * version, a welcome, the mark, and three quiet lines (the app, the account, the folder). As wide as the rule under
 * the other screens, so everything below lines up with it.
 * @param {{ app?: string | null, framework?: string | null, account?: string | null, plan?: string | null, host?: string | null, cwd?: string | null, version?: string | null }} h
 */
export function card(h = {}) {
  const inner = width() - 6;
  const B = unicode ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" } : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  // the name as the logo writes it: the first half plain, the second in the logo's green
  const title = ` ${c.bold("Gen")}${c.bold(brand("Class"))} `;
  const version = h.version ? ` ${c.gray(`v${clean(h.version, 20)}`)} ` : "";
  const row = (text = "") => out(`  ${brand(B.v)}${centre(text, inner)}${brand(B.v)}`);
  const fit = (text) => clean(text, inner - 4);
  const name = h.account ? firstName(h.account) : null;
  out();
  out(`  ${brand(B.tl + B.h)}${title}${brand(B.h.repeat(Math.max(0, inner - 2 - visible(title) - visible(version))))}${version}${brand(B.h + B.tr)}`);
  row();
  row(c.bold(h.account ? `Welcome back${name ? `, ${name}` : ""}!` : "Welcome to GenClass"));
  if (!h.account) {
    row();
    // one line where it fits, else two halves that read as halves (never one word alone on the second line)
    const halves = ["Finds what breaks in your web app,", "and tells you what it needs next."];
    for (const l of halves.join(" ").length <= inner - 6 ? [halves.join(" ")] : halves) row(c.gray(l));
  }
  row();
  if (unicode) {
    for (const m of markRows()) row(m);
    row();
  }
  const app = [h.app ? clean(h.app, 40) : null, h.framework ? clean(h.framework, 40) : null].filter(Boolean).join(` ${sym.dot} `);
  if (app) row(c.gray(fit(app)));
  row(c.gray(fit([h.account ? clean(h.account, 50) : "not signed in", h.plan ? `${clean(h.plan, 20)} plan` : null].filter(Boolean).join(` ${sym.dot} `))));
  if (h.cwd) row(c.gray(folderName(h.cwd, inner - 4)));
  row();
  out(`  ${brand(B.bl + B.h.repeat(inner) + B.br)}`);
  if (h.host) {
    out();
    out(`  ${c.yellow(sym.warn)} ${c.gray(`talking to ${clean(h.host, 60)} (GENCLASS_HOST is set: for tests only)`)}`);
  }
  out();
}

/**
 * The plan step's card: the paid plan, large. Its name in capitals with the price on the same line, what it is in
 * one sentence, and the lines of its card on genclass.dev, each with a tick. As wide as the welcome card. Every word
 * of it is the server's (the plans file), cleaned like any text that is not this program's.
 * @param {{ plan: { name: string }, price: string, summary?: string | null, features: string[] }} offer
 * @param {string | null} [app] the project it is chosen for
 */
/**
 * The Pro box: what comes with the paid plan, its trial and price, and the command that starts it. `lock` is what
 * the server said ({ plan, trialDays, price, upgradeUrl }); every part of it is cleaned before it is printed.
 */
export function proBox(what, lock = {}) {
  const plan = clean(lock.plan ?? "Pro", 20);
  out();
  out(`  ${badge(plan.toUpperCase())}`);
  for (const l of wrap(clean(what, 300), width() - 6)) out(`    ${c.bold(l)}`);
  const terms = lock.trialDays ? `${lock.trialDays} days free, then ${clean(lock.price ?? "the monthly price", 40)}. Cancel any time.` : lock.price ? `${clean(lock.price, 40)}.` : "";
  for (const l of wrap(`${terms ? `${terms} ` : ""}Start: npx genclass upgrade`, width() - 6)) out(`    ${l}`);
  if (lock.upgradeUrl) out(`    ${c.cyan(clean(lock.upgradeUrl, 200))}`);
}

export function planCard(offer, app, heading = null) {
  const inner = width() - 6;
  const B = unicode ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" } : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  const title = ` ${c.bold(heading ? clean(heading, 50) : app ? `A plan for ${clean(app, 30)}` : "A plan for this project")} `;
  const row = (text = "") => out(`  ${brand(B.v)}   ${text}${" ".repeat(Math.max(0, inner - 3 - visible(text)))}${brand(B.v)}`);
  const room = inner - 6;
  out();
  out(`  ${brand(B.tl + B.h)}${title}${brand(B.h.repeat(Math.max(0, inner - 1 - visible(title))))}${brand(B.tr)}`);
  row();
  // the name, large: capitals with air between the letters, the price at the far end of the line
  const name = badge(clean(offer.plan.name, 20).toUpperCase().split("").join(" "));
  const price = c.bold(clean(offer.price, 40));
  if (visible(name) + 2 + visible(price) <= room) row(`${name}${" ".repeat(room - visible(name) - visible(price))}${price}`);
  else {
    row(name);
    row(price);
  }
  if (offer.summary) for (const l of wrap(clean(offer.summary, 200), room)) row(c.gray(l));
  // the trial, when this account has one: said before anything else is
  if (offer.trialDays) for (const l of wrap(`${offer.trialDays} days free, then ${clean(offer.price, 40)}. Cancel any time.`, room)) row(c.green(l));
  row();
  for (const f of offer.features) {
    const [first = "", ...rest] = wrap(clean(f, 120), room - 2);
    row(`${c.green(sym.ok)} ${first}`);
    for (const l of rest) row(`  ${l}`);
  }
  row();
  out(`  ${brand(B.bl + B.h.repeat(inner) + B.br)}`);
}

/** `text` as a filled label in the brand's green (bold; plain bold where there is no colour). */
const badge = (text) => (useColor ? `${String.fromCharCode(27)}[7m${c.bold(brand(` ${text} `))}${String.fromCharCode(27)}[27m` : c.bold(` ${text} `));

/** The bar that stands beside a note. */
const BAR = () => brand(unicode ? "▎" : "|");

/** `text` wrapped, every line beside the bar. */
export function barPara(text, paint = c.gray) {
  for (const l of wrap(text, width() - 6)) out(`  ${BAR()} ${paint(l)}`);
}

/** The mark a question starts with. */
export const PROMPT = () => brand(unicode ? "❯" : ">");

const MARK = {
  done: () => c.green(sym.ok),
  next: () => c.cyan(unicode ? "●" : ">"),
  waiting: () => c.yellow(unicode ? "◌" : "~"),
  todo: () => c.gray(unicode ? "○" : "o"),
  optional: () => c.gray(unicode ? "–" : "-"),
  blocked: () => c.red(sym.cross),
};

/**
 * The checklist: one line per step, its mark, its title and what is known about it.
 * @param {{ title: string, state: "done" | "next" | "waiting" | "todo" | "optional" | "blocked", detail?: string }[]} steps
 */
export function checklist(steps) {
  const pad = Math.min(30, Math.max(...steps.map((s) => s.title.length)) + 2);
  for (const s of steps) {
    const title = s.state === "next" ? c.bold(s.title.padEnd(pad)) : s.state === "done" ? s.title.padEnd(pad) : c.gray(s.title.padEnd(pad));
    const room = width() - 4 - 3 - pad;
    const detail = s.detail ? clean(s.detail, Math.max(20, room)) : "";
    out(`  ${(MARK[s.state] ?? MARK.todo)()}  ${title}${detail ? c.gray(detail) : ""}`);
  }
}

/**
 * The short view of the steps: one line for what is done, one for what is next, one for each thing that waits on
 * something outside this machine, one for what comes later. Steps that do not apply to the project are left out
 * (the full list, checklist(), names them and says why).
 * @param {{ title: string, doing?: string, state: string, detail?: string }[]} steps
 */
export function summary(steps) {
  const room = width() - 4 - 3 - 9;
  // a list of names that does not fit goes on under itself, never cut short with an ellipsis
  const names = (list) => {
    const lines = [];
    let line = "";
    for (const t of list.map((s) => s.title)) {
      if (line && visible(line) + 3 + t.length > room) {
        lines.push(`${line} ${sym.dot}`);
        line = t;
      } else line = line ? `${line} ${sym.dot} ${t}` : t;
    }
    if (line) lines.push(line);
    return lines;
  };
  const line = (mark, label, text) => {
    const [first = "", ...rest] = Array.isArray(text) ? text : [text];
    out(`  ${mark}  ${label}${Array.isArray(text) ? c.gray(first) : first}`);
    for (const l of rest) out(`  ${" ".repeat(12)}${c.gray(l)}`);
  };
  const pad = (label) => label.padEnd(9);
  const done = steps.filter((s) => s.state === "done");
  const next = steps.find((s) => s.state === "next");
  const later = steps.filter((s) => s.state === "todo");
  if (done.length) line(MARK.done(), pad("Done"), names(done));
  for (const b of steps.filter((s) => s.state === "blocked")) line(MARK.blocked(), pad(b.title), c.gray(clean(b.detail ?? "", room)));
  if (next) line(MARK.next(), c.bold(pad("Next")), c.bold(clean(next.doing ?? next.title, room)));
  for (const w of steps.filter((s) => s.state === "waiting")) line(MARK.waiting(), pad("Waiting"), c.gray(clean(`${w.title}: ${w.detail ?? ""}`, room)));
  if (later.length) line(MARK.todo(), c.gray(pad("Later")), names(later));
}

/** The block under the checklist that says what comes next and why, in plain words. */
export function nextBlock(title, text) {
  out();
  out(`  ${BAR()} ${c.cyan(c.bold("Next"))}  ${c.bold(title)}`);
  if (text) barPara(text);
}

/**
 * A yes/no question whose default can be yes. Input that has ended is never a yes: an empty answer counts as the
 * default only while someone can still type. Null when stdin is not a terminal.
 */
export async function agree(question, def = true) {
  const a = await confirm(question, def);
  return inputClosed() ? false : a;
}

/** Pick one of `labels`; null when stdin is not a terminal, or when input has ended (no pick is assumed). */
export async function pick(question, labels, def = 0) {
  const i = await choose(question, labels, def);
  return inputClosed() ? null : i;
}

/** One line typed at `question`; null when stdin is not a terminal or input has ended. */
export async function typed(question) {
  const a = await ask(question);
  return a === null || (a === "" && inputClosed()) ? null : a;
}

/** One line typed at `question` that is never shown (a key, a webhook address); null when stdin is not a terminal or input has ended. */
export async function secret(question) {
  const a = await ask(question, { hidden: true });
  return a === null || (a === "" && inputClosed()) ? null : a;
}

/** A line of small print. */
export const note = (text) => para(text, "  ", c.gray);

/** A line behind a mark, wrapped to the window: the lines after the first stand under its text, not under the mark. */
const marked = (mark, text) => {
  const [first = "", ...rest] = wrap(text, width() - 6);
  out(`  ${mark} ${first}`);
  for (const l of rest) out(`    ${l}`);
};
/** A finished thing. */
export const good = (text) => marked(c.green(sym.ok), text);
/** Something that needs attention and is not an error. */
export const warn = (text) => marked(c.yellow(sym.warn), text);
/** Something that failed. */
export const bad = (text) => marked(c.red(sym.cross), text);

const FRAMES = unicode ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["-", "\\", "|", "/"];

/** What a stoppable wait says: after its line when it fits, else on its own line above it. */
export const STOP_HINT = "(Enter to stop waiting)";

/** `label` cut to what fits on one line of the terminal after the spinner's mark (a wrapped line could not be redrawn). */
export function fitLine(label, columns = Number(process.stdout.columns) || 80) {
  const room = Math.max(12, columns - 5);
  return visible(label) <= room ? label : `${String(label).replace(COLOUR, "").slice(0, room - 1)}…`;
}

/**
 * A spinner for a wait. On a terminal it redraws one line, never wider than the window (a line that wrapped would
 * leave a copy of itself on every frame); piped, it prints the text once. `stoppable`: the wait ends on Enter, and
 * the line says so. `stop(mark, text)` ends it with one final line (`mark`: "ok", "warn", "bad" or null for no line).
 */
export function spinner(text, opts = {}) {
  let label = text;
  let i = 0;
  let timer = null;
  if (opts.stoppable && tty()) {
    if (visible(`${text} ${STOP_HINT}`) <= Math.max(12, (Number(process.stdout.columns) || 80) - 5)) label = `${text}${c.gray(` ${STOP_HINT}`)}`;
    else out(`  ${c.gray("Enter stops the wait.")}`);
  }
  const draw = () => process.stdout.write(`\r\u001b[2K  ${c.cyan(FRAMES[i++ % FRAMES.length])} ${fitLine(label)}`);
  if (tty()) {
    draw();
    timer = setInterval(draw, 90);
    timer.unref?.();
  } else out(`  ${c.gray(sym.dot)} ${label}`);
  return {
    update(t) {
      label = t;
    },
    stop(mark = null, final = label) {
      if (timer) {
        clearInterval(timer);
        process.stdout.write("\r\u001b[2K");
      }
      if (mark === "ok") good(final);
      else if (mark === "warn") warn(final);
      else if (mark === "bad") bad(final);
    },
  };
}

/** "3 minutes ago", "2 days ago", "just now" for an ISO time; "" when it is not one. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return "just now";
  const units = [
    [86400 * 365, "year"],
    [86400 * 30, "month"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [n, name] of units) {
    if (s >= n) {
      const v = Math.floor(s / n);
      return `${v} ${name}${v === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
