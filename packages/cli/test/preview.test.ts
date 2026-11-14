// The runtime CLI's preview as the genclass command shows it (packages/runtime/bin/lib/ui.mjs printChange, outWhole,
// more; init.mjs briefTelemetry): long diff rows fold at their spaces with a hanging indent, an address is never
// split, and under genclass-runtime (no host command) every line is what it always was.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldDiffRow, more, outWhole, printChange, renderDiff } from "../../runtime/bin/lib/ui.mjs";
import { run as runInit, TELEMETRY_URL } from "../../runtime/bin/lib/init.mjs";
import { isolate, printed, tempDir, viteApp, write } from "./helpers.js";

isolate();

const HOST = { name: "genclass", brand: "GenClass", cmd: "npx genclass", version: "0.4.0-alpha.0", runtimeVersion: "0.3.8", mcpVersion: "0.2.2" };
const g = globalThis as { __GENCLASS_CLI__?: unknown };
const ESC = String.fromCharCode(27);
const plain = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const words = (s: string) => s.split(/\s+/).filter(Boolean);

let saved: unknown;
let cols: number | undefined;
beforeEach(() => {
  saved = g.__GENCLASS_CLI__;
  cols = process.stdout.columns;
  process.stdout.columns = 80;
});
afterEach(() => {
  g.__GENCLASS_CLI__ = saved;
  process.stdout.columns = cols as number;
});

const LONG = `import { QueryClient, QueryClientProvider, useQuery, useMutation } from "@tanstack/react-query"; // and more words here`;
const ADDRESS = `    <script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.8/dist/genclass.global.min.js" defer></script> <!-- genclass:init -->`;
const change = { file: "src/main.tsx", kind: "modify", before: "a();\n", after: `${LONG}\n${ADDRESS}\na();\n` };

describe("the init preview under the genclass command (runtime ui.mjs)", () => {
  it("a long diff row folds at its spaces with a hanging indent, within 78 columns, and keeps every word whole", async () => {
    g.__GENCLASS_CLI__ = HOST;
    const rows = foldDiffRow("+", LONG);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]).toMatchObject({ pad: 4, text: expect.stringMatching(/^\+ import \{ QueryClient/) });
    for (const r of rows) expect(r.pad + r.text.length, r.text).toBeLessThanOrEqual(78);
    // the lines after the first stand past the mark: a hanging indent
    for (const r of rows.slice(1)) expect(r.text.startsWith("      "), r.text).toBe(true);
    expect(words(rows.map((r) => r.text).join(" "))).toEqual(["+", ...words(LONG)]);
    // printed: the same lines, each within the window
    const lines = plain(await printed(() => printChange(change))).split("\n");
    const at = lines.findIndex((l) => l.startsWith("    + import { QueryClient"));
    expect(lines.slice(at, at + rows.length)).toEqual(rows.map((r) => `${" ".repeat(r.pad)}${r.text}`));
    // a row that fits stays one line, code indentation kept (tabs as two spaces)
    expect(foldDiffRow(" ", "\t\t<title>x</title>")).toEqual([{ pad: 4, text: "      <title>x</title>" }]);
  });

  it("an address longer than its line is never split: it is printed whole, starting further left so it fits where it can", async () => {
    g.__GENCLASS_CLI__ = HOST;
    const url = 'src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.8/dist/genclass.global.min.js"';
    const rows = foldDiffRow("+", ADDRESS);
    expect(words(rows.map((r) => r.text).join(" "))).toEqual(["+", ...words(ADDRESS)]);
    // longer than the window (84 of 80 columns): whole, at the first column, where the terminal breaks it least
    expect(rows.find((r) => r.text.includes("cdn.jsdelivr.net"))).toEqual({ pad: 0, text: url });
    // in a wider window it fits whole, on its own line
    process.stdout.columns = 96;
    const wide = foldDiffRow("+", ADDRESS).find((r) => r.text.includes("cdn.jsdelivr.net"))!;
    expect(wide.text.trim()).toBe(url);
    expect(wide.pad + wide.text.length).toBeLessThanOrEqual(96);
    process.stdout.columns = 80;
    // the telemetry address: in an 80-column window it starts at the first column, whole
    const said = plain(await printed(() => outWhole(TELEMETRY_URL, 2)));
    expect(said).toBe(`${TELEMETRY_URL}\n`);
    process.stdout.columns = 96;
    expect(plain(await printed(() => outWhole(TELEMETRY_URL, 2)))).toBe(`  ${TELEMETRY_URL}\n`);
    process.stdout.columns = 80;
    const under = plain(await printed(() => more(`What is sent: ${TELEMETRY_URL}`)));
    expect(under.split("\n")).toContain(TELEMETRY_URL);
  });

  it("init --brief under the genclass command: no line of its preview is longer than the window, and the address is one line", async () => {
    g.__GENCLASS_CLI__ = HOST;
    const dir = tempDir();
    viteApp(dir);
    const saveTags = process.env.GENCLASS_TEST_DIST_TAGS;
    process.env.GENCLASS_TEST_DIST_TAGS = "fail";
    let said = "";
    try {
      said = plain(await printed(async () => expect(await runInit("init", ["--cwd", dir, "--dry-run", "--no-install", "--no-network", "--no-devtools", "--brief"])).toBe(0)));
    } finally {
      if (saveTags === undefined) delete process.env.GENCLASS_TEST_DIST_TAGS;
      else process.env.GENCLASS_TEST_DIST_TAGS = saveTags;
    }
    const lines = said.split("\n");
    expect(lines).toContain(TELEMETRY_URL);
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(80);
  });

  it("init's Optional and Payments blocks fit 58 columns under the genclass command, and the code in them is the same code", async () => {
    const { codeLines } = await import("../../runtime/bin/lib/init.mjs");
    const dir = tempDir();
    viteApp(dir, { dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", stripe: "^17.0.0" } });
    write(dir, { "src/Cart.jsx": 'import { useState } from "react";\nexport function Cart() {\n  const [items, setItems] = useState([]);\n  const [open, setOpen] = useState(false);\n  return null;\n}\n' });
    const saveTags = process.env.GENCLASS_TEST_DIST_TAGS;
    process.env.GENCLASS_TEST_DIST_TAGS = "fail";
    const dry = () => printed(async () => expect(await runInit("init", ["--cwd", dir, "--dry-run", "--no-install", "--no-network", "--no-devtools", "--brief"])).toBe(0));
    let hostedOut = "";
    let runtimeOut = "";
    try {
      g.__GENCLASS_CLI__ = HOST;
      process.stdout.columns = 58;
      hostedOut = plain(await dry());
      g.__GENCLASS_CLI__ = undefined;
      process.stdout.columns = 80;
      runtimeOut = plain(await dry());
    } finally {
      if (saveTags === undefined) delete process.env.GENCLASS_TEST_DIST_TAGS;
      else process.env.GENCLASS_TEST_DIST_TAGS = saveTags;
    }
    // the two blocks, Optional to the end (the diff above them folds by its own rule, ui.mjs foldDiffRow)
    const lines = hostedOut.slice(hostedOut.indexOf("  Optional")).split("\n");
    expect(lines.some((l) => l.startsWith("  Optional (not applied:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("  Payments (found stripe"))).toBe(true);
    for (const l of lines.filter((x) => !/https?:\/\//.test(x))) expect(l.length, l).toBeLessThanOrEqual(58);
    // the words are the same as genclass-runtime prints them, only folded (a code line's comment moves above it)
    const block = (t: string, from: string, to: string) => words(t.slice(t.indexOf(from), t.indexOf(to))).sort();
    expect(block(hostedOut, "Optional", "Dry run")).toEqual(block(runtimeOut, "Optional", "Dry run"));
    // under genclass-runtime the lines stay whole, as they always were
    expect(runtimeOut).toContain('        const [cart, setCart] = useGenClassState("cart", initialCart); // instead of useState(initialCart)');
    expect(runtimeOut).toContain("    GenClass recommends keeping checkout and sign-in requests observe-only in every mode: it then never holds,");
    // folded code: the line comment on a line of its own above the code, breaks only at spaces outside quotes
    g.__GENCLASS_CLI__ = HOST;
    const folded = codeLines('const [cart, setCart] = useGenClassState("cart", initialCart); // instead of useState(initialCart)', 8, 60);
    expect(folded[0].trim()).toBe("// instead of useState(initialCart)");
    expect(folded.slice(1).map((l) => l.trim()).join(" ")).toBe('const [cart, setCart] = useGenClassState("cart", initialCart);');
    for (const l of folded) expect(l.length, l).toBeLessThanOrEqual(58);
    const quoted = codeLines('GenClass.runtime.guard("a store with spaces in its name", { get: () => null, set: () => null });', 8, 60);
    expect(quoted.some((l) => l.includes('"a store with spaces in its name"'))).toBe(true);
    g.__GENCLASS_CLI__ = undefined;
    expect(codeLines("x".repeat(120), 8, 60)).toEqual([`        ${"x".repeat(120)}`]);
  });

  it("init's folded code is still code: never a line break where JavaScript forbids one (an arrow's parameters and =>)", async () => {
    const { codeLines } = await import("../../runtime/bin/lib/init.mjs");
    g.__GENCLASS_CLI__ = HOST;
    // the code lines init recommends (recommendations, printMoneyAdvice), at every width from 20 to 140 columns
    const LINES = [
      'create(genclass(GenClass.runtime, "store")((set) => ({ /* your store */ })))',
      'configureStore({ reducer, enhancers: (getDefault) => getDefault().concat(genclassEnhancer(GenClass.runtime, { name: "app" })) })',
      'createStore(reducer, genclassEnhancer(GenClass.runtime, { name: "app" }))',
      'const [cart, setCart] = useGenClassState("cart", initialCart); // instead of useState(initialCart)',
      'const protect = { requests: { protect: ["preset:payments", "preset:auth"] } };',
      'const f = async (x) => { return { a: x, b: "a b, c", c: `d, e` }; }; x++; f({ k: 1 });',
    ];
    for (const line of LINES) {
      expect(() => new Function(line), line).not.toThrow();
      for (let cols = 20; cols <= 140; cols++) {
        const folded = codeLines(line, 8, cols);
        expect(() => new Function(folded.join("\n")), `${cols} columns:\n${folded.join("\n")}`).not.toThrow();
        // the same code, its comment above it once it folds
        if (folded.length === 1) expect(folded[0]).toBe(`        ${line}`);
        else expect(folded.filter((l) => !l.trim().startsWith("//")).map((l) => l.trim()).join(" "), `${cols} columns`).toBe(line.replace(/ \/\/ .*$/, ""));
        // never a line that starts with => (the break JavaScript forbids), never one that ends after return or async
        for (const l of folded) expect(/^\s*=>|\b(return|async|throw)\s*$/.test(l), `${cols} columns: ${l}`).toBe(false);
      }
    }
    // the 58 to 61 columns the review saw: Zustand's (set) and Redux Toolkit's (getDefault) stay with their =>
    for (const cols of [58, 59, 60, 61]) {
      expect(codeLines(LINES[0], 8, cols).join("\n")).toContain("((set) =>");
      expect(codeLines(LINES[1], 8, cols).join("\n")).toContain("(getDefault) =>");
    }
    // a line it cannot read surely is printed whole, as wide as it is: a regular expression (or a division), JSX, a
    // template with ${...}, a quote left open
    for (const line of [
      'const re = / a, b /g; match(re, { first: "one", second: "two", third: "three" });',
      "const el = <p className={x}>Hello, world, this is a long paragraph of text in JSX, folded</p>;",
      "const s = `a ${b, c} d`; call({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 });",
      'const s = "never closed, so the rest of it is read as a string, though it is long enough to fold',
    ]) expect(codeLines(line, 8, 60)).toEqual([`        ${line}`]);
  });

  it("init's folded imports break only around their `from`, never inside their braces (review, round 3)", async () => {
    const { codeLines } = await import("../../runtime/bin/lib/init.mjs");
    const { spawnSync } = await import("node:child_process");
    const { join } = await import("node:path");
    const { writeFileSync } = await import("node:fs");
    g.__GENCLASS_CLI__ = HOST;
    // the imports init recommends (recommendations), and a few it could
    const IMPORTS = [
      'import { genclassEnhancer } from "@genclass/runtime/redux";',
      'import { useGenClassState } from "@genclass/runtime/react";',
      'import { genclass } from "@genclass/runtime/zustand";',
      'import { GenClass } from "@genclass/runtime";',
      'import Default, { from, useGenClassState as useState } from "@genclass/runtime/a-long-module-name";',
      'export { genclassEnhancer, genclass as zustand } from "@genclass/runtime/a-long-module-name";',
      'import { GenClass } from "@genclass/runtime"; GenClass.init({ mode: "observe", telemetry: false, devtools: true });',
    ];
    // the 56 to 68 columns the review saw: as before round 2, `from` ends the first line and the module stands under it
    for (let cols = 56; cols <= 68; cols++) {
      expect(codeLines(IMPORTS[0], 8, cols), `${cols} columns`).toEqual(["        import { genclassEnhancer } from", '            "@genclass/runtime/redux";']);
      expect(codeLines(IMPORTS[1], 8, cols), `${cols} columns`).toEqual(["        import { useGenClassState } from", '            "@genclass/runtime/react";']);
      if (cols <= 62) expect(codeLines(IMPORTS[2], 8, cols), `${cols} columns`).toEqual(["        import { genclass } from", '            "@genclass/runtime/zustand";']);
    }
    const scratch = tempDir();
    const seen = new Set<string>();
    const braces = (l: string) => (l.match(/{/g) ?? []).length - (l.match(/}/g) ?? []).length;
    for (const line of IMPORTS) {
      for (let cols = 20; cols <= 140; cols++) {
        const folded = codeLines(line, 8, cols);
        // the same code; an import's braces close on the line that opened them, and nothing breaks but at `from`
        expect(folded.map((l) => l.trim()).join(" "), `${cols} columns`).toBe(line);
        const imports = line === IMPORTS[6] ? folded.filter((l) => l.includes("import {")) : folded;
        for (const l of imports) expect(braces(l.slice(0, l.includes(";") ? l.indexOf(";") : l.length)), `${cols} columns: ${l}`).toBe(0);
        for (const [i, l] of folded.entries()) if (i && imports.includes(folded[i - 1]) && !folded[i - 1].includes(";")) expect(/ from$/.test(folded[i - 1]) || /^\s*from\b/.test(l), `${cols} columns:\n${folded.join("\n")}`).toBe(true);
        seen.add(folded.join("\n"));
      }
    }
    // each distinct fold is a module node reads
    let n = 0;
    for (const code of seen) {
      const file = join(scratch, `fold-${n++}.mjs`);
      writeFileSync(file, `${code}\n`);
      const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      expect(check.status, `${code}\n${check.stderr}`).toBe(0);
    }
    // after an import's `;` the code folds by the usual rule again
    expect(codeLines(IMPORTS[6], 8, 90)).toEqual(['        import { GenClass } from "@genclass/runtime"; GenClass.init({ mode: "observe",', "            telemetry: false, devtools: true });"]);
  });

  it("init --dry-run on Zustand and Redux Toolkit apps at 58 to 61 columns: each Optional block's code parses as a module", async () => {
    const { spawnSync } = await import("node:child_process");
    const { join } = await import("node:path");
    const { writeFileSync } = await import("node:fs");
    const dir = tempDir();
    viteApp(dir);
    write(dir, {
      "src/store.js": 'import { create } from "zustand";\nexport const useStore = create((set) => ({ n: 0 }));\n',
      "src/redux.js": 'import { configureStore } from "@reduxjs/toolkit";\nexport const store = configureStore({ reducer: (s = 0) => s });\n',
    });
    const scratch = tempDir();
    const saveTags = process.env.GENCLASS_TEST_DIST_TAGS;
    process.env.GENCLASS_TEST_DIST_TAGS = "fail";
    try {
      g.__GENCLASS_CLI__ = HOST;
      for (const cols of [58, 59, 60, 61]) {
        process.stdout.columns = cols;
        const said = plain(await printed(async () => expect(await runInit("init", ["--cwd", dir, "--dry-run", "--no-install", "--no-network", "--no-devtools", "--brief"])).toBe(0)));
        const lines = said.split("\n");
        for (const title of ["Zustand store in", "Redux store in"]) {
          // the bullet, its title to the line ending "):", then the code to the next bullet or blank line
          const from = lines.findIndex((l) => l.startsWith(`    ${"•"} ${title}`) || l.startsWith(`    * ${title}`));
          expect(from, `${cols} columns: ${title}`).toBeGreaterThan(-1);
          const start = lines.findIndex((l, i) => i >= from && l.endsWith("):")) + 1;
          let end = start;
          while (end < lines.length && lines[end].trim() && !/^\s{4}[•*] /.test(lines[end])) end++;
          const code = lines.slice(start, end);
          expect(code.length).toBeGreaterThanOrEqual(3);
          const file = join(scratch, `${title.split(" ")[0]}-${cols}.mjs`);
          writeFileSync(file, `${code.join("\n")}\n`);
          const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
          expect(check.status, `${cols} columns, ${title}:\n${code.join("\n")}\n${check.stderr}`).toBe(0);
        }
      }
    } finally {
      if (saveTags === undefined) delete process.env.GENCLASS_TEST_DIST_TAGS;
      else process.env.GENCLASS_TEST_DIST_TAGS = saveTags;
    }
  });

  it("init's question about the account fits the window under the genclass command", async () => {
    const { saveCredentials } = await import("../../runtime/bin/lib/account.mjs");
    const { PassThrough } = await import("node:stream");
    const dir = tempDir();
    viteApp(dir);
    saveCredentials({ host: "https://genclass.dev", access_token: "gcs_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG", account: { id: "acct0000000000000000001", email: "someone.with.a.long.address@example.com", github_login: null } });
    const input = new PassThrough();
    (input as unknown as { isTTY: boolean }).isTTY = true;
    const real = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", { value: input, configurable: true });
    const calls: string[] = [];
    const { vi } = await import("vitest");
    vi.stubGlobal("fetch", async (u: string) => (calls.push(String(u)), new Response("{}", { status: 404 })));
    const saveTags = process.env.GENCLASS_TEST_DIST_TAGS;
    process.env.GENCLASS_TEST_DIST_TAGS = "fail";
    let said = "";
    try {
      g.__GENCLASS_CLI__ = HOST;
      process.stdout.columns = 58;
      setTimeout(() => input.write("n\n"), 30);
      setTimeout(() => input.write("n\n"), 60);
      said = plain(await printed(async () => await runInit("init", ["--cwd", dir, "--no-install", "--no-devtools", "--brief"])));
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(process, "stdin", real);
      if (saveTags === undefined) delete process.env.GENCLASS_TEST_DIST_TAGS;
      else process.env.GENCLASS_TEST_DIST_TAGS = saveTags;
    }
    expect(said.replace(/\s+/g, " ")).toContain("Signed in as someone.with.a.long.address@example.com: create this app in your GenClass account? (Y/n)");
    expect(said.replace(/\s+/g, " ")).toContain("Not in your account: init creates the app with a private dashboard link instead, as without an account.");
    // the question and its answer (the diff further down folds by its own rule, ui.mjs foldDiffRow)
    const asked = said.slice(said.indexOf("  Signed in as"), said.indexOf("Token")).split("\n");
    expect(asked.length).toBeGreaterThan(3);
    for (const l of asked) expect(l.length, l).toBeLessThanOrEqual(58);
    expect(calls).toEqual([]);
  });

  it("under genclass-runtime (no host command) every row stays one line, byte for byte as before", async () => {
    g.__GENCLASS_CLI__ = undefined;
    const said = plain(await printed(() => printChange(change)));
    expect(said).toBe(`  src/main.tsx (modify)\n    @@ -1,1 +1,3 @@\n    + ${LONG}\n    + ${ADDRESS}\n      a();\n\n`);
    expect(renderDiff(change.before, change.after).map(plain)).toEqual(["@@ -1,1 +1,3 @@", `+ ${LONG}`, `+ ${ADDRESS}`, "  a();"]);
    expect(plain(await printed(() => outWhole(TELEMETRY_URL, 2)))).toBe(`  ${TELEMETRY_URL}\n`);
  });
});
