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
