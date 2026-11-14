// The command's home (src/home.mjs): after the setup the command stays open for commands and questions. And how the
// command is typed on this machine (src/name.mjs): `genclass` once it is installed, `npx genclass` until then.
import { BUILD } from "../src/assets.mjs";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMANDS as ALL, nearest, run } from "../src/cli.mjs";
import { COMMANDS, FREE_MENU, home, installShortName, menu, read, words } from "../src/home.mjs";
import { forgetShortName, readPrefs, savePrefs, shorten, shortNameWorks } from "../src/name.mjs";
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
    // in colour, the code just before it is not a letter of the word
    expect(shorten("Every row: \u001b[36mnpx genclass dashboard --all\u001b[39m")).toBe("Every row: \u001b[36mgenclass dashboard --all\u001b[39m");
    expect(shorten("xnpx genclass")).toBe("xnpx genclass");
    // what it remembers for the person sits next to the sign-in, not in a project
    expect(readPrefs()).toEqual({});
    expect(savePrefs({ installAsked: true })).toBe(true);
    expect(savePrefs({ askTold: true })).toBe(true);
    expect(readPrefs()).toEqual({ installAsked: true, askTold: true });
  });

  it("a run through npx on a terminal installs the command itself and says so; a failure waits a day; never in CI", async () => {
    const before = process.env.CI;
    delete process.env.CI;
    try {
      const ran: string[] = [];
      const yes = await at58(async () => expect(await installShortName({ interactive: () => true, install: async (v: string) => (ran.push(v), { ok: true, text: "" }), works: () => false })).toBe("installed"));
      expect(tooWide(yes)).toEqual([]);
      expect(ran).toHaveLength(1);
      const flat = plainLines(yes).join(" ").replace(/\s+/g, " ");
      expect(flat).toContain("Added. Open a new terminal window and type genclass.");
      expect(flat).toContain("npm uninstall -g genclass takes it out.");
      // a failure says how by hand, and is not tried again for a day
      const failed = await at58(async () => expect(await installShortName({ interactive: () => true, install: async () => ({ ok: false, text: "EACCES" }), works: () => false })).toBe("failed"));
      expect(plainLines(failed).join(" ").replace(/\s+/g, " ")).toContain("npm install -g genclass (some systems need sudo in front)");
      expect(await installShortName({ interactive: () => true, install: async (v: string) => (ran.push(v), { ok: true, text: "" }), works: () => false })).toBe("skipped");
      expect(await installShortName({ interactive: () => true, now: Date.now() + 25 * 60 * 60_000, install: async (v: string) => (ran.push(v), { ok: true, text: "" }), works: () => false })).toBe("installed");
      expect(ran).toHaveLength(2);
      // already there, no terminal, or CI: nothing runs
      expect(await installShortName({ interactive: () => true, install: async (v: string) => (ran.push(v), { ok: true, text: "" }), works: () => true, installedVersion: () => null })).toBe("skipped");
      expect(await installShortName({ interactive: () => false, install: async (v: string) => (ran.push(v), { ok: true, text: "" }), works: () => false })).toBe("skipped");
      process.env.CI = "1";
      expect(await installShortName({ interactive: () => true, install: async (v: string) => (ran.push(v), { ok: true, text: "" }), works: () => false })).toBe("skipped");
      expect(ran).toHaveLength(2);
    } finally {
      if (before === undefined) delete process.env.CI;
      else process.env.CI = before;
    }
  });

  it("the installed command stays current: npx replaces an older copy, the installed one asks npm once a day (the 0.3.7 walk)", async () => {
    const before = process.env.CI;
    delete process.env.CI;
    try {
      const ran: string[] = [];
      const install = async (v: string) => (ran.push(v), { ok: true, text: "" });
      const fresh = () => forgetShortName();
      // npx runs the newest: an older installed copy is replaced by this version
      fresh();
      const up = await at58(async () => expect(await installShortName({ interactive: () => true, install, works: () => true, installedVersion: () => "0.3.6", viaNpx: () => true })).toBe("updated"));
      expect(ran).toEqual([BUILD.version]);
      expect(plainLines(up).join(" ")).toContain(`Updating the genclass command, 0.3.6 to ${BUILD.version}`);
      expect(tooWide(up)).toEqual([]);
      // the same version installed: nothing to do, and nothing asked of npm
      let asked = 0;
      const latest = async () => (asked++, "99.0.0");
      fresh();
      expect(await installShortName({ interactive: () => true, install, works: () => true, installedVersion: () => BUILD.version, viaNpx: () => true, latest })).toBe("skipped");
      expect(asked).toBe(0);
      // the installed copy asks npm, at most once a day, and updates to what npm has
      const now = Date.now() + 3 * 24 * 60 * 60_000;
      fresh();
      expect(await installShortName({ interactive: () => true, install, works: () => true, installedVersion: () => BUILD.version, viaNpx: () => false, latest, now })).toBe("updated");
      expect(ran).toEqual([BUILD.version, "99.0.0"]);
      fresh();
      expect(await installShortName({ interactive: () => true, install, works: () => true, installedVersion: () => BUILD.version, viaNpx: () => false, latest, now: now + 60_000 })).toBe("skipped");
      expect(asked).toBe(1);
    } finally {
      if (before === undefined) delete process.env.CI;
      else process.env.CI = before;
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
    // a command typed whole, as a screen printed it, is that command and not a question
    expect(read("npx genclass fix 2")).toEqual({ command: ["fix", "2"] });
    expect(read("genclass problems")).toEqual({ command: ["problems"] });
    expect(read("npx genclass dashbord")).toEqual({ unknown: "dashbord" });
    // a number is the command listed with it
    expect(read("1")).toEqual({ command: ["dashboard"] });
    expect(read(String(COMMANDS.findIndex(([n]) => n === "profile") + 1))).toEqual({ command: ["profile"] });
    expect(read("99")).toEqual({ unknown: "99", number: true });
    // a verb in front of a command is that command; on Free the numbers are the short list's
    expect(read("show problems")).toEqual({ command: ["problems"] });
    expect(read("open dashboard")).toEqual({ command: ["dashboard"] });
    expect(read("1", undefined, FREE_MENU)).toEqual({ command: ["upgrade"] });
    expect(read("npx genclass")).toEqual({ help: true });
    // every command the command line has, including the runtime's own, is a command here and never a question
    for (const cmd of ["connect", "init", "audit"]) expect(read(`${cmd} --name shop now`)).toEqual({ command: [cmd, "--name", "shop", "now"] });
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

  it("y runs what a 'Did you mean' named; a number no command has says so; on Free the list is what works there (the 0.3.9 user stories)", async () => {
    const ran: string[][] = [];
    type("dashbord", "y", "99", "q");
    const said = await at58(async () => expect(await home({}, { runCommand: async (a: string[]) => (ran.push(a), 0), nearest })).toBe(0));
    expect(ran).toEqual([["dashboard"]]);
    const flat = plainLines(said).join(" ").replace(/\s+/g, " ");
    expect(flat).toContain("Did you mean dashboard? (y runs it)");
    expect(flat).toContain("No command has the number 99.");
    // y with nothing named before it is not a yes to anything
    type("y", "q");
    const plain = await at58(async () => expect(await home({}, { runCommand: async (a: string[]) => (ran.push(a), 0), nearest })).toBe(0));
    expect(ran).toHaveLength(1);
    expect(plainLines(plain).join(" ")).toContain('There is no command "y"');
    // Free: the short list is the commands that work without Pro, and 1 is upgrade
    type("1", "q");
    const free = await at58(async () => expect(await home({ free: true }, { runCommand: async (a: string[]) => (ran.push(a), 0), nearest })).toBe(0));
    expect(ran[1]).toEqual(["upgrade"]);
    const freeFlat = plainLines(free).join(" ").replace(/\s+/g, " ");
    expect(freeFlat).toContain("You are on Free: the other commands come with Pro.");
    expect(freeFlat).not.toContain("what GenClass found on your live site");
    expect(tooWide(free)).toEqual([]);
  });

  it("opening: signed out in a folder that is set up says to sign in, not that it is not set up (the 0.3.9 user stories)", async () => {
    const { opening } = await import("../src/home.mjs");
    const base = { app: { name: "shop", framework: "Vite", token: "gc_x" }, steps: [], projects: [], account: null, host: null };
    expect(plainLines(await at58(() => opening({ ...base, signedIn: false, sessionProblem: null } as never))).join(" ")).toContain("Not signed in. Type login to sign in again.");
    expect(plainLines(await at58(() => opening({ ...base, signedIn: false, sessionProblem: "expired" } as never))).join(" ")).toContain("Your sign-in expired. Type login to sign in again.");
    const fresh = plainLines(await at58(() => opening({ ...base, app: { name: "shop", token: null }, signedIn: false, sessionProblem: null } as never))).join(" ").replace(/\s+/g, " ");
    expect(fresh).toContain("Not signed in, and GenClass is not in this app yet. Type setup");
    const unset = plainLines(await at58(() => opening({ ...base, app: { name: "shop", token: null }, signedIn: true, sessionProblem: null } as never))).join(" ");
    expect(unset).toContain("GenClass is not set up in this folder yet.");
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

describe("genclass: the walk leads into the home (src/setup.mjs)", () => {
  it("q in the walk leaves the walk, not the command: the home opens, in the folder and on the app of the walk", async () => {
    const { setup } = await import("../src/setup.mjs");
    const { viteApp } = await import("./helpers.js");
    const dir = tempDir();
    viteApp(dir);
    const opened: Record<string, unknown>[] = [];
    type("q");
    const said = await at58(async () => expect(await setup({ cwd: dir }, { home: async (o: Record<string, unknown>) => (opened.push(o), 0) })).toBe(0));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ cwd: dir, app: "shop" });
    // the same key is called the same everywhere
    expect(said).toContain("q stop");
    expect(plainLines(said).join(" ")).toContain("Setup stopped here. Type setup to go on with it.");
    // run from inside the home, the walk ends as it always did (no home inside the home)
    type("q");
    const nested = await at58(async () => expect(await setup({ cwd: dir, home: false }, { home: async () => (opened.push({}), 0) })).toBe(0));
    expect(opened).toHaveLength(1);
    expect(nested).toContain("q stop");
    // inside the prompt, setup is typed again
    expect(plainLines(nested).join(" ")).toContain("Setup stopped here. Type setup to go on with it.");
  });

  it("in the home a view is not headed again, and names its app only when it is another one", async () => {
    const { header, inHome } = await import("../src/tui.mjs");
    const full = await at58(() => header({ app: "shop", account: "ada@example.com", plan: "Free" }));
    expect(full).toContain("ada@example.com");
    inHome("shop");
    try {
      expect(await at58(() => header({ app: "shop", account: "ada@example.com", plan: "Free" }))).toBe("\n");
      expect(plainLines(await at58(() => header({ app: "blog", account: "ada@example.com" }))).join("|")).toBe("|  blog|");
    } finally {
      inHome(null);
    }
  });
});
