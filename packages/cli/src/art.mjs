// The mark on the `genclass` command's welcome card: GenClass's logo as pixel art, a green arrow that sweeps over the
// top to the right and a red arrow that sweeps under to the left, together a G.
//
// Invariants:
// - The cells are the logo itself, sampled to sixteen by sixteen, in two greens and two reds (the lit and the shaded
//   side of each arrow) and nothing else. The lighter green also draws the card's border, the bar beside a note and
//   the prompt mark.
// - Sixteen rows of sixteen cells (test/art.test.ts), drawn two rows to a line with half-block characters, so the
//   mark is eight lines tall and its cells are square in a terminal's two-to-one character box.
// - The card and the mark are drawn only on a terminal that can (canDraw). Piped output, a dumb terminal and a plain
//   Windows console get the name as text, so nothing an agent or a log reads ever holds the art.
// - Colour is the terminal's own business: the logo's exact colours when it says it has 24-bit colour (COLORTERM),
//   its own green and red (bright for the lit side) otherwise, the shape alone with NO_COLOR.

import { c, useColor } from "../../runtime/bin/lib/ui.mjs";

/** The mark, one character a cell: G and g the lit and shaded green, R and r the lit and shaded red, . nothing. */
export const MARK = [
  ".........G......",
  ".....GGggGG.....",
  "...gGGGGggGG....",
  "..gGGGGGggGG....",
  ".gGGGG..gg......",
  "gGGg............",
  "gGgg............",
  "Ggg......rrRRR..",
  "Ggg......rRRRRR.",
  "Gggg......rrrRR.",
  "Gggg.......rrRR.",
  ".gggG.rR..rrrr..",
  "..gG.RRrrrrrrr..",
  "....RRRRRRrrr...",
  ".....RRRRrr.....",
  ".......R........",
];

/** The four colours: 24-bit, and the nearest of a terminal's own sixteen (text colour; its background is ten more). */
export const COLOURS = {
  G: { rgb: [0, 200, 91], ansi: 92 },
  g: { rgb: [0, 152, 97], ansi: 32 },
  R: { rgb: [252, 31, 4], ansi: 91 },
  r: { rgb: [215, 1, 14], ansi: 31 },
};

const truecolor = () => useColor && /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
const ESC = String.fromCharCode(27);
const fg = (k) => (truecolor() ? `${ESC}[38;2;${COLOURS[k].rgb.join(";")}m` : `${ESC}[${COLOURS[k].ansi}m`);
const bg = (k) => (truecolor() ? `${ESC}[48;2;${COLOURS[k].rgb.join(";")}m` : `${ESC}[${COLOURS[k].ansi + 10}m`);

/** `text` in the logo's green. */
export const brand = (text) => (truecolor() ? `${fg("G")}${text}${ESC}[39m` : c.green(text));

/**
 * The mark as lines to print: two rows of cells to a line. The upper half block carries the upper cell as the
 * character's colour and the lower cell as its background; without colour the shape is drawn in blocks.
 */
export function markRows() {
  const lines = [];
  for (let y = 0; y < MARK.length; y += 2) {
    let line = "";
    for (let x = 0; x < MARK[y].length; x++) {
      const top = MARK[y][x];
      const bottom = MARK[y + 1][x];
      const t = top !== ".";
      const b = bottom !== ".";
      if (!t && !b) line += " ";
      else if (!useColor) line += t && b ? "█" : t ? "▀" : "▄";
      else if (t && b) line += top === bottom ? `${fg(top)}█${ESC}[39m` : `${fg(top)}${bg(bottom)}▀${ESC}[39m${ESC}[49m`;
      else line += `${fg(t ? top : bottom)}${t ? "▀" : "▄"}${ESC}[39m`;
    }
    lines.push(line);
  }
  return lines;
}

/** Whether this terminal can draw the card: a terminal, with box-drawing characters, wide enough for it. */
export function canDraw(columns = process.stdout.columns, env = process.env, platform = process.platform) {
  const unicode = platform !== "win32" || !!env.WT_SESSION || !!env.TERM_PROGRAM;
  return !!process.stdout.isTTY && unicode && env.TERM !== "dumb" && Number(columns) >= 44;
}
