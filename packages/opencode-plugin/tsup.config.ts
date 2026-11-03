import { defineConfig } from "tsup";

// One ESM file, dist/index.js, with src/digest.ts and src/ids.ts inlined: OpenCode loads the package's `.` (V1 `main`,
// V2 `server` then `.`) and `./server` (V1) exports, which both point here. Its only runtime export is the default
// plugin object (V1's legacy loader rejects non-function named exports). Node built-ins only; nothing is external.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  minify: false,
  treeshake: true,
});
