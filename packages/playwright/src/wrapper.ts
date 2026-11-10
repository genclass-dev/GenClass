// The config genclass-playwright-run generates for one run, and how the user's own config is found. The generated
// file sits next to the user's config (Playwright resolves every path of a config against the config's directory),
// imports the register entry by absolute file URL, then hands Playwright the user's config, unchanged. Playwright loads
// its config in the runner process and again in every worker before any test file, which is how the entry gets into
// the workers of a suite whose files nobody edited.
//
// Invariants:
//   - the user's config is found the way Playwright finds it (resolveConfig) and loaded the way Playwright would have
//     loaded it: imported when Playwright would import it, required when Playwright would require it (isModuleFile is
//     Playwright's rule), and reduced to its default export exactly once, as Playwright does. So `__dirname`,
//     `require` and `import.meta` in that file mean what they meant;
//   - the generated file is an ES module (.mjs) whatever the project is: the register entry is ESM, and a file URL
//     import of it works from an ES module in every supported Node, while a require of it would be rewritten to
//     CommonJS by Playwright's own loader when the package is not under node_modules;
//   - pure text in, text out, apart from the two lookups (existsSync, package.json's "type"): the source is tested as
//     exact text.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The config file extensions Playwright looks for in a directory, in its order. */
export const CONFIG_EXTENSIONS = [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"] as const;

export interface ConfigLocation {
  /** The user's config file, or null when the directory has none (Playwright then runs on its defaults). */
  file: string | null;
  /** The directory Playwright resolves the config's paths against (the config's, else the one looked in). */
  dir: string;
}

/**
 * Finds the config the way Playwright does: `given` (the --config value, a file or a directory, against `cwd`), else
 * `cwd`; in a directory, the first playwright.config with one of CONFIG_EXTENSIONS. Null when the path given does
 * not exist: Playwright reports that itself.
 */
export function resolveConfig(cwd: string, given?: string): ConfigLocation | null {
  const target = given !== undefined ? resolve(cwd, given) : resolve(cwd);
  let directory: boolean;
  try {
    if (!existsSync(target)) return null;
    directory = statSync(target).isDirectory();
  } catch {
    return null;
  }
  if (!directory) return { file: target, dir: dirname(target) };
  for (const ext of CONFIG_EXTENSIONS) {
    const file = join(target, `playwright.config${ext}`);
    if (existsSync(file)) return { file, dir: target };
  }
  return { file: null, dir: target };
}

/**
 * Whether Playwright loads `file` as an ES module (import) rather than CommonJS (require): .mjs and .mts are modules,
 * .cjs and .cts are not, and anything else follows the "type" of the nearest package.json above it.
 */
export function isModuleFile(file: string): boolean {
  if (file.endsWith(".mjs") || file.endsWith(".mts")) return true;
  if (file.endsWith(".cjs") || file.endsWith(".cts")) return false;
  for (let dir = dirname(resolve(file)), i = 0; i < 256; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        return (JSON.parse(readFileSync(pkg, "utf8")) as { type?: unknown }).type === "module";
      } catch {
        return false;
      }
    }
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}

/**
 * The generated config's file name: the user's config's name (so an error Playwright prints about the config still
 * names it), a marker, a number that tells one run from another (the command's process id), and .mjs.
 */
export function wrapperConfigName(config: string | null, id: number | string): string {
  return `${config ? basename(config) : "playwright.config"}.genclass-${id}.mjs`;
}

/** True for a file name wrapperConfigName could have made. */
export function isWrapperConfigName(name: string): boolean {
  return /\.genclass-[A-Za-z0-9]+\.mjs$/.test(name);
}

export interface WrapperConfigInput {
  /** The register entry, as an absolute file URL (file:///.../dist/register.js). */
  registerUrl: string;
  /** The user's config file (only its name is used: the generated file is its neighbour), or null for none. */
  config: string | null;
  /** isModuleFile(config): import it, or require it. */
  module: boolean;
}

/** The generated config's source. */
export function wrapperConfigSource(o: WrapperConfigInput): string {
  const head = [
    "// Written by genclass-playwright-run for one run and removed when the run ends. Safe to delete.",
    "// It loads GenClass's register entry, then hands Playwright your own config, unchanged.",
    `import ${JSON.stringify(o.registerUrl)};`,
  ];
  if (o.config === null) return [...head, "", "export default {};", ""].join("\n");
  const name = basename(o.config);
  if (o.module) {
    return [...head, `import * as config from ${JSON.stringify(`./${encodeURIComponent(name)}`)};`, "", 'export default "default" in config ? config.default : config;', ""].join("\n");
  }
  return [
    ...head,
    'import { createRequire } from "node:module";',
    "",
    `const config = createRequire(import.meta.url)(${JSON.stringify(`./${name}`)});`,
    'export default config && typeof config === "object" && "default" in config ? config.default : config;',
    "",
  ].join("\n");
}
