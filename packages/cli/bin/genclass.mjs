#!/usr/bin/env node
// The `genclass` command. The published package runs its bundle (dist/genclass.mjs, built by build.mjs: one file, no
// dependencies); a checkout without a build runs the sources.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const built = fileURLToPath(new URL("../dist/genclass.mjs", import.meta.url));
await import(existsSync(built) ? "../dist/genclass.mjs" : "../src/main.mjs");
