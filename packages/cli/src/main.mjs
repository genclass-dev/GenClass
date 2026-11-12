// The `genclass` command's entry. Before anything else loads, it tells the runtime CLI's modules
// (packages/runtime/bin/lib/version.mjs) who is running them: the command people type again, what the banners say,
// and the runtime version this build installs. Then it runs the command line (cli.mjs).
//
// Invariants:
// - This file imports only assets.mjs statically. Everything else is imported after the name is set, because those
//   modules read it once, when they load.
// - The exit code is the command's own; an error nobody caught prints one line and exits 1, never a stack trace.

import { BUILD } from "./assets.mjs";

globalThis.__GENCLASS_CLI__ = { name: "genclass", brand: "GenClass", cmd: "npx genclass", version: BUILD.version, runtimeVersion: BUILD.runtimeVersion, mcpVersion: BUILD.mcpVersion };

try {
  // once `genclass` is installed, every screen says `genclass`; until then, `npx genclass` (name.mjs)
  const { shortNameWorks, useShortName } = await import("./name.mjs");
  if (shortNameWorks()) useShortName();
  const { run } = await import("./cli.mjs");
  process.exitCode = await run(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`genclass: ${e?.message ?? e}\n`);
  process.exitCode = 1;
}
