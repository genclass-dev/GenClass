import { defineConfig } from "tsup";

// Seven ESM entries: the pure summariser (`@genclass/playwright` and `@genclass/playwright/summarize`), the
// Playwright reporter (`@genclass/playwright/reporter`, loaded by Playwright by module name, default export), the
// fixture (`@genclass/playwright/fixture`: `test` and `expect`; it imports @playwright/test, a peer dependency, and
// reads @genclass/runtime's dist/ from disk at run time), the register entry (`@genclass/playwright/register`: the
// same on an unmodified suite; it imports nothing but Node built-ins, and finds Playwright at run time from the worker
// it is loaded in) and the two commands (`bin/genclass-playwright-report.mjs` imports dist/cli.js,
// `bin/genclass-playwright-run.mjs` imports dist/run.js, which names dist/register.js by path). No splitting: each
// entry is one file. Only the peer dependencies are external; nothing else is imported besides Node built-ins.
export default defineConfig({
  entry: { index: "src/index.ts", summarize: "src/summarize.ts", reporter: "src/reporter.ts", fixture: "src/fixture.ts", register: "src/register.ts", cli: "src/cli.ts", run: "src/run.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  minify: false,
  treeshake: true,
  external: ["@playwright/test", "@genclass/runtime"],
});
