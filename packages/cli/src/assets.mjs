// What the build puts into the `genclass` command: its own version, the runtime and MCP server versions it installs,
// and the text of the one workflow file. A checkout without a build reads the same values from the repository.
//
// Invariants:
// - WORKFLOW_FILE is docs/github-app/workflows/genclass.yml, character for character (the build reads that file; the
//   collector keeps the same text in telemetry-worker/src/github/workflow-file.ts, and a test compares the three).
// - The versions are the ones in this repository's package.json files at build time, so a published `genclass`
//   installs the runtime and the MCP server it was built and tested with, never npm's bare `latest`.

import { readFileSync } from "node:fs";

/* global __GENCLASS_BUILD__ */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const version = (rel) => JSON.parse(read(rel)).version;

/** @type {{ version: string, runtimeVersion: string, mcpVersion: string, workflow: string }} */
export const BUILD =
  typeof __GENCLASS_BUILD__ !== "undefined"
    ? __GENCLASS_BUILD__
    : {
        version: version("../package.json"),
        runtimeVersion: version("../../runtime/package.json"),
        mcpVersion: version("../../mcp/package.json"),
        workflow: read("../../../docs/github-app/workflows/genclass.yml"),
      };

export const WORKFLOW_FILE = BUILD.workflow;
