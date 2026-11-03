// Applies medusa-admin.patch's fix to the installed @medusajs/dashboard 2.22.2 build, for the fixed-variant check of
// docs/adoption/hunts/medusa-admin.md. Not part of CI; not for Medusa (the patch against the source is the contribution).
//
//   node docs/adoption/hunts/medusa-admin/patch-dist.mjs <path to node_modules/@medusajs/dashboard> [--revert]
//
// The admin served by `medusa develop` is pre-bundled from the package's dist/ chunks, which are plain ESM (not
// minified). In order-create-exchange-*.mjs and order-create-claim-*.mjs each "Add items" Save handler
// (`const onItemsSelected = async () => { itemsToAdd… setIsOpen("…-items", false); };`) is changed the way the
// source patch changes it: the body becomes `addSelectedItems`, clears the module's selection after it is applied,
// and `onItemsSelected` runs it behind a ref that ignores a press while one is in progress. The originals are kept
// as *.orig; --revert puts them back. Remove the Vite dependency cache and restart `medusa develop` after either.

import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const pkg = process.argv[2];
const revert = process.argv.includes("--revert");
if (!pkg || !existsSync(join(pkg, "dist"))) throw new Error("usage: patch-dist.mjs <node_modules/@medusajs/dashboard> [--revert]");
const files = readdirSync(join(pkg, "dist")).filter((f) => /^order-create-(exchange|claim)-[A-Z0-9]+\.mjs$/.test(f));
if (files.length !== 2) throw new Error(`expected the exchange and claim chunks, found ${files.join(", ")}`);

for (const f of files) {
  const p = join(pkg, "dist", f);
  if (revert) {
    if (existsSync(`${p}.orig`)) copyFileSync(`${p}.orig`, p);
    console.log("reverted", f);
    continue;
  }
  if (!existsSync(`${p}.orig`)) copyFileSync(p, `${p}.orig`);
  let s = readFileSync(`${p}.orig`, "utf8");
  let n = 0;
  s = s.replace(
    /\n  const onItemsSelected = async \(\) => \{\n((?:(?!\n  \};\n)[\s\S])*?)\n    setIsOpen\("((?:in|out)bound-items)", false\);\n  \};\n/g,
    (all, body, modal) => {
      const add = /(itemsToAdd\d*)\.length &&/.exec(body)?.[1];
      const remove = /of (itemsToRemove\d*)\)/.exec(body)?.[1];
      if (!add || !remove) return all;
      n++;
      const cleared = body.replace(/\n    \);\n/, `\n    );\n    ${add} = [];\n`);
      return (
        `\n  const addSelectedItems = async () => {\n${cleared}\n    ${remove} = [];\n    setIsOpen("${modal}", false);\n  };\n` +
        `  const isSavingItems = __gcUseRef(false);\n` +
        `  const onItemsSelected = async () => {\n    if (isSavingItems.current) {\n      return;\n    }\n    isSavingItems.current = true;\n` +
        `    try {\n      await addSelectedItems();\n    } finally {\n      isSavingItems.current = false;\n    }\n  };\n`
      );
    },
  );
  if (n !== 2) throw new Error(`${f}: changed ${n} handlers, expected 2`);
  s = `import { useRef as __gcUseRef } from "react";\n${s}`;
  writeFileSync(p, s);
  console.log("patched", f, `(${n} handlers)`);
}
