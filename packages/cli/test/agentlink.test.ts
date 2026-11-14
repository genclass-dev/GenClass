// The dev-only coding-agent link (src/agentlink.mjs) on what the runtime CLI's init writes for each framework
// (packages/runtime/bin/lib/plan.mjs), and `remove` taking it out again (packages/runtime/bin/lib/edit.mjs
// planRemoval): every form round-trips to the files as they were before init, with no problem reported.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectProject } from "../../runtime/bin/lib/detect.mjs";
import { createdByInit, hasMarker, planRemoval } from "../../runtime/bin/lib/edit.mjs";
import { inspectProject } from "../../runtime/bin/lib/init.mjs";
import { planInit } from "../../runtime/bin/lib/plan.mjs";
import { channelOf, PKG_DIR, VERSION } from "../../runtime/bin/lib/version.mjs";
import { connectAgent, SKILL_PATH } from "../src/actions.mjs";
import { AGENT_END, AGENT_IMPORTS_START, AGENT_START, AGENT_START_BOUND, devCommand, devCondition, installedRuntime, linkLines, planAgentLink, runtimeUpgrade, seeItNow, withAgentLink, withAstroAgentLink } from "../src/agentlink.mjs";
import { readState } from "../src/state.mjs";
import { isolate, printed, tempDir, TOKEN, viteApp, write } from "./helpers.js";

isolate();

/** Every file under `dir` (relative path -> text), node_modules included. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

/** What `remove` does to every file with GenClass's marker (init.mjs remove): planRemoval, a created file deleted. */
function removed(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, text] of Object.entries(snapshot(dir))) {
    if (!hasMarker(text)) {
      out[rel] = text;
      continue;
    }
    const r = planRemoval(text);
    expect(r.problems, `${rel}\n${text}`).toEqual([]);
    if (!createdByInit(text, r.text)) out[rel] = r.text;
  }
  return out;
}

type Opts = { devtools?: boolean; config?: Record<string, unknown>; strategy?: string; runtime?: string | null };

/** This repository's runtime as installed in node_modules: its package.json (name, version, exports with ./agent). */
const OWN = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
const RUNTIME = JSON.stringify({ name: OWN.name, version: OWN.version, type: "module", exports: OWN.exports }, null, 2);
/** 0.2.3's package.json as npm's `latest` installs it: no ./agent in its exports. */
const RUNTIME_023 = JSON.stringify({ name: "@genclass/runtime", version: "0.2.3", type: "module", exports: { ".": { import: "./dist/index.js" }, "./auto": { import: "./dist/auto.js" }, "./devtools": { import: "./dist/devtools.js" }, "./package.json": "./package.json" } });
const INSTALLED = "node_modules/@genclass/runtime/package.json";

/** A project with `files` (and this repository's runtime installed, unless `runtime` says otherwise), set up by init's own plan (written as init writes it), then its link planned. */
function initThenLink(files: Record<string, string>, o: Opts = {}) {
  const dir = tempDir("genclass-link-");
  write(dir, o.runtime === null ? files : { [INSTALLED]: o.runtime ?? RUNTIME, ...files });
  const before = snapshot(dir);
  const plan = planInit(detectProject(dir), { mode: undefined, devtools: o.devtools ?? false, config: o.config, strategy: o.strategy }, { pkgDir: PKG_DIR, version: VERSION });
  expect(plan.manual, JSON.stringify(plan)).toBeUndefined();
  for (const ch of plan.changes) {
    mkdirSync(dirname(ch.file), { recursive: true });
    writeFileSync(ch.file, ch.after);
  }
  const link = planAgentLink(inspectProject({ cwd: dir }));
  return { dir, before, link };
}

/** Writes the planned link, checks it is there once, and that `remove` gives back the files from before init. */
function roundTrip(files: Record<string, string>, o: Opts = {}) {
  const { dir, before, link } = initThenLink(files, o);
  expect(link.state, JSON.stringify(link)).toBe("planned");
  for (const ch of link.changes) writeFileSync(ch.file, ch.after);
  const linked = snapshot(dir);
  // planned again: it is there now
  expect(planAgentLink(inspectProject({ cwd: dir })).state).toBe("linked");
  expect(removed(dir)).toEqual(before);
  return { dir, linked, changes: link.changes as { rel: string; after: string }[] };
}

const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "app", private: true, dependencies: deps, ...extra }, null, 2) + "\n";
const html = (src: string) => `<!doctype html>\n<html lang="en">\n  <head>\n    <title>App</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="${src}"></script>\n  </body>\n</html>\n`;
const STATIC_LINK = (cond: string, q = '"', semi = ";") => [AGENT_START, `import { GenClass } from ${q}@genclass/runtime${q}${semi}`, `import { connectAgent } from ${q}@genclass/runtime/agent${q}${semi}`, `if (${cond}) connectAgent(GenClass.init())${semi}`, AGENT_END];
/** The link when the app's own imports follow init's import: its imports there, its call right after the file's last import. */
const LINK_IMPORTS = (q = '"', semi = ";") => [AGENT_IMPORTS_START, `import { GenClass } from ${q}@genclass/runtime${q}${semi}`, `import { connectAgent } from ${q}@genclass/runtime/agent${q}${semi}`, AGENT_END];
const LINK_CALL = (cond: string, semi = ";") => [AGENT_START, `if (${cond}) connectAgent(GenClass.init())${semi}`, AGENT_END];
/**
 * The call's block (`block`, LINK_CALL's or the dynamic form's lines) right after the file's last import and before
 * its first other statement, so it runs before the app's own code: everything above it is imports, comments and
 * blank lines, and no import comes after it.
 */
const callRightAfterImports = (text: string, block: string[]) => {
  const lines = text.split(/\r?\n/);
  const at = lines.indexOf(block[0]!);
  expect(at, text).toBeGreaterThan(0);
  expect(lines.slice(at, at + block.length), text).toEqual(block);
  expect(lines.slice(0, at).filter((l) => l.trim() && !/^\s*\/\//.test(l)).every((l) => /^\s*import\s[^(]/.test(l) || /^\s*["']use \w+["'];?$/.test(l)), text).toBe(true);
  expect(lines[at - 1], text).toMatch(/^import\s/);
  expect(lines.slice(at + block.length).some((l) => /^\s*import\s[^(]/.test(l)), text).toBe(false);
};
/** Whether every import declaration in `text` comes before its first other statement (ESLint's import/first). */
const importsFirst = (text: string) => {
  const code = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*\/\//.test(l));
  const firstOther = code.findIndex((l) => !/^\s*import\s/.test(l) && !/^\s*["']use \w+["'];?$/.test(l));
  return firstOther < 0 || !code.slice(firstOther).some((l) => /^\s*import\s[^(]/.test(l));
};

describe("the coding-agent link on every setup init writes, and `remove` taking it out (src/agentlink.mjs; runtime edit.mjs planRemoval)", () => {
  it("Vite (React, Vue, Svelte, Solid, Preact): its imports right after init's import, its call right after the last import, import.meta.env.DEV, in the file's own style", () => {
    const flavours: [Record<string, string>, string, string][] = [
      [{ react: "^19", "react-dom": "^19", vite: "^8" }, "src/main.tsx", `import { createRoot } from 'react-dom/client'\nimport App from './App'\n\ncreateRoot(document.getElementById('root')!).render(<App />)\n`],
      [{ vue: "^3", vite: "^8" }, "src/main.js", `import { createApp } from "vue";\nimport App from "./App.vue";\n\ncreateApp(App).mount("#app");\n`],
      [{ svelte: "^5", vite: "^8" }, "src/main.ts", `import { mount } from "svelte";\nimport App from "./App.svelte";\n\nexport default mount(App, { target: document.getElementById("app")! });\n`],
      [{ "solid-js": "^1", vite: "^8" }, "src/index.tsx", `import { render } from "solid-js/web";\nimport App from "./App";\n\nrender(() => <App />, document.getElementById("root")!);\n`],
      [{ preact: "^10", vite: "^8" }, "src/main.jsx", `import { render } from "preact";\nimport { App } from "./app";\n\nrender(<App />, document.getElementById("app"));\n`],
    ];
    for (const [deps, entry, text] of flavours) {
      for (const devtools of [false, true]) {
        const { changes } = roundTrip({ "package.json": pkg(deps), "index.html": html(`/${entry}`), [entry]: text }, { devtools });
        expect(changes.map((ch) => ch.rel)).toEqual([entry]);
        const lines = changes[0]!.after.split("\n");
        const at = lines.findIndex((l) => l.includes("@genclass/runtime/auto"));
        const single = text.startsWith("import { createRoot } from 'react-dom/client'");
        const [q, semi] = single ? ["'", ""] : ['"', ";"];
        expect(lines.slice(at + 1, at + 5), `${entry} devtools=${devtools}`).toEqual(LINK_IMPORTS(q, semi));
        // the call before the app's own code (it runs first, as the link's block did before), init's devtools line last
        callRightAfterImports(changes[0]!.after, LINK_CALL("import.meta.env.DEV", semi));
        if (devtools) expect(changes[0]!.after.trimEnd().split("\n").at(-1)).toContain("@genclass/runtime/devtools");
        expect(importsFirst(changes[0]!.after), changes[0]!.after).toBe(true);
      }
    }
  });

  it("Vite with the options file (--no-telemetry): after the /auto import, not the options import; CRLF and no final newline kept", () => {
    // the app's code right after GenClass's import: the whole link there, in one block (imports, then the call)
    const { changes } = roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.ts"), "src/main.ts": `console.log("app");\n` }, { config: { telemetry: false } });
    expect(changes[0]!.after.split("\n").slice(0, 8)).toEqual(['import "./genclass.config"; // genclass:init', 'import "@genclass/runtime/auto"; // genclass:init', ...STATIC_LINK("import.meta.env.DEV"), 'console.log("app");']);
    const crlf = roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.js"), "src/main.js": `import "./style.css";\r\nconsole.log(1);\r\n` });
    expect(crlf.changes[0]!.after).toContain(`${AGENT_IMPORTS_START}\r\n`);
    expect(crlf.changes[0]!.after.endsWith(`import "./style.css";\r\n${LINK_CALL("import.meta.env.DEV").join("\r\n")}\r\nconsole.log(1);\r\n`)).toBe(true);
    expect(crlf.changes[0]!.after).not.toMatch(/[^\r]\n/);
    // no final newline: still none after the call, or after the app's code
    const bare = roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.js"), "src/main.js": `import "./style.css";` });
    expect(bare.changes[0]!.after.endsWith(`import "./style.css";\n${LINK_CALL("import.meta.env.DEV").join("\n")}`)).toBe(true);
    const code = roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.js"), "src/main.js": `console.log(1);` });
    expect(code.changes[0]!.after.endsWith(`${AGENT_END}\nconsole.log(1);`)).toBe(true);
    // the entry holds nothing but init's line: the link in one block right after it
    const only = roundTrip({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.js"), "src/main.js": "" });
    expect(only.changes[0]!.after).toBe(['import "@genclass/runtime/auto"; // genclass:init', ...STATIC_LINK("import.meta.env.DEV"), ""].join("\n"));
  });

  it("Create React App: import/first holds (react-app's ESLint config fails `npm start` and `npm run build` otherwise)", () => {
    const index = `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport './index.css';\nimport App from './App';\nimport reportWebVitals from './reportWebVitals';\n\nconst root = ReactDOM.createRoot(document.getElementById('root'));\nroot.render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);\n\nreportWebVitals();\n`;
    const files = { "package.json": pkg({ "react-scripts": "5.0.1", react: "^18", "react-dom": "^18" }, { eslintConfig: { extends: ["react-app", "react-app/jest"] } }), "src/index.js": index };
    for (const devtools of [false, true]) {
      const { changes } = roundTrip(files, { devtools });
      const after = changes[0]!.after;
      expect(importsFirst(after), after).toBe(true);
      const lines = after.split("\n");
      expect(lines.slice(1, 5)).toEqual(LINK_IMPORTS("'", ";"));
      expect(lines[5]).toBe("import React from 'react';");
      // the call after the app's last import, before `const root = ...`
      callRightAfterImports(after, LINK_CALL('process.env.NODE_ENV === "development"'));
      expect(lines[lines.indexOf(AGENT_START) - 1]).toBe("import reportWebVitals from './reportWebVitals';");
    }
  });

  it("SvelteKit: after the block of the hooks.client file init created, or after its line in an existing one", () => {
    const made = roundTrip({ "package.json": pkg({ "@sveltejs/kit": "^2" }), "tsconfig.json": "{}\n", "src/routes/+page.svelte": "<h1>hi</h1>\n" });
    expect(made.changes.map((ch) => ch.rel)).toEqual(["src/hooks.client.ts"]);
    const lines = made.changes[0]!.after.trimEnd().split("\n");
    expect(lines.slice(-5)).toEqual(STATIC_LINK("import.meta.env.DEV"));
    expect(lines[lines.length - 6]).toBe("// genclass:init end");
    // the created file is GenClass's alone: remove deletes it whole (roundTrip checked)
    roundTrip({ "package.json": pkg({ "@sveltejs/kit": "^2" }), "src/hooks.client.js": `export const handleError = ({ error }) => console.error(error);` }, { devtools: true });
  });

  it("Astro: a second marked <script> line after init's, in each layout; a one-line <head> gets the lines to add instead", () => {
    const { changes } = roundTrip({
      "package.json": pkg({ astro: "^5" }),
      "src/layouts/Layout.astro": `---\nconst { title } = Astro.props;\n---\n<html>\n\t<head>\n\t\t<title>{title}</title>\n\t</head>\n\t<body><slot /></body>\n</html>\n`,
      "src/layouts/Plain.astro": `<html>\n  <head>\n    <title>x</title>\n  </head>\n  <body><slot /></body>\n</html>\n`,
      "src/pages/index.astro": `---\nimport Layout from "../layouts/Layout.astro";\n---\n<Layout title="x"><h1>hi</h1></Layout>\n`,
    }, { devtools: true });
    expect(changes.map((ch) => ch.rel).sort()).toEqual(["src/layouts/Layout.astro", "src/layouts/Plain.astro"]);
    expect(changes.find((ch) => ch.rel === "src/layouts/Layout.astro")!.after).toContain(`\t\t<script>import { GenClass } from "@genclass/runtime"; import { connectAgent } from "@genclass/runtime/agent"; if (import.meta.env.DEV) connectAgent(GenClass.init()); // genclass:init</script>\n\t</head>`);
    const one = initThenLink({ "package.json": pkg({ astro: "^5" }), "src/pages/index.astro": `<html><head><title>x</title></head><body>hi</body></html>\n` });
    expect(one.link).toMatchObject({ state: "manual", changes: null });
    expect(one.link.lines!.join("\n")).toContain("connectAgent(GenClass.init())");
    expect(withAstroAgentLink(`<script>import "@genclass/runtime/auto"; // genclass:inline</script>`)).toBeNull();
  });

  it("React Router and Remix: entry.client with the Vite check; root (it renders on the server too) also checks for a window", () => {
    const rr = roundTrip({ "package.json": pkg({ "@react-router/dev": "^7" }), "app/entry.client.tsx": `import { HydratedRouter } from "react-router/dom";\n`, "app/root.tsx": "x\n" });
    expect(rr.changes.map((ch) => ch.rel)).toEqual(["app/entry.client.tsx"]);
    expect(rr.changes[0]!.after).toContain("if (import.meta.env.DEV) connectAgent(GenClass.init());");
    const remix = roundTrip({ "package.json": pkg({ "@remix-run/react": "^2", vite: "^5" }), "app/root.tsx": `export default function App() { return null; }\n` }, { devtools: true });
    expect(remix.changes[0]!.after).toContain('if (import.meta.env.DEV && typeof window !== "undefined") connectAgent(GenClass.init());');
    const old = roundTrip({ "package.json": pkg({ "@remix-run/react": "^2" }), "app/entry.client.jsx": `import { RemixBrowser } from "@remix-run/react";\n` });
    expect(old.changes[0]!.after).toContain('if (process.env.NODE_ENV === "development") connectAgent(GenClass.init());');
  });

  it("Next.js: instrumentation-client (made or edited), the App Router's genclass-init component, pages/_app (edited or made); the dynamic form where init bound `genclass`", () => {
    const layout = `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
    const next16 = { "package.json": pkg({ next: "16.0.0", react: "^19" }), "tsconfig.json": "{}\n", "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.0.1" }), "src/app/layout.tsx": layout };
    // made by init, no binding (the genclass command's init: --no-devtools): the two imports and the call
    const made = roundTrip(next16);
    expect(made.changes.map((ch) => ch.rel)).toEqual(["src/instrumentation-client.ts"]);
    expect(made.changes[0]!.after.trimEnd().split("\n").slice(-5)).toEqual(STATIC_LINK('process.env.NODE_ENV === "development"'));
    // with init's `genclass` binding (the devtools line): the dynamic import, as that line is
    const bound = roundTrip(next16, { devtools: true });
    expect(bound.changes[0]!.after).toContain('if (process.env.NODE_ENV === "development") import("@genclass/runtime/agent").then(({ connectAgent }) => connectAgent(genclass));');
    expect(bound.changes[0]!.after).not.toContain('from "@genclass/runtime";');
    // an instrumentation-client of the app's own: the dynamic form is one statement, right after the file's last
    // import (the import section stays imports only) and before the app's code; init's devtools line stays last
    const own = roundTrip({ ...next16, "src/instrumentation-client.ts": `import "./mine";\nconsole.log("mine");\n` }, { devtools: true });
    const ownLines = own.changes[0]!.after.trimEnd().split("\n");
    expect(ownLines.slice(0, 6)).toEqual(['import genclass from "@genclass/runtime/auto"; // genclass:init', 'import "./mine";', AGENT_START_BOUND, 'if (process.env.NODE_ENV === "development") import("@genclass/runtime/agent").then(({ connectAgent }) => connectAgent(genclass));', AGENT_END, 'console.log("mine");']);
    expect(ownLines.at(-1)).toContain("@genclass/runtime/devtools");
    // without the binding: the imports after init's line, the call after the app's import
    const ownStatic = roundTrip({ ...next16, "src/instrumentation-client.ts": `import "./mine";\nconsole.log("mine");\n` });
    expect(ownStatic.changes[0]!.after.split("\n").slice(1, 5)).toEqual(LINK_IMPORTS());
    callRightAfterImports(ownStatic.changes[0]!.after, LINK_CALL('process.env.NODE_ENV === "development"'));
    expect(importsFirst(ownStatic.changes[0]!.after)).toBe(true);
    // Next.js 15.1, App Router: the client component init creates, rendered on the server too
    for (const devtools of [false, true]) {
      const app = roundTrip({ "package.json": pkg({ next: "15.1.0" }), "tsconfig.json": "{}\n", "app/layout.tsx": layout }, { devtools });
      expect(app.changes.map((ch) => ch.rel)).toEqual(["app/genclass-init.tsx"]);
      expect(app.changes[0]!.after.startsWith('// genclass:init start')).toBe(true);
      expect(app.changes[0]!.after).toContain(devtools ? 'if (process.env.NODE_ENV === "development" && typeof window !== "undefined") import("@genclass/runtime/agent")' : 'if (process.env.NODE_ENV === "development" && typeof window !== "undefined") connectAgent(GenClass.init());');
    }
    // Next.js 14, pages: an _app of the app's own, and the one init creates
    const withApp = roundTrip({ "package.json": pkg({ next: "14.2.0" }), "pages/_app.js": `import "../styles/globals.css";\n\nexport default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n`, "pages/index.js": "export default function Home() { return null; }\n" });
    expect(withApp.changes[0]!.after).toContain('typeof window !== "undefined") connectAgent(GenClass.init());');
    roundTrip({ "package.json": pkg({ next: "14.2.0" }), "tsconfig.json": "{}\n", "pages/index.tsx": "export default function Home() { return null; }\n" }, { devtools: true });
  });

  it("Create React App and webpack, rspack, rsbuild, parcel: process.env.NODE_ENV; another bundler gets the lines instead", () => {
    const cra = roundTrip({ "package.json": pkg({ "react-scripts": "5.0.1", react: "^18" }), "src/index.js": `import React from 'react';\n` });
    expect(cra.changes[0]!.after).toContain(`if (process.env.NODE_ENV === "development") connectAgent(GenClass.init())`);
    const wp = roundTrip({ "package.json": pkg({ webpack: "^5", "html-webpack-plugin": "^5" }), "src/index.ts": `"use strict";\nconsole.log(1);\n` });
    expect(wp.changes[0]!.after.split("\n")).toEqual(['"use strict";', 'import "@genclass/runtime/auto"; // genclass:init', ...STATIC_LINK('process.env.NODE_ENV === "development"'), "console.log(1);", ""]);
    const es = initThenLink({ "package.json": pkg({ esbuild: "^0.25", "react-dom": "^19" }), "src/index.js": `console.log(1);\n` });
    expect(es.link).toMatchObject({ state: "manual", changes: null });
    expect(es.link.why).toContain("process.env.NODE_ENV");
  });

  it("Angular, Nuxt and a plain HTML script tag are not planned: the lines to add and where, nothing written", () => {
    const ng = initThenLink({ "package.json": pkg({ "@angular/core": "^20" }), "src/main.ts": `import { bootstrapApplication } from '@angular/platform-browser';\n` });
    expect(ng.link).toMatchObject({ state: "manual", changes: null });
    expect(ng.link.lines).toContain("if (isDevMode()) connectAgent(GenClass.init());");
    const nuxt = initThenLink({ "package.json": pkg({ nuxt: "^4.0.0" }), "tsconfig.json": "{}\n", "app/app.vue": "<template><div/></template>\n" });
    expect(nuxt.link).toMatchObject({ state: "manual", changes: null });
    expect(nuxt.link.lines).toContain("if (import.meta.dev) connectAgent(GenClass.init());");
    const page = initThenLink({ "index.html": `<html>\n<head>\n<title>x</title>\n</head>\n<body></body>\n</html>\n` });
    expect(page.link).toMatchObject({ state: "manual", changes: null, lines: [] });
    expect(page.link.why).toContain("ESM");
  });

  it("Nuxt: the lines to add are a marked block at the end of GenClass's plugin, and `remove` takes it out with the plugin", () => {
    for (const devtools of [false, true]) {
      const { dir, before, link } = initThenLink({ "package.json": pkg({ nuxt: "^4.0.0" }), "tsconfig.json": "{}\n", "app/app.vue": "<template><div/></template>\n" }, { devtools });
      expect(link).toMatchObject({ state: "manual", changes: null });
      expect(link.where).toContain("app/plugins/genclass.client.ts");
      expect(link.lines![0]).toBe(AGENT_START);
      expect(link.lines!.at(-1)).toBe(AGENT_END);
      // added as told: after the plugin's own end marker
      const plugin = join(dir, "app/plugins/genclass.client.ts");
      const text = readFileSync(plugin, "utf8");
      expect(text.trimEnd().endsWith(AGENT_END)).toBe(true);
      writeFileSync(plugin, `${text}${link.lines!.join("\n")}\n`);
      expect(planAgentLink(inspectProject({ cwd: dir })).state).toBe("linked");
      expect(removed(dir), `devtools=${devtools}`).toEqual(before);
      // what the earlier wording led to (the imports after GenClass's, the call inside defineNuxtPlugin) comes out too
      const inside = text
        .replace(/(import (?:genclass from )?"@genclass\/runtime\/auto";\n)/, `$1${link.lines!.slice(1, 3).join("\n")}\n`)
        .replace(/defineNuxtPlugin\(\(\) => \{(\}\);|\n)/, (_m, rest) => `defineNuxtPlugin(() => {\n  if (import.meta.dev) connectAgent(GenClass.init());${rest === "\n" ? "\n" : "\n});"}`);
      expect(inside).toContain("  if (import.meta.dev) connectAgent(GenClass.init());");
      const r = planRemoval(inside);
      expect(r, inside).toEqual({ text: "", problems: [] });
      expect(createdByInit(inside, r.text)).toBe(true);
    }
  });

  it("the installed runtime has no agent entry (0.2.x, npm's latest) or none is installed: nothing written, the upgrade to run first", () => {
    const spec = channelOf(VERSION) ? `@genclass/runtime@${channelOf(VERSION)}` : "@genclass/runtime";
    const files = { "package.json": pkg({ vite: "^8", "@genclass/runtime": "^0.2.3" }), "index.html": html("/src/main.js"), "src/main.js": `import { createApp } from "vue";\ncreateApp({}).mount("#app");\n` };
    const old = initThenLink(files, { runtime: RUNTIME_023 });
    expect(old.link).toMatchObject({ state: "manual", changes: null, upgrade: `npm install ${spec}` });
    expect(old.link.why).toContain("the installed @genclass/runtime 0.2.3 has no agent entry");
    expect(old.link.why).toContain(`first run npm install ${spec}`);
    const none = initThenLink(files, { runtime: null });
    expect(none.link).toMatchObject({ state: "manual", changes: null, upgrade: `npm install ${spec}` });
    expect(none.link.why).toContain("not installed");
    // a project by hand gets the same first step next to its lines
    const own = tempDir();
    write(own, { ...files, [INSTALLED]: RUNTIME_023, "src/main.js": `import { GenClass } from "@genclass/runtime";\nGenClass.init();\n` });
    expect(planAgentLink(inspectProject({ cwd: own })).why).toContain(`first run npm install ${spec}`);
    // upgraded: planned
    write(old.dir, { [INSTALLED]: RUNTIME });
    expect(planAgentLink(inspectProject({ cwd: old.dir })).state).toBe("planned");
    // as Node finds it: the project's node_modules, else a parent's (hoisted); exports decide, else the version
    const at = (map: Record<string, string>) => (p: string) => map[p.split("\\").join("/")] ?? null;
    const root = join(tempDir(), "repo");
    const hoisted = `${root.split("\\").join("/")}/node_modules/@genclass/runtime/package.json`;
    expect(installedRuntime(join(root, "apps/web"), at({ [hoisted]: RUNTIME }))).toEqual({ version: OWN.version, agent: true });
    expect(installedRuntime(join(root, "apps/web"), at({ [hoisted]: RUNTIME_023 }))).toEqual({ version: "0.2.3", agent: false });
    expect(installedRuntime(join(root, "apps/web"), at({}))).toBeNull();
    expect(installedRuntime(root, at({ [hoisted]: JSON.stringify({ version: "0.3.0-beta.6" }) }))).toEqual({ version: "0.3.0-beta.6", agent: true });
    expect(installedRuntime(root, at({ [hoisted]: JSON.stringify({ version: "0.2.3" }) }))).toEqual({ version: "0.2.3", agent: false });
    expect(installedRuntime(root, at({ [hoisted]: JSON.stringify({ version: "0.3.0-beta.6", exports: "./dist/index.js" }) }))).toEqual({ version: "0.3.0-beta.6", agent: false });
    expect(runtimeUpgrade("pnpm")).toBe(`pnpm add ${spec}`);
    expect(runtimeUpgrade("yarn")).toBe(`yarn add ${spec}`);
    expect(runtimeUpgrade("bun")).toBe(`bun add ${spec}`);
  });

  it("Plug'n'Play (Yarn's default, pnpm's node-linker=pnp; no node_modules): the lockfile next to .pnp.cjs gives the version, so the link is planned again", () => {
    const spec = channelOf(VERSION) ? `@genclass/runtime@${channelOf(VERSION)}` : "@genclass/runtime";
    // yarn.lock as Yarn 4 writes it: the runtime's entry, and the app's own workspace entry
    const berry = (range: string, version: string) =>
      `# This file is generated by running "yarn install" inside your project.\n\n__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"@genclass/runtime@npm:${range}":\n  version: ${version}\n  resolution: "@genclass/runtime@npm:${version}"\n  checksum: 10c0/0123\n  languageName: node\n  linkType: hard\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "app@workspace:."\n  dependencies:\n    "@genclass/runtime": "npm:${range}"\n  languageName: unknown\n  linkType: soft\n`;
    const app = (range: string, lock: string) => ({
      "package.json": pkg({ vue: "^3", vite: "^8", "@genclass/runtime": range }, { packageManager: "yarn@4.5.0" }),
      ".pnp.cjs": "#!/usr/bin/env node\n/* eslint-disable */\n// @ts-nocheck\n\"use strict\";\n",
      ".yarnrc.yml": "nodeLinker: pnp\n",
      "yarn.lock": lock,
      "index.html": html("/src/main.js"),
      "src/main.js": `import { createApp } from "vue";\ncreateApp({}).mount("#app");\n`,
    });
    // 0.3.0-beta.x resolved through .pnp.cjs: planned, written, linked, and removed again, as with node_modules
    const ok = roundTrip(app("^0.3.0-beta.6", berry("^0.3.0-beta.6", "0.3.0-beta.6")), { runtime: null });
    expect(ok.changes.map((ch) => ch.rel)).toEqual(["src/main.js"]);
    // 0.2.x there: the upgrade with Yarn, which does change what .pnp.cjs resolves
    const old = initThenLink(app("^0.2.3", berry("^0.2.3", "0.2.3")), { runtime: null });
    expect(old.link).toMatchObject({ state: "manual", changes: null, upgrade: `yarn add ${spec}` });
    expect(old.link.why).toContain("the installed @genclass/runtime 0.2.3 has no agent entry");
    // not in the lockfile at all: not installed, and `yarn add` installs it
    const none = initThenLink(app("^0.3.0-beta.6", `__metadata:\n  version: 8\n`), { runtime: null });
    expect(none.link).toMatchObject({ state: "manual", changes: null, upgrade: `yarn add ${spec}` });
    expect(none.link.why).toContain("@genclass/runtime is not installed: first run");
    // directly: the PnP root's lockfile wins over an older copy in a node_modules further up; pnpm's pnp linker;
    // several versions and none this app's range names: planned (cannot be told), as before node_modules was read
    const root = join(tempDir(), "home", "repo").split("\\").join("/");
    const files = (map: Record<string, string>) => ({ read: (p: string) => map[p.split("\\").join("/")] ?? null, exists: (p: string) => p.split("\\").join("/") in map });
    const up = files({ [`${root}/.pnp.cjs`]: "", [`${root}/yarn.lock`]: berry("^0.3.0-beta.6", "0.3.0-beta.6"), [`${dirname(root)}/node_modules/@genclass/runtime/package.json`]: RUNTIME_023 });
    expect(installedRuntime(root, up.read, up.exists)).toEqual({ version: "0.3.0-beta.6", agent: true });
    const pnpm = files({ [`${root}/.pnp.cjs`]: "", [`${root}/pnpm-lock.yaml`]: `lockfileVersion: '9.0'\n\nimporters:\n\n  apps/web:\n    dependencies:\n      '@genclass/runtime':\n        specifier: ^0.3.0-beta.6\n        version: 0.3.0-beta.6\n` });
    expect(installedRuntime(`${root}/apps/web`, pnpm.read, pnpm.exists)).toEqual({ version: "0.3.0-beta.6", agent: true });
    const two = files({ [`${root}/.pnp.cjs`]: "", [`${root}/yarn.lock`]: `__metadata:\n  version: 8\n\n"@genclass/runtime@npm:^0.2.3":\n  version: 0.2.3\n\n"@genclass/runtime@npm:^0.3.0-beta.6":\n  version: 0.3.0-beta.6\n` });
    expect(installedRuntime(root, two.read, two.exists)).toEqual({ version: null, agent: null });
    expect(planAgentLink({ project: { framework: "vite", dir: root, pm: "yarn" }, cwd: root, marked: [`${root}/src/main.js`] }, { read: (p: string) => (p.endsWith("main.js") ? 'import "@genclass/runtime/auto"; // genclass:init\n' : two.read(p)), exists: two.exists }).state).toBe("planned");
  });

  it("the call runs before the app's own code (Node ESM, a stub runtime): an entry that throws while it loads, or awaits at the top, is linked first", () => {
    const stub = {
      "node_modules/@genclass/runtime/index.js": "export const GenClass = { init: () => \"the runtime\" };\n",
      "node_modules/@genclass/runtime/auto.js": "export default \"the runtime\";\n",
      "node_modules/@genclass/runtime/agent.js": "export function connectAgent(rt) { console.log(`connectAgent ran: ${rt}`); }\n",
      "src/app.js": "export const start = (el) => el.append(\"hi\");\n",
    };
    const runtime = JSON.stringify({ name: "@genclass/runtime", version: OWN.version, type: "module", exports: { ".": "./index.js", "./auto": "./auto.js", "./agent": "./agent.js" } });
    const base = { "package.json": pkg({ webpack: "^5", "html-webpack-plugin": "^5" }, { type: "module" }), ...stub };
    const run = (dir: string) => spawnSync(process.execPath, [join(dir, "src/index.js")], { cwd: dir, encoding: "utf8", timeout: 20000, env: { ...process.env, NODE_ENV: "development" } });
    // the page's root element is not there (no document in Node): the entry throws on its first line of code
    const throws = roundTrip({ ...base, "src/index.js": `import { start } from "./app.js";\n\nstart(document.getElementById("root"));\n` }, { runtime });
    const t = run(throws.dir);
    expect(t.stderr).toContain("ReferenceError");
    expect(t.stdout).toContain("connectAgent ran: the runtime");
    // no semicolons, an IIFE right after the imports and a top-level await: linked before both, and the call is not
    // joined to the IIFE's parentheses
    const waits = roundTrip({ ...base, "src/index.js": `import { start } from "./app.js"\n(async () => { console.log("iife") })()\nawait new Promise((r) => setTimeout(r, 10))\nconsole.log("after the await")\nvoid start\n` }, { runtime });
    const w = run(waits.dir);
    expect(w.status, w.stderr).toBe(0);
    expect(w.stdout.split("\n").filter(Boolean)).toEqual(["connectAgent ran: the runtime", "iife", "after the await"]);
    expect(waits.changes[0]!.after).toContain(`if (process.env.NODE_ENV === "development") connectAgent(GenClass.init());\n${AGENT_END}\n(async () =>`);
  });

  it("where the end of the imports cannot be read safely (code on an import's line), the call goes at the end of the file", () => {
    const text = 'import "@genclass/runtime/auto"; // genclass:init\nimport a from "a"; a(\n  1);\n';
    const after = withAgentLink(text)!;
    expect(after.split("\n").slice(1, 5)).toEqual(LINK_IMPORTS());
    expect(after.endsWith(`  1);\n${LINK_CALL("import.meta.env.DEV").join("\n")}\n`)).toBe(true);
    expect(planRemoval(after)).toEqual({ text: planRemoval(text).text, problems: [] });
    // a declaration over several lines, import attributes and comments: the call after the whole of the last one
    const multi = 'import "@genclass/runtime/auto"; // genclass:init\nimport {\n  a,\n  b,\n} from "./x";\nimport data from "./d.json" with {\n  type: "json",\n};\n/* the app */\n// eslint-disable-next-line no-console\nconsole.log(a, b, data);\n';
    const linked = withAgentLink(multi)!;
    expect(linked).toContain(`  type: "json",\n};\n${LINK_CALL("import.meta.env.DEV").join("\n")}\n/* the app */\n`);
    expect(planRemoval(linked)).toEqual({ text: planRemoval(multi).text, problems: [] });
  });

  it("an entry file the person had, empty: `remove` gives it back empty instead of deleting it (createdByInit)", () => {
    for (const [files, entry] of [
      [{ "package.json": pkg({ "@sveltejs/kit": "^2" }), "src/hooks.client.ts": "\n", "tsconfig.json": "{}\n" }, "src/hooks.client.ts"],
      [{ "package.json": pkg({ next: "16.0.0", react: "^19" }), "tsconfig.json": "{}\n", "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.0.1" }), "src/app/layout.tsx": "export default function L({ children }) { return <html><body>{children}</body></html>; }\n", "src/instrumentation-client.ts": "" }, "src/instrumentation-client.ts"],
    ] as [Record<string, string>, string][]) {
      const { changes } = roundTrip(files);
      expect(changes.map((ch) => ch.rel)).toEqual([entry]);
      const r = planRemoval(changes[0]!.after);
      expect(r.text).toBe(files[entry]);
      expect(createdByInit(changes[0]!.after, r.text)).toBe(false);
    }
  });

  it("a setup by hand, a test that names connectAgent, a folder without GenClass: nothing planned there", () => {
    const dir = tempDir();
    viteApp(dir);
    expect(planAgentLink(inspectProject({ cwd: dir }))).toMatchObject({ state: "none", changes: null });
    write(dir, { "src/main.jsx": `import { GenClass } from "@genclass/runtime";\nGenClass.init();\n` });
    expect(planAgentLink(inspectProject({ cwd: dir }))).toMatchObject({ state: "manual", changes: null });
    // a generated regression test that names connectAgent is not the link
    const { dir: d2 } = initThenLink({ "package.json": pkg({ vite: "^8" }), "index.html": html("/src/main.js"), "src/main.js": "x();\n" });
    write(d2, { "tests/race.spec.ts": `import { test } from "@playwright/test";\n// the dev build calls connectAgent(rt) from @genclass/runtime/agent\n` });
    expect(planAgentLink(inspectProject({ cwd: d2 })).state).toBe("planned");
    // a link the person wrote anywhere in the app counts
    write(d2, { "src/agent.js": `import { connectAgent } from "@genclass/runtime/agent";\nconnectAgent(null);\n` });
    expect(planAgentLink(inspectProject({ cwd: d2 }))).toMatchObject({ state: "linked", files: ["src/agent.js"] });
  });

  it("withAgentLink and devCondition, directly: nothing twice, nothing without init's import, the check per framework and file", () => {
    const entry = 'import "@genclass/runtime/auto"; // genclass:init\nx();\n';
    const once = withAgentLink(entry)!;
    expect(withAgentLink(once)).toBeNull();
    expect(withAgentLink("import { createRoot } from 'react-dom/client';\n")).toBeNull();
    expect(withAgentLink('import "@genclass/runtime/auto";\n')).toBeNull();
    expect(devCondition({ framework: "next" }, "/a/src/instrumentation-client.ts")).toBe('process.env.NODE_ENV === "development"');
    expect(devCondition({ framework: "next" }, "/a/app/genclass-init.tsx")).toBe('process.env.NODE_ENV === "development" && typeof window !== "undefined"');
    expect(devCondition({ framework: "remix", details: { vite: true } }, "/a/app/entry.client.tsx")).toBe("import.meta.env.DEV");
    expect(devCondition({ framework: "webpack", details: { bundler: "rollup" } }, "x.js")).toBeNull();
    for (const f of ["angular", "nuxt", "html"]) expect(devCondition({ framework: f }, "x.ts")).toBeNull();
    expect(linkLines({ framework: "vite" }).lines.at(-1)).toBe("if (import.meta.env.DEV) connectAgent(GenClass.init());");
  });

  it("formatter rewrites of the link still come out: braces (ESLint curly), wrapped lines (Prettier), single quotes", () => {
    for (const body of [
      `if (import.meta.env.DEV) {\n  connectAgent(GenClass.init());\n}`,
      `if (process.env.NODE_ENV === 'development')\n  import('@genclass/runtime/agent').then(({ connectAgent }) =>\n    connectAgent(genclass),\n  );`,
      `if (process.env.NODE_ENV === "development") {\n  import("@genclass/runtime/agent").then(({ connectAgent }) => connectAgent(genclass));\n}`,
    ]) {
      const imports = body.includes("GenClass.init") ? `import { GenClass } from '@genclass/runtime'\nimport { connectAgent } from '@genclass/runtime/agent'\n` : "";
      const text = `import genclass from "@genclass/runtime/auto"; // genclass:init\n${AGENT_START}\n${imports}${body}\n${AGENT_END}\nx();\n`;
      expect(planRemoval(text), body).toEqual({ text: "x();\n", problems: [] });
    }
    // code of the person's own inside the link's block is a problem (remove then changes nothing) and is never deleted
    const edited = `import "@genclass/runtime/auto"; // genclass:init\n${AGENT_START}\nimport { GenClass } from "@genclass/runtime";\nwindow.rt = GenClass.init();\n${AGENT_END}\n`;
    expect(planRemoval(edited).problems).toHaveLength(1);
    expect(planRemoval(edited).text).toContain(`${AGENT_START}\nimport { GenClass } from "@genclass/runtime";\nwindow.rt = GenClass.init();\n${AGENT_END}\n`);
  });

  it("devCommand and seeItNow: the project's own dev script and package manager, the console, the question for the agent", () => {
    expect(devCommand({ pkg: { scripts: { dev: "vite" } }, pm: "npm" })).toBe("npm run dev");
    expect(devCommand({ pkg: { scripts: { dev: "vite" } }, pm: "pnpm" })).toBe("pnpm dev");
    expect(devCommand({ pkg: { scripts: { start: "react-scripts start" } }, pm: "npm" })).toBe("npm start");
    expect(devCommand({ pkg: { scripts: {} }, pm: "npm" })).toBeNull();
    const s = seeItNow({ pkg: { scripts: { dev: "vite" } }, pm: "npm" });
    expect(s).toBe('To see GenClass work now, before any deploy: start your dev server (npm run dev) and open the page; GenClass prints [GenClass] lines in the browser console, and ask your coding agent "is GenClass connected?" or to explore a flow for races.');
    expect(seeItNow(null, { agent: false })).toContain("once your coding agent is connected");
  });
});

describe("the walk's Coding agent step: the MCP server, the skill and the link in one preview and one yes (src/actions.mjs connectAgent, src/state.mjs)", () => {
  const setUpApp = () => {
    const dir = tempDir();
    viteApp(dir, { scripts: { dev: "vite" } });
    write(dir, { [INSTALLED]: RUNTIME });
    const plan = planInit(detectProject(dir), { mode: undefined, devtools: false }, { pkgDir: PKG_DIR, version: VERSION });
    for (const ch of plan.changes) writeFileSync(ch.file, ch.after);
    return dir;
  };

  it("--yes writes all three, says how to see it work before any deploy, and the step is done; remove takes the link out", async () => {
    const dir = setUpApp();
    const entry = readFileSync(join(dir, "src/main.jsx"), "utf8");
    const before = (await readState({ cwd: dir }, { runGit: () => null })).steps.find((x) => x.id === "agent")!;
    expect(before).toMatchObject({ state: "todo", doing: "Connect your coding agent" });
    expect(before.why).toContain("links your dev page to them");
    const said = await printed(async () => expect(await connectAgent({ cwd: dir }, { yes: true })).toBe("done"));
    // one preview: the MCP file's change and the link's change, then what was written
    expect(said).toContain(".mcp.json");
    expect(said).toContain("src/main.jsx");
    expect(said).toContain("+ if (import.meta.env.DEV) connectAgent(GenClass.init());");
    expect(said).toContain(SKILL_PATH);
    const flat = said.replace(/\s+/g, " ");
    expect(flat).toContain("See it work now (before any deploy)");
    expect(flat).toContain("Start your dev server (npm run dev) and open the page on localhost.");
    expect(flat).toContain("GenClass prints [GenClass] lines in the browser console");
    expect(flat).toContain('ask it "is GenClass connected?", or to explore a flow');
    const linked = readFileSync(join(dir, "src/main.jsx"), "utf8");
    expect(linked).toContain("connectAgent(GenClass.init())");
    const after = (await readState({ cwd: dir }, { runGit: () => null })).steps.find((x) => x.id === "agent")!;
    expect(after).toMatchObject({ state: "done", detail: ".mcp.json · dev page linked" });
    expect(planRemoval(linked)).toEqual({ text: planRemoval(entry).text, problems: [] });
  });

  it("`genclass remove` (the runtime's remove, then this command's files) gives back the app as it was before setup", async () => {
    const { remove } = await import("../src/remove.mjs");
    const apps: Record<string, string>[] = [
      { "package.json": pkg({ react: "^19", "react-dom": "^19", vite: "^8" }, { scripts: { dev: "vite" } }), "index.html": html("/src/main.jsx"), "src/main.jsx": `import { createRoot } from "react-dom/client";\n\ncreateRoot(document.getElementById("root")).render(null);\n` },
      { "package.json": pkg({ next: "16.0.0", react: "^19" }), "tsconfig.json": "{}\n", "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.0.1" }), "src/app/layout.tsx": "export default function L({ children }) { return <html><body>{children}</body></html>; }\n" },
    ];
    for (const files of apps) {
      const dir = tempDir();
      write(dir, { [INSTALLED]: RUNTIME, ...files });
      const before = snapshot(dir);
      const plan = planInit(detectProject(dir), { mode: undefined, devtools: false }, { pkgDir: PKG_DIR, version: VERSION });
      for (const ch of plan.changes) {
        mkdirSync(dirname(ch.file), { recursive: true });
        writeFileSync(ch.file, ch.after);
      }
      await printed(async () => expect(await connectAgent({ cwd: dir }, { yes: true })).toBe("done"));
      expect(Object.values(snapshot(dir)).some((t) => t.includes("connectAgent(GenClass.init())"))).toBe(true);
      await printed(async () => expect(await remove(["--cwd", dir, "--yes"], { runGit: () => null })).toBe(0));
      expect(snapshot(dir)).toEqual(before);
    }
  });

  it("an agent configured before the link: the step is open again for the link alone, and writes only it", async () => {
    const dir = setUpApp();
    write(dir, { ".mcp.json": JSON.stringify({ mcpServers: { genclass: { command: "npx", args: ["-y", "@genclass/mcp@0.2.2"] } } }) });
    const step = (await readState({ cwd: dir }, { runGit: () => null })).steps.find((x) => x.id === "agent")!;
    expect(step).toMatchObject({ state: "todo", doing: "Link your dev page to your coding agent", detail: ".mcp.json · dev page not linked yet" });
    const mcp = readFileSync(join(dir, ".mcp.json"), "utf8");
    const said = await printed(async () => expect(await connectAgent({ cwd: dir }, { yes: true })).toBe("done"));
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe(mcp);
    expect(said).not.toContain(".mcp.json (");
    expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toContain("connectAgent(GenClass.init())");
    expect((await readState({ cwd: dir }, { runGit: () => null })).steps.find((x) => x.id === "agent")!.state).toBe("done");
  });

  it("a framework the link is not planned for: the MCP server alone makes the step done, and the lines to add are printed", async () => {
    const dir = tempDir();
    write(dir, { "package.json": pkg({ "@angular/core": "^20" }), "src/main.ts": `import { bootstrapApplication } from '@angular/platform-browser';\n` });
    const plan = planInit(detectProject(dir), { mode: undefined, devtools: false }, { pkgDir: PKG_DIR, version: VERSION });
    for (const ch of plan.changes) writeFileSync(ch.file, ch.after);
    const main = readFileSync(join(dir, "src/main.ts"), "utf8");
    const said = await printed(async () => expect(await connectAgent({ cwd: dir }, { yes: true })).toBe("done"));
    expect(said).toContain("if (isDevMode()) connectAgent(GenClass.init());");
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe(main);
    expect((await readState({ cwd: dir }, { runGit: () => null })).steps.find((x) => x.id === "agent")!.state).toBe("done");
  });

  it("an installed runtime without the agent entry (0.2.3): the step writes the MCP server and the skill, not the link, and says what to upgrade", async () => {
    const dir = setUpApp();
    write(dir, { [INSTALLED]: RUNTIME_023 });
    const entry = readFileSync(join(dir, "src/main.jsx"), "utf8");
    const said = await printed(async () => expect(await connectAgent({ cwd: dir }, { yes: true })).toBe("done"));
    expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toBe(entry);
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toContain("@genclass/mcp@");
    const flat = said.replace(/\s+/g, " ");
    expect(flat).toContain("the installed @genclass/runtime 0.2.3 has no agent entry");
    expect(flat).toContain(runtimeUpgrade("npm"));
    expect((await readState({ cwd: dir }, { runGit: () => null })).steps.find((x) => x.id === "agent")!).toMatchObject({ state: "done", detail: ".mcp.json · dev page: link by hand" });
  });

  it("without a terminal and without --yes nothing is written; the Dashboard step's waiting text says how to see it now", async () => {
    const dir = setUpApp();
    const entry = readFileSync(join(dir, "src/main.jsx"), "utf8");
    const said = await printed(async () => expect(await connectAgent({ cwd: dir }, {})).toBe("skipped"));
    expect(said.replace(/\s+/g, " ")).toContain("Not a terminal: run npx genclass setup --yes to write .mcp.json, the skill and the dev-only link.");
    expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toBe(entry);
    const dash = (await readState({ cwd: dir }, { runGit: () => null })).steps.find((x) => x.id === "dashboard")!;
    expect(dash.now).toBe('To see GenClass work now, before any deploy: start your dev server (npm run dev) and open the page; GenClass prints [GenClass] lines in the browser console; once your coding agent is connected (the Coding agent step), ask it "is GenClass connected?" or to explore a flow for races.');
    expect(dash.more).toContain(dash.now!);
    void TOKEN;
  });

  describe("at a terminal", () => {
    const input = new PassThrough();
    (input as unknown as { isTTY: boolean }).isTTY = true;
    const real = Object.getOwnPropertyDescriptor(process, "stdin")!;
    beforeAll(() => Object.defineProperty(process, "stdin", { value: input, configurable: true }));
    afterAll(() => Object.defineProperty(process, "stdin", real));
    const type = (...lines: string[]) => lines.forEach((l, i) => setTimeout(() => input.write(`${l}\n`), 30 * (i + 1)));

    it("one question for all of it: no writes nothing, Enter writes the MCP server, the skill and the link", async () => {
      const dir = setUpApp();
      const entry = readFileSync(join(dir, "src/main.jsx"), "utf8");
      type("n");
      const no = await printed(async () => expect(await connectAgent({ cwd: dir }, { confirmed: true })).toBe("skipped"));
      expect(no).toContain("Write .mcp.json, the skill and the dev-only link?");
      expect(no.match(/\(Y\/n\)/g)).toHaveLength(1);
      expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toBe(entry);
      type("");
      const yes = await printed(async () => expect(await connectAgent({ cwd: dir }, { confirmed: true })).toBe("done"));
      expect(yes.match(/\(Y\/n\)/g)).toHaveLength(1);
      expect(readFileSync(join(dir, "src/main.jsx"), "utf8")).toContain("connectAgent(GenClass.init())");
      expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toContain("@genclass/mcp@");
      expect(readFileSync(join(dir, SKILL_PATH), "utf8")).toContain("genclass:init");
    });
  });
});
