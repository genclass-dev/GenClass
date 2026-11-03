// The built package as OpenCode loads it: dist/index.js through `exports["."]` and `exports["./server"]` (V1 reads
// `./server`, then `main`; V2 resolves `<name>/server`, then `<name>`), one default export and no named runtime
// export (V1's legacy loader calls every exported function), and the pinned @genclass/mcp version in step with
// packages/mcp/package.json. Needs `npm run build -w opencode-genclass` first.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const mcp = JSON.parse(readFileSync(new URL("../mcp/package.json", root), "utf8"));
const built = existsSync(new URL("dist/index.js", root));

describe("the package OpenCode installs", () => {
  it("package.json: ESM, main and both exports on dist/index.js, no dependencies", () => {
    expect(pkg.name).toBe("opencode-genclass");
    expect(pkg.type).toBe("module");
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.exports["."].import).toBe("./dist/index.js");
    expect(pkg.exports["./server"].import).toBe("./dist/index.js");
    expect(pkg.exports["./tui"]).toBeUndefined();
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });

  it("the source pins @genclass/mcp's current version", () => {
    const src = readFileSync(new URL("src/index.ts", root), "utf8");
    expect(src).toContain(`"@genclass/mcp@${mcp.version}"`);
    expect(readFileSync(new URL("README.md", root), "utf8")).toContain(`@genclass/mcp@${mcp.version}`);
  });

  it.skipIf(!built)("dist/index.js has a single default export with id, setup and server", async () => {
    const mod = (await import(new URL("dist/index.js", root).href)) as Record<string, unknown>;
    expect(Object.keys(mod)).toEqual(["default"]);
    const d = mod.default as Record<string, unknown>;
    expect(d.id).toBe("genclass");
    expect(typeof d.setup).toBe("function");
    expect(typeof d.server).toBe("function");
    expect(readFileSync(new URL("dist/index.js", root), "utf8")).toContain(`@genclass/mcp@${mcp.version}`);
  });
});
