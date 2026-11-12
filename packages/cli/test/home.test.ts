// The command's home (src/home.mjs): after the setup the command stays open for commands and questions. And how the
// command is typed on this machine (src/name.mjs): `genclass` once it is installed, `npx genclass` until then.
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMANDS as ALL, nearest, run } from "../src/cli.mjs";
import { COMMANDS, home, menu, offerInstall, read, words } from "../src/home.mjs";
import { readPrefs, savePrefs, shorten, shortNameWorks } from "../src/name.mjs";
import { isolate, printed, tempDir, write } from "./helpers.js";
import { plainLines, tooWide } from "./stats.js";

isolate();

const input = new PassThrough();
(input as unknown as { isTTY: boolean }).isTTY = true;
const real = Object.getOwnPropertyDescriptor(process, "stdin")!;
beforeAll(() => Object.defineProperty(process, "stdin", { value: input, configurable: true }));
afterAll(() => Object.defineProperty(process, "stdin", real));
const type = (...lines: string[]) => lines.forEach((l, i) => setTimeout(() => input.write(`${l}\n`), 30 * (i + 1)));
async function at58(fn: () => unknown): Promise<string> {
  const before = process.stdout.columns;
  process.stdout.columns = 58;
  try {
    return await printed(fn);
  } finally {
    process.stdout.columns = before;
  }
}

describe("genclass: how the command is typed here (src/name.mjs)", () => {
  it("`genclass` works when it is in a folder the person's shell searches, not npx's own or a project's", () => {
    const bin = (dir: string) => {
      write(dir, { genclass: "#!/bin/sh\n" });
      chmodSync(join(dir, "genclass"), 0o755);
      return dir;
    };
    const global = bin(tempDir());
    const npx = bin(join(tempDir(), "_npx", "abc123", "node_modules", ".bin"));
    const local = bin(join(tempDir(), "node_modules", ".bin"));
    expect(shortNameWorks({ PATH: `/usr/bin:${global}` }, "linux")).toBe(true);
    // npx puts its own folder on the PATH for the run it started; the shell that comes back does not have it
    expect(shortNameWorks({ PATH: `${npx}:/usr/bin` }, "linux")).toBe(false);
    expect(shortNameWorks({ PATH: `${local}:/usr/bin` }, "linux")).toBe(false);
    expect(shortNameWorks({ PATH: "" }, "linux")).toBe(false);
    // a file that cannot be run is not the command
    const dead = tempDir();
    write(dead, { genclass: "x" });
    chmodSync(join(dead, "genclass"), 0o644);
    expect(shortNameWorks({ PATH: dead }, "linux")).toBe(false);
  });

  it("every `npx genclass` is said the short way once the command is installed, and nothing else changes", () => {
    expect(shorten("Run npx genclass fix, then npx genclass problems.")).toBe("Run genclass fix, then genclass problems.");
    expect(shorten("npm install -g genclass")).toBe("npm install -g genclass");
    expect(shorten("npx genclassic")).toBe("npx genclassic");
    // what it remembers for the person sits next to the sign-in, not in a project
    expect(readPrefs()).toEqual({});
    expect(savePrefs({ installAsked: true })).toBe(true);
    expect(savePrefs({ askTold: true })).toBe(true);
    expect(readPrefs()).toEqual({ installAsked: true, askTold: true });
  });

  it("installing is offered once, as the command it runs, and only with a yes", async () => {
    const before = process.env.CI;
    delete process.env.CI;
    try {
      const ran: string[] = [];
      type("n");
      const no = await at58(async () => expect(await offerInstall({ install: async (v: string) => (ran.push(v), { ok: true, text: "" }) })).toBe("declined"));
      expect(tooWide(no)).toEqual([]);
      const flat = plainLines(no).join(" ").replace(/\s+/g, " ");
      expect(flat).toContain("Type just genclass from now on?");
      expect(flat).toContain("npm install -g genclass");
      expect(ran).toEqual([]);
      // asked once: the answer is remembered
      expect(await offerInstall({ install: async () => ({ ok: true, text: "" }) })).toBe("skipped");
      savePrefs({ installAsked: false });
      type("");
      const yes = await at58(async () => expect(await offerInstall({ install: async (v: string) => (ran.push(v), { ok: true, text: "" }), works: () => false })).toBe("installed"));
      expect(ran).toHaveLength(1);
      expect(yes).toContain("Open a new terminal and type genclass.");
      savePrefs({ installAsked: false });
      type("");
      const failed = await at58(async () => expect(await offerInstall({ install: async () => ({ ok: false, text: "EACCES" }) })).toBe("failed"));
      expect(plainLines(failed).join(" ").replace(/\s+/g, " ")).toContain("npm install -g genclass (some systems need sudo in front)");
    } finally {
      process.env.CI = before;
    }
  });
});

describe("genclass: the home (src/home.mjs)", () => {
  it("a typed line is a command, a question, help, or leaving", () => {
    expect(words(`funnels add "Check out" /cart '/thank you'`)).toEqual(["funnels", "add", "Check out", "/cart", "/thank you"]);
    expect(read("")).toEqual({ help: true });
    expect(read("help")).toEqual({ help: true, all: true });
    expect(read("?")).toEqual({ help: true, all: true });
    for (const q of ["q", "quit", "exit", "Q"]) expect(read(q)).toEqual({ quit: true });
    expect(read("problems --all")).toEqual({ command: ["problems", "--all"] });
    expect(read("Analytics sources")).toEqual({ command: ["analytics", "sources"] });
    expect(read('ask "why is checkout slow"')).toEqual({ command: ["ask", "why is checkout slow"] });
    // a sentence, or anything that ends in a question mark, is a question about the app
    expect(read("what is going wrong on my site")).toEqual({ question: "what is going wrong on my site" });
    expect(read("why?")).toEqual({ question: "why?" });
    expect(read("problms")).toEqual({ unknown: "problms" });
  });

  it("every command the home lists is one the command line runs, and the list fits 58 columns", async () => {
    for (const [name] of COMMANDS) expect(ALL).toContain(name.split(" ")[0]);
    // and nothing the command line has for an app is missing from the home's full list
    for (const name of ["dashboard", "problems", "analytics", "events", "health", "report", "export", "fix", "ask", "suggest", "connections", "agent", "funnels", "apps", "plan", "team"]) expect(COMMANDS.map(([n]) => n.split(" ")[0])).toContain(name);
    const short = await at58(() => menu());
    const full = await at58(() => menu(true));
    expect(tooWide(short)).toEqual([]);
    expect(tooWide(full)).toEqual([]);
    expect(short).toContain("ask about your app (or just type it)");
    expect(short).not.toContain("the people on your plan");
    expect(full).toContain("the people on your plan");
    expect(plainLines(short).filter((l) => l.trim()).length).toBeLessThanOrEqual(11);
  });

  it("the home runs what is typed in the folder it started in, takes a sentence as a question, and stays open until q", async () => {
    const ran: string[][] = [];
    type("problems --all", "what is going wrong on my site", "problms", "", "q");
    const said = await at58(async () => expect(await home({ cwd: "/app" }, { runCommand: async (a: string[]) => (ran.push(a), 0), nearest })).toBe(0));
    expect(ran).toEqual([["problems", "--all", "--cwd", "/app"], ["ask", "what is going wrong on my site", "--cwd", "/app"]]);
    const flat = plainLines(said).join(" ").replace(/\s+/g, " ");
    expect(flat).toContain('There is no command "problms". Did you mean problems?');
    // an empty Enter shows the list again
    expect(said.split("What next?").length).toBe(3);
    expect(flat).toContain("Run npx genclass any time to come back here.");
    expect(tooWide(said)).toEqual([]);
    // a command that throws does not end it
    type("dashboard", "q");
    const after = await at58(async () => expect(await home({}, { runCommand: async () => Promise.reject(new Error("boom")), nearest })).toBe(0));
    expect(after).toContain("That did not work: boom");
  });

  it("a command typed with a word it does not take is told so, not run as something else", async () => {
    const errs: string[] = [];
    const spy = (await import("vitest")).vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => (errs.push(String(s)), true)) as never);
    try {
      expect(await run(["agent", "nonsense"])).toBe(2);
      expect(errs.join("")).toContain("npx genclass agent link");
      errs.length = 0;
      expect(await run(["fix", "--bogus"])).toBe(2);
      expect(errs.join("")).toContain("unknown option");
    } finally {
      spy.mockRestore();
    }
  });
});
