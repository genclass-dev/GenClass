// The mark on the `genclass` command's welcome card: a G in block characters, in the brand's green.
//
// Invariants:
// - Five rows of the same width (test/art.test.ts), made of block and half-block characters only, so any terminal
//   font that has box drawing draws it and it fits the narrowest window the card is drawn in.
// - The card and the mark are drawn only on a terminal that can (canDraw). Piped output, a dumb terminal and a plain
//   Windows console get the name as text, so nothing an agent or a log reads ever holds the art.
// - Colour is the terminal's own business: 24-bit green shades when it says it has them (COLORTERM), plain green
//   otherwise, none with NO_COLOR.

import { c, useColor } from "../../runtime/bin/lib/ui.mjs";

/** The mark: five rows, all as wide as the first. */
export const MARK = [" ▄▄████▄▄", "██▀    ▀▀", "██   ▄▄▄▄", "██▄    ██", " ▀▀████▀▀"];

/** Green from light to deep, one shade per row of the mark (24-bit colour). */
const SHADES = [
  [150, 245, 190],
  [116, 234, 168],
  [84, 222, 146],
  [56, 206, 128],
  [29, 179, 106],
];
/** The brand's green as one colour (borders, the prompt mark, the bar beside a note). */
const BRAND = [64, 214, 134];

const truecolor = () => useColor && /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
const rgb = ([r, g, b], s) => `\u001b[38;2;${r};${g};${b}m${s}\u001b[39m`;

/** `text` in the brand's green. */
export const brand = (text) => (truecolor() ? rgb(BRAND, text) : c.green(text));

/** The mark's rows, coloured. */
export const markRows = () => MARK.map((row, i) => (truecolor() ? rgb(SHADES[i], row) : c.green(row)));

/** Whether this terminal can draw the card: a terminal, with box-drawing characters, wide enough for it. */
export function canDraw(columns = process.stdout.columns, env = process.env, platform = process.platform) {
  const unicode = platform !== "win32" || !!env.WT_SESSION || !!env.TERM_PROGRAM;
  return !!process.stdout.isTTY && unicode && env.TERM !== "dumb" && Number(columns) >= 44;
}
