#!/usr/bin/env node
// Builds an app this bench runs on: one of compat's apps (compat/apps/<name>), as an app that never installed
// GenClass. The one import in its entry and the dependency are taken out, so what is measured is what the GitHub
// App's one workflow file gives a repository: the runtime comes from the Playwright side alone. Nothing else in the
// app is touched, and compat/ itself is never written to.
//
//   node bench/pr-evidence/setup.mjs                 compat's React + Vite app (six data layers): run.mjs
//   node bench/pr-evidence/setup.mjs vue-vite        Vue 3 + Pinia: flaky.mjs (state the runtime does not see)
//   node bench/pr-evidence/setup.mjs solid-vite      Solid, signals + createResource: flaky.mjs
//   node bench/pr-evidence/setup.mjs plain-html      plain HTML with fetch and the DOM (no build: the script tag is taken out): flaky.mjs
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The entry file of each app this bench can build (a static Vite build that compat serves from dist/). The plain HTML
 * app has no build and no import: its GenClass line is the script tag in index.html.
 */
const ENTRY = { "react-vite": "src/main.tsx", "vue-vite": "src/main.ts", "solid-vite": "src/index.tsx", "plain-html": "index.html" };
const SCRIPT_TAG = /^\s*<!-- GenClass,[^\n]*-->\n\s*<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@genclass\/runtime[^"]*"><\/script>\n/m;

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = process.argv[2] ?? "react-vite";
if (!ENTRY[APP]) throw new Error(`unknown app ${JSON.stringify(APP)}: one of ${Object.keys(ENTRY).join(", ")}`);
const SRC = resolve(HERE, "..", "..", "compat", "apps", APP);
const OUT = join(HERE, ".work", APP);
const IMPORT = /^import "@genclass\/runtime\/auto";[^\n]*\n/;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(dirname(OUT), { recursive: true });
if (APP === "plain-html") {
  // served as it is, from dist/ like the others
  cpSync(SRC, join(OUT, "dist"), { recursive: true });
  const page = join(OUT, "dist", "index.html");
  const html = readFileSync(page, "utf8");
  if (!SCRIPT_TAG.test(html)) throw new Error(`${page} has no GenClass script tag where it was: compat's app changed, look at it before running this bench`);
  writeFileSync(page, html.replace(SCRIPT_TAG, ""));
  if (/genclass/i.test(readFileSync(page, "utf8"))) throw new Error(`${page} still names GenClass after the script tag was taken out`);
  console.log(`copied ${join(OUT, "dist")}`);
  process.exit(0);
}
cpSync(SRC, OUT, { recursive: true, filter: (p) => !/[\\/](node_modules|dist)([\\/]|$)/.test(p) });

const entry = join(OUT, ENTRY[APP]);
const text = readFileSync(entry, "utf8");
if (!IMPORT.test(text)) throw new Error(`${entry} does not start with the GenClass import: compat's app changed, look at it before running this bench`);
writeFileSync(entry, text.replace(IMPORT, ""));

const pkgPath = join(OUT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
delete pkg.dependencies["@genclass/runtime"];
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
rmSync(join(OUT, "package-lock.json"), { force: true });

execSync("npm install --no-audit --no-fund", { cwd: OUT, stdio: "inherit" });
execSync("npm run build", { cwd: OUT, stdio: "inherit" });
console.log(`built ${join(OUT, "dist")}`);
