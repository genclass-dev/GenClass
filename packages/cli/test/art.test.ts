// The welcome card and its mark (src/art.mjs, src/tui.mjs card): rows that line up, the right words for who is
// there, and never drawn where it cannot be.
import { describe, expect, it } from "vitest";
import { canDraw, MARK } from "../src/art.mjs";
import { nearest } from "../src/cli.mjs";
import { card, firstName, folderName, nextBlock } from "../src/tui.mjs";
import { isolate, printed } from "./helpers.js";

isolate();

const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("genclass: the welcome card (src/art.mjs header, src/tui.mjs card)", () => {
  it("the mark is five rows of one width, made of block characters only", () => {
    expect(MARK).toHaveLength(5);
    expect(new Set(MARK.map((r) => [...r].length))).toEqual(new Set([9]));
    expect(MARK.join("")).toMatch(/^[ █▀▄]+$/);
  });

  it("is drawn only on a terminal that has the characters and the room", () => {
    const tty = process.stdout.isTTY;
    try {
      process.stdout.isTTY = false;
      expect(canDraw(120, {}, "darwin")).toBe(false);
      process.stdout.isTTY = true;
      expect(canDraw(120, {}, "darwin")).toBe(true);
      expect(canDraw(58, {}, "darwin")).toBe(true); // a narrow window still gets the card
      expect(canDraw(43, {}, "linux")).toBe(false);
      expect(canDraw(120, { TERM: "dumb" }, "linux")).toBe(false);
      expect(canDraw(120, {}, "win32")).toBe(false);
      expect(canDraw(120, { WT_SESSION: "1" }, "win32")).toBe(true);
      expect(canDraw(undefined, {}, "darwin")).toBe(false);
    } finally {
      process.stdout.isTTY = tty;
    }
  });

  it("every row of the card is as wide as the rule under the other screens, whoever is there", async () => {
    const cols = process.stdout.columns;
    try {
      for (const width of [58, 72, 120]) {
        process.stdout.columns = width;
        for (const h of [
          { app: "shop", framework: "Vite + React", account: "ada@example.com", plan: "Team", cwd: "/home/ada/shop", version: "9.9.9" },
          { app: "a-very-long-application-name-that-goes-on-and-on", framework: "Next.js 16 (App Router)", account: null, plan: null, cwd: `/x/${"deep/".repeat(30)}app`, version: "9.9.9" },
        ]) {
          const lines = plain(await printed(() => card(h))).split("\n").filter((l) => /[│╭╰]/.test(l));
          expect(lines.length).toBeGreaterThan(10);
          const want = Math.max(60, Math.min(96, width)) - 2;
          expect(new Set(lines.map((l) => [...l].length)), `${width} columns`).toEqual(new Set([want]));
        }
      }
    } finally {
      process.stdout.columns = cols;
    }
  });

  it("someone signed in is welcomed back by name; a new person is told what GenClass does", async () => {
    const back = plain(await printed(() => card({ app: "shop", framework: "Vite + React", account: "ada.lovelace@example.com", plan: "Team", cwd: "/home/ada/shop", version: "9.9.9" })));
    expect(back).toContain("╭─ GenClass ─");
    expect(back).toContain(" v9.9.9 ─╮");
    expect(back).toContain("Welcome back, Ada!");
    expect(back).toContain("ada.lovelace@example.com • Team plan");
    expect(back).toContain("shop • Vite + React");
    expect(back).not.toContain("Finds what breaks");
    const fresh = plain(await printed(() => card({ app: "shop", framework: null, account: null, plan: null, cwd: "/home/ada/shop", version: "9.9.9" })));
    expect(fresh).toContain("Welcome to GenClass");
    expect(fresh).toContain("Finds what breaks in your web app,");
    expect(fresh).toContain("not signed in");
    // a server's or a project's text cannot draw on the card
    const odd = plain(await printed(() => card({ app: "shop\u001b[2J\u0007", account: "x@example.com", version: "1" })));
    expect(odd).not.toMatch(/\u0007|\u001b/);
    // a test host is said under the card
    expect(plain(await printed(() => card({ account: null, host: "http://localhost:8797", version: "1" })))).toContain("talking to http://localhost:8797");
  });

  it("names: the start of an email address or a GitHub name, capitalised; nothing when there is no name in it", () => {
    expect(firstName("mehar@daybot.ca")).toBe("Mehar");
    expect(firstName("ada.lovelace+work@example.com")).toBe("Ada");
    expect(firstName("GitHub octo-cat")).toBe("Octocat");
    expect(firstName("account acct0000000000000000001")).toBeNull();
    expect(firstName("")).toBeNull();
    expect(firstName("\u001b[31m@example.com")).toBeNull();
  });

  it("folders: the home folder is ~, and a long path keeps its end", () => {
    expect(folderName("/Users/ada/code/shop", 48, "/Users/ada")).toBe("~/code/shop");
    expect(folderName("/Users/ada", 48, "/Users/ada")).toBe("~");
    expect(folderName("/Users/adam/shop", 48, "/Users/ada")).toBe("/Users/adam/shop");
    const long = folderName(`/srv/${"deep/".repeat(20)}shop`, 30, "/Users/ada");
    expect([...long]).toHaveLength(30);
    expect(long.startsWith("…")).toBe(true);
    expect(long.endsWith("deep/shop")).toBe(true);
  });

  it("what comes next stands beside a bar, title on the first line", async () => {
    const said = plain(await printed(() => nextBlock("Sign in", "Opens genclass.dev in your browser.")));
    const lines = said.split("\n").filter(Boolean);
    expect(lines[0]).toMatch(/^ {2}[▎|] Next {2}Sign in$/);
    expect(lines[1]).toMatch(/^ {2}[▎|] Opens genclass\.dev in your browser\.$/);
  });
});

describe("genclass: a mistyped command (src/cli.mjs nearest)", () => {
  it("names the command two edits away at most, and nothing for a word that is none of them", () => {
    expect(nearest("dashbord")).toBe("dashboard");
    expect(nearest("sugest")).toBe("suggest");
    expect(nearest("STATUS")).toBe("status");
    expect(nearest("logn")).toBe("login");
    expect(nearest("frobnicate")).toBeNull();
    expect(nearest("")).toBeNull();
  });
});
