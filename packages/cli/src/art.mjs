// The wordmark the `genclass` command opens with on a terminal: GENCLASS in block letters, in the brand's green.
//
// Invariants:
// - Shown once, on the first screen of the guided walk, and only on a terminal that can draw it: at least 72 columns
//   and box-drawing characters. Anywhere else (a narrow window, a plain Windows console, piped output, --json) the
//   name is one bold line, so nothing an agent or a log reads ever holds the art.
// - Every letter is six rows of the same width, and the rows are joined here, so the letters cannot drift apart
//   (test/art.test.ts checks each letter and the whole).
// - Colour is the terminal's own business: 24-bit green shades when it says it has them (COLORTERM), plain green
//   otherwise, none with NO_COLOR.

import { c, out, useColor } from "../../runtime/bin/lib/ui.mjs";

/** Each letter: six rows, all as wide as the first. */
export const LETTERS = {
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  C: [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
  L: ["██╗     ", "██║     ", "██║     ", "██║     ", "███████╗", "╚══════╝"],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
};

/** The six rows of a word in block letters. */
export function blockRows(word) {
  const letters = [...word].map((ch) => LETTERS[ch]);
  return [0, 1, 2, 3, 4, 5].map((r) => letters.map((l) => l[r]).join(""));
}

/** GENCLASS, six rows. */
export const WORDMARK = blockRows("GENCLASS");

/** Green from light to deep, one shade per row (24-bit colour). */
const SHADES = [
  [150, 245, 190],
  [120, 236, 170],
  [90, 226, 150],
  [64, 214, 134],
  [47, 198, 120],
  [29, 179, 106],
];

/** Whether this terminal can draw the wordmark: wide enough, and one that has box-drawing characters. */
export function canDraw(columns = process.stdout.columns, env = process.env, platform = process.platform) {
  const unicode = platform !== "win32" || !!env.WT_SESSION || !!env.TERM_PROGRAM;
  return !!process.stdout.isTTY && unicode && env.TERM !== "dumb" && Number(columns) >= WORDMARK[0].length + 4;
}

/**
 * Prints the opening: the wordmark (or the name on one line where it cannot be drawn), then what GenClass does in
 * one sentence and this command's version.
 */
export function opening(version, tagline = "Finds what breaks in your web app, and tells you what it needs next.") {
  const truecolor = useColor && /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
  out();
  if (canDraw()) {
    WORDMARK.forEach((row, i) => {
      const [r, g, b] = SHADES[i];
      out(`  ${truecolor ? `\u001b[38;2;${r};${g};${b}m${row}\u001b[39m` : c.green(row)}`);
    });
    out();
  } else out(`  ${c.bold(c.green("GenClass"))}`);
  out(`  ${tagline}  ${c.gray(`v${version}`)}`);
}
