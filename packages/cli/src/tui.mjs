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

/** The width text is wrapped to: the terminal's, kept between 60 and 96 columns. */
export const width = () => Math.max(60, Math.min(96, Number(process.stdout.columns) || 80));

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

/** `text` wrapped to `cols` columns: an array of lines (words longer than a line are left whole). */
export function wrap(text, cols = width() - 4) {
  const lines = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
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

/** A horizontal rule as wide as the text. */
export const rule = () => out(`  ${c.gray((unicode ? "─" : "-").repeat(width() - 4))}`);

/**
 * The header: the product, this app and its framework on one line, the account and its plan under it.
 * @param {{ app?: string | null, framework?: string | null, account?: string | null, plan?: string | null, host?: string | null }} h
 */
export function header(h = {}) {
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

/** What to call the person on the card: the start of their email address or their GitHub name, else nothing. */
export function firstName(label) {
  const l = clean(label ?? "", 80);
  const raw = /^GitHub (\S+)$/.exec(l)?.[1] ?? (l.includes("@") ? l.split("@")[0].split(/[._+-]/)[0] : "");
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
export function planCard(offer, app) {
  const inner = width() - 6;
  const B = unicode ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" } : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  const title = ` ${c.bold(app ? `A plan for ${clean(app, 30)}` : "A plan for this project")} `;
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

/** A finished thing. */
export const good = (text) => out(`  ${c.green(sym.ok)} ${text}`);
/** Something that needs attention and is not an error. */
export const warn = (text) => out(`  ${c.yellow(sym.warn)} ${text}`);
/** Something that failed. */
export const bad = (text) => out(`  ${c.red(sym.cross)} ${text}`);

const FRAMES = unicode ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["-", "\\", "|", "/"];

/**
 * A spinner for a wait. On a terminal it redraws one line; piped, it prints the text once. `stop(mark, text)` ends
 * it with one final line (`mark`: "ok", "warn", "bad" or null for no line).
 */
export function spinner(text) {
  let label = text;
  let i = 0;
  let timer = null;
  const draw = () => process.stdout.write(`\r\u001b[2K  ${c.cyan(FRAMES[i++ % FRAMES.length])} ${label}`);
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
