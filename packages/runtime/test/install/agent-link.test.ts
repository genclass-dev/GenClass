// `genclass-runtime init --agent-link` (bin/lib/agent-link.mjs): the dev-only lines that connect a development build's
// pages to the coding agent's MCP bridge (CONTRACT.md §16), added after GenClass's import with init's markers, and
// `remove` taking them out byte for byte (bin/lib/edit.mjs). Owner, 2026-11-25: "the mcp setup leaves the app unwired".
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { linkText, planAgentLink } from "../../bin/lib/agent-link.mjs";
// @ts-expect-error plain ESM module without types
import { planRemoval } from "../../bin/lib/edit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "..", "bin", "genclass-runtime.mjs");
const MOCK_FETCH = resolve(HERE, "mock-fetch.mjs");
const VERSION = JSON.parse(readFileSync(resolve(HERE, "..", "..", "package.json"), "utf8")).version as string;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const NO_ACCOUNT = mkdtempSync(join(tmpdir(), "gc-noacct-"));
roots.push(NO_ACCOUNT);

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gc-link-"));
  roots.push(dir);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}
function cli(dir: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--import", pathToFileURL(MOCK_FETCH).href, BIN, ...args, "--no-network", "--cwd", dir], {
      encoding: "utf8",
      env: { ...process.env, GENCLASS_HOST: "", XDG_CONFIG_HOME: NO_ACCOUNT, APPDATA: NO_ACCOUNT, GENCLASS_TEST_FETCH: "fail", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

const pkg = (deps: Record<string, string>) => JSON.stringify({ name: "app", private: true, dependencies: { "@genclass/runtime": VERSION, ...deps } });
const VITE_HTML = '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n';
const LINK = [
  'import { GenClass } from "@genclass/runtime"; // genclass:init',
  'import { connectAgent } from "@genclass/runtime/agent"; // genclass:init',
  "if (import.meta.env.DEV && GenClass.runtime) connectAgent(GenClass.runtime); // genclass:init",
];

describe("init --agent-link: the dev-only lines that connect the app to the coding agent (CONTRACT.md §16)", () => {
  it("a set-up Vite app gets the three marked lines right after the auto import; again: nothing to do; remove: back byte for byte", () => {
    const main = 'import { createRoot } from "react-dom/client";\n\ncreateRoot(document.getElementById("root")!).render(null);\n';
    const dir = project({ "package.json": pkg({ react: "^19", vite: "^8" }), "index.html": VITE_HTML, "src/main.tsx": main });
    const original = snapshot(dir);
    expect(cli(dir, "init", "--yes", "--no-install", "--no-token").code).toBe(0);
    const set = readFileSync(join(dir, "src/main.tsx"), "utf8");
    const r = cli(dir, "init", "--agent-link", "--yes", "--no-install");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("development builds only: a production build drops these lines");
    expect(readFileSync(join(dir, "src/main.tsx"), "utf8")).toBe(set.replace('import "@genclass/runtime/auto"; // genclass:init\n', `import "@genclass/runtime/auto"; // genclass:init\n${LINK.join("\n")}\n`));
    const again = cli(dir, "init", "--agent-link", "--yes", "--no-install");
    expect(again.out).toContain("Agent link already in src/main.tsx");
    expect(cli(dir, "remove", "--yes", "--keep-package").code).toBe(0);
    expect(snapshot(dir)).toEqual(original);
  });

  it("GenClass's starter (its own `import \"@genclass/runtime/auto\"`): the lines go after it, and remove leaves the starter as it was", () => {
    const main = '// the starter\nimport "@genclass/runtime/auto";\nimport { StrictMode } from "react";\n';
    const dir = project({ "package.json": pkg({ react: "^19", vite: "^8" }), "index.html": VITE_HTML, "src/main.tsx": main });
    const r = cli(dir, "init", "--agent-link", "--yes");
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(dir, "src/main.tsx"), "utf8")).toBe(`// the starter\nimport "@genclass/runtime/auto";\n${LINK.join("\n")}\nimport { StrictMode } from "react";\n`);
    expect(cli(dir, "remove", "--yes", "--keep-package").code).toBe(0);
    expect(readFileSync(join(dir, "src/main.tsx"), "utf8")).toBe(main);
  });

  it("a hand-written `const rt = GenClass.init({ ... })` over several lines: the call goes after the statement, on that rt", () => {
    const main = 'import { GenClass } from "@genclass/runtime";\nconst rt = GenClass.init({\n  mode: "guard",\n});\nstart(rt);\n';
    const dir = project({ "package.json": pkg({ react: "^19", vite: "^8" }), "index.html": VITE_HTML, "src/main.tsx": main });
    expect(cli(dir, "init", "--agent-link", "--yes").code).toBe(0);
    expect(readFileSync(join(dir, "src/main.tsx"), "utf8")).toBe(
      'import { GenClass } from "@genclass/runtime";\nconst rt = GenClass.init({\n  mode: "guard",\n});\nimport { connectAgent } from "@genclass/runtime/agent"; // genclass:init\nif (import.meta.env.DEV) connectAgent(rt); // genclass:init\nstart(rt);\n',
    );
    expect(cli(dir, "remove", "--yes", "--keep-package").code).toBe(0);
    expect(readFileSync(join(dir, "src/main.tsx"), "utf8")).toBe(main);
  });

  it("a new SvelteKit setup with --agent-link: the lines sit inside the block init creates, and remove deletes the file", () => {
    const dir = project({ "package.json": pkg({ "@sveltejs/kit": "^2", vite: "^8" }), "src/routes/+page.svelte": "<h1>hi</h1>\n" });
    const r = cli(dir, "init", "--agent-link", "--yes", "--no-install", "--no-token");
    expect(r.code, r.out).toBe(0);
    const hooks = readFileSync(join(dir, "src/hooks.client.js"), "utf8");
    expect(hooks).toContain('import "@genclass/runtime/auto";\nimport { GenClass } from "@genclass/runtime";\nimport { connectAgent } from "@genclass/runtime/agent";\nif (import.meta.env.DEV && GenClass.runtime) connectAgent(GenClass.runtime);\n// genclass:init end');
    expect(cli(dir, "remove", "--yes", "--keep-package").code).toBe(0);
    expect(existsSync(join(dir, "src/hooks.client.js"))).toBe(false);
  });

  it("Next.js tests process.env.NODE_ENV; a build with no known development check (Angular) gets the lines printed, nothing written", () => {
    const next = project({ "package.json": pkg({ next: "^16", react: "^19" }), "instrumentation-client.ts": 'import "@genclass/runtime/auto";\n' });
    expect(cli(next, "init", "--agent-link", "--yes").code).toBe(0);
    expect(readFileSync(join(next, "instrumentation-client.ts"), "utf8")).toContain('if (process.env.NODE_ENV === "development" && GenClass.runtime) connectAgent(GenClass.runtime); // genclass:init');
    const ng = project({ "package.json": pkg({ "@angular/core": "^20" }), "src/main.ts": 'import "@genclass/runtime/auto";\nbootstrap();\n' });
    const before = snapshot(ng);
    const r = cli(ng, "init", "--agent-link", "--yes");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Could not add the agent link here");
    expect(r.out).toContain('import { connectAgent } from "@genclass/runtime/agent";');
    expect(snapshot(ng)).toEqual(before);
  });

  it("without --yes and no terminal nothing is written; --dry-run shows the lines and writes nothing", () => {
    const dir = project({ "package.json": pkg({ react: "^19", vite: "^8" }), "index.html": VITE_HTML, "src/main.tsx": 'import "@genclass/runtime/auto";\n' });
    const before = snapshot(dir);
    const ask = cli(dir, "init", "--agent-link");
    expect(ask.code).toBe(1);
    expect(ask.out).toContain("Not a terminal, so nothing was written");
    const dry = cli(dir, "init", "--agent-link", "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("+ if (import.meta.env.DEV && GenClass.runtime) connectAgent(GenClass.runtime); // genclass:init");
    expect(snapshot(dir)).toEqual(before);
  });

  it("an app that already imports the agent entry is linked; remove refuses an agent line someone edited", () => {
    const dir = project({ "package.json": pkg({ vite: "^8" }), "index.html": VITE_HTML, "src/main.tsx": 'import "@genclass/runtime/auto";\nimport { connectAgent } from "@genclass/runtime/agent";\n' });
    expect(planAgentLink({ framework: "vite" }, dir, [join(dir, "src/main.tsx")])).toMatchObject({ done: true, where: "src/main.tsx" });
    expect(linkText('import "@genclass/runtime/auto";\n', null)).toBeNull();
    const edited = 'import { connectAgent } from "@genclass/runtime/agent"; // genclass:init\nif (import.meta.env.DEV) connectAgent(rt, { anyHost: true }); // genclass:init\n';
    expect(planRemoval(edited).problems).toHaveLength(1);
    // a formatter's wrap of the call is still init's statement
    expect(planRemoval('if (import.meta.env.DEV && GenClass.runtime)\n  connectAgent(GenClass.runtime); // genclass:init\nrest();\n')).toEqual({ text: "rest();\n", problems: [] });
  });
});
