// The wordmark the command opens with (src/art.mjs): letters that line up, and never drawn where it cannot be.
import { describe, expect, it } from "vitest";
import { blockRows, canDraw, LETTERS, opening, WORDMARK } from "../src/art.mjs";
import { isolate, printed } from "./helpers.js";

isolate();

describe("genclass: the opening wordmark (src/art.mjs header)", () => {
  it("every letter is six rows of one width, and the word's rows are all as wide", () => {
    for (const [ch, rows] of Object.entries(LETTERS)) {
      expect(rows, ch).toHaveLength(6);
      expect(new Set(rows.map((r) => [...r].length)).size, ch).toBe(1);
    }
    expect(WORDMARK).toEqual(blockRows("GENCLASS"));
    expect(new Set(WORDMARK.map((r) => [...r].length))).toEqual(new Set([67]));
    // only box-drawing characters and spaces
    expect(WORDMARK.join("")).toMatch(/^[ █╗╔╝╚═║]+$/);
  });

  it("is drawn only on a terminal that is wide enough and has the characters", () => {
    const tty = process.stdout.isTTY;
    try {
      process.stdout.isTTY = false;
      expect(canDraw(120, {}, "darwin")).toBe(false);
      process.stdout.isTTY = true;
      expect(canDraw(120, {}, "darwin")).toBe(true);
      expect(canDraw(70, {}, "darwin")).toBe(false);
      expect(canDraw(71, {}, "linux")).toBe(true);
      expect(canDraw(120, { TERM: "dumb" }, "linux")).toBe(false);
      expect(canDraw(120, {}, "win32")).toBe(false);
      expect(canDraw(120, { WT_SESSION: "1" }, "win32")).toBe(true);
      expect(canDraw(undefined, {}, "darwin")).toBe(false);
    } finally {
      process.stdout.isTTY = tty;
    }
  });

  it("anywhere else the opening is the name on one line, what it does and the version", async () => {
    const said = await printed(() => opening("9.9.9"));
    expect(said).not.toContain("█");
    expect(said.trim().split("\n").map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").trim())).toEqual(["GenClass", "Finds what breaks in your web app, and tells you what it needs next.  v9.9.9"]);
  });
});
