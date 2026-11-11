#!/usr/bin/env node
// Builds the app this bench runs on: compat's React + Vite app (compat/apps/react-vite: six data layers, the eight
// compat scenarios), as an app that never installed GenClass. The one import in its entry and the dependency are taken
// out, so what is measured is what the GitHub App's one workflow file gives a repository: the runtime comes from the
// Playwright side alone. Nothing else in the app is touched, and compat/ itself is never written to.
//
//   node bench/pr-evidence/setup.mjs
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "..", "compat", "apps", "react-vite");
const OUT = join(HERE, ".work", "react-vite");
const IMPORT = /^import "@genclass\/runtime\/auto";[^\n]*\n/;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(dirname(OUT), { recursive: true });
cpSync(SRC, OUT, { recursive: true, filter: (p) => !/[\\/](node_modules|dist)([\\/]|$)/.test(p) });

const entry = join(OUT, "src", "main.tsx");
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
