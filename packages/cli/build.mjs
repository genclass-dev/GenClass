// Builds the published `genclass` command: one file, dist/genclass.mjs, with no dependencies, so `npx genclass`
// downloads a few hundred kilobytes and starts at once. The bundle holds this package's sources and the runtime
// CLI's modules they reuse (packages/runtime/bin/lib), plus what assets.mjs would otherwise read from the
// repository: the versions it installs and the text of the one workflow file.

import { build } from "esbuild";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const version = (rel) => JSON.parse(readFileSync(here(rel), "utf8")).version;

const BUILD = {
  version: version("./package.json"),
  runtimeVersion: version("../runtime/package.json"),
  mcpVersion: version("../mcp/package.json"),
  workflow: readFileSync(here("../../docs/github-app/workflows/genclass.yml"), "utf8"),
  skill: readFileSync(here("../mcp/plugin/skills/genclass/SKILL.md"), "utf8"),
};

await build({
  entryPoints: [here("./src/main.mjs")],
  outfile: here("./dist/genclass.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  define: { __GENCLASS_BUILD__: JSON.stringify(BUILD) },
  legalComments: "none",
  logLevel: "warning",
});

const kb = (statSync(here("./dist/genclass.mjs")).size / 1024).toFixed(0);
console.log(`dist/genclass.mjs ${kb} KB (genclass ${BUILD.version}, runtime ${BUILD.runtimeVersion}, mcp ${BUILD.mcpVersion})`);
