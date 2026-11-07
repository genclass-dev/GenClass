#!/usr/bin/env node
// genclass, the short command: `genclass <command>` runs `genclass-runtime <command>`, the CLI of the @genclass/runtime
// this package depends on (the same version: release.yml pins it exactly in the published package; in this repository
// npm links packages/runtime). It adds nothing of its own: the arguments, the output and the exit code are the runtime
// CLI's. The CLI's file is the one the runtime's package.json names as its `genclass-runtime` bin, found through
// `@genclass/runtime/package.json` because the runtime's exports map does not export bin/.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const manifest = require.resolve("@genclass/runtime/package.json");
const { bin } = require("@genclass/runtime/package.json");
await import(pathToFileURL(join(dirname(manifest), bin["genclass-runtime"])).href);
