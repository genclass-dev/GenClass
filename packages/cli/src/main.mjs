// The `genclass` command's entry. Before anything else loads, it tells the runtime CLI's modules
// (packages/runtime/bin/lib/version.mjs) who is running them: the command people type again, what the banners say,
// and the runtime version this build installs. Then it runs the command line (cli.mjs).
//
// Invariants:
// - This file imports only assets.mjs statically. Everything else is imported after the name is set, because those
//   modules read it once, when they load.
// - The exit code is the command's own; an error nobody caught prints one line and exits 1, never a stack trace.

import { BUILD } from "./assets.mjs";

// a reader that stops early (`genclass help | head`) closes the pipe: that ends the command quietly, never with a
// stack trace (EPIPE on stdout or stderr is the reader's choice, not an error of the command)
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e?.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}

globalThis.__GENCLASS_CLI__ = { name: "genclass", brand: "GenClass", cmd: "npx genclass", version: BUILD.version, runtimeVersion: BUILD.runtimeVersion, mcpVersion: BUILD.mcpVersion };

try {
  // once `genclass` is installed, every screen says `genclass`; until then, `npx genclass` (name.mjs)
  const { lineOf, shortNameWorks, useShortName, useTaggedName } = await import("./name.mjs");
  if (shortNameWorks()) useShortName();
  // a prerelease that cannot say `genclass` names itself with its tag (npx genclass@alpha), never npm's latest
  else if (lineOf(BUILD.version)) useTaggedName(lineOf(BUILD.version));
  const { run } = await import("./cli.mjs");
  process.exitCode = await run(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`genclass: ${e?.message ?? e}\n`);
  process.exitCode = 1;
}
