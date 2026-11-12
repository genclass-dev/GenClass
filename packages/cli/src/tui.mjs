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

import { c, out, sym } from "../../runtime/bin/lib/ui.mjs";

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

/** Prints `text` wrapped, every line behind `indent`. */
export function para(text, indent = "  ", paint = (s) => s) {
  for (const l of wrap(text, width() - indent.length)) out(`${indent}${paint(l)}`);
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

/** The block under the checklist that says what comes next and why, in plain words. */
export function nextBlock(title, text) {
  out();
  out(`  ${c.cyan(c.bold("Next"))}  ${c.bold(title)}`);
  if (text) para(text, "        ", c.gray);
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
